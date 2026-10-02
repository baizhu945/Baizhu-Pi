// Real Pi sessions and child sessions; deterministic in-memory provider, no network.
// Usage: node tests/completion-batching.mjs <Pi package dir> [Pi config source dir]
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [packageDir, configuredSource] = process.argv.slice(2);
assert(packageDir, 'Expected Pi package directory');
const sourceDir = configuredSource ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(packageDir, 'package.json'));
const dependencies = createRequire(path.join(process.env.PI_SUBAGENTS_TEST_DEPS ?? path.join(process.env.HOME, '.pi/agent/extensions/pi-subagents'), 'index.ts'));
const sdk = await import(pathToFileURL(path.join(packageDir, 'dist/index.js')));
const { AssistantMessageEventStream } = await import(pathToFileURL(path.join(packageDir, 'node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js')));
const { createJiti } = await import(pathToFileURL(require.resolve('jiti')));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const textOf = content => typeof content === 'string' ? content : (content ?? []).map(part => part.text ?? '').join('\n');
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert(Date.now() < deadline, 'Timed out waiting for fixture state');
    await wait(10);
  }
}
function finish(stream, model, content = [{ type: 'text', text: 'done' }]) {
  const toolUse = content.some(part => part.type === 'toolCall');
  const message = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
    stopReason: toolUse ? 'toolUse' : 'stop', timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  stream.push({ type: 'done', reason: message.stopReason, message });
  stream.end();
}
let sequence = 0;
async function setup(t, plugin, probeExecute, options = {}) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'pi-completion-batching-'));
  const agentDir = path.join(scratch, 'agent');
  mkdirSync(path.join(agentDir, 'agents'), { recursive: true });
  const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  const savedOffline = process.env.PI_OFFLINE;
  const savedCwd = process.cwd();
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_OFFLINE = '1';
  process.chdir(scratch);
  writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } }));
  writeFileSync(path.join(agentDir, 'subagents.json'), JSON.stringify({ schedulingEnabled: false, rememberAgents: false,
    outputTranscript: false, defaultJoinMode: options.joinMode ?? 'async' }));
  writeFileSync(path.join(agentDir, 'agents/completion-fixture.md'), '---\nname: completion-fixture\ndescription: Completion fixture\ntools: none\nextensions: false\nskills: false\ninherit_context: false\npersist_session: false\noutput_transcript: false\n---\nReturn the fixture result.\n');
  const jiti = createJiti(import.meta.url, { moduleCache: false, alias: {
    '@earendil-works/pi-coding-agent': path.join(packageDir, 'dist/index.js'),
    '@earendil-works/pi-tui': require.resolve('@earendil-works/pi-tui'),
    '@earendil-works/pi-ai': path.join(packageDir, 'node_modules/@earendil-works/pi-ai/dist/compat.js'),
    '@earendil-works/pi-agent-core': path.join(packageDir, 'node_modules/@earendil-works/pi-agent-core/dist/index.js'),
    '@sinclair/typebox': dependencies.resolve('@sinclair/typebox'),
    croner: dependencies.resolve('croner'), nanoid: dependencies.resolve('nanoid'),
    'typebox/value': require.resolve('typebox/value'),
    typebox: require.resolve('typebox'),
  } });
  const extensionPath = (plugin === 'background'
    ? [path.join(sourceDir, 'extensions/background-commands.ts'), path.join(sourceDir, 'background-commands.ts')]
    : [path.join(sourceDir, 'subagents/index.ts'), path.join(sourceDir, 'pi-subagents/index.ts')])
    .find(existsSync);
  assert(extensionPath, `Could not find ${plugin} extension in ${sourceDir}`);
  const extension = (await jiti.import(extensionPath)).default;
  const { Type } = await import(pathToFileURL(require.resolve('typebox')));
  let api, ctx;
  const children = new Map();
  const providerName = `completion-fixture-${++sequence}`;
  const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, steeringMode: 'one-at-a-time' });
  const loader = new sdk.DefaultResourceLoader({ cwd: scratch, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [extension, pi => {
      api = pi;
      pi.on('session_start', (_event, context) => { ctx = context; });
      pi.registerTool({ name: 'completion_probe', label: 'Completion probe', description: 'Fixture tool', parameters: Type.Object({}),
        async execute(...args) { if (probeExecute) await probeExecute(...args); return { content: [{ type: 'text', text: 'probe done' }] }; } });
      pi.registerProvider(providerName, { api: providerName, apiKey: 'fixture-only', baseUrl: 'http://127.0.0.1:9',
        streamSimple(model, context) {
          const marker = context.messages.map(message => textOf(message.content)).join('\n').match(/CHILD_[A-Z]+/)?.[0];
          assert(marker, 'Child prompt must contain fixture marker');
          const stream = new AssistantMessageEventStream();
          children.set(marker, () => finish(stream, model, [{ type: 'text', text: marker }]));
          return stream;
        },
        models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], contextWindow: 100000, maxTokens: 1024,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      });
    }],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await sdk.createAgentSession({ cwd: scratch, agentDir, settingsManager, resourceLoader: loader,
    sessionManager: sdk.SessionManager.inMemory(scratch) });
  await session.bindExtensions({ mode: 'sdk', onError: error => { throw new Error(JSON.stringify(error)); } });
  await session.setModel(session._modelRuntime.getModel(providerName, 'fixture'));
  const requests = [];
  let releaseParent;
  session.agent.streamFunction = (model, context) => {
    requests.push(context.messages);
    const stream = new AssistantMessageEventStream();
    if (requests.length === 1) releaseParent = content => finish(stream, model, content);
    else queueMicrotask(() => finish(stream, model));
    return stream;
  };
  const execute = (name, params) => {
    const tool = loader.getExtensions().extensions.flatMap(ext => [...ext.tools.values()]).find(tool => tool.definition.name === name);
    assert(tool, `Tool ${name} is registered`);
    return tool.definition.execute('fixture-call', params, undefined, undefined, ctx);
  };
  const notifications = () => session.messages.filter(message => message.role === 'custom' &&
    message.customType === (plugin === 'background' ? 'background-command-result' : 'subagent-notification'));
  async function complete(marker) {
    const registry = globalThis[Symbol.for('pi-subagents:manager')];
    assert(registry);
    const id = registry.spawn(api, ctx, 'completion-fixture', marker, { model: session.model, thinkingLevel: 'off' });
    await until(() => children.has(marker));
    children.get(marker)();
    await until(() => registry.getRecord(id)?.status === 'completed');
    return id;
  }
  // Background status observations are direct fixture calls, never parent tool calls.
  async function completeBackground(marker) {
    const started = await execute('bg_run', { command: `printf '%s\\n' ${marker}`, name: marker });
    const id = started.content[0].text.split(' ')[0];
    const deadline = Date.now() + 5000;
    while (true) {
      const result = await execute('bg_status', { id });
      if (result.content[0].text.startsWith(`${id} exited`)) break;
      assert(Date.now() < deadline, 'Background command did not complete');
      await wait(10);
    }
    return id;
  }
  t.after(async () => {
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    session.dispose();
    process.chdir(savedCwd);
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
    if (savedOffline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = savedOffline;
  });
  return { session, requests, execute, notifications, api, children, complete: plugin === 'background' ? completeBackground : complete,
    async startParent() { const done = session.prompt('parent fixture'); await until(() => releaseParent); return { done, release: releaseParent }; } };
}

for (const plugin of ['background', 'subagents']) {
  test(`${plugin}: staggered completions during inference arrive after one tool call`, { timeout: 20000 }, async t => {
    const h = await setup(t, plugin);
    const parent = await h.startParent();
    for (const marker of ['CHILD_ONE', 'CHILD_TWO', 'CHILD_THREE']) { await h.complete(marker); await wait(350); }
    assert.equal(h.notifications().length, 0, 'Results stay outside the steering queue during inference');
    parent.release([{ type: 'toolCall', id: 'probe', name: 'completion_probe', arguments: {} }]);
    await parent.done;
    assert.equal(h.notifications().length, 1);
    for (const marker of ['CHILD_ONE', 'CHILD_TWO', 'CHILD_THREE']) {
      assert.match(textOf(h.notifications()[0].content), new RegExp(marker));
      assert.match(JSON.stringify(h.requests[1]), new RegExp(marker));
    }
    assert.equal(h.requests.length, 2, 'One continuation sees all three results');
    assert.equal(h.session.messages.filter(message => message.role === 'toolResult').length, 1);
  });
  test(`${plugin}: staggered completions during a tool call stay together`, { timeout: 20000 }, async t => {
    let h;
    h = await setup(t, plugin, async () => {
      for (const marker of ['CHILD_ONE', 'CHILD_TWO', 'CHILD_THREE']) { await h.complete(marker); await wait(350); }
    });
    const parent = await h.startParent();
    parent.release([{ type: 'toolCall', id: 'probe', name: 'completion_probe', arguments: {} }]);
    await parent.done;
    assert.equal(h.notifications().length, 1);
    assert.equal(h.requests.length, 2);
    assert.match(textOf(h.notifications()[0].content), /CHILD_ONE[\s\S]*CHILD_TWO[\s\S]*CHILD_THREE/);
  });
  test(`${plugin}: idle completion burst automatically wakes the parent once`, { timeout: 20000 }, async t => {
    const h = await setup(t, plugin);
    h.session.agent.streamFunction = (model, context) => {
      h.requests.push(context.messages);
      const stream = new AssistantMessageEventStream();
      queueMicrotask(() => finish(stream, model));
      return stream;
    };
    for (const marker of ['CHILD_ONE', 'CHILD_TWO', 'CHILD_THREE']) await h.complete(marker);
    await until(() => h.notifications().length === 1 && h.session.isIdle);
    assert.equal(h.requests.length, 1);
    assert.match(textOf(h.notifications()[0].content), /CHILD_ONE[\s\S]*CHILD_TWO[\s\S]*CHILD_THREE/);
  });
  test(`${plugin}: a final answer without tools also flushes pending results`, { timeout: 20000 }, async t => {
    const h = await setup(t, plugin);
    const parent = await h.startParent();
    await h.complete('CHILD_ONE');
    await wait(350);
    parent.release([{ type: 'text', text: 'first answer' }]);
    await parent.done;
    assert.equal(h.notifications().length, 1);
    assert.equal(h.requests.length, 2);
    assert.equal(h.session.messages.filter(message => message.role === 'toolResult').length, 0);
  });
}

test('subagents: grouped and independent results share one delivery', { timeout: 20000 }, async t => {
  const h = await setup(t, 'subagents', undefined, { joinMode: 'group' });
  const parent = await h.startParent();
  const started = await Promise.all(['CHILD_ONE', 'CHILD_TWO'].map(marker => h.execute('Agent', {
    subagent_type: 'completion-fixture', description: marker, prompt: marker, thinking: 'off',
  })));
  await until(() => h.children.size === 2);
  await wait(150); // allow the spawn group to finalize before any child finishes
  for (const marker of ['CHILD_ONE', 'CHILD_TWO']) h.children.get(marker)();
  const registry = globalThis[Symbol.for('pi-subagents:manager')];
  await until(() => started.every(result => registry.getRecord(result.details.agentId)?.status === 'completed'));
  await wait(350);
  await h.complete('CHILD_THREE');
  parent.release([{ type: 'toolCall', id: 'probe', name: 'completion_probe', arguments: {} }]);
  await parent.done;
  assert.equal(h.notifications().length, 1);
  assert.equal(h.requests.length, 2);
  assert.match(textOf(h.notifications()[0].content), /CHILD_ONE[\s\S]*CHILD_TWO[\s\S]*CHILD_THREE/);
  assert.equal(h.notifications()[0].details.others.length, 2);
});

test('subagents: workflow and agent results share one delivery', { timeout: 20000 }, async t => {
  const h = await setup(t, 'subagents');
  const parent = await h.startParent();
  const started = await h.execute('SubagentWorkflow', {
    script: 'export const meta = { name: "Fixture", description: "Completion fixture" };\nreturn "WORKFLOW_RESULT";',
  });
  assert(started.details?.taskId, textOf(started.content));
  await wait(350);
  await h.complete('CHILD_ONE');
  parent.release([{ type: 'toolCall', id: 'probe', name: 'completion_probe', arguments: {} }]);
  await parent.done;
  assert.equal(h.notifications().length, 1);
  assert.equal(h.requests.length, 2);
  assert.match(textOf(h.notifications()[0].content), /WORKFLOW_RESULT/);
  assert.match(textOf(h.notifications()[0].content), /CHILD_ONE/);
});

test('subagents: RPC consumption removes one result from the pending batch', { timeout: 20000 }, async t => {
  const h = await setup(t, 'subagents');
  const parent = await h.startParent();
  const consumed = await h.complete('CHILD_ONE');
  await h.complete('CHILD_TWO');
  const reply = await new Promise(resolve => {
    const unsubscribe = h.api.events.on('subagents:rpc:consume:reply:fixture', result => { unsubscribe(); resolve(result); });
    h.api.events.emit('subagents:rpc:consume', { requestId: 'fixture', agentId: consumed });
  });
  assert.deepEqual(reply, { success: true });
  parent.release([{ type: 'text', text: 'first answer' }]);
  await parent.done;
  assert.equal(h.notifications().length, 1);
  assert.doesNotMatch(textOf(h.notifications()[0].content), /CHILD_ONE/);
  assert.match(textOf(h.notifications()[0].content), /CHILD_TWO/);
});
