// Host-profile domain transitions. This is not a host adapter or an execution permit.
// The file adapter must persist these transitions with the shared transaction engine;
// a trusted runner supplies independently verified host/validator evidence.
import { DEFINITIONS, VERSION, validate, fail } from './contracts.mjs';
import { digest, validateDomain, compareReadset, verifySelfTransition, result } from './engine.mjs';
import { authorize, reduceLocal, newId, receiptFor } from './file-model.mjs';
import { verifyHostIdentity } from './host-bridge.mjs';
import { evaluateObligations } from './obligation-monitor.mjs';

export const emptyHostState = () => ({ lanes: [], selections: [], effects: [], payloads: [],
  validations: [], self_transitions: [], receipts: [], attention: [], observations: [] });
const localIntents = new Set(['work create', 'work amend', 'work dependencies', 'grant record', 'work commit-start', 'audit record']);
const current = (task, row) => task.dispatches.find(d => d.id === row.dispatch_id);
const check = (value = 'unknown', source = null, at = null) => ({ value, ...(source ? { source, checked_at: at } : {}) });
const eventTime = now => new Date(now).toISOString();
const routeFor = identity => ({ host: 'codex', instance: identity.host_instance, opaque_id: identity.thread_id,
  kind: 'independent-task-thread', provenance: 'host-origin' });

export function initializeHost(request, identity, operationId) {
  verifyHostIdentity(identity, request);
  if (!['project init', 'flow take-control'].includes(request.command) || identity.role !== 'manager' ||
      request.input.identity !== identity.actor) fail('AUTH_DENIED');
  const project = { schema_major: '1', project_id: request.project_id, project_name: 'Local project',
    manager_binding: { principal: identity.actor, route: routeFor(identity), epoch: identity.manager_epoch, proof: 'host-origin' },
    policy: { id: request.input.policy, version: '1', response_window_seconds: 3600,
      owner_escalation_limit: 1, clock_source: 'system-clock-uptime-fence' }, project_grants: [], handoffs: [], batches: [],
    project_obligations: [], project_audit: [] };
  project.project_audit.push(hostAudit(request, operationId, identity, project.project_id, 'project-initialized'));
  const model = { project, rows: [], tasks: [] }; validateHostDomain(model); return model;
}

const identityPayload=identity=>[
  ['host-principal',identity.actor],['host-thread',identity.thread_id],['host-turn',identity.turn_id],['host-call',identity.call_id],
  ['host-nonce',identity.nonce],['host-command-digest',identity.command_digest],['manager-epoch',identity.manager_epoch],['identity-source',identity.assurance]
].map(([field,value])=>({field,value}));
function hostAudit(request, operationId, identity, subject, type, evidence = [], now = Date.now()) {
  const operation = receiptFor(request, operationId);
  operation.semantic_result.steps[0].assurance = 'verified';
  return { event_id: newId(), at: eventTime(now), actor: identity.actor, subject, type,
    payload: identityPayload(identity), evidence, operation_receipt: operation };
}

export function validateHostDomain(model) {
  validateDomain(model);
  const binding = model.project.manager_binding;
  if (binding.proof !== 'host-origin' || !binding.route || binding.route.provenance !== 'host-origin') fail('AUTH_REQUIRED');
  const owner=model.project.owner_channel;
  if(owner&&(owner.epoch!==binding.epoch||owner.proof!=='host-origin'||owner.route?.provenance!=='host-origin'||owner.route.instance!==binding.route.instance||owner.principal===binding.principal||owner.route.opaque_id===binding.route.opaque_id))fail('AUTH_DENIED');
  for (const row of model.rows) {
  const task = model.tasks.find(t => t.work_id === row.id), state = task.execution;
    if (!state) fail('INVARIANT_VIOLATION');
    for(const attention of state.attention){
      const route=attention.role==='owner'?owner?.route:binding.route;
      if(!route||attention.target!==route.opaque_id||attention.manager_epoch!==binding.epoch||!attention.created_at||!attention.consume_due||!attention.deliver_due||
        ![attention.created_at,attention.consume_due,attention.deliver_due,...(attention.response_due?[attention.response_due]:[])].every(v=>Number.isFinite(Date.parse(v))))fail('INVARIANT_VIOLATION');
    }

    for (const effect of state.effects) {
      const payload = state.payloads.find(p => p.id === effect.payload_ref);
      if (!payload || digest(payload.body) !== effect.payload_digest || payload.kind !== effect.kind ||
          effect.manager_epoch !== binding.epoch || effect.project_id !== model.project.project_id || effect.work_id !== row.id)
        fail('INVARIANT_VIOLATION');
      if (['claimed', 'accepted', 'confirmed', 'unknown', 'failed'].includes(effect.state) && !effect.claim) fail('INVARIANT_VIOLATION');
      if(effect.claim&&!!effect.claim.fence_operation_id!==!!effect.claim.fence_source_revision)fail('INVARIANT_VIOLATION');
      if (effect.claim && (effect.claim.run_epoch !== effect.run_epoch || effect.claim.payload_digest !== effect.payload_digest)) fail('INVARIANT_VIOLATION');
    }
    for (const receipt of state.receipts) {
      const effect = state.effects.find(e => e.id === receipt.effect_id);
      if (!effect?.claim || receipt.claim_id !== effect.claim.id || receipt.payload_digest !== effect.payload_digest ||
          receipt.run_epoch !== effect.run_epoch || receipt.target !== effect.target || receipt.manager_epoch !== effect.manager_epoch)
        fail('INVARIANT_VIOLATION');
    }
    if (row.candidate_id) {
      const candidate = task.candidates.find(c => c.id === row.candidate_id);
      if (candidate.digest !== digest(candidate.manifest)) fail('INVARIANT_VIOLATION');
    }
    if (['reviewing', 'accepted', 'closed'].includes(row.phase) && !row.candidate_id) fail('INVARIANT_VIOLATION');
    if (['accepted', 'closed'].includes(row.phase)) {
      const decision = task.decisions.find(d => d.id === row.decision_id);
      if (!decision || decision.result !== 'pass' || decision.scope_revision !== row.scope_revision ||
          decision.candidate_digest !== task.candidates.find(c => c.id === row.candidate_id)?.digest) fail('INVARIANT_VIOLATION');
    }
  }
  return model;
}

// Validation readsets omit only the mechanical fields expressly changed by claim.
// They include every grant, current scope/candidate/decision, discovery set and lane.
export function hostReadset(model, effectId) {
  const copy = structuredClone(model);
  copy.project.project_audit = [];
  for (const row of copy.rows) { row.row_version = 1; row.updated_at = 'mechanical'; }
  for (const task of copy.tasks) {
    task.audit = [];
    if (task.execution) {
      task.execution.validations = []; task.execution.self_transitions = [];
      for (const effect of task.execution.effects) if (effect.id === effectId) {
        delete effect.claim; effect.state = 'ready';
        const attention=task.execution.attention.find(a=>a.id===effect.success_gate);if(attention)attention.state='ready';
      }
    }
  }
  return { fields: [{ object: model.project.project_id, field: 'host-business', digest: digest(copy) }],
    references: [{ reference: effectId, exists: model.tasks.some(t => t.execution?.effects.some(e => e.id === effectId)) }],
    discoveries: [{ collection: 'managed-work', digest: digest(model.rows.map(r => [r.id, r.detail_path]).sort()) }] };
}

export function hostGrantRefs(model,row,action,refs=null,now=Date.now()){
  const task=model.tasks.find(t=>t.work_id===row.id);
  if(action!=='channel.send'&&(row.control!=='enabled'||task.blockers.length))fail('PROTECTED');
  const grants=model.project.project_grants.filter(g=>g.work_ids.includes(row.id)&&g.scope_revision===row.scope_revision&&
    (!refs||refs.includes(g.id))&&g.actions.includes(action)&&!g.revoked_at&&Date.parse(g.issued_at)<=now&&(!g.expires_at||Date.parse(g.expires_at)>now)&&
    (!['host.start','host.resume'].includes(action)||task.scope.allowed_writes.every(root=>g.write_roots.some(allowed=>root===allowed||root.startsWith(`${allowed}/`)))));
  if(!grants.length)fail('GRANT_MISSING');return grants.map(g=>g.id);
}

export function attentionRefreshNeeded(project,state,root,now=Date.now()){
  const manager=state.attention.find(a=>a.alert_key===root.alert_key&&a.manager_epoch===project.manager_binding.epoch&&(a.role??'manager')==='manager');
  if(!manager)return true;
  const granted=project.project_grants.some(g=>g.work_ids.some(id=>state.effects.some(e=>e.work_id===id)||root.work_id===id)&&g.actions.includes('channel.send')&&!g.revoked_at&&(!g.expires_at||Date.parse(g.expires_at)>now));
  if(!manager.effect_ref&&granted)return true;
  const deadline=manager.next_due??manager.response_due??manager.consume_due;
  if(!deadline||Date.parse(deadline)>now||!project.policy.owner_escalation_limit)return false;
  const owner=state.attention.find(a=>a.alert_key===root.alert_key&&a.manager_epoch===project.manager_binding.epoch&&a.role==='owner');
  if(!owner)return !!project.owner_channel||manager.escalation_state!=='unavailable';
  if(!owner.effect_ref&&granted)return true;
  return !owner.channel_disposition&&Date.parse(owner.response_due??owner.consume_due)<=now&&owner.escalation_state!=='exhausted';
}

export function reduceHost(model, request, { identity, operationId, runEpoch, now = Date.now(),
  hostEvidence = null, completedValidation = null, candidateVerified = false } = {}) {
  authorize(request, model, identity);
  validateHostDomain(model);
  if (!Number.isSafeInteger(now) || now < 0) fail('CLOCK_UNCERTAIN');
  if (localIntents.has(request.command)) {
    const next = reduceLocal(model, request, operationId, identity);
    for (const task of next.tasks) task.execution ??= emptyHostState();
    const audit=[...next.project.project_audit,...next.tasks.flatMap(t=>t.audit)].find(a=>a.operation_receipt?.operation_id===operationId);
    if(audit){audit.payload.push(...identityPayload(identity));audit.operation_receipt.semantic_result.steps[0].assurance='verified';}
    validateHostDomain(next); return next;
  }
  const beforeModel = model;
  model = structuredClone(model);
  const { command, input } = request, project = model.project;
  if(command==='attention channel-bind'){
    if(identity.role!=='owner'||input.proof!=='host-origin'||identity.actor===project.manager_binding.principal||identity.thread_id===project.manager_binding.route.opaque_id)fail('AUTH_DENIED');
    const binding={principal:identity.actor,route:routeFor(identity),epoch:identity.manager_epoch,proof:'host-origin'};
    if(project.owner_channel&&digest(project.owner_channel)!==digest(binding))fail('FENCE_INVALID');
    project.owner_channel=binding;project.project_audit.push(hostAudit(request,operationId,identity,project.project_id,'owner-channel-bound',[],now));validateHostDomain(model);return model;
  }
  if(command==='policy amend'){
    if(input.scope!==project.project_id||input.proof!=='host-origin')fail('AUTH_DENIED');
    for(const change of input.changes){
      if(!['response_window_seconds','owner_escalation_limit'].includes(change.key)||!/^\d+$/.test(change.value))fail('CAPABILITY_UNAVAILABLE');
      const value=Number(change.value);
      if(!Number.isSafeInteger(value)||value<0||value>(change.key==='owner_escalation_limit'?1:86400))fail('INVALID_INPUT');
      project.policy[change.key]=value;
    }
    project.policy.version=newId();
    const audit=hostAudit(request,operationId,identity,project.project_id,'policy-amended',[],now);
    audit.payload.push({field:'existing-due-dates',value:'preserved'},{field:'policy-effect',value:'future-activations-only'});
    project.project_audit.push(audit);validateHostDomain(model);return model;
  }
    if(command==='monitor refresh'){
    if(input.policy!==project.policy.id||input.observations?.length)fail('AUTH_DENIED');
    const view=evaluateObligations(model,{snapshot:input.snapshot,generation:0,now});
    if(view.roots.some(root=>project.project_obligations.some(o=>o.id===root.obligation_id)))fail('CAPABILITY_UNAVAILABLE');
    const created=[];
    for(const root of view.roots){
      const task=model.tasks.find(t=>t.obligations.some(o=>o.id===root.obligation_id)),row=model.rows.find(r=>r.id===task.work_id),state=task.execution;
      let changed=false;
      const grants=project.project_grants.filter(g=>g.work_ids.includes(row.id)&&g.scope_revision===row.scope_revision&&g.actions.includes('channel.send')&&!g.revoked_at&&Date.parse(g.issued_at)<=now&&(!g.expires_at||Date.parse(g.expires_at)>now));
      const ensure=(role,target)=>{
        let attention=state.attention.find(a=>a.alert_key===root.alert_key&&a.manager_epoch===project.manager_binding.epoch&&(a.role??'manager')===role);
        if(!attention){const deadline=eventTime(now+project.policy.response_window_seconds*1000);attention={id:newId(),alert_key:root.alert_key,obligation_id:root.obligation_id,obligation_revision:root.obligation_revision,
          manager_epoch:project.manager_binding.epoch,target,role,tier:role==='manager'?0:1,created_at:eventTime(now),deliver_due:deadline,consume_due:deadline,payload_digest:digest(root.alert_key),state:'ready',escalation_state:'waiting'};state.attention.push(attention);changed=true;}
        if(!attention.effect_ref&&grants.length){
          if(!runEpoch)fail('FENCE_INVALID');
          const payload={id:newId(),kind:'channel.send',body:JSON.stringify({subject:attention.id,alert_key:root.alert_key,message:role==='manager'?'Inspect the assigned private obligation.':'Inspect the private manager channel health; no business authority is transferred.'})};
          const effect={id:newId(),project_id:project.project_id,work_id:row.id,run_epoch:runEpoch,kind:'channel.send',target:attention.target,payload_ref:payload.id,payload_digest:digest(payload.body),grant_refs:grants.map(g=>g.id),manager_epoch:project.manager_binding.epoch,state:'ready',prerequisites:[],success_gate:attention.id,blocking_class:'passive'};
          state.payloads.push(payload);state.effects.push(effect);attention.effect_ref=effect.id;attention.payload_digest=effect.payload_digest;created.push(effect.id);changed=true;
        }
        return attention;
      };
      const manager=ensure('manager',project.manager_binding.route.opaque_id),deadline=manager.next_due??manager.response_due??manager.consume_due;
      if(project.policy.owner_escalation_limit&&deadline&&Date.parse(deadline)<=now){
        if(!project.owner_channel){if(manager.escalation_state!=='unavailable'){manager.escalation_state='unavailable';changed=true;}}
        else{
          const owner=ensure('owner',project.owner_channel.route.opaque_id);
          if(manager.escalation_state!=='issued'&&manager.escalation_state!=='exhausted'){manager.escalation_state='issued';manager.tier=1;changed=true;}
          if(!owner.channel_disposition&&Date.parse(owner.response_due??owner.consume_due)<=now&&owner.escalation_state!=='exhausted'){
            owner.escalation_state='exhausted';owner.tier=2;manager.escalation_state='exhausted';manager.tier=2;changed=true;
          }
        }
      }
      if(changed){row.row_version++;row.updated_at=eventTime(now);const a=hostAudit(request,operationId,identity,row.id,'attention-root-recorded',[],now);delete a.operation_receipt;task.audit.push(a);}
    }
    const audit=hostAudit(request,operationId,identity,project.project_id,'monitor-refreshed',[],now);
    if(created.length)audit.operation_receipt.semantic_result=result('EFFECT_PENDING',operationId,{operation_receipt:operationId,effects:created,steps:[{name:'attention-outbox',state:'published',facts:{local_intent_committed:true,external_calls:0},evidence:[],assurance:'verified'}]});
    project.project_audit.push(audit);validateHostDomain(model);return model;
  }
  const task = model.tasks.find(t => t.work_id === input.work || t.dispatches.some(d => d.id === input.dispatch) ||
    t.execution.effects.some(e => e.id === input.effect) || t.candidates.some(c => c.id === input.candidate) ||
    t.execution.attention.some(a => a.id === input.subject) || t.execution.lanes.some(l=>input.route&&l.route&&digest(input.route)===digest(l.route)) || (request.command === 'monitor refresh' && model.tasks.length === 1));
  if (!task) fail('INVALID_INPUT');
  const row = model.rows.find(r => r.id === task.work_id), state = task.execution;
  const at = eventTime(now), evidence = [];
  const grantFor=(action,refs=null)=>hostGrantRefs(model,row,action,refs,now);
  const requireReady = action => {
    grantFor(action);
    if (!task.commitments.some(c => c.id === row.commitment_id && c.state === 'live' && c.scope_revision === row.scope_revision) ||
        !row.dependencies.every(id => model.rows.find(r => r.id === id)?.phase === 'closed')) fail('INVARIANT_VIOLATION');
  };
  const addObligation = (template, basis, predicate, responsible = project.manager_binding.principal, born = now) => {
    const known = task.obligations.find(o => o.template === template && o.derivation_key === basis && o.scope_revision === row.scope_revision);
    if (known) return known;
    const o = { id: newId(), template, template_version: '1', derivation_key: basis, work_or_handoff_ref: row.id,
      scope_revision: row.scope_revision, responsible, activation_predicate: 'recorded-basis', satisfaction_predicate: predicate,
      activated_at: eventTime(born), due_at: eventTime(born + project.policy.response_window_seconds * 1000),
      policy_ref: project.policy.id, obligation_revision: 1, lifecycle: 'active', basis_refs: [basis], next: predicate };
    task.obligations.push(o); return o;
  };
  const satisfy = (template, proof, basis = null) => {
    for (const o of task.obligations) if (o.template === template && o.scope_revision === row.scope_revision &&
      ['waiting', 'active'].includes(o.lifecycle) && (!basis || o.derivation_key === basis)) {
      o.lifecycle = 'satisfied'; o.satisfied_by = proof;
    }
  };
  const addEffect = (kind, target, body, dispatch = null, blocking = 'mutating-host') => {
    if (!runEpoch) fail('FENCE_INVALID');
    const refs = grantFor(kind), payload = { id: newId(), kind, body };
    const effect = { id: newId(), project_id: project.project_id, work_id: row.id, run_epoch: runEpoch, kind, target,
      payload_ref: payload.id, payload_digest: digest(body), grant_refs: refs, manager_epoch: project.manager_binding.epoch,
      state: 'ready', prerequisites: [], blocking_class: blocking, ...(dispatch ? { dispatch_ref: dispatch.id } : {}) };
    state.payloads.push(payload); state.effects.push(effect); if (dispatch) dispatch.effect_refs.push(effect.id);
    return effect;
  };
  const getLane = dispatch => {
    const lane = state.lanes.find(l => l.id === dispatch?.lane_ref);
    if (!dispatch || !lane || dispatch.scope_revision !== row.scope_revision || dispatch.manager_epoch !== project.manager_binding.epoch) fail('ROLE_STALE');
    return lane;
  };
  if (command === 'lane select') {
    requireReady('host.prepare');
    if (row.phase !== 'planned' || row.dispatch_id || task.dispatches.some(d => d.id === input.dispatch)) fail('INVARIANT_VIOLATION');
    if (input.selection.selected_form !== 'independent-task-thread') fail('CAPABILITY_UNAVAILABLE');
    if (input.selection.requested_form !== input.selection.selected_form && !input.selection.degradation_ack) fail('AUTH_DENIED');
    const selection = { id: newId(), ...input.selection };
    grantFor('host.prepare', [selection.authorization]);
    const lane = { id: newId(), form: selection.selected_form, selection_ref: selection.id,
      created: check(), route_valid: check(), visible: check(), running: check(), recoverable: check(),
      lifecycle: Object.fromEntries(['read', 'resume', 'wake_idle', 'interrupt', 'survives_parent', 'callback_wake', 'ended', 'archived'].map(k => [k, check()])) };
    const dispatch = { id: input.dispatch, work_id: row.id, lane_ref: lane.id, scope_revision: row.scope_revision,
      manager_epoch: project.manager_binding.epoch, phase: 'intent', effect_refs: [], continuations: [] };
    state.selections.push(selection); state.lanes.push(lane); task.dispatches.push(dispatch); row.dispatch_id = dispatch.id;
  } else if (command === 'lane prepare') {
    requireReady('host.prepare'); const dispatch = current(task, row), lane = getLane(dispatch);
    const selection = state.selections.find(s => s.id === lane.selection_ref);
    const { id, ...original } = selection;
    if (digest(original) !== digest(input.selection) || dispatch.id !== input.dispatch || dispatch.phase !== 'intent' || dispatch.effect_refs.length) fail('INVARIANT_VIOLATION');
    addEffect('host.prepare', 'host-control', JSON.stringify({ mode: 'prepare-only', scope: task.scope }), dispatch);
  } else if (command === 'lane bind') {
    requireReady('host.prepare'); const dispatch = current(task, row), lane = getLane(dispatch);
    const selection = state.selections.find(s => s.id === lane.selection_ref), receipt = state.receipts.find(r => r.id === input.receipt);
    const { id, ...original } = selection;
    if (digest(original) !== digest(input.selection) || dispatch.phase !== 'prepared' || dispatch.id !== input.dispatch ||
        !receipt || receipt.event.kind !== 'context-created' || !dispatch.effect_refs.includes(receipt.effect_id) ||
        !lane.route || lane.created.value !== true || lane.route_valid.value !== true || lane.lifecycle.archived.value === true ||
        (selection.require_visible && lane.visible.value !== true) || (selection.require_recoverable && lane.recoverable.value !== true)) fail('CAPABILITY_UNAVAILABLE');
    dispatch.phase = 'bound'; row.write_owner = lane.route.opaque_id; evidence.push(receipt.id);
  } else if (command === 'validation receipt') {
    if (!completedValidation || digest(completedValidation) !== digest(input.receipt)) fail('VALIDATION_REQUIRED');
    validate(completedValidation, DEFINITIONS.ValidationReceipt);
    if (!completedValidation.terminated || !completedValidation.durable || completedValidation.exit !== 0 || completedValidation.result !== 'pass' ||
        completedValidation.schema_version !== VERSION.schema || completedValidation.scope_revision !== row.scope_revision ||
        state.validations.some(v => v.id === completedValidation.id)) fail('VALIDATION_REQUIRED');
    state.validations.push(completedValidation); evidence.push(completedValidation.id);
  } else if (command === 'dispatch start' || command === 'flow dispatch') {
    requireReady('host.start'); const dispatch = current(task, row), lane = getLane(dispatch);
    const selection = state.selections.find(s => s.id === lane.selection_ref), validation = state.validations.find(v => v.id === input.validation);
    if (dispatch.id !== input.dispatch || input.scope !== row.scope_revision || dispatch.phase !== 'bound' || !validation ||
        validation.scope_revision !== row.scope_revision || (selection.require_visible && lane.visible.value !== true) ||
        (selection.require_recoverable && lane.recoverable.value !== true)) fail('VALIDATION_REQUIRED');
    addEffect('host.start', lane.route.opaque_id, JSON.stringify({ mode: 'start', scope: task.scope }), dispatch);
    dispatch.phase = 'start-requested'; row.phase = 'executing';
    addObligation('start-proof', dispatch.id, 'start-confirmed');
  } else if (command === 'effect claim') {
    const effect = state.effects.find(e => e.id === input.effect), validation = state.validations.find(v => v.id === input.receipt_or_lookup);
    if (!effect || effect.state !== 'ready' || effect.claim || effect.run_epoch !== runEpoch) fail('FENCE_INVALID');
    if(effect.kind==='host.stop'){
      if(!task.obligations.some(o=>o.template==='stop-proof'&&o.lifecycle==='active'&&effect.prerequisites.includes(o.derivation_key)))fail('AUTH_DENIED');
    }else grantFor(effect.kind,effect.grant_refs);
    if (!validation || validation.scope_revision !== row.scope_revision || validation.candidate_digest !== effect.payload_digest ||
        !compareReadset(validation.readset, hostReadset(model, effect.id))) fail('VALIDATION_REQUIRED');
    effect.claim = { id: input.claim ?? newId(), runner: identity.actor, run_epoch: runEpoch,
      payload_digest: effect.payload_digest, claimed_at: at, validated_source_revision: request.expected_revision,
      validation_readset_digest: digest(validation.readset), claim_operation_id: operationId };
    effect.state = 'claimed';
    const attention=state.attention.find(a=>a.id===effect.success_gate);if(attention)attention.state='claimed';
    evidence.push(validation.id);
  } else if (command === 'effect refresh-fence') {
    const effect=state.effects.find(e=>e.id===input.effect), validation=state.validations.find(v=>v.id===input.receipt_or_lookup);
    if(!effect?.claim||effect.state!=='claimed'||effect.claim.runner!==identity.actor||effect.claim.id!==input.claim||effect.run_epoch!==runEpoch)fail('FENCE_INVALID');
    if(!validation||digest(validation.readset)!==effect.claim.validation_readset_digest||!compareReadset(validation.readset,hostReadset(model,effect.id)))fail('READSET_CHANGED');
    if(effect.kind!=='host.stop')grantFor(effect.kind,effect.grant_refs);
    effect.claim.fence_operation_id=operationId;effect.claim.fence_source_revision=request.expected_revision;evidence.push(validation.id);
  } else if (command === 'effect report' || command === 'effect reconcile') {
    const effect = state.effects.find(e => e.id === input.effect), receipt = hostEvidence?.receipt;
    if (!effect?.claim) fail('CAPABILITY_UNAVAILABLE');
    if (hostEvidence?.unknown === true || hostEvidence?.accepted === true) {
      if (effect.state !== 'claimed' || hostEvidence.effect_id !== effect.id || hostEvidence.claim_id !== effect.claim.id ||
          hostEvidence.payload_digest !== effect.payload_digest || hostEvidence.run_epoch !== effect.run_epoch) fail('FENCE_INVALID');
      effect.state = hostEvidence.unknown ? 'unknown' : 'accepted';
      const dispatch = task.dispatches.find(d => d.id === effect.dispatch_ref);
      if (dispatch && hostEvidence.unknown && ['host.start','host.resume','host.stop'].includes(effect.kind)) dispatch.phase = 'unknown';
      row.row_version++; row.updated_at = at;
      const audit=hostAudit(request,operationId,identity,row.id,hostEvidence.unknown?'effect-unknown':'effect-accepted',[],now);
      audit.operation_receipt.semantic_result=result(hostEvidence.unknown?'EFFECT_UNKNOWN':'EFFECT_PENDING',operationId,{operation_receipt:operationId,effects:[effect.id],steps:[{name:'host-effect',state:effect.state,facts:{local_intent_committed:true,running:'unknown',...(hostEvidence.accepted?{external_calls:1}:{})},evidence:[],assurance:'verified'}]});
      task.audit.push(audit);
      validateHostDomain(model); return model;
    }
    if (!receipt) fail('CAPABILITY_UNAVAILABLE');
    validate(receipt, DEFINITIONS.Receipt);
    if (!['claimed', 'accepted', 'unknown'].includes(effect.state) || receipt.effect_id !== effect.id ||
        receipt.claim_id !== effect.claim.id || receipt.run_epoch !== effect.run_epoch || receipt.manager_epoch !== effect.manager_epoch ||
        receipt.target !== effect.target || receipt.payload_digest !== effect.payload_digest || receipt.event.subject !== effect.id ||
        !Number.isFinite(Date.parse(receipt.occurred_at)) || Date.parse(receipt.occurred_at) > now || state.receipts.some(r => r.id === receipt.id)) fail('FENCE_INVALID');
    const expectedEvent = { 'host.prepare': 'context-created', 'host.start': 'turn-started', 'host.resume': 'turn-started',
      'host.message': 'message-delivered', 'host.stop': 'stopped', 'channel.send': 'channel-sent' }[effect.kind];
    if (receipt.event.kind !== expectedEvent) fail('INVALID_INPUT');
    state.receipts.push(receipt); effect.state = 'confirmed'; evidence.push(receipt.id);
    const dispatch = task.dispatches.find(d => d.id === effect.dispatch_ref);
    if (effect.kind === 'host.prepare') {
      const lane = getLane(dispatch);
      if (!receipt.result_route || receipt.result_route.provenance !== 'host-origin' || receipt.result_route.kind !== lane.form) fail('AUTH_DENIED');
      lane.route = receipt.result_route; lane.created = check(true, receipt.id, at); lane.route_valid = check(true, receipt.id, at);
      for (const name of ['visible', 'recoverable']) { validate(hostEvidence[name] ?? check(), DEFINITIONS.Check); lane[name] = hostEvidence[name] ?? check(); }
      dispatch.phase = 'prepared';
      if(row.control!=='enabled'&&!state.effects.some(e=>['host.start','host.resume'].includes(e.kind)&&e.claim))satisfy('stop-proof',receipt.id);
    } else if (effect.kind === 'host.start' || effect.kind === 'host.resume') {
      const lane = getLane(dispatch); if (!receipt.turn) fail('INVALID_INPUT');
      lane.running = check(Date.parse(receipt.occurred_at) + project.policy.response_window_seconds * 1000 >= now ? true : 'unknown', receipt.id, at); dispatch.phase = row.control==='enabled'?'start-confirmed':'stop-requested';
      satisfy('start-by', receipt.id); satisfy('start-proof', receipt.id);
      addObligation('runtime-evidence', dispatch.id, 'fresh-runtime-evidence', project.manager_binding.principal, Date.parse(receipt.occurred_at));
    } else if (effect.kind === 'host.stop') {
      const lane = getLane(dispatch); lane.running = check(false, receipt.id, at);
      lane.lifecycle.ended = check(true, receipt.id, at); dispatch.phase = 'stopped'; satisfy('stop-proof', receipt.id);satisfy('start-proof',receipt.id);satisfy('runtime-evidence',receipt.id);
    } else if (effect.kind === 'channel.send') {
      const attention = state.attention.find(a => a.id === effect.success_gate);
      if (attention&&attention.state!=='superseded') attention.state = 'sent';
    }
  } else if (command === 'observation accept') {
    const dispatch = current(task, row), lane = getLane(dispatch);
    if (!hostEvidence || digest(hostEvidence.observation) !== digest(input) || !lane.route || digest(input.route) !== digest(lane.route) ||
        !Number.isFinite(Date.parse(input.occurred_at)) || Date.parse(input.occurred_at) > now) fail('AUTH_DENIED');
    const starts = state.receipts.filter(r => r.turn && ['turn-started'].includes(r.event.kind));
    if (starts.at(-1)?.turn !== input.turn) fail('FENCE_INVALID');
    const previous = state.observations.filter(o => o.turn === input.turn).at(-1);
    if (previous && (Date.parse(input.occurred_at) < Date.parse(previous.occurred_at) ||
        (input.sequence !== undefined && previous.sequence !== undefined && input.sequence <= previous.sequence))) fail('FENCE_INVALID');
    const observation = { id: newId(), ...input }; state.observations.push(observation); evidence.push(observation.id);
    if (['ended', 'interrupted', 'stopped'].includes(input.event)) {
      lane.running = check(false, observation.id, input.occurred_at); lane.lifecycle.ended = check(true, observation.id, input.occurred_at);
      satisfy('runtime-evidence', observation.id);
      if(row.control!=='enabled')satisfy('stop-proof',observation.id);
      if (!row.candidate_id&&row.control==='enabled') addObligation('reconcile-execution', dispatch.id, 'valid-delivery-or-disposition');
    } else {
      if(previous&&['ended','interrupted','stopped'].includes(previous.event))fail('FENCE_INVALID');
      lane.running = check(Date.parse(input.occurred_at)+project.policy.response_window_seconds*1000>=now?true:'unknown', observation.id, input.occurred_at);
      for (const o of task.obligations) if (o.template === 'runtime-evidence' && o.lifecycle === 'active')
        o.due_at = eventTime(Date.parse(input.occurred_at) + project.policy.response_window_seconds * 1000);
    }
  } else if (command === 'delivery submit') {
    if (!candidateVerified || row.phase !== 'executing' || row.control !== 'enabled' || input.candidate.work_id !== row.id ||
        input.candidate.source_revision !== request.expected_revision || input.candidate.digest !== digest(input.candidate.manifest) ||
        !input.candidate.manifest.length || task.candidates.some(c => c.id === input.candidate.id)) fail('VALIDATION_REQUIRED');
    task.candidates.push(input.candidate); evidence.push(input.candidate.id); row.candidate_id = input.candidate.id; row.phase = 'reviewing';
    addObligation('review-response', input.candidate.id, 'manager-response'); addObligation('review-decision', input.candidate.id, 'manager-decision');
    satisfy('reconcile-execution', input.candidate.id);
  } else if (command === 'review submit') {
    const report = input.report, candidate = task.candidates.find(c => c.id === row.candidate_id);
    if (!candidate || report.candidate_digest !== candidate.digest || report.scope_revision !== row.scope_revision ||
        report.history_inherited || report.reviewer !== identity.actor || identity.actor === row.write_owner ||
        task.audit.some(a=>a.type==='delivery-submit'&&a.evidence.includes(candidate.id)&&a.actor===identity.actor) ||
        task.reports.some(r => r.id === report.id)) fail('AUTH_DENIED');
    task.reports.push(report); evidence.push(report.id);
  } else if (command === 'acceptance decide' || command === 'flow accept') {
    const candidate = task.candidates.find(c => c.id === row.candidate_id), reports = task.reports.filter(r => input.reports.includes(r.id));
    if (!candidate || candidate.id !== input.candidate || row.phase !== 'reviewing' || input.role !== 'local-manager' ||
        reports.length !== input.reports.length || !reports.length || digest([...input.criteria].sort()) !== digest([...task.scope.criteria].sort()) ||
        reports.some(r => r.candidate_digest !== candidate.digest || r.scope_revision !== row.scope_revision)) fail('INVARIANT_VIOLATION');
    const criteriaMissing = task.scope.criteria.some(criterion =>
      !reports.some(report => report.coverage.some(c => c.criterion === criterion && c.result === 'pass')) ||
      (task.scope.required_layers ?? []).some(layer => !reports.some(report =>
        report.coverage.some(c => c.criterion === criterion && c.layer === layer && c.result === 'pass'))));
    if (input.decision === 'pass' && (reports.some(report => report.open_issues.length) || criteriaMissing)) fail('VALIDATION_REQUIRED');
    const decision = { id: newId(), candidate_digest: candidate.digest, scope_revision: row.scope_revision, role: input.role,
      manager: identity.actor, manager_epoch: identity.manager_epoch, result: input.decision, report_refs: input.reports,
      criterion_refs: input.criteria, reason: 'Explicit authenticated manager decision', handoff_refs: [] };
    task.decisions.push(decision); row.decision_id = decision.id; evidence.push(decision.id);
    satisfy('review-response', decision.id, candidate.id); satisfy('review-decision', decision.id, candidate.id);
    if (input.decision === 'pass') { row.phase = 'accepted'; addObligation('close-or-explain', decision.id, 'closed'); }
    else if (input.decision === 'return') row.phase = 'executing';
    else task.blockers.push({ id: newId(), resolver: identity.actor, predicate: 'manager-resolution', next_due: eventTime(now + project.policy.response_window_seconds * 1000) });
  } else if (command === 'work close') {
    const decision = task.decisions.find(d => d.id === row.decision_id), dispatch = current(task, row);
    if (row.phase !== 'accepted' || row.control !== 'enabled' || task.blockers.length || !decision || decision.result !== 'pass' ||
        input.decision_or_reason !== decision.id || input.batch || row.batch_id ||
        state.effects.some(e => ['ready', 'claimed', 'accepted', 'unknown'].includes(e.state) && e.blocking_class !== 'passive') ||
        task.obligations.some(o => ['active', 'waiting'].includes(o.lifecycle) && o.template !== 'close-or-explain')) fail('INVARIANT_VIOLATION');
    if (dispatch && getLane(dispatch).running.value === true) fail('FENCE_INVALID');
    row.phase = 'closed'; satisfy('close-or-explain', operationId);
    for (const c of task.commitments) if (c.state === 'live') c.state = 'fulfilled';
  } else if(command==='attention channel-dispose'){
    const attention=state.attention.find(a=>a.id===input.subject);
    if(!attention||attention.role!=='owner'||identity.role!=='owner'||attention.target!==identity.thread_id||project.owner_channel?.principal!==identity.actor||!input.reason.trim())fail('AUTH_DENIED');
    if(input.until)fail('CAPABILITY_UNAVAILABLE');
    attention.channel_disposition=input.reason;attention.responded_at=at;attention.response_evidence=input.counterevidence;
  } else if (command === 'attention consume' || command === 'attention respond') {
    const attention = state.attention.find(a => a.id === input.subject);
    if (!attention || identity.role !== (attention.role??'manager') || (identity.role==='owner'&&project.owner_channel?.principal!==identity.actor) || attention.target !== identity.thread_id ||
        attention.manager_epoch !== identity.manager_epoch || input.turn !== identity.turn_id || input.payload_digest !== attention.payload_digest)
      fail('AUTH_DENIED');
    if (command === 'attention consume') {
      if (!attention.consumed_at) { attention.consumed_at = at; attention.consumed_turn = identity.turn_id; attention.response_due=eventTime(now+project.policy.response_window_seconds*1000); }
    } else {
      if(identity.role!=='manager')fail('AUTH_DENIED');
      if (!attention.consumed_at) fail('INVARIANT_VIOLATION');
      const audit = [...project.project_audit, ...model.tasks.flatMap(t => t.audit)];
      const known = input.commands.length && input.commands.every(id => audit.some(a => a.operation_receipt?.operation_id === id &&
        a.subject===row.id && a.actor===identity.actor && Date.parse(a.at)>=Date.parse(attention.consumed_at) &&
        ['acceptance-decide','work-block','work-wait','work-close'].includes(a.type)));
      const checkpoint = input.next_due && Date.parse(input.next_due) > now && Date.parse(input.next_due) <= now + project.policy.response_window_seconds * 1000;
      if (!known && !checkpoint) fail('INVARIANT_VIOLATION');
      attention.responded_at = at; attention.response_evidence = input.evidence;
      if (checkpoint) attention.next_due = input.next_due;
      const root=task.obligations.find(o=>o.id===attention.obligation_id);
      if(root&&['review-response','review-decision'].includes(root.template))satisfy('review-response',operationId,root.derivation_key);
    }
  } else fail('CAPABILITY_UNAVAILABLE');
  row.row_version++; row.updated_at = at;
  task.audit.push(hostAudit(request, operationId, identity, row.id, command.replaceAll(' ', '-'), evidence, now));
  if(['effect claim','effect refresh-fence'].includes(command)){
    const effect=state.effects.find(e=>e.id===input.effect), oldTask=beforeModel.tasks.find(t=>t.work_id===task.work_id), oldRow=beforeModel.rows.find(r=>r.id===row.id);
    const oldEffect=oldTask.execution.effects.find(e=>e.id===effect.id), validation=state.validations.find(v=>v.id===input.receipt_or_lookup);
    const writes=[{object:effect.id,field:'effect.claim',before:oldEffect.claim?digest(oldEffect.claim):null,after:digest(effect.claim)},
      {object:effect.id,field:'effect.state',before:digest(oldEffect.state),after:digest(effect.state)},
      {object:row.id,field:'task.audit',before:digest(oldTask.audit),after:digest(task.audit)},
      {object:row.id,field:'csv.row_version',before:digest(oldRow.row_version),after:digest(row.row_version)},
      {object:row.id,field:'csv.updated_at',before:digest(oldRow.updated_at),after:digest(row.updated_at)}];
    const attention=state.attention.find(a=>a.id===effect.success_gate),oldAttention=oldTask.execution.attention.find(a=>a.id===effect.success_gate);
    if(attention)writes.push({object:attention.id,field:'task.attention.state',before:digest(oldAttention.state),after:digest(attention.state)});
    const proof={validation_ref:validation.id,pre_revision:request.expected_revision,operation_id:operationId,
      exact_write_manifest:writes,unchanged_readset_digest:digest(validation.readset)};
    verifySelfTransition(command,proof,validation.readset,hostReadset(model,effect.id),writes);
    state.self_transitions.push(proof);
  }
  const newEffects=state.effects.filter(e=>!beforeModel.tasks.find(t=>t.work_id===task.work_id).execution.effects.some(old=>old.id===e.id));
  if(newEffects.length)task.audit.at(-1).operation_receipt.semantic_result=result('EFFECT_PENDING',operationId,{operation_receipt:operationId,effects:newEffects.map(e=>e.id),steps:[{name:'host-intent',state:'published',facts:{local_intent_committed:true,external_calls:0},evidence:[],assurance:'verified'}]});
  // Root satisfaction suppresses only unclaimed reminders; in-flight receipts remain.
  for (const attention of state.attention) {
    const obligation = task.obligations.find(o => o.id === attention.obligation_id);
    if(obligation&&['satisfied','cancelled'].includes(obligation.lifecycle)&&['claimed','sent','unknown'].includes(attention.state))attention.state='superseded';
    if (obligation && ['satisfied', 'cancelled'].includes(obligation.lifecycle) && attention.state === 'ready') {
      attention.state = 'suppressed';
      for (const effect of state.effects) if (effect.id === attention.effect_ref && effect.state === 'ready') effect.state = 'suppressed';
    }
  }
  validateHostDomain(model); return model;
}
