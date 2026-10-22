import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, chmod, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
const scripts = path.dirname(fileURLToPath(import.meta.url));
const init = path.join(scripts, "initialize-manager.mjs");
const collector = path.join(scripts, "collect-project-state.mjs");
process.env.PM_SERVER_BIN=process.env.PM_SERVER_BIN || path.join(os.tmpdir(),"pm-skill-no-app-"+process.pid);
const manager = "22222222-2222-4222-8222-222222222222";
async function fixture() {
  const repo = await mkdtemp(path.join(os.tmpdir(), "pm-fast-init-"));
  await mkdir(path.join(repo, "tasks"));
  await writeFile(path.join(repo, "TASKS.csv"), "id,status,priority,boundary,title,dependencies,executor,created_at,modified_at,detail_path,dispatch_id,execution_thread_id,execution_turn_id,manager_thread_id,manager_turn_id,recovery_turn_id,recovery_state,recovery_state_at\nT-001,待办,P0,Test,One,[],QA,2026-01-01T00:00:00Z,2026-01-01T00:00:00Z,tasks/T-001.md,,,,,,,,\n");
  await writeFile(path.join(repo, "tasks/T-001.md"), "# T-001 One\n\n- 状态：待办\n- 优先级：P0\n- 所属边界：Test\n- 执行者：QA\n- 依赖：[]\n\n## 目标\nCheck.\n\n## 任务日志\n- 2026-01-01T00:00:00Z｜QA｜创建｜准备初始化隔离测试。｜测试夹具。\n");
  execFileSync("python3", [path.join(scripts, "generate_tasks.py"), repo]);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "fixture"], { cwd: repo });
  return repo;
}
test("one-call initialization validates, routes and remains idempotent", async () => {
  const repo = await fixture();
  const argv = [init, "--repo", repo, "--manager-thread", manager, "--state-dir", path.join(repo, "registry")];
  const first = JSON.parse(execFileSync(process.execPath, argv, { encoding: "utf8" }));
  assert.equal(first.ok, true);
  assert.equal(first.registration.state, "unavailable");
  assert.equal(first.routing.changed, 1);
  assert.equal(first.snapshot.taskSystem.validation.ok, true);
  assert.deepEqual(first.snapshot.taskSystem.ready, ["T-001"]);
  assert.deepEqual(first.snapshot.registeredManagerThreadIds, [manager]);
  assert.equal(first.snapshot.hookCheck.skipped, true);
  assert.equal(first.snapshot.runtime.path,path.join(repo,"registry","session-runtime.csv"));
  assert.equal(first.snapshot.repository.worktrees.skipped, true);
  const csv = await readFile(path.join(repo, "TASKS.csv"), "utf8");
  const second = JSON.parse(execFileSync(process.execPath, argv, { encoding: "utf8" }));
  assert.equal(second.routing.changed, 0);
  assert.equal(second.registration.state, "unavailable");
  assert.equal(await readFile(path.join(repo, "TASKS.csv"), "utf8"), csv);
});
test("invalid task backend fails before route mutation", async () => {
  const repo = await fixture();
  const csvPath = path.join(repo, "TASKS.csv");
  const broken = (await readFile(csvPath, "utf8")).replace("T-001,待办", "T-001,INVALID");
  await writeFile(csvPath, broken);
  const result = spawnSync(process.execPath, [init, "--repo", repo, "--manager-thread", manager, "--state-dir", path.join(repo, "registry")], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stdout).stage, "prevalidation");
  assert.equal(await readFile(csvPath, "utf8"), broken);
});
test("slow local checks exhaust shared budget and are not reported as passed", async () => {
  const repo = await fixture();
  const bin = path.join(repo, "fake-bin");
  await mkdir(bin);
  const fake = path.join(bin, "git");
  await writeFile(fake, `#!${process.execPath}\nAtomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);\n`);
  await chmod(fake, 0o755);
  const result = spawnSync(process.execPath, [collector, "--repo", repo, "--init", "--budget-ms", "100"], { encoding: "utf8", env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH } });
  assert.equal(result.status, 2);
  const snapshot = JSON.parse(result.stdout);
  assert.equal(snapshot.budgetExceeded, true);
  assert.equal(snapshot.taskSystem.validation.ok, false);
  assert.ok(snapshot.checkFailures.length > 0);
});

test("historical missing log blocks takeover but preserves a readable failure snapshot", async () => {
  const repo = await fixture();
  const cardPath = path.join(repo, "tasks/T-001.md");
  const historical = (await readFile(cardPath, "utf8")).split("## 任务日志")[0];
  await writeFile(cardPath, historical);
  const originalCsv = await readFile(path.join(repo, "TASKS.csv"), "utf8");
  const result = spawnSync(process.execPath, [init, "--repo", repo, "--manager-thread", manager, "--state-dir", path.join(repo, "registry")], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stdout).stage, "prevalidation");
  assert.equal(await readFile(path.join(repo, "TASKS.csv"), "utf8"), originalCsv);
  assert.equal(await readFile(cardPath, "utf8"), historical);
  const readonly = spawnSync(process.execPath, [collector, "--repo", repo, "--init"], { encoding: "utf8" });
  assert.equal(readonly.status, 2);
  const snapshot = JSON.parse(readonly.stdout);
  assert.equal(snapshot.taskSystem.total, 1);
  assert.equal(snapshot.taskSystem.validation.ok, false);
  assert.deepEqual(snapshot.registeredManagerThreadIds, []);
});

test('optional app failure is reported after successful task routing',async()=>{
 const repo=await fixture();const binary=path.join(repo,'pm-server');
 await writeFile(binary,`#!${process.execPath}\nconsole.error('fixture unavailable');process.exit(2);`);await chmod(binary,0o755);
 const result=spawnSync(process.execPath,[init,'--repo',repo,'--manager-thread',manager],{encoding:'utf8',env:{...process.env,PM_SERVER_BIN:binary}});
 assert.equal(result.status,2);const report=JSON.parse(result.stdout);assert.equal(report.stage,'registration');assert.ok(report.routing);
});

test('takeover creates an empty non-Git project, registers its manager and is repeatable', async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'pm-empty-takeover-'));
  await writeFile(path.join(repo,'AGENTS.md'),'# Existing rules\nDo not deploy.\n');
  const argv=[init,'--repo',repo,'--manager-thread',manager,'--no-registration'];
  const result=JSON.parse(execFileSync(process.execPath,argv,{encoding:'utf8'}));
  assert.equal(result.ok,true);
  assert.equal(result.snapshot.taskSystem.total,0);
  assert.equal((await stat(path.join(repo,"work-items"))).isDirectory(),true);
  assert.equal(result.routing.verified,true);
  assert.equal(result.snapshot.projectManager.threadId,manager);
  assert.deepEqual(result.snapshot.registeredManagerThreadIds,[manager]);
  assert.equal((await readFile(path.join(repo,'TASKS.csv'),'utf8')).trim().split('\n').length,1);
  assert.match(await readFile(path.join(repo,'AGENTS.md'),'utf8'),/Do not deploy/);
  const files=['TASKS.csv','TASKS.html','project-manager.config.json','AGENTS.md'];
  const before=await Promise.all(files.map(file=>readFile(path.join(repo,file),'utf8')));
  const second=JSON.parse(execFileSync(process.execPath,argv,{encoding:'utf8'}));
  assert.equal(second.routing.projectChanged,false);
  assert.equal(second.routing.changed,0);
  assert.deepEqual(await Promise.all(files.map(file=>readFile(path.join(repo,file),'utf8'))),before);
});

test('unknown manager never creates a ledger', async () => {
  const repo=await mkdtemp(path.join(os.tmpdir(),'pm-no-identity-'));
  const result=spawnSync(process.execPath,[init,'--repo',repo,'--no-registration'],{encoding:'utf8'});
  assert.equal(result.status,2);
  await assert.rejects(readFile(path.join(repo,'TASKS.csv')),{code:'ENOENT'});
});

test('config-only project preserves project settings during takeover',async()=>{
  const repo=await mkdtemp(path.join(os.tmpdir(),'pm-config-resume-'));
  await writeFile(path.join(repo,'project-manager.config.json'),JSON.stringify({configVersion:1,project:{name:'Existing project',prefix:'KEEP',group:'Research'},taskSystem:{csv:'TASKS.csv',detailsDir:'cards'},workbench:{port:12345}}));
  const result=JSON.parse(execFileSync(process.execPath,[init,'--repo',repo,'--manager-thread',manager,'--no-registration'],{encoding:'utf8'}));
  assert.equal(result.ok,true);
  const config=JSON.parse(await readFile(path.join(repo,'project-manager.config.json'),'utf8'));
  assert.equal(config.project.name,'Existing project');
  assert.equal(config.project.prefix,'KEEP');
  assert.equal(config.taskSystem.detailsDir,'cards');
  assert.equal(config.workbench.port,12345);
});


test('takeover creates missing parent directories without requiring Git initialization',async()=>{
 const parent=await mkdtemp(path.join(os.tmpdir(),'pm-new-root-')),repo=path.join(parent,'new','project');
 const result=JSON.parse(execFileSync(process.execPath,[init,'--repo',repo,'--manager-thread',manager,'--no-registration'],{encoding:'utf8'}));
 assert.equal(result.ok,true);assert.equal(result.snapshot.projectManager.threadId,manager);assert.equal(result.snapshot.taskSystem.total,0);
});
