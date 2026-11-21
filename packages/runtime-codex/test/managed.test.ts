import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodexRuntime } from '../src/index.js';
import { managedCodexArgs } from '../src/managed.js';
import type { RuntimeContext } from '@super-agent/tool-broker/runtime';
const expectedFeatures=['shell_tool','unified_exec','apps','plugins','browser_use','computer_use','multi_agent','view_image','hooks'];

async function cliFixture(dir:string,features=expectedFeatures):Promise<{command:string;record:string}> {
  const command=join(dir,'fake-codex'),record=join(dir,'spawn.json');
  const source=`#!/usr/bin/env node
const fs=require('node:fs');
if(process.argv[2]==='features'){process.stdout.write(${JSON.stringify(features.map(name=>name+' stable true').join('\n'))});process.exit(0);}
fs.writeFileSync(${JSON.stringify(record)},JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(${JSON.stringify(record)}+'.env',JSON.stringify({HTTPS_PROXY:process.env.HTTPS_PROXY??null,NO_PROXY:process.env.NO_PROXY??''}));
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
const rl=require('node:readline').createInterface({input:process.stdin});
rl.on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{}});
 if(m.method==='thread/start'){
  if(m.params.config){const bridge=m.params.config['mcp_servers.super_agent'];if(!bridge?.enabled){send({id:m.id,error:{code:-1,message:'Managed bridge disabled'}});return;}}
  else if(!m.params.dynamicTools?.length){send({id:m.id,error:{code:-1,message:'Dynamic tools missing'}});return;}
  send({id:m.id,result:{thread:{id:'managed-thread'}}});
 }
 if(m.method==='turn/start'){send({id:m.id,result:{turn:{id:'managed-turn'}}});send({method:'item/completed',params:{threadId:'managed-thread',item:{type:'agentMessage',text:'managed'}}});send({method:'turn/completed',params:{threadId:'managed-thread',turn:{id:'managed-turn',status:'completed'}}});}
});
`;
  await writeFile(command,source,{mode:0o700});await chmod(command,0o700);return{command,record};
}
function context(cwd:string):RuntimeContext{return{runId:'r',taskId:'t',cwd,goal:'Use managed fixture',modelId:'mock',tools:[{name:'files_read',description:'Read',parameters:{type:'object'}}],executeTool:async()=>({}),emit:()=>{},signal:new AbortController().signal};}

test('default runtime spawn uses proven managed flags and disables global MCP while dynamic and explicit bridge stay usable',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'super-agent-managed-')),oldHome=process.env.CODEX_HOME;
  try{
    process.env.CODEX_HOME=dir;
    await writeFile(join(dir,'config.toml'),'[mcp_servers.personal]\ncommand="DO_NOT_FORWARD_CONFIG_VALUE"\n[mcp_servers.personal.env]\nTOKEN="DO_NOT_FORWARD_SECRET_VALUE"\n[mcp_servers.super_agent]\ncommand="user-global-command"\n');
    const fixture=await cliFixture(dir);
    const runtime=new CodexRuntime({command:fixture.command,timeoutMs:1000,maxRunMs:3000});assert.equal((await runtime.execute(context(dir))).text,'managed');
    const args=JSON.parse(await readFile(fixture.record,'utf8')) as string[];
    for(const feature of expectedFeatures){const index=args.indexOf(feature);assert.ok(index>0&&args[index-1]==='--disable',feature+' must be disabled');}
    assert.ok(args.includes('mcp_servers.personal.enabled=false'));assert.ok(args.includes('mcp_servers.super_agent.enabled=false'));assert.ok(args.includes('web_search="disabled"'));assert.deepEqual(args.slice(-2),['app-server','--stdio']);assert.doesNotMatch(JSON.stringify(args),/DO_NOT_FORWARD|user-global-command/);
    const bridgeContext={...context(dir),mcp:{url:'http://127.0.0.1:1',token:'test-only-bridge',script:'/tmp/managed-mcp-fixture.js'}};
    assert.equal((await new CodexRuntime({command:fixture.command,toolsMode:'mcp',timeoutMs:1000,maxRunMs:3000}).execute(bridgeContext)).text,'managed');
  }finally{if(oldHome===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=oldHome;await rm(dir,{recursive:true,force:true});}
});

test('model proxy env reaches the codex child and stays off the parent process',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'super-agent-managed-proxy-')),parent=process.env.HTTPS_PROXY,oldHome=process.env.CODEX_HOME;
  try{
    process.env.CODEX_HOME=dir;
    await writeFile(join(dir,'config.toml'),'model = "configured-default"\n');
    const fixture=await cliFixture(dir);
    const env={...process.env,HTTPS_PROXY:'http://127.0.0.1:7890/',HTTP_PROXY:'http://127.0.0.1:7890/',NO_PROXY:'localhost,127.0.0.1,::1'};
    assert.equal((await new CodexRuntime({command:fixture.command,timeoutMs:1000,maxRunMs:3000,env}).execute(context(dir))).text,'managed');
    const saved=JSON.parse(await readFile(`${fixture.record}.env`,'utf8')) as {HTTPS_PROXY:string;NO_PROXY:string};
    assert.equal(saved.HTTPS_PROXY,'http://127.0.0.1:7890/');
    assert.ok(saved.NO_PROXY.split(',').includes('127.0.0.1'));
    assert.equal(process.env.HTTPS_PROXY,parent);
  }finally{if(parent===undefined)delete process.env.HTTPS_PROXY;else process.env.HTTPS_PROXY=parent;if(oldHome===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=oldHome;await rm(dir,{recursive:true,force:true});}
});

test('unsupported managed feature fails explicitly before spawning an app-server',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'super-agent-managed-old-'));
  try{const fixture=await cliFixture(dir,['shell_tool']);await assert.rejects(new CodexRuntime({command:fixture.command}).execute(context(dir)),/codex_managed_cli_incompatible/);assert.equal(existsSync(fixture.record),false);}
  finally{await rm(dir,{recursive:true,force:true});}
});

test('MCP config scanner retains only section names, scans task config and refuses inline/profile forms',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'super-agent-managed-config-')),cwd=join(dir,'task');
  try{
    await mkdir(join(cwd,'.codex'),{recursive:true});
    await writeFile(join(dir,'config.toml'),'[mcp_servers."quoted server"]\nurl="SECRET_URL_NOT_FORWARDED"\n');
    await writeFile(join(cwd,'.codex','config.toml'),'[mcp_servers.workspace]\ncommand="SECRET_COMMAND_NOT_FORWARDED"\n');
    const options={cwd,launchCwd:cwd,configHome:dir,systemConfig:join(dir,'missing.toml')};
    const args=await managedCodexArgs(options);assert.ok(args.includes('mcp_servers."quoted server".enabled=false'));assert.ok(args.includes('mcp_servers.workspace.enabled=false'));assert.doesNotMatch(JSON.stringify(args),/SECRET_/);
    await writeFile(join(dir,'config.toml'),'mcp_servers = { dangerous = { command = "SECRET" } }\n');await assert.rejects(managedCodexArgs(options),/requires_section_headers/);
    await writeFile(join(dir,'config.toml'),'[profiles.example.mcp_servers.external]\ncommand="SECRET"\n');await assert.rejects(managedCodexArgs(options),/section_unsupported/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
