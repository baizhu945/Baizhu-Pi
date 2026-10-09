import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const sdk = process.env.REA_TEST_SDK, work = process.env.REA_TEST_WORK;
assert.ok(sdk && work, 'Use tests/run.mjs; never patch the installed SDK in place');
const load = (path) => import(pathToFileURL(join(sdk, path)).href);
const { createMcpExtension } = await load('dist/extensions/mcp/index.js');
const { McpServerConnection, McpOAuthCredentialStore } = await load('dist/extensions/mcp/runtime.js');
const { createInMemoryTransportPair } = await load('node_modules/@earendil-works/pi-mcp/dist/testing/index.js');
const { LATEST_PROTOCOL_VERSION } = await load('node_modules/@earendil-works/pi-mcp/dist/index.js');
const SDK = await load('dist/index.js');
const here = dirname(fileURLToPath(import.meta.url));
const deferred = () => { let resolve; const wait = new Promise(r => { resolve = r; }); return { wait, resolve }; };
const tick = () => new Promise(r => setImmediate(r));
const deadline = async (promise, message, ms = 4000) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); }
  finally { clearTimeout(timer); }
};
async function until(check, message, ms = 4000) {
  const end = Date.now() + ms;
  while (!(await check())) { if (Date.now() > end) throw new Error(message); await new Promise(r => setTimeout(r, 10)); }
}
const entry = (extra = {}) => ({ name: 'rea', source: 'regression', scope: 'extension', config: { command: 'unused', exposure: 'direct', timeout: 600, ...extra } });
function fakeServer({ gateList = false } = {}) {
  const pair = createInMemoryTransportPair();
  const seenList = deferred();
  let closes = 0, starts = 0, listRequest;
  const close = pair.client.close.bind(pair.client), start = pair.client.start.bind(pair.client);
  // InMemoryTransport recursively closes its peer (which calls back into close).
  // Count actual teardown transitions, not its idempotent recursive invocation.
  pair.client.close = async () => { if (!pair.client.closed) closes++; return close(); };
  pair.client.start = async () => { starts++; return start(); };
  pair.server.onMessage((request) => {
    if (!('id' in request) || !('method' in request)) return;
    let result;
    if (request.method === 'initialize') result = { protocolVersion: LATEST_PROTOCOL_VERSION, serverInfo: { name: 'fake', version: '1' }, capabilities: { tools: {} } };
    else if (request.method === 'tools/list') {
      listRequest = request; seenList.resolve();
      if (gateList) return;
      result = { tools: [{ name: 'healthy', inputSchema: { type: 'object', properties: {} } }] };
    } else result = {};
    void pair.server.send({ jsonrpc: '2.0', id: request.id, result }).catch(() => {});
  });
  void pair.server.start();
  return { pair, seenList, get closes() { return closes; }, get starts() { return starts; },
    lateList: () => pair.server.send({ jsonrpc: '2.0', id: listRequest.id, result: { tools: [{ name: 'late', inputSchema: { type: 'object' } }] } }).catch(() => {}) };
}
function connection(createTransport, onTools = () => {}) {
  return new McpServerConnection({ entry: entry(), cwd: work, createTransport,
    credentials: new McpOAuthCredentialStore(), onTools });
}
function nativeHarness(createTransport) {
  const handlers = new Map(), tools = new Map(); let servers = [];
  const pi = {
    on: (name, fn) => handlers.set(name, fn), registerToolRenderer() {}, registerCommand() {},
    registerTool: definition => tools.set(definition.name, definition),
    getMcpServers: () => servers, getAllTools: () => [...tools.values()],
    getActiveTools: () => [...tools.values()].filter(t => t.exposure !== 'hidden').map(t => t.name), setActiveTools() {},
  };
  createMcpExtension({ loadConfig: () => ({ servers: [], errors: [] }), createTransport })(pi);
  const ctx = { cwd: work, modelRegistry: {}, ui: { notify() {} } };
  return { tools, handlers, ctx, set: value => { servers = value; },
    change: () => handlers.get('mcp_servers_change')({ type: 'mcp_servers_change' }, ctx),
    start: () => handlers.get('session_start')({ type: 'session_start' }, ctx),
    stop: () => handlers.get('session_shutdown')({ type: 'session_shutdown' }, ctx) };
}

test('lazy import unregister: no late connection, tools or subprocess; cold-off does not import', async () => {
  const reached = deferred(), release = deferred(); let loads = 0, transports = 0;
  globalThis[Symbol.for('rea-tests:lazy-gate')] = { enter() { loads++; reached.resolve(); }, wait: release.wait };
  const h = nativeHarness(() => { transports++; throw new Error('unregistered server must not start'); });
  await h.start(); assert.equal(loads, 0); assert.equal(h.tools.size, 0);
  h.set([{ ...entry(), extensionPath: 'controller' }]);
  const adding = h.change(); await reached.wait;
  h.set([]); await h.change(); release.resolve(); await deadline(adding, 'lazy cancellation did not settle');
  assert.equal(transports, 0); assert.equal(h.tools.size, 0);
  delete globalThis[Symbol.for('rea-tests:lazy-gate')]; await h.stop();
});

test('tools/list pending: concurrent close cancels setup, suppresses late publish, closes once', async () => {
  const server = fakeServer({ gateList: true }); let publishes = 0;
  const c = connection(() => server.pair.client, () => publishes++);
  const opened = c.getClient().then(() => 'unexpected-success', () => 'cancelled');
  await server.seenList.wait;
  await deadline(Promise.all([c.close(), c.close()]), 'close deadlocked behind opening');
  assert.equal(await deadline(opened, 'tools/list did not reject'), 'cancelled');
  await server.lateList(); await tick();
  assert.equal(c.state, 'closed'); assert.equal(publishes, 0); assert.equal(server.closes, 1);
});

test('concurrent reconnects share replacement; old client close does not close the new client', async () => {
  const servers = []; let publishes = 0;
  const c = connection(() => { const s = fakeServer(); servers.push(s); return s.pair.client; }, () => publishes++);
  const old = await c.getClient();
  await deadline(Promise.all([c.reconnect(), c.reconnect()]), 'reconnect deadlocked');
  const current = await c.getClient();
  assert.notEqual(current, old); assert.equal(current.connectionState, 'connected');
  assert.equal(servers.length, 2); assert.equal(servers[0].closes, 1); assert.equal(servers[1].closes, 0);
  assert.equal(publishes, 2);
  await Promise.all([c.close(), c.close()]); assert.equal(servers[1].closes, 1);
});

test('terminal close waits detached old teardown; concurrent reconnect cannot reopen', async () => {
  const server = fakeServer(), reached = deferred(), release = deferred();
  const closeTransport = server.pair.client.close.bind(server.pair.client);
  server.pair.client.close = async () => {
    if (server.pair.client.closed) return closeTransport();
    reached.resolve(); await closeTransport(); await release.wait;
  };
  let creations = 0;
  const c = connection(() => { creations++; return server.pair.client; });
  await c.getClient();
  const reconnect = c.reconnect().then(() => 'unexpected-success', () => 'cancelled');
  await reached.wait;
  let closed = false; const closing = c.close().then(() => { closed = true; });
  await tick(); assert.equal(closed, false, 'must await detached teardown, not return early');
  release.resolve(); await deadline(closing, 'terminal close did not finish');
  assert.equal(await reconnect, 'cancelled'); assert.equal(creations, 1); assert.equal(c.state, 'closed');
});

test('factory reentrant close: unbound pending transport is closed, never started', async () => {
  const server = fakeServer(); let c;
  c = connection(() => { void c.close(); return server.pair.client; });
  await assert.rejects(c.getClient(), /shut down|closed/);
  await c.close(); assert.equal(server.starts, 0); assert.equal(server.closes, 1);
});

const noStreamModel = {
  id: 'no-stream', name: 'No provider requests permitted', provider: 'test-offline', api: 'openai-completions',
  baseUrl: 'http://127.0.0.1:1', reasoning: false, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024,
};
async function sdkSession(name) {
  const cwd = join(work, name), agentDir = join(cwd, 'agent'); await mkdir(agentDir, { recursive: true });
  let api;
  const settingsManager = SDK.SettingsManager.inMemory({ defaultTools: [] });
  const resourceLoader = new SDK.DefaultResourceLoader({ cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    additionalExtensionPaths: [resolve(here, '../index.ts')],
    extensionFactories: [pi => { api = pi; }, createMcpExtension({ loadConfig: () => ({ servers: [], errors: [] }) })],
  });
  await resourceLoader.reload();
  assert.ok(resourceLoader.getExtensions().extensions.some(ext => ext.commands.has('rea')), 'REA controller must actually be loaded in the fresh-session regression');
  const { session } = await SDK.createAgentSession({ cwd, agentDir, resourceLoader, settingsManager,
    sessionManager: SDK.SessionManager.inMemory(cwd), model: noStreamModel, noTools: true });
  await session.bindExtensions({ mode: 'print' });
  assert.ok(api); return { api, session };
}
const configFor = (mode, marker) => ({ command: process.execPath,
  args: [resolve(here, 'gated-server.mjs'), mode, marker], env: {}, timeout: 600, exposure: 'direct' });
async function markers(path) {
  try { return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
async function waitMarker(path, event) {
  let found; await until(async () => { found = (await markers(path)).find(m => m.event === event); return found; }, `Missing ${event}: ${path}`);
  return found;
}
async function waitExit(path) {
  const signal = await waitMarker(path, 'SIGTERM');
  await until(() => { try { process.kill(signal.pid, 0); return false; } catch (e) { if (e.code === 'ESRCH') return true; throw e; } }, 'gated process survived close');
}
for (const [mode, blocked] of [['init-gated', 'initialize'], ['list-gated', 'tools/list']]) {
  test(`real SDK unregister during ${blocked}: stdin closes, SIGTERM received, process exits; fresh session has zero tools`, async () => {
    const { api, session } = await sdkSession(mode); const marker = join(work, `${mode}.jsonl`);
    try {
      assert.deepEqual(session.getActiveToolNames(), []);
      api.registerMcpServer('rea', configFor(mode, marker));
      await waitMarker(marker, blocked);
      api.unregisterMcpServer('rea');
      await waitExit(marker); // Physical process assertion, NOT just void unregister.
      assert.equal(session.getAllTools().filter(t => t.name.startsWith('mcp__rea__') && t.exposure !== 'hidden').length, 0);
      assert.equal(session.getActiveToolNames().some(n => n.startsWith('mcp__rea__')), false);
      const fresh = await sdkSession(`${mode}-fresh`);
      try {
        await new Promise(r => setTimeout(r, 25));
        assert.deepEqual(fresh.session.getActiveToolNames(), []);
        assert.equal(fresh.session.getAllTools().filter(t => t.name.startsWith('mcp__rea__')).length, 0);
        assert.equal(fresh.api.getMcpServers().length, 0);
        assert.equal(fresh.session.systemPrompt.includes('<rea>'), false);
      } finally { fresh.session.dispose(); }
    } finally { api.unregisterMcpServer('rea'); session.dispose(); }
  });
}

test('real SDK same-name replacement: cancelled list cannot publish or kill replacement process', async () => {
  const { api, session } = await sdkSession('replace');
  const first = join(work, 'replace-old.jsonl'), second = join(work, 'replace-new.jsonl');
  try {
    api.registerMcpServer('rea', configFor('list-gated', first)); await waitMarker(first, 'tools/list');
    api.registerMcpServer('rea', configFor('healthy', second));
    await waitExit(first); await waitMarker(second, 'tools/list');
    await until(() => session.getAllTools().some(t => t.name === 'mcp__rea__healthy' && t.exposure === 'direct'), 'replacement did not become ready');
    const child = (await markers(second)).find(m => m.event === 'spawn');
    process.kill(child.pid, 0);
    assert.equal((await markers(second)).some(m => m.event === 'SIGTERM'), false);
    assert.deepEqual(session.getActiveToolNames().filter(n => n.startsWith('mcp__rea__')), ['mcp__rea__healthy']);
    api.unregisterMcpServer('rea'); await waitExit(second);
  } finally { api.unregisterMcpServer('rea'); session.dispose(); }
});
