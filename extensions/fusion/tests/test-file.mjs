// Load one upstream TypeScript test file using the same host modules as Pi.
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [packageDir, testFile] = process.argv.slice(2);
assert(packageDir && testFile, 'Expected Pi package directory and test file');
const require = createRequire(path.join(packageDir, 'package.json'));
const { createJiti } = await import(pathToFileURL(require.resolve('jiti')));
const alias = {
  '@earendil-works/pi-coding-agent': path.join(packageDir, 'dist/index.js'),
  '@earendil-works/pi-tui': path.join(packageDir, 'node_modules/@earendil-works/pi-tui/dist/index.js'),
  '@earendil-works/pi-agent-core': path.join(packageDir, 'node_modules/@earendil-works/pi-agent-core/dist/index.js'),
  '@earendil-works/pi-ai': path.join(packageDir, 'node_modules/@earendil-works/pi-ai/dist/compat.js'),
  typebox: require.resolve('typebox'),
  '@fusion-test/subagents-mention': path.join(
    process.env.PI_FUSION_TEST_SUBAGENTS_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../subagents'),
    'src/ui/agent-mention.ts',
  ),
};
const jiti = createJiti(import.meta.url, { moduleCache: false, alias });
await jiti.import(testFile);
