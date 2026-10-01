// No npm installer, transpiler download, credentials, or model calls required.
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const packageDir = process.argv[2];
assert(packageDir, 'Usage: node tests/run.mjs <Pi package directory>');
const directory = path.dirname(fileURLToPath(import.meta.url));
const selected = process.argv.slice(3);
const files = selected.length ? selected : readdirSync(directory).filter(name => name.endsWith('.test.ts')).sort();
let failed = false;
for (const file of files) {
  const outcome = spawnSync(process.execPath, [path.join(directory, 'test-file.mjs'), packageDir, path.join(directory, file)], {
    stdio: 'inherit',
    env: { ...process.env, PI_OFFLINE: '1', UNIPI_FUSION_CHILD: '', UNIPI_SUBAGENT_CHILD: '' },
  });
  if (outcome.status !== 0) failed = true;
}
if (!selected.length) {
  const outcome = spawnSync(process.execPath, [path.join(directory, 'neutrality.test.mjs'), packageDir], {
    stdio: 'inherit',
    env: { ...process.env, PI_OFFLINE: '1', UNIPI_FUSION_CHILD: '', UNIPI_SUBAGENT_CHILD: '' },
  });
  if (outcome.status !== 0) failed = true;
}
process.exitCode = failed ? 1 : 0;
