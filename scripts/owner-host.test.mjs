import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
import {readOwnerConfig,openOwnerHost} from './core/owner-host.mjs';
import {run} from './pm-host.mjs';
import {csvRead} from './core/file-model.mjs';
import {emptyRevision} from './core/file-store.mjs';

// A synthetic local socket peer: no authentication, visibility or AI-host proof.
async function fixture({authenticated=true,failCreate=false,failInstruction=false}={}){
  const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'owner-entry-')));await fs.chmod(base,0o700);
  const repo=path.join(base,'project'),home=path.join(base,'home'),profile=path.join(base,'profile'),state=path.join(base,'runtime');
  for(const p of [repo,home,profile,state])await fs.mkdir(p,{mode:0o700});
  const socket=path.join(base,'host.sock'),configFile=path.join(base,'owner.json');
  const config={version:1,home,codex_home:profile,socket,state,project:{id:'ATLAS',repo,manager_epoch:'epoch-a'},bindings:[],controller:{operation_id:'controller-a',actor:'manager-a',role:'manager'}};
  const clients=new Set(),threads=new Map(),calls=[],responses=new Map();let sequence=10000,permitBeforeCreate=false;
  const server=createServer(client=>{clients.add(client);client.on('close',()=>clients.delete(client));let buffer='';
    client.on('data',chunk=>{buffer+=chunk;for(;;){const end=buffer.indexOf('\n');if(end<0)break;const q=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);
      const send=result=>client.write(JSON.stringify({id:q.id,result})+'\n');calls.push(q.method??'tool-response');
      if(!q.method){responses.get(q.id)?.(q.result);responses.delete(q.id);continue;}
      if(q.method==='initialize')send({userAgent:'synthetic-owner-peer'});
      else if(q.method==='account/read')send({account:authenticated?{type:'synthetic'}:null,requiresOpenaiAuth:true});
      else if(q.method==='thread/start'){
        const filenames=[]; // The synchronous result below is delayed until the permit can be inspected.
        void fs.readdir(state).then(async names=>{for(const name of names)if(name.endsWith('.jsonl'))filenames.push(await fs.readFile(path.join(state,name),'utf8'));
          permitBeforeCreate=filenames.some(s=>s.includes('"kind":"permit"')&&!s.includes('"kind":"outcome"'));
          if(failCreate){client.write(JSON.stringify({id:q.id,error:{code:-1,message:'Synthetic failure'}})+'\n');return;}
          const thread={id:`context-${threads.size+1}`,createdAt:Math.floor(Date.now()/1000),status:{type:'idle'},turns:[]};threads.set(thread.id,thread);send({thread});});
      }else if(q.method==='turn/start'){if(failInstruction)client.write(JSON.stringify({id:q.id,error:{code:-1,message:'Synthetic instruction failure'}})+'\n');else send({turn:{id:'owner-turn-a'}});
      }else if(q.method==='thread/read'||q.method==='thread/resume')send({thread:threads.get(q.params.threadId)??null});
    }});
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socket,resolve);});
  await fs.writeFile(configFile,JSON.stringify(config),{mode:0o600});
  return {base,repo,state,configFile,config,calls,server,get permitBeforeCreate(){return permitBeforeCreate;},
    async command(request){const client=[...clients].at(-1),rid=++sequence;const result=new Promise(resolve=>responses.set(rid,resolve));client.write(JSON.stringify({id:rid,method:'item/tool/call',params:{threadId:'context-1',turnId:'turn-a',callId:`call-${rid}`,tool:'pm_command',arguments:request}})+'\n');return result;},
    async cleanup(){for(const c of clients)c.destroy();await new Promise(resolve=>server.close(resolve));await fs.rm(base,{recursive:true,force:true});}};
}

test('owner inspect is sanitized and unauthenticated prepare cannot create a controller',async()=>{
  const f=await fixture({authenticated:false});try{
    const out={value:'',write(s){this.value+=s;}};
    assert.equal(await run(['inspect','--config',f.configFile],{stdout:out}),0);
    assert.equal(JSON.parse(out.value).authenticated,false);assert(!out.value.includes(f.base));
    out.value='';assert.notEqual(await run(['prepare-controller','--config',f.configFile],{stdout:out}),0);
    assert.equal(JSON.parse(out.value).code,'AUTH_REQUIRED');assert(!f.calls.includes('thread/start'));assert.deepEqual(await fs.readdir(f.state),[]);
    assert(f.server.listening);
  }finally{await f.cleanup();}
});

test('private owner preparation is once-only; serve restores tools and writes only from a host envelope',async()=>{
  const f=await fixture();let session;try{
    const config=await readOwnerConfig(f.configFile);session=await openOwnerHost(config,{action:'prepare-controller'});
    assert.equal(session.status.created,true);assert.equal(session.privateContext.model_started,false);session.close();
    assert(f.permitBeforeCreate);assert(!f.calls.includes('turn/start'));assert(f.server.listening);
    session=await openOwnerHost(config,{action:'prepare-controller'});assert.equal(session.status.created,false);session.close();
    assert.equal(f.calls.filter(c=>c==='thread/start').length,1);
    session=await openOwnerHost({...config,monitor:false},{action:'serve'});assert.equal(session.status.bound_contexts,1);assert(f.calls.includes('thread/resume'));
    const result=await f.command({protocol:'project-files/1',command:'project init',repo:f.repo,project_id:'ATLAS',idempotency_key:'init-a',expected_revision:emptyRevision(),input:{root:f.repo,identity:'manager-a',policy:'policy-a'}});
    const body=JSON.parse(result.contentItems[0].text);assert.equal(body.exit,0);assert.equal(result.success,true);
    assert.deepEqual(csvRead(await fs.readFile(path.join(f.repo,'TASKS.csv'))),[]);
    session.close();assert(f.server.listening);
  }finally{session?.close();await f.cleanup();}
});

test('a preparation with a lost result remains unknown and never creates another context',async()=>{
  const f=await fixture({failCreate:true});try{
    const config=await readOwnerConfig(f.configFile);
    await assert.rejects(openOwnerHost(config,{action:'prepare-controller'}),{code:'EFFECT_UNKNOWN'});
    await assert.rejects(openOwnerHost(config,{action:'prepare-controller'}),{code:'EFFECT_UNKNOWN'});
    assert.equal(f.calls.filter(c=>c==='thread/start').length,1);assert(!f.calls.includes('turn/start'));
  }finally{await f.cleanup();}
});

test('owner config is private, outside project scope, and rejects secret or unknown fields',async()=>{
  const f=await fixture();try{
    await fs.chmod(f.configFile,0o644);await assert.rejects(readOwnerConfig(f.configFile),{code:'AUTH_DENIED'});await fs.chmod(f.configFile,0o600);
    await fs.writeFile(f.configFile,JSON.stringify({...f.config,apiKey:'private-sentinel'}));
    const out={value:'',write(s){this.value+=s;}};assert.notEqual(await run(['inspect','--config',f.configFile],{stdout:out}),0);assert(!out.value.includes('private-sentinel'));assert(!out.value.includes(f.base));
    await fs.writeFile(f.configFile,JSON.stringify({...f.config,state:f.repo}));await assert.rejects(readOwnerConfig(f.configFile),{code:'PATH_UNSAFE'});
    assert.equal(f.calls.length,0);
  }finally{await f.cleanup();}
});


test('owner instruction is explicit, private, once-only and never reported as running',async()=>{
  const f=await fixture();let session;try{
    const config=await readOwnerConfig(f.configFile);session=await openOwnerHost(config,{action:'prepare-controller'});session.close();
    const filename=path.join(f.base,'instruction.txt');await fs.writeFile(filename,'Owner-provided synthetic instruction',{mode:0o600});
    const instruction={id:'message-a',filename};session=await openOwnerHost(config,{action:'serve',instruction});
    assert.equal(session.status.owner_instruction.accepted,true);assert.equal(session.status.model_started,'unknown');session.close();
    session=await openOwnerHost(config,{action:'serve',instruction});assert.equal(session.status.owner_instruction.replayed_receipt,true);session.close();
    assert.equal(f.calls.filter(c=>c==='turn/start').length,1);
    await fs.writeFile(filename,'Changed instruction');await assert.rejects(openOwnerHost(config,{action:'serve',instruction}),{code:'FENCE_INVALID'});
    assert.equal(f.calls.filter(c=>c==='turn/start').length,1);
  }finally{session?.close();await f.cleanup();}
});

test('owner instruction with a missing result is not replayed on a new connection',async()=>{
  const f=await fixture({failInstruction:true});let session;try{
    const config=await readOwnerConfig(f.configFile);session=await openOwnerHost(config,{action:'prepare-controller'});session.close();
    const filename=path.join(f.base,'instruction.txt');await fs.writeFile(filename,'Synthetic instruction',{mode:0o600});
    const instruction={id:'message-a',filename};
    await assert.rejects(openOwnerHost(config,{action:'serve',instruction}),{code:'EFFECT_UNKNOWN'});
    await assert.rejects(openOwnerHost(config,{action:'serve',instruction}),{code:'EFFECT_UNKNOWN'});
    assert.equal(f.calls.filter(c=>c==='turn/start').length,1);
  }finally{session?.close();await f.cleanup();}
});


test('a missing owner runtime dependency emits only a stable error DTO',async()=>{
  const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'owner-boot-sentinel-')));
  try{
    const file=path.join(base,'pm-host.mjs');await fs.copyFile(new URL('./pm-host.mjs',import.meta.url),file);
    const child=spawnSync(process.execPath,[file,'inspect','--config',path.join(base,'config.json')],{encoding:'utf8'});
    assert.equal(child.status,70);assert.equal(JSON.parse(child.stdout).code,'INTERNAL_ERROR');assert.equal(child.stderr,'');assert(!child.stdout.includes(base));
  }finally{await fs.rm(base,{recursive:true,force:true});}
});
