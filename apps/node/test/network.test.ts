import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { configureNetwork, macosProxySettings } from '../src/network.js';

const system = `<dictionary> {
  HTTPEnable : 1
  HTTPProxy : 127.0.0.1
  HTTPPort : 7890
  HTTPSEnable : 1
  HTTPSProxy : 127.0.0.1
  HTTPSPort : 7890
}`;

test('explicit lowercase proxy env beats config/system, preserves exclusions and restores process state', async () => {
  const env = { HTTP_PROXY:'http://upper.invalid:8080',http_proxy:'http://lower.invalid:8081',NO_PROXY:'.company.invalid',no_proxy:'.other.invalid' } as NodeJS.ProcessEnv;
  const original={...env}; let called=0, restored=0;
  const setup=await configureNetwork({proxy_url:'http://config.invalid:8080'},{env,platform:'darwin',readSystemProxy:async()=>{throw new Error('Must not inspect system when explicit');},setGlobalProxy:value=>{
    called++;assert.equal(value.HTTP_PROXY,'http://lower.invalid:8081/');assert.equal(value.HTTPS_PROXY,value.HTTP_PROXY);
    for(const local of ['localhost','127.0.0.1','::1'])assert.ok(value.no_proxy?.split(',').includes(local));
    assert.ok(value.no_proxy?.includes('.company.invalid'));assert.ok(value.no_proxy?.includes('.other.invalid'));
    return()=>{restored++;};
  }});
  assert.equal(setup.source,'environment');assert.equal(called,1);setup.restore();setup.restore();assert.equal(restored,1);assert.deepEqual(env,original);
});

test('local config precedes macOS; system HTTP proxy is inherited when no overrides exist',async()=>{
  let systemReads=0;
  const options={platform:'darwin' as const,readSystemProxy:async()=>{systemReads++;return system;},setGlobalProxy:()=>()=>{}};
  const configured=await configureNetwork({proxy_url:'http://configured.invalid:8123'},{...options,env:{}});assert.equal(configured.source,'config');assert.equal(systemReads,0);configured.restore();
  const env:NodeJS.ProcessEnv={};const inherited=await configureNetwork({},{...options,env});assert.equal(inherited.source,'macos-system');assert.equal(systemReads,1);assert.equal(env.HTTPS_PROXY,'http://127.0.0.1:7890/');inherited.restore();
  assert.deepEqual(env,{});
});

test('proxy configuration fails closed on old Node, unsupported SOCKS/PAC or invalid URL without exposing credentials',async()=>{
  const env:NodeJS.ProcessEnv={};await assert.rejects(configureNetwork({proxy_url:'http://proxy.invalid:8080'},{env,setGlobalProxy:null}),/Node.js 24.14\+/);assert.deepEqual(env,{});
  await assert.rejects(configureNetwork({proxy_url:'socks5://test-user:test-password@proxy.invalid:1080'},{env,setGlobalProxy:()=>()=>{}}),error=>{assert.match(String(error),/HTTP\(S\)/);assert.doesNotMatch(String(error),/test-user|test-password/);return true;});
  assert.throws(()=>macosProxySettings('ProxyAutoConfigEnable : 1'),/PAC\/SOCKS/);
  await assert.rejects(configureNetwork({proxy_url:'http://test-user:test-password@proxy.invalid:8080'},{env,setGlobalProxy:()=>{throw new Error('test-password');}}),error=>{assert.doesNotMatch(String(error),/test-user|test-password/);return true;});
});

test('reset replaces a wedged proxy dispatcher and leaves the process proxy in place', async () => {
  let called = 0, undone = 0;
  const env: NodeJS.ProcessEnv = {};
  const setup = await configureNetwork({ proxy_url: 'http://127.0.0.1:7890' }, { env, platform: 'linux', setGlobalProxy: () => { called++; return () => { undone++; }; } });
  assert.equal(called, 1);
  setup.reset();
  assert.equal(called, 2);
  assert.equal(undone, 1);
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:7890/');
  setup.restore();
  assert.equal(undone, 2);
  assert.deepEqual(env, {});
});

test('setup configures fetch dispatcher and actual spawned child inherits the same proxy and local bypass',async()=>{
  let dispatcherConfigured=false;
  const setup=await configureNetwork({proxy_url:'http://127.0.0.1:7890'},{env:process.env,platform:'linux',setGlobalProxy:()=>{dispatcherConfigured=true;return()=>{};}});
  try{
    const child=await promisify(execFile)(process.execPath,['-e',`process.stdout.write(JSON.stringify({proxyPresent:!!process.env.HTTPS_PROXY,localBypass:process.env.NO_PROXY.split(',').includes('127.0.0.1')}))`]);
    const summary=JSON.parse(child.stdout);assert.equal(dispatcherConfigured,true);assert.equal(summary.proxyPresent,true);assert.equal(summary.localBypass,true);
  }finally{setup.restore();}
});
