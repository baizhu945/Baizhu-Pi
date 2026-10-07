// Deterministic filesystem, cancellation and linked-widget regressions; no model calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {test} from 'node:test';

const [sdkRoot, subagentsRoot, tasksRoot] = process.argv.slice(2);
assert(sdkRoot && subagentsRoot && tasksRoot, 'Pass Pi SDK, subagents and tasks roots');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-plugin-integrity-'));
process.env.PI_CODING_AGENT_DIR = path.join(scratch, 'agent');
process.env.PI_OFFLINE = '1';
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, {recursive: true});
const require = createRequire(path.join(sdkRoot, 'package.json'));
const dependencies = createRequire(path.join(process.env.PI_SUBAGENTS_TEST_DEPS ?? subagentsRoot, 'index.ts'));
const {createJiti} = require('jiti');
const jiti = createJiti(import.meta.url, {fsCache: false, alias: {
  '@earendil-works/pi-coding-agent': path.join(sdkRoot, 'dist/index.js'),
  '@earendil-works/pi-tui': require.resolve('@earendil-works/pi-tui'),
  '@earendil-works/pi-ai': path.join(sdkRoot, 'node_modules/@earendil-works/pi-ai/dist/compat.js'),
  '@earendil-works/pi-agent-core': path.join(sdkRoot, 'node_modules/@earendil-works/pi-agent-core/dist/index.js'),
  '@sinclair/typebox': dependencies.resolve('@sinclair/typebox'),
  croner: dependencies.resolve('croner'), nanoid: dependencies.resolve('nanoid'),
  typebox: require.resolve('typebox'), 'typebox/value': require.resolve('typebox/value'),
}});
const {TaskStore} = await jiti.import(path.join(tasksRoot, 'src/task-store.ts'));
const {TaskWidget} = await jiti.import(path.join(tasksRoot, 'src/ui/task-widget.ts'));
const {AgentWidget} = await jiti.import(path.join(subagentsRoot, 'src/ui/agent-widget.ts'));
const {FleetList} = await jiti.import(path.join(subagentsRoot, 'src/ui/fleet-list.ts'));
const {AgentManager} = await jiti.import(path.join(subagentsRoot, 'src/agent-manager.ts'));
const {cleanupWorktree} = await jiti.import(path.join(subagentsRoot, 'src/worktree.ts'));
const runner = await jiti.import(path.join(subagentsRoot, 'src/agent-runner.ts'));
const tasksCollapse = await jiti.import(path.join(tasksRoot, 'src/ui/widget-collapse.ts'));
const agentsCollapse = await jiti.import(path.join(subagentsRoot, 'src/ui/widget-collapse.ts'));
const {ScheduleStore, resolveStorePath} = await jiti.import(path.join(subagentsRoot, 'src/schedule-store.ts'));
const {SubagentScheduler} = await jiti.import(path.join(subagentsRoot, 'src/schedule.ts'));
const {runWorkflow} = await jiti.import(path.join(subagentsRoot, 'src/workflow/runtime.ts'));
const {createOutputFilePath, sessionTaskDir} = await jiti.import(path.join(subagentsRoot, 'src/output-file.ts'));
const files = await jiti.import(path.join(subagentsRoot, 'src/agent-file-toggle.ts'));
const {parseAgentFrontmatter} = await jiti.import(path.join(subagentsRoot, 'src/custom-agents.ts'));
const {registerRpcHandlers} = await jiti.import(path.join(subagentsRoot, 'src/cross-extension-rpc.ts'));
const {createEventBus} = await import(pathToFileURL(path.join(sdkRoot, 'dist/core/event-bus.js')));
const theme = {fg: (_color, text) => text, bg: (_color, text) => text,
  bold: text => text, strikethrough: text => text};
function widgetUI() {
  const widgets = new Map();
  const tui = {terminal: {columns: 240}, requestRender() {}};
  return {widgets, setStatus() {},
    setWidget(key, factory) {
      if (factory === undefined) widgets.delete(key);
      else widgets.set(key, factory(tui, theme));
    },
    lines(key) { return widgets.get(key)?.render() ?? []; },
  };
}
const record = (id, fields = {}) => ({id, type: 'general-purpose', description: `Agent ${id}`,
  status: 'running', isBackground: true, startedAt: Date.now(), toolUses: 0,
  lifetimeUsage: {input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0}, ...fields});

await test('fork snapshots and seeded stores own their nested data', () => {
  const parent = new TaskStore(); parent.create('Parent', 'requirements', undefined, {nested: {value: 1}});
  const snapshot = parent.snapshot(), child = new TaskStore(); child.seed(snapshot);
  child.update('1', {subject: 'Child'}); child.get('1').metadata.nested.value = 2;
  assert.equal(parent.get('1').subject, 'Parent'); assert.equal(parent.get('1').metadata.nested.value, 1);
  assert.equal(snapshot.tasks[0].subject, 'Parent'); assert.equal(snapshot.tasks[0].metadata.nested.value, 1);
});
await test('seed checks the latest shared store while holding the lock', () => {
  const file = path.join(scratch, 'seed.json'), stale = new TaskStore(file);
  new TaskStore(file).create('Concurrent', 'requirements');
  const source = new TaskStore(); source.create('Seed', 'requirements'); stale.seed(source.snapshot());
  assert.equal(new TaskStore(file).get('1').subject, 'Concurrent');
});
await test('empty cleanup rechecks the persisted state under the lock', () => {
  const file = path.join(scratch, 'empty.json'), stale = new TaskStore(file);
  new TaskStore(file).create('Concurrent', 'requirements');
  assert.equal(stale.deleteFileIfEmpty(), false); assert(fs.existsSync(file));
  assert.equal(new TaskStore(file).get('1').subject, 'Concurrent');
});
await test('malformed task files are never overwritten by a mutation', () => {
  for (const [i, damaged] of ['{ interrupted write', '{"tasks":null}', '{"tasks":[{"id":"1","subject":42}]}'].entries()) {
    const file = path.join(scratch, `corrupt-${i}.json`), store = new TaskStore(file);
    store.create('Keep', 'requirements'); fs.writeFileSync(file, damaged);
    assert.throws(() => store.create('New', 'requirements'), /Refusing to overwrite/);
    assert.equal(fs.readFileSync(file, 'utf8'), damaged);
  }
});
await test('metadata keys remain data without altering prototypes', () => {
  const store = new TaskStore(); store.create('Task', 'requirements');
  store.update('1', {metadata: JSON.parse('{"__proto__":{"injected":true}}')});
  const metadata = store.get('1').metadata;
  assert.equal(Object.getPrototypeOf(metadata), Object.prototype); assert(Object.hasOwn(metadata, '__proto__'));
});
await test('a backing file removed by another store cannot resurrect stale tasks', () => {
  const file = path.join(scratch, 'removed.json'), first = new TaskStore(file);
  first.create('Old', 'requirements');
  const second = new TaskStore(file); second.clearAll(); assert(second.deleteFileIfEmpty());
  first.create('New', 'requirements');
  assert.deepEqual(new TaskStore(file).list().map(task => task.subject), ['New']);
});
await test('failed git cleanup operations preserve the original worktree', async () => {
  for (const failedCommand of ['status', 'commit', 'branch']) {
    const directory = path.join(scratch, `worktree-${failedCommand}`); fs.mkdirSync(directory);
    const artifact = path.join(directory, 'report.txt'); fs.writeFileSync(artifact, 'uncommitted result');
    const calls = [];
    const pi = {exec: async (_command, args) => {
      calls.push(args.join(' '));
      if (args[0] === failedCommand) return {code: 1, killed: false, stdout: '', stderr: `${failedCommand} failed`};
      return {code: 0, killed: false, stdout: args[0] === 'status' ? '?? report.txt\n' : '', stderr: ''};
    }};
    const result = await cleanupWorktree(pi, scratch, {path: directory, branch: 'pi-agent-test', baseSha: 'base', workPath: directory}, 'test');
    assert(fs.existsSync(artifact)); assert.equal(result.hasChanges, true); assert.equal(result.path, directory);
    assert.match(result.error, /failed/); assert(!calls.some(command => command.startsWith('worktree remove')));
  }
});
await test('already cancelled starts and resumes execute no work', async () => {
  const signal = AbortSignal.abort(new DOMException('Fixture cancelled', 'AbortError'));
  let calls = 0;
  await assert.rejects(runner.runAgent({cwd: scratch}, 'general-purpose', 'cancelled', {
    signal, pi: {exec: async () => { calls++; throw new Error('Unexpected environment command'); }},
  }), {name: 'AbortError'});
  await assert.rejects(runner.resumeAgent({prompt: async () => { calls++; }}, 'cancelled', {signal}), {name: 'AbortError'});
  assert.equal(calls, 0);
});
await test('a parent interrupt releases a queued background resume', async () => {
  const manager = new AgentManager(undefined, 1), controller = new AbortController();
  const item = record('queued-resume', {status: 'completed', session: {dispose() {}}});
  manager.agents.set(item.id, item); manager.runningBackground = 1;
  try {
    await manager.resume(item.id, 'resume', controller.signal, {isBackground: true});
    assert.equal(item.status, 'queued'); controller.abort();
    assert.equal(item.status, 'stopped'); assert.equal(manager.hasRunning(), false);
    assert.equal(manager.queue.length, 0);
  } finally { await manager.dispose(); }
});
await test('workflow-owned and nested agents cannot be addressed by parent mentions', async () => {
  const manager = new AgentManager();
  try {
    manager.agents.set('workflow-child', record('workflow-child', {workflowId: 'wf_private'}));
    manager.agents.set('nested-child', record('nested-child', {parentAgentId: 'parent'}));
    manager.agents.set('public', record('public'));
    assert.equal(manager.resolveMention('workflow-child'), undefined);
    assert.equal(manager.resolveMention('nested-child'), undefined);
    assert.equal(manager.resolveMention('public').record.id, 'public');
  } finally { await manager.dispose(); }
});

for (const order of ['tasks-first', 'agents-first']) {
  await test(`one Alt+W toggles every task and agent row (${order})`, () => {
    const store = new TaskStore(); store.create('First', 'requirements'); store.create('Second', 'requirements');
    const tasks = new TaskWidget(store), agents = new AgentWidget({listAgents: () => [record('a'), record('b')]}, new Map());
    const ui = widgetUI(); tasks.setUICtx(ui); agents.setUICtx(ui); tasks.update(); agents.update();
    const shortcuts = [], events = createEventBus();
    const pi = {events, registerShortcut: (key, definition) => shortcuts.push({key, ...definition})};
    const off = [];
    try {
      const taskWire = () => tasksCollapse.wireWidgetCollapse(pi, value => tasks.setCollapsed(value));
      const agentWire = () => agentsCollapse.wireWidgetCollapse(pi, value => agents.setCollapsed(value));
      off.push(...(order === 'tasks-first' ? [taskWire(), agentWire()] : [agentWire(), taskWire()]));
      assert.equal(shortcuts.length, 1); assert.equal(shortcuts[0].key, 'alt+w');
      assert(ui.lines('tasks').length > 1); assert(ui.lines('agents').length > 1);
      shortcuts[0].handler();
      assert.equal(ui.lines('tasks').length, 1); assert.equal(ui.lines('agents').length, 1);
      assert.match(ui.lines('tasks')[0], /2 tasks.*alt\+w/); assert.match(ui.lines('agents')[0], /2 running.*alt\+w/);
      assert.equal(store.list().length, 2);
      shortcuts[0].handler(); assert(ui.lines('tasks').length > 1); assert(ui.lines('agents').length > 1);
      for (const data of [null, 7, {}, {collapsed: 'yes'}]) events.emit('ui:widget-collapse:changed', data);
      assert(ui.lines('tasks').length > 1); assert(ui.lines('agents').length > 1);
    } finally { for (const dispose of off) dispose(); tasks.dispose(); agents.dispose(); }
  });
}
await test('late widget loading inherits the current collapse state and does not claim another shortcut', () => {
  const events = createEventBus(), shortcuts = [], states = [false, false];
  const pi = {events, registerShortcut: (_key, definition) => shortcuts.push(definition)};
  const first = tasksCollapse.wireWidgetCollapse(pi, value => { states[0] = value; });
  shortcuts[0].handler(); const second = agentsCollapse.wireWidgetCollapse(pi, value => { states[1] = value; });
  assert.deepEqual(states, [true, true]); assert.equal(shortcuts.length, 1);
  second(); first(); events.emit('ui:widget-collapse:changed', {collapsed: false});
  assert.deepEqual(states, [true, true]);
});
await test('switching a task store resets spinners and metrics even when task IDs repeat', () => {
  const first = new TaskStore(); first.create('Old', 'requirements'); first.update('1', {status: 'in_progress'});
  const widget = new TaskWidget(first), ui = widgetUI(); widget.setUICtx(ui); widget.setActiveTask('1'); widget.addTokenUsage(123, 456);
  const next = new TaskStore(); next.create('New', 'requirements'); next.update('1', {status: 'in_progress'});
  try {
    widget.setStore(next); widget.update();
    assert.equal(widget.activeTaskIds.size, 0); assert.equal(widget.metrics.size, 0);
    assert.equal(widget.widgetInterval, undefined); assert(!ui.lines('tasks').join('\n').includes('456'));
  } finally { widget.dispose(); }
});
await test('zero visible rows at the top cannot expand the entire task list', () => {
  const store = new TaskStore(); store.create('Hidden first', 'requirements'); store.create('Hidden second', 'requirements');
  const widget = new TaskWidget(store, {hiddenAt: 'top', maxVisible: 0}), ui = widgetUI(); widget.setUICtx(ui);
  try { widget.update(); const text = ui.lines('tasks').join('\n'); assert(!text.includes('Hidden')); assert.match(text, /2 more/); }
  finally { widget.dispose(); }
});
await test('task and agent text cannot inject terminal controls or extra widget rows', () => {
  const payload = 'First\n\u001b]0;Injected title\u0007Second\u202e';
  const store = new TaskStore(); store.create(payload, 'requirements');
  const tasks = new TaskWidget(store), agents = new AgentWidget({listAgents: () => [record('a', {description: payload})]}, new Map());
  const ui = widgetUI(); tasks.setUICtx(ui); agents.setUICtx(ui);
  try {
    tasks.update(); agents.update();
    for (const line of [...ui.lines('tasks'), ...ui.lines('agents')]) assert(!/[\n\r\u001b\u0007\u202e]/.test(line), JSON.stringify(line));
  } finally { tasks.dispose(); agents.dispose(); }
});
await test('disposed agent widgets ignore late lifecycle and timer callbacks', () => {
  const widget = new AgentWidget({listAgents: () => [record('a')]}, new Map()), ui = widgetUI(); widget.setUICtx(ui);
  widget.ensureTimer(); widget.update(); widget.dispose(); widget.ensureTimer(); widget.update();
  assert.equal(widget.widgetInterval, undefined); assert.equal(ui.widgets.has('agents'), false);
});

const job = (id, extra = {}) => ({id, name: `Job ${id}`, description: 'Scheduled fixture',
  prompt: 'Fixture', subagent_type: 'general-purpose', schedule: '1h', scheduleType: 'interval',
  intervalMs: 3600000, enabled: true, createdAt: new Date().toISOString(), runCount: 0, ...extra});
await test('schedule readers and mutations observe other writers without lost jobs', () => {
  const file = path.join(scratch, 'schedule-shared.json'), stale = new ScheduleStore(file), writer = new ScheduleStore(file);
  writer.add(job('a')); assert.equal(stale.list().length, 1);
  assert(stale.update('a', {description: 'updated'})); assert.equal(writer.get('a').description, 'updated');
  const copy = writer.get('a'); copy.name = 'mutated snapshot'; assert.equal(writer.get('a').name, 'Job a');
  stale.deleteFileIfEmpty(); assert(fs.existsSync(file));
  assert.throws(() => writer.add(job('b', {name: 'Job a'})), /already exists/);
  assert.equal(new ScheduleStore(file).list().length, 1);
});
await test('schedule mutations preserve malformed persisted data', () => {
  const file = path.join(scratch, 'schedule-corrupt.json'), store = new ScheduleStore(file);
  store.add(job('a')); const raw = '{"jobs":[null]}'; fs.writeFileSync(file, raw);
  assert.throws(() => store.add(job('b')), /Refusing to overwrite/);
  assert.equal(fs.readFileSync(file, 'utf8'), raw);
});
await test('filesystem identifiers cannot escape transcript or schedule roots', () => {
  for (const id of ['..', '../../outside', '/absolute', 'x\\y', 'a'.repeat(1000)]) {
    const schedule = resolveStorePath(scratch, id);
    assert.equal(path.dirname(schedule), path.join(scratch, '.pi/subagent-schedules'));
    const directory = sessionTaskDir(scratch, id), output = createOutputFilePath(scratch, id, id);
    assert.equal(path.dirname(output), directory);
    assert(!path.relative(path.join(os.tmpdir(), `pi-subagents-${process.getuid?.() ?? 0}`), directory).startsWith('..'));
  }
});
await test('far-future schedules wait in bounded timer chunks and fire once at the deadline', async () => {
  const realTimeout = globalThis.setTimeout, realNow = Date.now;
  let now = realNow(), fired = 0;
  const timers = [], events = createEventBus(), store = new ScheduleStore(path.join(scratch, 'far-future.json'));
  const scheduler = new SubagentScheduler();
  try {
    globalThis.setTimeout = (callback, delay) => { const handle = {callback, delay}; timers.push(handle); return handle; };
    Date.now = () => now;
    scheduler.start({events}, {}, {spawn: () => { fired++; return 'fixture'; },
      awaitStartup: async () => {}, getRecord: () => ({status: 'completed', promise: Promise.resolve('')})}, store);
    const cap = 2147483647;
    const scheduled = scheduler.addJob({name: 'far', description: 'far', prompt: 'fixture', subagent_type: 'general-purpose',
      schedule: new Date(now + cap + 10000).toISOString()});
    assert.equal(timers[0].delay, cap); assert.equal(fired, 0);
    now += cap; timers[0].callback(); assert.equal(fired, 0); assert.equal(timers[1].delay, 10000);
    now += 10000; timers[1].callback(); assert.equal(fired, 1); assert.equal(store.get(scheduled.id).enabled, false);
  } finally { scheduler.stop(); globalThis.setTimeout = realTimeout; Date.now = realNow; }
  await new Promise(resolve => setImmediate(resolve));
});
await test('cron validation stops its temporary timer', () => {
  const {Cron} = dependencies('croner');
  const original = Cron.prototype.stop; let stopped = 0;
  Cron.prototype.stop = function (...args) { stopped++; return original.apply(this, args); };
  try { assert.equal(SubagentScheduler.validateCronExpression('0 0 9 * * 1').valid, true); assert.equal(stopped, 1); }
  finally { Cron.prototype.stop = original; }
});
await test('agent file toggles preserve YAML semantics and do not create duplicate enabled keys', () => {
  const enabled = '---\nenabled: true # original flag\ndescription: Fixture\n---\nBody\n';
  const disabled = files.disableInContent(enabled).content;
  assert.equal(parseAgentFrontmatter(disabled).frontmatter.enabled, false);
  assert.equal((disabled.match(/^enabled:/gm) ?? []).length, 1);
  for (const field of ['enabled: FALSE # comment', '"enabled": False', "'enabled': false"]) {
    const source = `---\n${field}\ndescription: Fixture\n---\nBody\n`;
    const result = files.enableInContent(source); assert(result.changed);
    assert.equal(parseAgentFrontmatter(result.content).frontmatter.enabled, undefined);
    assert.match(result.content, /Body/);
  }
});
await test('agent serialization preserves free-text YAML scalars and filenames stay inside the selected directory', () => {
  const built = files.buildNewAgentFile({description: 'A: # label', tools: '*', systemPrompt: 'Body'});
  assert.equal(parseAgentFrontmatter(built).frontmatter.tools, '*');
  const serialized = files.serializeAgentFile({description: 'Fixture', displayName: 'Name: # label', model: 'provider/model # custom',
    promptMode: 'replace', extensions: false, skills: false, systemPrompt: 'Body'});
  const parsed = parseAgentFrontmatter(serialized).frontmatter;
  assert.equal(parsed.display_name, 'Name: # label'); assert.equal(parsed.model, 'provider/model # custom');
  for (const name of ['../escape', '/absolute', 'x\\y', 'x\nnew']) assert.throws(() => files.agentFilePath(scratch, name));
  assert.equal(path.dirname(files.agentFilePath(scratch, 'Code Reviewer')), scratch);
});
await test('RPC model objects resolve through the trusted registry without payload routing overrides', async () => {
  const trusted = {provider: 'fixture', id: 'model', name: 'Fixture', api: 'openai-responses', baseUrl: 'https://trusted.invalid'};
  let received;
  const events = createEventBus();
  const handle = registerRpcHandlers({events, pi: {}, getCtx: () => ({cwd: scratch,
    modelRegistry: {find: (provider, id) => provider === trusted.provider && id === trusted.id ? trusted : undefined,
      getAvailable: () => [trusted]}}), manager: {spawn: (_pi, _ctx, _type, _prompt, options) => { received = options; return 'fixture'; },
    awaitStartup: async () => {}, getRecord: () => undefined, abort: () => false, consumeResult: () => false}});
  try {
    const response = new Promise(resolve => events.on('subagents:rpc:spawn:reply:model-object', resolve));
    events.emit('subagents:rpc:spawn', {requestId: 'model-object', type: 'general-purpose', prompt: 'Fixture',
      options: {model: {provider: 'fixture', id: 'model', baseUrl: 'https://untrusted.invalid', headers: {Authorization: 'bad'}}}});
    assert.equal((await response).success, true); assert.equal(received.model, trusted);
  } finally { handle.unsubPing(); handle.unsubSpawn(); handle.unsubStop(); handle.unsubConsume(); }
});
await test('collapsed fleet rows do not consume hidden-list navigation and restore on expansion', () => {
  const fleet = new FleetList({listAgents: () => [record('a', {session: {}}), record('b', {session: {}})]}, new Map());
  const ui = widgetUI(); ui.onTerminalInput = () => () => {}; ui.getEditorText = () => '';
  try {
    fleet.setUICtx(ui); fleet.update(); assert(ui.lines('fleet').length > 1);
    fleet.setCollapsed(true); assert.equal(ui.lines('fleet').length, 1); assert.equal(fleet.handleKey('\u001b[B'), undefined);
    fleet.setCollapsed(false); assert(ui.lines('fleet').length > 1);
    fleet.dispose(); fleet.ensureTimer(); assert.equal(fleet.timer, undefined);
  } finally { fleet.dispose(); }
});
const workflowHost = {spawnAgent: async request => ({ok: true, text: request.schema ? '{"answer":"ok"}' : 'ok'}), abortAgent() {},
  loadWorkflow: () => ({ok: true, script: 'export const meta={name:"child",description:"child"}; return await agent("child");'})};
const workflowScript = body => 'export const meta={name:"fixture",description:"fixture"};\n' + body;
await test('workflow helpers, promises and errors cannot compile code outside the VM', async () => {
  for (const body of [
    'return agent.constructor("return typeof process")();',
    'return globalThis.constructor.constructor("return typeof process")();',
    'return agent("fixture").constructor.constructor("return typeof process")();',
    'try { await agent(""); } catch(error) { return error.constructor.constructor("return typeof process")(); }',
  ]) {
    const result = await runWorkflow({script: workflowScript(body), host: workflowHost});
    assert.equal(result.status, 'failed'); assert.match(result.error, /Code generation/);
  }
});
await test('workflow parallel/pipeline/nesting and schema output still use realm-native values', async () => {
  const result = await runWorkflow({host: workflowHost, script: workflowScript(
    'const a=await parallel([()=>agent("a"),()=>agent("b")]); const b=await pipeline([1,2],x=>x+1,x=>x*2); '
    + 'const child=await workflow("child"); const structured=await agent("s",{schema:{type:"object"}}); '
    + 'return {a,b,child,structured,date:new Date(0).toISOString()};')});
  assert.equal(result.status, 'completed', result.error);
  assert.deepEqual(result.value, {a: ['ok','ok'], b: [4,6], child: 'ok', structured: {answer: 'ok'}, date: '1970-01-01T00:00:00.000Z'});
});
await test('global Date aliases cannot bypass workflow replay determinism', async () => {
  for (const body of ['return new globalThis.Date().getTime();', 'return new (Object.getPrototypeOf(Date))().getTime();']) {
    assert.equal((await runWorkflow({script: workflowScript(body), host: workflowHost})).status, 'failed');
  }
});

await test('actual Pi loads exactly one Alt+W shortcut and reloading does not stack registrations', async () => {
  const sdk = await import(pathToFileURL(path.join(sdkRoot, 'dist/index.js')));
  const taskPlugin = (await jiti.import(path.join(tasksRoot, 'index.ts'))).default;
  const subagentPlugin = (await jiti.import(path.join(subagentsRoot, 'index.ts'))).default;
  const errors = [], settingsManager = sdk.SettingsManager.inMemory({packages: []});
  const loader = new sdk.DefaultResourceLoader({cwd: scratch, agentDir: process.env.PI_CODING_AGENT_DIR,
    settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    noContextFiles: true, extensionFactories: [taskPlugin, subagentPlugin]});
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  const model = {provider: 'openai', id: 'fixture', name: 'Fixture', api: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1', input: ['text'], reasoning: false, contextWindow: 10000, maxTokens: 1024,
    cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}};
  const {session} = await sdk.createAgentSession({cwd: scratch, agentDir: process.env.PI_CODING_AGENT_DIR,
    resourceLoader: loader, settingsManager, sessionManager: sdk.SessionManager.inMemory(scratch), model, thinkingLevel: 'off'});
  const assertOne = () => {
    assert.equal(loader.getExtensions().extensions.filter(extension => extension.shortcuts.has('alt+w')).length, 1);
    assert.deepEqual(errors, []);
  };
  try {
    await session.bindExtensions({mode: 'sdk', onError: error => errors.push(error)}); assertOne();
    await session.reload(); assertOne();
  } finally { await session.extensionRunner.emit({type: 'session_shutdown', reason: 'quit'}); session.dispose(); }
});
