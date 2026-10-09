// Regenerate source/dist patches from the EXACT 1.0.3 inputs; never writes outside this extension.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = process.argv[2] ?? '/nix/store/ybsnz4v6fzl73dx2alwimf9518cry6ny-source';
const sdk = process.argv[3] ?? '/nix/store/y2vvpsg9c2rq0mrgmc1s6dq64376k8lp-pi-coding-agent-1.0.3/lib/node_modules/pi-monorepo';
const work = resolve(root, 'tests/.generated');
await mkdir(work, { recursive: true });
function replace(text, old, next) {
  if (text.split(old).length !== 2) throw new Error(`Expected unique original: ${old.slice(0, 120)}`);
  return text.replace(old, next);
}
function hardenIndex(text, ts) {
  if (ts) {
    text = replace(text, '\t\t\tconst server = connection.entry.name;\n\t\t\tconst entry =', '\t\t\tconst server = connection.entry.name;\n\t\t\t// Withdrawn/replaced connections cannot publish late tool definitions.\n\t\t\tif (!sessionActive || findServer(server)?.connection !== connection) return;\n\t\t\tconst entry =');
    text = replace(text, '\t\tconst onConnectionChange = (connection: McpServerConnection) => {\n', '\t\tconst onConnectionChange = (connection: McpServerConnection) => {\n\t\t\tif (findServer(connection.name)?.connection !== connection) return;\n');
    text = replace(text, '\t\tconst createConnection = async (server: McpServer): Promise<McpServerConnection> => {\n\t\t\tconst runtime = await loadMcpRuntime();', '\t\tconst createConnection = async (\n\t\t\tserver: McpServer,\n\t\t\tisCurrent: () => boolean,\n\t\t): Promise<McpServerConnection | undefined> => {\n\t\t\tconst runtime = await loadMcpRuntime();\n\t\t\t// The server may have been unregistered during the lazy import.\n\t\t\tif (!isCurrent()) return undefined;');
    text = replace(text, '\t\t): Promise<void> => {\n\t\t\tconst ready = (async () => {\n\t\t\t\tawait after;\n\t\t\t\tif (!isCurrent()) return;\n\t\t\t\tconst connection = await createConnection(server);\n\t\t\t\tif (!isCurrent()) return;', '\t\t): Promise<void> => {\n\t\t\tconst stillCurrent = () => isCurrent() && sessionActive && servers.includes(server) && isEnabled(server);\n\t\t\tconst ready = (async () => {\n\t\t\t\tawait after;\n\t\t\t\tif (!stillCurrent()) return;\n\t\t\t\tconst connection = await createConnection(server, stillCurrent);\n\t\t\t\tif (!connection) return;\n\t\t\t\tif (!stillCurrent()) {\n\t\t\t\t\tawait connection.close();\n\t\t\t\t\treturn;\n\t\t\t\t}');
  } else {
    text = replace(text, '            const server = connection.entry.name;\n            const entry =', '            const server = connection.entry.name;\n            // Withdrawn/replaced connections cannot publish late tool definitions.\n            if (!sessionActive || findServer(server)?.connection !== connection)\n                return;\n            const entry =');
    text = replace(text, '        const onConnectionChange = (connection) => {\n', '        const onConnectionChange = (connection) => {\n            if (findServer(connection.name)?.connection !== connection)\n                return;\n');
    text = replace(text, '        const createConnection = async (server) => {\n            const runtime = await loadMcpRuntime();', '        const createConnection = async (server, isCurrent) => {\n            const runtime = await loadMcpRuntime();\n            // The server may have been unregistered during the lazy import.\n            if (!isCurrent())\n                return undefined;');
    text = replace(text, '        const startConnection = (server, isCurrent, after) => {\n            const ready = (async () => {\n                await after;\n                if (!isCurrent())\n                    return;\n                const connection = await createConnection(server);\n                if (!isCurrent())\n                    return;', '        const startConnection = (server, isCurrent, after) => {\n            const stillCurrent = () => isCurrent() && sessionActive && servers.includes(server) && isEnabled(server);\n            const ready = (async () => {\n                await after;\n                if (!stillCurrent())\n                    return;\n                const connection = await createConnection(server, stillCurrent);\n                if (!connection)\n                    return;\n                if (!stillCurrent()) {\n                    await connection.close();\n                    return;\n                }');
  }
  return text;
}
function hardenRuntime(text, ts) {
  const indent = ts ? '\t' : '    ';
  const field = ts ? '\tprivate opening: Promise<McpClient> | undefined;\n' : '    opening;\n';
  const fields = ts
    ? '\tprivate pendingConnection: { client: McpClient; transport?: McpTransport; attached: boolean } | undefined;\n\tprivate closing: Promise<void> | undefined;\n\tprivate readonly clientClosures = new WeakMap<McpClient, Promise<void>>();\n\tprivate readonly inflightClosures = new Set<Promise<void>>();\n'
    : '    pendingConnection;\n    closing;\n    clientClosures = new WeakMap();\n    inflightClosures = new Set();\n';
  text = replace(text, field, field + fields);
  const oldDrop = ts
    ? '\t\tawait client.close().catch(() => undefined);\n\t}\n\n\tprivate async open()'
    : '        await client.close().catch(() => undefined);\n    }\n    async open()';
  const closeHelper = ts
    ? '\t\tawait this.closeClient(client);\n\t}\n\n\t/** Share teardown by client identity; a stale close never detaches a replacement. */\n\tprivate closeClient(client: McpClient): Promise<void> {\n\t\tlet closing = this.clientClosures.get(client);\n\t\tif (!closing) {\n\t\t\tclosing = client.close().catch(() => undefined);\n\t\t\tthis.clientClosures.set(client, closing);\n\t\t\tthis.inflightClosures.add(closing);\n\t\t\tconst finished = closing;\n\t\t\tvoid finished.then(() => this.inflightClosures.delete(finished));\n\t\t}\n\t\treturn closing;\n\t}\n\n\tprivate async open()'
    : '        await this.closeClient(client);\n    }\n    /** Share teardown by client identity; a stale close never detaches a replacement. */\n    closeClient(client) {\n        let closing = this.clientClosures.get(client);\n        if (!closing) {\n            closing = client.close().catch(() => undefined);\n            this.clientClosures.set(client, closing);\n            this.inflightClosures.add(closing);\n            const finished = closing;\n            void finished.then(() => this.inflightClosures.delete(finished));\n        }\n        return closing;\n    }\n    async open()';
  text = replace(text, oldDrop, closeHelper);
  const marker = ts ? '\t\tconst log = this.log;\n' : '        const log = this.log;\n';
  text = replace(text, marker, (ts
    ? '\t\tconst attempt: NonNullable<McpServerConnection["pendingConnection"]> = { client, attached: false };\n\t\tthis.pendingConnection = attempt;\n'
    : '        const attempt = { client, attached: false };\n        this.pendingConnection = attempt;\n') + marker);
  const before = ts
    ? '\t\t\ttransport = this.createTransport(this.entry, this.cwd, this.authProvider);\n\t\t\tawait client.connect(transport);'
    : '            transport = this.createTransport(this.entry, this.cwd, this.authProvider);\n            await client.connect(transport);';
  const guarded = [
    'if (this.closed || this.pendingConnection !== attempt) throw new Error("shut down while connecting");',
    'transport = this.createTransport(this.entry, this.cwd, this.authProvider);',
    'attempt.transport = transport;',
    'if (this.closed || this.pendingConnection !== attempt) throw new Error("shut down while connecting");',
    'attempt.attached = true;',
    'await client.connect(transport);',
    'if (this.closed || this.pendingConnection !== attempt) throw new Error("shut down while connecting");',
  ].map(line => indent.repeat(3) + line).join('\n');
  text = replace(text, before, guarded);
  // The setup/tools-list continuation checks BOTH terminal revocation and attempt identity.
  text = replace(text, ts
    ? '\t\t\tif (this.closed) throw new Error("shut down while connecting");'
    : '            if (this.closed)\n                throw new Error("shut down while connecting");', ts
    ? '\t\t\tif (this.closed || this.pendingConnection !== attempt) throw new Error("shut down while connecting");'
    : '            if (this.closed || this.pendingConnection !== attempt)\n                throw new Error("shut down while connecting");');
  const catchClose = indent.repeat(3) + 'await client.close().catch(() => undefined);';
  text = replace(text, catchClose, (ts
    ? '\t\t\tif (!attempt.attached) await transport?.close().catch(() => undefined);\n'
    : '            if (!attempt.attached)\n                await transport?.close().catch(() => undefined);\n') + indent.repeat(3) + 'await this.closeClient(client);');
  text = replace(text, ts
    ? '\t\t\tthrow error;\n\t\t}\n\t}\n\n\tprivate connectFailed'
    : '            throw error;\n        }\n    }\n    connectFailed', ts
    ? '\t\t\tthrow error;\n\t\t} finally {\n\t\t\tif (this.pendingConnection === attempt) this.pendingConnection = undefined;\n\t\t}\n\t}\n\n\tprivate connectFailed'
    : '            throw error;\n        } finally {\n            if (this.pendingConnection === attempt)\n                this.pendingConnection = undefined;\n        }\n    }\n    connectFailed');
  text = replace(text, ts
    ? '\tprivate markNeedsAuth(): void {\n'
    : '    markNeedsAuth() {\n', ts
    ? '\tprivate markNeedsAuth(): void {\n\t\tif (this.closed) return;\n'
    : '    markNeedsAuth() {\n        if (this.closed)\n            return;\n');
  const closeStart = ts ? '\tasync close(): Promise<void> {' : '    async close() {';
  const start = text.indexOf(closeStart);
  if (start < 0) throw new Error('missing terminal close');
  const suffix = ts ? '\n}\n' : '\n}\n//# sourceMappingURL=runtime.js.map';
  if (!text.endsWith(suffix)) throw new Error('unexpected runtime suffix');
  const lines = [
    closeStart,
    indent.repeat(2) + 'if (this.closing) return this.closing;',
    indent.repeat(2) + 'this.closed = true;',
    indent.repeat(2) + 'this.state = "closed";',
    indent.repeat(2) + 'const pending = this.pendingConnection;',
    indent.repeat(2) + 'const clients = new Set([this.client, pending?.client]);',
    indent.repeat(2) + 'this.client = undefined;',
    indent.repeat(2) + 'this.pendingConnection = undefined;',
    indent.repeat(2) + '// Do not await opening: initialize/tools/list can be blocked until we close its client.',
    indent.repeat(2) + 'this.closing = Promise.all([',
    indent.repeat(3) + '...this.inflightClosures,',
    indent.repeat(3) + '...Array.from(clients, (client) => client ? this.closeClient(client) : undefined),',
    indent.repeat(3) + 'pending && !pending.attached ? pending.transport?.close().catch(() => undefined) : undefined,',
    indent.repeat(2) + ']).then(async () => {',
    indent.repeat(3) + '// Preserve OAuth refresh-token writes, independently of the cancelled opening.',
    indent.repeat(3) + 'await this.authProvider?.settled();',
    indent.repeat(2) + '});',
    indent.repeat(2) + 'this.changed();',
    indent.repeat(2) + 'return this.closing;',
    indent + '}',
  ];
  return text.slice(0, start) + lines.join('\n') + suffix;
}

const patches = { source: '', dist: '' };
for (const [kind, base, prefix, ts] of [
  ['source', source, 'packages/coding-agent/src/extensions/mcp', true],
  ['dist', sdk, 'dist/extensions/mcp', false],
]) {
  for (const name of ['index', 'runtime']) {
    const path = `${prefix}/${name}.${ts ? 'ts' : 'js'}`;
    const old = await readFile(resolve(base, path), 'utf8');
    const next = name === 'index' ? hardenIndex(old, ts) : hardenRuntime(old, ts);
    const oldFile = resolve(work, `${kind}-${name}.old`), nextFile = resolve(work, `${kind}-${name}.${ts ? 'ts' : 'js'}`);
    await writeFile(oldFile, old); await writeFile(nextFile, next);
    const diff = spawnSync('diff', ['-u', '--label', `a/${path}`, '--label', `b/${path}`, oldFile, nextFile], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
    if (diff.status !== 1) throw new Error(diff.stderr || 'expected a diff');
    patches[kind] += diff.stdout;
  }
}
await writeFile(resolve(root, 'native-mcp-source-hardening.patch'), patches.source);
await writeFile(resolve(root, 'native-mcp-hardening.patch'), patches.dist);
console.log('Generated source and dist patches from exact inputs. Build/runtime validation is separate.');
