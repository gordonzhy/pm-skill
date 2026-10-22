// Versioned, executable contract primitives. No project or host I/O belongs here.
export const VERSION = Object.freeze({ protocol: 'project-files/1', schema: '1.3.0', engine: '0.4.0' });
export const EMPTY_PROJECT_REVISION='sha256:764cd0fd7719272c581aa01a2e869581198380536ae9ecd729818adb9af761f6';
export const str = { type: 'string', minLength: 1, maxLength: 8192 };
export const id = { ...str, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$' };
export const hash = { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' };
export const integer = { type: 'integer', minimum: 0 };
export const bool = { type: 'boolean' };
export const en = (...values) => ({ type: 'string', enum: values });
export const arr = items => ({ type: 'array', items, maxItems: 4096, uniqueItems: true });
export const obj = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
export const nullable = schema => ({ anyOf: [schema, { type: 'null' }] });
export const ref = name => ({ $ref: `#/$defs/${name}` });
export const path = { ...str, format: 'managed-path' };
export const PHASE = en('proposed', 'planned', 'executing', 'reviewing', 'accepted', 'closed', 'cancelled');
export const CONTROL = en('enabled', 'paused', 'revoked');
export const ROLE = en('owner', 'manager', 'executor', 'reviewer', 'host-bridge', 'monitor', 'effect-runner', 'reader');
export const LAYER = en('spec-review', 'synthetic', 'isolated-cli', 'host', 'browser', 'installation', 'manager-decision', 'user-acceptance');
export const DEFINITIONS = {
  Ref: id, Hash: hash,
  ManagerBinding: obj({principal:id,route:ref('Route'),epoch:id,proof:id},['principal','epoch','proof']),
  Policy: obj({id,version:id,response_window_seconds:integer,owner_escalation_limit:{type:'integer',minimum:0,maximum:1},clock_source:id}),
  ProjectText: obj({schema_major:{const:'1'},project_id:id,project_name:str,manager_binding:ref('ManagerBinding'),policy:ref('Policy'),project_grants:arr(ref('Grant')),handoffs:arr(id),batches:arr(id),project_obligations:arr(ref('Obligation')),project_audit:arr(ref('AuditEntry'))}),
  Route: obj({ host: id, instance: id, opaque_id: id, kind: id, provenance: id }),
  Check: obj({ value: { enum: [true, false, 'unknown'] }, source: id, checked_at: str }, ['value']),
  Scope: obj({ goal: str, allowed_writes: arr(path), exclusions: arr(str), criteria: arr(id) }),
  Grant: obj({ id, project_id: id, work_ids: arr(id), scope_revision: integer, issuer: id, actions: arr(id), write_roots: arr(path), protected_actions: arr(id), evidence_ref: id, issued_at: str, expires_at: str, revoked_at: str }, ['id','project_id','work_ids','scope_revision','issuer','actions','write_roots','protected_actions','evidence_ref','issued_at']),
  Commitment: obj({ id, work_id: id, scope_revision: integer, responsible: id, grant_refs: arr(id), policy_ref: id, state: en('live','withdrawn','fulfilled'), origin_event: id }),
  Obligation: obj({ id, template: en('start-by','condition-followup','scope-followup','request-intake','scope-response','provider-start','start-proof','runtime-evidence','reconcile-execution','review-response','review-decision','close-or-explain','stop-proof'), template_version: id, derivation_key: id, work_or_handoff_ref: id, scope_revision: integer, responsible: id, activation_predicate: id, satisfaction_predicate: id, activated_at: str, due_at: str, policy_ref: id, obligation_revision: { type:'integer',minimum:1 }, lifecycle: en('waiting','active','satisfied','cancelled'), basis_refs: arr(id), next: id, satisfied_by: id, cancelled_by: id }, ['id','template','template_version','derivation_key','work_or_handoff_ref','scope_revision','responsible','activation_predicate','satisfaction_predicate','policy_ref','obligation_revision','lifecycle','basis_refs','next']),
  ManifestEntry: obj({ path, digest: hash, size: integer }),
  Candidate: obj({ id, work_id: id, manifest: arr(ref('ManifestEntry')), digest: hash, source_revision: hash, limitations: arr(str) }),
  Report: obj({ id, candidate_digest: hash, scope_revision: integer, reviewer: id, history_inherited: bool, access_mode: en('enforced','prompt-only'), actual_inputs: arr(id), coverage: arr(obj({criterion:id,layer:LAYER,result:en('pass','fail','not-run','unknown'),evidence:arr(id)})), open_issues: arr(str) }),
  Decision: obj({ id, candidate_digest: hash, scope_revision: integer, role: en('local-manager','provider-delivery','requester-use'), manager: id, manager_epoch: id, result: en('pass','return','blocked'), report_refs: arr(id), criterion_refs: arr(id), reason: str, handoff_refs: arr(id) }),
  Readset: obj({ fields: arr(obj({ object: id, field: id, digest: hash })), references: arr(obj({ reference: id, exists: bool })), discoveries: arr(obj({ collection: id, digest: hash })) }),
  Write: obj({ object: id, field: id, before: nullable(hash), after: nullable(hash) }),
  SelfTransitionProof: obj({ validation_ref: id, pre_revision: hash, operation_id: id, exact_write_manifest: arr(ref('Write')), unchanged_readset_digest: hash }),
  ValidationReceipt: obj({ id, validator_version: id, schema_version: {const:VERSION.schema}, scope_revision: integer, candidate_digest: hash, terminated: bool, exit: integer, result: en('pass','fail'), durable: bool, source_revision: hash, readset: ref('Readset') }),
  Dispatch: obj({id,work_id:id,lane_ref:id,scope_revision:integer,manager_epoch:id,phase:en('intent','prepared','bound','start-requested','start-confirmed','unknown','stop-requested','stopped'),effect_refs:arr(id),continuations:arr(id)}),
  Effect: obj({id,project_id:id,work_id:id,dispatch_ref:id,continuation_id:id,run_epoch:id,kind:en('host.prepare','host.start','host.resume','host.message','host.stop','channel.send','artifact.write'),target:id,payload_ref:id,payload_digest:hash,grant_refs:arr(id),manager_epoch:id,state:en('ready','claimed','accepted','confirmed','unknown','suppressed','failed'),claim:ref('Claim'),prerequisites:arr(id),success_gate:id,blocking_class:en('mutating-host','control-handoff','passive')},['id','project_id','run_epoch','kind','target','payload_ref','payload_digest','grant_refs','manager_epoch','state','prerequisites','blocking_class']),
  Claim: obj({id,runner:id,run_epoch:id,payload_digest:hash,claimed_at:str,validated_source_revision:hash,validation_readset_digest:hash,claim_operation_id:id,fence_operation_id:id,fence_source_revision:hash},['id','runner','run_epoch','payload_digest','claimed_at','validated_source_revision','validation_readset_digest','claim_operation_id']),
  Receipt: obj({id,effect_id:id,claim_id:id,run_epoch:id,manager_epoch:id,target:id,result_route:ref('Route'),payload_digest:hash,event:ref('Event'),occurred_at:str,sequence:integer,turn:id,issuer:id,proof:id,raw_result_ref:id},['id','effect_id','claim_id','run_epoch','manager_epoch','target','payload_digest','event','occurred_at','issuer','proof','raw_result_ref']),
  Lane: obj({id,form:en('independent-task-thread','internal-agent','independent-review-context'),route:ref('Route'),selection_ref:id,created:ref('Check'),route_valid:ref('Check'),visible:ref('Check'),running:ref('Check'),recoverable:ref('Check'),lifecycle:obj(Object.fromEntries(['read','resume','wake_idle','interrupt','survives_parent','callback_wake','ended','archived'].map(k=>[k,ref('Check')])))},['id','form','selection_ref','created','route_valid','visible','running','recoverable','lifecycle']),
  Event: obj({id,subject:id,kind:en('context-created','turn-started','message-delivered','stopped','channel-sent','artifact-written'),occurred_at:str,issuer:id,proof:id,raw_result_ref:id}),
  QueryResult: obj({project_id:id,schema_major:{const:'1'},source_revision:nullable(hash),generation:nullable(integer),snapshot:nullable(id),protection_seq:integer,stale:bool,recovery_required:bool,data:{anyOf:[obj({projection:{const:'summary'},object_refs:arr(id)}),obj({projection:{const:'private-local'},runtime:obj({checkout_origin:en('initialized','adopted'),execution_activation_required:bool}),model:ref('Domain'),effective_protection_overlay:arr(ref('ProtectionOverlay')),case:ref('CaseProjection'),operation:ref('OperationReceiptView'),pending_operation:ref('Result'),monitor:ref('MonitorView')},['projection','model','effective_protection_overlay'])]},warnings:arr(en('STALE_SNAPSHOT','RECOVERY_REQUIRED','CAPABILITY_UNAVAILABLE'))}),
  TaskCSVRow: obj({ id, row_version: {type:'integer',minimum:1}, phase: PHASE, control: CONTROL, scope_revision: integer, title: str, detail_path: path, dependencies: arr(id), commitment_id: nullable(id), dispatch_id: nullable(id), candidate_id: nullable(id), decision_id: nullable(id), batch_id: nullable(id), write_owner: id, updated_at: str }),
  AuditEntry: obj({event_id:id,at:str,actor:id,type:id,subject:id,payload:arr(obj({field:id,value:str})),evidence:arr(id),corrects:id,operation_receipt:ref('OperationReceipt')}, ['event_id','at','actor','type','subject','payload','evidence']),
  OperationReceipt: obj({operation_id:id,idempotency_key:id,input_digest:hash,semantic_result:ref('Result')}),
  OperationReceiptView: obj({operation_id:id,idempotency_key:id,input_digest:hash,semantic_result:ref('Result'),recorded_result:ref('Result'),resolutions:arr(obj({operation_id:id,case_id:id,disposition:en('superseded','completed-by-resolution')}))},['operation_id','idempotency_key','input_digest','semantic_result']),
  TaskText: obj({schema_major:{const:'1'},project_id:id,work_id:id,scope:ref('Scope'),grant_refs:arr(id),blockers:arr(obj({id,resolver:id,predicate:id,next_due:str})),commitments:arr(ref('Commitment')),dispatches:arr(ref('Dispatch')),candidates:arr(ref('Candidate')),reports:arr(ref('Report')),decisions:arr(ref('Decision')),obligations:arr(ref('Obligation')),audit:arr(ref('AuditEntry'))}),
  Result: obj({command_id:id,outcome:en('committed','no-change','awaiting-effect','unknown','rejected','recovery-pending'),code:id,exit:integer,source_revision:nullable(hash),generation:nullable(integer),run_epoch:nullable(id),operation_receipt:nullable(id),steps:arr(ref('Step')),effects:arr(id),obligations:arr(id),next:arr(ref('Next'))}),
  Step: obj({name:id,state:id,facts:obj({local_intent_committed:bool,running:{enum:[true,false,'unknown']},retry_same_key:bool,external_calls:integer,protection_accepted:bool,business_commit_pending:bool,blocking_code:ref('Code'),effective_control:CONTROL,protection_seq:integer,project_id:id,policy_ref:id,resolution_ref:id,case_ref:id},[]),evidence:arr(id),assurance:en('verified','owner-attested','self-reported','unknown')}),
  Next: obj({action:str,subject:id,reason:id,needs_decision:bool,input_schema:id}),
};
DEFINITIONS.MonitorView=obj({snapshot:id,generation:integer,evaluated_at:str,clock_assurance:{const:'owner-attested'},waiting:integer,active:integer,satisfied:integer,cancelled:integer,roots:arr(obj({alert_key:hash,obligation_id:id,obligation_revision:{type:'integer',minimum:1},violation_kind:id,responsible:id,due_at:str,delivery:{const:'not-evaluated'},consumption:{const:'not-evaluated'},response:{const:'not-evaluated'}})),background_enabled:{const:false},effects_performed:{const:0}});
DEFINITIONS.Selection=obj({id,requested_form:en('independent-task-thread','internal-agent','independent-review-context'),selected_form:en('independent-task-thread','internal-agent','independent-review-context'),capabilities_ref:id,authorization:id,require_visible:bool,require_recoverable:bool,degradation_ack:id,reason:str},['id','requested_form','selected_form','capabilities_ref','authorization','require_visible','require_recoverable','reason']);
DEFINITIONS.HostPayload=obj({id,kind:en('host.prepare','host.start','host.resume','host.message','host.stop','channel.send'),body:str});
DEFINITIONS.Attention=obj({id,alert_key:hash,obligation_id:id,obligation_revision:{type:'integer',minimum:1},manager_epoch:id,target:id,created_at:str,payload_digest:hash,state:en('ready','claimed','sent','unknown','suppressed','superseded'),effect_ref:id,role:en('manager','owner'),tier:{type:'integer',minimum:0,maximum:2},deliver_due:str,consume_due:str,response_due:str,escalation_state:en('waiting','unavailable','issued','exhausted'),channel_disposition:str,consumed_at:str,consumed_turn:id,responded_at:str,response_evidence:arr(id),next_due:str},['id','alert_key','obligation_id','obligation_revision','manager_epoch','target','payload_digest','state']);
DEFINITIONS.Observation=obj({id,route:ref('Route'),turn:id,event:en('turn-started','running','ended','interrupted','stopped'),source:id,occurred_at:str,sequence:integer},['id','route','turn','event','source','occurred_at']);
DEFINITIONS.ProjectText.properties.owner_channel=ref('ManagerBinding');
DEFINITIONS.HostState=obj({lanes:arr(ref('Lane')),selections:arr(ref('Selection')),effects:arr(ref('Effect')),payloads:arr(ref('HostPayload')),validations:arr(ref('ValidationReceipt')),self_transitions:arr(ref('SelfTransitionProof')),receipts:arr(ref('Receipt')),attention:arr(ref('Attention')),observations:arr(ref('Observation'))});
DEFINITIONS.TaskText.properties.execution=ref('HostState');
DEFINITIONS.Scope.properties.required_layers=arr(LAYER);
DEFINITIONS.Domain=obj({project:ref('ProjectText'),rows:arr(ref('TaskCSVRow')),tasks:arr(ref('TaskText'))});
DEFINITIONS.ProtectionOverlay=obj({seq:integer,command:str,work:nullable(id),work_ids:arr(id),grant_ref:nullable(id),merged:bool,deny:{const:true}});
DEFINITIONS.CaseProjection=obj({id,case_digest:hash,reason:id,current:bool,current_revision:hash,transactions:arr(id),allowed_decisions:arr(en('retain-validated-current','complete-recorded-intent','adopt-authorized-structured-change')),affected_paths:arr(obj({path:str,before:nullable(hash),after:nullable(hash),current:nullable(hash)})),work_id:id,title_values:arr(str),stage_digests:arr(hash)},['id','case_digest','reason','current','current_revision','transactions','allowed_decisions','affected_paths']);
// Local worker handoffs are distinct from cross-project handoffs.
DEFINITIONS.WorkerCommitment = obj({id,lineage:id,revision:integer,absolute_due:str,first_due:str,next_due:str,extension_count:integer,extension_limit:{type:'integer',minimum:0,maximum:2},owner:nullable(id),owner_due:str,owner_state:en('waiting','issued','exhausted','unavailable'),escalations:{type:'integer',minimum:0,maximum:1},status:en('open','resolved','paused'),resolved_by:nullable(id),last_evidence:nullable(hash)});
DEFINITIONS.WorkerEnvelope = obj({version:{const:1},event_id:id,dispatch:id,epoch:id,sequence:integer,kind:en('stage','decision-needed','blocked','final'),phase:str,commitments:arr(id),candidate:hash,evidence:arr(obj({path, digest:hash})),next:str,can_continue:bool,published_at:str,supersedes:nullable(hash)});
DEFINITIONS.WorkerEvent = obj({digest:hash,envelope:ref('WorkerEnvelope'),seen_at:nullable(str),seen_epoch:nullable(id),prior_receipts:nullable(arr(id)),dispositions:arr(obj({commitment:id,operation:id,kind:en('scheduled','action','paused'),at:str}))});
DEFINITIONS.WorkerObservation = obj({route:id,turn:id,state:en('active','waiting','idle','ended','unknown'),source:id,source_event_at:str,collected_at:str,ttl_seconds:{type:'integer',minimum:1,maximum:60},assurance:en('host-origin','owner-attested')});
DEFINITIONS.WorkerDispatch = obj({id,work:id,scope_revision:integer,epoch:id,manager:id,worker:id,route:id,turn:id,spool:str,evidence_root:str,commitments:arr(ref('WorkerCommitment')),events:arr(ref('WorkerEvent')),notifications:arr(obj({key:id,role:en('manager','owner'),commitment:nullable(id),state:en('claimed','accepted','rejected','unknown'),at:str})),observation:nullable(ref('WorkerObservation')),registered_at:str,clock_at:str,clock_uncertain:bool,scan_errors:arr(id),paused:bool,mode:en('native','legacy-compat'),pending:arr(obj({id,event:hash,commitment:id,before:hash,after:hash,log_path:path,log_digest:hash,context:hash,before_status:str,operation:nullable(id),state:en('pending','finalized')}))});
DEFINITIONS.WorkerClaim = obj({sampled_at:str,business_phase:str,runtime:en('active','waiting','idle','ended','unknown'),running:bool,source:nullable(id),source_event_at:nullable(str),collected_at:nullable(str),route:id,turn:id,assurance:en('host-origin','owner-attested','unknown'),unread:integer,coverage:en('native','legacy-compat'),automatic_wake:{const:false},responsibilities:arr(obj({id,status:en('open','resolved','paused'),due:bool,next_due:str,absolute_due:str,extension_count:integer,owner_state:en('waiting','issued','exhausted','unavailable'),escalations:integer})),reconcile_failed:bool,attention:arr(ref('Attention'))});
DEFINITIONS.QueryResult.properties.data.anyOf[1].properties.worker_view=obj({claim:ref('WorkerClaim'),dispatch:ref('WorkerDispatch')},[]);
DEFINITIONS.WorkerControl = obj({version:{const:1},dispatches:arr(ref('WorkerDispatch'))});
DEFINITIONS.ProjectText.properties.worker_control=ref('WorkerControl');

export const FIELD_OWNERSHIP = Object.freeze({
  csv: Object.keys(DEFINITIONS.TaskCSVRow.properties),
  task: Object.keys(DEFINITIONS.TaskText.properties),
  identity_only: ['project_id','work_id'],
  derived: ['source_revision','generation','run_epoch','post_claim_revision'],
  project: ['schema_major','project_id','project_name','manager_binding','owner_channel','policy','project_grants','handoffs','batches','project_obligations','project_audit','worker_control'],
});
export const ERRORS = Object.freeze(Object.fromEntries([
  [0,'committed','OK'],[0,'no-change','NO_CHANGE IDEMPOTENT_REPLAY'],[10,'awaiting-effect','EFFECT_PENDING'],
  [11,'unknown','EFFECT_UNKNOWN STOP_UNKNOWN DELIVERY_HISTORY_UNKNOWN'],[12,'recovery-pending','RECOVERY_PENDING IO_PENDING PROTECTION_PENDING'],
  [20,'rejected','INVALID_INPUT SCHEMA_UNSUPPORTED INVARIANT_VIOLATION PATH_UNSAFE'],
  [21,'rejected','VERSION_CONFLICT IDEMPOTENCY_CONFLICT CASE_CHANGED'],[22,'rejected','AUTH_REQUIRED AUTH_DENIED ROLE_STALE GRANT_MISSING'],
  [23,'rejected','EFFECT_FAILED PROTECTED FENCE_INVALID READSET_CHANGED VALIDATION_REQUIRED CLOCK_UNCERTAIN'],
  [24,'rejected','RECOVERY_REQUIRED RECOVERY_CONFLICT JOURNAL_CORRUPT GIT_CONFLICT RESOLUTION_INPUT_REQUIRED'],
  [25,'rejected','PLATFORM_UNSUPPORTED CAPABILITY_UNAVAILABLE UNSUPPORTED_RESOLUTION_STATE LOCK_UNAVAILABLE'],
  [26,'rejected','IO_PREPARE_FAILED PROTECTION_NOT_DURABLE'],[70,'rejected','INTERNAL_ERROR'],
].flatMap(([exit,outcome,codes]) => codes.split(' ').map(code => [code,{exit,outcome}]))));
DEFINITIONS.Code = en(...Object.keys(ERRORS));
DEFINITIONS.Result.properties.code = ref('Code');
DEFINITIONS.Next.properties.reason = ref('Code');
// Generate code/outcome/exit coupling in the exported schema from the same table.
const resultShape=DEFINITIONS.Result;
DEFINITIONS.Result={anyOf:Object.entries(ERRORS).map(([code,spec])=>obj({...resultShape.properties,code:{const:code},outcome:{const:spec.outcome},exit:{const:spec.exit}},resultShape.required))};
export class ContractError extends Error {
  constructor(code) { super(code); this.code = Object.hasOwn(ERRORS,code) ? code : 'INTERNAL_ERROR'; }
}
export const fail = code => { throw new ContractError(code); };

// JSON Schema subset used by this registry; unknown schema keywords never arrive from callers.
export function validate(value, schema) {
  if (schema.$ref) return validate(value, DEFINITIONS[schema.$ref.split('/').at(-1)]);
  if (schema.anyOf) { if (!schema.anyOf.some(s => {try {validate(value,s);return true;} catch {return false;}})) fail('INVALID_INPUT'); return; }
  if (schema.const !== undefined && value !== schema.const) fail('SCHEMA_UNSUPPORTED');
  if (schema.enum && !schema.enum.includes(value)) fail('INVALID_INPUT');
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (schema.type && !(Array.isArray(schema.type)?schema.type:[schema.type]).some(t=> t === type || (t==='integer' && Number.isSafeInteger(value)))) fail('INVALID_INPUT');
  if (typeof value==='number' && (!Number.isSafeInteger(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) fail('INVALID_INPUT');
  if (typeof value==='string') {
    if(value.length < (schema.minLength??0) || value.length > (schema.maxLength??8192) || (schema.pattern && !new RegExp(schema.pattern).test(value))) fail('INVALID_INPUT');
    if(schema.format==='managed-path' && (value.startsWith('/') || value.includes('\\') || value.split('/').some(p=>!p||p==='.'||p==='..') || /[:\x00-\x1f]/.test(value))) fail('PATH_UNSAFE');
  }
  if (type==='object') {
    if(Object.getPrototypeOf(value)!==Object.prototype && Object.getPrototypeOf(value)!==null) fail('INVALID_INPUT');
    for(const key of schema.required??[]) if(!Object.hasOwn(value,key)) fail('INVALID_INPUT');
    for(const key of Object.keys(value)) { if(!Object.hasOwn(schema.properties??{},key)) fail('INVALID_INPUT'); validate(value[key],schema.properties[key]); }
  }
  if(type==='array') {
    if(value.length>(schema.maxItems??4096)) fail('INVALID_INPUT');
    if(schema.uniqueItems && new Set(value.map(v=>JSON.stringify(v))).size!==value.length) fail('INVALID_INPUT');
    for(const item of value) validate(item,schema.items);
  }
}
