// Native SDK/preflight/queued-user events; no Fusion tools, subprocesses,
// credential files, persistent sessions, network, or actual model providers.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, readdirSync, lstatSync, unlinkSync, rmdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageDir = process.argv[2];
assert(packageDir, 'Expected host Pi package directory');
const root = mkdtempSync('/tmp/fusion-runtime-sdk-');
process.env.HOME = root;
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
process.env.PI_OFFLINE = '1';
process.chdir(root);
const sdk = await import(pathToFileURL(path.join(packageDir, 'dist/index.js')));
const { AssistantMessageEventStream } = await import(pathToFileURL(path.join(packageDir, 'node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js')));
const require = createRequire(path.join(packageDir, 'package.json'));
const { createJiti } = await import(pathToFileURL(require.resolve('jiti')));
const jiti = createJiti(import.meta.url, { moduleCache: false });
const { SidekickRuntime } = await jiti.import(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/sidekick-runtime.ts'));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function removeTree(directory) {
  for (const entry of readdirSync(directory)) {
    const file = path.join(directory, entry);
    if (lstatSync(file).isDirectory()) removeTree(file);
    else unlinkSync(file);
  }
  rmdirSync(directory);
}

async function setup(t) {
  const settings = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new sdk.DefaultResourceLoader({
    cwd: root, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [pi => {
      pi.on('input', event => event.text === 'consume me' ? { action: 'handled' } : { action: 'continue' });
      pi.registerCommand('consume-command', { description: 'test-only consumed command', handler: async () => {} });
      pi.registerProvider('runtime-fixture', {
        api: 'openai-completions', apiKey: 'test-only', baseUrl: 'http://127.0.0.1:9',
        models: [{ id: 'model', name: 'Memory fixture', reasoning: false, input: ['text'], contextWindow: 8192, maxTokens: 1024,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      });
    }],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await sdk.createAgentSession({ cwd: root, agentDir: process.env.PI_CODING_AGENT_DIR,
    settingsManager: settings, resourceLoader: loader, sessionManager: sdk.SessionManager.inMemory(root), noTools: 'all' });
  await session.bindExtensions({ mode: 'sdk', onError: error => { throw error; } });
  await session.setModel(session._modelRuntime.getModel('runtime-fixture', 'model'));
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null, killed: false });
  child.kill = () => { child.killed = true; child.exitCode = 0; child.emit('close'); return true; };
  const events = [];
  const requests = [];
  const errors = [];
  const wire = value => child.stdout.write(JSON.stringify(value) + '\n');
  const runtime = new SidekickRuntime({ cwd: root, model: 'runtime-fixture/model', thinking: 'off', sessionFile: path.join(root, 'stub.jsonl'),
    systemPrompt: 'stub', command: { command: 'memory-only', args: [] }, spawn: () => child, promptTimeoutMs: 30, reportTimeoutMs: 1000 });
  const unsubscribe = session.subscribe(event => { events.push(event); wire(event); });
  child.stdin.on('data', data => {
    for (const line of String(data).split('\n').filter(Boolean)) {
      const command = JSON.parse(line);
      requests.push(command);
      if (command.type === 'prompt') {
        let accepted = false;
        void session.prompt(command.message, { streamingBehavior: command.streamingBehavior, source: 'rpc', preflightResult: success => {
          if (success) { accepted = true; wire({ type: 'response', id: command.id, command: 'prompt', success: true }); }
        } }).catch(error => {
          errors.push(String(error));
          if (!accepted) wire({ type: 'response', id: command.id, command: 'prompt', success: false, error: String(error) });
        });
      } else if (command.type === 'get_state') {
        wire({ type: 'response', id: command.id, command: command.type, success: true,
          data: { isStreaming: session.isStreaming, isCompacting: session.isCompacting, pendingMessageCount: session.pendingMessageCount } });
      } else if (command.type === 'get_last_assistant_text') {
        wire({ type: 'response', id: command.id, command: command.type, success: true, data: { text: session.getLastAssistantText() } });
      }
    }
  });
  t.after(async () => { unsubscribe(); runtime.kill(); await session.dispose(); });
  return { session, runtime, events, requests, errors, wire };
}
function finishStream(stream, model, text) {
  const message = { role: 'assistant', content: [{ type: 'text', text }], api: model.api, provider: model.provider, model: model.id,
    stopReason: 'stop', timestamp: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  stream.push({ type: 'done', reason: 'stop', message }); stream.end();
}

try {
  await test('native queued steer activates through user events without a second agent_start', { timeout: 3000 }, async t => {
    const h = await setup(t);
    let started;
    const start = new Promise(resolve => { started = resolve; });
    let release;
    let calls = 0;
    h.session.agent.streamFunction = model => {
      const stream = new AssistantMessageEventStream();
      calls++;
      if (calls === 1) { release = () => finishStream(stream, model, 'old answer'); started(); }
      else queueMicrotask(() => finishStream(stream, model, 'redirect final'));
      return stream;
    };
    const first = h.runtime.handoff('original brief');
    await start;
    const redirected = h.runtime.handoff('queued brief');
    await wait(75); // at least two inactivity windows, verified native streaming/queue state
    assert.equal(h.runtime.isBusy(), true);
    assert.ok(h.requests.some(request => request.type === 'get_state'));
    h.wire({ type: 'agent_settled' }); // old/irrelevant settle before queued user activity
    assert.equal(h.requests.some(request => request.type === 'get_last_assistant_text'), false);
    release();
    const report = await redirected.done;
    assert.equal(report.status, 'completed');
    assert.equal(report.text, 'redirect final');
    assert.equal(first.done, redirected.done);
    assert.equal(h.events.filter(event => event.type === 'agent_start').length, 1);
    assert.ok(h.events.some(event => event.type === 'message_start' && event.message.role === 'user' && event.message.content.some(part => part.text === 'queued brief')));
    assert.deepEqual(h.errors, []);
  });
  for (const brief of ['consume me', '/consume-command']) {
    await test(`native successful preflight but consumed prompt is bounded: ${brief}`, { timeout: 3000 }, async t => {
      const h = await setup(t);
      let calls = 0;
      h.session.agent.streamFunction = () => { calls++; throw new Error('must never invoke a model'); };
      const handoff = h.runtime.handoff(brief);
      await wait(65); // keep the foreground loop referenced for runtime's unref'd watchdog
      const report = await handoff.done;
      assert.equal(report.status, 'error');
      assert.match(report.error, /acknowledged but no matching user activity/);
      assert.equal(calls, 0);
      assert.equal(h.events.some(event => event.type === 'agent_start'), false);
      assert.equal(h.requests.some(request => request.type === 'get_last_assistant_text'), false);
      assert.deepEqual(h.errors, []);
    });
  }
} finally { removeTree(root); }
