import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION, DEFINITIONS, ERRORS, validate } from './core/contracts.mjs';
import { REGISTRY, CONTRACT, schemaDocument, inputSchema, help, capabilities } from './core/registry.mjs';
import { parseJSON, validateRequest, plan, execute, digest, inputDigest, replayDecision, compareReadset, verifySelfTransition, result, aggregateResults, validateDomain } from './core/engine.mjs';

const cli=fileURLToPath(new URL('./pm-cli.mjs',import.meta.url));
const H=`sha256:${'0'.repeat(64)}`;
const request=()=>({protocol:VERSION.protocol,command:'work create',repo:'/example/atlas',project_id:'ATLAS',actor_proof:'untrusted-proof',idempotency_key:'KEY-1',expected_revision:H,input:{work:'ATLAS-01',scope:{goal:'Build example',allowed_writes:['src/example.mjs'],exclusions:[],criteria:['criterion-1']},label:'Example',deps:[],impact:[]}});
const expectCode=(code,fn)=>assert.throws(fn,error=>error.code===code);
function sample(schema) {
  if(schema.$ref)return sample(DEFINITIONS[schema.$ref.split('/').at(-1)]);
  if(schema.const!==undefined)return schema.const;
  if(schema.enum)return schema.enum[0];
  if(schema.anyOf)return sample(schema.anyOf[0]);
  if(schema.type==='object')return Object.fromEntries(schema.required.map(k=>[k,sample(schema.properties[k])]));
  if(schema.type==='array')return [];
  if(schema.type==='boolean')return false;
  if(schema.type==='integer')return schema.minimum??0;
  if(schema.type==='null')return null;
  if(schema.pattern?.includes('sha256'))return H;
  return 'example';
}
test('one registry generates help, discovery, closed schemas and truthful implementation gates for every command',async()=>{
  assert.equal(new Set(REGISTRY.map(x=>x.name)).size,REGISTRY.length);
  assert(Object.isFrozen(CONTRACT.definitions.TaskText.properties));
  assert.equal(schemaDocument().oneOf.length,REGISTRY.length);
  assert.equal(capabilities().commands.length,REGISTRY.length);
  for(const entry of REGISTRY){assert(help().includes(`${entry.name} [${entry.implementation}]`));const value=sample(inputSchema(entry));if(value.input.receipt&&typeof value.input.receipt==='object')Object.assign(value.input.receipt,{terminated:true,durable:true,exit:0,result:'pass'});assert.equal(validateRequest(value),entry);assert.equal(plan(value).executable,false);if(entry.implementation==='local-query')await assert.rejects(execute(value),e=>e.code==='PATH_UNSAFE');else expectCode(value.actor_proof?'AUTH_REQUIRED':'CAPABILITY_UNAVAILABLE',()=>execute(value));}
});
test('strict JSON rejects duplicates, escaped duplicate, trailing text, prototype keys, depth and oversize',()=>{
  for(const value of ['{"a":1,"a":2}','{"a":1,"\\u0061":2}','{} trailing','{"__proto__":{}}','[1,]','{"a":1,}', '['.repeat(66)+'0'+']'.repeat(66),' '.repeat(1048577)])expectCode('INVALID_INPUT',()=>parseJSON(value));
  assert.deepEqual(parseJSON('{"a":[true,null,"escaped\\\"quote",-1.2]}'),{a:[true,null,'escaped"quote',-1.2]});
});
test('unknown fields, schema, phase, dual ownership, unsafe paths and forged actor are rejected',()=>{
  for(const change of [r=>r.extra=true,r=>r.input.phase='closed',r=>r.actor={role:'owner'},r=>r.input.scope.patch={}]){const r=request();change(r);expectCode('INVALID_INPUT',()=>validateRequest(r));}
  const unsupported=request();unsupported.protocol='project-files/99';expectCode('SCHEMA_UNSUPPORTED',()=>validateRequest(unsupported));
  expectCode('INVALID_INPUT',()=>validate('finished',DEFINITIONS.TaskCSVRow.properties.phase));
  const task=sample(DEFINITIONS.TaskText);task.title='duplicate';expectCode('INVALID_INPUT',()=>validate(task,DEFINITIONS.TaskText));
  for(const path of ['../secret','/absolute','a//b','a/./b','a\\b','file:thing']){const r=request();r.input.scope.allowed_writes=[path];expectCode('PATH_UNSAFE',()=>validateRequest(r));}
  expectCode('AUTH_REQUIRED',()=>execute(request()));
});
test('same key returns original result before new CAS; changed digest rejected; unknown never replayed',()=>{
  const r=request();const original=result('EFFECT_UNKNOWN','op-1',{operation_receipt:'receipt-1',steps:[{name:'host.start',state:'unknown',facts:{},evidence:[],assurance:'unknown'}],effects:['effect-1']});
  const receipt={operation_id:'op-1',idempotency_key:r.idempotency_key,input_digest:inputDigest(r),semantic_result:original};
  const replay=replayDecision(r,receipt,true);assert.equal(replay.requires_cas,false);assert.equal(replay.replay_effects,false);assert.deepEqual(replay.result,original);
  const changed=structuredClone(r);changed.input.label='Changed';expectCode('IDEMPOTENCY_CONFLICT',()=>replayDecision(changed,receipt,true));
  expectCode('AUTH_DENIED',()=>replayDecision(r,receipt,false));
  changed.idempotency_key='KEY-2';assert.equal(replayDecision(changed,receipt,true).requires_cas,true);
});
test('readset includes field values, presence, absence and discovered collections; only exact mechanical claim writes',()=>{
  const rs={fields:[{object:'task-1',field:'scope',digest:H}],references:[{reference:'grant-1',exists:true},{reference:'missing',exists:false}],discoveries:[{collection:'tasks',digest:H}]};
  const reversed=structuredClone(rs);reversed.references.reverse();assert(compareReadset(rs,reversed));
  for(const mutate of [r=>r.references[1].exists=true,r=>r.discoveries=[],r=>r.fields[0].digest=digest('changed')]){const changed=structuredClone(rs);mutate(changed);assert(!compareReadset(rs,changed));}
  const writes=[{object:'task-1',field:'csv.row_version',before:H,after:digest('new')}];
  const proof={validation_ref:'validation-1',pre_revision:H,operation_id:'op-1',exact_write_manifest:writes,unchanged_readset_digest:digest(rs)};
  assert.equal(verifySelfTransition('effect claim',proof,rs,rs,writes).external_permission,false);
  const bad=[{...writes[0],field:'scope'}];expectCode('READSET_CHANGED',()=>verifySelfTransition('effect claim',{...proof,exact_write_manifest:bad},rs,rs,bad));
  expectCode('READSET_CHANGED',()=>verifySelfTransition('work create',proof,rs,rs,writes));
});
test('closed result taxonomy retains partial facts with unknown/recovery/blocking precedence',()=>{
  for(const [code,spec] of Object.entries(ERRORS)){const value=result(code,'op-1',spec.outcome==='rejected'||spec.outcome==='no-change'?{}:{operation_receipt:'receipt-1',steps:[{name:'local',state:'recorded',facts:{},evidence:[],assurance:'verified'}]});assert.equal(value.exit,spec.exit);}
  const pending=result('IO_PENDING','op-1',{operation_receipt:'receipt-1',steps:[{name:'local',state:'decided',facts:{},evidence:[],assurance:'verified'}]});
  const unknown=result('STOP_UNKNOWN','op-2',{operation_receipt:'receipt-2',steps:[{name:'stop',state:'unknown',facts:{},evidence:[],assurance:'unknown'}]});
  const parts=[result('VERSION_CONFLICT'),pending,unknown];const combined=aggregateResults(parts);assert.equal(combined.exit,11);assert.deepEqual(combined.parts,parts);
  expectCode('INTERNAL_ERROR',()=>result('ADAPTER_INVENTED'));
  expectCode('INVARIANT_VIOLATION',()=>result('OK'));
});
test('domain structure checks ownership, index references, identities, dependencies and DAG',()=>{
  const project=sample(DEFINITIONS.ProjectText);project.project_id='ATLAS';
  const row=sample(DEFINITIONS.TaskCSVRow);Object.assign(row,{id:'ATLAS-01',detail_path:'work-items/ATLAS-01.yaml',commitment_id:null,dispatch_id:null,candidate_id:null,decision_id:null,batch_id:null});
  const task=sample(DEFINITIONS.TaskText);Object.assign(task,{project_id:'ATLAS',work_id:'ATLAS-01'});
  const model={project,rows:[row],tasks:[task]};assert.equal(validateDomain(model).assurance,'structure-only');
  for(const mutate of [m=>m.rows[0].dependencies=['ATLAS-01'],m=>m.rows[0].dependencies=['MISSING'],m=>m.tasks[0].project_id='OTHER',m=>m.rows[0].candidate_id='MISSING']){const bad=structuredClone(model);mutate(bad);expectCode('INVARIANT_VIOLATION',()=>validateDomain(bad));}
});
test('real CLI read-only paths have zero project/HOME writes and private sentinels never appear in output',()=>{
  const root=mkdtempSync(join(tmpdir(),'contract-cli-'));
  try {
    const sentinel='PRIVATE_SENTINEL_EXAMPLE';writeFileSync(join(root,'marker'),sentinel);
    const r=request();r.repo=root;r.input.label=sentinel;
    for(const args of [['help'],['capability','inspect'],['schema'],['api','describe'],['input','validate'],['plan'],['work','create'],['unknown',sentinel]]) {
      const child=spawnSync(process.execPath,[cli,...args],{input:JSON.stringify(r),cwd:root,env:{PATH:process.env.PATH,HOME:root,CODEX_HOME:root},encoding:'utf8'});
      assert(!child.stdout.includes(sentinel));assert.equal(child.stderr,'');assert([0,20,22].includes(child.status));assert.deepEqual(readdirSync(root),['marker']);assert.equal(readFileSync(join(root,'marker'),'utf8'),sentinel);
    }
    const q={protocol:VERSION.protocol,query:'project inspect',repo:root,projection:'private-local',snapshot_token:null,input:{}};
    const child=spawnSync(process.execPath,[cli,'project','inspect'],{input:JSON.stringify(q),cwd:root,env:{PATH:process.env.PATH,HOME:root},encoding:'utf8'});assert.equal(child.status,process.platform==='darwin'?24:25);assert.equal(JSON.parse(child.stdout).code,process.platform==='darwin'?'RECOVERY_REQUIRED':'PLATFORM_UNSUPPORTED');assert.deepEqual(readdirSync(root),['marker']);
  } finally {rmSync(root,{recursive:true,force:true});}
});
test('object namespace, nested work identity, receipt schema and readset logical identities are enforced',()=>{
  const project=sample(DEFINITIONS.ProjectText);project.project_id='ATLAS';
  const row=sample(DEFINITIONS.TaskCSVRow);Object.assign(row,{id:'ATLAS-01',detail_path:'work-items/ATLAS-01.yaml',commitment_id:null,dispatch_id:null,candidate_id:null,decision_id:null,batch_id:null});
  const task=sample(DEFINITIONS.TaskText);Object.assign(task,{project_id:'ATLAS',work_id:'ATLAS-01'});
  const model={project,rows:[row],tasks:[task]};
  const obligation=sample(DEFINITIONS.Obligation);obligation.id='obligation-1';project.project_obligations=[obligation];task.obligations=[structuredClone(obligation)];expectCode('INVARIANT_VIOLATION',()=>validateDomain(model));
  project.project_obligations=[];task.obligations=[];
  const commitment=sample(DEFINITIONS.Commitment);Object.assign(commitment,{id:'commitment-1',work_id:'OTHER'});task.commitments=[commitment];row.commitment_id=commitment.id;expectCode('INVARIANT_VIOLATION',()=>validateDomain(model));
  const receipt=sample(DEFINITIONS.ValidationReceipt);Object.assign(receipt,{schema_version:'999.0.0',terminated:true,durable:true,exit:0,result:'pass'});expectCode('SCHEMA_UNSUPPORTED',()=>validate(receipt,DEFINITIONS.ValidationReceipt));
  for(const bad of [{fields:[],references:[{reference:'ref-1',exists:true},{reference:'ref-1',exists:false}],discoveries:[]},{fields:[{object:'work-1',field:'scope',digest:H},{object:'work-1',field:'scope',digest:digest('changed')}],references:[],discoveries:[]},{fields:[],references:[],discoveries:[{collection:'tasks',digest:H},{collection:'tasks',digest:digest('changed')}]}])expectCode('INVARIANT_VIOLATION',()=>compareReadset(bad,bad));
});
test('missing runtime dependencies produce a stable boot error without a local path stack',()=>{
  const root=mkdtempSync(join(tmpdir(),'cli-startup-'));
  try{writeFileSync(join(root,'pm-cli.mjs'),readFileSync(cli));const child=spawnSync(process.execPath,[join(root,'pm-cli.mjs'),'help'],{encoding:'utf8',env:{PATH:process.env.PATH,HOME:root}});assert.equal(child.status,70);assert.equal(child.stderr,'');assert.equal(JSON.parse(child.stdout).code,'INTERNAL_ERROR');assert(!child.stdout.includes(root));}finally{rmSync(root,{recursive:true,force:true});}
});
test('input validate names the failing schema field without echoing supplied keys or values',()=>{
  const q={protocol:VERSION.protocol,query:'project inspect',repo:'/example/atlas',snapshot_token:null,input:{}};
  const missing=spawnSync(process.execPath,[cli,'input','validate'],{input:JSON.stringify(q),encoding:'utf8'});
  assert.equal(missing.status,20);assert.equal(missing.stderr,'');
  const rejected=JSON.parse(missing.stdout);
  assert.equal(rejected.valid,false);assert.equal(rejected.code,'INVALID_INPUT');assert.equal(rejected.field,'projection');assert.equal(rejected.executable,false);
  assert(!missing.stdout.includes('/example/atlas'));
  const supplied=structuredClone(q);supplied.projection='summary';supplied.private_marker_xyz={secret:'VALUE_SENTINEL'};
  const echoed=spawnSync(process.execPath,[cli,'input','validate'],{input:JSON.stringify(supplied),encoding:'utf8'});
  const unknown=JSON.parse(echoed.stdout);
  assert.equal(unknown.valid,false);assert.equal(unknown.field,null);assert(!echoed.stdout.includes('private_marker_xyz'));assert(!echoed.stdout.includes('VALUE_SENTINEL'));
  const nested=request();delete nested.input.scope.criteria;
  const inner=spawnSync(process.execPath,[cli,'input','validate'],{input:JSON.stringify(nested),encoding:'utf8'});
  assert.equal(inner.status,20);assert.equal(JSON.parse(inner.stdout).field,'input.scope.criteria');
});
