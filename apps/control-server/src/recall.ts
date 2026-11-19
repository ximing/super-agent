import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { ApiError, Tx, type Doc, hash } from './store.js';
import { text, uuid } from './auth.js';
import { assessMemory, publicAccess, type MemoryAccess } from './memory-governance.js';

export interface RecallConfig { encryptionKey:string; allowedOrigins?:string[]; fetch?:typeof fetch }
const typeMap:Record<string,string>={preference:'preference',website:'fact',procedure:'workflow',project:'architecture',experience:'lesson'};
const reverse:Record<string,string>={preference:'preference',workflow:'procedure',architecture:'project',lesson:'experience',fact:'experience',pattern:'experience',bug:'experience'};

/** One encrypted PAT per personal tenant. No process-global bearer token is supported. */
export class AgentRecallAdapter {
  private key:Buffer;private request:typeof fetch;private allowed:Set<string>;
  constructor(config:RecallConfig){
    this.key=createHash('sha256').update(`super-agent-memory-binding-v1:${config.encryptionKey}`).digest();
    this.request=config.fetch??fetch;this.allowed=new Set(config.allowedOrigins??['https://recall.aimo.plus']);
  }
  endpoint(value:unknown):string{
    const u=new URL(text(value,'url',1000));
    if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||u.pathname!=='/'||!this.allowed.has(u.origin))throw new ApiError(422,'recall_url_not_allowed','记忆服务地址不在服务器批准列表中');
    return u.origin;
  }
  encrypt(tenant:string,token:string):Doc{
    const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,iv);cipher.setAAD(Buffer.from(tenant));
    const ciphertext=Buffer.concat([cipher.update(token,'utf8'),cipher.final()]);return{iv:iv.toString('base64'),ciphertext:ciphertext.toString('base64'),tag:cipher.getAuthTag().toString('base64')};
  }
  decrypt(tenant:string,encrypted:Doc):string{
    try{const decipher=createDecipheriv('aes-256-gcm',this.key,Buffer.from(encrypted.iv,'base64'));decipher.setAAD(Buffer.from(tenant));decipher.setAuthTag(Buffer.from(encrypted.tag,'base64'));return Buffer.concat([decipher.update(Buffer.from(encrypted.ciphertext,'base64')),decipher.final()]).toString('utf8');}
    catch{throw new ApiError(503,'recall_binding_unavailable','记忆服务凭据无法解密，请重新绑定');}
  }
  private async call(binding:Doc,tenant:string,path:string,method='GET',body?:Doc):Promise<Doc>{
    let response:Response;
    try{response=await this.request(`${binding.url}${path}`,{method,headers:{authorization:`Bearer ${this.decrypt(tenant,binding.secret)}`,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:'manual',signal:AbortSignal.timeout(15000)});}
    catch{throw new ApiError(503,'recall_unreachable','记忆服务暂时不可达',true);}
    if(response.status===401||response.status===403)throw new ApiError(503,'recall_credentials_invalid','记忆服务授权已失效，请重新绑定');
    if(response.status===404)throw new ApiError(404,'not_found','记忆不存在');
    if(!response.ok)throw new ApiError(503,'recall_request_failed','记忆服务暂时无法处理请求',response.status>=500);
    if(response.status===204)return{};
    try{const value=await response.json();if(!value||typeof value!=='object')throw new Error('format');return value as Doc;}catch{throw new ApiError(503,'recall_response_invalid','记忆服务响应格式无效');}
  }
  async binding(tx:Tx):Promise<Doc>{const b=await tx.get('memory_bindings',tx.tenant);if(!b)throw new ApiError(503,'memory_not_configured','请先在设置中绑定自己的 Agent Recall 账号');return b;}
  public(binding:Doc|null):Doc{return binding?{provider:'agent-recall',configured:true,url:binding.url,account:{id:binding.actor_id,email:binding.actor_email},project:binding.project??null,version:binding.version}:{provider:'agent-recall',configured:false,url:null,account:null,project:null,version:0};}
  async settings(tx:Tx):Promise<Doc>{return this.public(await tx.get('memory_bindings',tx.tenant));}
  async bind(tx:Tx,input:Doc):Promise<Doc>{
    const url=this.endpoint(input.url),token=text(input.token,'token',5000),candidate={url,secret:this.encrypt(tx.tenant,token)};
    const me=await this.call(candidate,tx.tenant,'/api/auth/me'),actor=me.user;
    if(!actor||typeof actor.id!=='string')throw new ApiError(422,'recall_identity_invalid','无法确认记忆账号身份');
    const existing=await tx.get('memory_bindings',tx.tenant,true);
    if(existing&&existing.actor_id!==actor.id&&(await tx.all('memories')).length)throw new ApiError(409,'recall_account_change_requires_review','当前用户已有记忆映射，切换账号前需要先处理现有引用');
    const saved=await tx.put('memory_bindings',{...candidate,actor_id:actor.id,actor_email:typeof actor.email==='string'?actor.email:null,project:typeof input.project==='string'?input.project.slice(0,128):null},tx.tenant);
    return this.public(saved);
  }
  async convert(tx:Tx,raw:Doc):Promise<Doc>{
    uuid(raw.id);const meta=await tx.get('memories',raw.id),tags=Array.isArray(raw.tags)?raw.tags:[];
    const tagged=tags.find((t:unknown)=>typeof t==='string'&&t.startsWith('sa-type:'))?.slice(8);
    const content=typeof raw.content==='string'?raw.content:'';
    const governed=meta?.governance?.verification;
    const status=governed==='expired'?'expired':governed==='superseded'?'superseded':meta?.status??'verified';
    return{id:raw.id,title:meta?.title??content.split('\n').find((line:string)=>line.trim())?.replace(/^#+\s*/,'').slice(0,160)??'未命名记忆',content,type:tagged&&typeMap[tagged]?tagged:reverse[raw.type]??'experience',site:meta?.site??null,status,version:Number(raw.version)||1,created_at:raw.createdAt??raw.created_at,updated_at:raw.updatedAt??raw.updated_at??new Date().toISOString(),source:'agent-recall',recall_type:raw.type,recall_project:raw.project??null,recall_chain_id:raw.chainId??raw.id,recall_tags:tags,scope_kind:meta?.scope_kind??null,governance:meta?.governance??null};
  }
  async list(tx:Tx,query:Doc={}):Promise<Doc[]>{
    const binding=await this.binding(tx),params=new URLSearchParams({limit:String(Math.max(1,Math.min(500,Number(query.limit)||200)))});
    if(binding.project)params.set('project',binding.project);
    if(query.type&&typeMap[query.type])params.set('type',typeMap[query.type]!);
    const data=await this.call(binding,tx.tenant,`/api/memories?${params}`);
    const memories=Array.isArray(data.memories)?data.memories:[];
    const external=await Promise.all(memories.map((m:Doc)=>this.convert(tx,m)));
    const candidates=(await tx.all('memories')).filter(m=>m.status==='candidate'&&m.content);
    return [...external,...candidates];
  }
  private scoped(memory:Doc,access:MemoryAccess|undefined,site:unknown):Doc{
    if(!access||access.role==='user')return memory;
    if(typeof site==='string'&&site&&!access.sites.includes(site.toLowerCase()))throw new ApiError(404,'not_found','记忆不存在');
    const decision=assessMemory(memory,access);
    if(!decision.allowed)throw new ApiError(404,'not_found','记忆不存在');
    if(typeof site==='string'&&site&&decision.presentation.site&&decision.presentation.site.toLowerCase()!==site.toLowerCase())throw new ApiError(404,'not_found','记忆不存在');
    return decision.presentation;
  }
  async read(tx:Tx,id:string,access?:MemoryAccess):Promise<Doc>{
    const binding=await this.binding(tx),local=await tx.get('memories',uuid(id));
    if(local?.status==='candidate'&&local.content)return this.scoped(local,access,undefined);
    const data=await this.call(binding,tx.tenant,`/api/memories/${encodeURIComponent(id)}`);if(!data.memory)throw new ApiError(404,'not_found','记忆不存在');
    if(binding.project&&data.memory.project!==binding.project)throw new ApiError(404,'not_found','记忆不存在');
    return this.scoped(await this.convert(tx,data.memory),access,undefined);
  }
  async search(tx:Tx,input:Doc,access?:MemoryAccess):Promise<Doc>{
    const binding=await this.binding(tx),filter:Doc={};if(binding.project)filter.project=binding.project;
    if(Array.isArray(input.types)){const mapped=input.types.map((v:string)=>typeMap[v]).filter(Boolean);if(mapped.length)filter.type=[...new Set(mapped)];}
    const result=await this.call(binding,tx.tenant,'/api/memories/recall','POST',{query:text(input.query,'query',10000),limit:Math.max(1,Math.min(50,Number(input.limit)||5)),...(Object.keys(filter).length?{filter}:{})});
    let memories=await Promise.all((Array.isArray(result.memories)?result.memories:[]).map((m:Doc)=>this.convert(tx,m)));
    if(!access||access.role==='user')return{items:input.site?memories.filter(m=>!m.site||m.site===input.site):memories,search_mode:'agent-recall'};
    if(typeof input.site==='string'&&input.site&&!access.sites.includes(input.site.toLowerCase()))throw new ApiError(404,'not_found','记忆不存在');
    const locals=(await tx.all('memories')).filter(memory=>memory.status==='candidate'&&memory.content&&!memories.some(item=>item.id===memory.id));
    memories=[...memories,...locals];
    const items=memories.flatMap(memory=>{const decision=assessMemory(memory,access);if(!decision.allowed)return[];if(typeof input.site==='string'&&input.site&&decision.presentation.site&&decision.presentation.site.toLowerCase()!==input.site.toLowerCase())return[];return[decision.presentation];});
    return{items,search_mode:'agent-recall',scope:publicAccess(access)};
  }
  private input(body:Doc):Doc{
    if(!typeMap[body.type])throw new ApiError(422,'invalid_memory_type','知识类型无效');
    return{title:text(body.title,'title',300),content:text(body.content,'content',100000),type:body.type,site:typeof body.site==='string'?body.site.slice(0,500):null,scope_kind:body.scope_kind==='global'&&body.type==='preference'?'global':null};
  }
  async create(tx:Tx,body:Doc,operationKey?:string):Promise<Doc>{
    const binding=await this.binding(tx),input=this.input(body),opTag=`sa-op:${hash(operationKey??input).slice(0,24)}`;
    // An operation tag survives a lost response without altering pre-existing untagged memories.
    const found=await this.call(binding,tx.tenant,`/api/memories?tags=${encodeURIComponent(opTag)}&limit=1`);
    let raw=found.memories?.[0];
    if(!raw){const result=await this.call(binding,tx.tenant,'/api/memories','POST',{content:input.content,type:typeMap[input.type],tags:[`sa-type:${input.type}`,opTag],...(binding.project?{project:binding.project}:{})});raw=result.memory;}
    if(!raw)throw new ApiError(503,'recall_response_invalid','记忆服务未返回创建结果');
    const governance=body.governance&&typeof body.governance==='object'?{...body.governance,verification:'verified',claim:body.governance.claim==='fact'?'fact':body.governance.claim??'inference'}:null;
    await tx.put('memories',{title:input.title,type:input.type,site:input.site,scope_kind:input.scope_kind,status:'verified',external_id:raw.id,recall_chain_id:raw.chainId??raw.id,...(governance?{governance}:{})},uuid(raw.id));
    return this.convert(tx,raw);
  }
  async update(tx:Tx,id:string,body:Doc,expected:number):Promise<Doc>{
    const binding=await this.binding(tx),old=await this.read(tx,id);if(old.version!==expected)throw new ApiError(412,'version_conflict','记忆已更新，请刷新后重试');
    const input=this.input({...old,...body});
    if(old.status==='candidate'){
      if(body.status!=='verified')return tx.put('memories',{...old,...input,status:'candidate'},old.id);
      const created=await this.create(tx,{...input,governance:old.governance??null},`approve:${old.id}`);await tx.remove('memories',old.id);return created;
    }
    const tags=(Array.isArray(old.recall_tags)?old.recall_tags:[]).filter((tag:string)=>!tag.startsWith('sa-type:'));if(tags.length<16)tags.push(`sa-type:${input.type}`);
    const raw=await this.call(binding,tx.tenant,`/api/memories/${encodeURIComponent(id)}`,'PATCH',{content:input.content,type:typeMap[input.type],tags});
    if(!raw.memory)throw new ApiError(503,'recall_response_invalid','记忆服务未返回更新结果');
    await tx.put('memories',{title:input.title,type:input.type,site:input.site,scope_kind:input.scope_kind,status:'verified',external_id:raw.memory.id,recall_chain_id:raw.memory.chainId??raw.memory.id,governance:old.governance??null},uuid(raw.memory.id));
    return this.convert(tx,raw.memory);
  }
  async remove(tx:Tx,id:string,expected:number):Promise<void>{const binding=await this.binding(tx),old=await this.read(tx,id);if(old.version!==expected)throw new ApiError(412,'version_conflict','记忆已更新，请刷新后重试');if(old.status!=='candidate')await this.call(binding,tx.tenant,`/api/memories/${encodeURIComponent(id)}`,'DELETE');await tx.remove('memories',id);}
  async propose(tx:Tx,body:Doc):Promise<Doc>{await this.binding(tx);return tx.put('memories',{...this.input(body),status:'candidate',sources:body.sources??[],source:'proposal'},randomUUID());}
}
