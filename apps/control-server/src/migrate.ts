import { Store } from './store.js';
const migrationUrl=process.env.MIGRATION_DATABASE_URL??process.env.TEST_MIGRATION_DATABASE_URL;
if(!migrationUrl)throw new Error('MIGRATION_DATABASE_URL (or TEST_MIGRATION_DATABASE_URL) must point to the cloud migration-owner connection');
const store=new Store(migrationUrl);
try{await store.migrate();console.log('Control server migrations applied');}finally{await store.close();}
