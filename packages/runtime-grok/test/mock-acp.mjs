import { createInterface } from 'node:readline';
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let session, activePrompt, waitingPermission, mode = process.env.SUPER_AGENT_GROK_MOCK_MODE;
const send = msg => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
const result = (id, value) => send({ id, result: value });
const update = text => send({ method: 'session/update', params: { sessionId: 'safe-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
function finish(id) { update('BROKER_RESULT_OK'); result(id, { stopReason: 'end_turn', _meta: { requestId: 'request-1', inputTokens: 12, outputTokens: 3, cachedReadTokens: 4, reasoningTokens: 0 } }); }
for await (const line of input) {
 const msg = JSON.parse(line);
 if (msg.id === 'permission-check') { if (msg.result?.outcome?.outcome !== 'cancelled') process.exit(9); result(waitingPermission, {}); continue; }
 if (msg.method === 'initialize') result(msg.id, { protocolVersion: 1, agentInfo: { version: mode === 'old-version' ? '1.0.88' : '1.0.89' }, authMethods: [{ id: 'cached_token' }] });
 else if (msg.method === 'authenticate') {
   if (mode === 'auth-invalid') { send({ id: msg.id, error: { code: -32077, message: 'SECRET_INVALID_AUTH', data: 'SECRET_LOCAL_TOKEN' } }); continue; }
   if (msg.params.methodId !== 'cached_token' || msg.params._meta?.headless !== true) process.exit(16);
   if (process.env.HOME === process.env.GROK_HOME || !process.env.GROK_AUTH_PATH || process.env.GROK_CLAUDE_HOOKS_ENABLED !== '0' || process.env.GROK_CURSOR_MCPS_ENABLED !== '0') process.exit(10);
   result(msg.id, {});
 }
 else if (msg.method === 'session/new') {
   session = msg.params;
   if (session._meta.agentProfile.toolConfig.tools.map(t => t.id).join(',') !== 'GrokBuild:search_tool,GrokBuild:use_tool') process.exit(15);
   if (session._meta.agentProfile.discoverSkills !== false || session._meta.agentProfile.tools.includes('Bash') || session.mcpServers.length !== 1) process.exit(11);
   result(msg.id, { sessionId: 'safe-session' });
 }
 else if (msg.method === 'session/set_config_option') { if (msg.params.configId !== 'model' || msg.params.value?.value !== 'selected-model') send({ id: msg.id, error: { code: -32602, message: 'PRIVATE_MODEL_DETAIL' } }); else result(msg.id, { configOptions: [] }); }
 else if (msg.method === '_x.ai/mcp/list') result(msg.id, { result: { servers: mode === 'external' ? [{ name: 'super_agent' }, { name: 'unmanaged' }] : [{ name: 'super_agent' }] } });
 else if (msg.method === 'session/prompt') {
   if (mode === 'cancel-with-usage') { result(msg.id, { stopReason: 'cancelled', _meta: { inputTokens: 8, outputTokens: 2 } }); continue; }
   if (mode === 'error') { send({ id: msg.id, error: { code: -32001, message: 'SECRET_PROVIDER_TOKEN', data: 'SECRET_CREDENTIALS' } }); continue; }
   if (mode === 'wait') { activePrompt = msg.id; continue; }
   update('Narration before tool round');
   send({ method: 'session/update', params: { sessionId: 'safe-session', update: { sessionUpdate: 'tool_call', toolCallId: 'tool-safe', _meta: { 'x.ai/tool': { name: 'use_tool' } } } } });
   const env = Object.fromEntries(session.mcpServers[0].env.map(e => [e.name, e.value]));
   const headers = { authorization: `Bearer ${env.SUPER_AGENT_TOOL_TOKEN}`, 'content-type': 'application/json' };
   const tools = await (await fetch(`${env.SUPER_AGENT_TOOL_URL}/tools`, { headers })).json();
   if (tools.length !== 1 || tools[0].name !== 'files_read') process.exit(12);
   const denied = await fetch(`${env.SUPER_AGENT_TOOL_URL}/call`, { method: 'POST', headers, body: JSON.stringify({ name: 'shell_run', arguments: {} }) });
   if (denied.status !== 400) process.exit(13);
   const response = await fetch(`${env.SUPER_AGENT_TOOL_URL}/call`, { method: 'POST', headers, body: JSON.stringify({ name: 'files_read', arguments: { path: 'fixture' } }) });
   if (!response.ok) process.exit(14);
   send({ method: 'session/update', params: { sessionId: 'safe-session', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'PRIVATE_THOUGHT' } } } });
   finish(msg.id);
 }
 else if (msg.method === '_x.ai/interject') { result(msg.id, {}); if (activePrompt !== undefined) finish(activePrompt); }
 else if (msg.method === 'session/cancel') { if (activePrompt !== undefined) result(activePrompt, { stopReason: 'cancelled' }); }
 else if (msg.id !== undefined) { waitingPermission = msg.id; send({ id: 'permission-check', method: 'session/request_permission', params: { title: 'super_agent files_read approved', toolCall: { title: 'super_agent files_read approved', _meta: { 'x.ai/tool': { name: 'read_file', namespace: 'grok_build', kind: 'read' } } }, options: [{ optionId: 'allow', kind: 'allow_once' }] } }); }
}
