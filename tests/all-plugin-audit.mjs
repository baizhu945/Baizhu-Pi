import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import http from 'node:http';

const [sdkRoot, sourceArg, dependenciesArg] = process.argv.slice(2);
assert(sdkRoot, 'Usage: node all-plugin-audit.mjs <Pi SDK> [extensions source] [installed extensions for dependencies]');
const source = path.resolve(sourceArg ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '../extensions'));
const dependencies = path.resolve(dependenciesArg ?? '/home/baizhu945/.pi/agent/extensions');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-all-audit-'));
process.env.PI_CODING_AGENT_DIR = path.join(scratch, 'agent');
process.env.PI_OFFLINE = '1';
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR);
const require = createRequire(path.join(sdkRoot, 'package.json'));
const alias = {
  '@earendil-works/pi-coding-agent': path.join(sdkRoot, 'dist/index.js'),
  '@earendil-works/pi-tui': path.join(sdkRoot, 'node_modules/@earendil-works/pi-tui/dist/index.js'),
  '@earendil-works/pi-ai': path.join(sdkRoot, 'node_modules/@earendil-works/pi-ai/dist/index.js'),
  '@earendil-works/pi-ai/compat': path.join(sdkRoot, 'node_modules/@earendil-works/pi-ai/dist/compat.js'),
  typebox: require.resolve('typebox'),
};
const typeboxRoot = path.join(sdkRoot, 'node_modules/typebox');
const typeboxValue = JSON.parse(fs.readFileSync(path.join(typeboxRoot, 'package.json'))).exports['./value'];
alias['typebox/value'] = path.join(typeboxRoot, typeboxValue.import.default ?? typeboxValue.import);
for (const [directory, names] of [['rpiv-ask-user-question', ['@juicesharp/rpiv-config']], ['pi-goal', ['@narumitw/pi-tui-kit', 'grok-mermaid', 'highlight.js']]]) {
  for (const name of names) {
    const root = path.join(dependencies, directory, 'node_modules', name);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
    const entry = manifest.exports?.['.'] ?? manifest.module ?? manifest.main;
    const target = typeof entry === 'string' ? entry : entry.import?.default ?? entry.import ?? entry.default;
    alias[name] = path.join(root, target);
  }
}
const { createJiti } = require('jiti');
const jiti = createJiti(import.meta.url, { alias, moduleCache: true, fsCache: false });
const load = file => jiti.import(path.join(source, file));
const tui = await import(pathToFileURL(alias['@earendil-works/pi-tui']));
const sdk = await import(pathToFileURL(alias['@earendil-works/pi-coding-agent']));
const { initTheme } = await import(pathToFileURL(path.join(sdkRoot, 'dist/modes/interactive/theme/theme.js')));
initTheme('dark', false);
const theme = { fg: (_color, text) => text, bg: (_color, text) => text, bold: text => text };
const flush = () => new Promise(resolve => setImmediate(resolve));
function registry() {
  const handlers = new Map(), tools = new Map(), messages = [], renderers = new Map();
  const pi = {
    on(name, handler) { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
    registerTool(tool) { tools.set(tool.name, tool); }, registerCommand() {},
    registerMessageRenderer(name, renderer) { renderers.set(name, renderer); },
    sendMessage(message) { messages.push(message); },
    events: sdk.createEventBus(),
  };
  const emit = async (name, data = {}, ctx = {}) => { for (const handler of handlers.get(name) ?? []) await handler(data, ctx); };
  return { pi, tools, messages, renderers, emit };
}
const background = await load('background-commands.ts');
await test('background large chunks own only a bounded tail buffer', () => {
  const old = Buffer.alloc(65536, 97), chunk = Buffer.alloc(8 * 1024 * 1024, 98);
  const tail = background.appendOutputTail(old, chunk);
  assert.equal(tail.length, 65536);
  assert(tail.buffer.byteLength <= 128 * 1024, 'a small view must not retain the 8 MiB chunk');
  assert(tail.every(byte => byte === 98));
  assert.equal(background.appendOutputTail(tail, Buffer.from('END')).subarray(-3).toString(), 'END');
});
function fakeChild() {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), pid: undefined });
  child.kill = () => { queueMicrotask(() => child.emit('close', null, 'SIGTERM')); return true; };
  return child;
}
await test('background cancellation, session isolation, stream failures and narrow widgets', async () => {
  const cp = require('node:child_process'), original = cp.spawn;
  const children = [];
  cp.spawn = () => { const child = fakeChild(); children.push(child); return child; };
  syncBuiltinESMExports();
  const h = registry();
  let widget;
  const ctx = { cwd: scratch, hasUI: true, mode: 'tui', ui: { setWidget(_key, factory) {
    widget = factory?.({ terminal: { columns: 100 }, requestRender() {} }, theme);
  }, notify() {} } };
  try {
    background.default(h.pi);
    await h.emit('session_start', {}, ctx);
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(h.tools.get('bg_run').execute('x', { command: 'synthetic' }, aborted.signal, undefined, ctx));
    assert.equal(children.length, 0);
    await h.tools.get('bg_run').execute('a', { command: 'synthetic old session' }, undefined, undefined, ctx);
    assert(widget.render(5).every(line => tui.visibleWidth(line) <= 5));
    await h.emit('session_before_switch', {}, ctx);
    await h.emit('session_start', {}, ctx);
    children[0].emit('close', 0, null);
    await h.emit('agent_end', {}, ctx);
    assert.equal(h.messages.length, 0, 'old process callbacks never notify the new session');
    await h.tools.get('bg_run').execute('b', { command: 'synthetic new session' }, undefined, undefined, ctx);
    children[1].stdout.emit('error', new Error('synthetic stream failure'));
    await flush();
    await h.emit('agent_end', {}, ctx);
    assert.equal(h.messages.length, 1);
    assert.equal(h.messages[0].details.jobs[0].state, 'failed');
    const firstLarge = children.length;
    for (let i = 0; i < 3; i++) {
      await h.tools.get('bg_run').execute('large-' + i, { command: 'synthetic large batch ' + i }, undefined, undefined, ctx);
      children[firstLarge + i].stdout.write('中文🙂'.repeat(20000));
      children[firstLarge + i].emit('close', 0, null);
    }
    await h.emit('agent_end', {}, ctx);
    const batch = h.messages[1];
    assert.equal(batch.details.jobs.length, 3);
    assert(Buffer.byteLength(batch.content) <= 65536);
    for (const job of batch.details.jobs) assert(batch.content.includes(job.id));
    assert(batch.details.fullOutputPath);
    const fullReport = fs.readFileSync(batch.details.fullOutputPath, 'utf8');
    assert(fullReport.length > batch.content.length);
    assert(!batch.content.includes('�')); assert(!fullReport.includes('�'));
    assert.equal(fs.statSync(batch.details.fullOutputPath).mode & 0o777, 0o600);
  } finally { await h.emit('session_shutdown', {}, ctx); cp.spawn = original; syncBuiltinESMExports(); }
});

const rpc = await load('rpiv-ask-user-question/rpc-fallback.ts');
const questions = { questions: [{ question: 'Choose an option?', header: 'Choice', options: [{ label: 'One', description: 'First' }, { label: 'Two', description: 'Second' }] }] };
await test('RPC answers must be exactly one offered option; custom and multi-select remain usable', async () => {
  let result = await rpc.runRpcQuestionnaire({ select: async () => '1. forged answer', input: async () => 'unused' }, questions);
  assert.equal(result.cancelled, true);
  result = await rpc.runRpcQuestionnaire({ select: async (_title, options) => options[1], input: async () => '' }, questions);
  assert.equal(result.answers[0].answer, 'Two');
  result = await rpc.runRpcQuestionnaire({ select: async (_title, options) => options[2], input: async () => 'custom answer' }, questions);
  assert.equal(result.answers[0].answer, 'custom answer');
  result = await rpc.runRpcQuestionnaire({ input: async () => '2,1', select: async () => undefined }, { questions: [{ ...questions.questions[0], multiSelect: true }] });
  assert.deepEqual(result.answers[0].selected, ['Two', 'One']);
});
await test('RPC cancelled dialogs stop without recording a user decline or later answer', async () => {
  const controller = new AbortController();
  const pending = rpc.runRpcQuestionnaire({ input: async () => '', select: (_title, _options, opts) => {
    assert.equal(opts.signal, controller.signal);
    return new Promise(resolve => opts.signal.addEventListener('abort', () => resolve(undefined), { once: true }));
  } }, questions, controller.signal);
  controller.abort();
  await assert.rejects(pending);
});
const ask = await load('rpiv-ask-user-question/ask-user-question.ts');
await test('ask tool checks pre-abort and balances concurrent RPC blocked events', async () => {
  const h = registry(); ask.registerAskUserQuestionTool(h.pi);
  const events = []; h.pi.events.on('rpiv:ask-user:blocked', event => events.push(event.active));
  const releases = [];
  const ctx = { hasUI: true, mode: 'rpc', ui: { select: (_title, choices) => new Promise(resolve => releases.push(() => resolve(choices[0]))), input: async () => '' } };
  const controller = new AbortController(); controller.abort();
  const tool = h.tools.get('ask_user_question');
  await assert.rejects(tool.execute('abort', questions, controller.signal, undefined, ctx));
  assert.equal(releases.length, 0);
  const first = tool.execute('first', questions, undefined, undefined, ctx);
  const second = tool.execute('second', questions, undefined, undefined, ctx);
  releases[0](); await first;
  assert.deepEqual(events, [true]);
  releases[1](); await second;
  assert.deepEqual(events, [true, false]);
  await h.emit('session_shutdown');
});
await test('TUI cancellation removes its hidden questionnaire rather than another overlay', async () => {
  const h = registry(); ask.registerAskUserQuestionTool(h.pi);
  const ui = new tui.TuiMainScreen({ columns: 80, rows: 30, hideCursor() {}, write() {} });
  ui.requestRender = () => {};
  let rawInput, owned, component;
  const ctx = { hasUI: true, mode: 'tui', ui: { notify() {}, onTerminalInput(callback) { rawInput = callback; return () => { rawInput = undefined; }; },
    custom(factory, opts) { return new Promise((resolve, reject) => {
      let closed = false;
      const done = value => { if (closed) return; closed = true; ui.hideOverlay(); resolve(value); };
      try { component = factory(ui, theme, tui.getKeybindings(), done); }
      catch (error) { reject(error); return; }
      Promise.resolve(component).then(created => { if (!closed) { owned = ui.showOverlay(created); opts.onHandle(owned); } });
    }); },
  } };
  const controller = new AbortController();
  const request = h.tools.get('ask_user_question').execute('tui', questions, controller.signal, undefined, ctx);
  const rejected = assert.rejects(request);
  await flush();
  assert(owned);
  rawInput('\x1d'); assert.equal(owned.isHidden(), true);
  assert(component.render(1).every(line => tui.visibleWidth(line) <= 1));
  const otherComponent = { render: () => ['Other dialog'], invalidate() {}, handleInput() {} };
  const other = ui.showOverlay(otherComponent);
  controller.abort(); await rejected;
  assert.equal(other.isFocused(), true, 'unrelated dialog remains mounted and focused');
  assert.equal(rawInput, undefined);
  other.hide(); await h.emit('session_shutdown');
});
await test('Fusion private RPC children never misreport transport cancellation as human decline', async () => {
  const previous = process.env.UNIPI_FUSION_CHILD; process.env.UNIPI_FUSION_CHILD = '1';
  const h = registry(); ask.registerAskUserQuestionTool(h.pi);
  const reconcile = await load('rpiv-ask-user-question/reconcile.ts');
  let active = ['read', 'ask_user_question'];
  h.pi.getActiveTools = () => active; h.pi.setActiveTools = names => { active = names; };
  reconcile.registerAskUserQuestionReconciler(h.pi);
  const event = { systemPromptOptions: { selectedTools: [...active] } };
  try {
    const ctx = { hasUI: true, mode: 'rpc', ui: { select: async () => { throw new Error('should never show a dialog'); }, input: async () => '' } };
    await h.emit('before_agent_start', event, ctx);
    assert.deepEqual(active, ['read']); assert.deepEqual(event.systemPromptOptions.selectedTools, ['read']);
    const result = await h.tools.get('ask_user_question').execute('child', questions, undefined, undefined, ctx);
    assert.equal(result.details.error, 'no_ui'); assert.match(result.content[0].text, /did not see/);
  } finally { if (previous === undefined) delete process.env.UNIPI_FUSION_CHILD; else process.env.UNIPI_FUSION_CHILD = previous;
    await h.emit('session_shutdown'); }
});

const goalPersistence = await load('pi-goal/src/persistence.ts');
const goalSettings = await load('pi-goal/src/settings.ts');
const goalCommand = await load('pi-goal/src/command.ts');
await test('Goal legacy cleanup preserves malformed state and atomically preserves other workspaces', () => {
  const file = path.join(scratch, 'legacy-goal.json');
  fs.writeFileSync(file, '{broken');
  assert.throws(() => goalPersistence.clearLegacyPersistedGoal('/one', file), /Refusing to overwrite/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  fs.writeFileSync(file, JSON.stringify({ '/one': { id: 1 }, '/two': { id: 2 } }));
  goalPersistence.clearLegacyPersistedGoal('/one', file);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { '/two': { id: 2 } });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert(!fs.existsSync(file + '.lock'));
});
await test('Goal settings reject an active writer and keep unrelated fields', () => {
  const file = path.join(scratch, 'goal-settings.json');
  fs.writeFileSync(file, JSON.stringify({ custom: 'retained', rpc: { enabled: false } }));
  fs.writeFileSync(file + '.lock', JSON.stringify({ pid: process.pid, token: 'other-writer' }));
  assert.throws(() => goalSettings.saveGoalSettings(goalSettings.DEFAULT_GOAL_SETTINGS, file), /busy/);
  assert.equal(JSON.parse(fs.readFileSync(file)).custom, 'retained');
  fs.unlinkSync(file + '.lock');
  goalSettings.saveGoalSettings(goalSettings.DEFAULT_GOAL_SETTINGS, file);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(file)).custom, 'retained');
});
await test('Goal command keeps apostrophes in natural objectives', () => {
  assert.equal(goalCommand.parseCommand("Fix user's configuration").objective, "Fix user's configuration");
  assert.equal(goalCommand.parseCommand('--tokens "2k" "Fix two files"').tokenBudget, 2000);
});
const { WorkflowMutex } = await load('pi-goal/src/workflow-mutex.ts');
await test('Goal workflow listeners are removed and can be rebound', () => {
  let active = 0;
  const mutex = new WorkflowMutex({ events: { on: () => { active++; return () => { active--; }; }, emit() {} } });
  const session = {};
  mutex.bindSession(session); mutex.bindSession(session); assert.equal(active, 1);
  mutex.unbindSession(session); assert.equal(active, 0);
  mutex.bindSession({}); assert.equal(active, 1);
});
const { GoalWaitTimer, MAX_GOAL_WAIT_DELAY_MS } = await load('pi-goal/src/wait.ts');
await test('Goal waits re-arm far-future deadlines and ignore old timer callbacks', () => {
  const timeout = globalThis.setTimeout, clear = globalThis.clearTimeout, now = Date.now;
  let clock = 0, callback, delay, fired = 0;
  globalThis.setTimeout = (fn, ms) => { callback = fn; delay = ms; return { unref() {} }; };
  globalThis.clearTimeout = () => {};
  Date.now = () => clock;
  const timer = new GoalWaitTimer();
  try {
    timer.schedule(MAX_GOAL_WAIT_DELAY_MS + 1000, () => fired++);
    assert.equal(delay, MAX_GOAL_WAIT_DELAY_MS);
    clock = MAX_GOAL_WAIT_DELAY_MS; callback();
    assert.equal(fired, 0); assert.equal(delay, 1000);
    clock += 1000; callback(); assert.equal(fired, 1);
    timer.schedule(clock + 500, () => fired++); const late = callback; timer.clear(); late();
    assert.equal(fired, 1);
  } finally { globalThis.setTimeout = timeout; globalThis.clearTimeout = clear; Date.now = now; }
});

const tree = await load('session-picker/tree.ts');
await test('Session picker handles a 10,000-level fork tree with bounded prefixes and no recursion', () => {
  const sessions = Array.from({ length: 10000 }, (_, i) => ({ path: path.join(scratch, `session-${i}`), parentSessionPath: i ? path.join(scratch, `session-${i - 1}`) : undefined, modified: new Date(i), id: String(i) }));
  const { roots } = tree.buildTree(sessions);
  assert.equal(roots.length, 1);
  const expanded = new Set(); tree.expandSubtree(roots[0], expanded, true);
  const rows = tree.flatten(roots, expanded);
  assert.equal(rows.length, 10000);
  assert(rows.every(row => row.prefix.length < 110));
  tree.expandSubtree(roots[0], expanded, false); assert.equal(expanded.size, 0);
});
await test('Session picker bounds catastrophic regex backtracking and preserves ordinary regex matching', () => {
  const sessions = [{ path: '/synthetic', id: 'one', modified: new Date(), allMessagesText: 'a'.repeat(100) + '!' }];
  assert.throws(() => tree.search(sessions, 're:(a+)+$', 'recent'), /100 ms/);
  assert.equal(tree.search(sessions, 're:a+!', 'recent').length, 1);
});

const openTuiRoot = 'pi-open-tui/extensions/open-tui/';
const openConfig = await load(openTuiRoot + 'config.ts');
const { OpenTuiHeader } = await load(openTuiRoot + 'header.ts');
await test('Open TUI invalid configuration sections cannot mutate defaults or crash consumers', () => {
  const file = openConfig.getConfigPath();
  fs.writeFileSync(file, JSON.stringify({ enabled: 'yes', icons: null, telemetry: false, footerSegments: 7, thinkingPeek: [], cursorStyle: 'bad' }));
  const config = openConfig.loadConfig();
  assert.deepEqual(config, openConfig.DEFAULT_CONFIG);
  config.icons.mode = 'ascii';
  assert.equal(openConfig.DEFAULT_CONFIG.icons.mode, 'auto');
});
await test('Open TUI refuses corrupt settings and saves private atomic files', () => {
  const file = openConfig.getConfigPath(); fs.writeFileSync(file, '{broken');
  assert.throws(() => openConfig.saveConfig(openConfig.DEFAULT_CONFIG));
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  fs.writeFileSync(file, '{}'); openConfig.saveConfig(openConfig.DEFAULT_CONFIG);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
await test('Open TUI header fits every narrow and invalid terminal width', () => {
  const header = new OpenTuiHeader({ getCommands: () => [], getThinkingLevel: () => 'high' }, { ui: { theme }, cwd: scratch, model: { provider: 'test', id: '中文模型' } }, {});
  for (const width of [1, 2, 5, 10, 20, 24, 80, 120, 0, NaN]) {
    const normalized = Number.isFinite(width) ? Math.max(1, width) : 1;
    assert(header.render(width).every(line => tui.visibleWidth(line) <= normalized), `width ${width}`);
  }
});
const openState = await load(openTuiRoot + 'state.ts');
await test('Open TUI usage cache belongs to the current manager even when entry IDs match', () => {
  const context = input => ({ sessionManager: { getEntries: () => [{ type: 'message', id: 'same', timestamp: 0,
    message: { role: 'assistant', usage: { input, output: 0, cacheRead: 0, cacheWrite: 0 } } }] } });
  assert.equal(openState.getUsageTotals(context(10)).input, 10);
  assert.equal(openState.getUsageTotals(context(20)).input, 20);
});
const tasksConfig = await load('tasks/src/tasks-config.ts');
const subagentsSettings = await load('subagents/src/settings.ts');
await test('Tasks and Subagents refuse corrupt settings and save private atomic files', () => {
  const cwd = path.join(scratch, 'settings-project'); fs.mkdirSync(path.join(cwd, '.pi'), { recursive: true });
  const tasksFile = path.join(cwd, '.pi/tasks-config.json'), subFile = path.join(cwd, '.pi/subagents.json');
  fs.writeFileSync(tasksFile, '{broken'); fs.writeFileSync(subFile, '{broken');
  assert.throws(() => tasksConfig.saveTasksConfig({ maxVisible: 15 }, cwd), /Refusing to overwrite/);
  assert.equal(subagentsSettings.saveSettings({ maxConcurrent: 3 }, cwd), false);
  assert.equal(fs.readFileSync(tasksFile, 'utf8'), '{broken'); assert.equal(fs.readFileSync(subFile, 'utf8'), '{broken');
  fs.writeFileSync(tasksFile, '{}'); fs.writeFileSync(subFile, '{}');
  tasksConfig.saveTasksConfig({ maxVisible: 15 }, cwd);
  assert.equal(subagentsSettings.saveSettings({ maxConcurrent: 3 }, cwd), true);
  assert.equal(fs.statSync(tasksFile).mode & 0o777, 0o600); assert.equal(fs.statSync(subFile).mode & 0o777, 0o600);
});

const webUtils = await load('pi-web-access/utils.ts');
const ssrf = await load('pi-web-access/ssrf-protection.ts');
const storage = await load('pi-web-access/storage.ts');
const webConfigPath = path.join(process.env.PI_CODING_AGENT_DIR, 'web-search.json');
fs.writeFileSync(webConfigPath, '{}');
await test('Web redirects release bodies, strip cross-origin credentials and rewrite POST body headers', async () => {
  const requests = []; let released = 0;
  const redirected = new Response(new ReadableStream({ cancel() { released++; } }), { status: 303, headers: { location: 'https://other.example/final' } });
  await ssrf.fetchRemoteUrl('https://first.example/start', { method: 'POST', body: 'data', headers: { Authorization: 'synthetic', Cookie: 'synthetic', 'content-type': 'application/json' } }, {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    fetch: async (_url, init) => { requests.push(init); return requests.length === 1 ? redirected : new Response('ok'); },
  });
  assert.equal(released, 1); assert.equal(requests[1].method, 'GET'); assert.equal(requests[1].body, undefined);
  const headers = new Headers(requests[1].headers);
  assert.equal(headers.get('authorization'), null); assert.equal(headers.get('cookie'), null); assert.equal(headers.get('content-type'), null);
});
await test('Proxy bypass honors NO_PROXY ports and every IPv4/mapped-IPv6 loopback', () => {
  const previous = process.env.NO_PROXY;
  process.env.NO_PROXY = 'example.com:443';
  try {
    assert.equal(webUtils.isProxyBypassedUrl(new URL('https://example.com')), true);
    assert.equal(webUtils.isProxyBypassedUrl(new URL('http://example.com:8080')), false);
    assert.equal(webUtils.isProxyBypassedUrl(new URL('http://127.2.3.4')), true);
    assert.equal(webUtils.isProxyBypassedUrl(new URL('http://[::ffff:127.0.0.1]')), true);
    assert.throws(() => webUtils.normalizeProxyUrl('ssh://user:synthetic-secret@example.com', 'proxy'), error => !error.message.includes('synthetic-secret'));
  } finally { if (previous === undefined) delete process.env.NO_PROXY; else process.env.NO_PROXY = previous; }
});
await test('Web cancellation returns during a hung DNS preflight without starting a request', async () => {
  const controller = new AbortController(); let requests = 0;
  const request = ssrf.fetchRemoteUrl('https://hung.example', { signal: controller.signal }, {
    lookup: () => new Promise(() => {}), fetch: async () => { requests++; return new Response('unexpected'); },
  });
  controller.abort(); await assert.rejects(request); assert.equal(requests, 0);
});
await test('Web policy cache notices same-sized atomic replacements and rejects unreadable files', async () => {
  fs.writeFileSync(webConfigPath, JSON.stringify({ fetchContent: { domainPolicy: { deny: ['one.example'] } } }));
  assert.deepEqual(ssrf.loadFetchContentDomainPolicy().deny, ['one.example']);
  const timestamp = fs.statSync(webConfigPath).mtime;
  const replacement = webConfigPath + '.replacement';
  fs.writeFileSync(replacement, JSON.stringify({ fetchContent: { domainPolicy: { deny: ['two.example'] } } }));
  fs.utimesSync(replacement, timestamp, timestamp); fs.renameSync(replacement, webConfigPath);
  assert.deepEqual(ssrf.loadFetchContentDomainPolicy().deny, ['two.example']);
  fs.chmodSync(webConfigPath, 0);
  try { assert.throws(() => ssrf.loadFetchContentDomainPolicy(), /Cannot read/); }
  finally { fs.chmodSync(webConfigPath, 0o600); fs.writeFileSync(webConfigPath, '{}'); }
});
await test('Old asynchronous Web work cannot write results into a new session', async () => {
  storage.clearResults(); let resume;
  const work = storage.withResultSession(async () => { await new Promise(resolve => { resume = resolve; });
    storage.storeResult('old', { id: 'old', type: 'search', timestamp: Date.now(), queries: [] }); });
  storage.clearResults(); resume(); await assert.rejects(work, /inactive session/);
  assert.equal(storage.getResult('old'), null);
});
await test('Disk-backed fetched pages do not accumulate permanent full-text RAM copies', () => {
  const content = 'synthetic page'.repeat(50000);
  storage.storeFetchedContentResult('memory-test', { id: 'memory-test', type: 'fetch', timestamp: Date.now(), urls: [{ url: 'https://example.com', title: 'Fixture', content, error: null }] });
  assert.equal(storage.getAllResults().find(result => result.id === 'memory-test').urls, undefined);
  assert.equal(storage.getResult('memory-test').urls[0].content, content);
  assert.equal(storage.getAllResults().find(result => result.id === 'memory-test').urls, undefined);
});
const find = await load('pi-web-access/content-find.ts');
await test('Fuzzy content matching keeps edit-distance semantics for long tokens without quadratic work', () => {
  const token = 'a'.repeat(30000) + 'b';
  const result = find.findContent(token, ['a'.repeat(30000) + 'c'], 'fuzzy');
  assert.equal(result.matchCount, 1);
});
async function localServer(handler) {
  const server = http.createServer(handler); const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}`, close: async () => {
    for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve));
  } };
}
await test('Real curl proxy honors Request body/headers and HEAD without putting credentials in argv; reload stays usable', async () => {
  const requests = [], invocations = [];
  const proxy = await localServer((req, res) => {
    const chunks = []; req.on('data', chunk => chunks.push(chunk)); req.on('end', () => {
      requests.push({ method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString() });
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(req.method === 'HEAD' ? undefined : '{"ok":true}');
    });
  });
  const cp = require('node:child_process'), originalSpawn = cp.spawn, nativeFetch = globalThis.fetch, noProxy = process.env.NO_PROXY;
  cp.spawn = (command, args, options) => { if (command === 'curl') {
    invocations.push(args); assert.equal(args.length, 2); assert.equal(args[0], '--config');
    assert.equal(fs.statSync(args[1]).mode & 0o777, 0o600);
  } return originalSpawn(command, args, options); };
  syncBuiltinESMExports(); process.env.NO_PROXY = '';
  try {
    const request = new Request('http://proxy-fixture.invalid/test', { method: 'POST', body: 'payload', headers: { Authorization: 'synthetic-secret' } });
    const response = await webUtils.runWithProxy(proxy.url, () => fetch(request));
    assert.equal((await response.json()).ok, true);
    assert.equal(requests[0].method, 'POST'); assert.equal(requests[0].body, 'payload'); assert.equal(requests[0].headers.authorization, 'synthetic-secret');
    const head = await webUtils.runWithProxy(proxy.url, () => fetch('http://proxy-fixture.invalid/head', { method: 'HEAD' }));
    assert.equal(await head.text(), ''); assert.equal(requests[1].method, 'HEAD');
    const freshFile = path.join(scratch, 'fresh-utils.ts'); fs.copyFileSync(path.join(source, 'pi-web-access/utils.ts'), freshFile);
    const fresh = await jiti.import(freshFile);
    const afterReload = await fresh.runWithProxy(proxy.url, () => fetch('http://proxy-fixture.invalid/reloaded'));
    assert.equal((await afterReload.json()).ok, true); assert.equal(requests.length, 3);
    assert(!JSON.stringify(invocations).includes('synthetic-secret'));
  } finally { globalThis.fetch = nativeFetch; cp.spawn = originalSpawn; syncBuiltinESMExports();
    if (noProxy === undefined) delete process.env.NO_PROXY; else process.env.NO_PROXY = noProxy;
    await proxy.close(); }
});

const curator = await load('pi-web-access/curator-server.ts');
await test('Curator rewrite survives normal POST completion and split UTF-8 input', async () => {
  let querySeen;
  const handle = await curator.startCuratorServer({ queries: [], sessionToken: 'synthetic-token', timeout: 60,
    availableProviders: { duckduckgo: true }, defaultProvider: 'duckduckgo', searchProvider: 'duckduckgo', summaryModels: [], defaultSummaryModel: null }, {
    onSubmit() {}, onCancel() {}, onProviderChange() {}, onAddSearch: async () => [], onAddSearchResults() {},
    onSummarize: async () => ({ summary: '', meta: {} }), onRewriteQuery: async (query, signal) => {
      querySeen = query; await new Promise(resolve => setTimeout(resolve, 20)); signal.throwIfAborted(); return query + ' rewritten';
    },
  });
  try {
    const endpoint = new URL('/rewrite', handle.url);
    const bytes = Buffer.from(JSON.stringify({ token: 'synthetic-token', query: '中文测试' }));
    const split = bytes.indexOf(Buffer.from('中')) + 1;
    const response = await new Promise((resolve, reject) => {
      const req = http.request(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' } }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) }));
      });
      req.on('error', reject); req.write(bytes.subarray(0, split)); setTimeout(() => req.end(bytes.subarray(split)), 10);
    });
    assert.equal(response.status, 200); assert.equal(querySeen, '中文测试'); assert.equal(response.body.query, '中文测试 rewritten');
  } finally { handle.close(); }
});
console.log('All-plugin audit regressions complete; no credentials or external model calls.');
