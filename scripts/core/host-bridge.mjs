// A transport boundary, not an authorization grant or an execution runner.
// Only host-origin dynamic-tool envelopes can mint these one-use identities.
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import { recordHostObservation } from './host-observation.mjs';
import { performCodexEffect, lookupCodexEffect, dynamicTool } from './codex-effects.mjs';
import { randomUUID } from 'node:crypto';
import { fail, validate, id, ROLE, DEFINITIONS } from './contracts.mjs';
import { digest, parseJSON, validateRequest, validateResult, errorResult, result } from './engine.mjs';

const identities = new WeakMap();
const verified = new WeakMap();
const consumed = new WeakSet();
const toolName = 'pm_command';
const readMethods = new Set(['account/read', 'thread/read', 'thread/list']);

export function consumeHostIdentity(token, request, expected = null) {
  const proof = identities.get(token);
  if (!proof) fail('AUTH_REQUIRED');
  // Consume even a failed attempt; a proof is never a reusable bearer credential.
  identities.delete(token);
  if (proof.deadline < performance.now() || !proof.live()) fail('AUTH_REQUIRED');
  if (proof.command_digest !== digest(request) || (request.command && request.project_id !== proof.project_id) ||
      request.repo !== proof.repo || (request.command && request.actor_proof !== proof.reference)) fail('AUTH_DENIED');
  if (expected && (expected.project_id !== proof.project_id || expected.repo !== proof.repo ||
      expected.actor !== proof.actor || expected.role !== proof.role)) fail('AUTH_DENIED');
  if (expected && expected.manager_epoch !== proof.manager_epoch) fail('ROLE_STALE');
  consumed.add(token);
  const identity = Object.freeze({ actor: proof.actor, role: proof.role, manager_epoch: proof.manager_epoch,
    project_id: proof.project_id, thread_id: proof.thread_id, turn_id: proof.turn_id,
    call_id: proof.call_id, nonce: proof.nonce, command_digest: proof.command_digest,
    reference: proof.reference, connection: proof.connection, host_instance: proof.host_instance, assurance: 'host-transport' });
  verified.set(identity, proof);
  return identity;
}

export function verifyHostIdentity(identity, request) {
  const proof = verified.get(identity);
  if (!proof || !proof.live() || performance.now() > proof.deadline || proof.command_digest !== digest(request)) fail('AUTH_REQUIRED');
  return identity;
}

// The owner selects the installed executable and an isolated private profile.
// Replacing that executable or this process as the same OS owner is outside this boundary.
export async function connectHostBridge({ executable, home, codexHome, onCommand, timeoutMs = 5000, socketPath = null, fileCredentials = false }) {
  if (typeof onCommand !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 30000) fail('INVALID_INPUT');
  for (const name of [home, codexHome]) {
    if (!path.isAbsolute(name)) fail('PATH_UNSAFE');
    const st = await fs.lstat(name);
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o077)) fail('AUTH_DENIED');
  }
  let binary=null;
  if(socketPath!==null){
    if(typeof socketPath!=='string'||!path.isAbsolute(socketPath))fail('PATH_UNSAFE');
    if(await fs.realpath(path.dirname(socketPath))!==path.dirname(socketPath))fail('PATH_UNSAFE');
    const parent=await fs.lstat(path.dirname(socketPath)),socket=await fs.lstat(socketPath);
    if(!parent.isDirectory()||parent.isSymbolicLink()||parent.uid!==process.getuid()||(parent.mode&0o077)||!socket.isSocket()||socket.uid!==process.getuid())fail('AUTH_DENIED');
  }else{
    if (!path.isAbsolute(executable)) fail('PATH_UNSAFE');
    binary = await fs.realpath(executable);const st = await fs.stat(binary);
    if (!st.isFile() || !(st.mode & 0o111) || (st.mode & 0o022)) fail('AUTH_DENIED');
  }
  if(typeof fileCredentials!=='boolean')fail('INVALID_INPUT');
  const profile=await fs.stat(codexHome);
  const socketIdentity=socketPath?await fs.lstat(socketPath):null;
  const instance=`profile:${digest({dev:profile.dev,ino:profile.ino,...(socketIdentity?{socket:{dev:socketIdentity.dev,ino:socketIdentity.ino}}:{})}).slice(7)}`;
  return openTransport({ binary, home, codexHome, instance, onCommand, timeoutMs, socketPath, fileCredentials });
}

function openTransport({ binary, home, codexHome, instance, onCommand, timeoutMs, socketPath, fileCredentials }) {
  return new Promise((resolve, reject) => {
    // No inherited credentials, proxy settings, session IDs, or model overrides.
    const socket=socketPath?createConnection({path:socketPath}):null;
    const child=socket?null:spawn(binary, ['app-server', '--stdio',...(fileCredentials?['-c','cli_auth_credentials_store="file"']:[])], {
      cwd: home, env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: codexHome,
        LANG: 'en_US.UTF-8' }, stdio: ['pipe', 'pipe', 'ignore'],
    });
    const input=socket??child.stdin,output=socket??child.stdout,lifecycle=socket??child;
    const connection = randomUUID(), pending = new Map(), bindings = new Map(), programs = new Map(), events = new Map(), seen = new Set();
    let resolveClosed;const closed=new Promise(resolve=>{resolveClosed=resolve;});
    let live = true, ready = false, sequence = 0, buffered = Buffer.alloc(0), authenticated = false;
    let handling = false;
    const stop = () => {
      if (!live) return;
      live = false;resolveClosed();
      bindings.clear(); programs.clear(); events.clear();
      for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('CAPABILITY_UNAVAILABLE')); }
      pending.clear();
      if(socket)socket.destroy();else{child.stdin.end();child.kill('SIGTERM');}
    };
    const send = value => { if (!live) fail('CAPABILITY_UNAVAILABLE'); input.write(`${JSON.stringify(value)}\n`); };
    const rpc = (method, params) => new Promise((res, rej) => {
      const requestId = ++sequence;
      const timer = setTimeout(() => { pending.delete(requestId); rej(new Error('CAPABILITY_UNAVAILABLE')); }, timeoutMs);
      pending.set(requestId, { resolve: res, reject: rej, timer });
      try { send({ id: requestId, method, params }); } catch (error) { clearTimeout(timer); pending.delete(requestId); rej(error); }
    });
    async function dynamic(frame) {
      // These fields come from the app-server stream, never from arguments.
      const p = frame.params;
      let verifiedCall = false;
      const respond = output => {
        if (!verifiedCall && (output.exit === 0 || output.exit === undefined)) output = result('AUTH_REQUIRED');
        send({ id: frame.id, result: { success: output.exit === undefined || output.exit === 0,
          contentItems: [{ type: 'inputText', text: JSON.stringify(output) }] } });
      };
      const deny = () => respond(result('AUTH_DENIED'));
      try {
        if (!authenticated || !p || p.tool !== toolName || (p.namespace !== undefined && p.namespace !== null) ||
            !['threadId', 'turnId', 'callId'].every(k => typeof p[k] === 'string')) return deny();
        const binding = bindings.get(p.threadId);
        if (!binding || seen.has(p.callId) || handling) return deny();
        seen.add(p.callId);
        if (seen.size > 4096) { deny(); stop(); return; }
        const request = structuredClone(p.arguments);
        // A stable reference is safe because it is never accepted without the live token.
        // It also preserves input digests across retries of the same business intention.
        const reference = `host:${digest(binding).slice(7)}`;
        if (!request || typeof request !== 'object' || Array.isArray(request)) return deny();
        // Models do not choose their actor proof or use a query to gain a write identity.
        if (Object.hasOwn(request, 'actor_proof')) return deny();
        if(request.command)request.actor_proof = reference;
        if(['attention consume','attention respond'].includes(request.command)&&request.input?.turn==='host-origin')request.input.turn=p.turnId;
        validateRequest(request);
        if (request.repo !== binding.repo || (request.command && request.project_id !== binding.project_id)) return deny();
        const token = Object.freeze({});
        identities.set(token, { ...binding, connection, host_instance:instance, reference, thread_id: p.threadId, turn_id: p.turnId,
          call_id: p.callId, nonce: randomUUID(), command_digest: digest(request),
          deadline: performance.now() + timeoutMs, live: () => live && bindings.get(p.threadId) === binding });
        handling = true;
        try {
          const output = await onCommand(Object.freeze(request), token);
          if (!consumed.has(token)) fail('AUTH_REQUIRED');
          verifiedCall = true;
          if(output.exit===undefined)validate(output,DEFINITIONS.QueryResult);else validateResult(output);
          if (live) respond(output);
        } finally { verifiedCall = consumed.has(token); handling = false; identities.delete(token); consumed.delete(token); }
      } catch (error) {
        if (!live) return;
        // A trusted handler may attach its durable Result. Never turn an uncertain
        // operation into an assertion that authentication failed or nothing committed.
        let output;
        try { validateResult(error?.result); output = verifiedCall ? error.result : result('AUTH_REQUIRED'); }
        catch { try { output = errorResult(error); } catch { output = result('INTERNAL_ERROR'); } }
        respond(output);
      }
    }
    input.on('error',stop);
    lifecycle.on('error', error => { stop(); if (!ready) reject(new Error('CAPABILITY_UNAVAILABLE')); });
    lifecycle.on(socket?'close':'exit', () => { stop(); if (!ready) reject(new Error('CAPABILITY_UNAVAILABLE')); });
    output.on('data', chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > 1048576) { stop(); return; }
      for (;;) {
        const end = buffered.indexOf('\n'); if (end < 0) break;
        const line = buffered.subarray(0, end); buffered = buffered.subarray(end + 1);
        let frame; try { frame = parseJSON(new TextDecoder('utf-8', { fatal: true }).decode(line)); } catch { stop(); return; }
        if (!frame || typeof frame !== 'object' || Array.isArray(frame)) { stop(); return; }
        if (frame.method === 'item/tool/call' && Object.hasOwn(frame, 'id')) { void dynamic(frame); continue; }
        if(['turn/started','turn/completed'].includes(frame.method)){
          const p=frame.params,thread=p?.threadId,turn=p?.turn?.id;
          if(bindings.has(thread)&&typeof turn==='string'){
            const seconds=frame.method==='turn/started'?p.turn.startedAt:p.turn.completedAt;
            const occurred=Number.isSafeInteger(seconds)&&seconds>=0&&seconds*1000<=Date.now()?new Date(seconds*1000).toISOString():null;
            events.set(`${thread}:${turn}:${frame.method}`,{at:occurred,received_at:new Date().toISOString(),status:p.turn.status});
            if(events.size>2048){stop();return;}
          }
          continue;
        }
        // Unsupported server requests never receive a permissive response.
        if (frame.method && Object.hasOwn(frame, 'id')) {
          send({ id: frame.id, error: { code: -32601, message: 'Unsupported request' } }); continue;
        }
        const item = pending.get(frame.id);
        if (!item) continue;
        pending.delete(frame.id); clearTimeout(item.timer);
        if (frame.error || !Object.hasOwn(frame, 'result')) item.reject(new Error('CAPABILITY_UNAVAILABLE'));
        else item.resolve(frame.result);
      }
    });
    (async () => {
      try {
        await rpc('initialize', { clientInfo: { name: 'project-files-bridge', version: '0.1.0' }, capabilities: { experimentalApi: true } });
        send({ method: 'initialized' });
        const account = await rpc('account/read', { refreshToken: false });
        authenticated = !!account.account;
        ready = true;
        resolve(Object.freeze({
          closed,
          capability: Object.freeze({ connected: true, authenticated, dynamic_identity: 'not-verified',
            host_effects: false, connection, instance, assurance: 'transport-only' }),
          // Read access is restricted to bound routes. No general RPC or effect API is exposed.
          async inspect(method, params) {
            if (!live) fail('CAPABILITY_UNAVAILABLE');
            if (!readMethods.has(method)) fail('CAPABILITY_UNAVAILABLE');
            if (method === 'account/read') return { authenticated };
            if (method === 'thread/read' && !bindings.has(params?.threadId)) fail('AUTH_DENIED');
            if (method === 'thread/list') fail('CAPABILITY_UNAVAILABLE');
            return rpc(method, params);
          },
          async bindOwnerEstablishedRoute(binding) {
            // This owner bootstrap interface is not a model-callable command or identity proof.
            if (!authenticated) fail('AUTH_REQUIRED');
            for (const key of ['thread_id', 'actor', 'manager_epoch', 'project_id']) validate(binding[key], id);
            validate(binding.role, ROLE);
            if (!path.isAbsolute(binding.repo) || await fs.realpath(binding.repo) !== binding.repo) fail('PATH_UNSAFE');
            if (Object.keys(binding).sort().join(',') !== 'actor,manager_epoch,project_id,repo,role,thread_id') fail('INVALID_INPUT');
            if (bindings.has(binding.thread_id)) fail('AUTH_DENIED');
            const result = await rpc('thread/read', { threadId: binding.thread_id, includeTurns: false });
            if (result.thread?.id !== binding.thread_id || result.thread?.archived === true) fail('AUTH_DENIED');
            bindings.set(binding.thread_id, Object.freeze({ ...binding }));
            return { bound: true, identity_assurance: 'pending-host-call', connection };
          },
          async createOwnerContext(binding){
            if(!live||!authenticated)fail('AUTH_REQUIRED');
            if(Object.keys(binding).sort().join(',')!=='actor,manager_epoch,project_id,repo,role'||!['manager','owner','reviewer'].includes(binding.role))fail('AUTH_DENIED');
            for(const key of ['actor','manager_epoch','project_id'])validate(binding[key],id);
            if(!path.isAbsolute(binding.repo)||await fs.realpath(binding.repo)!==binding.repo)fail('PATH_UNSAFE');
            const response=await rpc('thread/start',{cwd:binding.repo,ephemeral:false,dynamicTools:[dynamicTool()],sandbox:'read-only',approvalPolicy:'untrusted',
              developerInstructions:'Use the connected pm_command tool for structured project intentions. Wait for explicit owner instructions. Do not discover projects or modify files through other tools.'});
            const thread=response.thread;
            if(typeof thread?.id!=='string'||!Number.isSafeInteger(thread.createdAt)||thread.createdAt<0||thread.createdAt*1000>Date.now())fail('CAPABILITY_UNAVAILABLE');
            bindings.set(thread.id,Object.freeze({...binding,thread_id:thread.id}));
            return {thread_id:thread.id,created_at:new Date(thread.createdAt*1000).toISOString(),model_started:false};
          },
          async sendOwnerInstruction(threadId,text){
            const bound=bindings.get(threadId);
            if(!live||!authenticated||!bound||!['manager','owner','reviewer'].includes(bound.role)||typeof text!=='string'||!text.trim()||Buffer.byteLength(text)>65536)fail('AUTH_DENIED');
            const response=await rpc('turn/start',{threadId,input:[{type:'text',text,text_elements:[]}],cwd:bound.repo});
            if(typeof response.turn?.id!=='string')fail('CAPABILITY_UNAVAILABLE');
            return {accepted:true,turn:response.turn.id,running:'unknown'};
          },
          async resumeOwnerEstablishedRoute(threadId){
            const binding=bindings.get(threadId);if(!live||!authenticated||!binding)fail('AUTH_DENIED');
            const response=await rpc('thread/resume',{threadId,excludeTurns:true});
            if(response.thread?.id!==threadId)fail('FENCE_INVALID');
            return {resumed:true,dynamic_call_assurance:'pending-host-call'};
          },
          async bindOwnerEstablishedProgram(binding){
            if(!live||!authenticated)fail('AUTH_REQUIRED');
            if(Object.keys(binding).sort().join(',')!=='actor,manager_epoch,project_id,repo,role')fail('INVALID_INPUT');
            for(const key of ['actor','manager_epoch','project_id'])validate(binding[key],id);
            if(!['monitor','effect-runner','host-bridge'].includes(binding.role))fail('AUTH_DENIED');
            if(!path.isAbsolute(binding.repo)||await fs.realpath(binding.repo)!==binding.repo)fail('PATH_UNSAFE');
            const reference=`program:${digest(binding).slice(7)}`;
            if(programs.has(reference))return reference;
            programs.set(reference,Object.freeze({...binding}));return reference;
          },
          async runSystem(reference,input,handler){
            const binding=programs.get(reference);
            if(!live||!authenticated||!binding||typeof handler!=='function')fail('AUTH_REQUIRED');
            const request=structuredClone(input);if(request.command)request.actor_proof=reference;validateRequest(request);
            if((request.command&&request.project_id!==binding.project_id)||request.repo!==binding.repo)fail('AUTH_DENIED');
            const proof={...binding,reference,connection,host_instance:instance,thread_id:`program:${connection}`,turn_id:randomUUID(),call_id:randomUUID(),nonce:randomUUID(),
              command_digest:digest(request),deadline:performance.now()+timeoutMs,live:()=>live&&programs.get(reference)===binding};
            const identity=Object.freeze({actor:binding.actor,role:binding.role,manager_epoch:binding.manager_epoch,project_id:binding.project_id,
              thread_id:proof.thread_id,turn_id:proof.turn_id,call_id:proof.call_id,nonce:proof.nonce,command_digest:proof.command_digest,
              reference,connection,host_instance:instance,assurance:'owner-established-program'});
            verified.set(identity,proof);
            try{return await handler(Object.freeze(request),identity);}finally{verified.delete(identity);}
          },
          takeObservation(thread,turn,method,route){
            const binding=bindings.get(thread),key=`${thread}:${turn}:${method}`,entry=events.get(key);
            if(!live||!binding||!entry||route.opaque_id!==thread||route.instance!==instance)fail('AUTH_DENIED');
            if(!entry.at)fail('CAPABILITY_UNAVAILABLE');
            events.delete(key);
            const observation={route,turn,event:method==='turn/started'?'running':entry.status==='interrupted'?'interrupted':'ended',
              source:'live-host-notification',occurred_at:entry.at};
            return {observation,token:recordHostObservation(observation,{project_id:binding.project_id,manager_epoch:binding.manager_epoch,
              repo:binding.repo,host_instance:instance})};
          },
          async lookup(effect,payload,token,facts){
            if(!live||!authenticated||facts.connection!==connection||facts.host_instance!==instance)fail('AUTH_REQUIRED');
            return lookupCodexEffect({rpc},effect,payload,token,facts);
          },
          async perform(effect,payload,token,facts,mutationGate){
            if(!live||!authenticated||facts.connection!==connection||facts.host_instance!==instance)fail('AUTH_REQUIRED');
            if(typeof mutationGate!=='function')fail('FENCE_INVALID');
            return performCodexEffect({rpc,mutate:(method,params)=>mutationGate(()=>rpc(method,params)),bindCreated:(thread,binding)=>{
              if(bindings.has(thread))fail('AUTH_DENIED');bindings.set(thread,Object.freeze({...binding,thread_id:thread}));
            },waitEvent:async(thread,turn,method)=>{
              const until=performance.now()+timeoutMs;
              while(live&&performance.now()<until){const e=events.get(`${thread}:${turn}:${method}`);if(e)return e;await new Promise(r=>setTimeout(r,10));}
              return null;
            }},effect,payload,token,facts);
          },
          close: stop,
        }));
      } catch { stop(); reject(new Error('CAPABILITY_UNAVAILABLE')); }
    })();
  });
}
