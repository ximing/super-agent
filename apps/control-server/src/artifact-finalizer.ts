import { randomUUID } from 'node:crypto';
import { signObject,copySource,type S3Config } from './objects.js';
import { ApiError,type Doc,type Tx } from './store.js';

type Transport=typeof fetch;
function etag(value:string|null):string{
  if(!value||value.length>512||!/^"[!-~]+"$/.test(value))throw new ApiError(503,'storage_etag_missing','对象存储未提供可核对的对象版本');
  return value;
}
function decodeXml(value:string):string{
  const decoded=value.replace(/&(?:quot|apos|lt|gt|amp);|&#(?:x[0-9a-f]+|[0-9]+);/gi,entity=>{
    const named:Record<string,string>={'&quot;':'"','&apos;':"'",'&lt;':'<','&gt;':'>','&amp;':'&'};
    if(named[entity.toLowerCase()])return named[entity.toLowerCase()]!;
    const hex=entity.slice(2,3).toLowerCase()==='x',number=parseInt(entity.slice(hex?3:2,-1),hex?16:10);
    return Number.isSafeInteger(number)&&number>0&&number<=0x10ffff?String.fromCodePoint(number):'\0';
  });
  if(/[\0\r\n]/.test(decoded)||/&(?:[a-z#][^;]*);/i.test(decoded))throw new ApiError(503,'storage_copy_invalid','对象复制响应无效');
  return decoded;
}
/** CopyObject may report an Error inside HTTP 200; validate the entire XML. */
export function copiedEtag(body:string):string{
  const xml=body.replace(/^\uFEFF/,'').trim().replace(/^<\?xml\s[^?]*\?>\s*/,'');
  const root=/^<CopyObjectResult(?:\s+xmlns=(?:"[^"<>]*"|'[^'<>]*'))?\s*>([\s\S]*)<\/CopyObjectResult>$/.exec(xml);
  if(!root||body.length>65536)throw new ApiError(503,'storage_copy_invalid','对象复制未返回完整成功结果');
  let rest=root[1]!.trim(),result:string|null=null;
  while(rest){
    const child=/^<([A-Za-z][A-Za-z0-9]*)>([^<]*)<\/\1>/.exec(rest);
    if(!child||child[1]==='Error')throw new ApiError(503,'storage_copy_invalid','对象复制未返回完整成功结果');
    if(child[1]==='ETag'){if(result!==null)throw new ApiError(503,'storage_copy_invalid','对象复制响应重复');result=decodeXml(child[2]!.trim());}
    rest=rest.slice(child[0].length).trim();
  }
  return etag(result);
}
async function bodyText(response:Response):Promise<string>{
  if(!response.body)throw new ApiError(503,'storage_copy_invalid','对象复制响应为空');
  const reader=response.body.getReader(),parts:Uint8Array[]=[];let size=0;
  try{while(true){const value=await reader.read();if(value.done)break;size+=value.value.length;if(size>65536){await reader.cancel();throw new ApiError(503,'storage_copy_invalid','对象复制响应过大');}parts.push(value.value);}}
  finally{reader.releaseLock();}
  return Buffer.concat(parts).toString('utf8');
}
/** The caller holds this artifact's FOR UPDATE lock until the tenant commit. */
export async function finalizeArtifact(tx:Tx,config:S3Config,artifact:Doc,transport:Transport=fetch):Promise<Doc>{
  // Neither re-copy a ready snapshot nor silently rewrite legacy ready data.
  if(artifact.status==='ready')return artifact;
  if(artifact.status!=='staged')throw new ApiError(409,'artifact_not_staged','文件当前不可完成上传');
  const staging=artifact.staging_object_key??artifact.object_key;
  if(typeof staging!=='string'||!staging)throw new ApiError(409,'upload_incomplete','文件尚未上传完整');
  const request=async(url:string,init:RequestInit):Promise<Response>=>{
    try{return await transport(url,{...init,redirect:'manual',signal:AbortSignal.timeout(15000)});}
    catch{throw new ApiError(503,'storage_unavailable','对象存储暂时不可用',true);}
  };
  const source=await request(signObject(config,'HEAD',staging),{method:'HEAD'});
  if(!source.ok||source.headers.get('content-length')===null||Number(source.headers.get('content-length'))!==artifact.size)throw new ApiError(source.status>=500?503:409,'upload_incomplete','文件尚未上传完整',source.status>=500);
  const sourceEtag=etag(source.headers.get('etag')),target=`artifacts/final/${tx.tenant}/${artifact.id}/${randomUUID()}`;
  const headers={'x-amz-copy-source':copySource(config,staging),'x-amz-copy-source-if-match':sourceEtag};
  const copied=await request(signObject(config,'PUT',target,300,new Date(),headers),{method:'PUT',headers});
  if(copied.status===412||copied.status===409)throw new ApiError(409,'upload_changed','上传内容已变化，请核对后重新完成');
  if(!copied.ok)throw new ApiError(503,'storage_copy_failed','对象存储暂时无法固定交付内容',true);
  let copiedTag:string;
  try{copiedTag=copiedEtag(await bodyText(copied));}catch(error){if(error instanceof ApiError)throw error;throw new ApiError(503,'storage_copy_invalid','对象复制未返回完整成功结果',true);}
  const final=await request(signObject(config,'HEAD',target),{method:'HEAD'});
  if(!final.ok||final.headers.get('content-length')===null||Number(final.headers.get('content-length'))!==artifact.size||etag(final.headers.get('etag'))!==copiedTag)throw new ApiError(503,'storage_copy_verification_failed','对象复制校验失败',true);
  // Only the server ever receives a PUT authorization for this fresh key.
  // Subsequent client PUTs can modify staging, never the published snapshot.
  const saved=await tx.put('artifacts',{...artifact,staging_object_key:staging,object_key:target,status:'ready',integrity:'server_snapshot',source_etag:sourceEtag,snapshot_etag:copiedTag,finalized_at:new Date().toISOString(),claimed_sha256:artifact.sha256??null});
  await tx.emit('artifact.ready',{id:saved.id,name:saved.name},saved.task_id??null,artifact.run_id??null);return saved;
}
