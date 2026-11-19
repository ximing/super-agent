import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { finalizeArtifact,copiedEtag } from '../src/artifact-finalizer.js';
import { copySource,signObject } from '../src/objects.js';
import { ApiError,type Doc } from '../src/store.js';
import { publicArtifact } from '../src/team.js';

const config={endpoint:'https://storage.example.com',bucket:'private-test',region:'test',accessKey:'EXAMPLE',secretKey:'example-secret'};
function fixture(){
  const artifact={id:randomUUID(),task_id:randomUUID(),run_id:null,name:'evidence.txt',mime:'text/plain',size:3,status:'staged',object_key:'staging/source',staging_object_key:'staging/source'};
  const writes:Doc[]=[],events:Doc[]=[];
  const tx={tenant:randomUUID(),put:async(_table:string,data:Doc)=>{writes.push(data);return{...data,version:1,created_at:new Date().toISOString()};},emit:async(_type:string,payload:Doc)=>{events.push(payload);}} as any;
  return{artifact,writes,events,tx};
}
const head=(tag='"source"',size=3)=>new Response(null,{headers:{etag:tag,'content-length':String(size)}});
const copied=(tag='&quot;source&quot;')=>new Response(`<?xml version="1.0"?><CopyObjectResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LastModified>2026-11-19T00:00:00Z</LastModified><ETag>${tag}</ETag></CopyObjectResult>`);

test('artifact snapshot signs source conditions, validates the full copy, and publishes only a new final key',async()=>{
  const f=fixture(),requests:{method:string;path:string;headers:Headers}[]=[];
  const transport=(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const url=new URL(String(input)),headers=new Headers(init?.headers);requests.push({method:init!.method!,path:url.pathname,headers});
    if(init?.method==='PUT'){
      assert.equal(headers.get('x-amz-copy-source'),copySource(config,f.artifact.staging_object_key));assert.equal(headers.get('x-amz-copy-source-if-match'),'"source"');
      assert.equal(url.searchParams.get('X-Amz-SignedHeaders'),'host;x-amz-copy-source;x-amz-copy-source-if-match');return copied();
    }return head();
  }) as typeof fetch;
  const ready=await finalizeArtifact(f.tx,config,f.artifact,transport);assert.equal(ready.status,'ready');assert.equal(ready.integrity,'server_snapshot');assert.notEqual(ready.object_key,f.artifact.object_key);assert.ok(ready.object_key.startsWith('artifacts/final/'));assert.equal(ready.staging_object_key,f.artifact.staging_object_key);
  assert.deepEqual(requests.map(r=>r.method),['HEAD','PUT','HEAD']);assert.equal(f.writes.length,1);assert.equal(f.events.length,1);
  const metadata=publicArtifact(ready);assert.equal(metadata.integrity,'server_snapshot');assert.equal(metadata.object_key,undefined);assert.equal(metadata.staging_object_key,undefined);assert.equal(metadata.source_etag,undefined);
  const before=requests.length;await finalizeArtifact(f.tx,config,ready,transport);assert.equal(requests.length,before);assert.equal(f.writes.length,1,'Ready replay never copies staging into the accepted snapshot');
});
test('legacy ready objects are returned unchanged and explicitly lack snapshot provenance',async()=>{
  const f=fixture(),legacy={...f.artifact,status:'ready',integrity:'size_verified'};const transport=(async()=>{throw new Error('must not contact S3');}) as any;
  assert.equal(await finalizeArtifact(f.tx,config,legacy,transport),legacy);assert.equal(publicArtifact(legacy).integrity,'legacy_unverified');assert.equal(f.writes.length,0);
});
test('copy HTTP 200 embedded error, malformed XML, absent ETag and final mismatch cannot mark an artifact ready',async()=>{
  for(const bad of ['<Error><Code>InternalError</Code></Error>','<CopyObjectResult><ETag>&quot;source&quot;</ETag><Error>failed</Error></CopyObjectResult>','<CopyObjectResult><ETag>&quot;source&quot;</ETag><broken></CopyObjectResult>','<CopyObjectResult><LastModified>today</LastModified></CopyObjectResult>','<CopyObjectResult><ETag>&quot;source&quot;</ETag></CopyObjectResult>trailing']){
    const f=fixture(),transport=(async(_input:any,init:any)=>init.method==='PUT'?new Response(bad):head()) as typeof fetch;
    await assert.rejects(()=>finalizeArtifact(f.tx,config,f.artifact,transport),ApiError);assert.equal(f.writes.length,0);
  }
  const f=fixture();let calls=0;const transport=(async()=>++calls===1?head():calls===2?copied():head('"changed"')) as typeof fetch;
  await assert.rejects(()=>finalizeArtifact(f.tx,config,f.artifact,transport),(e:any)=>e.code==='storage_copy_verification_failed');assert.equal(f.writes.length,0);
});
test('conditional copy rejects a changed source; metadata failures never attempt a copy',async()=>{
  const f=fixture(),transport=(async(_input:any,init:any)=>init.method==='PUT'?new Response('',{status:412}):head()) as typeof fetch;
  await assert.rejects(()=>finalizeArtifact(f.tx,config,f.artifact,transport),(e:any)=>e.status===409&&e.code==='upload_changed');assert.equal(f.writes.length,0);
  for(const source of [new Response(null,{headers:{'content-length':'3'}}),head('"source"',4)]){
    const other=fixture();let count=0;await assert.rejects(()=>finalizeArtifact(other.tx,config,other.artifact,(async()=>{count++;return source;}) as any),ApiError);assert.equal(count,1);assert.equal(other.writes.length,0);
  }
});
test('SigV4 source headers are bound into the signature and incomplete copy XML cannot pass',()=>{
  const at=new Date('2026-11-19T00:00:00Z'),headers={'x-amz-copy-source':'/private-test/source','x-amz-copy-source-if-match':'"one"'};
  const one=signObject(config,'PUT','final',300,at,headers),two=signObject(config,'PUT','final',300,at,{...headers,'x-amz-copy-source-if-match':'"two"'});assert.notEqual(one,two);
  assert.throws(()=>signObject(config,'PUT','final',300,at,{'x-amz-copy-source':'a\r\nb'}),ApiError);assert.throws(()=>copiedEtag('<!DOCTYPE x><CopyObjectResult><ETag>"tag"</ETag></CopyObjectResult>'),ApiError);
});
