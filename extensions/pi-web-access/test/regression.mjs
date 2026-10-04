import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { deflateSync } from "node:zlib";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";

const sdkRoot = process.argv[2];
const root = path.resolve(process.argv[3] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
assert(sdkRoot, "Pass the Pi SDK directory, followed by the local extension directory.");
assert.equal(typeof Promise.try, "function", "This local build requires Node 24's native Promise.try.");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-access-regression-"));
const agentDir = path.join(scratch, "agent");
fs.mkdirSync(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.XDG_CONFIG_HOME = path.join(scratch, "config");
process.env.PI_OFFLINE = "1";
for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_GEMINI_BASE_URL", "CLOUDFLARE_API_KEY"]) delete process.env[name];
process.env.NO_PROXY = "*";
const config = {
  workflow: "none", pdf: { provider: "unpdf" },
  fetchRouting: { providers: ["http"], allowRemoteHostedProviders: false },
  searxngBaseUrl: "https://search.example.com", firecrawlBaseUrl: "https://firecrawl.example.com",
  crawl4aiBaseUrl: "https://crawl.example.com", brightdataSerpZone: "fixture_zone",
  ssrf: { allowRanges: ["198.18.0.0/15"] },
  githubClone: { clonePath: path.join(scratch, "repos") },
};
for (const name of ["openai", "parallel", "firecrawl", "exa", "gemini", "anysearch", "xai", "baizhi", "zai"]) config[name + "ApiKey"] = "fixture-key";
fs.writeFileSync(path.join(agentDir, "web-search.json"), JSON.stringify(config));

const require = createRequire(path.join(sdkRoot, "package.json"));
require("node:dns").promises.lookup = async () => [{ address: "93.184.216.34", family: 4 }];
syncBuiltinESMExports();
const createJiti = require("jiti").createJiti ?? require("jiti");
function hostEntry(name, subpath = ".") {
  const dir = path.join(sdkRoot, "node_modules", name);
  const p = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  const e = p.exports?.[subpath] ?? p.module ?? p.main;
  const target = typeof e === "string" ? e : e.import?.default ?? e.import ?? e.default;
  return path.join(dir, target);
}
const alias = {
  "@earendil-works/pi-coding-agent": path.join(sdkRoot, "dist/index.js"),
  "@earendil-works/pi-ai/compat": hostEntry("@earendil-works/pi-ai", "./compat"),
  "@earendil-works/pi-ai": hostEntry("@earendil-works/pi-ai"),
  "@earendil-works/pi-tui": hostEntry("@earendil-works/pi-tui"),
  "typebox/value": hostEntry("typebox", "./value"),
  "typebox": hostEntry("typebox"),
};
const jiti = createJiti(import.meta.url, { alias, fsCache: false, moduleCache: true });
const load = name => jiti.import(path.join(root, name));
let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok ${passed} - ${name}`);
  } catch (error) {
    failures.push(name);
    process.exitCode = 1;
    console.error(`FAIL - ${name}: ${error.stack}`);
  }
}

const entry = { title: "Fixture article", name: "Fixture article", url: "https://example.com/article", link: "https://example.com/article", snippet: "Fixture evidence", description: "Fixture evidence", content: "Fixture evidence", text: "Fixture evidence", excerpts: ["Fixture evidence"], highlights: ["Fixture evidence"], summary: "Fixture evidence", type: 0 };
const answer = "Fixture answer with evidence.";
let provider = "exa";
let transportMode = "success";
let responseMode = "search";
const mcpEvents = [];
const requestedUrls = [];
let failSearxng = false;
const nativeFetch = globalThis.fetch;
const html = `<html><head><title>Fixture article</title></head><body><article><h1>Fixture article</h1><p>${"Fixture evidence about local plugins and dependency pruning. ".repeat(35)}</p><pre><code>nix-build</code></pre></article></body></html>`;
function pngChunk(name, data) {
  const type = Buffer.from(name);
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([type, data])) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, type, data, checksum]);
}
const pngHeader = Buffer.alloc(13);
pngHeader.writeUInt32BE(2, 0); pngHeader.writeUInt32BE(2, 4); pngHeader[8] = 8; pngHeader[9] = 6;
const pixel = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", pngHeader), pngChunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0, 255, 255, 0, 0, 255, 0, 255, 0, 0, 255, 255, 0, 0, 255]))), pngChunk("IEND", Buffer.alloc(0))]);
function json(data, status = 200, headers = {}) { return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } }); }
function mcpReply(data, headers = {}) {
  if (transportMode === "sse") return new Response(`event: message\ndata: ${JSON.stringify(data)}\n\n`, { headers: { "content-type": "text/event-stream", ...headers } });
  return json(data, 200, headers);
}
function searchFixture() {
  switch (provider) {
    case "anysearch": return { code: 0, data: { results: [entry], metadata: {} } };
    case "firecrawl": return { success: true, data: [entry] };
    case "gemini": return { candidates: [{ content: { parts: [{ text: answer }] }, groundingMetadata: { groundingChunks: [{ web: { uri: entry.url, title: entry.title } }] } }] };
    case "openai":
    case "xai": return { output: [{ type: "web_search_call", status: "completed" }, { type: "message", role: "assistant", content: [{ type: "output_text", text: answer, annotations: [{ type: "url_citation", url: entry.url, title: entry.title, start_index: 0, end_index: 7 }] }] }] };
    case "kimi": return { results: [entry], search_results: [entry] };
    case "parallel-mcp": return { jsonrpc: "2.0", id: 1, result: { structuredContent: { results: [entry] }, content: [] } };
    case "duckduckgo": return null;
    default: return { results: [entry], web: { results: [entry] }, organic: [entry], organic_results: [entry], data: [entry], choices: [{ message: { content: answer } }], citations: [entry.url], search_results: [entry] };
  }
}
globalThis.fetch = async (input, init = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  requestedUrls.push(url);
  if (failSearxng && url.includes("search.example.com")) return json({ error: "Fixture unavailable" }, 503);
  if (/^http:\/\/127\.0\.0\.1:/.test(url)) return nativeFetch(input, init);
  if (/baizhi\.cloud|web_search_prime\/mcp/.test(url)) {
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    assert.equal(headers.get("authorization"), "Bearer fixture-key");
    if (method === "DELETE") { mcpEvents.push("DELETE"); return new Response(null, { status: 204 }); }
    if (method === "GET") return new Response(null, { status: 405 });
    const message = JSON.parse(init.body);
    mcpEvents.push(message.method);
    if (message.method === "initialize") return mcpReply({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1.0" } } }, { "mcp-session-id": "fixture-session" });
    if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (message.method === "tools/list") return mcpReply({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "web_search_prime", inputSchema: { type: "object" } }] } });
    if (message.method === "tools/call") {
      if (transportMode === "abort") return new Promise((resolve, reject) => { const abort = () => reject(new Error("Aborted")); init.signal.addEventListener("abort", abort, { once: true }); if (init.signal.aborted) abort(); });
      const content = [{ type: "text", text: provider === "zai" ? JSON.stringify([{ link: entry.url, title: entry.title, content: entry.snippet }]) : answer }];
      return mcpReply({ jsonrpc: "2.0", id: message.id, result: { content, ...(transportMode === "error" ? { isError: true } : {}) } });
    }
    throw new Error("Unexpected MCP method: " + message.method);
  }
  if (responseMode === "http") {
    const response = url.endsWith(".png") ? new Response(pixel, { headers: { "content-type": "image/png" } }) : new Response(html, { headers: { "content-type": "text/html" } });
    Object.defineProperty(response, "url", { value: url });
    return response;
  }
  if (responseMode === "youtube-error") return json({ error: "Fixture Gemini unavailable" }, 503);
  if (responseMode === "pdf-gemini") return json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "<!-- Page 1 -->\nFixture PDF API content." }] } }] });
  if (responseMode === "youtube" || responseMode === "url-context") return json({ candidates: [{ content: { parts: [{ text: "# Fixture content\n" + "Video or URL API content. ".repeat(20) }] } }] });
  if (responseMode === "local-video") {
    if (url.includes("/upload/") && init.method === "POST") return json({}, 200, { "x-goog-upload-url": "https://generativelanguage.googleapis.com/upload/fixture" });
    if (init.method === "PUT") return json({ file: { name: "files/fixture", uri: "https://generativelanguage.googleapis.com/v1beta/files/fixture" } });
    if (url.includes("/files/fixture")) return json({ state: "ACTIVE" });
    return json({ candidates: [{ content: { parts: [{ text: "# Local video\nFixture video API content." }] } }] });
  }
  if (provider === "duckduckgo") return new Response(`<div class="result"><a class="result__a" href="${entry.url}">${entry.title}</a><a class="result__snippet">${entry.snippet}</a></div>`, { headers: { "content-type": "text/html" } });
  return json(searchFixture());
};

const models = [
  { provider: "openai", id: "gpt-6-luna", api: "openai-responses", baseUrl: "https://api.openai.com/v1", input: ["text", "image"], contextWindow: 128000 },
  { provider: "kimi-coding", id: "kimi-for-coding", api: "anthropic-messages", baseUrl: "https://api.kimi.com/coding", input: ["text"], contextWindow: 128000 },
  { provider: "anthropic", id: "claude-haiku-4-5", input: ["text"], contextWindow: 128000 },
  { provider: "google", id: "gemini-3.6-flash", input: ["text"], contextWindow: 128000 },
];
const sessionEntries = [];
const ctx = {
  cwd: scratch, mode: "tui", model: models[0], scopedModels: [], hasUI: true,
  modelRegistry: {
    getAll: () => models, getAvailable: () => models,
    find: (provider, id) => models.find(m => m.provider === provider && m.id === id),
    getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fixture-key", headers: {} }),
    isUsingOAuth: () => false,
    complete: async () => ({ role: "assistant", content: [{ type: "text", text: "Fixture model answer" }], stopReason: "stop" }),
  },
  sessionManager: { getSessionId: () => "fixture-session", getBranch: () => sessionEntries },
  ui: { setWidget() {}, setStatus() {}, notify() {}, select: async () => undefined, theme: { fg: (_, t) => t, bg: (_, t) => t, bold: t => t } },
};

await check("retired packages and source modules are absent", async () => {
  for (const name of ["@modelcontextprotocol/sdk", "promise.try", "undici"]) assert(!fs.existsSync(path.join(root, "node_modules", name)), name);
  for (const name of ["gemini-web.ts", "gemini-web-config.ts", "chrome-cookies.ts", "auth-fetch.ts", "promise-try.d.ts"]) assert(!fs.existsSync(path.join(root, name)), name);
  assert(fs.existsSync(path.join(root, "MCP-LICENSES.txt")));
});
const search = await load("gemini-search.ts");
await check("the 12 retained search providers remain registered, including Baizhi/Z.ai", async () => {
  assert.equal(search.RESOLVED_SEARCH_PROVIDERS.length, 12);
  assert(search.RESOLVED_SEARCH_PROVIDERS.includes("baizhi"));
  assert(search.RESOLVED_SEARCH_PROVIDERS.includes("zai"));
});
await check("removed services are absent and cannot silently route to another provider", async () => {
  for (const name of ["brave", "parallel", "tinyfish", "search1api", "searchinfinity", "querit", "tavily", "you", "jina", "serpdive", "kagi", "bocha", "ollama", "perplexity", "xcrawl", "valyu", "mistral", "brightdata", "serpbase", "serpapi", "serper", "serply"]) {
    assert(!search.RESOLVED_SEARCH_PROVIDERS.includes(name));
    assert.throws(() => search.normalizeSearchProviderSelection(name), /removed|unsupported/);
    await assert.rejects(search.search("fixture", { provider: name, extensionContext: ctx }), /removed|unsupported/);
  }
  for (const name of ["brave.ts", "parallel.ts", "perplexity.ts", "jina-search.ts", "mistral-search.ts", "brightdata-unlocker.ts", "datalab-pdf-extract.ts"]) assert(!fs.existsSync(path.join(root, name)));
});
for (const name of search.RESOLVED_SEARCH_PROVIDERS) await check(`${name}: search result parsing with an isolated HTTP fixture`, async () => {
  provider = name; responseMode = "search"; transportMode = "success"; mcpEvents.length = 0;
  const result = await search.search("local plugin regression", { provider: name, numResults: 1, extensionContext: ctx });
  assert.equal(result.provider, name);
  assert(result.answer?.length > 0 || result.results.length > 0, "Fixture must produce useful content");
  if (name === "baizhi" || name === "zai") {
    assert(mcpEvents.includes("initialize"));
    assert(mcpEvents.includes("tools/call"));
    assert(mcpEvents.includes("DELETE"));
    if (name === "zai") assert(mcpEvents.includes("tools/list"));
  }
});
await check("automatic search falls back to a retained service and all mode has only five default candidates", async () => {
  assert.deepEqual(search.ALL_SEARCH_PROVIDERS, ["searxng", "openai", "exa", "firecrawl", "gemini"]);
  provider = "exa"; responseMode = "search"; failSearxng = true;
  try {
    const result = await search.search("fixture", { provider: "auto", extensionContext: ctx });
    assert.equal(result.provider, "exa");
    assert(result.results.length > 0);
  } finally { failSearxng = false; }
});
for (const name of ["baizhi", "zai"]) {
  await check(`${name}: streamed SSE MCP responses preserve discovery and cleanup`, async () => {
    provider = name; transportMode = "sse"; mcpEvents.length = 0;
    const result = await search.search("fixture", { provider: name, extensionContext: ctx });
    assert(result.answer.length > 0);
    assert(mcpEvents.includes("tools/call"));
    assert(mcpEvents.includes("DELETE"));
  });
  await check(`${name}: remote tool errors retain sanitized failure and cleanup`, async () => {
    provider = name; transportMode = "error"; mcpEvents.length = 0;
    await assert.rejects(search.search("fixture", { provider: name, extensionContext: ctx }), error => !error.message.includes("fixture-key") && /tool returned an error/.test(error.message));
    assert(mcpEvents.includes("DELETE"));
  });
  await check(`${name}: in-flight cancellation terminates the MCP session`, async () => {
    provider = name; transportMode = "abort"; mcpEvents.length = 0;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30);
    try { await assert.rejects(search.search("fixture", { provider: name, extensionContext: ctx, signal: controller.signal }), /aborted/i); }
    finally { clearTimeout(timer); }
    assert(mcpEvents.includes("DELETE"));
  });
}
transportMode = "success";

await check("real Pi host loader discovers the published extension without errors", async () => {
  const sdk = await import(pathToFileURL(path.join(sdkRoot, "dist/index.js")));
  const loader = new sdk.DefaultResourceLoader({ cwd: scratch, agentDir, settingsManager: sdk.SettingsManager.inMemory({ packages: [root] }), noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  assert.deepEqual(loaded.warnings ?? [], []);
  const extension = loaded.extensions.find(e => e.path.startsWith(root));
  assert(extension);
  assert.deepEqual([...extension.tools.keys()].sort(), ["fetch_content", "get_search_content", "source_check", "web_search"]);
  assert(!fs.existsSync(path.join(root, "tool-activation.ts")));
  assert.deepEqual([...extension.commands.keys()].sort(), ["curator", "search", "websearch"]);
  assert(!("auth" in extension.tools.get("fetch_content").definition.parameters.properties));
});

const tools = new Map(), commands = new Map(), hooks = new Map();
let active = [];
const api = {
  registerTool: definition => { tools.set(definition.name, definition); active.push(definition.name); },
  registerCommand: (name, definition) => commands.set(name, definition), registerShortcut() {},
  on: (event, handler) => { const set = hooks.get(event) ?? new Set(); hooks.set(event, set); set.add(handler); return () => set.delete(handler); },
  getAllTools: () => [...tools].map(([name]) => ({ name })), getActiveTools: () => active,
  setActiveTools: names => { active = names; }, appendEntry: (customType, data) => sessionEntries.push({ type: "custom", customType, data }),
  sendMessage() {}, exec: async () => ({ code: 0, stdout: "", stderr: "" }),
};
(await load("dist/index.js")).default(api);
for (const handler of hooks.get("session_start") ?? []) await handler({}, ctx);
const execute = (name, params) => tools.get(name).execute("fixture-call", params, undefined, undefined, ctx);
const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
await check("raw and readable webpage extraction preserve content and Markdown", async () => {
  responseMode = "http";
  const extraction = await load("extract.ts");
  const readable = await extraction.extractContent(entry.url, undefined, { lookup });
  assert.equal(readable.error, null);
  assert.match(readable.content, /Fixture evidence/);
  assert.match(readable.content, /nix-build/);
  const raw = await extraction.extractContent(entry.url, undefined, { lookup, mode: "raw" });
  assert.equal(raw.content, html);
  assert.equal(raw.error, null);
});
await check("SSRF restrictions continue to reject loopback targets", async () => {
  const { validateRemoteUrl } = await load("ssrf-protection.ts");
  await assert.rejects(validateRemoteUrl("http://127.0.0.1/private"), /blocked|private|internal|IP/i);
});
await check("image fetch and pre-cancelled extraction remain functional", async () => {
  const extraction = await load("extract.ts");
  const image = await extraction.extractContent("https://example.com/image.png", undefined, { lookup });
  assert.equal(image.error, null);
  assert.equal(image.thumbnail.mimeType, "image/png");
  assert(image.thumbnail?.data.length > 0);
  const cancelled = await extraction.extractContent(entry.url, AbortSignal.abort(), { lookup });
  assert.equal(cancelled.error, "Aborted");
});
await check("removed auth parameters fail explicitly", async () => {
  const { normalizeFetchContentParams } = await load("fetch-params.ts");
  assert.throws(() => normalizeFetchContentParams({ url: entry.url, auth: true }), /unavailable/);
  assert.throws(() => normalizeFetchContentParams({ url: entry.url, auth: "profile" }), /unavailable/);
});
await check("published fetch tool preserves cache retrieval, paging and page-answer mode", async () => {
  responseMode = "http";
  const result = await execute("fetch_content", { url: entry.url });
  assert.equal(result.details.successful, 1);
  const stored = await execute("get_search_content", { responseId: result.details.responseId, urlIndex: 0, offset: 0, limit: 1000 });
  assert.match(stored.content[0].text, /Fixture evidence/);
  const answered = await execute("fetch_content", { url: entry.url, mode: "answer", prompt: "Describe the fixture" });
  assert.equal(answered.details.successful, 1);
  assert.match(answered.content[0].text, /Fixture model answer/);
});
await check("published search and source-check tools produce retrievable results", async () => {
  responseMode = "search"; provider = "exa";
  const result = await execute("web_search", { query: "fixture", provider: "exa", workflow: "none" });
  assert(result.content.some(part => part.text?.includes("Fixture")));
  const evidence = await execute("source_check", { claim: "Fixture evidence", queries: ["fixture"], provider: "exa", fetchContent: false });
  assert(evidence.content.some(part => part.text?.includes("Fixture")));
});

let pdfFixture;
await check("local PDF text extraction works with native Promise.try and no shim", async () => {
  const content = "BT /F1 12 Tf 40 250 Td (Pi local PDF regression) Tj ET";
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${content.length} >>\nstream\n${content}\nendstream`];
  let pdf = "%PDF-1.4\n"; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const start = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => String(offset).padStart(10, "0") + " 00000 n \n").join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  const buffer = new TextEncoder().encode(pdf);
  pdfFixture = buffer.buffer.slice(0);
  const { extractPDFToMarkdown } = await load("pdf-extract.ts");
  const result = await extractPDFToMarkdown(buffer.buffer, "https://example.com/fixture.pdf", { outputDir: path.join(scratch, "pdf") });
  assert.equal(result.pages, 1);
  assert.match(result.content, /Pi local PDF regression/);
});
await check("automatic PDF extraction retains Gemini without contacting Datalab", async () => {
  const file = path.join(agentDir, "web-search.json");
  fs.writeFileSync(file, JSON.stringify({ ...config, pdf: { provider: "auto" } }));
  responseMode = "pdf-gemini"; requestedUrls.length = 0;
  try {
    const { extractPDFToMarkdown } = await load("pdf-extract.ts");
    const result = await extractPDFToMarkdown(pdfFixture, "https://example.com/fixture.pdf", { outputDir: path.join(scratch, "pdf-gemini") });
    assert.match(result.content, /API content/);
    assert(requestedUrls.some(url => url.includes(":generateContent")));
    assert(!requestedUrls.some(url => url.includes("datalab")));
  } finally { fs.writeFileSync(file, JSON.stringify(config)); }
});
await check("Datalab configuration is rejected and remaining PDF choices are retained", async () => {
  const file = path.join(agentDir, "web-search.json");
  const { loadPDFConfig, PDF_PROVIDER_VALUES } = await load("pdf-extract.ts");
  assert.deepEqual([...PDF_PROVIDER_VALUES].sort(), ["auto", "gemini", "unpdf"]);
  fs.writeFileSync(file, JSON.stringify({ ...config, pdf: { provider: "datalab" } }));
  try { assert.throws(() => loadPDFConfig(), /Unsupported pdf.provider/); }
  finally { fs.writeFileSync(file, JSON.stringify(config)); }
});
await check("remaining fetch routes retain Jina Reader and Parallel MCP, and reject removed backends", async () => {
  const file = path.join(agentDir, "web-search.json");
  const { extractContent } = await load("extract.ts");
  for (const name of ["tinyfish", "search1api", "querit", "kagi", "ollama", "parallel", "brightdata"]) {
    fs.writeFileSync(file, JSON.stringify({ ...config, fetchRouting: { providers: [name], allowRemoteHostedProviders: true } }));
    const result = await extractContent(entry.url, undefined, { lookup });
    assert.match(result.error, /invalid provider/);
  }
  fs.writeFileSync(file, JSON.stringify(config));
});
await check("Gemini URL context and YouTube API fallback remain functional", async () => {
  responseMode = "url-context";
  const { extractWithUrlContext } = await load("gemini-url-context.ts");
  const result = await extractWithUrlContext(entry.url);
  assert.equal(result.error, null);
  assert.match(result.content, /API content/);
  responseMode = "youtube";
  const { extractYouTube } = await load("youtube-extract.ts");
  const video = await extractYouTube("https://youtube.com/watch?v=dQw4w9WgXcQ");
  assert.equal(video.error, null);
  assert.match(video.content, /API content/);
});
await check("YouTube API failure no longer falls back to Perplexity", async () => {
  responseMode = "youtube-error"; requestedUrls.length = 0;
  const { extractYouTube } = await load("youtube-extract.ts");
  const result = await extractYouTube("https://youtube.com/watch?v=dQw4w9WgXcQ");
  assert(result.error);
  assert(!result.error.includes("Perplexity"));
  assert(!requestedUrls.some(url => url.includes("perplexity")));
});
const cliDir = path.join(scratch, "bin");
fs.mkdirSync(cliDir);
function cli(name, script) { fs.writeFileSync(path.join(cliDir, name), `#!${process.execPath}\n${script}\n`, { mode: 0o755 }); }
cli("ffmpeg", `process.stdout.write(Buffer.from(${JSON.stringify(pixel.toString("base64"))}, "base64"));`);
cli("ffprobe", 'process.stdout.write("2.0\\n");');
cli("yt-dlp", 'process.stdout.write("2.0\\nhttps://video.example.com/stream\\n");');
cli("git", 'const fs=require("node:fs"),path=require("node:path"),args=process.argv.slice(2); if(args.includes("clone")){const dest=args.at(-1);fs.mkdirSync(path.join(dest,".git"),{recursive:true});fs.writeFileSync(path.join(dest,"README.md"),"# Fixture repository\\nFixture GitHub content");}');
cli("gh", 'const args=process.argv.slice(2); if(args[0]==="repo"&&args[1]==="clone"){const fs=require("node:fs"),path=require("node:path"),dest=args[3];fs.mkdirSync(path.join(dest,".git"),{recursive:true});fs.writeFileSync(path.join(dest,"README.md"),"# Fixture repository\\nFixture GitHub content");}else if(args.includes(".size"))process.stdout.write("1"); else if(args.includes(".default_branch"))process.stdout.write("main"); else if(args.includes("pr")||args.includes("issue"))process.stdout.write(JSON.stringify({number:1,title:"Fixture PR",body:"Fixture GitHub discussion",state:"OPEN",url:"https://github.com/fixture/repository/pull/1",author:{login:"fixture"},comments:[],reviews:[],files:[],commits:[]}));else process.stdout.write("gh version fixture");');
process.env.PATH = cliDir + path.delimiter + process.env.PATH;
await check("local video API upload, processing and CLI frame extraction remain functional", async () => {
  responseMode = "local-video";
  const file = path.join(scratch, "fixture.mp4"); fs.writeFileSync(file, "fixture");
  const video = await load("video-extract.ts");
  const info = video.isVideoFile(file);
  const result = await video.extractVideo(info);
  assert.equal(result.error, null);
  assert.match(result.content, /Fixture video API content/);
  assert.equal(await video.getLocalVideoDuration(file), 2);
  assert((await video.extractVideoFrame(file, 1)).data.length > 0);
  const youtube = await load("youtube-extract.ts");
  assert((await youtube.getYouTubeStreamInfo("dQw4w9WgXcQ")).streamUrl);
  assert((await youtube.extractYouTubeFrame("dQw4w9WgXcQ", 1)).data.length > 0);
});
await check("GitHub repository and PR extraction retain their specialized views", async () => {
  const git = await load("github-extract.ts");
  const repo = await git.extractGitHub("https://github.com/fixture/repository");
  assert.equal(repo.error, null);
  assert.match(repo.content, /Fixture GitHub content/);
  const { extractGitHubIssuePr } = await load("github-issue-pr.ts");
  const pr = await extractGitHubIssuePr("https://github.com/fixture/repository/pull/1");
  assert.equal(pr.error, null);
  assert.match(pr.content, /Fixture PR/);
});
await check("page answering and curator summaries respect the Pi model registry", async () => {
  const { answerFromPage } = await load("page-query.ts");
  const answer = await answerFromPage({ question: "What is the fixture?", pageText: html, sourceUrl: entry.url }, ctx);
  assert.equal(answer.text, "Fixture model answer");
  const { generateSummaryDraft } = await load("summary-review.ts");
  const summary = await generateSummaryDraft([{ query: "fixture", answer: "Fixture evidence", results: [entry] }], ctx);
  assert(summary.summary.length > 0);
});
await check("stored content, paging, find and source-check artifacts survive", async () => {
  const storage = await load("storage.ts");
  const data = storage.storeFetchedContentResult("fixture-result", { id: "fixture-result", type: "fetch", timestamp: Date.now(), urls: [{ url: entry.url, title: entry.title, content: html, error: null }] });
  assert.equal(data.type, "fetch");
  assert.match(storage.getResult("fixture-result").urls[0].content, /Fixture evidence/);
  const { findContent } = await load("content-find.ts");
  assert(findContent(html, ["Fixture evidence"], "case-insensitive").matchCount > 0);
  const { buildResearchArtifact } = await load("source-check.ts");
  const artifact = buildResearchArtifact({ query: "fixture", results: [entry], fetched: [], provider: "exa" });
  assert(artifact.id);
  assert(artifact.sources.length > 0);
});
await check("real Pi sessions expose all four tools immediately and on older branches", async () => {
  const sdk = await import(pathToFileURL(path.join(sdkRoot, "dist/index.js")));
  const settingsManager = sdk.SettingsManager.inMemory({ packages: [root] });
  const loader = new sdk.DefaultResourceLoader({ cwd: scratch, agentDir, settingsManager, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload();
  const sessionManager = sdk.SessionManager.inMemory(scratch);
  const { session } = await sdk.createAgentSession({ cwd: scratch, agentDir, settingsManager, resourceLoader: loader, sessionManager, model: ctx.model });
  const webNames = ["web_search", "source_check", "fetch_content", "get_search_content"];
  const errors = [];
  const assertVisible = () => {
    for (const name of webNames) {
      assert(session.getActiveToolNames().includes(name), `${name} must be declared to the model`);
      assert(session.getCallableToolNames().includes(name), `${name} must be callable`);
      const declared = session.agent.state.tools.find(tool => tool.name === name);
      assert(declared.description.length > 0, `${name} must have a model-visible description`);
      assert.equal(declared.parameters.type, "object");
    }
    assert(!session.getAllTools().some(tool => tool.name === "web_enable"));
    assert.deepEqual(errors, []);
  };
  try {
    assertVisible();
    // Simulate a resumed legacy loadout with no web tools.
    session.setActiveToolsByName(["read"]);
    await session.bindExtensions({ onError: error => errors.push(error) });
    assertVisible();
    const read = session.agent.state.tools.find(tool => tool.name === "read");
    const oldBranch = sessionManager.appendMessage({ role: "system", content: "Legacy branch", timestamp: Date.now(), toolsAdded: [{ name: read.name, description: read.description, parameters: read.parameters }] });
    sessionManager.appendMessage({ role: "user", content: "Later branch", timestamp: Date.now() });
    await session.navigateTree(oldBranch);
    assertVisible();
    assert(session.getActiveToolNames().includes("read"));
  } finally { session.dispose(); }
});
await check("curator still renders Baizhi/Z.ai and accepts a token-checked submission", async () => {
  const { startCuratorServer } = await load("curator-server.ts");
  const availability = Object.fromEntries(search.RESOLVED_SEARCH_PROVIDERS.map(name => [name, true]));
  let submitted;
  const server = await startCuratorServer({ queries: [], sessionToken: "fixture-token", timeout: 60, availableProviders: { all: true, ...availability }, defaultProvider: "exa", searchProvider: "auto", summaryModels: [], defaultSummaryModel: null }, { onSubmit: value => { submitted = value; }, onCancel() {}, onProviderChange() {}, onAddSearch: async () => [], onSummarize: async () => ({ summary: "Fixture summary", meta: {} }), onRewriteQuery: async value => value });
  try {
    const page = await nativeFetch(server.url);
    const body = await page.text();
    assert.match(body, /Baizhi/); assert.match(body, /Z\.ai/);
    assert(!body.includes("google-account"));
    for (const name of ["brave", "parallel", "tinyfish", "querit", "perplexity", "mistral", "brightdata"]) assert(!body.includes(`data-provider="${name}"`));
    const submitUrl = new URL("/submit", server.url);
    const rejected = await nativeFetch(submitUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "wrong", selected: [] }) });
    assert.equal(rejected.status, 403);
    const accepted = await nativeFetch(submitUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "fixture-token", selected: [], summary: "Fixture summary" }) });
    assert.equal(accepted.status, 200);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(submitted.summary, "Fixture summary");
  } finally { server.close(); }
});
console.log(`Pi web-access regression suite: ${passed} checks passed, ${failures.length} failed; fixtures make no external service or model requests.`);
