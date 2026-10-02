// Actual local background-commands producer + real SDK events + Fusion runtime
// and completion delivery. Only two harmless local printf subprocesses run;
// all model responses and the RPC child are in-memory fakes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageDir = process.argv[2];
assert(packageDir, 'Expected Pi package directory');
const directory = path.dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(path.join(os.tmpdir(), 'fusion-background-e2e-'));
process.env.HOME = root;
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
process.env.PI_OFFLINE = '1';
process.env.SHELL = process.env.PI_FUSION_TEST_SHELL ?? '/run/current-system/sw/bin/bash';
process.chdir(root);
const sdk = await import(pathToFileURL(path.join(packageDir, 'dist/index.js')));
const { AssistantMessageEventStream } = await import(pathToFileURL(path.join(packageDir, 'node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js')));
const require = createRequire(path.join(packageDir, 'package.json'));
const { createJiti } = await import(pathToFileURL(require.resolve('jiti')));
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: {
  '@earendil-works/pi-coding-agent': path.join(packageDir, 'dist/index.js'),
  '@earendil-works/pi-tui': path.join(packageDir, 'node_modules/@earendil-works/pi-tui/dist/index.js'),
  '@earendil-works/pi-ai': path.join(packageDir, 'node_modules/@earendil-works/pi-ai/dist/compat.js'),
  typebox: require.resolve('typebox'),
} });
const { SidekickRuntime } = await jiti.import(path.join(directory, '../src/sidekick-runtime.ts'));
const { registerFusionTools } = await jiti.import(path.join(directory, '../src/tools.ts'));
const backgroundExtension = process.env.PI_FUSION_TEST_BACKGROUND_EXT ?? path.resolve(directory, '../../extensions/background-commands.ts');
const settings = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
const loader = new sdk.DefaultResourceLoader({
  cwd: root, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager: settings,
  noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  additionalExtensionPaths: [backgroundExtension],
  extensionFactories: [pi => pi.registerProvider('background-fixture', {
    api: 'openai-completions', apiKey: 'test-only-not-a-real-key', baseUrl: 'http://127.0.0.1:9',
    models: [{ id: 'model', name: 'Fixture', reasoning: false, input: ['text'], contextWindow: 8192, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  })],
});
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
const { session } = await sdk.createAgentSession({ cwd: root, agentDir: process.env.PI_CODING_AGENT_DIR,
  settingsManager: settings, resourceLoader: loader, sessionManager: sdk.SessionManager.inMemory(root) });
await session.bindExtensions({ mode: 'sdk', onError: error => { throw error; } });
await session.setModel(session._modelRuntime.getModel('background-fixture', 'model'));
const final = 'ACTUAL_BACKGROUND_FINAL_REPORT';
let calls = 0;
session.agent.streamFunction = (model, context) => {
  calls++;
  const content = calls === 1
    ? [1, 2].map(i => ({ type: 'toolCall', id: `bg-e2e-${i}`, name: 'bg_run', arguments: { command: `printf 'fixture-${i}\\n'`, name: `fixture-${i}` } }))
    : [{ type: 'text', text: calls === 2 ? 'checkpoint: background jobs still settling' : final }];
  const reason = calls === 1 ? 'toolUse' : 'stop';
  const message = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
    stopReason: reason, timestamp: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  const stream = new AssistantMessageEventStream();
  queueMicrotask(() => { stream.push({ type: 'done', reason, message }); stream.end(); });
  return stream;
};
const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, killed: false });
child.kill = () => { child.killed = true; child.exitCode = 0; child.emit('close'); return true; };
const notes = [];
const requests = [];
const errors = [];
const parentTools = new Map();
const parentMessages = [];
const runtime = new SidekickRuntime({ cwd: root, model: 'background-fixture/model', thinking: 'off', sessionFile: path.join(root, 'stub.jsonl'),
  systemPrompt: 'stub', spawn: () => child, command: { command: 'in-memory-rpc', args: [] }, settleGraceMs: 40, reportTimeoutMs: 1500 });
const wire = value => child.stdout.write(JSON.stringify(value) + '\n');
const unsubscribe = session.subscribe(event => {
  if (event.type === 'message_end' && event.message.role === 'custom' && event.message.customType === 'background-command-result') notes.push(event.message);
  // The runtime correlates prompt acceptance with this brief's user activity.
  if (event.type === 'message_end' && event.message.role === 'user') wire(event);
  wire(event);
});
child.stdin.on('data', chunk => {
  for (const line of String(chunk).split('\n').filter(Boolean)) {
    const command = JSON.parse(line);
    requests.push(command);
    if (command.type === 'prompt') {
      wire({ type: 'response', id: command.id, command: 'prompt', success: true });
      void session.prompt(command.message, command.streamingBehavior ? { streamingBehavior: command.streamingBehavior } : undefined)
        .then(() => new Promise(resolve => setImmediate(resolve)))
        .catch(error => errors.push(String(error)));
    } else if (command.type === 'get_state') {
      wire({ type: 'response', id: command.id, command: 'get_state', success: true,
        data: { isStreaming: session.isStreaming, isCompacting: false, pendingMessageCount: session.pendingMessageCount } });
    } else if (command.type === 'get_last_assistant_text') {
      wire({ type: 'response', id: command.id, command: command.type, success: true, data: { text: session.getLastAssistantText() } });
    }
  }
});
registerFusionTools({ registerTool: tool => parentTools.set(tool.name, tool), registerMessageRenderer() {},
  on: () => () => undefined, sendMessage: (message, options) => parentMessages.push({ message, options }),
}, { getRuntime: () => runtime });

await test('real local background extension releases a two-job batch and wakes the lead exactly once with the final follow-up report', { timeout: 5000 }, async t => {
  t.after(async () => {
    unsubscribe();
    runtime.kill();
    await session.dispose();
  });
  const launched = await parentTools.get('sidekick').execute('call', { message: 'run two fixture jobs', block: false }, undefined, undefined, { hasPendingMessages: () => false });
  assert.equal(launched.details.background, true);
  const report = await runtime.latest().done;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(report.status, 'completed');
  assert.equal(report.text, final, 'the earlier stopped checkpoint is not the final report');
  assert.equal(runtime.isBusy(), false);
  assert.equal(calls, 3, 'initial dispatch, checkpoint and notification follow-up used only fake streams');
  assert.equal(notes.reduce((n, message) => n + message.details.jobs.length, 0), 2);
  assert.equal(notes.length, 1, 'the real producer coalesced the two jobs');
  assert.equal(notes[0].details.jobs.length, 2);
  assert.equal(parentMessages.length, 1);
  assert.match(parentMessages[0].message.content, /ACTUAL_BACKGROUND_FINAL_REPORT/);
  assert.equal(parentMessages[0].options.triggerTurn, true);
  assert.equal(parentMessages[0].options.deliverAs, 'followUp');
  assert.equal(requests.filter(request => request.type === 'get_last_assistant_text').length, 1);
  assert.deepEqual(errors, []);
});
