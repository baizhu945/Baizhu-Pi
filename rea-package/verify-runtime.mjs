// Run with the derivation's Node, passing the built package and a scratch HOME.
// Never invokes setup/update or writes to the real user's configuration.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, access } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const deadline = setTimeout(() => {
  console.error("Package runtime verification exceeded 120 seconds");
  process.exit(1);
}, 120000);
deadline.unref();
const [packagePath, scratchHome] = process.argv.slice(2);
assert.ok(packagePath?.startsWith("/nix/store/"));
assert.ok(scratchHome?.startsWith("/tmp/"));
const root = join(resolve(packagePath), "lib/rea-agents");
const cli = join(packagePath, "bin/rea");
const require = createRequire(join(root, "package.json"));
const load = (name) => import(pathToFileURL(require.resolve(name)).href);
const execute = promisify(execFile);
const environment = {
  HOME: scratchHome,
  XDG_CONFIG_HOME: join(scratchHome, "config"),
  XDG_CACHE_HOME: join(scratchHome, "cache"),
  TMPDIR: scratchHome,
  // Deliberately no ambient Node, npm, providers, or credentials.
  PATH: "/nonexistent",
  TERM: "xterm-256color",
};
const run = (args) => execute(cli, args, {
  env: environment,
  cwd: scratchHome,
  timeout: 60000,
  maxBuffer: 8 * 1024 * 1024,
});
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
assert.equal(manifest.version, "6.1.0");
for (const file of [
  "dist/main.js", "dist/cli.js",
  "bridge/hopper_bridge.py", "bridge/ghidra/ReaGhidraBridge.java",
  "bridge/android/ReaJadxBridge.java", "bridge/mitmproxy/capture.py",
  "bridge/pwntools/layout.py", "bridge/pwntools/decoder_runtime.py", "bridge/pwntools/recorded_crash.py",
  "bridge/pwndbg/launch.py", "bridge/pwndbg/core_context.py",
  "third_party/pwntools/README.md", "third_party/pwndbg/LICENSE.md", "third_party/evmole/LICENSE",
  "scripts/rea.mjs", "scripts/electron-active-hook.cjs",
  "skills/reverse-engineer-anything/SKILL.md",
]) await access(join(root, file));
await assert.rejects(access(join(root, "dist/generatedMcpToolCatalog.js")), { code: "ENOENT" });
console.log("CLI version:", (await run(["--version"])).stdout.trim());
assert.match((await run(["--help"])).stdout, /REA|rea/);
const doctor = JSON.parse((await run(["mcp", "doctor", "--json"])).stdout);
assert.equal(doctor.healthy, true, JSON.stringify(doctor));
assert.equal(doctor.server.version, "6.1.0");
assert.equal(doctor.inventory.tools.observed, doctor.inventory.tools.expected);
console.log("Production MCP doctor:", JSON.stringify(doctor));

const { Client } = await load("@modelcontextprotocol/client");
const { StdioClientTransport } = await load("@modelcontextprotocol/client/stdio");
const { TOOL_CONTRACTS } = await import(pathToFileURL(join(root, "dist/contracts/toolContracts.js")));
const client = new Client({ name: "nix-rea-runtime-verification", version: "1" });
const transport = new StdioClientTransport({ command: cli, args: ["--mcp"], env: environment, cwd: scratchHome, stderr: "pipe" });
let stderr = "";
transport.stderr?.on("data", (chunk) => { stderr += chunk; });
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(({ name }) => name).sort(), TOOL_CONTRACTS.map(({ name }) => name).sort());
  const status = await client.callTool({ name: "binary_session", arguments: {} });
  assert.notEqual(status.isError, true, JSON.stringify(status));
  assert.equal(stderr, "", `Unexpected MCP startup stderr: ${stderr}`);
  const rejected = await client.callTool({ name: "open_binary", arguments: { path: process.execPath, provider_id: "missing-provider" } });
  assert.equal(rejected.isError, true);
  assert.equal(rejected.structuredContent?.error?.details?.selection_reason, "unknown_provider");
  console.log(`--mcp initialize + exact tools/list (${tools.length}) + binary_session + unknown-provider rejection: PASS`);
} finally {
  await client.close();
  await transport.close();
}
// REA logs the intentional unknown-provider rejection as a structured warning.
for (const line of stderr.trim().split("\n").filter(Boolean)) {
  const log = JSON.parse(line);
  assert.equal(log.tool, "open_binary");
  assert.equal(log.level, 40);
  assert.equal(log.status, "error");
}

// Imports alone do not prove spawn-helper's ELF interpreter works on NixOS.
const pty = await load("@lydell/node-pty");
await new Promise((resolvePromise, reject) => {
  const terminal = pty.spawn(process.execPath, ["-e", "process.stdout.write('NIX_REA_PTY_OK');"], {
    name: "xterm-256color", cols: 80, rows: 24, cwd: scratchHome, env: environment,
  });
  let output = "";
  const timer = setTimeout(() => { terminal.kill(); reject(new Error(`PTY timeout: ${output}`)); }, 10000);
  terminal.onData((chunk) => { output += chunk; });
  terminal.onExit(({ exitCode }) => {
    clearTimeout(timer);
    try {
      assert.equal(exitCode, 0);
      assert.match(output, /NIX_REA_PTY_OK/);
      console.log("Native PTY real child spawn with empty PATH: PASS");
      resolvePromise();
    } catch (error) { reject(error); }
  });
});
clearTimeout(deadline);
console.log("All package runtime checks passed.");
