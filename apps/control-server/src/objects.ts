import { createHash, createHmac } from 'node:crypto';
import { ApiError } from './store.js';

export interface S3Config { endpoint:string; bucket:string; region:string; accessKey:string; secretKey:string }
const digest=(v:string)=>createHash('sha256').update(v).digest('hex');
const mac=(key:Buffer|string,data:string)=>createHmac('sha256',key).update(data).digest();
const encode=(s:string)=>encodeURIComponent(s).replace(/[!'()*]/g,c=>`%${c.charCodeAt(0).toString(16).toUpperCase()}`);
/** Path-style S3 SigV4. Credentials stay in this cloud process, never in API bodies. */
export function signObject(config:S3Config,method:'PUT'|'GET'|'HEAD'|'DELETE',key:string,ttl=300,at=new Date(),headers:Readonly<Record<string,string>>={}):string{
  const endpoint=new URL(config.endpoint);if(endpoint.protocol!=='https:')throw new ApiError(503,'storage_insecure','对象存储必须使用 HTTPS');
  const timestamp=at.toISOString().replace(/[:-]|\.\d{3}/g,''),date=timestamp.slice(0,8),scope=`${date}/${config.region}/s3/aws4_request`;
  const path=`${endpoint.pathname.replace(/\/$/,'')}/${encode(config.bucket)}/${key.split('/').map(encode).join('/')}`;
  const values=new Map<string,string>([['host',endpoint.host]]);
  for(const [name,value] of Object.entries(headers)){
    const lower=name.toLowerCase();
    if(!/^[a-z0-9-]+$/.test(lower)||values.has(lower)||typeof value!=='string'||/[\r\n]/.test(value))throw new ApiError(503,'storage_headers_invalid','对象存储请求头无效');
    values.set(lower,value.trim().replace(/[\t ]+/g,' '));
  }
  const signedNames=[...values.keys()].sort(),signedHeaders=signedNames.join(';'),canonicalHeaders=signedNames.map(name=>`${name}:${values.get(name)}\n`).join('');
  const query=new Map<string,string>([['X-Amz-Algorithm','AWS4-HMAC-SHA256'],['X-Amz-Credential',`${config.accessKey}/${scope}`],['X-Amz-Date',timestamp],['X-Amz-Expires',String(Math.max(1,Math.min(900,ttl)))],['X-Amz-SignedHeaders',signedHeaders]]);
  const canonicalQuery=[...query].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${encode(k)}=${encode(v)}`).join('&');
  const canonical=[method,path,canonicalQuery,canonicalHeaders,signedHeaders,'UNSIGNED-PAYLOAD'].join('\n');
  const toSign=['AWS4-HMAC-SHA256',timestamp,scope,digest(canonical)].join('\n');
  const dateKey=mac(`AWS4${config.secretKey}`,date),regionKey=mac(dateKey,config.region),serviceKey=mac(regionKey,'s3'),signingKey=mac(serviceKey,'aws4_request');
  return`${endpoint.origin}${path}?${canonicalQuery}&X-Amz-Signature=${mac(signingKey,toSign).toString('hex')}`;
}
export function copySource(config:S3Config,key:string):string{return`/${encode(config.bucket)}/${key.split('/').map(encode).join('/')}`;}
