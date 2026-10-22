// Explicit local-owner entry. This file is never a model-callable RPC surface.
import fs from 'node:fs/promises';
import path from 'node:path';
import {connectHostBridge} from './host-bridge.mjs';
import {execute,digest,parseJSON} from './engine.mjs';
import {fail,validate,id,ROLE} from './contracts.mjs';
import {openLock,identity,regular} from './file-platform.mjs';
import {parseExecutionInventory} from './execution-inventory.mjs';
import {HostMonitor} from './host-monitor.mjs';

function keys(value,allowed,required=allowed){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!allowed.includes(k))||required.some(k=>!Object.hasOwn(value,k)))fail('INVALID_INPUT');
}
async function privateDirectory(value){
  if(typeof value!=='string'||!path.isAbsolute(value))fail('PATH_UNSAFE');
  const actual=await fs.realpath(value),st=await fs.lstat(actual);
  if(!st.isDirectory()||st.uid!==process.getuid()||(st.mode&0o077))fail('AUTH_DENIED');
  return actual;
}
export async function readOwnerConfig(filename){
  if(!path.isAbsolute(filename))fail('PATH_UNSAFE');
  const st=await regular(filename);
  if(st.uid!==process.getuid()||(st.mode&0o077)||st.size>16384)fail('AUTH_DENIED');
  const config=parseJSON(await fs.readFile(filename,'utf8'));
  keys(config,['version','executable','home','codex_home','socket','state','project','bindings','controller','monitor','file_credentials'],['version','home','codex_home','state','project','bindings']);
  if(config.version!==1||(!!config.executable===!!config.socket)||typeof(config.monitor??false)!=='boolean'||typeof(config.file_credentials??false)!=='boolean')fail('INVALID_INPUT');
  const home=await privateDirectory(config.home),codexHome=await privateDirectory(config.codex_home),state=await privateDirectory(config.state);
  keys(config.project,['id','repo','manager_epoch']);validate(config.project.id,id);validate(config.project.manager_epoch,id);
  if(typeof config.project.repo!=='string'||!path.isAbsolute(config.project.repo))fail('PATH_UNSAFE');
  const repo=await fs.realpath(config.project.repo);
  if(!path.isAbsolute(config.project.repo)||!(await fs.stat(repo)).isDirectory())fail('PATH_UNSAFE');
  await privateDirectory(path.dirname(await fs.realpath(filename)));
  for(const location of [state,home,codexHome,await fs.realpath(filename)])if(location===repo||location.startsWith(`${repo}${path.sep}`))fail('PATH_UNSAFE');
  if(!Array.isArray(config.bindings)||config.bindings.length>16)fail('INVALID_INPUT');
  for(const b of config.bindings){keys(b,['thread_id','actor','role']);validate(b.thread_id,id);validate(b.actor,id);validate(b.role,ROLE);}
  if(config.controller){keys(config.controller,['operation_id','actor','role']);validate(config.controller.operation_id,id);validate(config.controller.actor,id);if(!['manager','owner','reviewer'].includes(config.controller.role))fail('AUTH_DENIED');}
  return {...config,home,codex_home:codexHome,state,project:{...config.project,repo}};
}
const binding=(config,value)=>({...value,repo:config.project.repo,project_id:config.project.id,manager_epoch:config.project.manager_epoch});
const recordFile=config=>path.join(config.state,`owner-context-${digest(config.controller.operation_id).slice(7)}.jsonl`);
async function header(config){return {format:'owner-context/1',configuration:digest({project:config.project,controller:config.controller}),profile:await identity(config.codex_home),root:await identity(config.project.repo)};}
async function readController(config){
  const filename=recordFile(config);const st=await regular(filename);
  if(st.uid!==process.getuid()||(st.mode&0o077))fail('AUTH_DENIED');
  const values=parseExecutionInventory(await fs.readFile(filename),await header(config));
  if(values.length===1&&values[0].kind==='permit')fail('EFFECT_UNKNOWN');
  if(values.length!==2||values[0].kind!=='permit'||values[1].kind!=='outcome'||values[1].value?.model_started!==false)fail('FENCE_INVALID');
  return values[1].value;
}
async function prepareController(config,bridge){
  if(!config.controller)fail('INVALID_INPUT');
  if(!bridge.capability.authenticated)fail('AUTH_REQUIRED');
  const lock=await openLock(config.project.repo,{state:config.state,create:true});
  try{
    const filename=recordFile(config);
    try{return {created:false,...await readController(config)};}catch(error){if(error.code!=='ENOENT')throw error;}
    const h=await header(config),permit={kind:'permit',operation_id:config.controller.operation_id,purpose:'explicit-owner-context-only'};
    const first={previous:digest(h),digest:digest(permit),value:permit};
    const file=await fs.open(filename,'wx',0o600);
    try{await file.writeFile(`${JSON.stringify(h)}\n${JSON.stringify(first)}\n`);}finally{await file.close();}
    await lock.flush(filename);await lock.flush(config.state);
    // This administrative context has no model turn and changes no project truth.
    // A retained permit without an outcome is never automatically retried.
    const {operation_id,...role}=config.controller;let context;
    try{context=await bridge.createOwnerContext(binding(config,role));}catch{fail('EFFECT_UNKNOWN');}
    const outcome={kind:'outcome',operation_id,value:context},record={previous:digest(first),digest:digest(outcome),value:outcome};
    await fs.appendFile(filename,`${JSON.stringify(record)}\n`);await lock.flush(filename);
    return {created:true,...context};
  }finally{await lock.release();}
}

async function submitOwnerInstruction(config,bridge,instruction){
  if(!config.controller)fail('AUTH_REQUIRED');
  keys(instruction,['id','filename']);validate(instruction.id,id);
  if(typeof instruction.filename!=='string'||!path.isAbsolute(instruction.filename))fail('PATH_UNSAFE');
  const actual=await fs.realpath(instruction.filename),st=await regular(actual);
  if(st.uid!==process.getuid()||(st.mode&0o077)||st.size>65536||actual===config.project.repo||actual.startsWith(`${config.project.repo}${path.sep}`))fail('AUTH_DENIED');
  const text=await fs.readFile(actual,'utf8');if(!text.trim())fail('INVALID_INPUT');
  const context=await readController(config),lock=await openLock(config.project.repo,{state:config.state});
  try{
    const filename=path.join(config.state,`owner-message-${digest(instruction.id).slice(7)}.jsonl`),h={format:'owner-message/1',context:context.thread_id,root:lock.rootId,input_digest:digest(text)};
    try{
      const st=await regular(filename);if(st.uid!==process.getuid()||(st.mode&0o077))fail('AUTH_DENIED');
      const previous=parseExecutionInventory(await fs.readFile(filename),h);
      if(previous.length===2&&previous[1].kind==='outcome')return {accepted:true,replayed_receipt:true,running:'unknown'};
      fail('EFFECT_UNKNOWN');
    }catch(error){if(error.code!=='ENOENT')throw error;}
    const permit={kind:'permit',purpose:'explicit-owner-instruction',operation_id:instruction.id},first={previous:digest(h),digest:digest(permit),value:permit};
    const fd=await fs.open(filename,'wx',0o600);try{await fd.writeFile(`${JSON.stringify(h)}\n${JSON.stringify(first)}\n`);}finally{await fd.close();}
    await lock.flush(filename);await lock.flush(config.state);
    let reply;try{reply=await bridge.sendOwnerInstruction(context.thread_id,text);}catch{fail('EFFECT_UNKNOWN');}
    const outcome={kind:'outcome',value:reply},record={previous:digest(first),digest:digest(outcome),value:outcome};
    await fs.appendFile(filename,`${JSON.stringify(record)}\n`);await lock.flush(filename);
    return {accepted:true,running:'unknown'};
  }finally{await lock.release();}
}

export async function openOwnerHost(config,{action='inspect',instruction=null}={}){
  if(!['inspect','prepare-controller','serve'].includes(action))fail('INVALID_INPUT');
  const bridge=await connectHostBridge({executable:config.executable,home:config.home,codexHome:config.codex_home,socketPath:config.socket??null,
    fileCredentials:config.file_credentials??false,onCommand:(request,token)=>execute(request,{hostIdentityToken:token,state:config.state})});
  let monitor=null;
  try{
    const status={connected:true,authenticated:bridge.capability.authenticated,identity:'pending-host-call',ordinary_ui_visibility:'unknown',ordinary_ui_recovery:'unknown',model_started:false};
    if(action==='inspect')return {status,closed:bridge.closed,close:()=>bridge.close()};
    if(!status.authenticated)fail('AUTH_REQUIRED');
    if(action==='prepare-controller'){
      const context=await prepareController(config,bridge);
      return {status:{...status,controller_prepared:true,created:context.created},privateContext:context,closed:bridge.closed,close:()=>bridge.close()};
    }
    const routes=[...config.bindings];
    if(config.controller){const context=await readController(config);routes.push({thread_id:context.thread_id,actor:config.controller.actor,role:config.controller.role});}
    if(!routes.some(b=>b.role==='manager'))fail('AUTH_REQUIRED');
    if(new Set(routes.map(b=>b.thread_id)).size!==routes.length)fail('INVALID_INPUT');
    for(const route of routes){await bridge.bindOwnerEstablishedRoute(binding(config,route));await bridge.resumeOwnerEstablishedRoute(route.thread_id);}
    let ownerInstruction;if(instruction)ownerInstruction=await submitOwnerInstruction(config,bridge,instruction);
    if(config.monitor)monitor=new HostMonitor({bridge,repo:config.project.repo,projectId:config.project.id,managerEpoch:config.project.manager_epoch,state:config.state});
    return {status:{...status,bound_contexts:routes.length,monitor_configured:!!monitor,...(ownerInstruction?{owner_instruction:ownerInstruction,model_started:'unknown'}:{})},monitor,closed:bridge.closed,close:()=>{monitor?.stopWorker();bridge.close();}};
  }catch(error){bridge.close();throw error;}
}
