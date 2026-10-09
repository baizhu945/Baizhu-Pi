#!/usr/bin/env node
// Local SDK/compiler regression hook, also suitable for a Nix store copy:
// node rea-child-prompts.test.mjs <Pi SDK dir> [subagents dir] [REA extension dir]
// PI_SUBAGENTS_TEST_DEPS may point at the Nix-built subagents dependency tree.
// PI_SUBAGENTS_TEST_BASELINE_SOURCE supplies the immutable pre-REA snapshot in Nix.
// PI_SUBAGENTS_TEST_HEAD_REPO optionally selects a Git checkout for development.
// No network/model service or credentials; optional local MCP fixture only.
// No historical user/task text cleanup.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [sdkArg, pluginArg, reaArg] = process.argv.slice(2);
assert(sdkArg, 'Expected Pi SDK directory');
const sdkDir = path.resolve(sdkArg);
const pluginDir = path.resolve(pluginArg ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '../extensions/subagents'));
const require = createRequire(path.join(sdkDir, 'package.json'));
const dependencies = createRequire(path.join(process.env.PI_SUBAGENTS_TEST_DEPS ?? path.join(os.homedir(), '.pi/agent/extensions/pi-subagents'), 'index.ts'));
const sdk = await import(pathToFileURL(path.join(sdkDir, 'dist/index.js')));
const ai = await import(pathToFileURL(path.join(sdkDir, 'node_modules/@earendil-works/pi-ai/dist/compat.js')));
const { AssistantMessageEventStream } = await import(pathToFileURL(path.join(sdkDir, 'node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js')));
const { buildSystemPrompt } = await import(pathToFileURL(path.join(sdkDir, 'dist/core/system-prompt.js')));
const { createJiti } = await import(pathToFileURL(require.resolve('jiti')));
const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false, alias: {
  '@earendil-works/pi-coding-agent': path.join(sdkDir, 'dist/index.js'),
  '@earendil-works/pi-tui': require.resolve('@earendil-works/pi-tui'),
  '@earendil-works/pi-ai': path.join(sdkDir, 'node_modules/@earendil-works/pi-ai/dist/compat.js'),
  '@earendil-works/pi-agent-core': path.join(sdkDir, 'node_modules/@earendil-works/pi-agent-core/dist/index.js'),
  '@sinclair/typebox': dependencies.resolve('@sinclair/typebox'),
  croner: dependencies.resolve('croner'), nanoid: dependencies.resolve('nanoid'),
  typebox: require.resolve('typebox'), 'typebox/value': require.resolve('typebox/value'),
} });
const { sanitizeReaParentPrompt: sanitize } = await jiti.import(path.join(pluginDir, 'src/rea-inheritance.ts'));
const { buildAgentPrompt } = await jiti.import(path.join(pluginDir, 'src/prompts.ts'));
const { runMentionClone } = await jiti.import(path.join(pluginDir, 'src/mention-clone.ts'));
// Counterfactual runs the real unmodified HEAD source, not a hand-written
// approximation or assertions about the new implementation's parent prefix.
// Evaluate in memory with sibling imports resolved from the original directory.
const headMentionSource = process.env.PI_SUBAGENTS_TEST_BASELINE_SOURCE
  ? fs.readFileSync(process.env.PI_SUBAGENTS_TEST_BASELINE_SOURCE, 'utf8')
  : execFileSync('git', ['-C', process.env.PI_SUBAGENTS_TEST_HEAD_REPO ?? pluginDir,
    'show', 'HEAD:extensions/subagents/src/mention-clone.ts'], { encoding: 'utf8' });
const { runMentionClone: runHeadMentionClone } = await jiti.evalModule(headMentionSource, {
  filename: path.join(pluginDir, 'src/mention-clone.head-counterfactual.ts'), async: true,
});
const runner = await jiti.import(path.join(pluginDir, 'src/agent-runner.ts'));
const { DEFAULT_AGENTS } = await jiti.import(path.join(pluginDir, 'src/default-agents.ts'));
const marker = 'REA mode is explicitly authorized for this session. Use mcp__rea__ tools for reverse engineering.';
const policy = reaArg ? (await jiti.import(path.join(path.resolve(reaArg), 'index.ts'))).REA_POLICY
  : `${marker}\nEvidence first: identify the binary/project.\nState unknown when evidence is missing.`;
assert(policy.startsWith(marker), 'Controller marker and inheritance parser must agree');
const reaBlock = `<rea>\n${policy}\n</rea>`;
const names = `address_name address_to_file_offset analyze_function analyze_javascript_application analyze_swift_types analyze_web_bundle annotate_native_function batch_decompile binary_overview binary_session build_call_path build_reconstruction_obligation_ledger capture_browser_scenario capture_electron_scenario capture_native_ui_scenario capture_process_scenario capture_web_screenshot close_binary comment compare_application_versions compare_artifacts compare_bundles compare_functions compare_javascript_export_shapes compare_managed_members compare_process_captures compare_source_to_bundle compare_web_captures compare_web_screenshots correlate_static_and_runtime current_address current_document current_procedure decode_interface_builder demangle_swift discover_webmcp_tools evaluate_reconstruction_coverage export_evidence_bundle export_web_scripts extract_artifact extract_firmware find_changed_behavior find_xrefs_to_name get_call_graph get_evidence_bundle get_navigation_context get_objc_classes get_objc_protocols goto_address import_evidence_bundle import_managed_reconstruction inline_comment inspect_address_context inspect_android_class inspect_android_method inspect_android_package inspect_artifact inspect_asset_catalog inspect_binary_layout inspect_evm_interface inspect_recorded_crash inspect_electron_page inspect_firmware_regions inspect_keyed_archive inspect_macho inspect_managed_artifact inspect_managed_members inspect_managed_native_boundaries inspect_native_api inspect_native_data_type inspect_native_dispatch_metadata inspect_native_instruction inspect_native_load_image inspect_plist inspect_signature inspect_web_event_listeners inspect_web_network_capture inspect_web_page list_architectures list_bookmarks list_browser_targets list_documents list_electron_targets list_javascript_runtime_targets list_names list_procedures list_segments list_strings list_unknowns next_address observe_javascript_runtime observe_native_calls observe_native_ui observe_web_execution observe_web_session open_binary prev_address procedure_address procedure_assembly procedure_callees procedure_callers procedure_info procedure_pseudo_code procedure_references project_android_application_graph project_apple_application_graph project_managed_application_graph read_bytes read_function_instructions reconcile_javascript_runtime record_unknown recover_javascript_sources resolve_containing_procedure resolve_native_call_targets search_android_classes search_procedures search_strings set_address_name set_addresses_names set_bookmark set_comment set_inline_comment trace_android_references trace_application_feature trace_call_path trace_dylib_resolution trace_feature trace_javascript_semantics trace_native_ui_action trace_native_values trace_web_module_imports trace_web_source_location unset_bookmark update_unknown verify_managed_native_boundaries verify_reconstruction verify_unknown_resolution xrefs`.split(' ').map(name => `mcp__rea__${name}`);
assert.equal(names.length, 138);
const otherServers = 'MCP servers whose tools are not declared to you.\n- mcp__docs (codemode): Preserve docs server.\n- mcp__rea_extra (tool_search): Preserve distinct namespace.';
const onServers = otherServers.replace('- mcp__rea_extra', '- mcp__rea (codemode): Reverse-engineering namespace\n  continuation must disappear\n- mcp__rea_extra');
const fusion = '<fusion>\nFusion prefix and routing instructions: preserve exactly.\n</fusion>';
const goal = 'Keep the existing goal exactly: build a byte-preserving child prompt.';
const baseOptions = {
  cwd: '/fixture', selectedTools: ['read', 'mcp__docs__search', 'mcp__rea_extra__inspect', 'write'],
  toolSnippets: { read: 'Read files\n  Preserve this multiline detail.', write: 'Write files',
    mcp__docs__search: 'Search existing docs', mcp__rea_extra__inspect: 'Distinct namespace' },
  sections: { fusion: 'Fusion routing rules remain.', goal, mcp_servers: otherServers },
};
const base = buildSystemPrompt(baseOptions);
function parentPrompt({ tail = false, nested = false, forced = false } = {}) {
  const selectedTools = tail ? [...baseOptions.selectedTools, ...names] : ['read', ...names, ...baseOptions.selectedTools.slice(1)];
  const prompt = buildSystemPrompt({ ...baseOptions, selectedTools,
    toolSnippets: { ...baseOptions.toolSnippets, ...Object.fromEntries(names.map(name => [name, `REA_DESCRIPTION:${name}\n  REA_CONTINUATION\n\n  More continuation.`])) },
    sections: { ...baseOptions.sections, mcp_servers: onServers, rea: nested ? `${policy}\n<evidence>\n<rea>\nNested policy detail\n</rea>\n</evidence>` : policy },
  });
  return forced ? `${fusion}\n\n${prompt}\n\n${reaBlock}` : prompt;
}

await test('cold parent is byte-for-byte unchanged; text and tool names are not mode markers', () => {
  for (const cold of [base, '', 'const rea = "ordinary code";\r\n', '<rea>\nunrelated user code\n</rea>',
    buildSystemPrompt({ ...baseOptions, selectedTools: names, toolSnippets: Object.fromEntries(names.map(name => [name, 'User-defined snippet'])) })]) {
    assert.equal(sanitize(cold), cold);
  }
  const config = DEFAULT_AGENTS.get('general-purpose');
  const child = buildAgentPrompt(config, '/fixture', { isGitRepo: false, platform: 'linux' }, base);
  assert(child.startsWith(`${base}\n\n<sub_agent_context>`));
});
await test('real SDK builder: 138 descriptions/continuations and only REA namespace are removed', () => {
  for (const tail of [false, true]) {
    const cleaned = sanitize(parentPrompt({ tail }));
    assert.equal(cleaned, `${base}\n\n`);
    assert.equal(sanitize(cleaned), cleaned, 'idempotent');
    assert(!cleaned.includes('REA_CONTINUATION'));
  }
});
await test('nested sections and forced Fusion prefix: remove whole owned blocks, preserve other bytes', () => {
  const cleaned = sanitize(parentPrompt({ nested: true, forced: true }));
  assert.equal(cleaned, `${fusion}\n\n${base}\n\n\n\n`);
  assert(!cleaned.includes('Nested policy detail'));
  assert(!cleaned.includes('<evidence>'));
});
await test('quoted code/project/task sections cannot opt into sanitization or be edited', () => {
  const examples = [`\`\`\`xml\n${reaBlock}\n\`\`\``, `<project_context>\n${reaBlock}\n</project_context>`,
    `<agent_instructions>\n${reaBlock}\n</agent_instructions>`, `const policy = ${JSON.stringify(reaBlock)};`];
  for (const example of examples) {
    const cold = `${base}\n\n${example}`;
    assert.equal(sanitize(cold), cold);
    const on = `${cold}\n\n${reaBlock}`;
    assert.equal(sanitize(on), `${cold}\n\n`);
  }
  const malformed = `${base}\n\n<rea>\n${marker}\n<rea>\nnot closed`;
  assert.equal(sanitize(malformed), malformed, 'never greedily consume malformed input through EOF');
  const crlf = parentPrompt({ nested: true }).replaceAll('\n', '\r\n');
  assert.equal(sanitize(crlf), `${base}\n\n`.replaceAll('\n', '\r\n'));
});

let sequence = 0;
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const text = content => typeof content === 'string' ? content : (content ?? []).map(part => part.text ?? '').join('\n');
const systemText = context => [context.systemPrompt ?? '', ...context.messages.filter(message => message.role === 'system').map(message => ai.getSystemMessageText(message))].filter(Boolean).join('\n');
const userText = context => context.messages.filter(message => message.role === 'user').map(message => text(message.content)).join('\n');

async function fixture(t, prompt, produce = () => [{ type: 'text', text: 'Fixture completed.' }], options = {}) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-child-prompt-'));
  const agentDir = path.join(scratch, 'agent');
  fs.mkdirSync(agentDir, { recursive: true });
  const envKeys = ['HOME', 'XDG_CONFIG_HOME', 'PI_CODING_AGENT_DIR', 'PI_OFFLINE', 'PI_SKIP_VERSION_CHECK', 'UNIPI_FUSION_CHILD'];
  const saved = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  const cwd = process.cwd();
  process.env.HOME = scratch; process.env.XDG_CONFIG_HOME = path.join(scratch, '.config');
  process.env.PI_CODING_AGENT_DIR = agentDir; process.env.PI_OFFLINE = '1'; process.env.PI_SKIP_VERSION_CHECK = '1';
  delete process.env.UNIPI_FUSION_CHILD;
  process.chdir(scratch);
  fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off',
    // With the optional product path, children really load the REA controller
    // under ALS. It must stay off, without reading config or registering MCP.
    extensions: reaArg ? [path.resolve(reaArg)] : [] }));
  const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off' });
  const captures = [], errors = [], children = [];
  const providerName = `rea-child-fixture-${++sequence}`;
  let controllerDir;
  if (options.realController) {
    assert(reaArg, 'Actual controller test needs the REA extension directory');
    controllerDir = path.join(scratch, 'rea-controller');
    fs.cpSync(path.resolve(reaArg), controllerDir, { recursive: true, dereference: true });
    // Nix's assembled controller/config are read-only; only this owned copy is
    // mutable. Never chmod or rewrite the installed extension/store source.
    fs.chmodSync(controllerDir, 0o700);
    const copiedConfig = path.join(controllerDir, 'config.json');
    if (fs.existsSync(copiedConfig)) fs.chmodSync(copiedConfig, 0o600);
    const server = path.join(scratch, 'native-138-fixture.mjs');
    fs.writeFileSync(server, `import { createInterface } from 'node:readline';
const names = JSON.parse(process.argv[2]);
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  let result;
  if (request.method === 'initialize') result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'rea-native-fixture', version: '1' } };
  else if (request.method === 'tools/list') result = { tools: names.map(name => ({ name, description: 'Native REA ' + name, inputSchema: { type: 'object', properties: {} } })) };
  else if (request.method === 'tools/call') result = { content: [{ type: 'text', text: 'Native binary_session completed.' }] };
  else if (request.method === 'ping') result = {};
  if (request.id !== undefined) send({ jsonrpc: '2.0', id: request.id, result: result ?? {} });
}).on('close', () => process.exit(0));
`);
    fs.writeFileSync(path.join(controllerDir, 'config.json'), JSON.stringify({ command: process.execPath,
      args: [server, JSON.stringify(names.map(name => name.slice('mcp__rea__'.length)))], env: {}, timeout: 5, expectedTools: 138 }));
  }
  let ctx, api;
  const resourceLoader = new sdk.DefaultResourceLoader({ cwd: scratch, agentDir, settingsManager,
    noExtensions: true, noContextFiles: true, noSkills: true, noThemes: true, noPromptTemplates: true,
    systemPromptOverride: () => prompt, appendSystemPromptOverride: () => [],
    additionalExtensionPaths: controllerDir ? [controllerDir] : [],
    extensionFactories: [...(controllerDir ? [sdk.createMcpExtension()] : []), ...(options.factories ?? []), pi => {
      api = pi;
      pi.on('session_start', (_event, context) => { ctx = context; });
      pi.registerProvider(providerName, { api: providerName, apiKey: 'offline-fixture-only', baseUrl: 'http://127.0.0.1:9',
        streamSimple(model, context) {
          captures.push(JSON.parse(JSON.stringify(context)));
          const stream = new AssistantMessageEventStream();
          const content = produce(captures.length, context);
          const message = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
            stopReason: content.some(part => part.type === 'toolCall') ? 'toolUse' : 'stop', timestamp: 0, usage };
          queueMicrotask(() => { stream.push({ type: 'done', reason: message.stopReason, message }); stream.end(); });
          return stream;
        },
        models: [{ id: 'fixture', name: 'Offline fixture', reasoning: false, input: ['text'], contextWindow: 200000, maxTokens: 1024,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      });
    }],
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const { session } = await sdk.createAgentSession({ cwd: scratch, agentDir, settingsManager, resourceLoader, sessionManager: sdk.SessionManager.inMemory(scratch) });
  await session.bindExtensions({ mode: controllerDir ? 'tui' : 'sdk',
    ...(controllerDir ? { uiContext: { confirm: async () => true, notify() {}, setStatus() {} } } : {}),
    onError: error => errors.push(error) });
  await session.setModel(session._modelRuntime.getModel(providerName, 'fixture'));
  t.after(async () => {
    for (const child of [...children, session]) {
      await child.extensionRunner?.emit({ type: 'session_shutdown', reason: 'quit' });
      child.dispose();
    }
    process.chdir(cwd);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    // Leave bounded scratch artifacts available for inspection; no rm wrapper bypass.
    assert.deepEqual(errors, []);
  });
  return { ctx: () => ctx, api, session, captures, children };
}
function assertCleanRequest(context, expectedBase) {
  const prompt = systemText(context);
  assert(prompt.includes(expectedBase), 'Full base prompt and other extensions preserved in actual model request');
  assert(!prompt.includes(marker), 'No REA mode guidance in new-session system prompt');
  assert(!prompt.includes('mcp__rea__'), 'No REA tool descriptions in new-session system prompt');
  assert(!prompt.includes('- mcp__rea ('), 'No REA discovery namespace');
  const declarations = [...(context.tools ?? []), ...context.messages.flatMap(message => message.role === 'system' ? message.toolsAdded ?? [] : [])];
  assert(declarations.every(tool => !tool.name.startsWith('mcp__rea__') && tool.namespace?.name !== 'mcp__rea'), 'No inherited names/schema');
  const removals = context.messages.flatMap(message => message.role === 'system' ? message.toolsRemoved ?? [] : []);
  assert(removals.every(tool => !tool.name.startsWith('mcp__rea__')), 'No inherited REA tool-removal delta');
}

await test('actual default append Agent request retains base/Fusion/Goal, not REA; task text is untouched', { timeout: 20000 }, async t => {
  const h = await fixture(t, parentPrompt({ nested: true, forced: true }));
  const task = `Real delivery task: inspect the literal name mcp__rea__open_binary, not authorization.\n${reaBlock}`;
  const history = `Historical REA task (do not clear it).\n${reaBlock}`;
  h.session.sessionManager.appendMessage({ role: 'user', content: history, timestamp: 0 });
  const result = await runner.runAgent(h.ctx(), 'general-purpose', task, { pi: h.api, inheritContext: true,
    onSessionCreated: child => h.children.push(child) });
  assert.equal(result.failure, undefined, result.failure);
  assert.equal(h.captures.length, 1);
  assertCleanRequest(h.captures[0], `${fusion}\n\n${base}`);
  assert(userText(h.captures[0]).includes(task), 'Delivery task is never sanitized');
  assert(userText(h.captures[0]).includes(history), 'inherit_context historical user text is never sanitized');
  assert(h.ctx().getSystemPrompt().includes(marker), 'Parent authorization remains intact');
});

await test('warm mention excludes real parent system records/REA metadata; non-system facts stay verbatim', { timeout: 20000 }, async t => {
  let cloning = false;
  const h = await fixture(t, parentPrompt({ forced: true }), call => cloning && call === 1
    ? [{ type: 'toolCall', id: 'mention_fixture', name: 'Agent', arguments: { prompt: 'Literal delivery task', subagent_type: 'general-purpose' } }]
    : [{ type: 'text', text: 'Mention delegated.' }], { factories: [pi => {
      pi.on('before_agent_start', event => {
        event.systemPromptOptions.sections = { ...event.systemPromptOptions.sections, rea: policy };
      });
      pi.registerTool({ name: 'mcp__rea__open_binary', label: 'REA fixture', description: 'PARENT_REA_TOOL_METADATA',
        namespace: { name: 'mcp__rea', description: 'PARENT_REA_NAMESPACE_METADATA' },
        parameters: { type: 'object', properties: { path: { type: 'string', description: 'PARENT_REA_SCHEMA_METADATA' } } },
        async execute() { throw new Error('Fixture never executes REA tools'); } });
    }] });
  const history = `Old historical task mentioning mcp__rea__open_binary.\n${reaBlock}`;
  // A real request records a system baseline (not a synthetic append), with
  // structured REA guidance and native tool declarations. The clone must not
  // replay that baseline or later prompt/tool deltas as child authorization.
  await h.session.prompt(history);
  const recordedSystems = h.session.sessionManager.buildSessionContext().messages.filter(message => message.role === 'system');
  assert(recordedSystems.some(message => message.sections?.rea?.includes(marker)), 'Parent actually persisted its REA section');
  assert(recordedSystems.some(message => message.toolsAdded?.some(tool => tool.name === 'mcp__rea__open_binary')), 'Parent actually persisted REA toolsAdded/schema');
  assert(systemText(h.captures[0]).includes(marker), 'Real parent request was authorized');
  h.session.sessionManager.appendMessage({ role: 'system', content: 'PARENT_REA_SYSTEM_DELTA', sections: { rea: `${policy}\nPARENT_REA_SECTION_DELTA` },
    toolsAdded: [{ name: 'mcp__rea__inspect_artifact', description: 'PARENT_REA_DELTA_TOOL_METADATA', parameters: { type: 'object', properties: {} } }],
    toolsRemoved: [{ name: 'mcp__rea__open_binary' }], timestamp: 0 });
  h.session.sessionManager.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id: 'historical_rea_call', name: 'mcp__rea__open_binary', arguments: { path: 'historical-fact.bin' } }],
    api: h.session.model.api, provider: h.session.model.provider, model: h.session.model.id, stopReason: 'toolUse', timestamp: 0, usage });
  h.session.sessionManager.appendMessage({ role: 'toolResult', toolCallId: 'historical_rea_call', toolName: 'mcp__rea__open_binary',
    content: [{ type: 'text', text: 'Historical REA result: binary fingerprint fact.' }], details: { untouched: 'mcp__rea__open_binary' }, isError: false, timestamp: 0 });
  h.session.sessionManager.appendMessage({ role: 'branchSummary', summary: `Historical summary fact: ${marker}`, fromId: null, timestamp: 0 });
  h.session.sessionManager.appendMessage({ role: 'compactionSummary', summary: `Historical compacted fact: ${reaBlock}`, tokensBefore: 123, timestamp: 0 });
  const resolvedFacts = h.session.sessionManager.buildSessionContext().messages.filter(message => message.role !== 'system');
  h.captures.length = 0;
  cloning = true;
  const before = JSON.stringify(h.session.sessionManager.getEntries());
  let forwarded;
  const task = 'Mention task: preserve ordinary rea code and mcp__rea__open_binary literally.';
  const result = await runMentionClone({ ctx: h.ctx(), type: 'general-purpose', message: task,
    agentTool: { name: 'Agent', label: 'Agent', description: 'Delegate exactly one task',
      parameters: { type: 'object', properties: { prompt: { type: 'string' }, subagent_type: { type: 'string' } } },
      async execute(id, params, _signal, _update, mainCtx) {
        forwarded = { id, params, mainCtx };
        return { content: [{ type: 'text', text: 'Spawned.' }], details: undefined };
      },
    } });
  assert.deepEqual(result, { spawned: true });
  assert(h.captures.length >= 1);
  for (const capture of h.captures) {
    assertCleanRequest(capture, `${fusion}\n\n${base}`);
    assert(!JSON.stringify(capture.messages.filter(message => message.role === 'system')).includes('PARENT_REA_'),
      'No inherited system content, section delta, description, namespace, or schema');
  }
  // Summary roles are converted by Pi for provider delivery; compare against
  // Pi's own projection rather than assuming their rendered text format.
  const expectedFacts = sdk.convertToLlm(resolvedFacts);
  const actualFacts = h.captures[0].messages.filter(message => message.role !== 'system').slice(0, expectedFacts.length);
  assert.deepEqual(actualFacts, expectedFacts, 'All resolved non-system facts remain unchanged and in order');
  assert(userText(h.captures[0]).includes(history), 'Old historical text deliberately retained');
  assert(userText(h.captures[0]).includes(task), 'Mention task retained');
  assert.equal(forwarded.id, undefined);
  assert.equal(forwarded.mainCtx, h.ctx());
  assert.equal(forwarded.params.prompt, 'Literal delivery task');
  assert.equal(JSON.stringify(h.session.sessionManager.getEntries()), before, 'Main transcript not edited');
});

await test('counterfactual cold behavior and actual requests equal the unmodified HEAD mention clone', { timeout: 20000 }, async t => {
  for (const [name, prompt, primed, getter] of [
    ['live nonempty getter: original SDK failure', base, false, 'live'],
    ['quoted marker: original SDK failure', `${base}\n\n<project_context>\n${reaBlock}\n</project_context>`, true, 'live'],
    ['missing getter, fresh', base, false, 'missing'],
    ['missing getter, already prompted', base, true, 'missing'],
    ['empty getter, fresh', undefined, false, 'empty'],
    ['empty getter, already prompted', base, true, 'empty'],
  ]) await t.test(name, async subtest => {
    const h = await fixture(subtest, prompt);
    if (primed) await h.session.prompt(`Cold historical user fact, not authorization.\n${reaBlock}`);
    const before = JSON.stringify(h.session.sessionManager.getEntries());
    // getSystemPrompt is optional in the original clone. Missing/empty getter
    // paths issue real requests even on this SDK. Do not patch the SDK's state
    // getter to make its nonempty path work: that would hide the original bug.
    const ctx = getter === 'live' ? h.ctx() : { ...h.ctx(), getSystemPrompt: getter === 'empty' ? () => '' : undefined };
    const options = { ctx, type: 'general-purpose', message: 'Cold mention: literal mcp__rea__open_binary.',
      agentTool: { name: 'Agent', label: 'Agent', description: 'Delegate', parameters: { type: 'object', properties: {} },
        async execute() { throw new Error('Fixture never issues tools'); } } };
    h.captures.length = 0;
    const originalResult = await runHeadMentionClone(options);
    const originalRequests = [...h.captures];
    h.captures.length = 0;
    const currentResult = await runMentionClone(options);
    assert.deepEqual(currentResult, originalResult);
    assert.equal(JSON.stringify(h.session.sessionManager.getEntries()), before, 'Both clones leave the parent transcript untouched');
    if (getter === 'live') {
      assert.equal(originalRequests.length, 0);
      assert.equal(h.captures.length, 0);
      assert.equal(originalResult.spawned, false);
      assert.match(originalResult.error, /Cannot set property systemPrompt .* which has only a getter/);
      console.log(`Cold counterfactual ${name}: unchanged HEAD error; both send zero requests (no SDK bug fix).`);
      return;
    }
    assert.equal(originalRequests.length, 1, `HEAD sends one real SDK request: ${JSON.stringify(originalResult)}`);
    assert.equal(h.captures.length, 1, 'Current sends one real SDK request');
    // Only wall-clock message timestamps vary between these separate runs.
    // Compare every remaining request byte: prompt, sections/deltas, tool
    // descriptions/schema/namespace, and conversation content/order alike.
    const stable = request => ({ ...request, messages: request.messages.map(({ timestamp, ...message }) => message) });
    assert.deepEqual(stable(h.captures[0]), stable(originalRequests[0]));
    assert.equal(JSON.stringify(stable(h.captures[0])), JSON.stringify(stable(originalRequests[0])), 'Full actual request bytes match HEAD except wall-clock timestamps');
    console.log(`Cold counterfactual ${name}: actual request JSON equals HEAD (only message timestamps omitted).`);
  });
});

if (reaArg) for (const forced of [false, true]) {
  await test(`actual controller/native MCP: in-tool parent getter leaks mode guidance (${forced ? 'forced Fusion' : 'structured default'})`, { timeout: 20000 }, async t => {
    let inflightPrompt, childResult;
    let h;
    h = await fixture(t, undefined, call => {
      if (call === 1) return [{ type: 'toolCall', id: 'native_binary_session', name: 'mcp__rea__binary_session', arguments: {} }];
      if (call === 2) return [{ type: 'toolCall', id: 'actual_agent_spawn', name: 'fixture_spawn', arguments: {} }];
      return [{ type: 'text', text: 'Fixture completed.' }];
    }, { realController: true, factories: [pi => {
      if (forced) pi.on('before_agent_start', event => ({ systemPrompt: `${fusion}\n\n${event.systemPrompt}` }));
      pi.registerTool({ name: 'fixture_spawn', label: 'Spawn', description: 'Exercise the real default append runner.',
        parameters: { type: 'object', properties: {} },
        async execute(_id, _params, _signal, _update, parentCtx) {
          inflightPrompt = parentCtx.getSystemPrompt();
          childResult = await runner.runAgent(parentCtx, 'general-purpose', 'Deliver the actual child result.', { pi: h.api,
            onSessionCreated: child => h.children.push(child) });
          return { content: [{ type: 'text', text: childResult.responseText }], details: undefined };
        } });
    }] });
    const idleBase = h.ctx().getSystemPrompt();
    await h.session.prompt('/rea on');
    assert.equal(h.captures.length, 0, 'Activation does not call a model');
    assert.equal(h.session.getAllTools().filter(tool => tool.name.startsWith('mcp__rea__') && tool.exposure === 'direct').length, 138);
    assert(!h.ctx().getSystemPrompt().includes(marker), 'Idle getter alone cannot detect this leak');
    await h.session.prompt('Call binary_session, then delegate through fixture_spawn.');
    assert.equal(childResult?.failure, undefined);
    assert.equal(h.captures.length, 4, 'Parent binary_session + parent spawn + child + parent follow-up');
    assert(systemText(h.captures[0]).includes(marker), 'Actual parent request is authorized');
    assert(inflightPrompt?.includes(marker), 'Actual in-tool getter contains the REA mode section');
    if (forced) assert(inflightPrompt.startsWith(fusion), 'Forced Fusion path actually exercised');
    else assert(!inflightPrompt.includes('- mcp__rea__'), 'Native MCP has no promptSnippet; do not assume native summaries');
    const inherited = sanitize(inflightPrompt);
    assertCleanRequest(h.captures[2], inherited);
    assert.equal(h.children[0].getAllTools().filter(tool => tool.name.startsWith('mcp__rea__')).length, 0, 'Child controller stays off, with no inherited native MCP');
    assert(h.ctx().getSystemPrompt().includes(idleBase), 'Settled getter restores the base');
    console.log(`Verified actual ${forced ? 'forced' : 'structured'} path: idle marker=false, in-tool marker=true, child marker=false; 138 native tools parent-only.`);
  });
}
