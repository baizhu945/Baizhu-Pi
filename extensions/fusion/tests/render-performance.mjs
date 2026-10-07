// Real Ctrl+O/updateResult/render path; no terminal, model or network needed.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
const sdk = process.argv[2];
assert(sdk, 'Usage: node tests/render-performance.mjs <Pi package directory>');
const source = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(sdk, 'package.json'));
const { createJiti } = await import(pathToFileURL(require.resolve('jiti')));
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: {
  '@earendil-works/pi-coding-agent': join(sdk, 'dist/index.js'),
  '@earendil-works/pi-tui': join(sdk, 'node_modules/@earendil-works/pi-tui/dist/index.js'),
  typebox: require.resolve('typebox'),
}});
const { registerFusionTools } = await jiti.import(join(source, 'src/tools.ts'));
const { TRANSCRIPT_MAX_LINES } = await jiti.import(join(source, 'src/transcript.ts'));
const { ToolExecutionComponent } = await import(pathToFileURL(join(sdk, 'dist/modes/interactive/components/tool-execution.js')));
const { initTheme } = await import(pathToFileURL(join(sdk, 'dist/modes/interactive/theme/theme.js')));
initTheme('dark', false);
const tools = new Map();
registerFusionTools({ registerTool: tool => tools.set(tool.name, tool), registerMessageRenderer() {}, on() {} }, { getRuntime() {} });
const paragraph = 'Review **source** and `implementation` for correctness, performance and 中文显示. '.repeat(70);
for (const name of ['sidekick', 'read_subagent']) {
  const events = Array.from({ length: 300 }, (_, i) => i % 3 === 0
    ? { kind: 'tool', toolCallId: String(i), name: 'bash', args: { command: 'nix build' }, output: 'build output\n'.repeat(100), done: true, isError: false, startedAt: 0 }
    : { kind: 'text', text: `Step ${i}\n\n${paragraph}`, open: false });
  const progress = { toolCalls: 100, recentTools: [], textTail: '', startedAt: Date.now(), events, droppedEvents: 0 };
  const value = () => ({ content: [{ type: 'text', text: 'working' }], details: { progress } });
  const component = new ToolExecutionComponent(name, 'bench', { message: 'brief' }, {}, tools.get(name), { requestRender() {} }, '/tmp');
  component.updateResult(value(), true);
  component.setExpanded(true);
  const first = component.render(120);
  assert(first.length <= TRANSCRIPT_MAX_LINES + 2);
  assert(first.join('\n').includes('history'), 'large histories explicitly announce the preview limit');
  const start = performance.now();
  for (let i = 0; i < 30; i++) component.render(120);
  const idleMs = performance.now() - start;
  // Generous aggregate ceiling avoids noisy microbenchmark failures. The old
  // version takes about 20 seconds here, continuously blocking Pi's event loop.
  assert(idleMs < 500, `${name}: unchanged frames took ${idleMs.toFixed(1)}ms`);
  for (let i = 0; i < 5; i++) {
    progress.events.at(-1).text += `\nupdate-${i}`;
    component.updateResult(value(), true);
    const lines = component.render(120);
    assert(lines.length <= TRANSCRIPT_MAX_LINES + 2);
    assert(lines.join('\n').includes(`update-${i}`));
  }
  component.setExpanded(false);
  component.render(40);
  component.setExpanded(true);
  assert(component.render(120).join('\n').includes('update-4'));
  component.invalidate(); // Theme/resize invalidation may discard caches.
  assert(component.render(120).join('\n').includes('update-4'));
  component.updateResult({ content: [{ type: 'text', text: 'accepted report' }], details: {
    status: 'completed', text: 'accepted report', durationMs: 1000, toolCalls: 100, events,
  } }, false);
  assert(component.render(120).join('\n').includes('accepted report'));
  console.log(`PASS real SDK ${name} Ctrl+O: ${first.length} lines, 30 idle frames ${idleMs.toFixed(2)}ms; updates/toggles/invalidation/report intact`);
}
