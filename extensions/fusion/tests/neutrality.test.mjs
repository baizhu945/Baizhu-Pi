// Integration against the real Pi loader, session runtime and prompt builder.
// All config/state are temporary. Commands never contact a model or spawn Pi.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageDir = process.argv[2];
assert(packageDir, 'Pass the Pi package directory');
const root = mkdtempSync(path.join(os.tmpdir(), 'fusion-real-pi-'));
process.env.HOME = path.join(root, 'home');
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
process.env.PI_OFFLINE = '1';
delete process.env.UNIPI_FUSION_CHILD;
mkdirSync(process.env.HOME);
mkdirSync(path.join(process.env.HOME, '.unipi', 'config', 'fusion'), { recursive: true });
// Regression: another session remembered Fusion. This must never grant a new
// or resumed-unconsenting session authorization, even for the same lead model.
writeFileSync(path.join(process.env.HOME, '.unipi', 'config', 'fusion', 'preset.json'), JSON.stringify({
  active: { kind: 'fusion', lead: 'fusion-fixture/lead', sidekick: 'fusion-fixture/side', leadEffort: 'medium', sidekickEffort: 'low' },
  default: { lead: 'fusion-fixture/lead', sidekick: 'fusion-fixture/side' },
}));
mkdirSync(path.join(process.env.PI_CODING_AGENT_DIR, 'skills', 'fixture'), { recursive: true });
mkdirSync(path.join(process.env.PI_CODING_AGENT_DIR, 'prompts'), { recursive: true });
writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'AGENTS.md'), 'Keep the existing project instructions unchanged.');
writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'skills', 'fixture', 'SKILL.md'), '---\nname: fixture\ndescription: An existing skill used to check resource neutrality.\n---\nDo the existing skill workflow.\n');
writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'prompts', 'fixture.md'), '---\ndescription: Existing template\n---\nExisting prompt template.\n');
process.chdir(root);
const sdk = await import(pathToFileURL(path.join(packageDir, 'dist/index.js')));
const { buildSystemPrompt } = await import(pathToFileURL(path.join(packageDir, 'dist/core/system-prompt.js')));
const { AssistantMessageEventStream } = await import(pathToFileURL(path.join(packageDir, 'node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js')));
const extensionPath = process.argv[3] ?? fileURLToPath(new URL('../index.ts', import.meta.url));
const errors = [];
let nextChoice;
const ui = {
  notify() {}, addAutocompleteProvider() {}, setWidget() {}, setStatus() {},
  custom: async () => nextChoice,
};
const provider = pi => pi.registerProvider('fusion-fixture', {
  baseUrl: 'http://127.0.0.1:9', apiKey: 'test-only-not-a-real-secret', api: 'openai-completions',
  models: ['lead', 'side'].map(id => ({
    id, name: id, reasoning: true, input: ['text'],
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 2048,
  })),
});
const sessions = [];
async function create(loadFusion, options = {}) {
  const settingsManager = sdk.SettingsManager.inMemory({
    defaultProvider: 'fusion-fixture', defaultModel: 'lead', defaultThinkingLevel: 'medium',
    compaction: { enabled: false }, retry: { enabled: false },
  });
  const loader = new sdk.DefaultResourceLoader({
    cwd: root, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager,
    noExtensions: true, noThemes: true,
    additionalExtensionPaths: loadFusion ? [extensionPath] : [],
    extensionFactories: [provider],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await sdk.createAgentSession({
    cwd: root, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager,
    resourceLoader: loader, sessionManager: options.sessionManager ?? sdk.SessionManager.inMemory(root),
    ...(options.modelRuntime ? { modelRuntime: options.modelRuntime } : {}),
  });
  session.agent.streamFunction = () => { throw new Error('A test tried to contact a model'); };
  await session.bindExtensions({ mode: 'tui', uiContext: ui, onError: error => errors.push(error) });
  // Inline providers become available after construction; select the fixture
  // explicitly, just as CLI startup selects its already-configured provider.
  if (!options.keepRestoredModel) {
    await session.setModel(session._modelRuntime.getModel('fusion-fixture', 'lead'));
    session.setThinkingLevel('medium');
  }
  sessions.push(session);
  return { session, loader };
}
async function view({ session, loader }) {
  const outcome = await session._extensionRunner.emitBeforeAgentStart('test input', undefined, session._baseSystemPromptOptions);
  return {
    tools: session.agent.state.tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
    prompt: buildSystemPrompt(outcome.systemPromptOptions),
    messages: outcome.messages,
    skills: loader.getSkills().skills,
    templates: loader.getPrompts().prompts,
    model: session.model?.id,
    thinking: session.thinkingLevel,
  };
}

await test('real Pi: absent and cold disabled Fusion have identical model inputs and resources', async () => {
  const absent = await create(false);
  const loaded = await create(true);
  const baseline = await view(absent);
  assert.equal(baseline.skills.length, 1);
  assert.equal(baseline.templates.length, 1);
  assert.match(baseline.prompt, /existing project instructions/);
  const ext = loaded.loader.getExtensions().extensions.find(ext => ext.resolvedPath === extensionPath);
  assert(ext);
  assert.equal(ext.tools.size, 0, 'cold disabled mode must not register tools');
  assert.deepEqual(await view(loaded), baseline);
  globalThis.fusionFixture = { absent, loaded, baseline };
});

await test('real Pi: cold disabled mode produces the exact same LLM request context', async () => {
  const { absent, loaded } = globalThis.fusionFixture;
  const captured = [];
  for (const { session } of [absent, loaded]) {
    session.agent.streamFunction = (model, context) => {
      captured.push(JSON.parse(JSON.stringify(context, (key, value) => key === 'timestamp' ? undefined : value)));
      const stream = new AssistantMessageEventStream();
      const message = {
        role: 'assistant', content: [{ type: 'text', text: 'fixture response' }],
        api: model.api, provider: model.provider, model: model.id, stopReason: 'stop', timestamp: 0,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      queueMicrotask(() => { stream.push({ type: 'done', reason: 'stop', message }); stream.end(); });
      return stream;
    };
    await session.prompt('Check the unchanged model inputs.');
    session.agent.streamFunction = () => { throw new Error('A test tried to contact a model'); };
  }
  assert.equal(captured.length, 2);
  assert.deepEqual(captured[1], captured[0]);
});

await test('real Pi: activation adds exactly two tools; same-lead single mode restores the exact baseline', async () => {
  const { loaded, baseline } = globalThis.fusionFixture;
  nextChoice = {
    type: 'fusion', lead: 'fusion-fixture/lead', sidekick: 'fusion-fixture/side',
    leadEffort: 'medium', sidekickEffort: 'low', effortMap: {},
  };
  await loaded.session.prompt('/unipi:model');
  const active = await view(loaded);
  assert.deepEqual(active.tools.map(tool => tool.name), [...baseline.tools.map(tool => tool.name), 'sidekick', 'read_subagent']);
  assert.match(active.prompt, /You are powered by Fusion/);
  assert.match(active.prompt, /Fusion lead is coordination-only/);
  assert.match(active.prompt, /no execution exceptions while Fusion is active/);
  const handoff = active.tools.find(tool => tool.name === 'sidekick');
  assert.match(handoff.description, /Delegate all task execution/);
  assert.match(handoff.parameters.properties.message.description, /the lead does not execute task work/);
  assert.deepEqual(active.skills, baseline.skills);
  assert.deepEqual(active.templates, baseline.templates);
  const marker = loaded.session.sessionManager.getBranch().findLast(entry => entry.type === 'custom' && entry.customType === 'fusion-session-state');
  assert(marker, 'explicit user confirmation must write session-only state');
  assert.equal(marker.data.sessionId, loaded.session.sessionManager.getSessionId());
  assert.equal(JSON.stringify(loaded.session.agent.state.messages).includes('fusion-session-state'), false, 'authorization data must not enter model context');
  assert.deepEqual(await view(await create(true)), baseline, 'a second session must not inherit the globally remembered active pair');
  const clone = sdk.SessionManager.inMemory(root);
  clone.appendCustomEntry('fusion-session-state', marker.data);
  assert.deepEqual(await view(await create(true, { sessionManager: clone })), baseline, 'copied parent state cannot authorize a clone/fork');
  const resumed = await create(true, { sessionManager: loaded.session.sessionManager, modelRuntime: loaded.session._modelRuntime });
  const resumedView = await view(resumed);
  assert.deepEqual(resumedView.tools, active.tools, 'only the exact consenting session restores its pair');
  assert.match(resumedView.prompt, /You are powered by Fusion/);
  nextChoice = { type: 'single', model: 'fusion-fixture/lead', effort: 'medium', effortMap: {} };
  await loaded.session.prompt('/unipi:model');
  assert.deepEqual(await view(loaded), baseline);
  assert.deepEqual(await view(resumed), baseline, 'a stale active snapshot must revoke tools after the branch is disabled');
});

await test('real Pi: persisted single selection is neutral after a fresh load', async () => {
  const { baseline } = globalThis.fusionFixture;
  assert.deepEqual(await view(await create(true)), baseline);
});

await test('real Pi: a native model switch while Fusion is unloaded revokes an older session opt-in', async () => {
  const { loaded, baseline } = globalThis.fusionFixture;
  nextChoice = { type: 'fusion', lead: 'fusion-fixture/lead', sidekick: 'fusion-fixture/side', leadEffort: 'medium', sidekickEffort: 'low', effortMap: {} };
  await loaded.session.prompt('/unipi:model');
  const manager = loaded.session.sessionManager;
  const without = await create(false, { sessionManager: manager, modelRuntime: loaded.session._modelRuntime });
  await without.session.setModel(without.session._modelRuntime.getModel('fusion-fixture', 'side'));
  assert.equal(manager.getBranch().findLast(entry => entry.type === 'custom' && entry.customType === 'fusion-session-state').data.selection.kind, 'fusion', 'no unloaded extension wrote a revocation marker');
  const restored = await create(true, { sessionManager: manager, modelRuntime: loaded.session._modelRuntime, keepRestoredModel: true });
  const result = await view(restored);
  assert.equal(result.model, 'side', 'loading Fusion must not override the model selected while it was absent');
  assert.deepEqual(result.tools, baseline.tools);
  assert.equal(result.prompt, baseline.prompt);
  assert.deepEqual(result.messages, []);
});

await test('real Pi: child guard registers no Fusion tools, policy, commands or event handlers', async () => {
  process.env.UNIPI_FUSION_CHILD = '1';
  try {
    const child = await create(true);
    const ext = child.loader.getExtensions().extensions.find(ext => ext.resolvedPath === extensionPath);
    assert.equal(ext.tools.size, 0);
    assert.equal(ext.commands.size, 0);
    assert.equal(ext.handlers.size, 0);
    assert.deepEqual(await view(child), globalThis.fusionFixture.baseline);
  } finally { delete process.env.UNIPI_FUSION_CHILD; }
});

for (const session of sessions) session.dispose();
assert.deepEqual(errors, []);
console.log('Actual Pi model-input integration fixtures completed; no model calls.');
