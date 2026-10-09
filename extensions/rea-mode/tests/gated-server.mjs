// Real stdio JSON-RPC fixture: process markers prove cancellation, not just registry hiding.
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const [mode, marker] = process.argv.slice(2);
const mark = (event) => appendFileSync(marker, `${JSON.stringify({ event, pid: process.pid })}\n`);
mark('spawn');
const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
process.on('SIGTERM', () => { mark('SIGTERM'); process.exit(0); });
// Deliberately survive stdin EOF until SIGTERM: prove the transport terminates the process group.
process.stdin.on('end', () => mark('stdin-end'));
setInterval(() => {}, 1000);
createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (!('id' in request)) return;
  mark(request.method);
  switch (request.method) {
    case 'initialize':
      if (mode !== 'init-gated') reply(request.id, {
        protocolVersion: request.params.protocolVersion,
        serverInfo: { name: 'rea-regression', version: '1' }, capabilities: { tools: {} },
      });
      break;
    case 'tools/list':
      if (mode !== 'list-gated') reply(request.id, { tools: [
        { name: 'healthy', description: 'regression fixture', inputSchema: { type: 'object', properties: {} } },
      ] });
      break;
    default: reply(request.id, {});
  }
});
