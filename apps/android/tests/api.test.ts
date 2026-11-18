import {test} from 'node:test';
import assert from 'node:assert/strict';
import {APIClient, validateServer, type SessionStore} from '../src/api';
import type {Session} from '../src/types';

const session:Session={access_token:'test-access',refresh_token:'test-refresh',expires_in:600,user:{id:'u',email:'test@example.com',name:'Test',tenant_id:'t'}};
function store():SessionStore {const data=new Map<string,Session>();return{async read(key){return data.get(key)??null;},async write(key,value){data.set(key,value);},async remove(key){data.delete(key);}};}
test('server URLs do not allow remote HTTP, credentials, query tokens or paths',()=>{
  for(const value of ['http://public.example','https://u:secret@agent.example','https://agent.example/path','https://agent.example?token=x','not a url'])assert.throws(()=>validateServer(value));
  assert.equal(validateServer(' https://agent.example/ '),'https://agent.example');
  assert.equal(validateServer('http://10.0.2.2:8787'),'http://10.0.2.2:8787');
});
test('401 refresh retains version and idempotency key and uses renewed access',async()=>{
  const calls:{url:string;headers:Record<string,string>}[]=[];
  const transport=(async(url:unknown,init:RequestInit)=>{calls.push({url:String(url),headers:init.headers as Record<string,string>});
    if(String(url).endsWith('/auth/refresh'))return new Response(JSON.stringify({...session,access_token:'renewed'}),{status:200});
    if(calls.length===1)return new Response(JSON.stringify({error:{code:'expired',message:'expired'}}),{status:401});
    return new Response(JSON.stringify({ok:true}),{status:200});
  }) as typeof fetch;
  const client=new APIClient(store(),()=> 'stable-id',transport);await client.configure('https://agent.example');await client.setSession(session);
  await client.request('/tasks/t/actions',{method:'POST',body:{action:'pause'},version:4});
  assert.equal(calls.length,3);assert.equal(calls[0]?.headers['Idempotency-Key'],calls[2]?.headers['Idempotency-Key']);assert.equal(calls[2]?.headers.Authorization,'Bearer renewed');assert.equal(calls[2]?.headers['If-Match'],'"4"');assert.equal(calls[1]?.headers.Authorization,undefined);
});
test('switching server origin does not leak existing account token',async()=>{
  const client=new APIClient(store(),()=> 'id');await client.configure('https://one.example');await client.setSession(session);await client.configure('https://two.example');assert.equal(client.session,null);
});
test('missing monetary values are preserved instead of synthesized as zero',async()=>{
  const transport=(async()=>new Response(JSON.stringify({totals:[],unknown_count:1,coverage:0}),{status:200})) as typeof fetch;
  const client=new APIClient(store(),()=> 'id',transport);await client.configure('https://agent.example');await client.setSession(session);
  const summary=await client.request<{totals:unknown[];unknown_count:number}>('/costs/summary');assert.deepEqual(summary.totals,[]);assert.equal(summary.unknown_count,1);
});
