import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globalPresetPath, loadPreset, projectPresetPath, saveCuration, saveRuntimeState } from "../src/preset.js";

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "fusion-security-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "fusion-security-cwd-"));
  return { home, cwd, path: globalPresetPath(home) };
}
function put(path: string, content: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}
const curation = { lead: ["p/a"], sidekick: ["p/b"], default: { lead: "p/a" } };
const patch = { effort: {}, recent: ["p/a"] };

function assertNoArtifacts(path: string) {
  assert.equal(existsSync(`${path}.lock`), false);
  assert.equal(readdirSync(join(path, "..")).some((name) => name.endsWith(".tmp")), false);
}

test("nonexistent layers load normally and new files/directories are private", () => {
  const { home, cwd, path } = fixture();
  assert.equal(loadPreset(cwd, home).hasProjectLayer, false);
  const mask = process.umask(0o022);
  try { saveRuntimeState(path, patch); } finally { process.umask(mask); }
  assert.equal(statSync(path).mode & 0o777, 0o600);
  for (const directory of [join(home, ".unipi"), join(home, ".unipi", "config"), join(home, ".unipi", "config", "fusion")]) {
    assert.equal(statSync(directory).mode & 0o777, 0o700);
  }
  assertNoArtifacts(path);
});

test("atomic replacement preserves stricter existing modes and never widens access", () => {
  for (const mode of [0o400, 0o600, 0o640, 0o644]) {
    const { path } = fixture();
    put(path, "{}");
    chmodSync(path, mode);
    const mask = process.umask(0o022);
    try { saveCuration(path, curation); } finally { process.umask(mask); }
    assert.equal(statSync(path).mode & 0o777, mode & 0o600);
    assertNoArtifacts(path);
  }
});

test("corrupt/non-object/unsupported documents throw without overwriting bytes", () => {
  for (const content of ['{"lead":["p/a"],', "null", "[]", "42", '{"schema_version":2}', '{"schema_version":"1"}']) {
    const { home, cwd, path } = fixture();
    put(path, content);
    assert.throws(() => loadPreset(cwd, home), /Cannot read Fusion preset/);
    assert.throws(() => saveCuration(path, curation), /Cannot .*Fusion preset/);
    assert.throws(() => saveRuntimeState(path, patch), /Cannot .*Fusion preset/);
    assert.equal(readFileSync(path, "utf8"), content);
    assertNoArtifacts(path);
  }
});

test("legacy missing version is accepted; unknown root and nested fields survive", () => {
  const { path } = fixture();
  put(path, JSON.stringify({
    custom: { future: [1, 2, 3] }, default: { lead: "p/old", sidekick: "p/old-side", future: { enabled: true } },
    effort: { "p/untouched": "future-effort" }, prices: { "p/a": { input: 1, cachedInput: 0, output: 2, future: 9 } },
    active: { kind: "fusion", lead: "p/a", sidekick: "p/b", leadEffort: "high", future: { note: "keep" } },
  }));
  saveCuration(path, curation);
  saveRuntimeState(path, { effort: { "p/new": "high" }, recent: ["p/new"], active: { kind: "single", model: "p/new" } });
  const actual = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(actual.schema_version, 1);
  assert.deepEqual(actual.custom, { future: [1, 2, 3] });
  assert.deepEqual(actual.default, { lead: "p/a", future: { enabled: true } });
  assert.deepEqual(actual.effort, { "p/untouched": "future-effort", "p/new": "high" });
  assert.equal(actual.prices["p/a"].future, 9);
  assert.deepEqual(actual.active, { kind: "single", model: "p/new", future: { note: "keep" } });
  assertNoArtifacts(path);
});

test("malformed project layers throw instead of silently disappearing", () => {
  const { home, cwd } = fixture();
  put(projectPresetPath(cwd), "{");
  assert.throws(() => loadPreset(cwd, home), /Cannot read Fusion preset.*fusion-preset\.json/);
});

test("non-regular files and IO failures are not treated as absence", () => {
  const regular = fixture();
  mkdirSync(regular.path, { recursive: true });
  assert.throws(() => loadPreset(regular.cwd, regular.home), /regular JSON file/);
  assert.throws(() => saveRuntimeState(regular.path, patch), /regular JSON file/);
  assert.equal(existsSync(`${regular.path}.lock`), false);
  const blocked = fixture();
  writeFileSync(join(blocked.home, ".unipi"), "not a directory");
  assert.throws(() => loadPreset(blocked.cwd, blocked.home), /Cannot read Fusion preset.*ENOTDIR/);
});

test("preset symlinks are rejected, including dangling links", () => {
  for (const dangling of [false, true]) {
    const { home, cwd, path } = fixture();
    mkdirSync(join(path, ".."), { recursive: true });
    const victim = join(home, "victim.json");
    if (!dangling) writeFileSync(victim, '{"custom":"untouched"}');
    symlinkSync(victim, path);
    assert.throws(() => loadPreset(cwd, home), /Cannot read Fusion preset/);
    assert.throws(() => saveCuration(path, curation), /Cannot .*Fusion preset/);
    assert.equal(lstatSync(path).isSymbolicLink(), true);
    if (!dangling) assert.equal(readFileSync(victim, "utf8"), '{"custom":"untouched"}');
    else assert.equal(existsSync(victim), false);
    assertNoArtifacts(path);
  }
});

test("old predictable temporary symlink is never opened or overwritten", () => {
  const { home, path } = fixture();
  put(path, "{}");
  const victim = join(home, "victim.txt");
  writeFileSync(victim, "untouched");
  const oldTemporary = `${path}.${process.pid}.tmp`;
  symlinkSync(victim, oldTemporary);
  saveCuration(path, curation);
  assert.equal(readFileSync(victim, "utf8"), "untouched");
  assert.equal(lstatSync(oldTemporary).isSymbolicLink(), true);
  assert.equal(lstatSync(path).isFile(), true);
  assert.equal(existsSync(`${path}.lock`), false);
});

test("busy, abandoned and symlink locks fail fast without deleting or following them", () => {
  for (const kind of ["busy", "abandoned", "symlink"] as const) {
    const { home, path } = fixture();
    put(path, "{}");
    const lockPath = `${path}.lock`;
    const victim = join(home, "victim.txt");
    writeFileSync(victim, "untouched");
    const bytes = JSON.stringify({ pid: kind === "busy" ? process.pid : 2147483647, token: "fixture-owner" });
    if (kind === "symlink") symlinkSync(victim, lockPath);
    else writeFileSync(lockPath, bytes);
    const before = lstatSync(lockPath);
    for (const save of [() => saveCuration(path, curation), () => saveRuntimeState(path, patch)]) {
      assert.throws(save, /write lock exists.*manually verified.*never automatically removed or followed/);
      assert.equal(lstatSync(lockPath).ino, before.ino);
      assert.equal(readFileSync(path, "utf8"), "{}");
    }
    assert.equal(readFileSync(victim, "utf8"), "untouched");
    if (kind !== "symlink") assert.equal(readFileSync(lockPath, "utf8"), bytes);
  }
});

test("failed serialization cleans this writer's random temporary and lock", () => {
  const { path } = fixture();
  put(path, "{}");
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const invalid = { ...curation, default: { lead: "p/a", future: circular } };
  assert.throws(() => saveCuration(path, invalid), /circular/i);
  assert.equal(readFileSync(path, "utf8"), "{}");
  assertNoArtifacts(path);
});

test("invalid PATCH or curation keys are rejected before touching state", () => {
  const { path } = fixture();
  put(path, "{}");
  assert.throws(() => saveRuntimeState(path, { effort: { "unqualified": "high" }, recent: [] }), /invalid effort/);
  assert.throws(() => saveRuntimeState(path, { effort: {}, recent: ["p/ "] }), /invalid recent/);
  assert.throws(() => saveRuntimeState(path, { effort: {}, recent: [], active: { kind: "single", model: "" } }), /invalid active/);
  assert.throws(() => saveCuration(path, { ...curation, lead: ["/bad"] }), /invalid lead/);
  assert.throws(() => saveCuration(path, { ...curation, default: { sidekick: "p/" } }), /invalid default/);
  assert.equal(readFileSync(path, "utf8"), "{}");
  assertNoArtifacts(path);
});
