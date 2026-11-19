import { buildApp } from './app.js';
import { Store } from './store.js';
import { readFile } from 'node:fs/promises';

const databaseUrl=process.env.DATABASE_URL;
const jwtSecret=process.env.JWT_SECRET;
if(!databaseUrl||!jwtSecret)throw new Error('DATABASE_URL and JWT_SECRET are required; use your cloud PostgreSQL connection');
if(process.env.AUTO_MIGRATE==='true'){if(!process.env.MIGRATION_DATABASE_URL)throw new Error('AUTO_MIGRATE requires a separate MIGRATION_DATABASE_URL');const store=new Store(process.env.MIGRATION_DATABASE_URL);try{await store.migrate();}finally{await store.close();}}
const s3Access=process.env.S3_ACCESS_KEY_ID??process.env.S3_ACCESS_KEY,s3Secret=process.env.S3_SECRET_ACCESS_KEY??process.env.S3_SECRET_KEY;
const s3=process.env.S3_ENDPOINT&&process.env.S3_BUCKET&&s3Access&&s3Secret?{endpoint:process.env.S3_ENDPOINT,bucket:process.env.S3_BUCKET,region:process.env.S3_REGION??'us-east-1',accessKey:s3Access,secretKey:s3Secret}:undefined;
let apnsPrivateKey:string|undefined;
if(process.env.APNS_PRIVATE_KEY_FILE){try{apnsPrivateKey=await readFile(process.env.APNS_PRIVATE_KEY_FILE,'utf8');}catch{/* Provider remains explicitly unconfigured; never log a credential path or value. */}}
const apns=process.env.APNS_KEY_ID&&process.env.APNS_TEAM_ID&&process.env.APNS_TOPIC&&apnsPrivateKey?{keyId:process.env.APNS_KEY_ID,teamId:process.env.APNS_TEAM_ID,topic:process.env.APNS_TOPIC,privateKey:apnsPrivateKey,environment:process.env.APNS_ENVIRONMENT==='sandbox'?'sandbox' as const:'production' as const}:undefined;
const expo=process.env.EXPO_PROJECT_ID?{projectId:process.env.EXPO_PROJECT_ID,accessToken:process.env.EXPO_ACCESS_TOKEN}:undefined;
const app=await buildApp({databaseUrl,jwtSecret,allowDevAuth:process.env.ALLOW_DEV_AUTH==='true',oidcIssuer:process.env.OIDC_ISSUER,oidcAudience:process.env.OIDC_AUDIENCE,oidcClientId:process.env.OIDC_CLIENT_ID,oidcRedirectUri:process.env.OIDC_REDIRECT_URI,s3,memoryEncryptionKey:process.env.MEMORY_ENCRYPTION_KEY,recallAllowedOrigins:process.env.RECALL_ALLOWED_ORIGINS?.split(',').map(v=>v.trim()).filter(Boolean),notifications:{apns,expo},logger:true});
await app.listen({port:Number(process.env.PORT??8787),host:process.env.HOST??'127.0.0.1'});
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{void app.close();});
