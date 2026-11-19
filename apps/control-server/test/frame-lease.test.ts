import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { Store } from '../src/store.js';
import { requireCloudTestDatabase } from './cloud-guard.js';

const databaseUrl=process.env.TEST_DATABASE_URL,ownerUrl=process.env.TEST_MIGRATION_DATABASE_URL;
if(databaseUrl)requireCloudTestDatabase(databaseUrl,ownerUrl);
test('cloud frame polling commits its lease before first-frame 404 and accepts capture beyond the original window', {skip:!databaseUrl,timeout:60000},async t=>{
  const migration=new Store(ownerUrl!);try{await migration.migrate();}finally{await migration.close();}
  const app=await buildApp({databaseUrl:databaseUrl!,jwtSecret:'frame-lease-regression-secret-at-least-32-bytes',allowDevAuth:true,runScheduler:false});
  const call=(method:string,path:string,token?:string,payload?:unknown)=>app.inject({method:method as never,url:'/v1'+path,headers:token?{authorization:`Bearer ${token}`}:{},...(payload===undefined?{}:{payload})});
  try{
    const login=await call('POST','/auth/dev',undefined,{email:`frame-lease-${randomUUID()}@test.invalid`});assert.equal(login.statusCode,200);const session=login.json(),tenant=session.user.tenant_id;
    const foreign=(await call('POST','/auth/dev',undefined,{email:`frame-foreign-${randomUUID()}@test.invalid`})).json();
    const keys=generateKeyPairSync('ed25519'),pair=(await call('POST','/device-pairings',undefined,{name:'Delayed first-frame fixture',public_key:keys.publicKey.export({type:'spki',format:'pem'}).toString()})).json();
    const claim=await call('POST','/device-pairings/claim',session.access_token,{code:pair.code});assert.equal(claim.statusCode,200);const deviceId=claim.json().device_id;
    const challenge=(await call('POST','/devices/auth/challenge',undefined,{device_id:deviceId})).json();
    const deviceAuth=await call('POST','/devices/auth/token',undefined,{device_id:deviceId,nonce:challenge.nonce,signature:sign(null,Buffer.from(challenge.challenge),keys.privateKey).toString('base64')});assert.equal(deviceAuth.statusCode,200);const deviceToken=deviceAuth.json().access_token;
    const run=await app.control.store.tenant(tenant,async tx=>{
      const task=await app.control.service.createTask(tx,{goal:'Wait for the browser before capturing',engine:'codex',device_id:deviceId});
      const value=await tx.put('runs',{task_id:task.id,device_id:deviceId,engine:'codex',model_id:'fixture',state:'paused',lease_epoch:'1',lease_expires_at:new Date().toISOString()});
      await tx.put('tasks',{...task,status:'paused',current_run_id:value.id});return value;
    });
    const start=await call('POST',`/runs/${run.id}/views`,session.access_token,{});assert.equal(start.statusCode,200);const viewId=start.json().id;
    const original=await app.control.store.tenant(tenant,tx=>tx.need('views',viewId)),started=Date.now();
    let simulated=started+20000;t.mock.method(Date,'now',()=>simulated);
    assert.equal((await call('GET',`/runs/${run.id}/frame`,foreign.access_token)).statusCode,404);
    assert.equal((await app.control.store.tenant(tenant,tx=>tx.need('views',viewId))).expires_at,original.expires_at,'A foreign tenant cannot renew the viewer');
    const waiting=await call('GET',`/runs/${run.id}/frame`,session.access_token);assert.equal(waiting.statusCode,404);assert.equal(waiting.json().error.code,'not_found');
    const renewed=await app.control.store.tenant(tenant,tx=>tx.need('views',viewId));assert.ok(Date.parse(renewed.expires_at)>Date.parse(original.expires_at)+15000,'The missing-frame response must not roll back its lease renewal');
    simulated=started+35000;assert.ok(simulated>Date.parse(original.expires_at));assert.ok(simulated<Date.parse(renewed.expires_at));
    const frame={frame_id:randomUUID(),image_base64:Buffer.from([255,216,255,0]).toString('base64'),width:100,height:80,captured_at:new Date(simulated).toISOString(),viewport_version:'delayed-v1',tab_id:'fixture'};
    const captured=await call('POST',`/node/runs/${run.id}/frames`,deviceToken,frame);assert.equal(captured.statusCode,200,'Capture remains active after the original 30-second window');
    const visible=await call('GET',`/runs/${run.id}/frame`,session.access_token);assert.equal(visible.statusCode,200);assert.deepEqual(visible.json(),frame);assert.equal(visible.json().object_key,undefined);assert.equal(visible.json().tenant_id,undefined);
    await call('DELETE',`/views/${viewId}`,session.access_token);
    const closed=await app.control.store.tenant(tenant,tx=>tx.need('views',viewId));simulated+=10000;
    assert.equal((await call('GET',`/runs/${run.id}/frame`,session.access_token)).statusCode,200);assert.equal((await app.control.store.tenant(tenant,tx=>tx.need('views',viewId))).expires_at,closed.expires_at,'A closed viewer must not be renewed');
  }finally{t.mock.restoreAll();await app.close();}
});
