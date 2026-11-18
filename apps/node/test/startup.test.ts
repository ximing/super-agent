import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureCsiStarted, launchAgentPath, launchAgentPlist } from '../src/startup.js';

test('LaunchAgent preserves absolute command paths and decodes spaces while persisting only PATH',()=>{
  const path=launchAgentPath('/Users/Test User/.nvm/versions/node/v24/bin/node','.:relative:/opt/homebrew/bin:/Users/Test User/custom/bin:/bad\nentry:/usr/bin:/opt/homebrew/bin');
  assert.equal(path.split(':')[0],'/Users/Test User/.nvm/versions/node/v24/bin');
  assert.ok(path.includes('/Users/Test User/custom/bin'));assert.ok(path.includes('/opt/homebrew/bin'));assert.equal(path.split(':').filter(entry=>entry==='/opt/homebrew/bin').length,1);
  assert.ok(path.split(':').every(entry=>entry.startsWith('/')&&!entry.includes('\n')));
  const plist=launchAgentPlist({execPath:'/Users/Test User/node/bin/node',scriptUrl:pathToFileURL('/Users/Test User/My Worker & Tools/cli.js'),configPath:'/Users/Test User/worker & data/node.json',outputDir:'/Users/Test User/worker & data/logs',currentPath:path});
  assert.ok(plist.includes('/Users/Test User/My Worker &amp; Tools/cli.js'));assert.doesNotMatch(plist,/%20/);
  const env=/<key>EnvironmentVariables<\/key><dict>(.*?)<\/dict>/.exec(plist)?.[1];assert.ok(env);assert.equal((env.match(/<key>/g)??[]).length,1);assert.ok(env.includes('<key>PATH</key>'));
  assert.doesNotMatch(plist,/XAI_API_KEY|CODEX_HOME|HTTPS_PROXY|PRIVATE KEY/);
});

test('fake startup skips even the executable check; missing CSI emits only a fixed diagnostic',async()=>{
  const messages:string[]=[];
  assert.equal(await ensureCsiStarted(true,{checkExecutable:async()=>{throw new Error('Must not access installed CSI');},run:async()=>{throw new Error('Must not execute');},log:message=>messages.push(message)}),'skipped-fake');
  assert.deepEqual(messages,[]);
  assert.equal(await ensureCsiStarted(false,{home:'/nonexistent/test-home',checkExecutable:async()=>{throw new Error('SENSITIVE_INTERNAL_DETAIL');},log:message=>messages.push(message)}),'unavailable');
  assert.equal(messages.length,1);assert.match(messages[0]!,/other tasks can continue/);assert.doesNotMatch(messages[0]!,/SENSITIVE|nonexistent/);
});

test('existing CSI executable receives only idempotent start; output and failed diagnostics stay private',async()=>{
  const home=await mkdtemp(join(tmpdir(),'super-agent csi startup ')),messages:string[]=[];
  const executable=join(home,'.csi','bin','csi');
  try{
    await mkdir(join(home,'.csi','bin'),{recursive:true});
    await writeFile(executable,'#!/bin/sh\n[ "$#" -eq 1 ] && [ "$1" = "start" ] || exit 2\nexit 0\n');await chmod(executable,0o700);
    assert.equal(await ensureCsiStarted(false,{home,log:message=>messages.push(message)}),'ready');
    assert.equal(await ensureCsiStarted(false,{home,log:message=>messages.push(message)}),'ready');assert.deepEqual(messages,[]);
    await writeFile(executable,'#!/bin/sh\necho SENSITIVE_CHILD_OUTPUT >&2\nexit 1\n');
    assert.equal(await ensureCsiStarted(false,{home,log:message=>messages.push(message)}),'unavailable');assert.equal(messages.length,1);assert.doesNotMatch(messages[0]!,/SENSITIVE/);
  }finally{await rm(home,{recursive:true,force:true});}
});
