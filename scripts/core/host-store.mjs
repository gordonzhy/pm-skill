import {isWorker,reduceWorker} from './worker-domain.mjs';
import {workerIO} from './worker-io.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { executeFiles, FileStore } from './file-store.mjs';
import { identity as fileIdentity, sameIdentity, regular, directory, safeRoot } from './file-platform.mjs';
import { parseModel, authorize, findReplay, newId, jsonBytes, rawHash } from './file-model.mjs';
import { initializeHost, reduceHost, hostReadset, validateHostDomain, hostGrantRefs } from './host-domain.mjs';
import { verifyHostIdentity } from './host-bridge.mjs';
import { consumeAdapterEvidence, inspectAdapterEvidence, issueExecutionPermit, issueLookupPermit } from './execution-permit.mjs';
import { parseExecutionInventory } from './execution-inventory.mjs';
import { consumeHostObservation } from './host-observation.mjs';
import { digest, parseJSON, result, validateResult, validateRequest } from './engine.mjs';
import { VERSION, ContractError, fail } from './contracts.mjs';

const sourceRevision = files => digest(files.map(({ path, exists, mode, digest }) => ({ path, exists, mode, digest })).sort((a, b) => a.path.localeCompare(b.path)));
const protections = new Set(['work pause', 'work cancel', 'grant revoke']);
const validationChild = `import fs from 'node:fs';import {validateHostDomain} from ${JSON.stringify(new URL('./host-domain.mjs', import.meta.url).href)};validateHostDomain(JSON.parse(fs.readFileSync(0,'utf8')));process.stdout.write('pass');`;

export class HostStore extends FileStore {
  constructor(root, options = {}) { super(root, options); this.hostIdentity = options.hostIdentity; this.adapterEvidence = options.adapterEvidence; this.observationEvidence = options.observationEvidence; this.runnerCurrent = options.runnerCurrent ?? (()=>true);this.clock=options.clock??{wall:()=>Date.now(),uptime:()=>Math.floor(os.uptime()*1000)}; }
  async checkpoint(name){
    await super.checkpoint(name);
    if(['before-DECIDED','VERIFIED'].includes(name))for(const item of this.candidateChecks??[])await this.verifyCandidate({tasks:[{work_id:item.work_id,scope:item.scope}]},{input:{work:item.work_id,candidate:item.candidate}});
  }
  async finish(ordered){
    this.candidateChecks=[];
    for(const member of ordered){
      const model=parseModel(member.journal.after),audits=[...model.project.project_audit,...model.tasks.flatMap(t=>t.audit)];
      const audit=audits.find(a=>a.operation_receipt?.operation_id===member.journal.operation_id);
      if(!audit||!['delivery-submit','acceptance-decide','flow-accept','work-close'].includes(audit.type))continue;
      const row=model.rows.find(r=>r.id===audit.subject),task=model.tasks.find(t=>t.work_id===row?.id),candidate=task?.candidates.find(c=>c.id===row.candidate_id);
      if(candidate)this.candidateChecks.push({work_id:row.id,scope:task.scope,candidate});
    }
    return super.finish(ordered);
  }
  inventoryFilename() { return path.join(this.state, 'execution', `${digest(this.lock.rootId).slice(7)}.jsonl`); }
  async ensureBootstrap(request) {
    if (!await this.readObject('.pm-local/safety-identity.json', { optional: true })) await this.safety(async () => {}, { create: true });
    const inventoryDirectory = path.dirname(this.inventoryFilename());
    await fs.mkdir(inventoryDirectory, { recursive: true, mode: 0o700 });
    const st = await directory(inventoryDirectory);
    if (st.uid !== process.getuid() || (st.mode & 0o077)) fail('AUTH_DENIED');
    if (!this.pin.host_bootstrap) {
      this.pin.host_bootstrap = { nonce: newId(), project_id: request.project_id, manager_epoch: this.hostIdentity.manager_epoch,
        host_instance: this.hostIdentity.host_instance, run_epoch: newId(),clock_anchor:{wall:this.clock.wall(),uptime:this.clock.uptime(),tolerance_ms:5000} };
      await this.putObject('.pm-local/identity.json', this.pin);
    }
    const bootstrap = this.pin.host_bootstrap;
    if (bootstrap.project_id !== request.project_id || bootstrap.manager_epoch !== this.hostIdentity.manager_epoch ||
        bootstrap.host_instance !== this.hostIdentity.host_instance) fail('FENCE_INVALID');
    const header = { format: 'project-execution/1', root: this.lock.rootId, lock: this.lock.lockId, ...bootstrap };
    const line = Buffer.from(`${JSON.stringify(header)}\n`), filename = this.inventoryFilename();
    if (!this.pin.host_inventory_identity) {
      const modelFiles = await this.source();
      if (modelFiles.some(f => f.exists)) {
        const model = parseModel(modelFiles);
        if (model.rows.length || model.project.project_grants.length || model.project.project_audit.length !== 1 ||
            model.project.project_audit[0].operation_receipt?.input_digest !== digest(request)) fail('FENCE_INVALID');
      }
      let bytes;
      try { await regular(filename); bytes = await fs.readFile(filename); }
      catch (error) { if (error.code !== 'ENOENT') throw error; const fd = await fs.open(filename, 'wx', 0o600); await fd.close(); bytes = Buffer.alloc(0); }
      if (!line.subarray(0, bytes.length).equals(bytes)) fail('FENCE_INVALID');
      await fs.writeFile(filename, line); await this.flush(filename); await this.flush(inventoryDirectory);
      this.pin.host_inventory_identity = await fileIdentity(filename);
      await this.putObject('.pm-local/identity.json', this.pin);
    }
    await this.readInventory();
  }
  async activate(request, publication) {
    const name = '.pm-local/execution-activation.json', bootstrap = this.pin.host_bootstrap;
    if (!bootstrap) fail('FENCE_INVALID');
    if (!this.pin.host_activation_identity) {
      const model = parseModel(await this.source());
      if (model.rows.length || model.project.project_audit.length !== 1 || model.project.project_audit[0].operation_receipt?.input_digest !== digest(request) ||
          (await this.readInventory()).length) fail('FENCE_INVALID');
      const value = { ...bootstrap, root: this.lock.rootId, inventory: this.pin.host_inventory_identity,
        initial_publication: publication.source_revision };
      const existing = await this.readObject(name, { optional: true });
      if (existing && digest(existing) !== digest(value)) fail('FENCE_INVALID');
      if (!existing) await this.putObject(name, value, { exclusive: true });
      this.pin.host_activation_identity = await fileIdentity(this.p(name));
      await this.putObject('.pm-local/identity.json', this.pin);
    }
    return this.activation();
  }
  async activation() {
    try{
    if (!this.pin.host_activation_identity || !sameIdentity(this.pin.host_activation_identity, await fileIdentity(this.p('.pm-local/execution-activation.json')))) fail('FENCE_INVALID');
    const activation = await this.readObject('.pm-local/execution-activation.json');
    if (!sameIdentity(activation.root, this.lock.rootId) || !sameIdentity(activation.inventory, this.pin.host_inventory_identity) ||
        activation.host_instance !== this.hostIdentity.host_instance || activation.manager_epoch !== this.hostIdentity.manager_epoch) fail('FENCE_INVALID');
    await this.readInventory(); return activation;
    }catch(error){if(error instanceof ContractError)throw error;fail('FENCE_INVALID');}
  }
  assertClock(){
    const anchor=this.pin.host_bootstrap?.clock_anchor,wall=this.clock.wall(),uptime=this.clock.uptime();
    if(!anchor||!Number.isSafeInteger(wall)||!Number.isSafeInteger(uptime)||uptime<anchor.uptime||Math.abs(wall-anchor.wall-(uptime-anchor.uptime))>anchor.tolerance_ms)fail('CLOCK_UNCERTAIN');
  }
  async readInventory() {
    try{
    const filename = this.inventoryFilename();
    if (!this.pin.host_inventory_identity || !sameIdentity(this.pin.host_inventory_identity, await fileIdentity(filename))) fail('FENCE_INVALID');
    await regular(filename); const bytes = await fs.readFile(filename);
    return parseExecutionInventory(bytes,{format:'project-execution/1',root:this.lock.rootId,lock:this.pin.lock,...this.pin.host_bootstrap});
    }catch(error){if(error instanceof ContractError)throw error;fail('FENCE_INVALID');}
  }
  async appendInventory(value) {
    const values = await this.readInventory(), filename = this.inventoryFilename();
    const lines = (await fs.readFile(filename, 'utf8')).trimEnd().split('\n');
    const last = parseJSON(lines.at(-1));
    const record = { previous: digest(last), value, digest: digest(value) };
    if (values.length >= 8192) fail('FENCE_INVALID');
    await fs.appendFile(filename, `${JSON.stringify(record)}\n`); await this.flush(filename);
    await this.checkpoint('HOST_INVENTORY_DURABLE');
  }
  assertInventorySource(model, values) {
    for (const record of values) {
      const f = record.facts;
      if (!f || !['permit', 'outcome'].includes(record.kind)) fail('FENCE_INVALID');
      const effect = model.tasks.flatMap(t => t.execution.effects).find(e => e.id === f.effect_id);
      if (!effect?.claim || effect.claim.id !== f.claim_id || effect.payload_digest !== f.payload_digest || effect.run_epoch !== f.run_epoch) fail('FENCE_INVALID');
    }
  }
  async captureProtectionInventory(model,request){
    const ids=request.input.grant?.work_ids??[request.input.work];
    try{
      const records=await this.readInventory(),issued=[...new Set(records.filter(v=>v.kind==='permit').map(v=>v.facts.claim_id))];
      const issuedSet=new Set(issued),inflight=[];
      for(const id of ids){const task=model.tasks.find(t=>t.work_id===id),x=task?.execution;
        if(x&&x.effects.some(e=>e.claim&&issuedSet.has(e.claim.id)&&e.blocking_class!=='passive'&&e.kind!=='host.stop'&&
          (['claimed','accepted','unknown'].includes(e.state)||(['host.start','host.resume'].includes(e.kind)&&e.state==='confirmed'&&x.lanes.find(l=>l.id===task.dispatches.find(d=>d.id===e.dispatch_ref)?.lane_ref)?.lifecycle.ended.value!==true))))inflight.push(id);
        if(records.some(v=>v.facts.work_id===id&&!x?.effects.some(e=>e.id===v.facts.effect_id)))inflight.push(id);
      }
      return {inventory_valid:true,issued_claims:issued,inflight_work_ids:[...new Set(inflight)]};
    }catch{return {inventory_valid:false,issued_claims:[],inflight_work_ids:ids};}
  }
  async hostReconcile() {
    await this.begin(); try { await this.reconcile(); } finally { await this.end(); }
  }
  async hostCommand(request) {
    verifyHostIdentity(this.hostIdentity, request);
    this.activeRequest = request;
    const init = ['project init', 'flow take-control'].includes(request.command);
    await this.begin({ create: init, bootstrapDigest: digest(request) });
    try {
      if (init) await this.ensureBootstrap(request);
      const pub = await this.reconcile(), before = await this.source();
      let model;
      if (before.some(f => f.exists)) {
        model = parseModel(before); authorize(request, model, this.hostIdentity);
        const replay = findReplay(model, request, await this.protections());
        if (replay) { if (init) await this.activate(request, pub); return { ...replay, source_revision: pub.source_revision, generation: pub.generation }; }
      }
      if (init) { if (before.some(f => f.exists) || await safeRoot(request.input.root) !== this.root) fail('INVARIANT_VIOLATION'); }
      else if (!model) fail('RECOVERY_REQUIRED');
      const activation = init ? this.pin.host_bootstrap : await this.activation();
      if (request.expected_revision !== sourceRevision(before)) fail('VERSION_CONFLICT');
      if (request.command === 'project reconcile') return result('NO_CHANGE', 'reconcile', { source_revision: pub.source_revision, generation: pub.generation });
      if (request.command === 'monitor refresh' && request.input.snapshot !== pub.snapshot) fail('VERSION_CONFLICT');
      if(request.command==='monitor refresh')this.assertClock();
      if(request.command==='work close'&&model.project.worker_control?.dispatches.some(d=>d.work===request.input.work&&(d.commitments.some(c=>c.status==='open')||d.pending.some(p=>p.state==='pending'))))fail('INVARIANT_VIOLATION');
      if (['effect claim','effect refresh-fence'].includes(request.command)){
        const effect=model.tasks.flatMap(t=>t.execution.effects).find(e=>e.id===request.input.effect);
        if(effect?.kind!=='host.stop')this.assertClock();
        const inventory=await this.readInventory();this.assertInventorySource(model,inventory);
        if(request.command==='effect refresh-fence'&&(!effect?.claim||inventory.some(v=>v.facts.claim_id===effect.claim.id)))fail('FENCE_INVALID');
      }
      const operationId = newId(), options = { identity: this.hostIdentity, operationId, runEpoch: activation.run_epoch };
      if (request.command === 'validation receipt') options.completedValidation = this.runValidation(model, request);
      if (request.command === 'delivery submit'){
        options.candidateVerified=await this.verifyCandidate(model,request);
        const task=model.tasks.find(t=>t.work_id===request.input.work);this.candidateChecks=[{work_id:task.work_id,scope:task.scope,candidate:request.input.candidate}];
      }
      if(['acceptance decide','flow accept','work close'].includes(request.command)){
        const row=model.rows.find(r=>r.id===request.input.work||r.candidate_id===request.input.candidate),task=model.tasks.find(t=>t.work_id===row?.id),candidate=task?.candidates.find(c=>c.id===row.candidate_id);
        if(!candidate)fail('VALIDATION_REQUIRED');await this.verifyCandidate(model,{input:{work:row.id,candidate}});
        this.candidateChecks=[{work_id:row.id,scope:task.scope,candidate}];
      }
      if (['effect report', 'effect reconcile'].includes(request.command)) {
        options.hostEvidence=await this.decodeEvidence(model,request);
        const effect=model.tasks.flatMap(t=>t.execution.effects).find(e=>e.id===request.input.effect);
        if((options.hostEvidence.unknown&&effect?.state==='unknown')||(options.hostEvidence.accepted&&effect?.state==='accepted'))return result('NO_CHANGE',operationId,{source_revision:pub.source_revision,generation:pub.generation});
      }
      if (request.command === 'observation accept') {
        const binding = { project_id: request.project_id, manager_epoch: this.hostIdentity.manager_epoch,
          repo: this.root, host_instance: this.hostIdentity.host_instance };
        const observed = consumeHostObservation(this.observationEvidence, request.input, binding);
        options.hostEvidence = { observation: observed };
      }
      if(isWorker(request.command)){
        const workerOptions={now:this.workerClock(),identity:this.hostIdentity};
        if(request.command==='worker handoff publish')reduceWorker(model,request,operationId,{...workerOptions,io:{envelope_digest:digest(request.input.envelope)}});
        const io=await workerIO(this,model,request),beforeWorker=digest(model);model=reduceWorker(model,request,operationId,{...workerOptions,io});if(digest(model)===beforeWorker)return result('NO_CHANGE',operationId,{source_revision:sourceRevision(before),generation:pub?.generation??null});
      }else model = init ? initializeHost(request, this.hostIdentity, operationId) : reduceHost(model, request, options);
      const prepared = await this.prepare(before, this.afterFiles(before, model), request, { protection_seq: pub?.protection_seq ?? 0 });
      const publication = await this.finish([prepared]);
      if (init) await this.activate(request, publication);
      const final = parseModel(await this.source()), replay = findReplay(final, request, await this.protections());
      return { ...replay, source_revision: publication.source_revision, generation: publication.generation, run_epoch: activation.run_epoch };
    } catch (error) {
      if(this.published){
        const final=parseModel(await this.source()),replay=findReplay(final,request,await this.protections());
        if(replay&&sourceRevision(await this.source())===this.published.source_revision){
          if(init){
            try{await this.activation();}
            catch{return result('IO_PENDING',replay.operation_receipt,{operation_receipt:replay.operation_receipt,source_revision:this.published.source_revision,generation:this.published.generation,
              steps:[{name:'activation',state:'business-published-runtime-pending',facts:{local_intent_committed:true,retry_same_key:true,external_calls:0},evidence:[],assurance:'verified'}]});}
          }
          return {...replay,source_revision:this.published.source_revision,generation:this.published.generation,steps:[...replay.steps,{name:'local-cleanup',state:'pending',facts:{local_intent_committed:true,external_calls:0},evidence:[],assurance:'verified'}]};
        }
      }
      if (!(error instanceof ContractError)) {
        const pending = await this.pending().catch(() => []), active = pending.find(p => p.decided);
        if (active) return result('IO_PENDING', active.journal.operation_id, { operation_receipt: active.journal.operation_id,
          steps: [{ name: 'file-commit', state: 'decided-recovery-pending', facts: { retry_same_key: true, external_calls: 0 }, evidence: [], assurance: 'verified' }] });
        const failure=new ContractError('IO_PREPARE_FAILED');failure.cause=error;throw failure;
      }
      throw error;
    } finally { await this.end(); }
  }
  runValidation(model, request) {
    const receipt = request.input.receipt, task = model.tasks.find(t => t.work_id === request.input.work);
    const effect = task?.execution.effects.find(e => e.payload_digest === receipt.candidate_digest);
    if (!effect || receipt.source_revision !== request.expected_revision || !task) fail('VALIDATION_REQUIRED');
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', validationChild], {
      input: JSON.stringify(model), encoding: 'utf8', timeout: 10000, maxBuffer: 1048576,
      env: { PATH: process.env.PATH, HOME: this.root }, stdio: ['pipe', 'pipe', 'pipe'] });
    if (child.error || child.status !== 0 || child.stdout !== 'pass') fail('VALIDATION_REQUIRED');
    const actual = { id: receipt.id, validator_version: `domain-${VERSION.engine}`, schema_version: VERSION.schema,
      scope_revision: model.rows.find(r => r.id === task.work_id).scope_revision, candidate_digest: effect.payload_digest,
      terminated: true, exit: 0, result: 'pass', durable: true, source_revision: request.expected_revision, readset: hostReadset(model, effect.id) };
    if (digest(actual) !== digest(receipt)) fail('VALIDATION_REQUIRED'); return actual;
  }
  async verifyCandidate(model, request) {
    const task = model.tasks.find(t => t.work_id === request.input.work);
    if (!task) fail('INVALID_INPUT');
    for (const entry of request.input.candidate.manifest) {
      if (!task.scope.allowed_writes.some(root => entry.path === root || entry.path.startsWith(`${root}/`))) fail('PATH_UNSAFE');
      const st = await this.checked(entry.path);
      if (!st || st.size !== entry.size || rawHash(await this.read(entry.path)) !== entry.digest) fail('READSET_CHANGED');
    }
    return true;
  }
  async invokeClaim(request,bridge){
    verifyHostIdentity(this.hostIdentity,request);
    await this.begin();
    try{
      const pub=await this.reconcile(),model=parseModel(await this.source());authorize(request,model,this.hostIdentity);
      if(request.command!=='effect claim'||this.hostIdentity.role!=='effect-runner')fail('AUTH_DENIED');
      const activation=await this.activation(),values=await this.readInventory();
      if(bridge.capability.instance!==activation.host_instance)fail('FENCE_INVALID');this.assertInventorySource(model,values);
      const task=model.tasks.find(t=>t.execution.effects.some(e=>e.id===request.input.effect)),row=model.rows.find(r=>r.id===task?.work_id),effect=task?.execution.effects.find(e=>e.id===request.input.effect);
      if(!effect?.claim||effect.state!=='claimed'||effect.run_epoch!==activation.run_epoch||effect.claim.runner!==this.hostIdentity.actor||
        (request.input.claim&&effect.claim.id!==request.input.claim)||values.some(v=>v.facts.claim_id===effect.claim.id))fail('FENCE_INVALID');
      const replay=findReplay(model,request,await this.protections());
      if(!replay||replay.operation_receipt!==effect.claim.claim_operation_id)fail('FENCE_INVALID');
      let journal;
      for(const name of await fs.readdir(this.p('.pm-local/transactions'))){
        if(!/^[a-f0-9-]{36}$/.test(name))continue;
        const found=await this.readObject(`.pm-local/transactions/${name}/journal.json`,{optional:true});
        if(found?.operation_id===(effect.claim.fence_operation_id??effect.claim.claim_operation_id)){if(journal)fail('FENCE_INVALID');journal=found;}
      }
      if(!journal||journal.after_revision!==pub.source_revision||journal.before_revision!==(effect.claim.fence_source_revision??effect.claim.validated_source_revision)||(!effect.claim.fence_operation_id&&journal.input_digest!==digest(request)))fail('READSET_CHANGED');
      await this.verifyDecided(journal);
      const validation=task.execution.validations.find(v=>v.id===request.input.receipt_or_lookup);
      if(!validation||digest(hostReadset(model,effect.id))!==digest(validation.readset))fail('READSET_CHANGED');
      const payload=task.execution.payloads.find(p=>p.id===effect.payload_ref);
      if(!payload||digest(payload.body)!==effect.payload_digest)fail('READSET_CHANGED');
      if(effect.kind==='host.stop'){
        if(!task.obligations.some(o=>o.template==='stop-proof'&&o.lifecycle==='active'&&effect.prerequisites.includes(o.derivation_key)))fail('AUTH_DENIED');
      }else{
        this.assertClock();hostGrantRefs(model,row,effect.kind,effect.grant_refs,this.clock.wall());
      }
      if(row.candidate_id&&['reviewing','accepted'].includes(row.phase))await this.verifyCandidate(model,{input:{work:row.id,candidate:task.candidates.find(c=>c.id===row.candidate_id)}});
      const latestTurn=task.execution.receipts.filter(r=>r.target===effect.target&&r.turn).at(-1)?.turn;
      const facts={project_id:model.project.project_id,repo:this.root,host_instance:activation.host_instance,connection:bridge.capability.connection,
        work_id:row.id,effect_id:effect.id,claim_id:effect.claim.id,kind:effect.kind,target:effect.target,payload_digest:effect.payload_digest,run_epoch:effect.run_epoch,
        manager_epoch:effect.manager_epoch,source_revision:pub.source_revision,protection_seq:pub.protection_seq,...(latestTurn?{turn_id:latestTurn}:{})};
      if(!this.runnerCurrent())fail('FENCE_INVALID');
      let permit;
      await this.safety(async()=>{
        const events=await this.protections();
        if(effect.kind!=='host.stop'&&effect.kind!=='channel.send'&&events.some(e=>(e.request.input.grant?.work_ids??[e.request.input.work]).includes(row.id)))fail('PROTECTED');
        if(digest(await this.gitToken())!==digest(pub.git)||sourceRevision(await this.source())!==pub.source_revision)fail('READSET_CHANGED');
        verifyHostIdentity(this.hostIdentity,request);
        if(effect.kind!=='host.stop')this.assertClock();
        await this.appendInventory({kind:'permit',facts,at:new Date().toISOString()});
        permit=issueExecutionPermit(facts,()=>!!this.lock&&this.runnerCurrent());
      });
      await this.checkpoint('HOST_CALL_PERMITTED');
      // The project lock remains held; a concurrent P can still take its short safety lock.
      let token;
      try{token=await bridge.perform(effect,payload,permit,facts,async issue=>{
        await this.checkpoint('HOST_BEFORE_MUTATION');
        const issued=await this.safety(async()=>{
          verifyHostIdentity(this.hostIdentity,request);
          if(!this.runnerCurrent())fail('FENCE_INVALID');
          const events=await this.protections();
          if(effect.kind!=='host.stop'&&effect.kind!=='channel.send'&&events.some(e=>(e.request.input.grant?.work_ids??[e.request.input.work]).includes(row.id)))fail('PROTECTED');
          if(digest(await this.gitToken())!==digest(pub.git)||sourceRevision(await this.source())!==pub.source_revision)fail('READSET_CHANGED');
          if(effect.kind!=='host.stop'){this.assertClock();hostGrantRefs(model,row,effect.kind,effect.grant_refs,this.clock.wall());}
          // Serialize only RPC issuance with deny persistence, never the host response.
          return {pending:issue()};
        });
        return issued.pending;
      });}
      catch{return {state:'unknown',facts,token:null};}
      const outcome=inspectAdapterEvidence(token,facts);
      await this.safety(async()=>{await this.appendInventory({kind:'outcome',facts,outcome,at:new Date().toISOString()});});
      return {state:outcome.state,facts,token};
    }finally{await this.end();}
  }
  async lookupClaim(request,bridge){
    verifyHostIdentity(this.hostIdentity,request);await this.begin();
    try{
      const pub=await this.reconcile(),model=parseModel(await this.source());authorize(request,model,this.hostIdentity);
      if(request.command!=='effect reconcile')fail('AUTH_DENIED');
      const activation=await this.activation(),values=await this.readInventory();this.assertInventorySource(model,values);
      const task=model.tasks.find(t=>t.execution.effects.some(e=>e.id===request.input.effect)),effect=task?.execution.effects.find(e=>e.id===request.input.effect);
      if(!effect?.claim||!['claimed','accepted','unknown'].includes(effect.state)||bridge.capability.instance!==activation.host_instance)fail('FENCE_INVALID');
      const records=values.filter(v=>v.facts.claim_id===effect.claim.id),last=records.at(-1);
      if(!last)fail('CAPABILITY_UNAVAILABLE');
      const facts={...last.facts,connection:bridge.capability.connection,source_revision:pub.source_revision,lookup:true,
        ...(last.outcome?.turn?{known_turn:last.outcome.turn}:{})};
      const payload=task.execution.payloads.find(p=>p.id===effect.payload_ref);
      const token=await bridge.lookup(effect,payload,issueLookupPermit(facts,()=>!!this.lock),facts);
      const outcome=inspectAdapterEvidence(token,facts);
      if(outcome.state==='confirmed')await this.safety(async()=>{await this.appendInventory({kind:'outcome',facts,outcome,at:new Date().toISOString()});});
      return {state:outcome.state,token,facts};
    }finally{await this.end();}
  }
  async decodeEvidence(model, request) {
    const effect = model.tasks.flatMap(t => t.execution.effects).find(e => e.id === request.input.effect);
    if (!effect?.claim) fail('FENCE_INVALID');
    let facts,outcome;
    if(this.adapterEvidence){facts=this.adapterEvidence.facts;outcome=consumeAdapterEvidence(this.adapterEvidence.token,facts);}
    else{
      const records=(await this.readInventory()).filter(v=>v.facts.effect_id===effect.id&&v.facts.claim_id===effect.claim.id);
      if(!records.length)fail('CAPABILITY_UNAVAILABLE');facts=records.at(-1).facts;outcome=records.at(-1).outcome??{state:'unknown'};
    }
    if (facts.effect_id !== effect.id || facts.claim_id !== effect.claim.id || facts.payload_digest !== effect.payload_digest ||
        facts.manager_epoch !== model.project.manager_binding.epoch || facts.run_epoch !== effect.run_epoch) fail('FENCE_INVALID');
    if (outcome.state === 'unknown') return { unknown: true, effect_id: effect.id, claim_id: effect.claim.id, payload_digest: effect.payload_digest, run_epoch: effect.run_epoch };
    if (outcome.state === 'accepted') return { accepted: true, effect_id: effect.id, claim_id: effect.claim.id, payload_digest: effect.payload_digest, run_epoch: effect.run_epoch };
    if (outcome.state !== 'confirmed') fail('CAPABILITY_UNAVAILABLE');
    const event = { id: newId(), subject: effect.id, kind: outcome.event, occurred_at: outcome.occurred_at,
      issuer: this.hostIdentity.actor, proof: this.hostIdentity.reference, raw_result_ref: outcome.raw_result_ref };
    const receipt = { id: newId(), effect_id: effect.id, claim_id: effect.claim.id, run_epoch: effect.run_epoch,
      manager_epoch: effect.manager_epoch, target: effect.target, payload_digest: effect.payload_digest, event,
      occurred_at: outcome.occurred_at, issuer: this.hostIdentity.actor, proof: this.hostIdentity.reference,
      raw_result_ref: outcome.raw_result_ref, ...(outcome.route ? { result_route: outcome.route } : {}), ...(outcome.turn ? { turn: outcome.turn } : {}) };
    return { receipt, visible: outcome.visible, recoverable: outcome.recoverable };
  }
}

export async function executeHostFiles(request, options) {
  validateRequest(request); verifyHostIdentity(options.hostIdentity, request);
  if(request.query){
    const read=await executeFiles({...request,projection:'private-local'},{state:options.state});
    if(read.exit!==undefined)fail('RECOVERY_REQUIRED');
    authorize(request,read.data.model,options.hostIdentity);
    if(request.projection==='private-local')return read;
    return executeFiles(request,{state:options.state});
  }
  if (!request.command) fail('INVALID_INPUT');
  const store = new HostStore(request.repo, options);
  const output = protections.has(request.command) ? await store.protect(request) : await store.hostCommand(request);
  validateResult(output); return output;
}
