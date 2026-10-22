// Exact legacy task semantics, not merely a before/after byte acknowledgment.
import {parse as parseTaskLog} from '../task-log.mjs';
import {digest,parseJSON} from './engine.mjs';
import {fail} from './contracts.mjs';
export const LEGACY_COLUMNS=['id','status','priority','boundary','title','dependencies','executor','created_at','modified_at','detail_path','dispatch_id','execution_thread_id','execution_turn_id','manager_thread_id','manager_turn_id','recovery_turn_id','recovery_state','recovery_state_at'];
export const LEGACY_STATUSES=['待办','进行中','待确认','受阻','已完成','已取消'];
export function legacyRows(buffer){
 const text=new TextDecoder('utf8',{fatal:true}).decode(buffer),rows=[];let row=[],cell='',quoted=false,closed=false;
 for(let n=0;n<text.length;n++){
  const c=text[n];if(quoted){if(c==='"'){if(text[n+1]==='"'){cell+='"';n++;}else{quoted=false;closed=true;}}else cell+=c;continue;}
  if(c==='"'&&!cell&&!closed){quoted=true;continue;}
  if(c==='\r'&&text[n+1]==='\n')continue;
  if(c===','||c==='\n'){row.push(cell);cell='';closed=false;if(c==='\n'){rows.push(row);row=[];}continue;}
  if(closed||c==='"'||c==='\r')fail('INVALID_INPUT');cell+=c;
 }
 if(quoted||cell||row.length||closed||JSON.stringify(rows.shift())!==JSON.stringify(LEGACY_COLUMNS))fail('SCHEMA_UNSUPPORTED');
 const result=rows.map(cells=>{if(cells.length!==18)fail('INVALID_INPUT');const r=Object.fromEntries(LEGACY_COLUMNS.map((key,n)=>[key,cells[n]]));if(!r.id||!LEGACY_STATUSES.includes(r.status)||!r.detail_path||!Array.isArray(parseJSON(r.dependencies)))fail('INVALID_INPUT');return r;});
 if(new Set(result.map(r=>r.id)).size!==result.length)fail('INVARIANT_VIOLATION');return result;
}
export function legacyContext(rows,work){
 if(rows.filter(r=>r.id===work).length!==1)fail('INVALID_INPUT');
 return digest(rows.map(r=>r.id===work?{...r,status:'<manager-status>',modified_at:'<manager-time>'}:r));
}
export function legacyBefore(buffer,d,input){
 const rows=legacyRows(buffer),row=rows.find(r=>r.id===d.work);
 if(!row||row.dispatch_id!==d.id||row.execution_thread_id!==d.route||row.detail_path!==input.log_path)fail('FENCE_INVALID');
 return {context:legacyContext(rows,d.work),before_status:row.status};
}
export function legacyDisposition(buffer,log,d,pending){
 const rows=legacyRows(buffer),row=rows.find(r=>r.id===d.work),event=d.events.find(e=>e.digest===pending.event);
 if(!row||!event||row.dispatch_id!==d.id||row.execution_thread_id!==d.route||row.detail_path!==pending.log_path||legacyContext(rows,d.work)!==pending.context)fail('RECOVERY_REQUIRED');
 const parsed=parseTaskLog(log);if(parsed.mode!=='structured'||parsed.errors.length)fail('RECOVERY_REQUIRED');
 const recorded=parsed.events.find(e=>e.id===pending.id);
 if(!recorded||recorded.actor!==d.manager||recorded.state_from!==pending.before_status||recorded.state_to!==row.status)fail('RECOVERY_REQUIRED');
 let receipt;
 for(const evidence of recorded.evidence){try{const value=parseJSON(evidence.note??'');if(value.kind==='worker-manager-disposition'){if(receipt)fail('RECOVERY_REQUIRED');receipt=value;}}catch(error){if(error.code==='RECOVERY_REQUIRED')throw error;}}
 const allowed={block:{status:'受阻',type:'blocked'},wait:{status:'待确认',type:'decision_requested'},pause:{status:'受阻',type:'paused'},pass:{status:'已完成',type:'accepted'},cancel:{status:'已取消',type:'cancelled'}};
 if(!receipt||Object.keys(receipt).sort().join(',')!=='candidate,decision,dispatch,event,kind,operation_id,scope_revision,task'||receipt.task!==d.work||receipt.dispatch!==d.id||receipt.event!==pending.event||receipt.candidate!==event.envelope.candidate||receipt.scope_revision!==d.scope_revision||receipt.operation_id!==pending.id||allowed[receipt.decision]?.status!==row.status||allowed[receipt.decision]?.type!==recorded.type||(receipt.decision==='pass'&&recorded.result!=='passed'))fail('RECOVERY_REQUIRED');
 return {...pending,decision:receipt.decision};
}
