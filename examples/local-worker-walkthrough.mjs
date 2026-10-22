#!/usr/bin/env node
// Runnable fictional project: public CLI calls only; no host, service or account access.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const args=process.argv.slice(2);
if(!args.includes('--run')||args.some(a=>!['--run','--private-local'].includes(a))){
 console.log('Usage: node examples/local-worker-walkthrough.mjs --run [--private-local]\nCreates and retains one private temporary fictional project, with isolated HOME and CLI state. No existing project, installation, host or service is changed. --private-local prints its local evidence directory.');
 process.exitCode=args.length?20:0;
}else{
 const base=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'pm-cli-walkthrough-'));await fs.chmod(base,0o700);
 const dirs=Object.fromEntries(['repo','home','spool','evidence','transcript'].map(k=>[k,path.join(base,k)]));
 for(const dir of Object.values(dirs))await fs.mkdir(dir,{mode:0o700});
 const skill=fileURLToPath(new URL('../',import.meta.url));
 const env={PATH:process.env.PATH,HOME:dirs.home,CODEX_HOME:path.join(dirs.home,'.codex'),TMPDIR:base};
 let count=0,revision,config;
 async function call(entry,action,input){
  const child=spawnSync(process.execPath,[path.join(skill,'scripts',entry),...action],{input:input===undefined?undefined:JSON.stringify(input),encoding:'utf8',env,timeout:30000});
  const name=String(++count).padStart(2,'0');await fs.writeFile(path.join(dirs.transcript,name+'.json'),JSON.stringify({entry,action,input,exit:child.status,stdout:child.stdout,stderr:child.stderr},null,2)+'\n',{mode:0o600});
  if(child.status!==0)throw Error('CLI_STEP_FAILED');const value=JSON.parse(child.stdout);if(value.source_revision)revision=value.source_revision;return value;
 }
 function request(command,input){return {protocol:'project-files/1',command,repo:dirs.repo,project_id:'ATLAS',actor_proof:'local-owner',idempotency_key:`walkthrough-${count+1}`,expected_revision:revision,input};}
 const write=(command,input)=>call('pm-cli.mjs',command.split(' '),request(command,input));
 const query=(query,input={})=>call('pm-cli.mjs',query.split(' '),{protocol:'project-files/1',query,repo:dirs.repo,projection:'private-local',snapshot_token:null,input});
 try{
  const capability=await call('pm-cli.mjs',['capability','inspect']);revision=capability.empty_project_revision;
  await write('project init',{root:dirs.repo,identity:'local-owner',policy:'example-policy'});
  const scope={goal:'Prepare an example plan',allowed_writes:['src'],exclusions:[],criteria:['criterion-a']};
  const create=request('work create',{work:'ATLAS-001',scope,label:'Example plan',deps:[],impact:[]});
  await call('pm-cli.mjs',['input','validate'],create);const plan=await call('pm-cli.mjs',['plan'],create);
  if(plan.executable!==false)throw Error('PLAN_IS_NOT_PERMISSION');
  await call('pm-cli.mjs',['work','create'],create);
  await write('work amend',{work:'ATLAS-001',scope:{...scope,goal:'Prepare and review an example plan'},impact:[]});
  const snapshot=await query('snapshot');if(snapshot.data.model.rows.length!==1||snapshot.data.model.rows[0].phase!=='planned'||snapshot.data.model.tasks[0].scope.goal!=='Prepare and review an example plan')throw Error('TASK_NOT_CREATED');
  const now=Date.now(),at=delta=>new Date(now+delta).toISOString();
  await write('worker dispatch register',{work:'ATLAS-001',dispatch:'dispatch-a',epoch:'epoch-a',manager:'local-owner',worker:'local-owner',route:'example-route',turn:'example-turn',spool:dirs.spool,evidence_root:dirs.evidence,mode:'native',commitments:[{id:'commitment-a',lineage:'lineage-a',revision:1,first_due:at(60000),next_due:at(60000),absolute_due:at(120000),extension_count:0,extension_limit:2,owner:null,owner_due:at(180000),owner_state:'waiting',escalations:0,status:'open',resolved_by:null,last_evidence:null}]});
  config={version:1,control_epoch:'epoch-a',control_repo:dirs.repo,state:path.join(dirs.home,'.local','state','project-files'),project_id:'ATLAS',mode:'native',legacy_root:null};
  const configFile=path.join(base,'worker.json');await fs.writeFile(configFile,JSON.stringify(config),{mode:0o600});
  const evidence=Buffer.from('Fictional plan prepared for manager review. This is not accepted delivery.\n');
  const evidenceDigest='sha256:'+createHash('sha256').update(evidence).digest('hex');await fs.writeFile(path.join(dirs.evidence,'plan.txt'),evidence,{mode:0o600});
  // finish succeeds only after the local envelope is durable. No AI turn is started.
  await call('pm-worker.mjs',['finish','--config',configFile],{command:'worker handoff publish',idempotency_key:'publish-plan',input:{work:'ATLAS-001',dispatch:'dispatch-a',envelope:{version:1,event_id:'event:dispatch-a:1',dispatch:'dispatch-a',epoch:'epoch-a',sequence:1,kind:'stage',phase:'planning',commitments:['commitment-a'],candidate:evidenceDigest,evidence:[{path:'plan.txt',digest:evidenceDigest}],next:'Manager review the plan',can_continue:false,published_at:new Date().toISOString(),supersedes:null}}});
  // A separate writer published: read current source before constructing a new manager intent.
  await query('snapshot');
  await write('worker reconcile',{work:'ATLAS-001',dispatch:'dispatch-a',control_epoch:'epoch-a'});
  const handoff=await query('worker handoff inspect',{dispatch:'dispatch-a'}),event=handoff.data.worker_view.dispatch.events[0];
  await write('worker handoff consume',{work:'ATLAS-001',dispatch:'dispatch-a',control_epoch:'epoch-a',event:event.digest});
  await write('worker handoff dispose',{work:'ATLAS-001',dispatch:'dispatch-a',control_epoch:'epoch-a',event:event.digest,commitment:'commitment-a',kind:'scheduled',action:'Review the example plan at the recorded checkpoint',responsible:'local-owner',evidence:[{path:'plan.txt',digest:evidenceDigest}],commands:[],next_due:at(90000)});
  const claim=await call('pm-worker.mjs',['claim','--config',configFile],{work:'ATLAS-001',dispatch:'dispatch-a'});
  const final=(await query('worker handoff inspect',{dispatch:'dispatch-a'})).data.worker_view.dispatch;
  if(!final.events[0].seen_at||final.events[0].dispositions[0]?.kind!=='scheduled'||final.commitments[0].status!=='open'||claim.runtime!=='unknown'||claim.running!==false)throw Error('FLOW_ASSERTION_FAILED');
  const result={created:true,planned:true,handoff_published:true,manager_consumed:true,checkpoint_recorded:true,responsibility_open:true,runtime:'unknown',business_accepted:false,host_started:false,automatic_wake:false};
  await fs.writeFile(path.join(base,'result.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});console.log(JSON.stringify({...result,...(args.includes('--private-local')?{private_evidence_directory:base}:{})}));
 }catch{
  // Raw failures remain private in transcript; default output is safe to copy.
  console.log(JSON.stringify({completed:false,code:'WALKTHROUGH_FAILED',...(args.includes('--private-local')?{private_evidence_directory:base}:{})}));process.exitCode=1;
 }
}
