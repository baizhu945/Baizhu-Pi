// Optional local integration: use the actual installed OpenTuiEditor class.
// No Pi session, terminal, network, user credentials or model calls are used.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [packageDir, subagentsDir, openTuiDir, fusionEntry] = process.argv.slice(2);
assert(packageDir && subagentsDir && openTuiDir, 'Expected Pi package, local subagents and pi-open-tui directories');
const require = createRequire(path.join(packageDir, 'package.json'));
const { createJiti } = await import(pathToFileURL(require.resolve('jiti')));
const alias = {
  '@earendil-works/pi-coding-agent': path.join(packageDir, 'dist/index.js'),
  '@earendil-works/pi-tui': path.join(packageDir, 'node_modules/@earendil-works/pi-tui/dist/index.js'),
  '@earendil-works/pi-ai': path.join(packageDir, 'node_modules/@earendil-works/pi-ai/dist/compat.js'),
  '@earendil-works/pi-agent-core': path.join(packageDir, 'node_modules/@earendil-works/pi-agent-core/dist/index.js'),
  typebox: require.resolve('typebox'),
};
const jiti = createJiti(import.meta.url, { moduleCache: false, alias });
const { CombinedAutocompleteProvider } = await import(pathToFileURL(alias['@earendil-works/pi-tui']));
const { createModelBoostProvider } = await jiti.import(fusionEntry ?? fileURLToPath(new URL('../src/index.ts', import.meta.url)));
const { createMentionProvider } = await jiti.import(path.join(subagentsDir, 'src/ui/agent-mention.ts'));
const { OpenTuiEditor } = await jiti.import(path.join(openTuiDir, 'extensions/open-tui/editor.ts'));
const id = text => text;
const editorTheme = {
  borderColor: id,
  selectList: { selectedPrefix: id, selectedText: id, description: id, scrollInfo: id, noMatch: id },
};
const tick = () => new Promise(resolve => setImmediate(resolve));
const commands = [{ name: 'model' }, { name: 'unipi:model' }, { name: 'resume' }, { name: 'resume-native' }];
function providers(order) {
  const base = new CombinedAutocompleteProvider(commands, '/tmp', null);
  const mention = current => createMentionProvider(current, () => [
    { kind: 'type', handle: 'explore', type: 'Explore', description: 'Explore the codebase' },
  ], () => true);
  return order === 'fusion-inside'
    ? mention(createModelBoostProvider(base))
    : createModelBoostProvider(mention(base));
}
for (const order of ['fusion-inside', 'fusion-outside']) {
  for (const [text, expected] of [['/res', '/resume'], ['/unipi:mo', '/unipi:model'], ['@ex', '@explore']]) {
    for (const accept of ['\t', '\r']) {
      await test(`actual OpenTuiEditor ${order}: ${text} + ${accept === '\t' ? 'Tab' : 'Enter'}`, async () => {
        const submitted = [];
        const tui = {
          requestRender() {}, terminal: { rows: 24, columns: 100, write() { assert.fail('Unexpected terminal write'); } },
        };
        const editor = new OpenTuiEditor(tui, editorTheme, { matches: () => false });
        editor.setAutocompleteProvider(providers(order));
        editor.onSubmit = value => submitted.push(value);
        editor.setText(text);
        editor.handleInput('\t');
        await tick();
        // A single @ candidate is accepted automatically by the first Tab.
        if (editor.isShowingAutocomplete()) {
          assert.doesNotThrow(() => editor.handleInput(accept));
        }
        assert.equal(editor.isShowingAutocomplete(), false);
        if (accept === '\r' && text.startsWith('/')) {
          assert.deepEqual(submitted, [expected]);
        } else {
          assert.equal(editor.getText(), expected + ' ');
          assert.deepEqual(submitted, []);
        }
      });
    }
  }
}
