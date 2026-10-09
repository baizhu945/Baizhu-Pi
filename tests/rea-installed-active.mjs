// Actual deployed Pi -> native MCP -> installed REA -> real Ghidra/JS.
// Only model streaming and the human confirmation are fixtures; analysis is real.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [sdkRoot, deployedAgentDir, largeTarget] = process.argv.slice(2);
assert(sdkRoot && deployedAgentDir, "Usage: node rea-installed-active.mjs <Pi SDK root> <deployed agent directory>");
const root = mkdtempSync(path.join(os.tmpdir(), "pi-rea-installed-active-"));
const privateAgent = path.join(root, "agent");
const tmp = path.join(root, "tmp");
mkdirSync(privateAgent); mkdirSync(tmp);
process.env.PI_CODING_AGENT_DIR = privateAgent;
process.env.PI_OFFLINE = "1";
process.env.TMPDIR = tmp;
delete process.env.UNIPI_FUSION_CHILD;
delete process.env.UNIPI_SUBAGENT_CHILD;
const sdk = await import(pathToFileURL(path.join(sdkRoot, "dist/index.js")));
const { AssistantMessageEventStream } = await import(pathToFileURL(path.join(sdkRoot, "node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js")));
const settingsManager = sdk.SettingsManager.inMemory({
  ...JSON.parse(readFileSync(path.join(deployedAgentDir, "settings.json"), "utf8")),
  defaultProvider: "rea-live-pi-fixture", defaultModel: "fixture", cacheWarming: "off",
  compaction: { enabled: false }, retry: { enabled: false },
});
const fixtureProvider = pi => pi.registerProvider("rea-live-pi-fixture", {
  api: "openai-completions", baseUrl: "http://127.0.0.1:9", apiKey: "fixture-no-network",
  models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1050000, maxTokens: 1024 }],
});
const ui = {
  notify() {}, setStatus() {}, setWidget() {}, addAutocompleteProvider() {},
  setHeader() {}, setFooter() {}, setTitle() {}, setEditorComponent() {},
  getEditorComponent() { return undefined; }, getEditorText() { return ""; },
  setEditorText() {}, pasteToEditor() {}, setWorkingMessage() {},
  setWorkingVisible() {}, setWorkingIndicator() {}, setHiddenThinkingLabel() {},
  getToolsExpanded() { return false; }, setToolsExpanded() {},
  getAllThemes() { return []; }, getTheme() { return undefined; },
  setTheme() { return { success: true }; },
  theme: { fg: (_color, text) => text, bg: (_color, text) => text, bold: text => text },
  select: async () => undefined, input: async () => undefined,
  editor: async () => undefined, custom: async () => undefined,
  onTerminalInput() { return () => {}; },
  confirmations: 0,
  confirm: async () => { ui.confirmations++; return true; },
};
const loader = new sdk.DefaultResourceLoader({
  cwd: root, agentDir: deployedAgentDir, settingsManager,
  extensionFactories: [fixtureProvider, sdk.createCodemodeExtension(), sdk.createToolSearchExtension(), sdk.createMcpExtension()],
});
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
const modelRuntime = await sdk.ModelRuntime.create({ authPath: path.join(privateAgent, "auth.json"), modelsPath: path.join(privateAgent, "models.json") });
const { session } = await sdk.createAgentSession({ cwd: root, agentDir: privateAgent, resourceLoader: loader,
  settingsManager, modelRuntime, sessionManager: sdk.SessionManager.inMemory(root) });
const errors = [];
const replies = [];
const requests = [];
const results = [];
const outputFiles = new Set();
session.subscribe(event => {
  if (event.type === "tool_execution_end") {
    results.push(event);
    if (event.result?.details?.fullOutputPath) outputFiles.add(event.result.details.fullOutputPath);
  }
});
session.agent.streamFunction = (model, context) => {
  requests.push(context);
  const calls = replies.shift() ?? [];
  const stream = new AssistantMessageEventStream();
  const message = { role: "assistant", content: calls.length
    ? calls.map((call, i) => ({ type: "toolCall", id: `real_${requests.length}_${i}`, ...call }))
    : [{ type: "text", text: "fixture response" }],
    api: model.api, provider: model.provider, model: model.id, stopReason: calls.length ? "toolUse" : "stop", timestamp: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  queueMicrotask(() => { stream.push({ type: "done", reason: message.stopReason, message }); stream.end(); });
  return stream;
};
await session.bindExtensions({ mode: "tui", uiContext: ui, onError: error => errors.push(error) });
await session.setModel(session._modelRuntime.getModel("rea-live-pi-fixture", "fixture"));
const baseline = session.getActiveToolNames();
const baselinePrompt = session.systemPrompt;
async function call(rawName, args = {}, allowError = false) {
  const name = `mcp__rea__${rawName}`;
  const start = results.length;
  replies.push([{ name, arguments: args }]);
  await session.prompt("Execute the declared locally generated analysis fixture.");
  const event = results.slice(start).find(entry => entry.toolName === name);
  assert(event, `No native Pi execution event for ${name}`);
  if (allowError) return event;
  assert.equal(event.isError, false, `${name} failed: ${JSON.stringify(event.result.content)}`);
  const mcp = event.result.structuredContent;
  assert(mcp?.structuredContent, `${name} lost the complete MCP structuredContent`);
  assert.notEqual(mcp.isError, true);
  return mcp.structuredContent;
}
const hash = file => createHash("sha256").update(readFileSync(file)).digest("hex");
const report = { status: "running", checks: [], real_model_requests: 0 };
try {
  assert(!baseline.some(name => name.startsWith("mcp__rea__")));
  await session.prompt("Capture the untouched installed default session.");
  assert.equal(requests.length, 1);
  await session.prompt("/rea on");
  assert.equal(requests.length, 1, "Enabling must not itself invoke a model");
  assert.equal(ui.confirmations, 1);
  assert.equal(session.getActiveToolNames().filter(name => name.startsWith("mcp__rea__")).length, 138);
  assert.deepEqual(session.getActiveToolNames().filter(name => !name.startsWith("mcp__rea__")), baseline);
  assert.equal(session.getActiveToolNames().length, baseline.length + 138);
  report.checks.push("user-confirmed 138 tools; original loadout retained");
  const status = await call("binary_session");
  assert.equal(status.result.tool_availability.length, 138);
  assert.match(JSON.stringify(requests.at(-1)), /REA mode is explicitly authorized/,
    "REA guidance must reach the actual model request (it is request-local, not the idle prompt getter)");
  const app = path.join(root, "application"); mkdirSync(app);
  writeFileSync(path.join(app, "package.json"), '{"name":"pi-live-rea","version":"1.0.0","main":"main.cjs"}');
  writeFileSync(path.join(app, "main.cjs"), 'const {ipcMain}=require("electron");ipcMain.handle("pi-rea:local",(_,value)=>({value}));');
  const graph = await call("analyze_javascript_application", { input_path: app, format: "directory" });
  assert.equal(graph.evidence.provider.id, "rea-javascript-application");
  assert(graph.result.graph.nodes.length > 0 && graph.result.graph.edges.length > 0);
  assert(JSON.stringify(graph.result).includes("pi-rea:local"));
  report.javascript_evidence = graph.evidence.evidence_id;
  report.checks.push("real JS application analysis through native Pi tool pipeline");
  const evmCarrier = path.join(root, "runtime.hex");
  writeFileSync(evmCarrier, '0x60006000f3\n');
  const evm = await call("inspect_evm_interface", { path: evmCarrier, encoding: "hex" });
  assert.equal(evm.result.bytecode.hex, "60006000f3");
  assert.equal(evm.result.runtime_execution, "not-performed");
  assert.equal(evm.result.evidence_kind, "inferred");
  report.checks.push("new offline EVMole inspection through native Pi pipeline without chain access or target execution");
  const source = path.join(root, "native.c"), binary = path.join(root, "native");
  writeFileSync(source, '#include <stdio.h>\n__attribute__((noinline)) int pi_rea_leaf(int x){return x*3+7;}\n__attribute__((noinline)) int pi_rea_entry(int x){puts("PI_REA_PIPELINE_OK");return x>3?pi_rea_leaf(x):pi_rea_leaf(x+1)+2;}\nint main(int argc,char**argv){return pi_rea_entry(argc);}\n');
  execFileSync("/run/current-system/sw/bin/gcc", ["-O0", "-g", "-fno-inline", "-fno-pie", "-no-pie", source, "-o", binary]);
  const originalSha = hash(binary);
  // Omitting provider_id must honor the configured native Ghidra default.
  await call("open_binary", { path: binary });
  const dossier = await call("analyze_function", { procedure: "pi_rea_entry" });
  assert.equal(dossier.evidence.provider.id, "ghidra");
  assert.equal(dossier.evidence.subject.digest.sha256, originalSha);
  assert(dossier.evidence.analysis_profile);
  assert(dossier.result.assembly.length > 0 && dossier.result.basic_blocks.length > 1);
  assert(dossier.result.pseudocode.length > 0);
  assert(JSON.stringify(dossier.result.callees).includes("pi_rea_leaf"));
  report.ghidra_evidence = dossier.evidence.evidence_id;
  report.ghidra_profile = dossier.evidence.analysis_profile;
  report.checks.push("real Ghidra disassembly/decompilation/CFG/calls through native Pi tool pipeline");
  await call("close_binary");
  assert.equal(hash(binary), originalSha);
  assert(!readdirSync(tmp).some(name => name.startsWith("rea-ghidra-")));
  if (largeTarget) {
    const largeSha = hash(largeTarget);
    await call("open_binary", { path: largeTarget });
    const started = Date.now();
    console.log(`[large Ghidra] first full import/analysis started: ${new Date(started).toISOString()}`);
    const matches = await call("search_strings", { pattern: "BrightnessContrast|brightnessContrast|Brightness/Contrast|useLegacy", mode: "regex" });
    assert.equal(matches.evidence.provider.id, "ghidra");
    assert.equal(matches.evidence.subject.digest.sha256, largeSha);
    report.large_target = { path: largeTarget, sha256: largeSha, duration_ms: Date.now() - started,
      evidence_id: matches.evidence.evidence_id, provider: matches.evidence.provider };
    await call("close_binary");
    assert.equal(hash(largeTarget), largeSha);
    assert(!readdirSync(tmp).some(name => name.startsWith("rea-ghidra-")));
    report.checks.push("large user target full Ghidra analysis completed via native Pi pipeline; original SHA unchanged");
  }
  await session.prompt("/rea off");
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.deepEqual(session.getActiveToolNames(), baseline);
  assert.equal(session.systemPrompt, baselinePrompt);
  assert(!session.getCallableToolNames().some(name => name.startsWith("mcp__rea__")));
  assert(session.getAllTools().filter(tool => tool.name.startsWith("mcp__rea__")).every(tool => tool.exposure === "hidden"));
  const denied = await call("binary_session", {}, true);
  assert.equal(denied.isError, true, "A model-issued call after OFF must fail");
  assert.deepEqual(errors, []);
  report.checks.push("off restores original active tools/prompt; indirect and model-issued REA calls rejected");
  report.checks.push("original executable unchanged; Ghidra private runtime removed");
  report.status = "pass";
  report.baseline_tools = baseline;
  console.log(JSON.stringify(report, null, 2));
} finally {
  await session._extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
  session.dispose();
  await new Promise(resolve => setTimeout(resolve, 300));
  for (const file of outputFiles) {
    assert(path.resolve(file).startsWith(`${os.tmpdir()}/`), "Unexpected output path");
    try { unlinkSync(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  rmSync(root, { recursive: true, force: true });
}
