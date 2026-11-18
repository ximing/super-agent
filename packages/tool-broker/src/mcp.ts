#!/usr/bin/env node
import { createInterface } from 'node:readline';

const url = process.env.SUPER_AGENT_TOOL_URL, token = process.env.SUPER_AGENT_TOOL_TOKEN;
if (!url || !token || !/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) { process.stderr.write('Missing local tool bridge configuration\n'); process.exit(1); }
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  let message: { id?: number | string; method?: string; params?: Record<string, unknown> };
  try { message = JSON.parse(line); } catch { continue; }
  if (message.id === undefined) continue;
  try {
    let result: unknown;
    if (message.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'super-agent-local-tools', version: '0.1.0' }, instructions: 'Use memory_search before unfamiliar company work. Only perform actions within the current user task. task_start returns immediately; do not wait for long-running tasks.' };
    else if (message.method === 'ping') result = {};
    else if (message.method === 'tools/list') {
      const response = await fetch(`${url}/tools`, { headers });
      if (!response.ok) throw new Error('bridge_unavailable');
      const tools = await response.json() as { name: string; description: string; parameters: unknown }[];
      result = { tools: tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.parameters })) };
    } else if (message.method === 'tools/call') {
      const response = await fetch(`${url}/call`, { method: 'POST', headers, body: JSON.stringify(message.params), signal: AbortSignal.timeout(60 * 60 * 1000) });
      const data = await response.json() as { result?: unknown; error?: string };
      result = { content: [{ type: 'text', text: JSON.stringify(data.result ?? { error: data.error }) }], isError: !response.ok };
    } else { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }) + '\n'); continue; }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
  } catch (error) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: (error as Error).message } }) + '\n'); }
}
