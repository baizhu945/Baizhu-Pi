// Post-activation regression against ALL actually deployed Pi extensions.
// No paid model request, credentials, MCP server, or real user session is used.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [sdkRoot, deployedAgentDir] = process.argv.slice(2);
assert(sdkRoot && deployedAgentDir, "Usage: node rea-installed-neutrality.mjs <Pi SDK root> <deployed agent dir>");
const scratch = mkdtempSync(path.join(os.tmpdir(), "pi-rea-installed-neutrality-"));
const scratchAgent = path.join(scratch, "agent");
mkdirSync(scratchAgent);
process.env.PI_CODING_AGENT_DIR = scratchAgent;
process.env.PI_OFFLINE = "1";
delete process.env.UNIPI_FUSION_CHILD;
delete process.env.UNIPI_SUBAGENT_CHILD;
const sdk = await import(pathToFileURL(path.join(sdkRoot, "dist/index.js")));
const { buildSystemPrompt } = await import(pathToFileURL(path.join(sdkRoot, "dist/core/system-prompt.js")));
const { AssistantMessageEventStream } = await import(pathToFileURL(path.join(sdkRoot, "node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js")));
const modeEntry = realpathSync(path.join(deployedAgentDir, "extensions/rea-mode/index.ts"));
const settings = JSON.parse(readFileSync(path.join(deployedAgentDir, "settings.json"), "utf8"));
const sessions = [];
const errors = [];
const noModelCalls = () => { throw new Error("Unexpected model request"); };
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
  confirm: async () => { throw new Error("A cold session requested authorization"); },
};
const fixtureProvider = pi => pi.registerProvider("rea-neutrality-fixture", {
  baseUrl: "http://127.0.0.1:9", apiKey: "fixture-only-no-network",
  api: "openai-completions", models: [{
    id: "fixture", name: "Fixture", reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1050000, maxTokens: 1024,
  }],
});
const isMode = extension => [extension.path, extension.resolvedPath].some(value => {
  if (!value) return false;
  try { return realpathSync(value) === modeEntry; } catch { return false; }
});
async function create(includeMode) {
  const settingsManager = sdk.SettingsManager.inMemory({
    ...settings, compaction: { enabled: false }, retry: { enabled: false },
    defaultProvider: "rea-neutrality-fixture", defaultModel: "fixture",
  });
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd: scratch, agentDir: deployedAgentDir, settingsManager,
    extensionFactories: [fixtureProvider, sdk.createCodemodeExtension(),
      sdk.createToolSearchExtension(), sdk.createMcpExtension()],
    extensionsOverride: base => ({ ...base,
      extensions: includeMode ? base.extensions : base.extensions.filter(ext => !isMode(ext)),
    }),
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, [], "Deployed extension load errors");
  const modelRuntime = await sdk.ModelRuntime.create({
    authPath: path.join(scratchAgent, "auth.json"),
    modelsPath: path.join(scratchAgent, "models.json"),
  });
  const { session } = await sdk.createAgentSession({
    cwd: scratch, agentDir: scratchAgent, settingsManager, resourceLoader, modelRuntime,
    sessionManager: sdk.SessionManager.inMemory(scratch),
  });
  session.agent.streamFunction = noModelCalls;
  await session.bindExtensions({ mode: "tui", uiContext: ui,
    onError: error => errors.push(error),
  });
  await session.setModel(session._modelRuntime.getModel("rea-neutrality-fixture", "fixture"));
  sessions.push(session);
  return { session, resourceLoader };
}
const clean = value => JSON.parse(JSON.stringify(value, (key, child) => key === "timestamp" ? undefined : child));
async function view({ session, resourceLoader }) {
  const outcome = await session._extensionRunner.emitBeforeAgentStart("baseline input", undefined, session._baseSystemPromptOptions);
  return clean({
    activeTools: session.agent.state.tools,
    allTools: session.getAllTools(),
    prompt: buildSystemPrompt(outcome.systemPromptOptions), messages: outcome.messages,
    skills: resourceLoader.getSkills().skills, prompts: resourceLoader.getPrompts().prompts,
    model: session.model?.id, thinking: session.thinkingLevel,
    servers: session._extensionRunner.runtime?.mcpServers?.list?.() ?? [],
  });
}
async function capture({ session }) {
  let request;
  session.agent.streamFunction = (model, context) => {
    request = clean(context);
    const stream = new AssistantMessageEventStream();
    const message = {
      role: "assistant", content: [{ type: "text", text: "fixture response" }],
      api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    queueMicrotask(() => { stream.push({ type: "done", reason: "stop", message }); stream.end(); });
    return stream;
  };
  await session.prompt("Confirm that the default environment is unchanged.");
  session.agent.streamFunction = noModelCalls;
  assert(request, "No actual agent request was captured");
  return request;
}
try {
  const absent = await create(false);
  const installedOff = await create(true);
  const mode = installedOff.resourceLoader.getExtensions().extensions.find(isMode);
  assert(mode, "The deployed REA controller was not loaded");
  assert.equal(mode.tools.size, 0, "Off controller must register no tools");
  const baseline = await view(absent);
  assert.deepEqual(await view(installedOff), baseline, "Installed/off changes active tools, schemas, prompt or discovered resources");
  assert(!baseline.activeTools.some(tool => tool.name.startsWith("mcp__rea__")));
  const first = await capture(absent);
  const second = await capture(installedOff);
  assert.deepEqual(second, first, "The ACTUAL model request differs with the cold-off controller loaded");
  assert.deepEqual(errors, [], "Existing extension lifecycle errors");
  console.log(JSON.stringify({
    status: "pass", deployedExtensions: installedOff.resourceLoader.getExtensions().extensions.length,
    activeTools: baseline.activeTools.map(tool => tool.name),
    checks: ["all deployed extensions load", "off registers zero tools", "full schema and prompt equality",
      "skills/template equality", "actual first model-request equality", "no paid model or REA process"],
  }, null, 2));
} finally {
  for (const session of sessions) session.dispose();
  rmSync(scratch, { recursive: true, force: true });
}
