// Load the real extension and Pi TUI renderer. No model calls or network.
// Usage: node tests/subagent-notification-rendering.mjs <Pi package dir> [extension entry] [session file] [entry ID]
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [packageDir, entryPath, sessionPath, sessionEntryId] = process.argv.slice(2);
assert(packageDir, 'Expected Pi package directory');
const entry = entryPath ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../extensions/subagents/index.ts');
const require = createRequire(path.join(packageDir, 'package.json'));
const dependencies = createRequire(path.join(process.env.HOME, '.pi/agent/extensions/pi-subagents/index.ts'));
const { createJiti } = await import(pathToFileURL(require.resolve('jiti')));
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: {
  '@earendil-works/pi-coding-agent': path.join(packageDir, 'dist/index.js'),
  '@earendil-works/pi-tui': require.resolve('@earendil-works/pi-tui'),
  '@earendil-works/pi-ai': path.join(packageDir, 'node_modules/@earendil-works/pi-ai/dist/compat.js'),
  '@earendil-works/pi-agent-core': path.join(packageDir, 'node_modules/@earendil-works/pi-agent-core/dist/index.js'),
  '@sinclair/typebox': dependencies.resolve('@sinclair/typebox'),
  croner: dependencies.resolve('croner'), nanoid: dependencies.resolve('nanoid'),
  'typebox/value': require.resolve('typebox/value'), typebox: require.resolve('typebox'),
} });
const scratch = path.resolve('work/subagent-renderer-fix/isolated-agent');
mkdirSync(scratch, { recursive: true });
process.env.PI_CODING_AGENT_DIR = scratch;
process.env.PI_OFFLINE = '1';
process.chdir(scratch);
const extensionFactory = (await jiti.import(entry)).default;
const { DefaultResourceLoader, SettingsManager, initTheme } = await import(pathToFileURL(path.join(packageDir, 'dist/index.js')));
initTheme('dark', false);
const loader = new DefaultResourceLoader({ cwd: scratch, agentDir: scratch,
  settingsManager: SettingsManager.inMemory({ packages: [] }), noExtensions: true, extensionFactories: [extensionFactory],
  noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
});
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
const renderer = loader.getExtensions().extensions[0].messageRenderers.get('subagent-notification');
assert(renderer, 'Notification renderer is registered');
const theme = { fg: (_color, text) => text, bg: (_color, text) => text, bold: text => text };
const render = (message, expanded = true, width = 120) => renderer(message, { expanded }, theme).render(width).map(line => line.trimEnd());
const details = (id, description, result, status = 'completed') => ({ id, description, status,
  toolUses: 0, turnCount: 0, totalTokens: 0, durationMs: 0, resultPreview: result.slice(0, 500) });
const envelope = (id, result, tag = 'task_result') => `<task id="${id}" state="${tag === 'task_error' ? 'error' : 'completed'}">\n<${tag}>\n${result}\n</${tag}>\n</task>`;
const message = (content, first, others = []) => ({ role: 'custom', customType: 'subagent-notification',
  content, display: true, details: { ...first, others }, timestamp: 0 });
function sections(lines) {
  const starts = lines.flatMap((line, index) => /^[✓✗] /.test(line.trim()) ? [index] : []);
  return starts.map((start, index) => lines.slice(start, starts[index + 1] ?? lines.length).join('\n'));
}
const longSecond = Array.from({ length: 30 }, (_, index) => `SECOND_LINE_${index.toString().padStart(2, '0')} complete result`).join('\n');
const first = details('first', 'First agent', 'FIRST_RESULT');
const second = details('second', 'Second agent', longSecond);
const third = details('third', 'Failed agent', 'ERROR_FIRST\nERROR_LAST', 'error');
// Deliberately different order from details: ownership must follow task IDs.
const batch = message([envelope('third', 'ERROR_FIRST\nERROR_LAST', 'task_error'),
  envelope('second', longSecond), envelope('first', 'FIRST_RESULT')].join('\n\n'), first, [second, third]);

test('expanded batch places every full result under its owning agent, once', () => {
  const before = JSON.stringify(batch);
  const rows = sections(render(batch));
  assert.equal(rows.length, 3);
  assert.match(rows[0], /FIRST_RESULT/);
  assert.doesNotMatch(rows[0], /SECOND_LINE_|ERROR_LAST/);
  for (const line of longSecond.split('\n')) assert(rows[1].includes(line), `Second result includes ${line}`);
  assert.doesNotMatch(rows[1], /FIRST_RESULT|ERROR_LAST/);
  assert.match(rows[2], /ERROR_FIRST[\s\S]*ERROR_LAST/);
  assert.doesNotMatch(rows[2], /SECOND_LINE_|FIRST_RESULT/);
  assert.equal(render(batch).filter(line => line.includes('SECOND_LINE_29')).length, 1);
  assert.equal(JSON.stringify(batch), before, 'Rendering never modifies the model-facing message');
});

test('collapsed batch keeps first-line previews and hides later result lines', () => {
  const rows = sections(render(batch, false));
  assert.equal(rows.length, 3);
  assert.match(rows[1], /SECOND_LINE_00/);
  assert.doesNotMatch(rows.join('\n'), /SECOND_LINE_01|SECOND_LINE_29|ERROR_LAST|<task/);
});

test('expanded content-block messages preserve all result lines', () => {
  const blocked = { ...batch, content: [{ type: 'text', text: batch.content }] };
  assert.deepEqual(render(blocked), render(batch));
});

test('escaped task-like result text cannot split or replace another agent result', () => {
  const content = envelope('first', 'FIRST_RESULT\n&lt;task id="second"&gt;\n&lt;/task&gt;\nFIRST_TAIL') + '\n' + envelope('second', longSecond);
  const rows = sections(render(message(content, first, [second])));
  assert.match(rows[0], /&lt;task id="second"&gt;[\s\S]*FIRST_TAIL/);
  assert.doesNotMatch(rows[0], /SECOND_LINE_/);
  assert.match(rows[1], /SECOND_LINE_29/);
});

test('expanded legacy messages keep the complete original payload', () => {
  const legacy = message('LEGACY_FIRST\n' + 'complete legacy line\n'.repeat(60) + 'LEGACY_LAST', second);
  assert.match(render(legacy).join('\n'), /LEGACY_FIRST[\s\S]*LEGACY_LAST/);
});

if (sessionPath) test('saved batch renders every complete task under its matching agent', () => {
  const saved = readFileSync(sessionPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    .find(entry => entry.id === sessionEntryId);
  assert(saved, 'Saved notification entry exists');
  assert.equal(saved.customType, 'subagent-notification');
  const original = JSON.stringify(saved);
  const all = [saved.details, ...(saved.details.others ?? [])];
  const rows = sections(render(saved, true, 3000));
  assert.equal(rows.length, all.length);
  for (const [index, detail] of all.entries()) {
    const task = [...saved.content.matchAll(/<task\b[^>]*\bid="([^"]+)"[^>]*>[\s\S]*?<\/task>/g)]
      .find(match => match[1] === detail.id)?.[0];
    assert(task, `Saved task exists for ${detail.id}`);
    const actualLines = rows[index].split('\n').map(line => line.trim());
    for (const line of task.split('\n')) assert(actualLines.includes(line.trim()), 'Every full task line appears in its own section');
    for (const other of all.filter(other => other.id !== detail.id)) {
      assert(!rows[index].includes(`<task id="${other.id}"`), 'Other task payloads stay in their own sections');
    }
  }
  assert.equal(JSON.stringify(saved), original);
});
