// Real REA/Ghidra process budget regression, without a model or user artifact.
// Usage: node rea-ghidra-budget-live.mjs <REA executable> <mode config.json>
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
const exec = promisify(execFile);
const [executable, configPath] = process.argv.slice(2);
assert(executable && configPath);
const config = JSON.parse(await readFile(configPath, 'utf8'));
const runtime = join(dirname(dirname(resolve(executable))), 'lib/rea-agents');
const require = createRequire(join(runtime, 'package.json'));
const { Client } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/client')).href);
const { StdioClientTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/client/stdio')).href);
const root = await mkdtemp(join(tmpdir(), 'rea-ghidra-budget-live-'));
const source = join(root, 'fixture.c'), binary = join(root, 'fixture');
await writeFile(source, '__attribute__((noinline)) int budget_fixture(int x) { return x + 7; }\nint main(void) { return budget_fixture(1); }\n');
await exec('/run/current-system/sw/bin/gcc', ['-O0', '-g', '-fno-pie', '-no-pie', '-o', binary, source]);
const report = { root, executable, cases: [], paid_model_requests: 0 };
for (const budget of [100, 60000]) {
  const home = join(root, `home-${budget}`), tmp = join(home, 'tmp');
  await mkdir(tmp, { recursive: true });
  const transport = new StdioClientTransport({ command: executable, args: ['mcp'], stderr: 'pipe',
    env: { ...process.env, ...config.env, HOME: home, TMPDIR: tmp,
      XDG_CONFIG_HOME: join(home, 'config'), XDG_CACHE_HOME: join(home, 'cache'),
      REA_GHIDRA_STARTUP_TIMEOUT_MS: String(budget) } });
  const client = new Client({ name: 'ghidra-budget-live', version: '1' });
  transport.stderr?.on('data', () => {});
  try {
    await client.connect(transport, { timeout: 30000 });
    const call = (name, args = {}) => client.callTool({ name, arguments: args }, { timeout: 90000 });
    const opened = await call('open_binary', { path: binary });
    assert.notEqual(opened.isError, true);
    const start = Date.now();
    const result = await call('procedure_pseudo_code', { procedure: 'budget_fixture' });
    const data = result.structuredContent;
    if (budget === 100) {
      assert.equal(result.isError, true, 'patched short provider deadline must actually interrupt startup');
      assert.equal(data.error.code, 'provider_timeout');
      assert.equal(data.error.details.timeout_ms, budget);
      assert(Date.now() - start < 5000, 'short internal deadline accidentally fell back to 330s');
    } else {
      assert.notEqual(result.isError, true, JSON.stringify(data));
      assert.equal(data.evidence.provider.id, 'ghidra');
      assert(data.result.includes('7'));
    }
    report.cases.push({ budget_ms: budget, duration_ms: Date.now() - start, outcome: budget === 100 ? 'provider_timeout' : 'real-decompilation' });
    await call('close_binary');
    assert(!(await readdir(tmp)).some(name => name.startsWith('rea-ghidra-')), 'provider failed to remove owned runtime');
  } finally {
    await client.close();
    await transport.close();
  }
}
await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
console.log('PASS real provider deadline override, native default provider, decompilation and owned cleanup');
