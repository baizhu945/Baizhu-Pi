import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getPiSpawnCommand, PI_CODING_AGENT_PACKAGE, resolvePiCliScript } from "../src/vendor/subagents/pi-spawn.js";

function fixture(t: TestContext) {
  const root = mkdtempSync("/tmp/fusion-spawn-");
  const dist = join(root, "dist");
  mkdirSync(dist);
  mkdirSync(join(dist, "bundle"));
  const files = [join(root, "package.json"), join(dist, "index.js"), join(dist, "cli.js"), join(dist, "bundle", "cli.js")];
  writeFileSync(files[0]!, JSON.stringify({ name: PI_CODING_AGENT_PACKAGE, bin: { pi: "dist/bundle/cli.js" } }));
  for (const file of files.slice(1)) writeFileSync(file, "// memory fixture, never executed\n");
  t.after(() => {
    for (const file of files) unlinkSync(file);
    rmdirSync(join(dist, "bundle")); rmdirSync(dist); rmdirSync(root);
  });
  return { root, files };
}

test("library dist/index.js is not a CLI; package bin.pi wins", (t) => {
  const { root } = fixture(t);
  assert.equal(resolvePiCliScript({ argv1: join(root, "dist", "index.js"), piPackageRoot: root }), join(root, "dist", "bundle", "cli.js"));
});

test("declared bin and verified unbundled CLI argv remain usable", (t) => {
  const { root } = fixture(t);
  for (const entry of [join(root, "dist", "bundle", "cli.js"), join(root, "dist", "cli.js")]) {
    assert.equal(resolvePiCliScript({ argv1: entry, piPackageRoot: root }), entry);
  }
});

test("unrelated package script cannot become the child CLI", (t) => {
  const { root, files } = fixture(t);
  writeFileSync(files[0]!, JSON.stringify({ name: "not-pi", bin: { pi: "dist/index.js" } }));
  assert.equal(resolvePiCliScript({ argv1: join(root, "dist", "index.js"), resolvePackageJson: () => "invalid", existsSync: () => true, readFileSync: () => "invalid" }), undefined);
});

test("package without bin.pi does not substitute an unrelated bin", () => {
  assert.equal(resolvePiCliScript({ argv1: "/tmp/no-host-entry", existsSync: (path) => path.endsWith("unrelated.js"), resolvePackageJson: () => "/tmp/pkg/package.json", readFileSync: () => JSON.stringify({ bin: { unrelated: "unrelated.js" } }) }), undefined);
});

test("standalone and explicit environment override retain precedence", () => {
  assert.deepEqual(getPiSpawnCommand(["--mode", "rpc"], { execPath: "/tmp/pi", env: {} }), { command: "/tmp/pi", args: ["--mode", "rpc"] });
  assert.deepEqual(getPiSpawnCommand(["--mode", "rpc"], { execPath: "/tmp/pi", env: { UNIPI_SUBAGENT_PI_BINARY: " /tmp/explicit-pi " } }), { command: "/tmp/explicit-pi", args: ["--mode", "rpc"] });
  assert.deepEqual(getPiSpawnCommand([], { execPath: "C:\\tools\\pi.exe", env: {} }), { command: "C:\\tools\\pi.exe", args: [] });
});
