// Run with: node tests/session-picker.test.mjs <Pi package directory>
// Tests use Pi's actual extension loader and public TUI API; no model calls.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { test } from 'node:test';

const packageDir = process.argv[2];
assert(packageDir, 'Pass the Pi package directory containing dist/index.js');
const temp = mkdtempSync(path.join(os.tmpdir(), 'pi-session-picker-test-'));
process.env.PI_CODING_AGENT_DIR = path.join(temp, 'agent');
process.chdir(temp);
const sdk = await import(pathToFileURL(path.join(packageDir, 'dist/index.js')));
const tui = await import(pathToFileURL(path.join(packageDir, 'node_modules/@earendil-works/pi-tui/dist/index.js')));
const { KeybindingsManager } = await import(pathToFileURL(path.join(packageDir, 'dist/core/keybindings.js')));
const kb = new KeybindingsManager();
tui.setKeybindings(kb);
const theme = { fg: (_color, text) => text, bg: (_color, text) => text, bold: text => text };
const extension = process.argv[3] ?? fileURLToPath(new URL('../extensions/session-picker/index.ts', import.meta.url));
const loader = new sdk.DefaultResourceLoader({ cwd: temp, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager: sdk.SettingsManager.inMemory(), noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: [extension] });
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
const ext = loader.getExtensions().extensions[0];
assert.equal(ext.tools.size, 0);
assert.deepEqual([...ext.commands.keys()].sort(), ['resume-native', 'session-picker']);
const dir = path.join(temp, 'sessions');
mkdirSync(dir);
let Picker;
await ext.commands.get('session-picker').handler('', {
  mode: 'tui',
  sessionManager: { getCwd: () => temp, getSessionDir: () => dir, getSessionFile: () => undefined },
  ui: { async custom(factory) {
    const component = await factory({ requestRender() {} }, theme, kb, () => {});
    Picker = component.constructor;
    component.dispose();
    return undefined;
  } },
});
const flush = () => new Promise(resolve => setImmediate(resolve));
const RIGHT = '\x1b[C', LEFT = '\x1b[D', DOWN = '\x1b[B', UP = '\x1b[A';
const state = () => ({ scope: 'current', sort: 'threaded', named: false, showPath: false, query: '', expanded: new Set() });
const session = (id, parent, age = 0, extra = {}) => ({ path: path.join(dir, id + '.jsonl'), id, parentSessionPath: parent?.path, name: id, cwd: temp, created: new Date(0), modified: new Date(Date.now() - age * 60000), messageCount: 1, firstMessage: 'hello', allMessagesText: 'hello', ...extra });
const parent = session('Parent', undefined, 10);
const child = session('Needle child', parent, 2);
const grandchild = session('Grandchild', child, 1);
const sibling = session('Sibling', parent, 3);
const other = session('Other parent', undefined, 20);
const fixtures = [parent, child, grandchild, sibling, other];
const ids = picker => picker.getRows().map(row => row.node.session.id);
async function picker(sessions = fixtures, options = {}) {
  const s = options.state ?? state();
  const component = new Picker(s, options.loader ?? (async () => sessions), theme, kb, () => {}, options.done ?? (() => {}), options.currentPath);
  await flush();
  return { component, state: s };
}

await test('loads with no tools or prompt overhead; parents start folded', async () => {
  const { component } = await picker();
  assert.deepEqual(ids(component), ['Parent', 'Other parent']);
  assert.match(component.render(120).join('\n'), /▸ Parent/);
  assert.doesNotMatch(component.render(120).join('\n'), /Grandchild/);
  component.dispose();
});
await test('Right expands all descendants, retains parent; Left folds all', async () => {
  const { component, state: s } = await picker();
  component.handleInput(RIGHT);
  assert.deepEqual(ids(component), ['Parent', 'Needle child', 'Grandchild', 'Sibling', 'Other parent']);
  assert.equal(component.getSelectedPath(), parent.path);
  assert.match(component.render(120).join('\n'), /▾ Parent/);
  component.handleInput(RIGHT); // Idempotent
  component.handleInput(LEFT);
  assert.deepEqual(ids(component), ['Parent', 'Other parent']);
  assert.equal(s.expanded.size, 0);
  component.handleInput(LEFT);
  assert.equal(component.getSelectedPath(), parent.path);
  component.dispose();
});
await test('Left from a child folds its parent; leaf Right does not move selection', async () => {
  const { component } = await picker();
  component.handleInput(RIGHT);
  component.handleInput(DOWN);
  component.handleInput(DOWN);
  assert.equal(component.getSelectedPath(), grandchild.path);
  component.handleInput(RIGHT);
  assert.equal(component.getSelectedPath(), grandchild.path);
  component.handleInput(LEFT);
  assert.equal(component.getSelectedPath(), child.path);
  assert(!ids(component).includes('Grandchild'));
  component.handleInput(LEFT);
  assert.equal(component.getSelectedPath(), parent.path);
  assert.deepEqual(ids(component), ['Parent', 'Other parent']);
  component.dispose();
});
await test('each picker starts folded, even after an earlier picker expands', async () => {
  const first = await picker(); first.component.handleInput(RIGHT); first.component.dispose();
  const next = await picker(); assert.deepEqual(ids(next.component), ['Parent', 'Other parent']); next.component.dispose();
});
await test('search finds hidden child; arrows edit search, clear selects visible ancestor', async () => {
  const { component, state: s } = await picker();
  component.handleInput('"Needle child"');
  assert.deepEqual(ids(component), ['Needle child']);
  component.handleInput(LEFT); component.handleInput(RIGHT); component.handleInput(' ');
  assert.equal(s.query, '"Needle child" ');
  assert.equal(s.expanded.size, 0);
  component.handleInput('\x15'); // Ctrl+U, clear search
  assert.deepEqual(ids(component), ['Parent', 'Other parent']);
  assert.equal(component.getSelectedPath(), parent.path);
  component.dispose();
});
await test('phrase, regex, invalid regex and whitespace search', async () => {
  for (const [query, expected] of [['re:^.*Grandchild', ['Grandchild']], ['re:(', []], ['   ', ['Parent', 'Other parent']]]) {
    const s = state(); s.query = query;
    const { component } = await picker(fixtures, { state: s });
    assert.deepEqual(ids(component), expected);
    component.dispose();
  }
});
await test('sort modes reveal flat results and preserve fold state when returning to threaded', async () => {
  const { component, state: s } = await picker();
  component.handleInput('\x13'); assert.equal(s.sort, 'recent'); assert.equal(ids(component).length, 5);
  component.handleInput(RIGHT); assert.equal(s.expanded.size, 0);
  component.handleInput('\x13'); assert.equal(s.sort, 'fuzzy');
  component.handleInput('\x13'); assert.equal(s.sort, 'threaded'); assert.deepEqual(ids(component), ['Parent', 'Other parent']);
  component.dispose();
});
await test('named filtering and parentless children remain accessible', async () => {
  const unnamed = session('Unnamed', undefined, 10, { name: undefined });
  const namedChild = session('Named child', unnamed);
  const { component } = await picker([unnamed, namedChild]);
  component.handleInput('\x0e'); // Ctrl+N
  assert.deepEqual(ids(component), ['Named child']);
  component.dispose();
  const orphan = await picker([child]); assert.deepEqual(ids(orphan.component), ['Needle child']); orphan.component.dispose();
});
await test('progressive loads preserve expansion, selection and new children', async () => {
  let progress, resolve;
  const load = (_scope, cb) => { progress = cb; return new Promise(done => { resolve = done; }); };
  const { component } = await picker([], { loader: load });
  progress(2, 5, [parent, child]);
  component.handleInput(RIGHT); component.handleInput(DOWN);
  progress(5, 5, fixtures);
  assert.deepEqual(ids(component), ['Parent', 'Needle child', 'Grandchild', 'Sibling', 'Other parent']);
  assert.equal(component.getSelectedPath(), child.path);
  resolve(fixtures); await flush();
  component.dispose();
});
await test('count-only/invalid progress retains the last readonly snapshot during navigation', async () => {
  let progress, resolve;
  const { component } = await picker([], { loader: (_scope, cb) => { progress = cb; return new Promise(done => { resolve = done; }); } });
  const snapshot = Object.freeze([...fixtures]);
  progress(1, 134, snapshot);
  component.handleInput(RIGHT);
  const expected = ids(component);
  for (const partial of [undefined, null, 42, 'counts only', { loaded: 2 }]) {
    progress(2, 134, partial);
    for (const key of [DOWN, UP, '\x1b[6~', '\x1b[5~', '\x0e', '\x0e']) component.handleInput(key);
    assert.deepEqual(ids(component), expected);
    assert.match(component.render(120).join('\n'), /Loading 2\/134/);
  }
  resolve(fixtures); await flush();
  assert(!component.render(120).join('\n').includes('Loading'));
  // A delayed callback after completion must not replace the committed result.
  progress(135, 134, [session('Late stale result')]);
  assert.deepEqual(ids(component), expected);
  component.dispose();
});
await test('invalid final results are reported without corrupting the last valid view or cache', async () => {
  for (const bad of [undefined, null, {}, [{ ...parent, modified: null }]]) {
    let progress, resolve, signal;
    const { component } = await picker([], { loader: (_scope, cb, abort) => { progress = cb; signal = abort; return new Promise(done => { resolve = done; }); } });
    progress(1, 5, fixtures);
    resolve(bad); await flush();
    assert.match(component.render(120).join('\n'), /Load failed:/);
    assert.deepEqual(ids(component), ['Parent', 'Other parent']);
    assert(signal.aborted);
    for (const key of [DOWN, UP, RIGHT, LEFT, '\x0e', '\x0e']) component.handleInput(key);
    progress(5, 5, [session('Late after error')]);
    assert.deepEqual(ids(component), ['Parent', 'Other parent']);
    component.dispose();
  }
});
await test('a newly discovered parent hides the selected child and selects its ancestor', async () => {
  let progress;
  const { component } = await picker([], { loader: (_scope, cb) => { progress = cb; return new Promise(() => {}); } });
  progress(1, 2, [child]); component.handleInput(UP);
  progress(2, 2, [parent, child]);
  assert.deepEqual(ids(component), ['Parent']);
  assert.equal(component.getSelectedPath(), parent.path);
  component.dispose();
});
await test('scope switches reject stale updates, abort old reads and retain folds', async () => {
  const requests = [];
  const { component, state: s } = await picker([], { loader: (scope, progress, signal) => new Promise(resolve => requests.push({ scope, progress, signal, resolve })) });
  requests[0].resolve(fixtures); await flush();
  component.handleInput(RIGHT);
  component.handleInput('\t'); assert.equal(s.scope, 'all');
  component.handleInput('\t'); assert.equal(s.scope, 'current');
  assert(requests[1].signal.aborted);
  requests[1].progress(1, 1, [session('Stale')]); requests[1].resolve([session('Stale')]); await flush();
  assert(!ids(component).includes('Stale'));
  requests[2].resolve(fixtures); await flush();
  assert.equal(ids(component).length, 5);
  component.dispose();
});
await test('paging and render width use only visible rows', async () => {
  const many = Array.from({ length: 25 }, (_, i) => session('Task ' + i, parent, i));
  const { component } = await picker([parent, ...many, other]);
  assert.equal(ids(component).length, 2);
  component.handleInput(RIGHT);
  component.handleInput('\x1b[6~'); // PageDown
  assert.notEqual(component.getSelectedPath(), parent.path);
  for (const width of [1, 20, 40, 80, 120]) for (const line of component.render(width)) assert(tui.visibleWidth(line) <= width);
  component.handleInput('\x1b[5~'); assert.equal(component.getSelectedPath(), parent.path);
  component.handleInput(LEFT); assert.equal(ids(component).length, 2);
  component.dispose();
});
await test('Enter resumes the visible parent/child, Escape cancels, Ctrl+D protects active session', async () => {
  let choice;
  let result = await picker(fixtures, { done: value => { choice = value; }, currentPath: parent.path });
  result.component.handleInput('\x04'); assert.equal(choice, undefined);
  assert.match(result.component.render(120).join('\n'), /Cannot delete/);
  result.component.handleInput(RIGHT); result.component.handleInput(DOWN); result.component.handleInput('\r');
  assert.deepEqual(choice, { kind: 'resume', path: child.path, name: child.name });
  result = await picker(fixtures, { done: value => { choice = value; } });
  result.component.handleInput('\x1b'); assert.equal(choice, undefined);
});
await test('empty lists and cyclic metadata cannot trap selection or recurse forever', async () => {
  const { component } = await picker([]); component.handleInput(DOWN); component.handleInput(RIGHT); component.dispose();
  const a = session('Cycle A'); const b = session('Cycle B', a); a.parentSessionPath = b.path;
  const cyclic = await picker([a, b]); assert.equal(ids(cyclic.component).length, 2); cyclic.component.dispose();
});
await test('live focus routing survives later editor replacement and callback rewiring', async () => {
  class Editor {
    #text = '';
    onSubmit;
    getText() { return this.#text; }
    setText(text) { this.#text = text; }
    handleInput(data) { if (data === '\r') this.onSubmit?.(this.#text); }
    render() { return [this.#text]; }
    invalidate() {}
  }
  let editor = new Editor(), focused = editor, submitted, listener;
  let unsubscriptions = 0;
  const terminal = { getFocusedComponent: () => focused };
  const ctx = { mode: 'tui', ui: {
    setWidget(_key, factory) { factory?.(terminal, theme); },
    getEditorText: () => editor.getText(),
    onTerminalInput(handler) { listener = handler; return () => { unsubscriptions++; listener = undefined; }; },
    setEditorComponent() { assert.fail('Must not replace or reconstruct another extension editor'); },
  } };
  await ext.handlers.get('session_start')[0]({}, ctx);
  // Simulate pi-open-tui installing its editor AFTER our session_start handler.
  editor = new Editor(); focused = editor;
  editor.onSubmit = text => { submitted = text; };
  const submit = text => { editor.setText(text); assert.equal(listener('\r'), undefined); editor.handleInput('\r'); };
  submit(' /resume '); assert.equal(submitted, '/session-picker');
  assert.equal(editor.getText(), ' /resume ');
  const wrapped = editor.onSubmit;
  submit('/resume'); assert.equal(editor.onSubmit, wrapped);
  for (const text of ['/resume-native', '/resume more', 'please explain /resume', '/compact', 'multiline\n/resume']) {
    submit(text); assert.equal(submitted, text);
  }
  // Core reassigns the callback; use the fresh one, not a saved startup handler.
  editor.onSubmit = text => { submitted = 'fresh:' + text; };
  submit('/resume'); assert.equal(submitted, 'fresh:/session-picker');
  // A picker/dialog owns focus while the main buffer still contains /resume.
  focused = { render() { return []; }, invalidate() {}, handleInput() {} };
  const callback = editor.onSubmit;
  listener('\r'); assert.equal(editor.onSubmit, callback);
  focused = editor;
  await ext.handlers.get('session_start')[0]({}, ctx);
  assert.equal(unsubscriptions, 1);
  await ext.handlers.get('session_shutdown')[0]({}, ctx);
  assert.equal(unsubscriptions, 2); assert.equal(listener, undefined);
});
await test('real session files resume a child through the command context after closing the UI', { timeout: 5000 }, async () => {
  const parentPath = path.join(dir, 'integration-parent.jsonl');
  const childPath = path.join(dir, 'integration-child.jsonl');
  for (const [id, file, parentPathValue] of [['Integration parent', parentPath, undefined], ['Integration child', childPath, parentPath]]) {
    const timestamp = new Date().toISOString();
    const entries = [
      { type: 'session', version: sdk.CURRENT_SESSION_VERSION, id, timestamp, cwd: temp, parentSession: parentPathValue },
      { type: 'session_info', id: id + '-info', parentId: null, timestamp, name: id },
      { type: 'message', id: id + '-message', parentId: id + '-info', timestamp, message: { role: 'user', content: [{ type: 'text', text: 'integration fixture' }], timestamp: Date.now() } },
    ];
    writeFileSync(file, entries.map(value => JSON.stringify(value)).join('\n') + '\n');
  }
  let screenOpen = false, resumed;
  await ext.commands.get('session-picker').handler('', {
    mode: 'tui',
    sessionManager: { getCwd: () => temp, getSessionDir: () => dir, getSessionFile: () => parentPath },
    async switchSession(file) { assert.equal(screenOpen, false); resumed = file; return { cancelled: false }; },
    ui: {
      notify(text) { assert.fail(text); },
      custom(factory) {
        return new Promise(resolve => {
          let component, selected = false;
          screenOpen = true;
          const terminal = { requestRender() {
            if (!component?.getRows().some(row => row.node.children.length) || selected) return;
            selected = true;
            assert.deepEqual(ids(component), ['Integration parent']);
            component.handleInput(RIGHT); component.handleInput(DOWN); component.handleInput('\r');
          } };
          component = factory(terminal, theme, kb, choice => { component.dispose(); screenOpen = false; resolve(choice); });
        });
      },
    },
  });
  assert.equal(resumed, childPath);
});
await test('134 real JSONL sessions handle optional SDK progress and finish with every session', { timeout: 10000 }, async () => {
  const largeDir = path.join(temp, 'large-real-sessions'); mkdirSync(largeDir);
  const parentPath = path.join(largeDir, 'parent.jsonl');
  for (let i = 0; i < 134; i++) {
    const file = i === 0 ? parentPath : path.join(largeDir, `child-${String(i).padStart(3, '0')}.jsonl`);
    const name = i === 0 ? 'Large parent' : 'Large child ' + i;
    const timestamp = new Date().toISOString();
    const entries = [
      { type: 'session', version: sdk.CURRENT_SESSION_VERSION, id: 'large-' + i, timestamp, cwd: temp, ...(i ? { parentSession: parentPath } : {}) },
      { type: 'session_info', id: 'info-' + i, parentId: null, timestamp, name },
      { type: 'message', id: 'message-' + i, parentId: 'info-' + i, timestamp, message: { role: 'user', content: [{ type: 'text', text: 'Large directory fixture' }], timestamp: Date.now() } },
    ];
    writeFileSync(file, entries.map(value => JSON.stringify(value)).join('\n') + '\n');
  }
  let loaded, missingSnapshots = 0, count = 0, resolve;
  const complete = new Promise(done => { resolve = done; });
  const loader = async (scope, progress, signal) => {
    const report = (n, total, partial) => {
      if (partial === undefined) missingSnapshots++;
      count = n;
      progress(n, total, partial);
    };
    loaded = scope === 'current'
      ? await sdk.SessionManager.list(temp, largeDir, report, signal)
      : await sdk.SessionManager.listAll(largeDir, report, signal);
    resolve();
    return loaded;
  };
  const { component } = await picker([], { loader });
  await complete; await flush();
  assert(missingSnapshots > 100, 'SDK must exercise its count-only callback path');
  assert.equal(count, 134); assert.equal(loaded.length, 134);
  assert.deepEqual(ids(component), ['large-0']);
  assert(!/Loading|Load failed/.test(component.render(120).join('\n')));
  for (const key of [DOWN, UP, '\x1b[6~', '\x1b[5~']) component.handleInput(key);
  component.handleInput(RIGHT); assert.equal(ids(component).length, 134);
  for (const key of [DOWN, UP, '\x1b[6~', '\x1b[5~']) component.handleInput(key);
  component.handleInput(LEFT); assert.deepEqual(ids(component), ['large-0']);
  const allComplete = new Promise(done => { resolve = done; });
  component.handleInput('\t');
  await allComplete; await flush();
  assert.equal(loaded.length, 134);
  assert.deepEqual(ids(component), ['large-0']);
  assert(!component.render(120).join('\n').includes('Load failed'));
  component.dispose();
});
await test('canonical paths group symlink aliases and sorting uses descendant activity', async () => {
  const alias = path.join(temp, 'sessions-alias'); symlinkSync(dir, alias);
  const original = session('integration-parent', undefined, 20, { path: path.join(dir, 'integration-parent.jsonl') });
  const linkedChild = session('Aliased child', original, 0, { parentSessionPath: path.join(alias, 'integration-parent.jsonl') });
  const moreRecentParent = session('Standalone', undefined, 10);
  const { component } = await picker([moreRecentParent, original, linkedChild]);
  assert.deepEqual(ids(component), ['integration-parent', 'Standalone']);
  component.handleInput(RIGHT); assert.deepEqual(ids(component), ['integration-parent', 'Aliased child', 'Standalone']);
  component.dispose();
});
await test('real theme with CJK, emoji and combining characters stays within terminal width', async () => {
  sdk.initTheme('dark', false);
  const actualTheme = (await import(pathToFileURL(path.join(packageDir, 'dist/modes/interactive/theme/theme.js')))).theme;
  const component = new Picker(state(), async () => [session('中文 👨‍💻 e\u0301 '.repeat(10))], actualTheme, kb, () => {}, () => {});
  await flush();
  for (const width of [1, 20, 40, 80, 120]) for (const line of component.render(width)) assert(tui.visibleWidth(line) <= width);
  component.dispose();
});
await test('non-terminal modes do not install editors or open a custom screen', async () => {
  const notifications = [];
  const ctx = { mode: 'rpc', ui: { notify: text => notifications.push(text), custom() { assert.fail('custom UI in RPC'); }, setEditorComponent() { assert.fail('editor in RPC'); } } };
  await ext.handlers.get('session_start')[0]({}, ctx);
  await ext.commands.get('session-picker').handler('', ctx);
  await ext.commands.get('resume-native').handler('', ctx);
  assert.equal(notifications.length, 2);
});
if (process.argv[4]) {
  await test('actual user directory: readonly loading, navigation, scope switching and complete root counts', { timeout: 30000 }, async () => {
    const actualDir = process.argv[4];
    const actualCwd = process.argv[5] ?? '/home/baizhu945';
    const key = file => { try { return realpathSync(file); } catch { return path.resolve(file); } };
    let finish, loaded, countsOnly = 0;
    const load = async (scope, progress, signal) => {
      const report = (n, total, partial) => { if (!partial) countsOnly++; progress(n, total, partial); };
      loaded = scope === 'current'
        ? await sdk.SessionManager.list(actualCwd, actualDir, report, signal)
        : await sdk.SessionManager.listAll(actualDir, report, signal);
      finish();
      return loaded;
    };
    let complete = new Promise(resolve => { finish = resolve; });
    const { component } = await picker([], { loader: load });
    await complete; await flush();
    const rootCount = () => {
      const paths = new Set(loaded.map(session => key(session.path)));
      return loaded.filter(session => !session.parentSessionPath || !paths.has(key(session.parentSessionPath))).length;
    };
    assert(loaded.length > 10); assert(countsOnly > 0);
    assert.equal(component.getRows().length, rootCount());
    assert(!/Loading|Load failed/.test(component.render(120).join('\n')));
    for (let i = 0; i < 10; i++) for (const data of [DOWN, UP, '\x1b[6~', '\x1b[5~', RIGHT, LEFT]) component.handleInput(data);
    assert.equal(component.getRows().length, rootCount());
    complete = new Promise(resolve => { finish = resolve; });
    component.handleInput('\t'); await complete; await flush();
    assert.equal(component.getRows().length, rootCount());
    assert(!/Loading|Load failed/.test(component.render(120).join('\n')));
    component.handleInput('re:this-query-is-deliberately-impossible-8ae72fa0');
    assert.equal(component.getRows().length, 0);
    component.handleInput('\x15');
    assert.equal(component.getRows().length, rootCount());
    console.log(JSON.stringify({ actualDirectorySessions: loaded.length, collapsedRoots: rootCount(), countsOnlyUpdates: countsOnly, readonly: true }));
    component.dispose();
  });
}
console.log('Folded-picker regression test run completed; no model calls.');
