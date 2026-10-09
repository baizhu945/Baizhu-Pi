#!/usr/bin/env node
/** Real installed-REA acceptance, not a mock, setup command, or 138-tool execution claim.
 * Usage: node rea-live.mjs /absolute/bin/rea /absolute/ghidra /absolute/java [browser]
 * REA_LIVE_INSTALL_DIR: explicit rea-agents package root if a Nix wrapper hides it.
 * REA_LIVE_SOURCE_DIR: source tree containing scripts/fixtures/managed/pe.mjs.
 * stdout is a JSON report; progress goes to stderr. Redirect stdout to retain it.
 * --self-test only checks generated fixture logic (no server/provider claims).
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { access, lstat, mkdir, mkdtemp, readFile, readlink, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';

const execute = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const shaFile = async path => hash(await readFile(path));
const pause = ms => new Promise(r => setTimeout(r, ms));
const exists = async path => { try { await access(path); return true; } catch { return false; } };
const SOURCE = process.env.REA_LIVE_SOURCE_DIR ?? '/tmp/rea-source-analysis-2bf3663';
const runDeadline = Date.now() + 500_000; // leave ~100s for cleanup inside a 600s outer Nix gate
const boundedTimeout = requested => { const remaining = runDeadline - Date.now(); assert.ok(remaining > 0, '500-second live-verification budget exhausted'); return Math.min(requested, remaining); };
const EXPECTED_TOOLS = `address_name address_to_file_offset analyze_function analyze_javascript_application analyze_swift_types analyze_web_bundle annotate_native_function batch_decompile binary_overview binary_session build_call_path build_reconstruction_obligation_ledger capture_browser_scenario capture_electron_scenario capture_native_ui_scenario capture_process_scenario capture_web_screenshot close_binary comment compare_application_versions compare_artifacts compare_bundles compare_functions compare_javascript_export_shapes compare_managed_members compare_process_captures compare_source_to_bundle compare_web_captures compare_web_screenshots correlate_static_and_runtime current_address current_document current_procedure decode_interface_builder demangle_swift discover_webmcp_tools evaluate_reconstruction_coverage export_evidence_bundle export_web_scripts extract_artifact extract_firmware find_changed_behavior find_xrefs_to_name get_call_graph get_evidence_bundle get_navigation_context get_objc_classes get_objc_protocols goto_address import_evidence_bundle import_managed_reconstruction inline_comment inspect_address_context inspect_android_class inspect_android_method inspect_android_package inspect_artifact inspect_asset_catalog inspect_binary_layout inspect_evm_interface inspect_recorded_crash inspect_electron_page inspect_firmware_regions inspect_keyed_archive inspect_macho inspect_managed_artifact inspect_managed_members inspect_managed_native_boundaries inspect_native_api inspect_native_data_type inspect_native_dispatch_metadata inspect_native_instruction inspect_native_load_image inspect_plist inspect_signature inspect_web_event_listeners inspect_web_network_capture inspect_web_page list_architectures list_bookmarks list_browser_targets list_documents list_electron_targets list_javascript_runtime_targets list_names list_procedures list_segments list_strings list_unknowns next_address observe_javascript_runtime observe_native_calls observe_native_ui observe_web_execution observe_web_session open_binary prev_address procedure_address procedure_assembly procedure_callees procedure_callers procedure_info procedure_pseudo_code procedure_references project_android_application_graph project_apple_application_graph project_managed_application_graph read_bytes read_function_instructions reconcile_javascript_runtime record_unknown recover_javascript_sources resolve_containing_procedure resolve_native_call_targets search_android_classes search_procedures search_strings set_address_name set_addresses_names set_bookmark set_comment set_inline_comment trace_android_references trace_application_feature trace_call_path trace_dylib_resolution trace_feature trace_javascript_semantics trace_native_ui_action trace_native_values trace_web_module_imports trace_web_source_location unset_bookmark update_unknown verify_managed_native_boundaries verify_reconstruction verify_unknown_resolution xrefs`.split(' ').sort();
const EXPECTED_PROMPTS = ['investigate_feature', 'compare_application_versions', 'verify_reconstruction', 'trace_crash', 'audit_residual_unknowns', 'prepare_bounded_process_capture'].sort();
assert.equal(EXPECTED_TOOLS.length, 138);
assert.equal(new Set(EXPECTED_TOOLS).size, 138);

const report = {
  schema: 'rea-live-acceptance/1', started_at: new Date().toISOString(),
  mode: process.argv.includes('--self-test') ? 'pure-fixture-only' : 'real-installed-mcp',
  passed: [], unsupported: [], failed: [], calls: [], artifact_identities: [],
  provider_profiles: [], cleanup: {},
  coverage_statement: '138 exact advertised tool names and 6 prompt names; only calls explicitly recorded below are executed. No paid model, setup, or client configuration.',
};
class Unsupported extends Error {}
async function check(name, fn) {
  process.stderr.write(`[rea-live] ${name}\n`);
  const started = Date.now();
  try {
    if (name !== 'owned-resource-and-original-SHA-cleanup') boundedTimeout(1);
    const details = await fn(); report.passed.push({ name, elapsed_ms: Date.now() - started, details });
  }
  catch (e) {
    const dest = e instanceof Unsupported ? report.unsupported : report.failed;
    dest.push({ name, elapsed_ms: Date.now() - started, error: e.stack ?? String(e) });
    process.stderr.write(`[rea-live] ${e instanceof Unsupported ? 'unsupported' : 'FAILED'}: ${name}: ${e.message}\n`);
  }
}
let root, env, client, transport, ajv;
let schemas = new Map();
const owned = new Set();
const trackedFiles = new Map();
async function track(path, role) {
  const sha256 = await shaFile(path);
  trackedFiles.set(path, sha256);
  report.artifact_identities.push({ path, role, sha256, bytes: (await stat(path)).size });
  return sha256;
}
async function command(executable, args, timeout = 60_000) {
  return execute(executable, args, { env, cwd: root, timeout: boundedTimeout(timeout), maxBuffer: 16 * 1024 * 1024 });
}
// Respect this machine's deletion wrapper. Never delete an unowned path.
async function removeOwned(path) {
  assert.ok(path === root || path.startsWith(`${root}/`), `refusing unowned deletion: ${path}`);
  await execute('remove-without-permission', ['-rf', '--', path], { timeout: 30_000 });
}
const NONCE_KEY = 'PI_REA_LIVE_CHILD_NONCE';
// Read stat twice around environ: a PID alone, process name, or group is not ownership.
async function procIdentity(pid, nonce, profile = null, previouslyOwned = new Map()) {
  try {
    const parse = text => {
      const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/);
      return { pid: Number(pid), start_ticks: fields[19], state: fields[0], parent_pid: Number(fields[1]), process_group: Number(fields[2]), session: Number(fields[3]) };
    };
    const first = parse(await readFile(`/proc/${pid}/stat`, 'utf8'));
    const environment = await readFile(`/proc/${pid}/environ`);
    const commandLine = (await readFile(`/proc/${pid}/cmdline`)).toString();
    const second = parse(await readFile(`/proc/${pid}/stat`, 'utf8'));
    if (first.start_ticks !== second.start_ticks) return null;
    const envMatch = environment.toString().split('\0').includes(`${NONCE_KEY}=${nonce}`);
    // Chromium overwrites the environment region when setting its process title.
    // Its explicit private profile carries the SAME assigned nonce and survives
    // in renderer/utility command lines, including detached descendants.
    const privateProfile = profile && profile.startsWith(`${root}/`) && profile.endsWith(nonce);
    const escaped = profile?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const profileMatch = privateProfile && new RegExp(`(?:^|[\\0 ])--user-data-dir=${escaped}(?:[\\0 ]|$)`).test(commandLine);
    const historyMatch = previouslyOwned.has(`${second.pid}:${second.start_ticks}`);
    if (!envMatch && !profileMatch && !historyMatch) return null;
    return { ...second, ownership_authority: envMatch ? 'child-only-env-nonce' : profileMatch ? 'same-nonce-private-profile-argument' : 'previous-nonce-authentication-same-start-ticks' };
  } catch (e) {
    if (['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(e.code)) return null;
    throw e;
  }
}
async function nonceProcesses(child) {
  const found = [];
  for (const name of await readdir('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const identity = await procIdentity(name, child.ownerNonce, child.privateProfile, child.identities);
    if (identity) { found.push(identity); child.identities.set(`${identity.pid}:${identity.start_ticks}`, identity); }
  }
  return found;
}
function spawnOwned(executable, args, ownerNonce = randomUUID(), privateProfile = null) {
  // This variable exists ONLY in this child's environment, not REA's or the user's.
  const child = spawn(executable, args, { env: { ...env, [NONCE_KEY]: ownerNonce }, cwd: root, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  child.ownerNonce = ownerNonce;
  child.privateProfile = privateProfile;
  child.identities = new Map();
  child.log = '';
  child.stderr.on('data', c => { child.log = (child.log + c.toString()).slice(-64 * 1024); });
  child.on('error', e => { child.spawnError = e; });
  child.done = new Promise(r => child.once('close', r));
  owned.add(child);
  child.sample = () => {
    if (!child.sampling) child.sampling = nonceProcesses(child).catch(e => { child.observationError = e; }).finally(() => { child.sampling = null; });
  };
  child.sample();
  child.sampler = setInterval(child.sample, 200);
  child.sampler.unref();
  return child;
}
async function signalOwned(child, identity, signal) {
  const current = await procIdentity(identity.pid, child.ownerNonce, child.privateProfile, child.identities);
  if (!current || current.start_ticks !== identity.start_ticks || current.state === 'Z') return;
  try { process.kill(current.pid, signal); }
  catch (e) { if (e.code !== 'ESRCH') throw e; }
}
async function stopOwned(child) {
  if (!child || !owned.has(child)) return;
  clearInterval(child.sampler);
  await child.sampling;
  const signals = [];
  if (child.gracefulClose && child.exitCode === null && child.signalCode === null) {
    try { await child.gracefulClose(); await Promise.race([child.done, pause(2000)]); child.gracefulCloseOutcome = 'requested-on-owned-CDP'; }
    catch (e) { child.gracefulCloseOutcome = `CDP close unavailable: ${e.message}`; }
  }
  const first = await nonceProcesses(child);
  for (const identity of first) { await signalOwned(child, identity, 'SIGTERM'); signals.push({ ...identity, signal: 'SIGTERM' }); }
  let live;
  const deadline = Date.now() + 12_000;
  do {
    await pause(100);
    live = (await nonceProcesses(child)).filter(p => p.state !== 'Z');
    if (Date.now() > deadline - 9000) for (const identity of live) {
      await signalOwned(child, identity, 'SIGKILL'); signals.push({ ...identity, signal: 'SIGKILL' });
    }
  } while (live.length && Date.now() < deadline);
  // Also check previously authenticated identities whose environ disappeared on exit.
  const lingering = [], terminatedZombies = [];
  for (const identity of child.identities.values()) {
    try {
      const text = await readFile(`/proc/${identity.pid}/stat`, 'utf8');
      const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/);
      if (fields[19] === identity.start_ticks) {
        if (fields[0] === 'Z') terminatedZombies.push(identity);
        else lingering.push(identity);
      }
    } catch (e) { if (!['ENOENT', 'ESRCH'].includes(e.code)) throw e; }
  }
  child.cleanupProof = { owner_nonce: child.ownerNonce, nonce_assigned_only_to_child_environment: true, private_profile: child.privateProfile, graceful_close: child.gracefulCloseOutcome, identities: [...child.identities.values()], signals, remaining_nonce_live_processes: live, remaining_previously_owned_live_identities: lingering, terminated_zombie_identities: terminatedZombies };
  assert.equal(live.length + lingering.length, 0, 'owned browser descendants remain alive; refusing socket/profile deletion');
  await Promise.race([child.done, pause(3000)]);
  assert.ok(child.exitCode !== null || child.signalCode !== null || child.spawnError, 'owned launcher has not ended');
  owned.delete(child);
  if (child.observationError) throw child.observationError;
}
async function installedRoot(executable) {
  const candidates = [];
  if (process.env.REA_LIVE_INSTALL_DIR) candidates.push(resolve(process.env.REA_LIVE_INSTALL_DIR));
  for (const file of [executable, await realpath(executable)]) {
    let p = dirname(file);
    for (let i = 0; i < 5; i++, p = dirname(p)) {
      candidates.push(p, join(p, 'lib/node_modules/rea-agents'), join(p, 'node_modules/rea-agents'));
    }
    // Nix makeWrapper scripts point at the original executable in another store path.
    const text = (await readFile(file)).subarray(0, 64 * 1024).toString();
    for (const match of text.matchAll(/\/nix\/store\/[^\s"']+(?:\/scripts\/rea\.mjs|\/bin\/(?:rea|\.rea-wrapped))/g)) {
      let p = dirname(match[0]);
      candidates.push(dirname(p), join(dirname(p), 'lib/node_modules/rea-agents'));
    }
  }
  for (const p of candidates) {
    try { if (JSON.parse(await readFile(join(p, 'package.json'), 'utf8')).name === 'rea-agents') return await realpath(p); }
    catch {}
  }
  throw new Error('Cannot find installed rea-agents package; set REA_LIVE_INSTALL_DIR (must contain its own node_modules).');
}
async function call(name, args = {}, { timeout = 180_000, allowError = false } = {}) {
  const started = Date.now();
  const contract = schemas.get(name);
  assert.ok(contract, `unadvertised tool ${name}`);
  const validate = ajv.compile(contract.inputSchema);
  assert.ok(validate(args), `${name} request schema: ${ajv.errorsText(validate.errors)}`);
  const entry = { name, arguments: args, outcome: 'requested' };
  report.calls.push(entry);
  let response;
  try {
    response = await client.callTool({ name, arguments: args }, { timeout: name === 'close_binary' ? 30_000 : boundedTimeout(timeout) });
    entry.is_error = response.isError === true;
    entry.outcome = response.isError ? 'tool-error' : 'responded';
  } catch (e) { entry.outcome = 'transport-error'; entry.error = e.message; throw e; }
  finally { entry.elapsed_ms = Date.now() - started; }
  if (response.isError === true) {
    entry.error = response.structuredContent ?? response.content;
    if (allowError) return response;
    throw new Error(`${name}: ${JSON.stringify(entry.error).slice(0, 6000)}`);
  }
  const out = response.structuredContent;
  assert.ok(out, `${name} omitted structuredContent`);
  if (contract.outputSchema) {
    const validateOutput = ajv.compile(contract.outputSchema);
    assert.ok(validateOutput(out), `${name} output schema: ${ajv.errorsText(validateOutput.errors)}`);
  }
  if (out.evidence) {
    const { parseEvidence } = await import(pathToFileURL(join(report.install_root, 'dist/domain/evidence.js')));
    const evidence = parseEvidence(out.evidence); // authenticate digest, not merely look for an ID
    assert.deepEqual(evidence.normalized_result, out.result);
    entry.evidence_id = evidence.evidence_id;
    entry.provider = evidence.provider;
    report.provider_profiles.push({ tool: name, evidence_id: evidence.evidence_id, provider: evidence.provider, analysis_profile: evidence.analysis_profile ?? null, subject: evidence.subject });
  }
  return out;
}
async function fixtureFiles(path, files) {
  await mkdir(path, { recursive: true });
  for (const [relative, contents] of Object.entries(files)) {
    const full = join(path, relative);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, contents);
    await track(full, 'locally-generated-fixture-source');
  }
}
const C_SOURCE = `#include <stdio.h>
__attribute__((noinline)) int rea_live_leaf(int x) { return x * 3 + 7; }
__attribute__((noinline)) int rea_live_entry(int x) {
  puts("REA_LIVE_LOCAL_C");
  if (x > 3) return rea_live_leaf(x); else return rea_live_leaf(x + 1) + 2;
}
int main(int argc, char **argv) { return rea_live_entry(argc) == 13 ? 0 : 1; }
`;
const jsFiles = (variant = 1) => ({
  'package.json': JSON.stringify({ name: 'rea-live-local-electron', version: '1.0.0', main: 'main.cjs' }),
  'main.cjs': `const { BrowserWindow, ipcMain } = require('electron');
const path = require('path');
ipcMain.handle('rea-live:echo', (_event, value) => ({ value }));
const window = new BrowserWindow({webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false}});
window.loadFile('index.html');\n`,
  'preload.cjs': `const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('reaLive', { echo: (value) => ipcRenderer.invoke('rea-live:echo', value) });\n`,
  'parser.mjs': `export function parseValue(value) { return { kind: 'record', version: ${variant}, value }; }\n`,
  'renderer.mjs': `import { parseValue } from './parser.mjs';
const literalSeed = 'local-only';
function carry(value) { return value; }
const message = carry(literalSeed);
const parsed = parseValue(message);
window.reaLive.echo(parsed);\n`,
  'index.html': '<!doctype html><title>REA local fixture</title><script type="module" src="renderer.mjs"></script>',
});
async function managedFixture() {
  const generator = join(SOURCE, 'scripts/fixtures/managed/pe.mjs');
  await track(generator, 'public-source-managed-PE-generator');
  const { buildManagedPeFixture } = await import(pathToFileURL(generator));
  const bytes = buildManagedPeFixture({
    // ECMA-335 tiny header: code size 1 (0x06), then actual ret (0x2a).
    methods: [{ name: 'Main', flags: 0x0016, body: Buffer.from([0x06, 0x2a]) }, { name: 'NativeMessageBox', flags: 0x2016, rva: 0 }],
    pinvoke: { moduleName: 'user32.dll', importName: 'MessageBoxW', mappingFlags: 0x0345, memberRow: 2 },
  });
  assert.equal(bytes.subarray(0, 2).toString(), 'MZ');
  const path = join(root, 'managed-fixture.exe');
  await writeFile(path, bytes);
  await track(path, 'locally-generated-managed-byte-fixture-never-executed');
  return path;
}
async function catalog() {
  const tools = [];
  let cursor;
  do { const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: 20_000 }); tools.push(...page.tools); cursor = page.nextCursor; } while (cursor);
  assert.deepEqual(tools.map(t => t.name).sort(), EXPECTED_TOOLS);
  schemas = new Map(tools.map(t => [t.name, t]));
  for (const tool of tools) {
    assert.ok(tool.inputSchema, `${tool.name} missing inputSchema`);
    assert.ok(tool.outputSchema, `${tool.name} missing outputSchema`);
    for (const kind of ['inputSchema', 'outputSchema']) {
      assert.ok(ajv.validateSchema(tool[kind]), `${tool.name}.${kind}: ${ajv.errorsText(ajv.errors)}`);
      ajv.compile(tool[kind]);
    }
  }
  const prompts = [];
  cursor = undefined;
  do { const page = await client.listPrompts(cursor ? { cursor } : undefined, { timeout: 20_000 }); prompts.push(...page.prompts); cursor = page.nextCursor; } while (cursor);
  assert.deepEqual(prompts.map(p => p.name).sort(), EXPECTED_PROMPTS);
  // Rendering is local prompt construction, not inference/model invocation.
  for (const prompt of prompts) {
    const args = Object.fromEntries((prompt.arguments ?? []).filter(a => a.required).map(a => [a.name, a.name.includes('path') ? join(root, 'local-fixture') : 'rea-live local fixture']));
    const result = await client.getPrompt({ name: prompt.name, arguments: args }, { timeout: 20_000 });
    assert.ok(result.messages?.some(m => m.content.type === 'text' && m.content.text.length > 0), `${prompt.name} did not render`);
  }
  report.catalog_counts = { exact_tool_names: tools.length, exact_prompt_names: prompts.length, advertised_schemas_validated: tools.length * 2, rendered_prompts: prompts.length };
  return { tools: EXPECTED_TOOLS, prompts: EXPECTED_PROMPTS, schemas: tools.length * 2, rendered_prompts: prompts.length };
}
async function targetFree() {
  const session = (await call('binary_session')).result;
  assert.ok(Array.isArray(session.tool_availability));
  assert.deepEqual(session.tool_availability.map(t => t.name).sort(), EXPECTED_TOOLS);
  assert.equal(session.tool_availability.find(t => t.name === 'current_document')?.reason, 'target_required');
  await call('get_evidence_bundle');
  await call('list_unknowns');
  const bound = await call('current_document', {}, { allowError: true });
  assert.equal(bound.isError, true, 'target-bound tool unexpectedly ran without a target');
  report.initial_session = session;
  return { successful_tools: ['binary_session', 'get_evidence_bundle', 'list_unknowns'], target_required_rejection: true };
}
async function javascript() {
  const leftPath = join(root, 'js-left'), rightPath = join(root, 'js-right');
  await fixtureFiles(leftPath, jsFiles(1));
  await fixtureFiles(rightPath, jsFiles(2));
  const left = await call('analyze_javascript_application', { input_path: leftPath, format: 'directory' });
  const right = await call('analyze_javascript_application', { input_path: rightPath, format: 'directory' });
  const result = left.result;
  assert.equal(result.format, 'directory');
  assert.equal(left.evidence.subject?.digest.sha256, result.root_artifact_sha256);
  assert.ok(result.graph.nodes.length > 0 && result.graph.edges.length > 0);
  assert.ok(result.semantic_graph.nodes.length > 0 && result.semantic_graph.relations.length > 0);
  assert.equal(result.semantic_graph.application_graph_id, result.graph.graph_id);
  assert.equal(result.semantic_graph.root_artifact_sha256, result.root_artifact_sha256);
  assert.equal(result.statistics.parse_failures, 0);
  assert.equal(result.statistics.truncated_scopes, 0);
  assert.ok(result.summary.browser_windows >= 1);
  assert.ok(result.summary.context_bridge_apis >= 1);
  assert.ok(result.summary.ipc.main_handlers >= 1);
  assert.ok(result.summary.ipc.renderer_transmissions >= 1);
  assert.ok(result.summary.ipc.paired_renderer_transmissions >= 1, 'expected IPC pairing');
  assert.ok(JSON.stringify(result.graph).includes('rea-live:echo'));
  const traced = await call('trace_javascript_semantics', {
    application: { kind: 'retained-evidence', evidence_id: left.evidence.evidence_id },
    query: { seed: { kind: 'literal', value: 'local-only' }, direction: 'forward-influence' },
  });
  report.semantic_trace_diagnostics = traced.result;
  const seedNodes = traced.result.nodes.filter(n => traced.result.seed_node_ids.includes(n.node_id));
  assert.ok(seedNodes.some(n => n.kind === 'literal' && n.properties.value === 'local-only'), 'exact semantic literal not recovered');
  assert.ok(traced.result.nodes.some(n => n.kind === 'binding' && n.label === 'literalSeed'), 'literal initializer did not define its binding');
  assert.ok(traced.result.nodes.some(n => n.kind === 'parameter' && n.label === 'value'), 'direct call argument did not reach carry parameter');
  assert.ok(traced.result.nodes.some(n => n.kind === 'binding' && n.label === 'message'), 'return did not flow to message binding');
  for (const relation of ['defines', 'argument-to-parameter', 'returns-to-call']) assert.ok(traced.result.relations.some(r => r.relation === relation), `semantic flow lacks ${relation}`);
  assert.ok(traced.evidence.evidence_links.includes(left.evidence.evidence_id));
  const compared = await call('compare_javascript_export_shapes', {
    left: { kind: 'retained-evidence', evidence_id: left.evidence.evidence_id },
    right: { kind: 'retained-evidence', evidence_id: right.evidence.evidence_id },
    left_module_path: 'parser.mjs', right_module_path: 'parser.mjs', left_export_name: 'parseValue', right_export_name: 'parseValue',
  });
  assert.ok(compared.result.summary.changed >= 1, 'static return version delta not detected');
  assert.ok(JSON.stringify(compared.result.changes).includes('/version'), 'expected version JSON pointer');
  return { graph_id: result.graph.graph_id, semantic_graph_id: result.semantic_graph.graph_id, ipc: result.summary.ipc, semantic_trace: traced.result, export_comparison: compared.result, limitations: result.limitations };
}
async function managed() {
  const path = await managedFixture();
  const artifact = await call('inspect_managed_artifact', { path });
  const members = await call('inspect_managed_members', { path });
  const boundaries = await call('inspect_managed_native_boundaries', { path });
  assert.equal(artifact.result.classification.status, 'managed');
  assert.equal(artifact.evidence.provider.id, 'rea-dotnet-static');
  assert.equal(members.result.methods.length, 2);
  const main = members.result.methods.find(m => m.name === 'Main');
  assert.ok(main && main.body.status === 'present');
  assert.equal(main.body.truncated_instructions, 0);
  assert.match(main.body.normalized_il_sha256, /^[a-f0-9]{64}$/);
  // The actual production schema is an opcode-name map, not an array. The earlier
  // generator default [0x2a] was a tiny HEADER for ten nops, not a ret instruction.
  assert.equal(main.body.il_size, 1);
  assert.equal(main.body.instruction_count, 1);
  assert.equal(main.body.decoded_instruction_count, 1);
  assert.deepEqual(main.body.opcode_counts, { ret: 1 });
  assert.equal(main.body.il_sha256, hash(Buffer.from([0x2a])), 'CIL bytes do not match source-owned ret');
  assert.equal(boundaries.result.pinvoke_imports.length, 1);
  assert.equal(boundaries.result.pinvoke_imports[0].verification, 'managed-declaration-only');
  assert.ok(JSON.stringify(boundaries.result.pinvoke_imports).includes('MessageBoxW'));
  for (const out of [artifact, members, boundaries]) assert.equal(out.result.artifact.sha256, await shaFile(path));
  return { artifact: artifact.result.artifact, classification: artifact.result.classification, CIL: main.body, pinvoke: boundaries.result.pinvoke_imports, limitations: boundaries.result.limitations };
}
async function nativeFixtures() {
  const source = join(root, 'native.c');
  await writeFile(source, C_SOURCE);
  await track(source, 'local-C-source');
  const compiler = process.env.REA_CC ?? '/run/current-system/sw/bin/gcc';
  const files = { debug: join(root, 'native-debug'), stripped: join(root, 'native-stripped') };
  for (const [variant, path] of Object.entries(files)) {
    await command(compiler, ['-O0', '-g', '-fno-inline', '-fno-pie', '-no-pie', ...(variant === 'stripped' ? ['-s'] : []), source, '-o', path]);
    await track(path, `gcc-${variant}-ELF`);
  }
  // nm is an independent oracle: use the debug symbol address to test stripped analysis.
  const { stdout } = await command('nm', ['--defined-only', files.debug]);
  const address = stdout.match(/^([a-f0-9]+)\s+T\s+rea_live_entry$/m)?.[1];
  assert.ok(address, 'nm did not recover the local entry symbol');
  return { ...files, entry: `0x${BigInt(`0x${address}`).toString(16)}`, compiler };
}
async function ghidra(path, procedure, variant) {
  const scratch = join(root, 'tmp');
  const baseline = (await readdir(scratch)).sort();
  const before = await shaFile(path);
  let opened = false;
  try {
    await call('open_binary', { path, provider_id: 'ghidra' });
    opened = true;
    const session = (await call('binary_session')).result;
    assert.equal(session.analysis_provider_binding?.provider?.id, 'ghidra');
    report.provider_profiles.push({ variant, session });
    // This is the first deep query: launch and analyze, not a doctor/probe claim.
    const dossier = await call('analyze_function', { procedure });
    const d = dossier.result;
    assert.equal(dossier.evidence.subject?.digest.sha256, before, 'Ghidra evidence subject SHA does not identify original fixture');
    assert.equal(dossier.evidence.provider.id, 'ghidra');
    assert.ok(dossier.evidence.analysis_profile, 'Ghidra evidence lacks committed analysis profile');
    assert.ok(d.procedure?.address);
    assert.ok(!JSON.stringify(d.comments).includes('REA_LIVE_SESSION_ONLY_'), 'annotation unexpectedly persisted across provider close');
    assert.ok(d.assembly?.length > 0, 'no real disassembly');
    assert.ok(typeof d.pseudocode === 'string' && d.pseudocode.trim().length > 0, 'no real decompilation');
    assert.ok(d.callees?.length > 0, 'local entry calls not recovered');
    assert.ok(d.basic_blocks?.length > 1, 'branch CFG not recovered');
    if (variant === 'debug') assert.ok(d.callees.some(c => JSON.stringify(c).includes('rea_live_leaf')));
    const args = { procedure: d.procedure.address };
    const assembly = await call('procedure_assembly', args);
    const pseudo = await call('procedure_pseudo_code', args);
    const callees = await call('procedure_callees', args);
    const callers = await call('procedure_callers', args);
    assert.ok(assembly.result?.length > 0);
    assert.ok(typeof pseudo.result === 'string' && pseudo.result.length > 0);
    assert.ok(callees.result?.length > 0 && callers.result?.length > 0);
    const bytes = (await call('read_bytes', { address: d.procedure.address, length: 16 })).result;
    const offset = (await call('address_to_file_offset', { address: d.procedure.address })).result;
    assert.equal(bytes.complete, true);
    assert.equal(bytes.returned_bytes, 16);
    assert.equal(bytes.bytes_hex, (await readFile(path)).subarray(offset.file_offset, offset.file_offset + 16).toString('hex'), 'bridge bytes do not match independent file offset');
    const comment = `REA_LIVE_SESSION_ONLY_${variant}`;
    const annotation = await call('annotate_native_function', { procedure: d.procedure.address, comment });
    assert.equal(annotation.result.annotations.comment, comment, 'session comment round trip failed');
    assert.deepEqual(annotation.result.effects, { scope: 'session-analysis-database', source_bytes_modified: false, persists_after_close: false });
    assert.ok(JSON.stringify(annotation.result.dossier.comments).includes(comment), 'refreshed dossier omitted session annotation');
    assert.equal(await shaFile(path), before, 'annotation mutated original binary');
    const during = (await readdir(scratch)).filter(p => !baseline.includes(p));
    assert.ok(during.some(p => p.startsWith('rea-ghidra-')), 'no real owned Ghidra runtime observed');
    return { variant, procedure: d.procedure, bytes: bytes.bytes_hex, offset: offset.file_offset, runtime_roots_observed: during, assembly_count: d.assembly.length, cfg_blocks: d.basic_blocks.length, limitations: d.limitations, evidence_id: dossier.evidence?.evidence_id };
  } finally {
    if (opened) await call('close_binary');
    assert.equal(await shaFile(path), before, 'original binary changed');
    assert.deepEqual((await readdir(scratch)).sort(), baseline, 'provider runtime leaked after close (checked before harness cleanup)');
    report.cleanup[`ghidra_${variant}`] = { original_sha256_unchanged: before, runtime_baseline_restored: true };
  }
}
async function processCapture() {
  // Availability is NOT execution: call the actual PTY tool with a local node command.
  const response = await call('capture_process_scenario', {
    executable: process.execPath, arguments: ['-e', 'console.log("REA_LIVE_PTY_EXECUTED"); setTimeout(() => process.exit(0), 120);'],
    working_directory: root, timeout_ms: 5000, idle_timeout_ms: 5000, settle_ms: 150,
  }, { timeout: 20_000, allowError: true });
  if (response.isError) {
    const error = response.structuredContent?.error;
    if (/node-pty.*(?:unavailable|missing|not installed|cannot find module|failed to load)|(?:unavailable|missing|not installed|cannot find module|failed to load).*node-pty|pty.*(?:unavailable|missing|not installed)/i.test(JSON.stringify(error))) throw new Unsupported(`PTY backend unavailable: ${JSON.stringify(error)}`);
    throw new Error(`real process capture failed: ${JSON.stringify(response)}`);
  }
  const c = response.result;
  assert.equal(c.manifest.pty_backend, 'node-pty');
  assert.equal(c.exit.reason, 'exited');
  assert.equal(c.exit.code, 0);
  assert.ok(JSON.stringify(c.raw_chunks ?? c).includes('REA_LIVE_PTY_EXECUTED'), 'no observed command output');
  assert.equal(c.cleanup.owned_process_group, 'verified');
  assert.equal(c.cleanup.temporary_root, 'removed');
  return { manifest: c.manifest, exit: c.exit, settlement: c.settlement, cleanup: c.cleanup, residual_unknowns: c.residual_unknowns };
}
async function browser(executable) {
  const scratch = join(root, 'tmp');
  const baseline = (await readdir(scratch)).sort();
  const socketProofs = [];
  const tmpLifecycle = { before_passive_spawn: baseline };
  // Associate the newly created socket directory with THIS nonce-authenticated
  // browser's private profile. A name prefix or creation timestamp alone is not proof.
  async function observeSockets(child, profile) {
    const after = (await readdir(scratch)).sort();
    tmpLifecycle.after_passive_start_before_REA_calls = after;
    const newNames = after.filter(name => !baseline.includes(name));
    const processes = (await nonceProcesses(child)).filter(p => p.state !== 'Z');
    assert.ok(processes.length > 0, 'browser ownership nonce not observed');
    let socketLink;
    try { socketLink = await readlink(join(profile, 'SingletonSocket')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const socketPath = socketLink ? resolve(profile, socketLink) : null;
    for (const name of newNames.filter(n => n.startsWith('org.chromium.'))) {
      const path = join(scratch, name);
      assert.equal(dirname(socketPath ?? ''), path, 'new Chrome directory is not linked from owned profile; cannot classify or remove it');
      const directory = await lstat(path);
      const socket = await lstat(socketPath);
      assert.ok(directory.isDirectory() && !directory.isSymbolicLink());
      assert.ok(socket.isSocket(), 'SingletonSocket link does not point to a UNIX socket');
      assert.equal(directory.uid, process.getuid());
      socketProofs.push({ path, directory_dev: directory.dev, directory_ino: directory.ino, socket_path: socketPath, socket_dev: socket.dev, socket_ino: socket.ino, profile_link: join(profile, 'SingletonSocket'), observed_owned_processes: processes });
    }
  }
  const browserNonce = randomUUID();
  const profile = join(root, `browser-profile-${browserNonce}`);
  await mkdir(profile);
  const script = 'const reaSourceMarker = "REA_LIVE_BROWSER_SCRIPT"; document.querySelector("#run").addEventListener("click", () => { document.querySelector("#done").textContent = "REA_LIVE_CLICK_OBSERVED"; });';
  const html = '<!doctype html><title>REA localhost-only</title><button id="run">Run local</button><div id="done">Waiting</div><script src="/app.js"></script>';
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; img-src 'self'; script-src 'self'; style-src 'self'");
    if (req.url === '/app.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(script); }
    else if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end(html); }
    else { res.statusCode = 404; res.end('local-only fixture'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  let child;
  try {
    child = spawnOwned(executable, [
      '--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
      `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
      '--disable-background-networking', '--disable-component-update', '--disable-sync',
      '--disable-dev-shm-usage', '--metrics-recording-only', '--disable-breakpad',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
      '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=127.0.0.1;localhost',
      ...(process.env.REA_BROWSER_NO_SANDBOX === 'true' ? ['--no-sandbox'] : []), `${origin}/`,
    ], browserNonce, profile);
    let port;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (child.spawnError) throw child.spawnError;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`owned browser exited: ${child.log}`);
      try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); if (port > 0) break; } catch {}
      await pause(100);
    }
    assert.ok(port > 0, `no owned browser CDP endpoint: ${child.log}`);
    await observeSockets(child, profile);
    const endpoint = `http://127.0.0.1:${port}`;
    child.gracefulClose = async () => {
      const identity = await procIdentity(child.pid, child.ownerNonce, child.privateProfile, child.identities);
      assert.ok(identity && identity.state !== 'Z', 'owned launcher identity missing before CDP close');
      const version = await (await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(2000) })).json();
      const url = new URL(version.webSocketDebuggerUrl);
      assert.equal(url.hostname, '127.0.0.1'); assert.equal(Number(url.port), port);
      const socket = new WebSocket(url);
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('owned CDP close timeout')), 2000);
          socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
          socket.onmessage = () => { clearTimeout(timer); resolve(); };
          socket.onclose = () => { clearTimeout(timer); resolve(); };
          socket.onerror = () => { clearTimeout(timer); reject(new Error('owned CDP close error')); };
        });
      } finally { socket.close(); }
    };
    let target;
    for (let attempt = 0; attempt < 30; attempt++) {
      const targets = (await call('list_browser_targets', { cdp_endpoint: endpoint, allowed_origins: [origin] }, { timeout: 5000 })).result;
      target = targets.targets.find(t => t.url === `${origin}/`);
      if (target) break;
      await pause(100);
    }
    assert.ok(target, 'owned local page was not discovered');
    const scope = { cdp_endpoint: endpoint, target_id: target.target_id, allowed_origins: [origin] };
    const observed = await call('inspect_web_page', { ...scope, observation_ms: 200, include_script_sources: true, include_accessibility_text: true });
    assert.equal(observed.result.target.url, `${origin}/`);
    const captured = observed.result.scripts.items.find(s => s.source.included && s.source.artifact.text.includes('REA_LIVE_BROWSER_SCRIPT'));
    assert.ok(captured, 'CDP did not capture actual local JavaScript source');
    assert.ok(captured.source.artifact.text.includes('reaSourceMarker'));
    const screenshot = (await call('capture_web_screenshot', scope)).result;
    const bytes = Buffer.from(screenshot.artifact.data_base64, 'base64');
    assert.ok(bytes.length > 8 && screenshot.viewport.width > 0 && screenshot.viewport.height > 0);
    assert.equal(hash(bytes), screenshot.artifact.sha256);
    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    const same = (await call('compare_web_screenshots', { before: screenshot.artifact, after: screenshot.artifact })).result;
    assert.equal(same.status, 'identical');
    assert.equal(same.changed_pixels, 0);
    const active = (await call('capture_browser_scenario', {
      browser: { mode: 'connect', cdp_endpoint: endpoint, target_id: target.target_id },
      start_url: { url: `${origin}/` },
      actions: [
        { step_id: 'ready', action: 'wait_for', locator: { kind: 'role', role: 'button', name: 'Run local' }, state: 'visible' },
        { step_id: 'click', action: 'click', locator: { kind: 'role', role: 'button', name: 'Run local' } },
      ],
      capture: { at_end: ['dom', 'accessibility', 'url'], after_each_step: [], events: ['console', 'page-errors', 'network'] },
    }, { timeout: 45_000 })).result;
    assert.ok(active.steps.length === 3 && active.steps.every(s => s.status === 'completed'), 'active steps did not execute');
    assert.ok(JSON.stringify(active.steps.at(-1).artifacts).includes('REA_LIVE_CLICK_OBSERVED'), 'no observed click effect in captured DOM/AX');
    assert.equal(active.browser.process_ownership, 'external'); // external to REA, owned by this harness
    assert.equal(active.browser.cleanup, 'disconnected-external');
    assert.ok(requests.includes('/app.js'), 'local script was never fetched');
    report.artifact_identities.push({ role: 'local-http-script', url: `${origin}/app.js`, sha256: hash(script), captured_source_sha256: hash(captured.source.artifact.text) });
    return { origin, endpoint, target: target.target_id, screenshot_sha256: screenshot.artifact.sha256, active_steps: active.steps.map(s => ({ step_id: s.step_id, status: s.status })), local_requests: requests, limitations: active.limitations };
  } finally {
    // The localhost server must close even when process ownership cannot be proved.
    try { await stopOwned(child); }
    finally {
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      report.cleanup.browser = { process_identity_proof: child?.cleanupProof, harness_owned_socket_directories: socketProofs, tmp_lifecycle: tmpLifecycle };
    }
    tmpLifecycle.after_owned_process_exit = (await readdir(scratch)).sort();
    for (const proof of socketProofs) {
      if (await exists(proof.path)) {
        const current = await lstat(proof.path);
        assert.equal(current.dev, proof.directory_dev);
        assert.equal(current.ino, proof.directory_ino, 'socket directory identity changed; refusing deletion');
        assert.ok(current.isDirectory() && !current.isSymbolicLink());
        // Browser has ended; remove only the exact socket directory proved above.
        await removeOwned(proof.path);
        proof.cleanup = 'removed-after-nonce-owned-processes-ended';
      } else proof.cleanup = 'already-removed-by-browser';
      assert.equal(await exists(proof.path), false);
    }
    await removeOwned(profile);
    assert.equal(await exists(profile), false);
    tmpLifecycle.after_harness_socket_cleanup = (await readdir(scratch)).sort();
    report.cleanup.browser = { own_process_only: true, process_identity_proof: child?.cleanupProof, temporary_profile_removed: true, harness_owned_socket_directories: socketProofs, tmp_lifecycle: tmpLifecycle };
    // No allowance for unexplained REA roots or additional Chrome directories.
    assert.deepEqual(tmpLifecycle.after_harness_socket_cleanup, baseline, 'tmp baseline not restored after explicitly owned browser cleanup');
  }
}
async function evidenceBundle() {
  const before = (await call('get_evidence_bundle')).result;
  assert.ok(before.records.length > 0);
  const path = join(root, 'evidence.json');
  await call('export_evidence_bundle', { path });
  const disk = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(disk, before);
  await call('import_evidence_bundle', { path });
  const after = (await call('get_evidence_bundle')).result;
  for (const record of before.records) assert.deepEqual(after.records.find(r => r.evidence_id === record.evidence_id), record);
  return { sha256: await shaFile(path), record_count: before.records.length, authenticated_evidence_ids: before.records.map(r => r.evidence_id) };
}
async function initialize(executable, ghidraDir, javaHome) {
  for (const path of [executable, ghidraDir, javaHome]) { assert.ok(path && isAbsolute(path), 'Supply absolute reaExecutable, ghidraInstallDir, javaHome'); await access(path); }
  report.install_root = await installedRoot(executable);
  const require = createRequire(join(report.install_root, 'package.json'));
  const pkg = JSON.parse(await readFile(join(report.install_root, 'package.json'), 'utf8'));
  report.package = { name: pkg.name, version: pkg.version, path: report.install_root };
  const clientPath = require.resolve('@modelcontextprotocol/client');
  let p = dirname(clientPath), clientPkg;
  while (p !== dirname(p)) {
    try { const pkg = JSON.parse(await readFile(join(p, 'package.json'), 'utf8')); if (pkg.name === '@modelcontextprotocol/client') { clientPkg = pkg; break; } } catch {}
    p = dirname(p);
  }
  assert.equal(clientPkg?.version, '2.3.1', 'must use installed REA client 2.3.1, never legacy sdk');
  // Assert the dependency lives in this install closure, not an ambient SDK.
  const installedClientRoot = await realpath(join(report.install_root, 'node_modules/@modelcontextprotocol/client'));
  assert.ok((await realpath(clientPath)).startsWith(`${installedClientRoot}/`), `client was not resolved from installed REA's own dependency: ${clientPath}`);
  report.mcp_client = { version: clientPkg.version, module_path: clientPath };
  const { Client } = await import(pathToFileURL(clientPath));
  const { StdioClientTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/client/stdio')));
  const { Ajv2020 } = await import(pathToFileURL(require.resolve('ajv/dist/2020.js')));
  ajv = new Ajv2020({ strict: false, validateFormats: false });
  await track(executable, 'real-REA-executable-or-wrapper');
  await track(join(report.install_root, 'package.json'), 'installed-package-metadata');
  await track(join(javaHome, 'bin/java'), 'selected-Java-runtime');
  report.engine_configuration = { ghidra_install_dir: ghidraDir, java_home: javaHome };
  env.GHIDRA_INSTALL_DIR = ghidraDir;
  env.JAVA_HOME = javaHome;
  env.REA_ANALYSIS_PROVIDER = 'ghidra';
  env.REA_LOG_LEVEL = 'warn';
  transport = new StdioClientTransport({ command: executable, args: ['mcp'], env, stderr: 'pipe' });
  report.server_stderr_tail = '';
  transport.stderr?.on('data', chunk => { report.server_stderr_tail = (report.server_stderr_tail + chunk.toString()).slice(-64 * 1024); });
  client = new Client({ name: 'rea-live-owned-acceptance', version: '1.0.0' });
  await client.connect(transport, { timeout: 30_000 });
  report.server_version = client.getServerVersion();
}
async function main() {
  root = await mkdtemp(join(tmpdir(), 'rea-live-owned-'));
  report.temporary_root = root;
  for (const dir of ['home', 'tmp', 'cache', 'config', 'data']) await mkdir(join(root, dir));
  env = Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === 'string'));
  // Isolate all state and ignore caller's REA/provider configuration; no setup.
  for (const key of Object.keys(env)) if (/^(REA_|HOPPER_|GHIDRA_|JAVA_TOOL_OPTIONS$|_JAVA_OPTIONS$|JDK_JAVA_OPTIONS$)/.test(key)) delete env[key];
  Object.assign(env, { HOME: join(root, 'home'), TMPDIR: join(root, 'tmp'), TMP: join(root, 'tmp'), TEMP: join(root, 'tmp'), XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'), XDG_DATA_HOME: join(root, 'data') });
  try {
    if (report.mode === 'pure-fixture-only') {
      await check('pure-fixture-generation-only', async () => {
        await fixtureFiles(join(root, 'js-left'), jsFiles());
        const managed = await managedFixture();
        assert.ok((await stat(managed)).size > 512);
        const native = await nativeFixtures();
        assert.notEqual(await shaFile(native.debug), await shaFile(native.stripped));
        return { managed_sha256: await shaFile(managed), native, note: 'No REA server or provider executed; not a real acceptance pass.' };
      });
      return;
    }
    const [executable, ghidraDir, javaHome, browserPath] = process.argv.slice(2);
    await check('installed-MCP-initialize', () => initialize(executable, ghidraDir, javaHome));
    if (report.failed.length) return;
    await check('138-tools-6-prompts-and-all-advertised-schemas', catalog);
    if (report.failed.length) return;
    await check('target-free-session-and-negative-boundary', targetFree);
    // Ghidra deep query is deliberately early, avoiding a late hidden startup timeout.
    let fixtures;
    await check('gcc-debug-and-stripped-fixtures', async () => { fixtures = await nativeFixtures(); return fixtures; });
    if (fixtures) {
      await check('real-Ghidra-debug-dossier-by-symbol', () => ghidra(fixtures.debug, 'rea_live_entry', 'debug'));
      await check('real-Ghidra-stripped-dossier-by-independent-address', () => ghidra(fixtures.stripped, fixtures.entry, 'stripped'));
    }
    await check('static-JavaScript-Electron-graph-semantic-IPC-export-delta', javascript);
    await check('managed-metadata-CIL-PInvoke-no-execution', managed);
    await check('real-PTY-command-output-and-owned-cleanup', processCapture);
    if (browserPath) {
      await check('real-localhost-browser-passive-source-screenshot-active-click', async () => { await track(browserPath, 'selected-browser-executable'); return browser(browserPath); });
    } else report.unsupported.push({ name: 'real-browser', error: 'optional browserExecutable not supplied; no browser run' });
    await check('evidence-authentication-export-import-round-trip', evidenceBundle);
    report.optional_provider_profile = ['hopper', 'ida', 'jadx', 'binwalk', 'unblob', 'wakaru', 'ilspy'].map(id => ({
      id, execution: 'not-run', configured_by_harness: false,
      verification_status: 'unavailable-in-this-verification-profile',
      advertised_candidates: (report.initial_session?.analysis_provider_candidates ?? []).filter(c => c.provider.id.toLowerCase().includes(id)),
      note: 'No helper installation, setup, or execution. Advertised host availability, if any, is not a live-verification pass.',
    }));
    report.unsupported.push(
      { name: 'optional-providers', status: 'unavailable-in-this-verification-profile', error: 'Hopper/IDA/JADX/Binwalk/Unblob/Wakaru/ILSpy are not configured by this harness and are not executed or installed. Inspect optional_provider_profile for actual advertised candidates; helper availability is not execution.' },
      { name: 'higher-order-workflows', error: 'Not covered: active Electron/native UI, Android/firmware/apple formats, V8 Inspector, recovery engines, cross-format/nativeAOT/type/switch/value tracing, reconstruction closure, source-map authority, network replay, exhaustive per-tool execution. Only recorded representative families ran.' },
    );
  } finally {
    await check('owned-resource-and-original-SHA-cleanup', async () => {
      const errors = [];
      if (client && schemas.has('close_binary')) try { await call('close_binary'); } catch (e) { errors.push(e.message); }
      try { await client?.close(); } catch (e) { errors.push(`client close: ${e.message}`); }
      try { await transport?.close(); } catch (e) { errors.push(`transport close: ${e.message}`); }
      for (const child of [...owned]) try { await stopOwned(child); } catch (e) { errors.push(`owned child: ${e.message}`); }
      for (const [path, before] of trackedFiles) try { assert.equal(await shaFile(path), before, `${path} changed`); } catch (e) { errors.push(e.message); }
      const remaining = (await readdir(join(root, 'tmp'))).sort();
      report.cleanup.provider_tmp_remaining_before_harness_removal = remaining;
      if (remaining.length) errors.push(`unclassified or provider temporary runtime remains: ${remaining.join(', ')}`);
      if (owned.size) errors.push('owned child cleanup incomplete');
      // Fail closed: preserve unknown socket/runtime content instead of removing it
      // as part of a blanket parent-directory deletion and calling that cleanup.
      if (remaining.length || owned.size) {
        report.cleanup.harness_root_removed = false;
        report.cleanup.preserved_for_ownership_diagnostics = root;
      } else {
        await removeOwned(root);
        assert.equal(await exists(root), false);
        report.cleanup.harness_root_removed = true;
      }
      assert.equal(errors.length, 0, errors.join('\n'));
      return { all_tracked_input_SHA256_unchanged: true, temporary_root_removed: true, provider_temporary_baseline_restored: true };
    });
  }
}
try { await main(); }
catch (e) { report.failed.push({ name: 'harness-fatal', error: e.stack ?? String(e) }); }
report.completed_at = new Date().toISOString();
report.executed_tool_names = [...new Set(report.calls.map(c => c.name))].sort();
report.execution_counts = { recorded_tool_requests: report.calls.length, distinct_requested_tool_names: report.executed_tool_names.length, responded_successfully: report.calls.filter(c => c.outcome === 'responded').length, expected_target_required_rejections: report.calls.filter(c => c.name === 'current_document' && c.outcome === 'tool-error').length, passed_cases: report.passed.length, unsupported_cases: report.unsupported.length, failed_cases: report.failed.length };
report.status = report.failed.length ? 'failed' : report.mode === 'pure-fixture-only' ? 'pure-fixture-passed' : 'passed-with-explicit-unsupported';
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.failed.length ? 1 : 0;
