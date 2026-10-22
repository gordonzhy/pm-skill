// Owner-program integration only. Never registered as a model-callable sender.
// The native adapter is supplied by the owner, the target comes from the contract,
// and the generic body contains no project, path, task, route or account values.
import {workerRequest} from './worker-client.mjs';
import {digest} from './engine.mjs';
import {newId} from './file-model.mjs';
import {fail} from './contracts.mjs';
export async function attemptWorkerNotice(config,{work,dispatch,role='manager',commitment=null,deliver},options={}){
 if(typeof deliver!=='function'||!['manager','owner'].includes(role))fail('INVALID_INPUT');
 const view=await workerRequest(config,{query:'worker handoff inspect',input:{dispatch}},options),d=view.data.worker_view.dispatch;
 const c=commitment?d.commitments.find(c=>c.id===commitment):null;
 const key=role==='manager'?`manager:${dispatch}`:`owner:${digest({dispatch,commitment:c?.id,lineage:c?.lineage}).slice(7)}`;
 const input={work,dispatch,key,role,commitment};
 try{await workerRequest(config,{command:'worker notification claim',idempotency_key:newId(),input},options);}
 catch(error){if(error.code==='IDEMPOTENCY_CONFLICT')return {invoked:false,state:'prior-attempt-not-replayed'};throw error;}
 let state='unknown';
 try{const response=await deliver({target:role==='manager'?d.manager:c.owner,role,message:'Inspect the assigned private local handoff.'});if(['accepted','rejected','unknown'].includes(response?.state))state=response.state;}catch{}
 await workerRequest(config,{command:'worker notification record',idempotency_key:newId(),input:{...input,state}},options);
 return {invoked:true,state};
}
