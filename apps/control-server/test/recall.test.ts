import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AgentRecallAdapter } from '../src/recall.js';
import { ApiError, type Doc, type Tx } from '../src/store.js';

function localTx(tenant=randomUUID()):Tx{
  const tables=new Map<string,Map<string,Doc>>();
  const table=(name:string)=>{if(!tables.has(name))tables.set(name,new Map());return tables.get(name)!;};
  return{tenant,get:async(name:string,id:string)=>table(name).get(id)??null,all:async(name:string)=>[...table(name).values()],remove:async(name:string,id:string)=>{table(name).delete(id);},put:async(name:string,doc:Doc,id:string=doc.id??randomUUID())=>{const value={...doc,id,version:(table(name).get(id)?.version??0)+1,created_at:new Date().toISOString(),updated_at:new Date().toISOString()};table(name).set(id,value);return value;}} as unknown as Tx;
}
function upstream(){
  const aId=randomUUID(),bId=randomUUID(),memoryId=randomUUID(),calls:Doc[]=[];
  const rows=new Map<string,Doc[]>([['alice',[{id:memoryId,content:'已有个人知识：发布平台入口',type:'fact',tags:['existing'],version:2,chainId:memoryId,project:null,updatedAt:'2026-11-18T12:00:00Z'}]],['bob',[]]]);
  const mocked=(async(input:URL|string|Request,init?:RequestInit)=>{
    const url=new URL(String(input)),token=new Headers(init?.headers).get('authorization')?.replace('Bearer ',''),who=token==='alice-pat'||token==='alice-pat-2'?'alice':token==='bob-pat'?'bob':null;
    calls.push({path:url.pathname,method:init?.method??'GET',who,body:init?.body?JSON.parse(String(init.body)):null});
    if(!who)return Response.json({error:'unauthorized'},{status:401});
    if(url.pathname==='/api/auth/me')return Response.json({user:{id:who==='alice'?aId:bId,email:`${who}@example.com`}});
    const memories=rows.get(who)!;
    if(url.pathname==='/api/memories/recall')return Response.json({memories});
    if(url.pathname==='/api/memories'&&init?.method==='POST'){
      const value=JSON.parse(String(init.body)),id=randomUUID(),m={...value,id,version:1,chainId:id,updatedAt:new Date().toISOString()};memories.push(m);return Response.json({memory:m});
    }
    if(url.pathname==='/api/memories')return Response.json({memories:url.searchParams.has('tags')?memories.filter(m=>m.tags?.includes(url.searchParams.get('tags'))):memories});
    const id=url.pathname.split('/').at(-1),found=memories.find(m=>m.id===id);
    if(!found)return Response.json({error:'not found'},{status:404});
    if(init?.method==='PATCH'){
      const data=JSON.parse(String(init.body)),next={...found,...data,id:randomUUID(),version:found.version+1};rows.set(who,memories.filter(m=>m.id!==id).concat(next));return Response.json({memory:next});
    }
    if(init?.method==='DELETE'){rows.set(who,memories.filter(m=>m.id!==id));return new Response(null,{status:204});}
    return Response.json({memory:found});
  }) as typeof fetch;
  return{mocked,calls,memoryId};
}

test('Recall binding encrypts each user PAT with tenant AAD and never returns it',async()=>{
  const mock=upstream(),adapter=new AgentRecallAdapter({encryptionKey:'a-private-test-encryption-key',fetch:mock.mocked}),tx=localTx();
  assert.equal((await adapter.settings(tx)).configured,false);
  const result=await adapter.bind(tx,{url:'https://recall.aimo.plus',token:'alice-pat',project:'alpha'});
  assert.equal(result.configured,true);assert.equal(result.project,'alpha');assert.equal(result.account.email,'alice@example.com');assert.equal(JSON.stringify(result).includes('alice-pat'),false);
  const kept=await adapter.bind(tx,{url:'https://recall.aimo.plus',token:'alice-pat-2'});
  assert.equal(kept.project,'alpha');
  const changed=await adapter.bind(tx,{url:'https://recall.aimo.plus',token:'alice-pat-2',project:'beta'});
  assert.equal(changed.project,'beta');
  const cleared=await adapter.bind(tx,{url:'https://recall.aimo.plus',token:'alice-pat-2',project:null});
  assert.equal(cleared.project,null);
  const stored=await tx.get('memory_bindings',tx.tenant);assert.ok(stored?.secret);assert.equal(JSON.stringify(stored).includes('alice-pat'),false);
  assert.throws(()=>adapter.decrypt(randomUUID(),stored!.secret),error=>error instanceof ApiError&&error.code==='recall_binding_unavailable');
  assert.equal(adapter.decrypt(tx.tenant,stored!.secret),'alice-pat-2');
});

test('separate Recall bindings read existing authoritative records without modifying them',async()=>{
  const mock=upstream(),adapter=new AgentRecallAdapter({encryptionKey:'test-private-key',fetch:mock.mocked}),a=localTx(),b=localTx();
  await adapter.bind(a,{url:'https://recall.aimo.plus',token:'alice-pat'});await adapter.bind(b,{url:'https://recall.aimo.plus',token:'bob-pat'});
  const existing=await adapter.list(a);assert.equal(existing[0]?.id,mock.memoryId);assert.equal(existing[0]?.version,2);assert.equal(existing[0]?.source,'agent-recall');
  assert.equal((await adapter.list(b)).length,0);
  await assert.rejects(()=>adapter.read(b,mock.memoryId),error=>error instanceof ApiError&&error.status===404);
  const found=await adapter.search(a,{query:'发布平台',limit:5,site:'internal.example.com'});assert.equal(found.items[0]?.id,mock.memoryId);assert.equal(found.items[0]?.semantic_score,null);
  const related=await adapter.related(a,mock.memoryId);assert.equal(related.semantic_conflict,'user_decision');assert.equal(related.semantic_scores,false);assert.equal(related.items.every((item:Doc)=>item.semantic_conflict===false),true);
  assert.equal(mock.calls.filter(c=>['PATCH','DELETE'].includes(c.method)||c.path==='/api/memories'&&c.method==='POST').length,0);
});

test('unbound memory access fails explicitly; proposals remain local until verified',async()=>{
  const mock=upstream(),adapter=new AgentRecallAdapter({encryptionKey:'test-private-key',fetch:mock.mocked}),tx=localTx();
  await assert.rejects(()=>adapter.list(tx),error=>error instanceof ApiError&&error.code==='memory_not_configured');
  await adapter.bind(tx,{url:'https://recall.aimo.plus',token:'alice-pat'});
  const proposed=await adapter.propose(tx,{title:'待验证流程',content:'候选操作',type:'procedure'});assert.equal(proposed.status,'candidate');
  assert.equal(mock.calls.filter(c=>c.path==='/api/memories'&&c.method==='POST').length,0);
  const approved=await adapter.update(tx,proposed.id,{status:'verified'},proposed.version);assert.equal(approved.status,'verified');assert.notEqual(approved.id,proposed.id);
  assert.equal(mock.calls.filter(c=>c.path==='/api/memories'&&c.method==='POST').length,1);
});

test('Recall address policy rejects user-selected network targets and cannot follow redirects',async()=>{
  const mock=upstream(),adapter=new AgentRecallAdapter({encryptionKey:'test-private-key',fetch:mock.mocked});
  for(const url of ['http://127.0.0.1:13007','https://evil.example.com','https://recall.aimo.plus/private','https://user:secret@recall.aimo.plus'])assert.throws(()=>adapter.endpoint(url),ApiError);
});
