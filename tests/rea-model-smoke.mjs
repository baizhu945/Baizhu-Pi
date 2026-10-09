// Optional real-model compatibility smoke. Uses existing credentials internally;
// allows ONLY REA target-free status and never persists a real user session.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [sdkRoot, agentDir, provider, modelId] = process.argv.slice(2);
assert(sdkRoot && agentDir && provider && modelId, "Usage: rea-model-smoke.mjs <SDK> <agent dir> <provider> <model>");
const root = mkdtempSync(path.join(os.tmpdir(), "pi-rea-model-smoke-"));
const privateAgent = path.join(root, "agent"); mkdirSync(privateAgent);
process.env.PI_CODING_AGENT_DIR = privateAgent;
process.env.PI_OFFLINE = "1";
const sdk = await import(pathToFileURL(path.join(sdkRoot, "dist/index.js")));
const settingsManager = sdk.SettingsManager.inMemory({
  ...JSON.parse(readFileSync(path.join(agentDir, "settings.json"), "utf8")),
  cacheWarming: "off", retry: { enabled: false }, compaction: { enabled: false },
});
const modelRuntime = await sdk.ModelRuntime.create({
  authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json"),
});
const model = modelRuntime.getModel(provider, modelId);
assert(model, "The selected current model is absent from the installed catalog; no fallback is permitted");
const calls = [];
const guard = pi => pi.on("tool_call", event => {
  calls.push(event.toolName);
  if (event.toolName !== "mcp__rea__binary_session" || calls.filter(name => name === event.toolName).length > 1) {
    return { block: true, reason: "This compatibility test permits only one target-free REA status read; no filesystem, commands, network or other analysis." };
  }
});
const loader = new sdk.DefaultResourceLoader({ cwd: root, agentDir, settingsManager,
  extensionFactories: [sdk.createCodemodeExtension(), sdk.createToolSearchExtension(), sdk.createMcpExtension(), guard] });
await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
const { session } = await sdk.createAgentSession({ cwd: root, agentDir: privateAgent, settingsManager,
  resourceLoader: loader, modelRuntime, model: { ...model, maxTokens: 1024 },
  sessionManager: sdk.SessionManager.inMemory(root) });
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
  onTerminalInput() { return () => {}; }, confirm: async () => true,
};
const errors = [];
let timer;
try {
  await session.bindExtensions({ mode: "tui", uiContext: ui, onError: error => errors.push(error) });
  session.setThinkingLevel("minimal");
  await session.prompt("/rea on");
  assert.equal(session.getActiveToolNames().filter(name => name.startsWith("mcp__rea__")).length, 138);
  timer = setTimeout(() => { void session.abort(); }, 90_000);
  await session.prompt("This is a restricted compatibility test. Call mcp__rea__binary_session exactly once with {}. Do not call any other tool, do not read any files or output paths, do not run commands. After that one status result, reply with exactly REA_READY. You do not need to interpret or investigate the status.");
  const last = session.messages.findLast(message => message.role === "assistant");
  assert(last && last.stopReason !== "error", last?.errorMessage ?? "No completed assistant message");
  assert.match(session.getLastAssistantText(), /REA_READY/);
  assert.deepEqual(calls, ["mcp__rea__binary_session"]);
  const result = session.messages.find(message => message.role === "toolResult" && message.toolName === "mcp__rea__binary_session");
  assert.equal(result?.isError, false);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: "pass", provider, model: modelId,
    active_tools: session.getActiveToolNames().length, REA_tools: 138, executed_tools: calls,
    final: session.getLastAssistantText(), usage: last.usage,
    restrictions: "one target-free status call; all other tool calls blocked; ephemeral session" }, null, 2));
} finally {
  clearTimeout(timer);
  await session.prompt("/rea off").catch(() => undefined);
  await session._extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
  session.dispose();
  rmSync(root, { recursive: true, force: true });
}
