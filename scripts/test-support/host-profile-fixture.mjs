import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { connectHostBridge } from '../core/host-bridge.mjs';
import { execute, result, errorResult, digest } from '../core/engine.mjs';
import { executeFiles, emptyRevision } from '../core/file-store.mjs';
import { executeHostFiles, HostStore } from '../core/host-store.mjs';
import { hostReadset } from '../core/host-domain.mjs';
import { HostMonitor } from '../core/host-monitor.mjs';
import { VERSION } from '../core/contracts.mjs';
import { rawHash } from '../core/file-model.mjs';

// Protocol peer and model turns below are synthetic. FileStore writes and validator
// child processes are real; no assertion in this suite is evidence of a real AI host.
export async function fixture(existing=null) {
  const base = existing??await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'host-profile-test-')));
  await fs.chmod(base, 0o700);
  const repo = path.join(base, 'repo'), state = path.join(base, 'state'), profile = path.join(base, 'profile');
  for (const dir of [repo, state, profile]) await fs.mkdir(dir, { mode: 0o700, recursive:true });
  const peer = path.join(base, 'protocol-peer'), mailbox = path.join(base, `request-${process.hrtime.bigint()}.json`), control = path.join(base, 'control.json');
  const hostState = path.join(base, 'host.json');
  const script = `#!${process.execPath}
const fs=require('node:fs'),mailbox=${JSON.stringify(mailbox)},control=${JSON.stringify(control)},hostState=${JSON.stringify(hostState)};
const state=fs.existsSync(hostState)?JSON.parse(fs.readFileSync(hostState)): {counter:0,call:0,mutations:[],threads:{'manager-route':{id:'manager-route',status:{type:'idle'},turns:[]},'reviewer-route':{id:'reviewer-route',status:{type:'idle'},turns:[]},'owner-route':{id:'owner-route',status:{type:'idle'},turns:[]}}};
const save=()=>fs.writeFileSync(hostState,JSON.stringify(state));const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');let buffer='';
const endThread=id=>{const t=state.threads[id],turn=t?.turns.at(-1);if(turn){turn.status='completed';turn.completedAt=Math.floor(Date.now()/1000);t.status={type:'idle'};send({method:'turn/completed',params:{threadId:id,turn}});}save();};
process.stdin.on('data',chunk=>{buffer+=chunk;for(;;){const n=buffer.indexOf('\\n');if(n<0)break;const q=JSON.parse(buffer.slice(0,n));buffer=buffer.slice(n+1);const p=q.params||{};
if(q.method==='initialize')send({id:q.id,result:{userAgent:'synthetic-protocol-peer'}});
else if(q.method==='account/read')send({id:q.id,result:{account:{type:'synthetic'},requiresOpenaiAuth:true}});
else if(q.method==='thread/start'){const id='worker-'+(++state.counter);state.threads[id]={id,createdAt:Math.floor(Date.now()/1000),status:{type:'idle'},turns:[]};state.mutations.push(q.method);save();send({id:q.id,result:{thread:state.threads[id]}});}
else if(q.method==='thread/read'){
 if(fs.existsSync(control)){const c=JSON.parse(fs.readFileSync(control));if(c.end===p.threadId){fs.unlinkSync(control);endThread(c.end);}}
 const thread=state.threads[p.threadId];send({id:q.id,result:{thread:thread?{...thread,turns:p.includeTurns?thread.turns:[]}:null}});
 if(fs.existsSync(mailbox)){const m=JSON.parse(fs.readFileSync(mailbox));if(m.thread===p.threadId){fs.unlinkSync(mailbox);let turn=thread.turns.at(-1);if(!turn||turn.status!=='inProgress'){turn={id:'controller-'+(++state.counter),status:'inProgress',items:[]};thread.turns.push(turn);thread.status={type:'active'};save();}send({id:10000+(++state.call),method:'item/tool/call',params:{threadId:p.threadId,turnId:turn.id,callId:'call-'+state.call,tool:'pm_command',arguments:m.request}});}}
}
else if(q.method==='turn/start'){const thread=state.threads[p.threadId],turn={id:'turn-'+(++state.counter),startedAt:Math.floor(Date.now()/1000),status:'inProgress',items:[]};if(fs.existsSync(control)){const c=JSON.parse(fs.readFileSync(control));if(c.omitTimes)delete turn.startedAt;}thread.turns.push(turn);thread.status={type:'active'};state.mutations.push(q.method);save();send({id:q.id,result:{turn}});send({method:'turn/started',params:{threadId:p.threadId,turn}});}
else if(q.method==='turn/steer'){state.mutations.push(q.method);save();send({id:q.id,result:{turnId:p.expectedTurnId}});}
else if(q.method==='turn/interrupt'){state.mutations.push(q.method);send({id:q.id,result:{}});endThread(p.threadId);}
}});
`;
  await fs.writeFile(peer, script, { mode: 0o700 });
  let bridge, waiter, counter = existing?1000:0;
  const binding = (thread_id, actor, role) => ({ thread_id, actor, role, manager_epoch: 'epoch-a', project_id: 'ATLAS', repo });
  async function connect() {
    bridge = await connectHostBridge({ executable: peer, home: base, codexHome: profile, timeoutMs: 10000,
      onCommand: async (request, token) => {
        const receiver = waiter; waiter = null;
        await fs.appendFile(path.join(base,'trace.txt'),`received ${request.command??request.query}\n`);
        try { const output = await execute(request, { hostIdentityToken: token, state }); receiver?.resolve({ output, request }); return output; }
        catch (error) { receiver?.reject(error); return errorResult(error); }
      } });
    await bridge.bindOwnerEstablishedRoute(binding('manager-route', 'manager-a', 'manager'));
    await bridge.bindOwnerEstablishedRoute(binding('reviewer-route', 'reviewer-a', 'reviewer'));
    await bridge.bindOwnerEstablishedRoute(binding('owner-route', 'owner-a', 'owner'));
    return bridge;
  }
  await connect();
  const request = (command, input, revision) => ({ protocol: 'project-files/1', command, repo, project_id: 'ATLAS',
    idempotency_key: `request-${++counter}`, expected_revision: revision, input });
  const snapshot = () => executeFiles({ protocol: 'project-files/1', query: 'snapshot', repo, projection: 'private-local', snapshot_token: null, input: {} }, { state });
  async function call(command, input, thread = 'manager-route', revision = null) {
    revision ??= command === 'project init' ? emptyRevision() : (await snapshot()).source_revision;
    if(command.startsWith('worker ')&&command!=='worker dispatch register')input={...input,control_epoch:input.control_epoch??'epoch-a'};
    const next = request(command, input, revision);
    await fs.appendFile(path.join(base,'trace.txt'),`issued ${command}\n`);
    const promise = new Promise((resolve, reject) => { waiter = { resolve, reject }; });
    await fs.writeFile(mailbox, JSON.stringify({ thread, request: next }));
    await bridge.inspect('thread/read', { threadId: thread, includeTurns: false });
    return Promise.race([promise, new Promise((_, reject) => { const t = setTimeout(() => reject(new Error(`synthetic callback timeout: ${command}`)), 15000); t.unref(); })]);
  }
  const programs = {};
  async function system(role, command, input, options = {}) {
    programs[role] ??= await bridge.bindOwnerEstablishedProgram({ actor: `program-${role}`, role, manager_epoch: 'epoch-a', project_id: 'ATLAS', repo });
    const q = await snapshot(), next = options.request ?? request(command, input, q.source_revision);
    return bridge.runSystem(programs[role], next, async (authorized, identity) => {
      if (options.invoke) return new HostStore(repo, { ...options, state, hostIdentity: identity }).invokeClaim(authorized, bridge);
      return executeHostFiles(authorized, { state, hostIdentity: identity, ...options });
    });
  }
  async function validation(effectId) {
    const q = await snapshot(), model = q.data.model, task = model.tasks.find(t => t.execution.effects.some(e => e.id === effectId)), effect = task.execution.effects.find(e => e.id === effectId);
    const receipt = { id: `validation-${++counter}`, validator_version: `domain-${VERSION.engine}`, schema_version: VERSION.schema,
      scope_revision: model.rows.find(r => r.id === task.work_id).scope_revision, candidate_digest: effect.payload_digest,
      terminated: true, exit: 0, result: 'pass', durable: true, source_revision: q.source_revision, readset: hostReadset(model, effect.id) };
    await system('effect-runner', 'validation receipt', { work: task.work_id, receipt }); return receipt.id;
  }
  async function runEffect(effectId) {
    const receipt = await validation(effectId), q = await snapshot(), claimRequest = request('effect claim', { effect: effectId, claim: `claim-${++counter}`, receipt_or_lookup: receipt }, q.source_revision);
    const claimed = await system('effect-runner', 'effect claim', claimRequest.input, { request: claimRequest });
    assert.equal(claimed.exit, 0);
    const evidence = await system('effect-runner', 'effect claim', claimRequest.input, { request: claimRequest, invoke: true });
    const reported = await system('host-bridge', 'effect report', { effect: effectId }, { adapterEvidence: evidence });
    if(evidence.state==='confirmed'){
      const model=(await snapshot()).data.model,task=model.tasks.find(t=>t.execution.effects.some(e=>e.id===effectId)),effect=task.execution.effects.find(e=>e.id===effectId),receipt=task.execution.receipts.find(r=>r.effect_id===effectId);
      const peerState=JSON.parse(await fs.readFile(hostState,'utf8'));
      if(effect.kind==='host.prepare')assert.equal(receipt.occurred_at,new Date(peerState.threads[receipt.result_route.opaque_id].createdAt*1000).toISOString());
      if(effect.kind==='host.start')assert.equal(receipt.occurred_at,new Date(peerState.threads[effect.target].turns.find(t=>t.id===receipt.turn).startedAt*1000).toISOString());
      if(effect.kind==='host.stop')assert.equal(receipt.occurred_at,new Date(peerState.threads[effect.target].turns.find(t=>t.id===receipt.turn).completedAt*1000).toISOString());
    }
    return { evidence, reported, claimRequest };
  }
  async function end(thread, route) {
    await fs.writeFile(control, JSON.stringify({ end: thread }));
    await bridge.inspect('thread/read', { threadId: thread, includeTurns: false });
    await new Promise(r => setTimeout(r, 10));
    const observed = bridge.takeObservation(thread, (await fs.readFile(hostState, 'utf8').then(JSON.parse)).threads[thread].turns.at(-1).id, 'turn/completed', route);
    await system('host-bridge', 'observation accept', observed.observation, { observationEvidence: observed.token });
  }
  return { base, repo, state, profile, call, snapshot, system, validation, runEffect, end,
    async idle(thread){await fs.writeFile(control,JSON.stringify({end:thread}));await bridge.inspect('thread/read',{threadId:thread,includeTurns:false});await new Promise(r=>setTimeout(r,10));},
    makeRequest:request,setControl:value=>fs.writeFile(control,JSON.stringify(value)),
    get bridge() { return bridge; }, host: async () => JSON.parse(await fs.readFile(hostState, 'utf8')),
    async cleanup() { bridge.close(); if(process.env.PM_HOST_TEST_EVIDENCE_ROOT){const target=path.resolve(process.env.PM_HOST_TEST_EVIDENCE_ROOT,path.basename(base));await fs.mkdir(path.dirname(target),{recursive:true});await fs.cp(base,target,{recursive:true});}await fs.rm(base, { recursive: true, force: true }); } };
}
export const scope = { goal: 'Synthetic deliverable', allowed_writes: ['out'], exclusions: [], criteria: ['criterion-a'], required_layers: ['synthetic'] };
export async function setup(f, hard = false) {
  await f.call('project init', { root: f.repo, identity: 'manager-a', policy: 'policy-a' });
  await f.call('work create', { work: 'ATLAS-01', scope, label: 'Example', deps: [], impact: [] });
  const grant = { id: 'grant-a', project_id: 'ATLAS', work_ids: ['ATLAS-01'], scope_revision: 1, issuer: 'manager-a',
    actions: ['commit-start', 'host.prepare', 'host.start', 'host.stop', 'channel.send'], write_roots: ['out'], protected_actions: [], evidence_ref: 'authorization-a', issued_at: new Date().toISOString() };
  await f.call('grant record', { grant, evidence: ['authorization-a'] });
  await f.call('work commit-start', { work: 'ATLAS-01', responsible: 'manager-a', policy: 'policy-a', reason: 'Synthetic authorization' });
  const selection = { requested_form: 'independent-task-thread', selected_form: 'independent-task-thread', capabilities_ref: 'synthetic-capability',
    authorization: 'grant-a', require_visible: hard, require_recoverable: hard, reason: 'Synthetic state test; no real-host assurance' };
  await f.call('lane select', { work: 'ATLAS-01', dispatch: 'dispatch-a', selection });
  await f.call('lane prepare', { dispatch: 'dispatch-a', selection });
  const q = await f.snapshot(), effect = q.data.model.tasks[0].execution.effects[0];
  const ran = await f.runEffect(effect.id);
  const prepared = await f.snapshot(), receipt = prepared.data.model.tasks[0].execution.receipts.at(-1);
  return { selection, receipt, ran };
}

