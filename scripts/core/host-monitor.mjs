import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { newId } from './file-model.mjs';
import { VERSION, fail } from './contracts.mjs';
import { digest, parseJSON } from './engine.mjs';
import { hostReadset } from './host-domain.mjs';
import { HostStore, executeHostFiles } from './host-store.mjs';

export class HostMonitor {
  constructor({ bridge, repo, projectId, managerEpoch, state, maxEffectsPerCycle = 4 }) {
    if (!Number.isInteger(maxEffectsPerCycle) || maxEffectsPerCycle < 0 || maxEffectsPerCycle > 16) fail('INVALID_INPUT');
    Object.assign(this, { bridge, repo, projectId, managerEpoch, state, maxEffectsPerCycle });
    this.programs = {}; this.sequence = 0; this.running = false; this.pending = null;
    this.health = { supervisor: 'idle', worker: 'absent', ready: false, last_progress_at: null, project: 'unknown' };
  }
  async program(role, request, options = {}) {
    this.programs[role] ??= await this.bridge.bindOwnerEstablishedProgram({ actor: `program-${role}`, role,
      manager_epoch: this.managerEpoch, project_id: this.projectId, repo: this.repo });
    return this.bridge.runSystem(this.programs[role], request, (authorized, identity) => {
      const store = new HostStore(this.repo, { state: this.state, hostIdentity: identity, runnerCurrent: options.runnerCurrent });
      if (options.invoke) return store.invokeClaim(authorized, this.bridge);
      if (options.lookup) return store.lookupClaim(authorized, this.bridge);
      return executeHostFiles(authorized, { state: this.state, hostIdentity: identity, ...options });
    });
  }
  query() { return this.program('monitor', { protocol: VERSION.protocol, query: 'snapshot', repo: this.repo,
    projection: 'private-local', snapshot_token: null, input: {} }); }
  command(command, input, source_revision, key = newId()) {
    return { protocol: VERSION.protocol, command, repo: this.repo, project_id: this.projectId,
      idempotency_key: key, expected_revision: source_revision, input };
  }
  startWorker() {
    if (this.child) return;
    this.boot = newId(); const boot = this.boot;
    const child = spawn(process.execPath, [fileURLToPath(new URL('./monitor-evaluator.mjs', import.meta.url))], {
      cwd: this.repo, env: { PATH: process.env.PATH, HOME: this.repo }, stdio: ['pipe', 'pipe', 'ignore'] });
    this.child = child; this.health.worker = 'starting';
    let buffered = Buffer.alloc(0);
    const ended = () => {
      if (this.child !== child) return;
      this.child = null; this.health.worker = 'exited'; this.health.ready = false;
      if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(new Error('CAPABILITY_UNAVAILABLE')); this.pending = null; }
    };
    child.on('error', ended); child.on('exit', ended); child.stdin.on('error', ended);
    child.stdout.on('data', chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > 1048576) { child.kill('SIGKILL'); return; }
      for (;;) {
        const end = buffered.indexOf(10); if (end < 0) break;
        const line = buffered.subarray(0, end); buffered = buffered.subarray(end + 1);
        let value; try { value = parseJSON(new TextDecoder('utf8', { fatal: true }).decode(line)); } catch { child.kill('SIGKILL'); return; }
        const pending = this.pending;
        if(!value||typeof value!=='object'||Array.isArray(value)){child.kill('SIGKILL');return;}
        if (!pending || value.boot !== boot || boot !== this.boot || value.sequence !== pending.sequence) continue;
        this.pending = null; clearTimeout(pending.timer);
        if (value.error) pending.reject(new Error('CAPABILITY_UNAVAILABLE')); else pending.resolve(value);
      }
    });
  }
  evaluate(snapshot) {
    this.startWorker();
    return new Promise((resolve, reject) => {
      const sequence = ++this.sequence, timer = setTimeout(() => {
        if (this.pending?.sequence === sequence) { this.pending = null; reject(new Error('CAPABILITY_UNAVAILABLE')); this.stopWorker(); }
      }, 5000);
      this.pending = { sequence, resolve, reject, timer };
      this.child.stdin.write(`${JSON.stringify({ boot: this.boot, sequence, model: snapshot.data.model,
        snapshot: snapshot.snapshot, generation: snapshot.generation })}\n`);
    });
  }
  async cycle() {
    if (this.running) fail('LOCK_UNAVAILABLE'); this.running = true;
    this.health.supervisor = 'running'; this.health.ready = false;
    try {
      let snapshot = await this.query();
      if (snapshot.stale) {
        await this.program('monitor', this.command('monitor refresh', { snapshot: snapshot.snapshot, policy: snapshot.data.model.project.policy.id }, snapshot.source_revision));
        snapshot = await this.query(); if (snapshot.stale) fail('RECOVERY_REQUIRED');
      }
      const plan = await this.evaluate(snapshot), boot = this.boot;
      if (!this.child || plan.boot !== boot) fail('FENCE_INVALID');
      for (const effect of plan.unsettled) {
        if (!this.child || this.boot !== boot) fail('FENCE_INVALID');
        const current = await this.query(), request = this.command('effect reconcile', { effect }, current.source_revision);
        let evidence;
        try { evidence = await this.program('host-bridge', request, { lookup: true }); }
        catch (error) { if (['CAPABILITY_UNAVAILABLE', 'FENCE_INVALID'].includes(error.code)) continue; throw error; }
        await this.program('host-bridge', this.command('effect reconcile', { effect }, (await this.query()).source_revision), { adapterEvidence: evidence });
      }
      if (plan.refresh) {
        const current = await this.query();
        await this.program('monitor', this.command('monitor refresh', { snapshot: current.snapshot, policy: current.data.model.project.policy.id }, current.source_revision));
      }
      snapshot = await this.query();
      const ready = snapshot.data.model.tasks.flatMap(t => t.execution.effects).filter(e => e.state === 'ready').slice(0, this.maxEffectsPerCycle);
      let attempted = 0;
      for (const effect of ready) {
        if (!this.child || this.boot !== boot) fail('FENCE_INVALID');
        await this.runEffect(effect.id,boot); attempted++;
      }
      if(!this.child||this.boot!==boot)fail('FENCE_INVALID');
      this.health = { supervisor: 'running', worker: 'ready', ready: true, last_progress_at: new Date().toISOString(),
        channel:snapshot.data.model.tasks.some(t=>t.execution.attention.some(a=>a.escalation_state==='unavailable'&&!['suppressed','superseded'].includes(a.state)))?'owner-channel-unavailable':'checked',
        project: plan.unsettled.length ? 'needs-reconciliation' : plan.roots.length ? 'needs-response' : 'checked', boot: this.boot };
      return { roots: plan.roots.length, attempted, boot: this.boot, health: { ...this.health } };
    } finally { this.running = false; }
  }
  async runEffect(effectId,boot) {
    const current=()=>!!this.child&&this.boot===boot;
    if(!current())fail('FENCE_INVALID');
    let snapshot = await this.query(), model = snapshot.data.model;
    const task = model.tasks.find(t => t.execution.effects.some(e => e.id === effectId)), effect = task?.execution.effects.find(e => e.id === effectId);
    if (!effect || effect.state !== 'ready') fail('FENCE_INVALID');
    const receipt = { id: newId(), validator_version: `domain-${VERSION.engine}`, schema_version: VERSION.schema,
      scope_revision: model.rows.find(r => r.id === task.work_id).scope_revision, candidate_digest: effect.payload_digest,
      terminated: true, exit: 0, result: 'pass', durable: true, source_revision: snapshot.source_revision, readset: hostReadset(model, effect.id) };
    if(!current())fail('FENCE_INVALID');
    await this.program('effect-runner', this.command('validation receipt', { work: task.work_id, receipt }, snapshot.source_revision));
    snapshot = await this.query();
    const request = this.command('effect claim', { effect: effectId, claim: `claim:${effectId}`, receipt_or_lookup: receipt.id }, snapshot.source_revision, `claim:${effectId}`);
    if(!current())fail('FENCE_INVALID');
    await this.program('effect-runner', request);
    const evidence = await this.program('effect-runner', request, { invoke: true, runnerCurrent:current });
    await this.program('host-bridge', this.command('effect report', { effect: effectId }, (await this.query()).source_revision), { adapterEvidence: evidence });
  }
  stopWorker() { const child = this.child; this.child = null; this.boot = null; this.health.worker = 'absent'; this.health.ready = false;
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(new Error('CAPABILITY_UNAVAILABLE')); this.pending = null; }
    if (child) { this.lastStopped=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal,pid:child.pid})));child.kill('SIGKILL');child.stdin.end(); } }
  async run({ intervalMs = 1000, signal, failureBudget = 3 } = {}) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 20 || intervalMs > 60000 || !Number.isInteger(failureBudget) || failureBudget < 1 || failureBudget > 10) fail('INVALID_INPUT');
    let failures = 0;
    try {
      while (!signal?.aborted) {
        try { await this.cycle(); failures = 0; }
        catch { this.health.ready = false; this.health.project = 'blocked'; if (++failures >= failureBudget) fail('CAPABILITY_UNAVAILABLE'); }
        if (!signal?.aborted) await new Promise(resolve => { let timer;const finish=()=>{clearTimeout(timer);signal?.removeEventListener('abort',finish);resolve();};timer=setTimeout(finish,intervalMs);signal?.addEventListener('abort',finish,{once:true}); });
      }
    } finally { this.stopWorker(); this.health.supervisor = 'stopped'; }
  }
}
