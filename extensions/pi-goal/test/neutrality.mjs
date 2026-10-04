import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const sdkRoot = process.argv[2];
const packageRoot = path.resolve(process.argv[3] ?? new URL('..', import.meta.url).pathname);
assert(sdkRoot, 'Pass the installed Pi SDK directory');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-goal-neutrality-'));
process.env.HOME = path.join(root, 'home');
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
process.env.PI_OFFLINE = '1';
fs.mkdirSync(process.env.HOME);
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR);
fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'AGENTS.md'), 'Keep existing instructions and tool policies unchanged.');
const sdk = await import(pathToFileURL(path.join(sdkRoot, 'dist/index.js')));
const { AssistantMessageEventStream } = await import(pathToFileURL(path.join(sdkRoot, 'node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js')));
const goalNames = ['goal_complete', 'goal_blocked', 'goal_wait'];
const sessions = [];
const ui = { notify() {}, setStatus() {}, setWidget() {}, confirm: async () => true, custom: async () => undefined };
const goalState = (manager) => manager.getBranch().findLast(e => e.type === 'custom' && e.customType === 'goal-state')?.data.goal;
const tools = (session) => session.agent.state.tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
const normalize = value => JSON.parse(JSON.stringify(value, (key, item) => key === 'timestamp' ? undefined : item));
const waitFor = async predicate => {
  for (let n = 0; n < 300; n++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert(predicate(), 'Goal transition did not settle');
};
function seededGoal(status) {
  return { id: 'fixture-goal', text: 'Verify a fixture goal', status, startedAt: Date.now(), updatedAt: Date.now(),
    iteration: 0, tokensUsed: 0, timeUsedSeconds: 0, baselineTokens: 0, automaticModelTurns: 0, toolFreeRepeatCount: 0 };
}
async function create(includeGoal, options = {}) {
  const settingsManager = sdk.SettingsManager.inMemory({ defaultProvider: 'goal-fixture', defaultModel: 'test',
    compaction: { enabled: false }, retry: { enabled: false }, packages: includeGoal ? [packageRoot] : [] });
  const provider = pi => {
    pi.registerProvider('goal-fixture', { baseUrl: 'http://127.0.0.1:9', apiKey: 'test-only', api: 'openai-completions',
      models: [{ id: 'test', name: 'Fixture', reasoning: true, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 2048 }] });
    if (options.collision) pi.registerTool({ name: 'goal_complete', label: 'Existing unrelated tool',
      description: 'An unrelated tool that must stay available.', parameters: { type: 'object', properties: {} },
      execute: async () => ({ content: [{ type: 'text', text: 'existing' }] }) });
  };
  const loader = new sdk.DefaultResourceLoader({ cwd: root, agentDir: process.env.PI_CODING_AGENT_DIR,
    settingsManager, noThemes: true, extensionFactories: [provider] });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  assert.deepEqual(loader.getExtensions().warnings ?? [], []);
  const manager = options.manager ?? sdk.SessionManager.inMemory(root);
  if (options.status) manager.appendCustomEntry('goal-state', { goal: seededGoal(options.status) });
  const { session } = await sdk.createAgentSession({ cwd: root, agentDir: process.env.PI_CODING_AGENT_DIR,
    settingsManager, resourceLoader: loader, sessionManager: manager,
    ...(options.excludeTools ? { excludeTools: options.excludeTools } : {}) });
  sessions.push(session);
  const errors = [];
  const notices = [];
  const fixture = { session, loader, manager, errors, notices, contexts: [], response: 'text' };
  session.agent.streamFunction = (model, context) => {
    fixture.contexts.push(normalize(context));
    const goal = goalState(manager);
    const name = fixture.response === 'wait' ? 'goal_wait' : fixture.response === 'complete' ? 'goal_complete' : undefined;
    const content = name ? [{ type: 'toolCall', id: 'fixture-call', name, arguments: name === 'goal_wait'
      ? { goal_id: goal.id, reason: 'Await an explicit user resume.' }
      : { goal_id: goal.id, summary: 'All fixture requirements were verified with offline checks.' } }]
      : [{ type: 'text', text: 'Fixture response.' }];
    const stream = new AssistantMessageEventStream();
    const message = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
      stopReason: name ? 'toolUse' : 'stop', timestamp: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    queueMicrotask(() => { stream.push({ type: 'done', reason: message.stopReason, message }); stream.end(); });
    return stream;
  };
  await session.bindExtensions({ mode: 'tui', uiContext: { ...ui, notify: text => notices.push(text) }, onError: e => errors.push(e) });
  await session.setModel(session._modelRuntime.getModel('goal-fixture', 'test'));
  return fixture;
}
const command = (fixture, args) => fixture.session.prompt('/goal' + (args ? ' ' + args : ''));
let baseline;

await test('loaded but unused: no Goal registration; exact tools, prompt and provider context match an absent plugin', async () => {
  const absent = await create(false);
  const loaded = await create(true);
  const ext = loaded.loader.getExtensions().extensions.find(e => e.commands.has('goal'));
  assert(ext, '/goal stays available');
  assert.equal(ext.tools.size, 0);
  await absent.session.prompt('Inspect the existing tools.');
  await loaded.session.prompt('Inspect the existing tools.');
  assert.deepEqual(loaded.contexts, absent.contexts);
  assert.deepEqual(tools(loaded.session), tools(absent.session));
  assert.equal(loaded.session.systemPrompt, absent.session.systemPrompt);
  baseline = { tools: tools(absent.session), prompt: absent.session.systemPrompt, context: absent.contexts[0] };
  await command(loaded, ''); // Cancel the manager without activating a goal.
  await command(loaded, 'status');
  await command(loaded, 'clear');
  assert.equal(ext.tools.size, 0);
  assert.deepEqual(tools(loaded.session), baseline.tools);
  assert.deepEqual(loaded.errors, []);
});

for (const status of ['paused', 'blocked', 'usage_limited', 'budget_limited', 'complete']) {
  await test(`restore ${status}: no Goal tools or inactive prompt injected`, async () => {
    const fixture = await create(true, { status });
    await fixture.session.prompt('Inspect the existing tools.');
    assert.deepEqual(tools(fixture.session), baseline.tools);
    assert.equal(fixture.session.systemPrompt, baseline.prompt);
    assert.deepEqual(fixture.contexts[0], baseline.context);
    assert.deepEqual(fixture.errors, []);
  });
}

await test('start, pause, resume, clear: tools and contracts follow the mode; ordinary tool selection is restored', async () => {
  const fixture = await create(true);
  fixture.response = 'wait';
  await command(fixture, 'Verify local Goal activation.');
  await waitFor(() => goalState(fixture.manager)?.waiting && !fixture.session.isStreaming);
  assert.deepEqual(tools(fixture.session).map(t => t.name), [...baseline.tools.map(t => t.name), ...goalNames]);
  assert(JSON.stringify(fixture.contexts.at(-1)).includes('Active /goal context:'));
  await command(fixture, 'pause');
  assert.equal(goalState(fixture.manager).status, 'paused');
  assert.deepEqual(tools(fixture.session), baseline.tools);
  fixture.response = 'text';
  await fixture.session.prompt('Continue ordinary conversation.');
  assert.equal(fixture.session.systemPrompt, baseline.prompt);
  assert(!JSON.stringify(fixture.contexts.at(-1)).includes('Goal mode is inactive.'));
  assert(!JSON.stringify(fixture.contexts.at(-1)).includes('This Goal contract supersedes'));
  fixture.response = 'wait';
  await command(fixture, 'resume');
  await waitFor(() => goalState(fixture.manager)?.waiting && !fixture.session.isStreaming);
  assert(tools(fixture.session).some(t => t.name === 'goal_complete'));
  await command(fixture, 'clear');
  assert.equal(goalState(fixture.manager), null);
  assert.deepEqual(tools(fixture.session), baseline.tools);
  assert.equal(fixture.session.systemPrompt, baseline.prompt);
  assert.deepEqual(fixture.errors, []);
});

await test('completion immediately hides Goal tools and removes obsolete contract injections', async () => {
  const fixture = await create(true);
  fixture.response = 'complete';
  await command(fixture, 'Verify a complete fixture.');
  await waitFor(() => goalState(fixture.manager) === null && !fixture.session.isStreaming);
  assert.deepEqual(tools(fixture.session), baseline.tools);
  fixture.response = 'text';
  await fixture.session.prompt('Continue ordinary conversation.');
  assert.equal(fixture.session.systemPrompt, baseline.prompt);
  assert(!JSON.stringify(fixture.contexts.at(-1)).includes('This Goal contract supersedes'));
  assert.deepEqual(fixture.errors, []);
});

await test('restore an active session: lazily register Goal tools and restore its contract', async () => {
  const fixture = await create(true, { status: 'active' });
  assert.deepEqual(tools(fixture.session).map(t => t.name), [...baseline.tools.map(t => t.name), ...goalNames]);
  assert(fixture.manager.getBranch().some(e => e.customType === 'goal-contract'));
  await command(fixture, 'clear');
  assert.deepEqual(tools(fixture.session), baseline.tools);
  assert.deepEqual(fixture.errors, []);
});

await test('unrelated tools with a Goal name survive unused mode and rejected activation', async () => {
  const fixture = await create(true, { collision: true });
  const before = tools(fixture.session);
  await command(fixture, 'Try a colliding activation.');
  assert.deepEqual(tools(fixture.session), before);
  assert.equal(goalState(fixture.manager), undefined);
  assert(fixture.notices.some(text => text.includes('already belong to another extension')));
  assert.deepEqual(fixture.errors, []);
});

await test('an explicit Pi denylist prevents activation without leaking the other Goal tools', async () => {
  const fixture = await create(true, { excludeTools: ['goal_complete'] });
  await command(fixture, 'Try a denied activation.');
  assert.equal(goalState(fixture.manager), undefined);
  assert.deepEqual(tools(fixture.session), baseline.tools);
  assert(fixture.notices.some(text => text.includes('excluded by the Pi tool selection')));
  assert.deepEqual(fixture.errors, []);
});

for (const session of sessions) session.dispose();
console.log('Actual Pi loader/session/provider-input checks passed; no model or network calls.');
