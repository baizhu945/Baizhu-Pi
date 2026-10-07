// Real Pi RPC subprocess + real tools + native steering, with a local fake
// provider. No user state, credentials, network or external model requests.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const packageDir = process.argv[2];
assert(packageDir, 'Expected Pi package directory');
const root = mkdtempSync('/tmp/fusion-sidekick-process-');
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
process.env.PI_OFFLINE = '1';
mkdirSync(process.env.PI_CODING_AGENT_DIR);
const require = createRequire(path.join(packageDir, 'package.json'));
const { createJiti } = await import(pathToFileURL(require.resolve('jiti')));
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: {
  '@earendil-works/pi-coding-agent': path.join(packageDir, 'dist/index.js'),
  '@earendil-works/pi-tui': path.join(packageDir, 'node_modules/@earendil-works/pi-tui/dist/index.js'),
  typebox: require.resolve('typebox'),
} });
const directory = path.dirname(fileURLToPath(import.meta.url));
const { SidekickRuntime } = await jiti.import(path.join(directory, '../src/sidekick-runtime.ts'));
const { SidekickViewer, readSidekickHistory } = await jiti.import(path.join(directory, '../src/sidekick-viewer.ts'));
const { registerFusionTools } = await jiti.import(path.join(directory, '../src/tools.ts'));
const fixture = path.join(root, 'provider.mjs');
const artifact = path.join(root, 'verified.txt');
const trace = path.join(root, 'requests.jsonl');
writeFileSync(fixture, `
import { AssistantMessageEventStream } from ${JSON.stringify(pathToFileURL(path.join(packageDir, 'node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js')).href)};
import { appendFileSync } from 'node:fs';
export default function (pi) {
  let calls = 0;
  pi.registerProvider('sidekick-process-fixture', {
    api: 'openai-completions', apiKey: 'test-only', baseUrl: 'http://127.0.0.1:9',
    models: [{ id: 'side', name: 'Process fixture', reasoning: false, input: ['text'], contextWindow: 32768, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context, options) {
      calls++;
      const n = calls;
      const stream = new AssistantMessageEventStream();
      const users = context.messages.filter(message => message.role === 'user').map(message => JSON.stringify(message.content));
      appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ n, users }) + '\\n');
      const stopping = users.at(-1)?.includes('stop-now');
      const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: [], stopReason: 'stop',
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      let timer;
      const abort = () => {
        clearTimeout(timer);
        message.stopReason = 'aborted'; message.errorMessage = 'fixture aborted';
        stream.push({ type: 'error', reason: 'aborted', error: message }); stream.end();
      };
      options?.signal?.addEventListener('abort', abort, { once: true });
      void (async () => {
        await options?.onPayload?.({ fixture: true }, model);
        await options?.onResponse?.({ status: 200, headers: {} }, model);
        if (options?.signal?.aborted) return abort();
        stream.push({ type: 'start', partial: message });
        if (n === 1 || stopping) {
          message.content = [{ type: 'text', text: 'working in the real child' }];
          stream.push({ type: 'text_delta', contentIndex: 0, delta: 'working in the real child', partial: message });
        }
        timer = setTimeout(() => {
          options?.signal?.removeEventListener('abort', abort);
          if (n === 2) {
            message.content = [{ type: 'toolCall', id: 'fixture-write', name: 'write', arguments: { path: ${JSON.stringify(artifact)}, content: 'human intervention applied\\n' } }];
            message.stopReason = 'toolUse';
          } else message.content = [{ type: 'text', text: n === 1 ? 'initial response' : 'human intervention verified' }];
          stream.push({ type: 'done', reason: message.stopReason, message }); stream.end();
        }, n === 1 || stopping ? 700 : 0);
      })();
      return stream;
    },
  });
}
`);
const waitFor = async (predicate, label) => {
  const deadline = Date.now() + 7000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};

await test('actual RPC child: live viewing, human steering, tool write, one completion, idle continuation and stop', { timeout: 15000 }, async () => {
  const runtime = new SidekickRuntime({ cwd: root, sessionFile: path.join(root, 'child.jsonl'), model: 'sidekick-process-fixture/side', thinking: 'off', systemPrompt: 'fixture',
    command: { command: process.execPath, args: [path.join(packageDir, 'dist/cli.js'), '--mode', 'rpc', '--session', path.join(root, 'child.jsonl'), '--model', 'sidekick-process-fixture/side', '--thinking', 'off', '--no-extensions', '-e', fixture, '--no-skills', '--no-context-files', '--no-prompt-templates', '--offline'] },
    promptTimeoutMs: 5000, shutdownGraceMs: 50 });
  const tools = new Map(), sent = [];
  const ctx = { hasUI: false, hasPendingMessages: () => false };
  const controls = registerFusionTools({ on() {}, registerTool(tool) { tools.set(tool.name, tool); }, registerMessageRenderer() {},
    sendMessage(message, options) { sent.push({ message, options }); } }, { getRuntime: () => runtime });
  let viewer;
  const observed = [];
  runtime.subscribe(event => observed.push({ type: event.type, delta: event.assistantMessageEvent?.type, content: event.message?.content }));
  try {
    await tools.get('sidekick').execute('call', { message: 'original brief', block: false }, undefined, undefined, ctx);
    await waitFor(() => {
      const report = runtime.latest()?.report;
      assert.ok(!report, `Child finished before streaming: ${JSON.stringify({ report, observed })}`);
      return runtime.progress()?.textTail.includes('working in the real child');
    }, 'child stream');
    const handoff = runtime.latest();
    viewer = new SidekickViewer({ runtime, name: 'real child', thinking: 'off', tui: { terminal: { rows: 40 }, requestRender() {} },
      theme: { fg: (_c, text) => text, bold: text => text }, done() {}, onSend: message => controls.sendToSidekick(ctx, message), onStop: () => runtime.abort() });
    assert.match(viewer.render(100).join('\n'), /working in the real child/);
    for (const input of ['\r', 'human direction: verify the artifact', '\r']) viewer.handleInput(input);
    assert.equal(runtime.latest().id, handoff.id);
    const report = await handoff.done;
    await waitFor(() => sent.length === 1, 'parent completion');
    assert.equal(report.status, 'completed', report.error);
    assert.match(report.text, /human intervention verified/);
    assert.equal(readFileSync(artifact, 'utf8'), 'human intervention applied\n');
    assert.match(viewer.render(100).join('\n'), /fixture-write|verified\.txt|human intervention verified/);
    const requests = readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(requests.length, 3);
    assert.match(JSON.stringify(requests[1].users), /human direction/);
    assert.ok(readSidekickHistory(runtime.sessionFile).some(message => message.role === 'toolResult' && message.toolName === 'write'));
    controls.sendToSidekick(ctx, 'idle follow-up');
    assert.equal((await runtime.latest().done).status, 'completed');
    await waitFor(() => sent.length === 2, 'idle completion');
    controls.sendToSidekick(ctx, 'stop-now');
    await waitFor(() => runtime.progress()?.textTail.includes('working in the real child'), 'stoppable response');
    viewer.handleInput('x'); viewer.handleInput('x');
    assert.equal((await runtime.latest().done).status, 'aborted');
    await waitFor(() => sent.length === 3, 'abort completion');
    viewer.close();
    assert.equal(runtime.isAlive(), true);
  } finally { viewer?.dispose(); runtime.kill(); }
});
