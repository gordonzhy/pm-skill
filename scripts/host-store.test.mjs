import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { connectHostBridge } from './core/host-bridge.mjs';
import { execute, result, errorResult, digest } from './core/engine.mjs';
import { executeFiles, emptyRevision } from './core/file-store.mjs';
import { executeHostFiles, HostStore } from './core/host-store.mjs';
import { hostReadset } from './core/host-domain.mjs';
import { HostMonitor } from './core/host-monitor.mjs';
import { VERSION } from './core/contracts.mjs';
import { rawHash } from './core/file-model.mjs';

// Protocol peer and model turns below are synthetic. FileStore writes and validator
// child processes are real; no assertion in this suite is evidence of a real AI host.
async function fixture(existing=null) {
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
const scope = { goal: 'Synthetic deliverable', allowed_writes: ['out'], exclusions: [], criteria: ['criterion-a'], required_layers: ['synthetic'] };
async function setup(f, hard = false) {
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

test('host profile uses shared real file transactions; weak owner cannot enter it; hard visibility remains unknown', { skip: process.platform !== 'darwin' }, async () => {
  const f = await fixture();
  try {
    const { selection, ran, receipt } = await setup(f, true);
    assert.equal(ran.reported.exit, 0);
    const q = await f.snapshot(), task = q.data.model.tasks[0];
    assert.equal(task.execution.lanes[0].visible.value, 'unknown');
    await assert.rejects(f.call('lane bind', { dispatch: 'dispatch-a', selection, receipt: receipt.id }), { code: 'CAPABILITY_UNAVAILABLE' });
    await assert.rejects(executeFiles({ protocol: 'project-files/1', command: 'audit record', repo: f.repo, project_id: 'ATLAS', actor_proof: 'local-owner', idempotency_key: 'weak-attempt', expected_revision: q.source_revision,
      input: { subject: 'ATLAS-01', type: 'example', evidence: [] } }, { state: f.state }), { code: 'AUTH_REQUIRED' });
    assert.deepEqual((await f.host()).mutations, ['thread/start']);
    await assert.rejects(f.system('effect-runner', 'effect claim', ran.claimRequest.input, { request: ran.claimRequest, invoke: true }), { code: 'FENCE_INVALID' });
    assert.deepEqual((await f.host()).mutations, ['thread/start']);
  } finally { await f.cleanup(); }
});

test('synthetic full state journey keeps start, delivery, review, manager pass and atomic close separate', { skip: process.platform !== 'darwin' }, async () => {
  const f = await fixture();
  try {
    const { selection, receipt } = await setup(f);
    await f.call('lane bind', { dispatch: 'dispatch-a', selection, receipt: receipt.id });
    let q = await f.snapshot(), state = q.data.model.tasks[0].execution;
    await f.call('dispatch start', { dispatch: 'dispatch-a', scope: 1, validation: state.validations.at(-1).id });
    q = await f.snapshot(); state = q.data.model.tasks[0].execution;
    const start = state.effects.find(e => e.kind === 'host.start');
    await f.runEffect(start.id);
    q = await f.snapshot(); state = q.data.model.tasks[0].execution;
    assert.equal(q.data.model.rows[0].phase, 'executing'); assert.equal(state.lanes[0].running.value, true);
    await fs.mkdir(path.join(f.repo, 'out')); const bytes = Buffer.from('Example output\n'); await fs.writeFile(path.join(f.repo, 'out/result.txt'), bytes);
    const manifest = [{ path: 'out/result.txt', digest: rawHash(bytes), size: bytes.length }];
    const candidate = { id: 'candidate-a', work_id: 'ATLAS-01', manifest, digest: digest(manifest), source_revision: q.source_revision, limitations: ['Synthetic peer only'] };
    await f.call('delivery submit', { work: 'ATLAS-01', candidate, limitations: ['Synthetic peer only'] }, state.lanes[0].route.opaque_id);
    q = await f.snapshot(); assert.equal(q.data.model.rows[0].phase, 'reviewing');
    const report = { id: 'report-a', candidate_digest: candidate.digest, scope_revision: 1, reviewer: 'reviewer-a', history_inherited: false,
      access_mode: 'prompt-only', actual_inputs: ['candidate-a'], coverage: [{ criterion: 'criterion-a', layer: 'synthetic', result: 'pass', evidence: ['evidence-a'] }], open_issues: [] };
    await f.call('review submit', { work: 'ATLAS-01', report, limitations: ['Synthetic peer only'] }, 'reviewer-route');
    await fs.writeFile(path.join(f.repo, 'out/result.txt'), 'Changed after review\n');
    await assert.rejects(f.call('acceptance decide', { candidate: 'candidate-a', role: 'local-manager', decision: 'pass', reports: ['report-a'], criteria: ['criterion-a'] }), { code: 'READSET_CHANGED' });
    assert.equal((await f.snapshot()).data.model.rows[0].phase, 'reviewing');
    await fs.writeFile(path.join(f.repo, 'out/result.txt'), bytes);
    await f.call('acceptance decide', { candidate: 'candidate-a', role: 'local-manager', decision: 'pass', reports: ['report-a'], criteria: ['criterion-a'] });
    q = await f.snapshot(); assert.equal(q.data.model.rows[0].phase, 'accepted');
    const decision = q.data.model.rows[0].decision_id;
    await assert.rejects(f.call('work close', { work: 'ATLAS-01', decision_or_reason: decision, impact: [] }), { code: 'INVARIANT_VIOLATION' });
    await f.end(state.lanes[0].route.opaque_id, state.lanes[0].route);
    await f.call('work close', { work: 'ATLAS-01', decision_or_reason: decision, impact: [] });
    q = await f.snapshot(); assert.equal(q.data.model.rows[0].phase, 'closed');
    assert.equal(q.data.model.tasks[0].obligations.find(o => o.template === 'close-or-explain').lifecycle, 'satisfied');
    assert.deepEqual((await f.host()).mutations, ['thread/start', 'turn/start']);
  } finally { await f.cleanup(); }
});

test('protection suppresses an unissued claim and keeps a running stop unknown until its exact receipt', { skip: process.platform !== 'darwin' }, async () => {
  for (const running of [false, true]) {
    const f = await fixture();
    try {
      const { selection, receipt } = await setup(f);
      await f.call('lane bind', { dispatch: 'dispatch-a', selection, receipt: receipt.id });
      let q = await f.snapshot();
      await f.call('dispatch start', { dispatch: 'dispatch-a', scope: 1, validation: q.data.model.tasks[0].execution.validations.at(-1).id });
      q = await f.snapshot(); const start = q.data.model.tasks[0].execution.effects.find(e => e.kind === 'host.start');
      let request;
      if (running) await f.runEffect(start.id);
      else {
        const validation = await f.validation(start.id); q = await f.snapshot();
        request = f.makeRequest('effect claim', { effect: start.id, claim: 'unissued-claim', receipt_or_lookup: validation }, q.source_revision);
        await f.system('effect-runner', 'effect claim', request.input, { request });
      }
      const paused = await f.call('work pause', { work: 'ATLAS-01', resolver: 'manager-a', next: 'Explicit manager disposition', protection_refs: [], proof: 'host-origin' });
      q = await f.snapshot(); assert.equal(q.data.model.rows[0].control, 'paused');
      const task = q.data.model.tasks[0];
      assert(task.obligations.some(o => o.template === 'condition-followup' && o.lifecycle === 'active'));
      if (!running) {
        assert.equal(paused.output.exit, 0);
        assert.equal(task.execution.effects.find(e => e.id === start.id).state, 'suppressed');
        await assert.rejects(f.system('effect-runner', 'effect claim', request.input, { request, invoke: true }), { code: 'FENCE_INVALID' });
        assert.deepEqual((await f.host()).mutations, ['thread/start']);
      } else {
        assert.equal(paused.output.code, 'STOP_UNKNOWN');
        assert.equal(task.execution.lanes[0].running.value, true);
        assert(task.obligations.some(o => o.template === 'stop-proof' && o.lifecycle === 'active'));
        const stop = task.execution.effects.find(e => e.kind === 'host.stop'); assert(stop);
        await f.runEffect(stop.id);
        q = await f.snapshot();
        assert.equal(q.data.model.rows[0].control, 'paused');
        assert.equal(q.data.model.tasks[0].execution.lanes[0].running.value, false);
        assert(q.data.model.tasks[0].obligations.filter(o => o.template === 'stop-proof').every(o => o.lifecycle === 'satisfied'));
        assert.deepEqual((await f.host()).mutations, ['thread/start', 'turn/start', 'turn/interrupt']);
      }
    } finally { await f.cleanup(); }
  }
});

test('clock drift blocks the call before a permit; restoring the tested clock does not create a second claim', { skip: process.platform !== 'darwin' }, async () => {
  const f = await fixture();
  try {
    const { selection, receipt } = await setup(f);
    await f.call('lane bind', { dispatch: 'dispatch-a', selection, receipt: receipt.id });
    let q = await f.snapshot();
    await f.call('dispatch start', { dispatch: 'dispatch-a', scope: 1, validation: q.data.model.tasks[0].execution.validations.at(-1).id });
    q = await f.snapshot(); const effect = q.data.model.tasks[0].execution.effects.find(e => e.kind === 'host.start');
    const validation = await f.validation(effect.id); q = await f.snapshot();
    const request = f.makeRequest('effect claim', { effect: effect.id, claim: 'clock-claim', receipt_or_lookup: validation }, q.source_revision);
    await f.system('effect-runner', 'effect claim', request.input, { request });
    await assert.rejects(f.system('effect-runner', 'effect claim', request.input, { request, invoke: true,
      clock: { wall: () => Date.now() + 60000, uptime: () => Math.floor(os.uptime() * 1000) } }), { code: 'CLOCK_UNCERTAIN' });
    assert.deepEqual((await f.host()).mutations, ['thread/start']);
    const evidence = await f.system('effect-runner', 'effect claim', request.input, { request, invoke: true });
    await f.system('host-bridge', 'effect report', { effect: effect.id }, { adapterEvidence: evidence });
    assert.deepEqual((await f.host()).mutations, ['thread/start', 'turn/start']);
    await assert.rejects(f.system('effect-runner', 'effect claim', request.input, { request, invoke: true }), { code: 'FENCE_INVALID' });
  } finally { await f.cleanup(); }
});

test('synthetic lost callback is rebuilt by a real restarted evaluator; transport, consume, response and root resolution stay separate', { skip: process.platform !== 'darwin' }, async () => {
  const f = await fixture(); let monitor;
  try {
    const { selection, receipt } = await setup(f);
    await f.call('lane bind', { dispatch: 'dispatch-a', selection, receipt: receipt.id });
    let q = await f.snapshot(), state = q.data.model.tasks[0].execution;
    await f.call('dispatch start', { dispatch: 'dispatch-a', scope: 1, validation: state.validations.at(-1).id });
    q = await f.snapshot(); await f.runEffect(q.data.model.tasks[0].execution.effects.find(e => e.kind === 'host.start').id);
    await f.call('policy amend', { changes: [{ key: 'response_window_seconds', value: '0' }], scope: 'ATLAS', proof: 'host-origin' });
    await fs.mkdir(path.join(f.repo, 'out')); const bytes = Buffer.from('Example output\n'); await fs.writeFile(path.join(f.repo, 'out/result.txt'), bytes);
    const manifest = [{ path: 'out/result.txt', digest: rawHash(bytes), size: bytes.length }]; q = await f.snapshot();
    const worker = q.data.model.tasks[0].execution.lanes[0].route.opaque_id;
    const candidate = { id: 'candidate-a', work_id: 'ATLAS-01', manifest, digest: digest(manifest), source_revision: q.source_revision, limitations: ['Synthetic peer only'] };
    await f.call('delivery submit', { work: 'ATLAS-01', candidate, limitations: ['Synthetic peer only'] }, worker);
    // No direct delivery callback is sent to the manager. The source duties must suffice.
    await f.idle('manager-route');
    monitor = new HostMonitor({ bridge: f.bridge, repo: f.repo, projectId: 'ATLAS', managerEpoch: 'epoch-a', state: f.state });
    const first = await monitor.cycle(); assert.equal(first.roots, 2); assert.equal(first.attempted, 2);
    assert.equal(first.health.project, 'needs-response');
    q = await f.snapshot(); const old = q.data.model.tasks[0].execution.attention;
    assert.equal(old.length, 2); assert(old.every(a => a.state === 'sent' && !a.consumed_at));
    assert(q.data.model.tasks[0].obligations.filter(o => o.template.startsWith('review-')).every(o => o.lifecycle === 'active'));
    const mutations = (await f.host()).mutations, roots = old.map(a => a.alert_key), revision = q.source_revision;
    const oldPid = monitor.child.pid; monitor.stopWorker(); const stopped = await monitor.lastStopped;
    assert.equal(stopped.signal, 'SIGKILL'); assert.equal(stopped.pid, oldPid);
    const second = await monitor.cycle(); assert.notEqual(monitor.child.pid, oldPid); assert.notEqual(second.boot, first.boot);
    assert.equal(second.roots, 2); assert.equal(second.attempted, 0);
    assert.deepEqual((await f.host()).mutations, mutations);
    q = await f.snapshot(); assert.equal(q.source_revision, revision); assert.deepEqual(q.data.model.tasks[0].execution.attention.map(a => a.alert_key), roots);
    const attention = q.data.model.tasks[0].execution.attention.find(a => q.data.model.tasks[0].obligations.find(o => o.id === a.obligation_id).template === 'review-decision');
    await f.call('attention consume', { subject: attention.id, payload_digest: attention.payload_digest, turn: 'host-origin', commands: [], evidence: [] });
    q = await f.snapshot(); assert(q.data.model.tasks[0].execution.attention.find(a => a.id === attention.id).consumed_at);
    assert.equal(q.data.model.tasks[0].obligations.find(o => o.template === 'review-decision').lifecycle, 'active');
    await assert.rejects(f.call('attention respond', { subject: attention.id, payload_digest: attention.payload_digest, turn: 'host-origin', commands: [], evidence: [] }), { code: 'INVARIANT_VIOLATION' });
    const oldDue = q.data.model.tasks[0].obligations.find(o => o.template === 'review-decision').due_at;
    await f.call('policy amend', { changes: [{ key: 'response_window_seconds', value: '3600' }], scope: 'ATLAS', proof: 'host-origin' });
    await f.call('attention respond', { subject: attention.id, payload_digest: attention.payload_digest, turn: 'host-origin', commands: [], evidence: [], next_due: new Date(Date.now() + 60000).toISOString() });
    q = await f.snapshot(); const duty = q.data.model.tasks[0].obligations.find(o => o.template === 'review-decision');
    assert.equal(duty.lifecycle, 'active'); assert.equal(duty.due_at, oldDue);
    assert(q.data.model.tasks[0].execution.attention.find(a => a.id === attention.id).responded_at);
    const third = await monitor.cycle(); assert.equal(third.attempted, 0); assert.deepEqual((await f.host()).mutations, mutations);
    const report = { id: 'report-after-alert', candidate_digest: candidate.digest, scope_revision: 1, reviewer: 'reviewer-a', history_inherited: false,
      access_mode: 'prompt-only', actual_inputs: ['candidate-a'], coverage: [{ criterion: 'criterion-a', layer: 'synthetic', result: 'pass', evidence: ['evidence-a'] }], open_issues: [] };
    await f.call('review submit', { work: 'ATLAS-01', report, limitations: ['Synthetic peer only'] }, 'reviewer-route');
    await f.call('acceptance decide', { candidate: 'candidate-a', role: 'local-manager', decision: 'pass', reports: [report.id], criteria: ['criterion-a'] });
    q = await f.snapshot(); const route = q.data.model.tasks[0].execution.lanes[0].route;
    await f.end(worker, route);
    await f.call('work close', { work: 'ATLAS-01', decision_or_reason: q.data.model.rows[0].decision_id, impact: [] });
    const closed = await monitor.cycle(); assert.equal(closed.roots, 0); assert.equal(closed.attempted, 0);
    q = await f.snapshot(); assert.equal(q.data.model.rows[0].phase, 'closed');
    assert(q.data.model.tasks[0].execution.attention.every(a => ['superseded', 'suppressed'].includes(a.state)));
    assert.deepEqual((await f.host()).mutations, mutations);
  } finally { monitor?.stopWorker(); await f.cleanup(); }
});

test('durable call permission without a response becomes unknown and never replays; lost inventory blocks execution', { skip: process.platform !== 'darwin' }, async () => {
  const f = await fixture();
  try {
    const { selection, receipt } = await setup(f);
    await f.call('lane bind', { dispatch: 'dispatch-a', selection, receipt: receipt.id });
    let q = await f.snapshot(); assert.equal(q.data.runtime.execution_activation_required, false);
    await f.call('dispatch start', { dispatch: 'dispatch-a', scope: 1, validation: q.data.model.tasks[0].execution.validations.at(-1).id });
    q = await f.snapshot(); const effect = q.data.model.tasks[0].execution.effects.find(e => e.kind === 'host.start');
    const validation = await f.validation(effect.id); q = await f.snapshot();
    const request = f.makeRequest('effect claim', { effect: effect.id, claim: 'claim-interrupted', receipt_or_lookup: validation }, q.source_revision);
    await f.system('effect-runner', 'effect claim', request.input, { request });
    const before = (await f.host()).mutations;
    await assert.rejects(f.system('effect-runner', 'effect claim', request.input, { request, invoke: true,
      fault: async name => { if (name === 'HOST_CALL_PERMITTED') throw new Error('simulated owner loss'); } }), /simulated owner loss/);
    assert.deepEqual((await f.host()).mutations, before);
    const reconciled = await f.system('host-bridge', 'effect reconcile', { effect: effect.id });
    assert.equal(reconciled.code, 'EFFECT_UNKNOWN');
    q = await f.snapshot(); assert.equal(q.data.model.tasks[0].execution.effects.find(e => e.id === effect.id).state, 'unknown');
    assert.notEqual(q.data.model.tasks[0].execution.lanes[0].running.value, true);
    await assert.rejects(f.system('effect-runner', 'effect claim', request.input, { request, invoke: true }), { code: 'FENCE_INVALID' });
    assert.deepEqual((await f.host()).mutations, before);
    const directory = path.join(f.state, 'execution'), filename = (await fs.readdir(directory))[0];
    await fs.rename(path.join(directory, filename), path.join(f.base, 'saved-inventory.jsonl'));
    q = await f.snapshot(); assert.equal(q.data.runtime.execution_activation_required, true);
    await assert.rejects(f.system('effect-runner', 'effect claim', request.input, { request, invoke: true }), { code: 'FENCE_INVALID' });
    assert.deepEqual((await f.host()).mutations, before);
  } finally { await f.cleanup(); }
});


test('claim fence refresh permits only unchanged business readsets and never a second execution', { skip: process.platform !== 'darwin' }, async () => {
  const f=await fixture();
  try{
    const {selection,receipt}=await setup(f);await f.call('lane bind',{dispatch:'dispatch-a',selection,receipt:receipt.id});
    let q=await f.snapshot();await f.call('dispatch start',{dispatch:'dispatch-a',scope:1,validation:q.data.model.tasks[0].execution.validations.at(-1).id});
    q=await f.snapshot();const effect=q.data.model.tasks[0].execution.effects.find(e=>e.kind==='host.start');
    const validation=await f.validation(effect.id);q=await f.snapshot();
    const request=f.makeRequest('effect claim',{effect:effect.id,claim:'refresh-claim',receipt_or_lookup:validation},q.source_revision);
    await f.system('effect-runner','effect claim',request.input,{request});
    await f.call('audit record',{subject:'ATLAS-01',type:'progress-note',evidence:[]});
    await assert.rejects(f.system('effect-runner','effect claim',request.input,{request,invoke:true}),{code:'READSET_CHANGED'});
    await f.system('effect-runner','effect refresh-fence',request.input);
    const evidence=await f.system('effect-runner','effect claim',request.input,{request,invoke:true});
    await f.system('host-bridge','effect report',{effect:effect.id},{adapterEvidence:evidence});
    await assert.rejects(f.system('effect-runner','effect refresh-fence',request.input),{code:'FENCE_INVALID'});
    assert.deepEqual((await f.host()).mutations,['thread/start','turn/start']);
  }finally{await f.cleanup();}
  const g=await fixture();
  try{
    const {selection,receipt}=await setup(g);await g.call('lane bind',{dispatch:'dispatch-a',selection,receipt:receipt.id});
    let q=await g.snapshot();await g.call('dispatch start',{dispatch:'dispatch-a',scope:1,validation:q.data.model.tasks[0].execution.validations.at(-1).id});
    q=await g.snapshot();const effect=q.data.model.tasks[0].execution.effects.find(e=>e.kind==='host.start'),validation=await g.validation(effect.id);q=await g.snapshot();
    const request=g.makeRequest('effect claim',{effect:effect.id,claim:'relevant-change',receipt_or_lookup:validation},q.source_revision);
    await g.system('effect-runner','effect claim',request.input,{request});
    await g.call('policy amend',{changes:[{key:'response_window_seconds',value:'3600'}],scope:'ATLAS',proof:'host-origin'});
    await assert.rejects(g.system('effect-runner','effect refresh-fence',request.input),{code:'READSET_CHANGED'});
    assert.deepEqual((await g.host()).mutations,['thread/start']);
  }finally{await g.cleanup();}
});


test('deny persisted after permit and before physical mutation prevents the host start', { skip: process.platform !== 'darwin' }, async () => {
  const f=await fixture();let second;
  try{
    const {selection,receipt}=await setup(f);await f.call('lane bind',{dispatch:'dispatch-a',selection,receipt:receipt.id});
    let q=await f.snapshot();await f.call('dispatch start',{dispatch:'dispatch-a',scope:1,validation:q.data.model.tasks[0].execution.validations.at(-1).id});
    q=await f.snapshot();const effect=q.data.model.tasks[0].execution.effects.find(e=>e.kind==='host.start');
    const validation=await f.validation(effect.id);q=await f.snapshot();
    const request=f.makeRequest('effect claim',{effect:effect.id,claim:'denied-at-boundary',receipt_or_lookup:validation},q.source_revision);
    await f.system('effect-runner','effect claim',request.input,{request});
    second=await fixture(f.base);let deny;
    const unknown=await f.system('effect-runner','effect claim',request.input,{request,invoke:true,fault:async name=>{
      if(name==='HOST_BEFORE_MUTATION'){
        deny=second.call('work pause',{work:'ATLAS-01',resolver:'manager-a',next:'Manager disposition',protection_refs:[],proof:'host-origin'},'manager-route',q.source_revision);
        for(let i=0;i<200;i++){if(await fs.readFile(path.join(f.repo,'.pm-local/protection/1.json')).then(()=>true,()=>false))break;await new Promise(r=>setTimeout(r,10));}
      }
    }});
    assert.equal(unknown.state,'unknown');deny=await deny;assert.equal(deny.output.code,'STOP_UNKNOWN');
    assert.deepEqual((await f.host()).mutations,['thread/start']);
    await f.system('host-bridge','effect reconcile',{effect:effect.id});
    q=await f.snapshot();assert.equal(q.data.model.rows[0].control,'paused');
    assert.notEqual(q.data.model.tasks[0].execution.lanes[0].running.value,true);
    await assert.rejects(f.system('effect-runner','effect claim',request.input,{request,invoke:true}),{code:'FENCE_INVALID'});
    assert.deepEqual((await f.host()).mutations,['thread/start']);
  }finally{second?.bridge.close();await f.cleanup();}
});


test('fixed attention windows allow one separate owner escalation and no recursive reminders', { skip: process.platform !== 'darwin' }, async () => {
  const f=await fixture();let monitor;
  try{
    const {selection,receipt}=await setup(f);await f.call('lane bind',{dispatch:'dispatch-a',selection,receipt:receipt.id});
    let q=await f.snapshot();await f.call('dispatch start',{dispatch:'dispatch-a',scope:1,validation:q.data.model.tasks[0].execution.validations.at(-1).id});
    q=await f.snapshot();await f.runEffect(q.data.model.tasks[0].execution.effects.find(e=>e.kind==='host.start').id);
    await f.call('attention channel-bind',{proof:'host-origin'},'owner-route');
    await f.call('policy amend',{changes:[{key:'response_window_seconds',value:'1'}],scope:'ATLAS',proof:'host-origin'});
    await fs.mkdir(path.join(f.repo,'out'));const bytes=Buffer.from('Example output');await fs.writeFile(path.join(f.repo,'out/result.txt'),bytes);
    const manifest=[{path:'out/result.txt',digest:rawHash(bytes),size:bytes.length}];q=await f.snapshot();
    await f.call('delivery submit',{work:'ATLAS-01',candidate:{id:'candidate-a',work_id:'ATLAS-01',manifest,digest:digest(manifest),source_revision:q.source_revision,limitations:['Synthetic peer only']},limitations:['Synthetic peer only']},q.data.model.tasks[0].execution.lanes[0].route.opaque_id);
    await new Promise(r=>setTimeout(r,1100));
    monitor=new HostMonitor({bridge:f.bridge,repo:f.repo,projectId:'ATLAS',managerEpoch:'epoch-a',state:f.state});
    const first=await monitor.cycle();assert.equal(first.attempted,2);q=await f.snapshot();
    const manager=q.data.model.tasks[0].execution.attention.find(a=>a.role==='manager'),consumeDue=manager.consume_due;
    assert(manager.deliver_due&&consumeDue);assert.equal(manager.tier,0);
    await f.call('attention consume',{subject:manager.id,payload_digest:manager.payload_digest,turn:'host-origin',commands:[],evidence:[]});
    q=await f.snapshot();assert.equal(q.data.model.tasks[0].execution.attention.find(a=>a.id===manager.id).consume_due,consumeDue);
    assert(q.data.model.tasks[0].execution.attention.find(a=>a.id===manager.id).response_due);
    await new Promise(r=>setTimeout(r,1100));const second=await monitor.cycle();assert.equal(second.attempted,2);q=await f.snapshot();
    const all=q.data.model.tasks[0].execution.attention;assert.equal(all.length,4);
    const owner=all.find(a=>a.role==='owner');assert.equal(owner.target,'owner-route');
    await f.call('attention consume',{subject:owner.id,payload_digest:owner.payload_digest,turn:'host-origin',commands:[],evidence:[]},'owner-route');
    await assert.rejects(f.call('attention respond',{subject:owner.id,payload_digest:owner.payload_digest,turn:'host-origin',commands:[],evidence:[],next_due:new Date(Date.now()+500).toISOString()},'owner-route'),{code:'AUTH_DENIED'});
    await f.call('attention channel-dispose',{subject:owner.id,reason:'Channel investigated',counterevidence:[]},'owner-route');
    await new Promise(r=>setTimeout(r,1100));const third=await monitor.cycle();assert.equal(third.attempted,0);
    const mutations=(await f.host()).mutations;await monitor.cycle();assert.deepEqual((await f.host()).mutations,mutations);
    q=await f.snapshot();assert.equal(q.data.model.rows[0].phase,'reviewing');
    assert.equal(q.data.model.tasks[0].execution.attention.length,4);
    assert(q.data.model.tasks[0].execution.attention.some(a=>a.role==='owner'&&a.tier===2&&a.escalation_state==='exhausted'));
    assert(q.data.model.tasks[0].obligations.filter(o=>o.template.startsWith('review-')).every(o=>o.lifecycle==='active'));
  }finally{monitor?.stopWorker();await f.cleanup();}
});


test('a notification without occurrence time cannot become a fresh running proof', { skip: process.platform !== 'darwin' }, async () => {
  const f=await fixture();
  try{
    const {selection,receipt}=await setup(f);await f.call('lane bind',{dispatch:'dispatch-a',selection,receipt:receipt.id});
    let q=await f.snapshot();await f.call('dispatch start',{dispatch:'dispatch-a',scope:1,validation:q.data.model.tasks[0].execution.validations.at(-1).id});
    q=await f.snapshot();const effect=q.data.model.tasks[0].execution.effects.find(e=>e.kind==='host.start');
    await f.setControl({omitTimes:true});const ran=await f.runEffect(effect.id);assert.equal(ran.evidence.state,'accepted');
    q=await f.snapshot();const task=q.data.model.tasks[0];assert.equal(task.execution.effects.find(e=>e.id===effect.id).state,'accepted');
    assert.notEqual(task.execution.lanes[0].running.value,true);assert(task.obligations.some(o=>o.template==='start-proof'&&o.lifecycle==='active'));
    const worker=(await f.host()).threads[effect.target];
    assert.throws(()=>f.bridge.takeObservation(effect.target,worker.turns.at(-1).id,'turn/started',task.execution.lanes[0].route),{code:'CAPABILITY_UNAVAILABLE'});
  }finally{await f.cleanup();}
});
