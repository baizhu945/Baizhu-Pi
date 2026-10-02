import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = process.argv[2]!;
const require = createRequire(join(packageDir, "package.json"));
const fs = require("node:fs") as typeof import("node:fs");
const directory = dirname(fileURLToPath(import.meta.url));
const source = join(directory, "../src/preset.ts");
const runner = join(directory, "test-file.mjs");

function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), "fusion-concurrency-"));
  const path = join(root, "preset.json");
  fs.writeFileSync(path, JSON.stringify({ lead: ["p/old"], effort: { "p/untouched": "low" }, recent: ["p/untouched"] }));
  return { root, path };
}

async function isolatedWithPatch(
  patch: Partial<Record<"readFileSync" | "renameSync", Function>>,
  run: (preset: typeof import("../src/preset.js")) => void,
) {
  const { createJiti } = await import(require.resolve("jiti"));
  const saved = new Map<string, Function>();
  for (const [key, value] of Object.entries(patch)) {
    saved.set(key, (fs as any)[key]);
    (fs as any)[key] = value;
  }
  syncBuiltinESMExports();
  try {
    const jiti = createJiti(join(tmpdir(), "fusion-isolated.mjs"), { moduleCache: false, fsCache: false });
    const preset = await jiti.import(source);
    run(preset);
  } finally {
    for (const [key, value] of saved) (fs as any)[key] = value;
    syncBuiltinESMExports();
  }
}

function child(file: string) {
  const result = spawnSync(process.execPath, [runner, packageDir, file], {
    encoding: "utf8", timeout: 30_000,
    env: { ...process.env, JITI_FS_CACHE: "false", PI_OFFLINE: "1" },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

test("both writers hold a cross-process lock throughout latest read/modify/rename", async () => {
  for (const kind of ["curation", "runtime"] as const) {
    const { root, path } = fixture();
    const competing = join(root, "competing.ts");
    fs.writeFileSync(competing, `
      import assert from "node:assert/strict";
      import { saveRuntimeState } from ${JSON.stringify(source)};
      assert.throws(() => saveRuntimeState(${JSON.stringify(path)}, {
        effort: { "p/child": "max" }, recent: ["p/child"]
      }), /write lock exists/);
    `);
    const success = join(root, "after-release.ts");
    fs.writeFileSync(success, `
      import { saveRuntimeState } from ${JSON.stringify(source)};
      saveRuntimeState(${JSON.stringify(path)}, { effort: { "p/child": "max" }, recent: ["p/child"] });
    `);
    const originalRead = fs.readFileSync;
    const before = fs.statSync(path);
    let observed = false;
    await isolatedWithPatch({ readFileSync: (fd: any, ...args: any[]) => {
      const bytes = (originalRead as any)(fd, ...args);
      if (typeof fd === "number" && !observed) {
        const stat = fs.fstatSync(fd);
        if (stat.ino === before.ino && stat.dev === before.dev) {
          observed = true;
          const lockStat = fs.lstatSync(`${path}.lock`);
          const owner = JSON.parse(originalRead(`${path}.lock`, "utf8"));
          assert.equal(owner.pid, process.pid);
          assert.match(owner.token, /^[0-9a-f-]{36}$/);
          assert.equal(owner.ino, lockStat.ino);
          assert.equal(owner.dev, lockStat.dev);
          child(competing);
        }
      }
      return bytes;
    } }, (preset) => {
      if (kind === "curation") preset.saveCuration(path, { lead: ["p/new"], sidekick: [], default: {} });
      else preset.saveRuntimeState(path, { effort: { "p/parent": "high" }, recent: ["p/parent"] });
    });
    assert.equal(observed, true);
    assert.equal(fs.existsSync(`${path}.lock`), false);
    child(success);
    const actual = JSON.parse(fs.readFileSync(path, "utf8"));
    assert.equal(actual.effort["p/untouched"], "low");
    assert.equal(actual.effort["p/child"], "max");
    if (kind === "curation") assert.deepEqual(actual.lead, ["p/new"]);
    else assert.equal(actual.effort["p/parent"], "high");
    assert.equal(actual.recent[0], "p/child");
  }
});

test("rename failure cleans the private random temporary and own lock", async () => {
  const { root, path } = fixture();
  const originalRename = fs.renameSync;
  const bytes = fs.readFileSync(path, "utf8");
  await isolatedWithPatch({ renameSync: (from: any, to: any) => {
    if (to === path) {
      assert.match(String(from), /\.[0-9a-f-]{36}\.tmp$/);
      assert.equal(fs.statSync(from).mode & 0o777, 0o600);
      throw new Error("fixture rename failure");
    }
    return originalRename(from, to);
  } }, (preset) => {
    assert.throws(() => preset.saveRuntimeState(path, { effort: {}, recent: ["p/new"] }), /fixture rename failure/);
  });
  assert.equal(fs.readFileSync(path, "utf8"), bytes);
  assert.deepEqual(fs.readdirSync(root), ["preset.json"]);
});

test("cleanup does not delete a different lock inode replacing its own path", async () => {
  const { path } = fixture();
  const originalRename = fs.renameSync;
  const replacement = '{"pid":2147483647,"token":"replacement-owner"}';
  await isolatedWithPatch({ renameSync: (from: any, to: any) => {
    if (to === path) {
      fs.unlinkSync(`${path}.lock`);
      fs.writeFileSync(`${path}.lock`, replacement, { flag: "wx", mode: 0o600 });
    }
    return originalRename(from, to);
  } }, (preset) => {
    preset.saveRuntimeState(path, { effort: {}, recent: ["p/new"] });
  });
  assert.equal(fs.readFileSync(`${path}.lock`, "utf8"), replacement);
});

test("IO failure during latest read leaves the existing document intact and cleans lock", async () => {
  const { root, path } = fixture();
  const originalRead = fs.readFileSync;
  const before = fs.statSync(path);
  const bytes = fs.readFileSync(path, "utf8");
  let observed = false;
  await isolatedWithPatch({ readFileSync: (fd: any, ...args: any[]) => {
    if (typeof fd === "number") {
      const stat = fs.fstatSync(fd);
      if (stat.ino === before.ino && stat.dev === before.dev) {
        observed = true;
        throw new Error("fixture EIO read failure");
      }
    }
    return (originalRead as any)(fd, ...args);
  } }, (preset) => {
    assert.throws(() => preset.saveRuntimeState(path, { effort: {}, recent: ["p/new"] }), /fixture EIO read failure/);
  });
  assert.equal(observed, true);
  assert.equal(fs.readFileSync(path, "utf8"), bytes);
  assert.deepEqual(fs.readdirSync(root), ["preset.json"]);
});
