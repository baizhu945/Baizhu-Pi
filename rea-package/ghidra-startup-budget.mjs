// Offline gate for upstream 6.1's native startup budget (no local source patch).
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [root] = process.argv.slice(2);
assert(root, 'usage: node ghidra-startup-budget.mjs <REA package runtime>');
const load = name => import(pathToFileURL(path.join(root, 'dist', name)).href);
const { parseConfig } = await load('config.js');
const { createGhidraProviderClient } = await load('ghidra/GhidraProviderClient.js');
const { DEFAULT_GHIDRA_STARTUP_TIMEOUT_MS } = await load('config/ghidraStartupTimeout.js');
const { GhidraClient } = await load('ghidra/GhidraClient.js');
const { ProviderStartupDeadline } = await load('process/ProviderDeadline.js');
const { silentLogger } = await load('logger.js');
assert.equal(DEFAULT_GHIDRA_STARTUP_TIMEOUT_MS, 330000);
const baseline = parseConfig({});
assert.equal(baseline.ok, true);
assert.equal(baseline.value.ghidraStartupTimeoutMs, 330000);
for (const value of ['1', '330000', '1800000', '2147483647', '1e6', ' 1800000 ', '01', '+1']) {
  const parsed = parseConfig({ REA_GHIDRA_STARTUP_TIMEOUT_MS: value });
  assert.equal(parsed.ok, true, value);
  assert.equal(parsed.value.ghidraStartupTimeoutMs, Number(value));
  const { ghidraStartupTimeoutMs: _, ...rest } = parsed.value;
  const { ghidraStartupTimeoutMs: __, ...expected } = baseline.value;
  assert.deepEqual(rest, expected, 'no unrelated config changes');
}
// Upstream deliberately defaults invalid/unset input rather than failing startup.
for (const value of ['', '0', '-1', '1.5', '2147483648', 'Infinity', 'not-a-number']) {
  const parsed = parseConfig({ REA_GHIDRA_STARTUP_TIMEOUT_MS: value });
  assert.equal(parsed.ok, true, value);
  assert.equal(parsed.value.ghidraStartupTimeoutMs, 330000, value);
}
const target = { kind: 'executable', format: 'elf', path: '/fixture/never-launched', sha256: 'a'.repeat(64), architecture: 'x86_64' };
const provider = { id: 'ghidra', name: 'Ghidra', version: '12.1.2' };
const profile = { provider, parameters: {}, digest: 'b'.repeat(64) };
const installation = { status: 'available', platform: 'linux', analyzeHeadlessPath: '/fixture/never-launched', providerVersion: provider.version };
for (const custom of [undefined, '1800000']) {
  const config = parseConfig(custom === undefined ? {} : { REA_GHIDRA_STARTUP_TIMEOUT_MS: custom }).value;
  let captured, launched = 0;
  const client = createGhidraProviderClient({ config, logger: silentLogger, target, profile, installation,
    clientFactory: options => {
      captured = options;
      return new GhidraClient({ ...options, launcher: { launch: () => { launched++; throw new Error('unexpected launch'); } } });
    },
  });
  assert(captured, 'actual production provider adapter must create client');
  assert.equal(captured.startupTimeoutMs, custom === undefined ? 330000 : Number(custom));
  const controller = new AbortController(); controller.abort();
  const result = await client.execute('health', {}, { signal: controller.signal });
  assert.equal(result.ok, false);
  assert.equal(result.error._tag, 'AnalysisCancelledError');
  assert.equal(launched, 0, 'long budget cannot swallow cancellation or launch a provider');
  await client.close();
}
const abort = new AbortController();
const deadline = new ProviderStartupDeadline(1800000, abort.signal);
assert(deadline.remainingMs() > 330000);
abort.abort('user cancellation');
assert.equal(deadline.interruption, 'cancelled');
assert.equal(await deadline.wait(1800000), 'aborted');
deadline.dispose();
console.log('PASS upstream Ghidra startup budget: default/fallback/timer bounds; config -> production client; real-client cancellation; no local patch');
