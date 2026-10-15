import { cp, mkdir, mkdtemp, readFile, writeFile, chmod, symlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
if (!process.argv[2]) throw new Error('Usage: node tests/run.mjs <matching Pi SDK root> --built');
const sdk = resolve(process.argv[2]);
const { version } = JSON.parse(await readFile(join(sdk, 'package.json'), 'utf8'));
if (!process.argv.includes('--built') && version !== '1.0.3') {
  throw new Error(`Pi ${version}: the legacy dist patch only supports 1.0.3; use the source-patched SDK with --built`);
}
await mkdir(join(here, '.runs'), { recursive: true });
const work = await mkdtemp(join(here, '.runs/native-mcp-'));
const copy = join(work, 'sdk');
await mkdir(copy);
await cp(join(sdk, 'dist'), join(copy, 'dist'), { recursive: true });
await cp(join(sdk, 'package.json'), join(copy, 'package.json'));
await symlink(join(sdk, 'node_modules'), join(copy, 'node_modules'));
await chmod(join(copy, 'dist/extensions/mcp'), 0o755);
for (const name of ['index', 'runtime']) await chmod(join(copy, `dist/extensions/mcp/${name}.js`), 0o644);
if (!process.argv.includes('--built')) {
  const apply = spawnSync('patch', ['-p1', '-d', copy, '-i', join(root, 'native-mcp-hardening.patch')], { encoding: 'utf8' });
  if (apply.status !== 0) throw new Error(apply.stdout + apply.stderr);
} else {
  console.log(`Testing Pi ${version} compiled SDK; no dist patch applied.`);
}
// TEST-ONLY deferred lazy import; no hook is added to the production patch.
const lazy = join(copy, 'dist/extensions/mcp/runtime.lazy.js');
await chmod(lazy, 0o644);
const old = await readFile(lazy, 'utf8');
if (!old.includes('export const loadMcpRuntime = () => import("./runtime.js");')) throw new Error(`Unexpected Pi ${version} lazy module`);
await writeFile(lazy, old.replace('export const loadMcpRuntime = () => import("./runtime.js");',
  'export const loadMcpRuntime = async () => { const gate = globalThis[Symbol.for("rea-tests:lazy-gate")]; if (gate) { gate.enter(); await gate.wait; } return import("./runtime.js"); };'));
const result = spawnSync(process.execPath, ['--test', '--test-reporter=spec', '--test-concurrency=1', join(here, 'native-mcp.test.mjs')], {
  env: { ...process.env, PI_OFFLINE: '1', REA_TEST_SDK: copy, REA_TEST_WORK: work },
  encoding: 'utf8', timeout: 60000,
});
const output = (result.stdout ?? '') + (result.stderr ?? '');
await writeFile(join(here, 'latest-run.log'), output);
console.log(output);
console.log(`Regression workspace (all writes scoped): ${work}`);
process.exitCode = result.status ?? 1;
