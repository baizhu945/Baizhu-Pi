// Typecheck patched upstream source against this machine's installed 1.0.3 dependencies.
// This is not the upstream/Nix full build; run.mjs validates actual runtime behavior separately.
import { cp, mkdir, mkdtemp, writeFile, symlink, chmod, readFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const here = dirname(fileURLToPath(import.meta.url));
const source = process.argv[2] ?? '/nix/store/ybsnz4v6fzl73dx2alwimf9518cry6ny-source';
const sdk = process.argv[3] ?? '/nix/store/y2vvpsg9c2rq0mrgmc1s6dq64376k8lp-pi-coding-agent-1.0.3/lib/node_modules/pi-monorepo';
const tsc = process.argv[4] ?? '/nix/store/cr53f8n3x4knbwcymv1hxmwam7a0sdql-typescript-7.0.2/bin/tsc';
await mkdir(join(here, '.runs'), { recursive: true });
const work = await mkdtemp(join(here, '.runs/source-check-'));
await cp(join(source, 'packages/coding-agent/src'), join(work, 'src'), { recursive: true });
await symlink(join(sdk, 'node_modules'), join(work, 'node_modules'));
// Write only the two patched source copies (original store files remain untouched).
for (const name of ['index', 'runtime']) {
  const target = join(work, `src/extensions/mcp/${name}.ts`);
  await chmod(target, 0o644);
  await writeFile(target, await readFile(join(here, `.generated/source-${name}.ts`)));
}
await writeFile(join(work, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
  target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true,
  skipLibCheck: true, noEmit: true, allowImportingTsExtensions: true,
  types: ['node'], typeRoots: [join(sdk, 'node_modules/@types')],
}, files: ['src/extensions/mcp/index.ts', 'src/extensions/mcp/runtime.ts'] }));
const result = spawnSync(tsc, ['-p', join(work, 'tsconfig.json')], { encoding: 'utf8' });
const patched = result.stdout + result.stderr;
await writeFile(join(work, 'patched-typecheck.log'), patched);
for (const name of ['index', 'runtime']) {
  await writeFile(join(work, `src/extensions/mcp/${name}.ts`),
    await readFile(join(source, `packages/coding-agent/src/extensions/mcp/${name}.ts`)));
}
const original = spawnSync(tsc, ['-p', join(work, 'tsconfig.json')], { encoding: 'utf8' });
const baseline = original.stdout + original.stderr;
await writeFile(join(work, 'baseline-typecheck.log'), baseline);
if (result.status === 0) console.log('PASS: strict source dependency-graph typecheck');
else if (patched === baseline && result.status === original.status) {
  console.log('PASS: no new source type diagnostics vs exact unpatched baseline.');
  console.log('Full source typecheck remains blocked by the installed SDK missing upstream dev declarations; see both logs.');
} else { console.log(patched); console.log('FAIL: source diagnostics differ from baseline.'); }
console.log(`Source-check workspace: ${work}`);
process.exitCode = result.status === 0 || (patched === baseline && result.status === original.status) ? 0 : 1;
