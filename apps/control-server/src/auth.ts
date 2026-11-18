import { createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto';
import { SignJWT, jwtVerify, createRemoteJWKSet } from 'jose';
import { ApiError, Store, Tx, hash, type Doc } from './store.js';
import type { S3Config } from './objects.js';

export interface Config {
  databaseUrl:string; jwtSecret:string; allowDevAuth?:boolean; oidcIssuer?:string;
  oidcAudience?:string; oidcClientId?:string; oidcRedirectUri?:string;
  logger?:boolean; runScheduler?:boolean; port?:number; host?:string; s3?:S3Config;
  memoryEncryptionKey?:string; recallAllowedOrigins?:string[]; recallFetch?:typeof fetch;
  oidcDiagnostic?:(event:{stage:string;name:string;code:string|null})=>void;
}
export interface Principal { type:'client'|'device'; tenant:string; id:string; session?:string; device?:string; user?:Doc }
export const text=(value:unknown,name:string,max=16000):string=>{if(typeof value!=='string'||!value.trim()||value.length>max)throw new ApiError(422,'invalid_input',`${name} 无效`);return value.trim();};
export const uuid=(value:unknown,name='id'):string=>{const v=text(value,name,100);if(!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(v))throw new ApiError(422,'invalid_id',`${name} 无效`);return v;};
export const now=()=>new Date().toISOString();
export const expires=(ms:number)=>new Date(Date.now()+ms).toISOString();
export class Auth {
  private key:Uint8Array;
  constructor(public store:Store,public config:Config){
    if(Buffer.byteLength(config.jwtSecret)<32)throw new Error('JWT_SECRET must contain at least 32 bytes');
    if(config.allowDevAuth&&process.env.NODE_ENV==='production')throw new Error('Development authentication is forbidden in production');
    this.key=new TextEncoder().encode(config.jwtSecret);
  }
  async token(payload:Doc,seconds=600):Promise<string>{return new SignJWT(payload).setProtectedHeader({alg:'HS256',typ:'JWT'}).setIssuer('super-agent-control').setAudience('super-agent').setIssuedAt().setExpirationTime(`${seconds}s`).sign(this.key);}
  async decode(token:string):Promise<Doc>{try{const {payload}=await jwtVerify(token,this.key,{issuer:'super-agent-control',audience:'super-agent',algorithms:['HS256']});return payload;}catch{throw new ApiError(401,'unauthorized','登录已失效，请重新登录');}}
  async principal(header:unknown):Promise<Principal>{
    if(typeof header!=='string'||!header.startsWith('Bearer '))throw new ApiError(401,'unauthorized','需要登录');
    const p=await this.decode(header.slice(7));
    if(p.type==='client'){
      const r=await this.store.pool.query('SELECT s.id,u.* FROM sa_sessions s JOIN sa_users u ON u.id=s.user_id WHERE s.id=$1 AND s.revoked_at IS NULL AND s.expires_at>now()',[p.sid]);
      const user=r.rows[0];if(!user||user.tenant_id!==p.tenant)throw new ApiError(401,'session_revoked','会话已撤销');
      return {type:'client',tenant:user.tenant_id,id:user.id,session:p.sid,user};
    }
    if(p.type==='device'){
      const r=await this.store.pool.query('SELECT * FROM sa_device_keys WHERE device_id=$1 AND revoked_at IS NULL',[p.device]);
      const d=r.rows[0];if(!d||d.tenant_id!==p.tenant||d.key_version!==p.key_version)throw new ApiError(401,'device_revoked','执行电脑身份已撤销');
      return {type:'device',tenant:d.tenant_id,id:d.device_id,device:d.device_id};
    }
    throw new ApiError(401,'invalid_principal','身份类型无效');
  }
  client(p:Principal):void{if(p.type!=='client')throw new ApiError(403,'client_required','此操作需要用户会话');}
  device(p:Principal):void{if(p.type!=='device')throw new ApiError(403,'device_required','此操作需要执行电脑身份');}
  async session(user:Doc):Promise<Doc>{
    const sid=randomUUID(),refresh=randomBytes(32).toString('base64url');
    await this.store.pool.query('INSERT INTO sa_sessions(id,user_id,refresh_hash,expires_at) VALUES($1,$2,$3,$4)',[sid,user.id,hash(refresh),expires(30*86400000)]);
    return this.sessionResult(user,sid,refresh);
  }
  async sessionResult(user:Doc,sid:string,refresh:string):Promise<Doc>{return{access_token:await this.token({type:'client',tenant:user.tenant_id,sub:user.id,sid}),refresh_token:refresh,expires_in:600,user:{id:user.id,tenant_id:user.tenant_id,email:user.email,name:user.name}};}
  async user(issuer:string,subject:string,email:string,name:string):Promise<Doc>{
    const r=await this.store.pool.query('INSERT INTO sa_users(id,tenant_id,issuer,subject,email,name) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(issuer,subject) DO UPDATE SET email=EXCLUDED.email,name=EXCLUDED.name RETURNING *',[randomUUID(),randomUUID(),issuer,subject,email,name]);
    return r.rows[0];
  }
  async development(body:Doc):Promise<Doc>{if(!this.config.allowDevAuth)throw new ApiError(404,'not_found','资源不存在');const email=text(body.email,'email',254).toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new ApiError(422,'invalid_email','邮箱格式无效');return this.session(await this.user('development',email,email,typeof body.name==='string'?body.name.slice(0,100):email.split('@')[0]!));}
  async oidc(body:Doc):Promise<Doc>{
    const {oidcIssuer:issuer,oidcAudience:audience}=this.config;
    if(!issuer||!audience)throw new ApiError(503,'oidc_not_configured','身份服务尚未配置');
    let stage='discovery_fetch';
    try{
      const url=new URL('.well-known/openid-configuration',issuer.endsWith('/')?issuer:`${issuer}/`);
      const response=await fetch(url,{signal:AbortSignal.timeout(10000)});if(!response.ok)throw new Error('discovery');
      stage='discovery_parse';
      const discovery=await response.json() as Doc;
      stage='issuer_check';
      if(discovery.issuer!==issuer)throw new Error('issuer mismatch');
      stage='jwt_verify';
      const {payload}=await jwtVerify(text(body.access_token,'access_token',20000),createRemoteJWKSet(new URL(discovery.jwks_uri)),{issuer,audience});
      stage='subject_check';
      if(!payload.sub)throw new Error('subject');
      const email=typeof payload.email==='string'?payload.email:`${payload.sub}@oidc.invalid`;
      stage='session_create';
      return this.session(await this.user(issuer,payload.sub,email,typeof payload.name==='string'?payload.name:email));
    }catch(e){const value=e as {name?:unknown;code?:unknown};this.config.oidcDiagnostic?.({stage,name:typeof value.name==='string'?value.name.slice(0,80):'UnknownError',code:typeof value.code==='string'&&/^[\w-]{1,100}$/.test(value.code)?value.code:null});if(e instanceof ApiError)throw e;throw new ApiError(401,'oidc_invalid','身份服务凭证无效或不可用');}
  }
  async refresh(body:Doc):Promise<Doc>{
    const replacement=randomBytes(32).toString('base64url');
    const r=await this.store.pool.query('UPDATE sa_sessions SET refresh_hash=$2 WHERE refresh_hash=$1 AND revoked_at IS NULL AND expires_at>now() RETURNING id,user_id',[hash(text(body.refresh_token,'refresh_token',2000)),hash(replacement)]);
    if(!r.rows[0])throw new ApiError(401,'invalid_refresh','刷新凭证失效');
    const user=await this.store.pool.query('SELECT * FROM sa_users WHERE id=$1',[r.rows[0].user_id]);
    return this.sessionResult(user.rows[0],r.rows[0].id,replacement);
  }
  publicKey(value:unknown):string{
    const input=text(value,'public_key',5000);
    try{
      const key=input.includes('BEGIN PUBLIC KEY')?createPublicKey(input):createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(input,'base64')]),format:'der',type:'spki'});
      if(key.asymmetricKeyType!=='ed25519')throw new Error('wrong type');
      return key.export({type:'spki',format:'pem'}).toString();
    }catch{throw new ApiError(422,'invalid_key','需要 Ed25519 公钥');}
  }
  async pairing(body:Doc):Promise<Doc>{
    const id=randomUUID(),secret=randomBytes(32).toString('base64url'),code=randomBytes(5).toString('hex').toUpperCase(),expiry=expires(600000);
    await this.store.pool.query('INSERT INTO sa_pairings(id,code,name,public_key,polling_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6)',[id,code,text(body.name,'name',100),this.publicKey(body.public_key),hash(secret),expiry]);
    return{pairing_id:id,code,polling_secret:secret,expires_at:expiry};
  }
  async claim(p:Principal,body:Doc):Promise<Doc>{
    this.client(p);const c=await this.store.pool.connect();
    try{
      await c.query('BEGIN');await c.query("SELECT set_config('app.tenant_id',$1,true)",[p.tenant]);const result=await c.query('SELECT * FROM sa_pairings WHERE code=$1 AND expires_at>now() FOR UPDATE',[text(body.code,'code',100).toUpperCase()]);
      const pairing=result.rows[0];if(!pairing)throw new ApiError(404,'pairing_not_found','配对码无效或已过期');
      if(pairing.device_id){if(pairing.tenant_id!==p.tenant)throw new ApiError(409,'pairing_claimed','配对码已使用');await c.query('COMMIT');return{device_id:pairing.device_id};}
      const id=randomUUID(),data={id,name:pairing.name,last_seen_at:null,capabilities:{generation:1,engines:[],tools:[],slots:{browser:1,worker:1}}};
      await c.query('INSERT INTO sa_devices(tenant_id,id,data) VALUES($1,$2,$3)',[p.tenant,id,data]);
      await c.query('INSERT INTO sa_device_keys(device_id,tenant_id,public_key) VALUES($1,$2,$3)',[id,p.tenant,pairing.public_key]);
      await c.query('UPDATE sa_pairings SET device_id=$2,tenant_id=$3,claimed_by=$4 WHERE id=$1',[pairing.id,id,p.tenant,p.id]);
      await c.query('COMMIT');return{device_id:id};
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }
  async poll(body:Doc):Promise<Doc>{
    const result=await this.store.pool.query('SELECT device_id,tenant_id FROM sa_pairings WHERE id=$1 AND polling_hash=$2 AND expires_at>now()',[uuid(body.pairing_id),hash(text(body.polling_secret,'polling_secret',1000))]);
    const p=result.rows[0];if(!p)throw new ApiError(404,'pairing_expired','配对已过期');
    return p.device_id?{status:'claimed',device_id:p.device_id,tenant_id:p.tenant_id}:{status:'pending'};
  }
  async challenge(body:Doc):Promise<Doc>{
    const id=uuid(body.device_id),r=await this.store.pool.query('SELECT * FROM sa_device_keys WHERE device_id=$1 AND revoked_at IS NULL',[id]);
    if(!r.rows[0])throw new ApiError(401,'invalid_device','执行电脑身份无效');
    const nonce=randomBytes(32).toString('base64url'),expiry=expires(60000),challenge=JSON.stringify({domain:'super-agent-device-auth-v1',device_id:id,nonce,expires_at:expiry});
    await this.store.pool.query('INSERT INTO sa_challenges(nonce,device_id,challenge,expires_at) VALUES($1,$2,$3,$4)',[nonce,id,challenge,expiry]);return{nonce,challenge,expires_at:expiry};
  }
  async deviceToken(body:Doc):Promise<Doc>{
    const c=await this.store.pool.connect();try{
      await c.query('BEGIN');const r=await c.query('SELECT c.*,k.public_key,k.tenant_id,k.key_version FROM sa_challenges c JOIN sa_device_keys k ON k.device_id=c.device_id WHERE c.nonce=$1 AND c.device_id=$2 AND c.expires_at>now() AND k.revoked_at IS NULL FOR UPDATE OF c',[text(body.nonce,'nonce',200),uuid(body.device_id)]);
      const d=r.rows[0];if(!d||!verify(null,Buffer.from(d.challenge),createPublicKey(d.public_key),Buffer.from(text(body.signature,'signature',1000),'base64')))throw new ApiError(401,'invalid_signature','设备签名无效或挑战已使用');
      await c.query('DELETE FROM sa_challenges WHERE nonce=$1',[d.nonce]);await c.query('COMMIT');
      return{access_token:await this.token({type:'device',tenant:d.tenant_id,device:d.device_id,key_version:d.key_version},300),expires_in:300};
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }
  async runTicket(p:Principal,run:Doc):Promise<string>{return this.token({type:'run',tenant:p.tenant,device:p.device,run:run.id,epoch:String(run.lease_epoch)},60);}
  async run(p:Principal,tx:Tx,token:unknown,requestedRun?:string,allowStopping=false):Promise<Doc>{
    this.device(p);if(typeof token!=='string')throw new ApiError(403,'run_ticket_required','需要当前执行授权');
    const t=await this.decode(token);if(t.type!=='run'||t.tenant!==p.tenant||t.device!==p.device||(requestedRun&&t.run!==requestedRun))throw new ApiError(403,'invalid_run_ticket','执行授权不匹配');
    const run=await tx.need('runs',uuid(t.run));
    if(run.device_id!==p.device||String(run.lease_epoch)!==String(t.epoch)||Date.parse(run.lease_expires_at)<Date.now()||(!allowStopping&&!['starting','running','waiting_input'].includes(run.state)))throw new ApiError(409,'run_lease_invalid','执行授权已失效');
    return run;
  }
  async assistant(p:Principal,tx:Tx,epoch:unknown):Promise<Doc>{
    this.device(p);const lease=await tx.get('assistant_leases',p.tenant);
    if(!lease||lease.device_id!==p.device||String(lease.epoch)!==String(epoch)||Date.parse(lease.expires_at)<Date.now())throw new ApiError(409,'assistant_lease_invalid','主助理租约已失效');
    return lease;
  }
}
