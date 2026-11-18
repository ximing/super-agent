import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexRuntime, CodexRpc } from '../src/index.js';
import type { RuntimeContext, RuntimeEvent } from '@super-agent/tool-broker/runtime';
const script = `
import {createInterface} from 'node:readline';
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
for await(const line of createInterface({input:process.stdin})){
 const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{userAgent:'mock'}});
 if(m.method==='thread/start'){
  if(!m.params.dynamicTools?.length)send({id:m.id,error:{code:-1,message:'No tools'}});
  else send({id:m.id,result:{thread:{id:'thread1'}}});
 }
 if(m.method==='turn/start'){
  send({id:m.id,result:{turn:{id:'turn1'}}});
  send({method:'turn/started',params:{threadId:'thread1',turn:{id:'turn1'}}});
  send({id:900,method:'item/tool/call',params:{threadId:'thread1',tool:'memory_search',arguments:{query:'release'}}});
 }
 if(m.id===900&&m.result){
  if(!m.result.success)process.exit(4);
  send({method:'thread/tokenUsage/updated',params:{threadId:'thread1',turnId:'turn1',tokenUsage:{last:{inputTokens:10,cachedInputTokens:2,outputTokens:3,reasoningOutputTokens:1},total:{inputTokens:500}}}});
  send({method:'item/completed',params:{threadId:'thread1',item:{type:'agentMessage',text:'Local tool result received'}}});
  send({method:'turn/completed',params:{threadId:'thread1',turn:{id:'turn1',status:'completed'}}});
 }
 if(m.method==='turn/interrupt'){send({id:m.id,result:{}});send({method:'turn/completed',params:{threadId:'thread1',turn:{id:'turn1',status:'interrupted'}}});}
}
`;

test('Codex stdio handshake, dynamic tool bridge and last-turn usage mapping', async () => {
  const events: RuntimeEvent[] = [], tools: string[] = [];
  const context: RuntimeContext = { runId: 'r1', taskId: 't1', goal: 'Use local tool', modelId: 'mock-model', cwd: '/tmp', signal: new AbortController().signal,
    tools: [{ name: 'memory_search', description: 'Search', parameters: { type: 'object' } }],
    executeTool: async (name, args) => { tools.push(name); assert.equal(args.query, 'release'); return { source: 'cloud-memory' }; }, emit: event => { events.push(event); } };
  const runtime = new CodexRuntime({ command: process.execPath, args: ['--input-type=module', '-e', script], timeoutMs: 2000, maxRunMs: 5000 });
  const result = await runtime.execute(context);
  assert.equal(result.text, 'Local tool result received'); assert.deepEqual(tools, ['memory_search']);
  const usage = events.find(e => e.type === 'usage'); assert.ok(usage?.type === 'usage');
  assert.equal(usage.usage.input_tokens, 10); assert.equal(usage.usage.cached_input_tokens, 2);
  assert.deepEqual(result.binding, { thread_id: 'thread1', turn_id: 'turn1' });
});

test('JSON-RPC timeout closes pending request without returning fabricated success', async () => {
  const rpc = new CodexRpc(process.execPath, ['--input-type=module', '-e', "process.stdin.resume(); process.stdin.on('end',()=>process.exit(0));"], 50);
  try { await assert.rejects(rpc.request('never-answered'), /codex_rpc_timeout/); } finally { await rpc.close(); }
});
