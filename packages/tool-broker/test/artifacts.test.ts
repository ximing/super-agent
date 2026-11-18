import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, symlink, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolBroker, BrowserActor } from '../src/index.js';

function broker(dir:string, request:(path:string,body?:unknown)=>Promise<unknown>, fetcher:typeof fetch, controller=new AbortController()) {
  return new ToolBroker({runId:'run-fixture',cwd:dir,browser:new BrowserActor(),signal:controller.signal,assertActive:()=>{},ask:async()=>'',request:request as never,fetcher});
}
const signed='https://objects.integration.invalid/object?X-Amz-Signature=test-only-signature';

test('artifact binary list/download/upload/finalize uses task API and token-free signed transfers',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'super-agent-artifacts-')),bytes=Buffer.from([0,255,10,11,34]);
  const api:string[]=[],transfers:string[]=[];let uploaded:Buffer|undefined;
  try{
    const tools=broker(dir,async(path,body)=>{
      api.push(path);
      if(path==='/artifacts')return{items:[{id:'input',name:'fixture.bin'}]};
      if(path.endsWith('/download'))return{url:signed,name:'fixture.bin',mime:'application/octet-stream'};
      if(path==='/artifacts/uploads'){assert.equal((body as {size:number}).size,bytes.length);assert.match((body as {sha256:string}).sha256,/^[a-f0-9]{64}$/);return{artifact_id:'output',upload_url:signed,upload_headers:{'Content-Type':'application/octet-stream'},max_size:50*1024*1024};}
      if(path.endsWith('/finalize'))return{id:'output',status:'ready',name:'deliverable.bin'};
      throw new Error('Unexpected product API');
    },(async(_url,init)=>{
      assert.equal(init?.redirect,'error');assert.equal(init?.credentials,'omit');assert.ok(init?.signal);
      const headers=new Headers(init?.headers);for(const name of ['authorization','cookie','x-run-ticket','x-assistant-epoch'])assert.equal(headers.has(name),false);
      transfers.push(init?.method??'GET');
      if(init?.method==='PUT'){uploaded=Buffer.from(await new Response(init.body).arrayBuffer());return new Response(null,{status:200});}
      return new Response(new ReadableStream({start(controller){controller.enqueue(bytes.subarray(0,2));controller.enqueue(bytes.subarray(2));controller.close();}}),{headers:{'content-length':String(bytes.length)}});
    }) as typeof fetch);
    assert.deepEqual(await tools.execute('artifacts_list',{}),{items:[{id:'input',name:'fixture.bin'}]});
    const result=await tools.execute('artifacts_download',{id:'input',path:'inputs/fixture.bin'});assert.equal((result as {bytes:number}).bytes,bytes.length);assert.deepEqual(await readFile(join(dir,'inputs/fixture.bin')),bytes);
    const final=await tools.execute('artifacts_upload',{path:'inputs/fixture.bin',name:'deliverable.bin'});assert.deepEqual(uploaded,bytes);assert.equal((final as {status:string}).status,'ready');
    assert.deepEqual(transfers,['GET','PUT']);assert.deepEqual(api,['/artifacts','/artifacts/input/download','/artifacts/uploads','/artifacts/output/finalize']);
    assert.doesNotMatch(JSON.stringify([result,final]),/Signature|https:/);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('artifact tools reject workspace traversal, symlink escape, directories and >50MB files before API calls',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'super-agent-artifact-bound-')),outside=await mkdtemp(join(tmpdir(),'super-agent-artifact-out-'));let requests=0;
  try{
    await writeFile(join(outside,'private.txt'),'outside');await symlink(outside,join(dir,'escape'));
    const large=await open(join(dir,'large.bin'),'w');try{await large.truncate(50*1024*1024+1);}finally{await large.close();}
    const tools=broker(dir,async()=>{requests++;return{};},(async()=>{throw new Error('No transfer permitted');})as typeof fetch);
    for(const path of ['../outside.bin','escape/private.txt']){
      await assert.rejects(tools.execute('artifacts_download',{id:'input',path}),/outside_workspace/);
      await assert.rejects(tools.execute('artifacts_upload',{path}),/outside_workspace/);
    }
    await mkdir(join(dir,'directory'));
    await assert.rejects(tools.execute('artifacts_download',{id:'input',path:'directory'}),/directory/);
    await assert.rejects(tools.execute('artifacts_upload',{path:'.'}),/regular_file/);
    await assert.rejects(tools.execute('artifacts_upload',{path:'large.bin'}),/too_large/);assert.equal(requests,0);
  }finally{await rm(dir,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
});

test('artifact transfers reject non-HTTPS, redirects and auth headers without leaking signed URL or bearer',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'super-agent-artifact-url-'));let transfers=0,finalized=false;
  try{
    await writeFile(join(dir,'out.bin'),'x');
    const insecure=broker(dir,async()=>({url:'http://objects.invalid/?Signature=NEVER_PRINT'}),(async()=>{transfers++;return new Response();})as typeof fetch);
    await assert.rejects(insecure.execute('artifacts_download',{id:'a',path:'in.bin'}),/requires_https/);assert.equal(transfers,0);
    const redirect=broker(dir,async()=>({url:signed}),(async(_url,init)=>{assert.equal(init?.redirect,'error');transfers++;return new Response(null,{status:302,headers:{location:'https://untrusted.invalid'}});})as typeof fetch);
    await assert.rejects(redirect.execute('artifacts_download',{id:'a',path:'in.bin'}),/http_302/);assert.equal(transfers,1);
    const badHeaders=broker(dir,async(path)=>{if(path.endsWith('/finalize'))finalized=true;return{artifact_id:'out',upload_url:signed,upload_headers:{Authorization:'Bearer NEVER_PRINT'},max_size:50*1024*1024};},(async()=>{transfers++;return new Response();})as typeof fetch);
    await assert.rejects(badHeaders.execute('artifacts_upload',{path:'out.bin'}),error=>{assert.match(String(error),/unsafe_artifact_upload_headers/);assert.doesNotMatch(String(error),/NEVER_PRINT|Signature/);return true;});assert.equal(transfers,1);assert.equal(finalized,false);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('artifact download bounds actual streaming bytes and removes partial files on overflow or abort',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'super-agent-artifact-stream-'));
  try{
    const block=new Uint8Array(64*1024);let count=0,cancelled=false;
    const overflow=broker(dir,async()=>({url:signed}),(async()=>new Response(new ReadableStream({pull(stream){count++;stream.enqueue(block);},cancel(){cancelled=true;}})))as typeof fetch);
    await assert.rejects(overflow.execute('artifacts_download',{id:'a',path:'overflow.bin'}),/too_large/);assert.equal(cancelled,true);assert.deepEqual(await readdir(dir),[]);
    const controller=new AbortController();
    const stopped=broker(dir,async()=>({url:signed}),(async(_url,init)=>new Response(new ReadableStream({pull(stream){controller.abort();stream.enqueue(new Uint8Array([1]));},cancel(){assert.equal(init?.signal?.aborted,true);}})))as typeof fetch,controller);
    await assert.rejects(stopped.execute('artifacts_download',{id:'a',path:'aborted.bin'}),{name:'AbortError'});assert.deepEqual(await readdir(dir),[]);
  }finally{await rm(dir,{recursive:true,force:true});}
});
