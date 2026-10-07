# Local Pi Web Access

This local build requires Node 24 or newer (Pi's Nix package uses Node 24).
It retains local PDF extraction, Gemini API/ADC, videos, GitHub extraction,
the curator, source checking, and these 12 search providers: OpenAI, Exa,
Gemini API/ADC, Kimi, xAI, Baizhi, Z.ai, DuckDuckGo, AnySearch, Parallel MCP,
SearXNG and Firecrawl.

The four web tools are available directly from the first model request,
including after session restoration or navigation to an older branch.
The loader tool and activation modes have been removed. Explicit per-tool
disabling and alternate tool names remain supported.

Removed capabilities:

- The `Promise.try` compatibility package and its legacy-PDF shim.
- Gemini Web, Chromium cookie extraction, browser-cookie authenticated fetch,
  and `/google-account`. An old `fetch_content({ auth: ... })` request is rejected.
- The runtime MCP SDK npm package, its server components and unused dependencies.
- Brave, Parallel HTTP, TinyFish, Search1API, Searchinfinity, Querit, Tavily,
  You.com, Jina Search, SERPdive, Kagi, Bocha, Ollama cloud search, Perplexity,
  XCrawl, Valyu, Mistral search, Bright Data, SerpBase, SerpApi, Serper and Serply.
- Datalab remote PDF extraction, associated configuration and the Perplexity
  text-summary fallback for YouTube.

Parallel MCP retains anonymous access and its optional key. Jina Reader's
webpage extraction is retained separately from the removed Jina Search.
Remaining webpage fetch paths are HTTP, Firecrawl, Crawl4AI, Jina Reader,
Parallel MCP and Gemini URL context. PDF auto mode now tries Gemini then
local unpdf. Explicit configuration of a removed search/fetch/PDF provider
is rejected rather than silently sending the request to a different service.

Baizhi and Z.ai retain their original authentication, discovery, search,
timeouts, cancellation and session cleanup. They dynamically load
`mcp-client.ts`, a local client bundle exporting `Client` and
`StreamableHTTPClientTransport` from MCP SDK 1.27.1. The bundle was generated
with esbuild 0.27.2 (`--bundle --format=esm --platform=node --target=node24
--minify --keep-names`) from those two upstream entry points. All ten included
packages' license texts are preserved in `MCP-LICENSES.txt`.

Home Manager builds `dist` from the current local TypeScript using
`scripts/build.mjs`, then runs the regression suite. Dependencies are pinned
directly in `../pi-web-access.nix`; no separate dependency manifest or npm
installation is used. The original README below describes the upstream package;
its instructions for the removed services do not apply to this local build.

Local revision 0.35.0-local.4 isolates foreground and stored results across session/branch changes, avoids permanent RAM copies of disk-backed pages, bounds fuzzy edit-distance work, identifies stored results by complete IDs, and fixes curator UTF-8/POST/disconnect handling. Proxy fetch supports Request objects and HEAD, survives reload, honors NO_PROXY ports and all loopbacks, stores credentials in private curl config files, bounds proxy responses to 32 MiB, rejects partial curl failures, and cleans temporary files on errors. Redirects release bodies and strip credentials/body headers as appropriate; policy reads fail closed and detect atomic replacements.
