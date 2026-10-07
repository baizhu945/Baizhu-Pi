// Actual Pi parent/child sessions with deterministic provider errors; no network.
// node tests/subagent-failure-recovery.mjs <Pi SDK dir> [subagents package dir]
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [sdkDir, configuredPackage] = process.argv.slice(2);
assert(sdkDir, 'Expected Pi SDK directory');
const pluginDir = configuredPackage ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../extensions/subagents');
const require = createRequire(path.join(sdkDir, 'package.json'));
const dependencies = createRequire(path.join(process.env.PI_SUBAGENTS_TEST_DEPS ?? path.join(process.env.HOME, '.pi/agent/extensions/pi-subagents'), 'index.ts'));
const sdk = await import(pathToFileURL(path.join(sdkDir, 'dist/index.js')));
const { AssistantMessageEventStream } = await import(pathToFileURL(path.join(sdkDir, 'node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js')));
const { createJiti } = await import(pathToFileURL(require.resolve('jiti')));
const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false, alias: {
  '@earendil-works/pi-coding-agent': path.join(sdkDir, 'dist/index.js'),
  '@earendil-works/pi-tui': require.resolve('@earendil-works/pi-tui'),
  '@earendil-works/pi-ai': path.join(sdkDir, 'node_modules/@earendil-works/pi-ai/dist/compat.js'),
  '@earendil-works/pi-agent-core': path.join(sdkDir, 'node_modules/@earendil-works/pi-agent-core/dist/index.js'),
  '@sinclair/typebox': dependencies.resolve('@sinclair/typebox'),
  croner: dependencies.resolve('croner'), nanoid: dependencies.resolve('nanoid'),
  typebox: require.resolve('typebox'), 'typebox/value': require.resolve('typebox/value'),
} });
const plugin = (await jiti.import(path.join(pluginDir, 'index.ts'))).default;
const runner = await jiti.import(path.join(pluginDir, 'src/agent-runner.ts'));
const {AgentManager} = await jiti.import(path.join(pluginDir, 'src/agent-manager.ts'));
const {createWorkflowHost} = await jiti.import(path.join(pluginDir, 'src/workflow/host.ts'));
const {createNestedSubagentTools} = await jiti.import(path.join(pluginDir, 'src/nested-tools.ts'));
const { compileJsonSchema } = await jiti.import(path.join(pluginDir, 'src/workflow/json-schema.ts'));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const text = content => typeof content === 'string' ? content : (content ?? []).map(part => part.text ?? '').join('\n');
const hasRecovery = context => context.messages.some(m => text(m.content).includes('The previous model response failed with an upstream idle timeout.'));
async function until(predicate) {
  const deadline = Date.now() + 6000;
  while (!predicate()) { assert(Date.now() < deadline, 'Timed out waiting for fixture'); await wait(10); }
}
function respond(stream, model, content, error) {
  const message = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
    stopReason: error ? 'error' : content.some(p => p.type === 'toolCall') ? 'toolUse' : 'stop',
    ...(error ? { errorMessage: error } : {}), timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  stream.push(error ? { type: 'error', reason: 'error', error: message } : { type: 'done', reason: message.stopReason, message });
  stream.end();
}

let sequence = 0;
async function setup(t, produce, retry = { enabled: true, maxRetries: 2, baseDelayMs: 1 }) {
  const scratch = fs.mkdtempSync(path.join(tmpdir(), 'pi-subagent-recovery-'));
  const agentDir = path.join(scratch, 'agent');
  fs.mkdirSync(path.join(agentDir, 'agents'), { recursive: true });
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR, previousOffline = process.env.PI_OFFLINE, previousCwd = process.cwd();
  process.env.PI_CODING_AGENT_DIR = agentDir; process.env.PI_OFFLINE = '1'; process.chdir(scratch);
  fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ compaction: { enabled: false }, retry }));
  fs.writeFileSync(path.join(agentDir, 'subagents.json'), JSON.stringify({ schedulingEnabled: false, rememberAgents: false, outputTranscript: false }));
  fs.writeFileSync(path.join(agentDir, 'agents/recovery-fixture.md'), '---\nname: recovery-fixture\ndescription: Recovery fixture\ntools: read, write, edit\nextensions: false\nskills: false\ninherit_context: false\npersist_session: false\noutput_transcript: false\n---\nComplete the requested fixture.\n');
  const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const calls = [], events = [], failures = [];
  let api, ctx;
  const providerName = `recovery-fixture-${++sequence}`;
  const loader = new sdk.DefaultResourceLoader({ cwd: scratch, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [plugin, pi => {
      api = pi; pi.on('session_start', (_event, context) => { ctx = context; });
      for (const kind of ['subagents:completed', 'subagents:failed']) pi.events.on(kind, data => events.push({ kind, data }));
      pi.registerProvider(providerName, { api: providerName, apiKey: 'fixture-only', baseUrl: 'http://127.0.0.1:9',
        streamSimple(model, context) {
          const stream = new AssistantMessageEventStream();
          calls.push(context);
          queueMicrotask(async () => {
            try { const result = await produce(calls.length, context, scratch); respond(stream, model, result.content ?? [], result.error); }
            catch (error) { respond(stream, model, [], String(error)); }
          });
          return stream;
        },
        models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], contextWindow: 100000, maxTokens: 1024,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      });
    }],
  });
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await sdk.createAgentSession({ cwd: scratch, agentDir, settingsManager, resourceLoader: loader, sessionManager: sdk.SessionManager.inMemory(scratch) });
  await session.bindExtensions({ mode: 'sdk', onError: error => failures.push(error) });
  await session.setModel(session._modelRuntime.getModel(providerName, 'fixture'));
  session.agent.streamFunction = model => { const stream = new AssistantMessageEventStream(); queueMicrotask(() => respond(stream, model, [{ type: 'text', text: 'parent acknowledged' }])); return stream; };
  const execute = (name, params) => loader.getExtensions().extensions.flatMap(e => [...e.tools.values()]).find(t => t.definition.name === name).definition.execute('fixture', params, undefined, undefined, ctx);
  const notifications = () => session.messages.filter(m => m.role === 'custom' && m.customType === 'subagent-notification');
  const manager = () => globalThis[Symbol.for('pi-subagents:manager')];
  let cleanupSession = session;
  const spawn = async () => {
    const response = await execute('Agent', { subagent_type: 'recovery-fixture', description: 'Fixture work', prompt: 'Complete the fixture and return the result.' });
    const id = response.details.agentId; assert(id, text(response.content)); return id;
  };
  const settled = async id => { await until(() => ['completed', 'error', 'stopped'].includes(manager().getRecord(id)?.status)); await until(() => notifications().some(m => text(m.content).includes(id))); return manager().getRecord(id); };
  t.after(async () => {
    if (cleanupSession) { await cleanupSession.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); cleanupSession.dispose(); }
    assert.deepEqual(failures, []); process.chdir(previousCwd);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousOffline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = previousOffline;
  });
  return { session, api, ctx: () => ctx, calls, events, notifications, execute, manager, spawn, settled, scratch,
    agentDir, settingsManager, loader, setCleanupSession: value => { cleanupSession = value; } };
}

test('already-cancelled spawn never initializes or contacts a provider', { timeout: 15000 }, async t => {
  const h = await setup(t, () => { throw new Error('Unexpected provider request'); });
  await assert.rejects(runner.runAgent(h.ctx(), 'recovery-fixture', 'cancelled', {
    pi: h.api, signal: AbortSignal.abort(new DOMException('Cancelled fixture', 'AbortError')),
  }), {name: 'AbortError'});
  assert.equal(h.calls.length, 0);
});

test('cancellation at session creation cannot start a fresh model request', { timeout: 15000 }, async t => {
  const h = await setup(t, () => { throw new Error('Unexpected provider request'); });
  const controller = new AbortController(); let child;
  try {
    await assert.rejects(runner.runAgent(h.ctx(), 'recovery-fixture', 'cancelled', {
      pi: h.api, signal: controller.signal, onSessionCreated: session => { child = session; controller.abort(); },
    }), {name: 'AbortError'});
    assert.equal(h.calls.length, 0);
  } finally { if (child) { await child.extensionRunner.emit({type: 'session_shutdown', reason: 'quit'}); child.dispose(); } }
});

test('already-cancelled resume keeps the prior result without another provider request', { timeout: 15000 }, async t => {
  const h = await setup(t, () => ({content: [{type: 'text', text: 'FIRST_RESULT'}]}));
  const id = await h.spawn(), record = await h.settled(id);
  await assert.rejects(runner.resumeAgent(record.session, 'cancelled', {
    signal: AbortSignal.abort(new DOMException('Cancelled fixture', 'AbortError')),
  }), {name: 'AbortError'});
  assert.equal(h.calls.length, 1); assert.equal(record.result, 'FIRST_RESULT');
});

test('actual Pi runtime replacement stops old children and isolates their late results', { timeout: 15000 }, async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const h = await setup(t, async () => { await gate; return {content: [{type: 'text', text: 'OLD_SESSION_RESULT'}]}; });
  const id = await h.spawn(); await until(() => h.calls.length === 1);
  const oldRecord = h.manager().getRecord(id), oldSessionId = h.session.sessionManager.getSessionId();
  const services = {cwd: h.scratch, agentDir: h.agentDir, settingsManager: h.settingsManager,
    modelRuntime: h.session.modelRuntime, resourceLoader: h.loader, diagnostics: []};
  const runtime = new sdk.AgentSessionRuntime(h.session, services, async options => {
    const loader = new sdk.DefaultResourceLoader({cwd: options.cwd, agentDir: options.agentDir,
      settingsManager: h.settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true,
      noThemes: true, noContextFiles: true, extensionFactories: [plugin]});
    await loader.reload();
    const result = await sdk.createAgentSession({cwd: options.cwd, agentDir: options.agentDir,
      settingsManager: h.settingsManager, resourceLoader: loader, sessionManager: options.sessionManager,
      model: h.session.model, sessionStartEvent: options.sessionStartEvent});
    return {...result, services: {...services, resourceLoader: loader}, diagnostics: []};
  });
  runtime.setRebindSession(session => session.bindExtensions({mode: 'sdk'}));
  try {
    assert.deepEqual(await runtime.newSession(), {cancelled: false});
    h.setCleanupSession(runtime.session);
    assert.notEqual(runtime.session.sessionManager.getSessionId(), oldSessionId);
    assert.equal(oldRecord.status, 'stopped'); assert(oldRecord.abortController.signal.aborted);
    release(); await oldRecord.promise; await wait(150);
    assert(!JSON.stringify(runtime.session.messages).includes('OLD_SESSION_RESULT'));
    assert.equal(globalThis[Symbol.for('pi-subagents:manager')].getRecord(id), undefined);
  } finally { release(); }
});

test('worktree gates run before cleanup without exposing a premature completed status', { timeout: 15000 }, async t => {
  const h = await setup(t, () => ({content: [{type: 'text', text: 'VERIFIED_FIXTURE_RESULT'}]}));
  const manager = new AgentManager(); let releaseGate, gateCalls = 0, gateCwd;
  const waitGate = new Promise(resolve => { releaseGate = resolve; });
  const fakePi = {...h.api, exec: async (command, args, options) => {
    if (command === 'sh') { gateCalls++; gateCwd = options.cwd; await waitGate; return {code: 0, killed: false, stdout: 'verified', stderr: ''}; }
    if (command === 'git') {
      if (args[0] === 'worktree' && args[1] === 'add') fs.mkdirSync(args[3], {recursive: true});
      if (args[0] === 'worktree' && args[1] === 'remove') fs.rmdirSync(args[3]);
      const stdout = args.includes('--is-inside-work-tree') ? 'true' : args.includes('--show-toplevel') ? h.scratch
        : args.includes('HEAD') ? 'fixture-base-sha' : args.includes('--show-current') ? 'main' : '';
      return {code: 0, killed: false, stdout, stderr: ''};
    }
    throw new Error(`Unexpected fixture command ${command}`);
  }};
  const host = createWorkflowHost({pi: fakePi, ctx: h.ctx(), manager, workflowId: 'wf-fixture'});
  try {
    const pending = host.spawnAgent({agentId: 'wf-agent-0', index: 0, prompt: 'Complete the fixture.',
      label: 'Gate fixture', agentType: 'general-purpose', isolation: 'worktree', gate: 'verify fixture'});
    await until(() => gateCalls === 1);
    const record = manager.listAgents()[0];
    assert.equal(record.status, 'running'); assert.equal(record.completedAt, undefined);
    assert.equal(gateCwd, record.worktree.path); assert(fs.existsSync(gateCwd));
    releaseGate(); const result = await pending;
    assert.equal(result.ok, true); assert.equal(result.gate.ok, true); assert.equal(gateCalls, 1);
    assert.equal(record.status, 'completed'); assert(!fs.existsSync(gateCwd));
  } finally { releaseGate(); await manager.dispose(); }
});

test('nested branches execute their own agent definition and tool restrictions', { timeout: 15000 }, async t => {
  const h = await setup(t, () => ({content: [{type: 'text', text: 'LOCAL_BRANCH_RESULT'}]}));
  fs.mkdirSync(path.join(h.scratch, '.pi/agents'), {recursive: true});
  fs.writeFileSync(path.join(h.scratch, '.pi/agents/recovery-fixture.md'),
    '---\nname: recovery-fixture\ndescription: Branch-local fixture\ntools: none\nextensions: false\nskills: false\npersist_session: false\noutput_transcript: false\n---\nLOCAL_BRANCH_POLICY_TOKEN\n');
  let options;
  const tools = createNestedSubagentTools({manager: {
    getRecord: id => id === 'parent' ? {rootSessionId: 'root-fixture'} : undefined,
    spawn: (_pi, _ctx, _type, _prompt, value) => { options = value; return 'nested-fixture'; },
    awaitStartup: async () => {},
  }, pi: h.api, parentAgentId: 'parent', depth: 1, maxSubagentDepth: 2, allowedSubagents: 'all', configCwd: h.scratch});
  await tools[0].execute('fixture', {prompt: 'Execute branch task.', description: 'Branch fixture', subagent_type: 'recovery-fixture'}, undefined, undefined, h.ctx());
  assert(options.agentConfig); assert.deepEqual(options.agentConfig.builtinToolNames, []);
  const result = await runner.runAgent(h.ctx(), 'recovery-fixture', 'Execute branch task.', {pi: h.api, agentConfig: options.agentConfig});
  try {
    assert.deepEqual(result.session.getActiveToolNames(), []);
    assert(JSON.stringify(h.calls[0]).includes('LOCAL_BRANCH_POLICY_TOKEN'));
    assert.equal(result.responseText, 'LOCAL_BRANCH_RESULT');
  } finally { await result.session.extensionRunner.emit({type: 'session_shutdown', reason: 'quit'}); result.session.dispose(); }
});

test('idle timeout recovery reaches the existing retry and returns a real chunked file result', { timeout: 15000 }, async t => {
  const h = await setup(t, (n, context, scratch) => {
    if (n === 1) return { content: [{ type: 'text', text: 'Preparing report.' }], error: 'Upstream idle timeout exceeded' };
    if (n === 2) { assert(hasRecovery(context)); return { content: [{ type: 'toolCall', id: 'write-part', name: 'write', arguments: { path: path.join(scratch, 'report.txt'), content: 'FIRST_CHUNK\n' } }] }; }
    if (n === 3) return { content: [{ type: 'toolCall', id: 'append-part', name: 'edit', arguments: { path: path.join(scratch, 'report.txt'), oldText: 'FIRST_CHUNK\n', newText: 'FIRST_CHUNK\nSECOND_CHUNK\n' } }] };
    return { content: [{ type: 'text', text: 'FINAL_REPORT_RESULT' }] };
  });
  const id = await h.spawn(), record = await h.settled(id);
  assert.equal(record.status, 'completed'); assert.equal(record.result, 'FINAL_REPORT_RESULT');
  assert.equal(fs.readFileSync(path.join(h.scratch, 'report.txt'), 'utf8'), 'FIRST_CHUNK\nSECOND_CHUNK\n');
  assert.match(text(h.notifications()[0].content), /<task_result>[\s\S]*FINAL_REPORT_RESULT/);
  assert(!text(h.notifications()[0].content).includes('<task_error>'));
});

test('persistent idle timeouts obey the retry budget and report error plus partial output', { timeout: 15000 }, async t => {
  const h = await setup(t, () => ({ content: [{ type: 'text', text: 'Preparing report.' }], error: 'Upstream idle timeout exceeded' }));
  const id = await h.spawn(), record = await h.settled(id);
  assert.equal(record.status, 'error'); assert.equal(h.calls.length, 3);
  assert.equal(h.calls[2].messages.filter(m => text(m.content).includes('The previous model response failed')).length, 1);
  const result = text(h.notifications()[0].content);
  assert.match(result, /<task_error>\nUpstream idle timeout exceeded\n<\/task_error>/);
  assert.match(result, /<partial_output>\nPreparing report.\n<\/partial_output>/);
  assert(!result.includes('<task_result>'));
  assert.equal(h.events.filter(e => e.kind === 'subagents:failed').length, 1);
});

test('concurrent children recover independently and all results reach the parent', { timeout: 15000 }, async t => {
  const attempts = new Map();
  const h = await setup(t, (_n, context) => {
    const marker = context.messages.map(m => text(m.content)).join('\n').match(/FIXTURE_[ABC]/)?.[0];
    assert(marker); const attempt = (attempts.get(marker) ?? 0) + 1; attempts.set(marker, attempt);
    if (attempt === 1) return { error: 'Upstream idle timeout exceeded' };
    assert(hasRecovery(context));
    return { content: [{ type: 'text', text: `RESULT_${marker}` }] };
  });
  const responses = await Promise.all(['A', 'B', 'C'].map(label => h.execute('Agent', {
    subagent_type: 'recovery-fixture', description: `Concurrent ${label}`, prompt: `Complete FIXTURE_${label}.`,
  })));
  await Promise.all(responses.map(response => h.settled(response.details.agentId)));
  const payload = h.notifications().map(m => text(m.content)).join('\n');
  for (const label of ['A', 'B', 'C']) { assert.match(payload, new RegExp(`RESULT_FIXTURE_${label}`)); assert.equal(attempts.get(`FIXTURE_${label}`), 2); }
  assert.equal(h.events.filter(e => e.kind === 'subagents:completed').length, 3);
  assert.equal(h.events.filter(e => e.kind === 'subagents:failed').length, 0);
});

test('disabled retries do not gain an implicit extra request', { timeout: 15000 }, async t => {
  const h = await setup(t, () => ({ error: 'Upstream idle timeout exceeded' }), { enabled: false });
  assert.equal((await h.settled(await h.spawn())).status, 'error'); assert.equal(h.calls.length, 1);
});

test('authentication errors keep their real reason without timeout recovery', { timeout: 15000 }, async t => {
  const h = await setup(t, () => ({ content: [{ type: 'text', text: 'Partial work' }], error: '401 Invalid API key' }));
  await h.settled(await h.spawn()); assert.equal(h.calls.length, 1); assert(!hasRecovery(h.calls[0]));
  assert.match(text(h.notifications()[0].content), /<task_error>\n401 Invalid API key/);
});

test('other transient provider errors use normal retries without output-strategy steering', { timeout: 15000 }, async t => {
  const h = await setup(t, n => n === 1 ? { error: '503 Service unavailable' } : { content: [{ type: 'text', text: 'RECOVERED_NORMAL_RETRY' }] });
  assert.equal((await h.settled(await h.spawn())).status, 'completed'); assert.equal(h.calls.length, 2);
  assert(!hasRecovery(h.calls[1]));
});

test('resuming a failed child gets recovery guidance and returns only the new result', { timeout: 15000 }, async t => {
  const h = await setup(t, n => n === 1 ? { error: '401 Invalid API key' } : n === 2 ? { error: 'Upstream idle timeout exceeded' } : { content: [{ type: 'text', text: 'RESUME_RESULT' }] });
  const id = await h.spawn(); assert.equal((await h.settled(id)).status, 'error');
  await h.execute('Agent', { subagent_type: 'recovery-fixture', resume: id, description: 'Resume fixture', prompt: 'Continue the fixture.' });
  await until(() => h.manager().getRecord(id)?.status === 'completed');
  await until(() => h.notifications().length === 2);
  assert(hasRecovery(h.calls[2])); assert.equal(h.manager().getRecord(id).result, 'RESUME_RESULT');
  assert.match(text(h.notifications()[1].content), /<task_result>[\s\S]*RESUME_RESULT/);
});

test('stopping during retry backoff cancels recovery without another model call', { timeout: 15000 }, async t => {
  const h = await setup(t, () => ({ error: 'Upstream idle timeout exceeded' }), { enabled: true, maxRetries: 2, baseDelayMs: 5000 });
  const id = await h.spawn(); await until(() => h.manager().getRecord(id)?.session?.isRetrying);
  const requestId = 'stop-fixture';
  const stopped = new Promise(resolve => { const off = h.api.events.on(`subagents:rpc:stop:reply:${requestId}`, reply => { off(); resolve(reply); }); });
  h.api.events.emit('subagents:rpc:stop', { requestId, agentId: id }); assert.deepEqual(await stopped, { success: true });
  assert.equal((await h.settled(id)).status, 'stopped'); assert.equal(h.calls.length, 1);
});

test('structured-output provider failures do not trigger an unrelated schema retry', { timeout: 15000 }, async t => {
  const h = await setup(t, () => ({ error: '401 Invalid API key' }), { enabled: false });
  const schema = compileJsonSchema({ type: 'object', properties: { result: { type: 'string' } }, required: ['result'] }); assert(schema.ok);
  const result = await runner.runAgent(h.ctx(), 'recovery-fixture', 'Return the fixture.', { pi: h.api, structuredOutput: schema.compiled });
  assert.equal(result.failure, '401 Invalid API key'); assert(!result.structuredRetried); assert.equal(h.calls.length, 1);
  await result.session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); result.session.dispose();
});

test('structured-output shape errors still receive the intended single retry', { timeout: 15000 }, async t => {
  const h = await setup(t, n => n === 1 ? { content: [{ type: 'text', text: 'prose instead of schema' }] }
    : n === 2 ? { content: [{ type: 'toolCall', id: 'structured-result', name: 'StructuredOutput', arguments: { result: 'SCHEMA_RESULT' } }] }
    : { content: [{ type: 'text', text: 'structured result submitted' }] }, { enabled: false });
  const schema = compileJsonSchema({ type: 'object', properties: { result: { type: 'string' } }, required: ['result'] }); assert(schema.ok);
  const result = await runner.runAgent(h.ctx(), 'recovery-fixture', 'Return the fixture.', { pi: h.api, structuredOutput: schema.compiled });
  assert.equal(result.failure, undefined); assert.equal(result.structuredRetried, true);
  assert.deepEqual(JSON.parse(result.structuredJson), { result: 'SCHEMA_RESULT' });
  await result.session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); result.session.dispose();
});
