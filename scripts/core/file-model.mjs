// The on-disk .yaml documents use the strict JSON subset of YAML 1.2.
import { randomUUID, createHash } from 'node:crypto';
import { DEFINITIONS, validate, fail } from './contracts.mjs';
import { parseJSON, validateDomain, digest, inputDigest, result } from './engine.mjs';
import { verifyHostIdentity } from './host-bridge.mjs';
import { findCommand } from './registry.mjs';

export const columns=Object.keys(DEFINITIONS.TaskCSVRow.properties);
export const rawHash=bytes=>`sha256:${createHash('sha256').update(bytes).digest('hex')}`;
export const jsonBytes=value=>Buffer.from(`${JSON.stringify(value,null,2)}\n`);
export function csvBytes(rows) {
  const cell=value=>`"${String(value).replaceAll('"','""')}"`;
  return Buffer.from([columns,...rows.map(row=>columns.map(k=>Array.isArray(row[k])?JSON.stringify(row[k]):row[k]??''))].map(r=>r.map(cell).join(',')).join('\n')+'\n');
}
export function csvRead(buffer) {
  const text=new TextDecoder('utf-8',{fatal:true}).decode(buffer);
  let rows=[],row=[],value='',quoted=false,closed=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(quoted){if(c==='"'){if(text[i+1]==='"'){value+='"';i++;}else{quoted=false;closed=true;}}else value+=c;continue;}
    if(c==='"'&&!value&&!closed){quoted=true;continue;}
    if(c===','||c==='\n'){row.push(value);value='';closed=false;if(c==='\n'){rows.push(row);row=[];}continue;}
    if(closed||c==='\r'||c==='"')fail('INVALID_INPUT');value+=c;
  }
  if(quoted||value||row.length||closed)fail('INVALID_INPUT');
  if(JSON.stringify(rows.shift())!==JSON.stringify(columns))fail('SCHEMA_UNSUPPORTED');
  return rows.map(cells=>{
    if(cells.length!==columns.length)fail('INVALID_INPUT');
    const r=Object.fromEntries(columns.map((k,i)=>[k,cells[i]]));
    for(const k of ['row_version','scope_revision']){if(!/^(0|[1-9][0-9]*)$/.test(r[k]))fail('INVALID_INPUT');r[k]=Number(r[k]);}
    r.dependencies=parseJSON(r.dependencies);
    for(const k of ['commitment_id','dispatch_id','candidate_id','decision_id','batch_id'])if(r[k]==='')r[k]=null;
    validate(r,DEFINITIONS.TaskCSVRow);return r;
  });
}
export function parseModel(files) {
  const get=p=>{const image=files.find(x=>x.path===p);if(!image?.exists)fail('INVARIANT_VIOLATION');return Buffer.from(image.bytes,'base64');};
  const project=parseJSON(new TextDecoder('utf8',{fatal:true}).decode(get('.pm/project.yaml')));
  const rows=csvRead(get('TASKS.csv'));
  const tasks=rows.map(row=>parseJSON(new TextDecoder('utf8',{fatal:true}).decode(get(row.detail_path))));
  const registered=new Set(rows.map(r=>r.detail_path));
  for(const file of files)if(file.path.startsWith('work-items/')&&file.exists&&!registered.has(file.path))fail('INVARIANT_VIOLATION');
  const model={project,rows,tasks};validateDomain(model);return model;
}
export function modelFiles(model) {
  validateDomain(model);
  const files=[{path:'.pm/project.yaml',bytes:jsonBytes(model.project)},{path:'TASKS.csv',bytes:csvBytes(model.rows)},...model.rows.map(row=>({path:row.detail_path,bytes:jsonBytes(model.tasks.find(t=>t.work_id===row.id))}))];
  if(files.some(f=>f.bytes.length>1048576))fail('CAPABILITY_UNAVAILABLE');return files;
}
export const newId=()=>randomUUID();
export function validateLocalModel(model) {
  validateDomain(model);
  if(model.rows.some(r=>!['planned','cancelled'].includes(r.phase))||model.tasks.some(t=>t.execution||['dispatches','candidates','reports','decisions'].some(k=>t[k].length)))fail('CAPABILITY_UNAVAILABLE');
  if(model.rows.some(r=>r.phase==='cancelled'&&r.control!=='revoked'))fail('INVARIANT_VIOLATION');
  return model;
}
export function assertTitleMerge(base,candidate,work,events,beforeFiles,currentFiles) {
  validateLocalModel(candidate);
  const normalize=model=>{
    model=mergeProtection(model,events);
    model.project.project_audit=model.project.project_audit.filter(a=>!['protection-merged','protection-reasserted'].includes(a.type));
    for(const row of model.rows){row.row_version=1;row.updated_at='mechanical';if(row.id===work)row.title='label';}
    return model;
  };
  if(digest(normalize(base))!==digest(normalize(candidate)))fail('UNSUPPORTED_RESOLUTION_STATE');
  const evidence=files=>files.filter(f=>f.path.startsWith('evidence/pm/')).map(({path,digest,mode,exists})=>({path,digest,mode,exists}));
  if(digest(evidence(beforeFiles))!==digest(evidence(currentFiles)))fail('UNSUPPORTED_RESOLUTION_STATE');
}
const entry=(op,actor,subject,type,evidence=[],payload=[])=>({event_id:newId(),at:new Date().toISOString(),actor,type,subject,payload,evidence,...(op?{operation_receipt:op}:{})});
export function receiptFor(request,operationId) {
  const semantic_result=result('OK',operationId,{operation_receipt:operationId,steps:[{name:'local-transaction',state:'published',facts:{local_intent_committed:true,external_calls:0},evidence:[],assurance:'owner-attested'}]});
  return {operation_id:operationId,idempotency_key:request.idempotency_key,input_digest:inputDigest(request),semantic_result};
}
export function initialize(request,operationId) {
  if(!['project init','flow take-control'].includes(request.command))fail('CAPABILITY_UNAVAILABLE');
  if(request.input.identity!=='local-owner'||request.actor_proof!=='local-owner')fail('AUTH_REQUIRED');
  const project={schema_major:'1',project_id:request.project_id,project_name:'Local project',manager_binding:{principal:'local-owner',epoch:newId(),proof:'local-os-owner'},policy:{id:request.input.policy,version:'1',response_window_seconds:3600,owner_escalation_limit:1,clock_source:'local-wall-clock'},project_grants:[],handoffs:[],batches:[],project_obligations:[],project_audit:[]};
  project.project_audit.push(entry(receiptFor(request,operationId),'local-owner',project.project_id,'project-initialized'));
  return {project,rows:[],tasks:[]};
}
export function adopt(model,request,operationId) {
  validateLocalModel(model);authorize(request,model);
  if(request.input.identity!=='local-owner'||request.input.policy!==model.project.policy.id||model.project.manager_binding.route)fail('AUTH_DENIED');
  model=structuredClone(model);const prior=model.project.manager_binding.epoch,at=new Date().toISOString();
  model.project.manager_binding.epoch=newId();
  for(const grant of model.project.project_grants)if(!grant.revoked_at)grant.revoked_at=at;
  model.project.project_audit.push(entry(receiptFor(request,operationId),'local-owner',model.project.project_id,'checkout-adopted',[],[{field:'previous-epoch',value:prior},{field:'execution-activation',value:'required'},{field:'inherited-grants',value:'revoked'}]));
  return model;
}
export function authorize(request,model,hostIdentity=null) {
  if(hostIdentity){
    const identity=verifyHostIdentity(hostIdentity,request);
    if((request.command&&request.project_id!==model.project.project_id)||identity.project_id!==model.project.project_id)fail('AUTH_DENIED');
    if(model.project.manager_binding.proof!=='host-origin')fail('AUTH_REQUIRED');
    if(identity.manager_epoch!==model.project.manager_binding.epoch)fail('ROLE_STALE');
    const record=findCommand(request.command??request.query);
    if(!record?.roles.includes(identity.role))fail('AUTH_DENIED');
    if(identity.role==='manager'&&(identity.actor!==model.project.manager_binding.principal||identity.thread_id!==model.project.manager_binding.route?.opaque_id))fail('AUTH_DENIED');
    if(identity.role==='executor'&&request.command){
      const row=model.rows.find(r=>r.id===request.input.work);
      if(!row||row.write_owner!==identity.actor)fail('AUTH_DENIED');
    }
    return identity;
  }
  // Local owner attestation is deliberately weaker than a host/agent binding.
  // The platform verifies UID and private binding files; this named policy grants no host identity.
  if(request.actor_proof!=='local-owner'||model.project.manager_binding.proof!=='local-os-owner'||model.project.manager_binding.principal!=='local-owner')fail('AUTH_REQUIRED');
  if(request.project_id!==model.project.project_id)fail('AUTH_DENIED');
}
export function projectReceipt(model,op,events=[]) {
  const audits=[...model.project.project_audit,...model.tasks.flatMap(t=>t.audit)];
  const known=new Set([op.operation_id]),resolutions=[];
  for(let changed=true;changed;){changed=false;for(const audit of model.project.project_audit){
    const next=audit.operation_receipt?.operation_id;
    if(audit.type!=='resolution'||!next||known.has(next)||!audit.payload.some(p=>p.field==='absorbed-operation'&&known.has(p.value)))continue;
    const case_id=audit.payload.find(p=>p.field==='case-ref')?.value,disposition=audit.payload.find(p=>p.field==='resolution-disposition')?.value;
    if(!case_id||!['superseded','completed-by-resolution'].includes(disposition))fail('INVARIANT_VIOLATION');
    resolutions.push({operation_id:next,case_id,disposition});known.add(next);changed=true;
  }}
  const original=audits.find(a=>a.operation_receipt?.operation_id===op.operation_id);
  let control=model.rows.find(r=>r.id===original?.subject)?.control;
  for(const event of events)if(control&&(event.request.input.grant?.work_ids??[event.request.input.work]).includes(original.subject)&&control!=='revoked')control=event.request.command==='work pause'?'paused':'revoked';
  if(!resolutions.length&&!control&&!events.length)return op;
  const effective={name:'effective-control',state:'current-local-state',facts:{...(control?{effective_control:control}:{}),protection_seq:events.length,external_calls:0},evidence:[],assurance:'verified'};
  let semantic_result={...op.semantic_result,steps:[...op.semantic_result.steps,effective]};
  if(resolutions.length){const last=resolutions.at(-1);semantic_result=result('NO_CHANGE',op.operation_id,{operation_receipt:op.operation_id,steps:[{name:'historical-intent',state:last.disposition==='superseded'?'superseded-by-resolution':'completed-by-resolution',facts:{local_intent_committed:last.disposition!=='superseded',resolution_ref:last.operation_id,case_ref:last.case_id,external_calls:0},evidence:resolutions.map(r=>r.operation_id),assurance:'verified'},effective]});}
  return {...op,recorded_result:op.semantic_result,semantic_result,...(resolutions.length?{resolutions}:{})};
}
export function findReplay(model,request,events=[]) {
  const audits=[...model.project.project_audit,...model.tasks.flatMap(t=>t.audit)];
  const hits=audits.filter(a=>a.operation_receipt?.idempotency_key===request.idempotency_key);
  if(hits.length>1)fail('INVARIANT_VIOLATION');
  if(!hits.length)return null;
  const op=hits[0].operation_receipt;
  if(op.input_digest!==inputDigest(request))fail('IDEMPOTENCY_CONFLICT');
  return projectReceipt(model,op,events).semantic_result;
}

export function reduceLocal(model,request,operationId,hostIdentity=null) {
  model=structuredClone(model);authorize(request,model,hostIdentity);
  const actor=hostIdentity?.actor??'local-owner';
  const {input,command}=request;
  const row=model.rows.find(r=>r.id===input.work),task=model.tasks.find(t=>t.work_id===input.work);
  const project=model.project;
  const audit=(subject=project.project_id,type=command.replaceAll(' ','-'),evidence=[])=>entry(receiptFor(request,operationId),actor,subject,type,evidence);
  const bump=()=>{row.row_version++;row.updated_at=new Date().toISOString();};
  if(command.startsWith('work ')&&command!=='work create'&&!row)fail('INVALID_INPUT');
  if(command==='work create') {
    if(row)fail('INVARIANT_VIOLATION');
    model.rows.push({id:input.work,row_version:1,phase:'planned',control:'enabled',scope_revision:1,title:input.label,detail_path:`work-items/${input.work}.yaml`,dependencies:input.deps,commitment_id:null,dispatch_id:null,candidate_id:null,decision_id:null,batch_id:null,write_owner:actor,updated_at:new Date().toISOString()});
    model.tasks.push({schema_major:'1',project_id:project.project_id,work_id:input.work,scope:input.scope,grant_refs:[],blockers:[],commitments:[],dispatches:[],candidates:[],reports:[],decisions:[],obligations:[],audit:[audit(input.work)]});
  }else if(command==='work amend'||command==='work dependencies') {
    if(['closed','cancelled','executing','reviewing','accepted'].includes(row.phase)||row.commitment_id)fail('INVARIANT_VIOLATION');
    if(command==='work amend'){task.scope=input.scope;if(input.label)row.title=input.label;row.scope_revision++;}
    else row.dependencies=input.deps;
    task.audit.push(audit(row.id));bump();
  }else if(command==='grant record') {
    const g=input.grant;
    if(g.project_id!==project.project_id||g.issuer!==actor||!input.evidence.includes(g.evidence_ref)||!input.evidence.length||g.revoked_at)fail('AUTH_DENIED');
    if(project.project_grants.some(x=>x.id===g.id))fail('INVARIANT_VIOLATION');
    if(!Number.isFinite(Date.parse(g.issued_at))||Date.parse(g.issued_at)>Date.now()||(g.expires_at&&(!Number.isFinite(Date.parse(g.expires_at))||Date.parse(g.expires_at)<=Date.parse(g.issued_at))))fail('INVALID_INPUT');
    for(const id of g.work_ids){const r=model.rows.find(x=>x.id===id);if(!r||r.scope_revision!==g.scope_revision)fail('GRANT_MISSING');}
    project.project_grants.push(g);project.project_audit.push(audit(project.project_id,'grant-recorded',input.evidence));
  }else if(command==='work commit-start') {
    if(row.control!=='enabled'||row.phase!=='planned'||row.commitment_id||(!hostIdentity&&input.responsible!==actor)||input.policy!==project.policy.id)fail('INVARIANT_VIOLATION');
    const grants=project.project_grants.filter(g=>g.work_ids.includes(row.id)&&g.scope_revision===row.scope_revision&&g.actions.includes('commit-start')&&!g.revoked_at&&(!g.expires_at||Date.parse(g.expires_at)>Date.now()));
    if(!grants.length)fail('GRANT_MISSING');
    const a=audit(row.id),id=newId();row.commitment_id=id;
    task.grant_refs=[...new Set([...task.grant_refs,...grants.map(g=>g.id)])];
    task.commitments.push({id,work_id:row.id,scope_revision:row.scope_revision,responsible:input.responsible,grant_refs:grants.map(g=>g.id),policy_ref:input.policy,state:'live',origin_event:a.event_id});
    const ready=row.dependencies.every(dep=>model.rows.find(r=>r.id===dep)?.phase==='closed');
    task.obligations.push({id:newId(),template:'start-by',template_version:'1',derivation_key:id,work_or_handoff_ref:row.id,scope_revision:row.scope_revision,responsible:input.responsible,activation_predicate:'prepare-eligible',satisfaction_predicate:'start-confirmed',policy_ref:input.policy,obligation_revision:1,lifecycle:ready?'active':'waiting',basis_refs:[id],next:'prepare-lane',...(ready?{activated_at:a.at,due_at:new Date(Date.parse(a.at)+project.policy.response_window_seconds*1000).toISOString()}:{})});
    task.audit.push(a);bump();
  }else if(command==='audit record') {
    const target=model.tasks.find(t=>t.work_id===input.subject);
    if(input.subject!==project.project_id&&!target)fail('INVALID_INPUT');
    const e=audit(input.subject,input.type,input.evidence);if(input.corrects)e.corrects=input.corrects;
    (target?.audit??project.project_audit).push(e);
    if(target){const r=model.rows.find(r=>r.id===target.work_id);r.row_version++;r.updated_at=e.at;}
  }else fail('CAPABILITY_UNAVAILABLE');
  validateDomain(model);return model;
}
export function mergeProtection(model,events) {
  model=structuredClone(model);
  for(const event of events) {
    const request=event.request;
    const recorded=!!findReplay(model,request);let changed=false;
    const host=model.project.manager_binding.proof==='host-origin';
    if(host){
      const a=event.authority,b=model.project.manager_binding;
      if(!a||a.project_id!==model.project.project_id||(a.role==='manager'&&a.principal!==b.principal)||a.epoch!==b.epoch||!['manager','owner'].includes(a.role)||a.reference!==request.actor_proof)fail('PROTECTED');
    }else authorize(request,model);
    let rows=[];
    if(request.command==='grant revoke'){
      let grant=model.project.project_grants.find(g=>g.id===request.input.grant.id);
      if(digest(request.input.grant)!==event.grant_digest)fail('PROTECTED');
      const core=g=>{const copy={...g};delete copy.revoked_at;return copy;};
      if(grant&&digest(core(grant))!==digest(core(request.input.grant)))fail('PROTECTED');
      if(!grant){grant={...request.input.grant,revoked_at:event.at};model.project.project_grants.push(grant);changed=true;}
      if(!grant.revoked_at){grant.revoked_at=event.at;changed=true;}
      rows=model.rows.filter(r=>grant.work_ids.includes(r.id));if(rows.length!==grant.work_ids.length)fail('PROTECTED');
    }else rows=model.rows.filter(r=>r.id===request.input.work);
    if(!rows.length&&request.command!=='grant revoke')fail('PROTECTED');
    for(const row of rows){const task=model.tasks.find(t=>t.work_id===row.id),prior=digest({row,task});if(row.control!=='revoked')row.control=request.command==='work pause'?'paused':'revoked';if(request.command==='work cancel')row.phase='cancelled';
      if(task.dispatches.length){
        if(!host||!task.execution)fail('CAPABILITY_UNAVAILABLE');
        const x=task.execution,at=event.at;
        for(const e of x.effects)if(e.kind!=='host.stop'&&e.blocking_class!=='passive'&&
          (e.state==='ready'||(event.inventory_valid&&e.state==='claimed'&&!event.issued_claims.includes(e.claim.id))))e.state='suppressed';
        const knownNotStarted=x.effects.filter(e=>['host.start','host.resume'].includes(e.kind)).every(e=>e.state==='suppressed');
        if(knownNotStarted)for(const o of task.obligations)if(o.template==='start-proof'&&['active','waiting'].includes(o.lifecycle)){o.lifecycle='cancelled';o.cancelled_by=event.operation_id;}
        if(request.command!=='work cancel'){
          for(const o of task.obligations)if(o.template==='start-by'&&o.lifecycle==='active')o.lifecycle='waiting';
          if(!task.obligations.some(o=>o.template==='condition-followup'&&o.derivation_key===event.operation_id))task.obligations.push({id:newId(),template:'condition-followup',template_version:'1',derivation_key:event.operation_id,
            work_or_handoff_ref:row.id,scope_revision:row.scope_revision,responsible:model.project.manager_binding.principal,activation_predicate:'protected-work',satisfaction_predicate:'explicit-resume-or-disposition',
            activated_at:at,due_at:new Date(Date.parse(at)+model.project.policy.response_window_seconds*1000).toISOString(),policy_ref:model.project.policy.id,obligation_revision:1,lifecycle:'active',basis_refs:[event.operation_id],next:'manager-disposition'});
        }
        const dispatch=task.dispatches.find(d=>d.id===row.dispatch_id),lane=x.lanes.find(l=>l.id===dispatch?.lane_ref);
        const possible=event.inflight_work_ids?.includes(row.id)||x.effects.some(e=>e.blocking_class!=='passive'&&e.kind!=='host.stop'&&
          (['claimed','accepted','unknown'].includes(e.state)||(['host.start','host.resume'].includes(e.kind)&&e.state==='confirmed'&&lane?.lifecycle.ended.value!==true)));
        if(possible){
          if(!task.obligations.some(o=>o.template==='stop-proof'&&o.derivation_key===event.operation_id))task.obligations.push({id:newId(),template:'stop-proof',template_version:'1',derivation_key:event.operation_id,
            work_or_handoff_ref:row.id,scope_revision:row.scope_revision,responsible:model.project.manager_binding.principal,
            activation_predicate:'protected-inflight',satisfaction_predicate:'exact-stop-or-nonexecution',activated_at:at,
            due_at:new Date(Date.parse(at)+model.project.policy.response_window_seconds*1000).toISOString(),policy_ref:model.project.policy.id,
            obligation_revision:1,lifecycle:'active',basis_refs:[event.operation_id],next:'exact-stop'});
          if(lane?.route&&!x.effects.some(e=>e.kind==='host.stop'&&e.prerequisites.includes(event.operation_id))){
            const payload={id:newId(),kind:'host.stop',body:JSON.stringify({reason:'protection',basis:event.operation_id})};x.payloads.push(payload);
            const old=x.effects.find(e=>e.kind!=='host.stop'&&e.dispatch_ref===dispatch.id);
            if(!old)fail('PROTECTED');
            const stop={id:newId(),project_id:model.project.project_id,work_id:row.id,dispatch_ref:dispatch.id,run_epoch:old.run_epoch,kind:'host.stop',target:lane.route.opaque_id,
              payload_ref:payload.id,payload_digest:digest(payload.body),grant_refs:[],manager_epoch:dispatch.manager_epoch,state:'ready',prerequisites:[event.operation_id],blocking_class:'mutating-host'};
            x.effects.push(stop);dispatch.effect_refs.push(stop.id);dispatch.phase='stop-requested';
          }
        }
      }
      if(request.command==='work cancel')for(const o of task.obligations)if(['active','waiting'].includes(o.lifecycle)&&o.template==='start-by'){o.lifecycle='cancelled';o.cancelled_by=event.operation_id;}
      if(request.command==='work cancel')for(const c of task.commitments)if(c.state==='live')c.state='withdrawn';
      if(digest({row,task})!==prior){changed=true;row.row_version++;row.updated_at=event.at;}
    }
    if(!recorded||changed)model.project.project_audit.push(entry(recorded?null:receiptFor(request,event.operation_id),host?event.authority.principal:'local-owner',request.input.work??request.input.grant.id,recorded?'protection-reasserted':'protection-merged',request.input.evidence??request.input.protection_refs??[],[{field:'protection-seq',value:String(event.seq)},{field:'command',value:request.command},{field:'accepted-at',value:event.at},{field:'proof',value:request.input.proof??'local-owner'},{field:'next',value:request.input.next??'revoked'}]));
  }
  validateDomain(model);return model;
}
