export function requireCloudTestDatabase(appValue:unknown,migrationValue:unknown):void{
  if(typeof appValue!=='string'||typeof migrationValue!=='string')throw new Error('Dedicated TEST_DATABASE_URL and TEST_MIGRATION_DATABASE_URL are required');
  let app:URL,migration:URL;
  try{app=new URL(appValue);migration=new URL(migrationValue);}catch{throw new Error('Cloud test database URL is invalid');}
  const blocked=new Set(['localhost','127.0.0.1','::1','[::1]','0.0.0.0','host.docker.internal']);
  const valid=(u:URL)=>['postgres:','postgresql:'].includes(u.protocol)&&!blocked.has(u.hostname)&&u.hostname!==''&&/^\/[a-z0-9_]+_test$/i.test(u.pathname)&&!u.pathname.toLowerCase().includes('prod')&&!!u.username;
  if(!valid(app)||!valid(migration)||app.hostname!==migration.hostname||(app.port||'5432')!==(migration.port||'5432')||app.pathname!==migration.pathname||app.username===migration.username)throw new Error('Tests require one dedicated cloud *_test database with separate app/migration roles; local and production databases are refused');
}
