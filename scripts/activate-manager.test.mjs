import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "activate-manager.mjs");
const oldManager = "11111111-1111-4111-8111-111111111111";
const newManager = "22222222-2222-4222-8222-222222222222";
const headers = "id,status,priority,boundary,title,dependencies,executor,created_at,modified_at,detail_path,dispatch_id,execution_thread_id,execution_turn_id,manager_thread_id,manager_turn_id,recovery_turn_id,recovery_state,recovery_state_at";

test("new manager replaces all routes and resets active notification addressed to predecessor", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "pm-takeover-"));
  const csv = path.join(repo, "TASKS.csv");
  await writeFile(csv, `${headers}\nA,进行中,P0,x,x,[],AI,2026-01-01T00:00:00Z,2026-01-01T00:00:00Z,a.md,dispatch-a,execution,turn-a,${oldManager},,warning:abc,warning-muted,2026-01-01T00:00:00Z\nB,已完成,P1,x,x,[],AI,2026-01-01T00:00:00Z,2026-01-01T00:00:00Z,b.md,dispatch-b,execution,turn-b,${oldManager},,turn-b,sent,2026-01-01T00:00:00Z\n`);
  const result = JSON.parse(execFileSync(process.execPath, [script, "--repo", repo, "--manager-thread", newManager], { encoding: "utf8" }));
  assert.equal(result.changed, 2);
  const changed = await readFile(csv, "utf8");
  assert.equal(changed.match(new RegExp(newManager, "g")).length, 2);
  assert.doesNotMatch(changed, new RegExp(oldManager));
  assert.match(changed, /A,进行中,.*turn-a,22222222-2222-4222-8222-222222222222,,,/, "active notification must reset");
  assert.match(changed, /B,已完成,.*turn-b,sent,/, "historical notification receipt remains");
  const second = JSON.parse(execFileSync(process.execPath, [script, "--repo", repo, "--manager-thread", newManager], { encoding: "utf8" }));
  assert.equal(second.changed, 0);
});

async function resumeFixture(manager=oldManager){
 const repo=await mkdtemp(path.join(os.tmpdir(),'pm-resume-'));
 const config={configVersion:1,project:{name:'Demo',prefix:'DEMO'},taskSystem:{csv:'TASKS.csv',detailsDir:'tasks'},...(manager?{manager:{threadId:manager,registeredAt:'2026-01-01T00:00:00Z'}}:{})};
 await writeFile(path.join(repo,'project-manager.config.json'),JSON.stringify(config));
 const cols=headers.split(',').concat(['monitor_pause_until','monitor_pause_reason','monitor_pause_scope']);
 const row=(id,status,route,pause='')=>cols.map(k=>({id,status,manager_thread_id:route,execution_thread_id:'original-execution',dispatch_id:'original-dispatch',monitor_pause_reason:pause,modified_at:'2026-01-01T00:00:00Z'}[k]||'')).join(',');
 await writeFile(path.join(repo,'TASKS.csv'),cols.join(',')+'\n'+row('DEMO-1','进行中',newManager)+'\n'+row('DEMO-2','已完成',newManager)+'\n'+row('DEMO-3','进行中',newManager,'paused')+'\n'+row('DEMO-4','待办',newManager)+'\n');
 const run=(id=oldManager)=>{try{return JSON.parse(execFileSync(process.execPath,[script,'--repo',repo,'--manager-thread',id,'--resume-existing'],{encoding:'utf8'}));}catch(e){return JSON.parse(e.stdout);}};
 return {repo,run,csv:path.join(repo,'TASKS.csv'),config:path.join(repo,'project-manager.config.json')};
}
test('existing manager repairs active callback route only, preserves paused and historical routes, and is idempotent',async()=>{
 const f=await resumeFixture(),before=(await readFile(f.csv,'utf8')).split('\n');
 const result=f.run();assert.equal(result.state,'REPAIRED');assert.deepEqual(result.changedTaskIds,['DEMO-1']);assert.deepEqual(result.skippedTaskIds,['DEMO-3']);
 const after=await readFile(f.csv,'utf8');assert.match(after,/original-dispatch,original-execution/);
 for(const i of [2,3,4])assert.equal(after.split('\n')[i],before[i]);
 const second=f.run();assert.equal(second.state,'ALREADY_ALIGNED');assert.equal(await readFile(f.csv,'utf8'),after);
});
test('different current manager and unverified ownership cannot be claimed',async()=>{
 const f=await resumeFixture(newManager),before=await readFile(f.csv,'utf8'),config=await readFile(f.config,'utf8');
 assert.equal(f.run().state,'MANAGER_CHANGED');assert.equal(await readFile(f.csv,'utf8'),before);assert.equal(await readFile(f.config,'utf8'),config);
 const missing=await resumeFixture(null);assert.equal(missing.run().state,'OWNERSHIP_UNVERIFIED');
});
test('identity-equivalent current manager does not rewrite registration; missing ledger is not initialized',async()=>{
 const f=await resumeFixture('codex:default:'+oldManager),config=await readFile(f.config,'utf8');assert.equal(f.run().verified,true);assert.equal(await readFile(f.config,'utf8'),config);
 const {rm}=await import('node:fs/promises');await rm(f.csv);
 assert.throws(()=>execFileSync(process.execPath,[script,'--repo',f.repo,'--manager-thread',oldManager,'--resume-existing'],{stdio:'pipe'}));await assert.rejects(readFile(f.csv));
});
test('encoded identity components retain boundaries and cannot claim another manager',async()=>{
 const f=await resumeFixture('dsh:alpha%3Abeta:gamma'),before=await readFile(f.csv,'utf8');
 assert.equal(f.run('dsh:alpha:beta%3Agamma').state,'MANAGER_CHANGED');assert.equal(await readFile(f.csv,'utf8'),before);
});
test('missing registration is restored only from unambiguous matching existing routes',async()=>{
 const f=await resumeFixture(null);await writeFile(f.csv,(await readFile(f.csv,'utf8')).replaceAll(newManager,oldManager));
 const result=f.run();assert.equal(result.state,'REPAIRED');assert.equal(result.projectChanged,true);assert.equal(result.changed,0);assert.equal(JSON.parse(await readFile(f.config)).manager.threadId,oldManager);
});
