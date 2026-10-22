import { createHash } from 'node:crypto';
import { VERSION, ERRORS, DEFINITIONS, validate, fail, ContractError } from './contracts.mjs';
import { REGISTRY, findCommand, inputSchema } from './registry.mjs';

export const canonical = value => {
  if(value === null || typeof value !== 'object') return JSON.stringify(value);
  if(Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
};
export const digest = value => `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;

// Reject duplicate keys (including escaped spellings) before JSON.parse can erase them.
export function parseJSON(text,{maxBytes=1048576}={}) {
  if(typeof text!=='string' || Buffer.byteLength(text)>maxBytes) fail('INVALID_INPUT');
  let i=0;
  const ws=()=>{while(/\s/.test(text[i]??'') && i<text.length)i++;};
  function string() { const start=i++; while(i<text.length) { if(text[i]==='\\') {i+=2;continue;} if(text[i++]==='"') return JSON.parse(text.slice(start,i)); } fail('INVALID_INPUT'); }
  function value(depth=0) {
    if(depth>64) fail('INVALID_INPUT'); ws();
    if(text[i]==='"') {string();return;}
    if(text[i]==='{') { i++;ws();const keys=new Set();if(text[i]==='}') {i++;return;}
      while(i<text.length) {ws();if(text[i]!=='"')fail('INVALID_INPUT');const key=string();if(keys.has(key)||['__proto__','constructor','prototype'].includes(key))fail('INVALID_INPUT');keys.add(key);ws();if(text[i++]!==':')fail('INVALID_INPUT');value(depth+1);ws();const end=text[i++];if(end==='}')return;if(end!==',')fail('INVALID_INPUT'); } fail('INVALID_INPUT'); }
    if(text[i]==='[') {i++;ws();if(text[i]===']'){i++;return;}while(i<text.length){value(depth+1);ws();const end=text[i++];if(end===']')return;if(end!==',')fail('INVALID_INPUT');}fail('INVALID_INPUT');}
    const token=text.slice(i).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/);if(!token)fail('INVALID_INPUT');i+=token[0].length;
  }
  try {value();ws();if(i!==text.length)fail('INVALID_INPUT');return JSON.parse(text);} catch {fail('INVALID_INPUT');}
}
export function validateRequest(request) {
  if(!request || request.protocol!==VERSION.protocol) fail('SCHEMA_UNSUPPORTED');
  const record=findCommand(request.command??request.query);
  if(!record) fail('INVALID_INPUT');
  validate(request,inputSchema(record));
  if(request.input.deps?.includes(request.input.work)) fail('INVARIANT_VIOLATION');
  if(request.input.candidate && typeof request.input.candidate==='object' && request.input.candidate.work_id!==request.input.work) fail('INVARIANT_VIOLATION');
  if(request.input.items?.some(item=>item.status==='accepted'&&!item.grant_refs.length)) fail('GRANT_MISSING');
  if(request.input.report?.history_inherited) fail('INVARIANT_VIOLATION');
  if(request.input.receipt && typeof request.input.receipt==='object' && (!request.input.receipt.terminated || !request.input.receipt.durable || request.input.receipt.exit!==0 || request.input.receipt.result!=='pass')) fail('VALIDATION_REQUIRED');
  if(request.input.receipt?.readset) validateReadset(request.input.receipt.readset);
  return record;
}
// Contract validation only: callers obtain the source through the consistent reader.
// No timestamp, revision, proof, role or filesystem claim is verified by this function.
export function validateDomain(model) {
  validate(model,{type:'object',properties:{project:{$ref:'#/$defs/ProjectText'},rows:{type:'array',items:DEFINITIONS.TaskCSVRow},tasks:{type:'array',items:DEFINITIONS.TaskText}},required:['project','rows','tasks'],additionalProperties:false});
  const {project,rows,tasks}=model;
  validate(project,DEFINITIONS.ProjectText);
  validate(rows,{type:'array',items:DEFINITIONS.TaskCSVRow});
  validate(tasks,{type:'array',items:DEFINITIONS.TaskText});
  const byId=new Map(rows.map(row=>[row.id,row]));
  const texts=new Map(tasks.map(task=>[task.work_id,task]));
  if(byId.size!==rows.length||texts.size!==tasks.length||rows.length!==tasks.length)fail('INVARIANT_VIOLATION');
  const seenObjects=new Set();
  const register=object=>{if(seenObjects.has(object.id))fail('INVARIANT_VIOLATION');seenObjects.add(object.id);};
  project.project_grants.forEach(register);
  project.project_obligations.forEach(register);
  for(const grant of project.project_grants)if(grant.project_id!==project.project_id)fail('INVARIANT_VIOLATION');
  rows.forEach(register);
  for(const row of rows) {
    const task=texts.get(row.id);
    if(!task||task.project_id!==project.project_id||row.detail_path!==`work-items/${row.id}.yaml`)fail('INVARIANT_VIOLATION');
    for(const dep of row.dependencies)if(dep===row.id||!byId.has(dep))fail('INVARIANT_VIOLATION');
    for(const key of ['commitments','dispatches','candidates','reports','decisions','obligations'])task[key].forEach(register);
    if(task.execution){
      for(const key of ['lanes','selections','effects','payloads','validations','receipts','attention','observations'])task.execution[key].forEach(register);
      for(const effect of task.execution.effects)if(effect.project_id!==project.project_id||(effect.work_id&&effect.work_id!==row.id))fail('INVARIANT_VIOLATION');
      for(const dispatch of task.dispatches)if(!task.execution.lanes.some(l=>l.id===dispatch.lane_ref)||dispatch.effect_refs.some(id=>!task.execution.effects.some(e=>e.id===id)))fail('INVARIANT_VIOLATION');
      for(const lane of task.execution.lanes)if(!task.execution.selections.some(s=>s.id===lane.selection_ref))fail('INVARIANT_VIOLATION');
    }
    for(const key of ['commitments','dispatches','candidates'])for(const object of task[key])if(object.work_id!==row.id)fail('INVARIANT_VIOLATION');
    for(const [field,collection] of [['commitment_id','commitments'],['dispatch_id','dispatches'],['candidate_id','candidates'],['decision_id','decisions']])if(row[field]!==null&&!task[collection].some(x=>x.id===row[field]))fail('INVARIANT_VIOLATION');
    for(const grant of task.grant_refs)if(!project.project_grants.some(x=>x.id===grant))fail('INVARIANT_VIOLATION');
    for(const commitment of task.commitments)for(const grant of commitment.grant_refs)if(!project.project_grants.some(x=>x.id===grant))fail('INVARIANT_VIOLATION');
    for(const candidate of task.candidates)if(candidate.work_id!==row.id||new Set(candidate.manifest.map(x=>x.path)).size!==candidate.manifest.length)fail('INVARIANT_VIOLATION');
  }
  const controls=project.worker_control?.dispatches??[];
  if(new Set(controls.map(d=>d.id)).size!==controls.length||new Set(controls.map(d=>d.work)).size!==controls.length)fail('INVARIANT_VIOLATION');
  for(const d of controls){
    if(!byId.has(d.work)||new Set(d.commitments.map(c=>c.id)).size!==d.commitments.length||new Set(d.events.map(e=>e.digest)).size!==d.events.length)fail('INVARIANT_VIOLATION');
    for(const c of d.commitments)if(!Number.isFinite(Date.parse(c.absolute_due))||Date.parse(c.next_due)>Date.parse(c.absolute_due)||c.extension_count>c.extension_limit)fail('INVARIANT_VIOLATION');
  }
  const visiting=new Set(),done=new Set();
  function visit(key){if(visiting.has(key))fail('INVARIANT_VIOLATION');if(done.has(key))return;visiting.add(key);byId.get(key).dependencies.forEach(visit);visiting.delete(key);done.add(key);}
  rows.forEach(row=>visit(row.id));
  return {valid:true,assurance:'structure-only'};
}
export function plan(request) {
  const record=validateRequest(request);
  return {kind:'contract-plan',version:VERSION,command:record.name,executable:false,implementation:record.implementation,authorization:'not-verified',project_state:'not-read',effects_performed:0,changes_performed:0,contract:{roles:record.roles,reads:record.reads,writes:record.writes,invariants:record.invariants,effects:record.effects,required_obligations:record.required_obligations,readset:record.readset},blocking_code:record.implementation==='unavailable'?'CAPABILITY_UNAVAILABLE':'AUTH_REQUIRED',prerequisite:record.prerequisite};
}
export function execute(request,options={}) {
  const record=validateRequest(request);
  if(options.hostIdentityToken){
    return import('./host-bridge.mjs').then(({consumeHostIdentity})=>{
      const hostIdentity=consumeHostIdentity(options.hostIdentityToken,request);
      if(record.implementation==='unavailable')fail('CAPABILITY_UNAVAILABLE');
      return import('./host-store.mjs').then(({executeHostFiles})=>executeHostFiles(request,{hostIdentity,...(options.state?{state:options.state}:{}),...(options.fault?{fault:options.fault}:{})}));
    });
  }
  if(request.command&&request.actor_proof!=='local-owner')fail('AUTH_REQUIRED');
  if(record.implementation==='unavailable')fail('CAPABILITY_UNAVAILABLE');
  return import('./file-store.mjs').then(({executeFiles})=>executeFiles(request));
}
export function inputDigest(request) {validateRequest(request);return digest(request);}
export function replayDecision(request, receipt, currentReadAuthorized) {
  validateRequest(request);validate(receipt,DEFINITIONS.OperationReceipt);
  if(!currentReadAuthorized)fail('AUTH_DENIED');
  if(request.idempotency_key!==receipt.idempotency_key) return {kind:'new-intent',requires_cas:true};
  if(inputDigest(request)!==receipt.input_digest)fail('IDEMPOTENCY_CONFLICT');
  validateResult(receipt.semantic_result);
  return {kind:'historical-result',requires_cas:false,replay_effects:false,result:receipt.semantic_result};
}
export function validateReadset(readset) {
  validate(readset,DEFINITIONS.Readset);
  for(const [collection,key] of [['fields',x=>canonical([x.object,x.field])],['references',x=>x.reference],['discoveries',x=>x.collection]]) {
    const identities=readset[collection].map(key);
    if(new Set(identities).size!==identities.length)fail('INVARIANT_VIOLATION');
  }
  return readset;
}
export function compareReadset(expected, actual) {
  validateReadset(expected);validateReadset(actual);
  const normalize = r => Object.fromEntries(['fields','references','discoveries'].map(k=>[k,[...r[k]].sort((a,b)=>canonical(a).localeCompare(canonical(b)))]));
  return digest(normalize(expected))===digest(normalize(actual));
}
export function verifySelfTransition(command, proof, expectedReadset, actualReadset, actualWrites) {
  validate(proof,DEFINITIONS.SelfTransitionProof);validate(actualWrites,{type:'array',items:DEFINITIONS.Write});
  if(new Set(actualWrites.map(x=>canonical([x.object,x.field]))).size!==actualWrites.length)fail('INVARIANT_VIOLATION');
  const record=findCommand(command);if(!record)fail('INVALID_INPUT');
  if(!compareReadset(expectedReadset,actualReadset) || digest(expectedReadset)!==proof.unchanged_readset_digest)fail('READSET_CHANGED');
  if(!actualWrites.length || digest(actualWrites)!==digest(proof.exact_write_manifest))fail('READSET_CHANGED');
  for(const write of actualWrites) if(!record.readset.claim_exemptions.includes(write.field) || expectedReadset.fields.some(r=>r.object===write.object&&r.field===write.field))fail('READSET_CHANGED');
  return {verified:true,external_permission:false};
}
export function result(code, command_id='request', parts={}) {
  const spec=ERRORS[code];if(!spec)fail('INTERNAL_ERROR');
  const value={command_id,outcome:spec.outcome,code,exit:spec.exit,source_revision:null,generation:null,run_epoch:null,operation_receipt:null,steps:[],effects:[],obligations:[],next:[],...parts};
  validateResult(value);return value;
}
export function validateResult(value) {
  validate(value,DEFINITIONS.Result);
  const spec=ERRORS[value.code];
  if(!spec || value.exit!==spec.exit || value.outcome!==spec.outcome)fail('INVARIANT_VIOLATION');
  if(['committed','awaiting-effect','unknown','recovery-pending'].includes(value.outcome) && (!value.operation_receipt || !value.steps.length))fail('INVARIANT_VIOLATION');
  for(const next of value.next)if(!ERRORS[next.reason])fail('INVARIANT_VIOLATION');
  return value;
}
export function aggregateResults(parts) {
  if(!parts.length)fail('INVALID_INPUT');parts.forEach(validateResult);
  const rank = exit=>exit===11?6:exit===12?5:exit===70?4:exit>=20?3:exit===10?2:1;
  const highest=parts.reduce((a,b)=>rank(a.exit)>=rank(b.exit)?a:b);
  return {code:highest.code,exit:highest.exit,parts};
}
export function errorResult(error) {return result(error instanceof ContractError?error.code:'INTERNAL_ERROR','request',error.caseId?{next:[{action:'project resolve',subject:error.caseId,reason:error.code,needs_decision:true,input_schema:'ResolveInput'}]}:{});}
export function assertRegistry() {
  if(new Set(REGISTRY.map(r=>r.name)).size!==REGISTRY.length)fail('INVARIANT_VIOLATION');
  for(const r of REGISTRY)if(!r.roles.length||!r.reads.length||!r.invariants.length)fail('INVARIANT_VIOLATION');
  return true;
}
