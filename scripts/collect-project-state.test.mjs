import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scripts = path.dirname(fileURLToPath(import.meta.url));
const collector = path.join(scripts, "collect-project-state.mjs");

test("collects one bounded control-plane snapshot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "project-manager-collect-"));
  await mkdir(path.join(root, "tasks"));
  await writeFile(path.join(root, "TASKS.csv"), [
    "id,status,priority,boundary,title,dependencies,executor,created_at,modified_at,detail_path,dispatch_id,execution_thread_id,execution_turn_id,manager_thread_id,manager_turn_id,recovery_turn_id,recovery_state,recovery_state_at",
    "ONE-001,已完成,P0,Test,Done,[],AI,2026-01-01,2026-01-01,tasks/ONE-001.md,,,,,,,,",
    'ONE-002,待办,P1,Test,Ready,"[ONE-001]",AI,2026-01-01,2026-01-01,tasks/ONE-002.md,,,,,,,,',
    'ONE-003,受阻,P0,Test,Blocked,"[ONE-002]",AI,2026-01-01,2026-01-01,tasks/ONE-003.md,dispatch-3,exec-3,turn-3,manager-1,,,,',
    "",
  ].join("\n"));
  await writeFile(path.join(root, "tasks/ONE-002.md"), "# Ready\n\n## 目标\n\nRun.\n");
  await writeFile(path.join(root, "tasks/ONE-003.md"), "# Blocked\n\n## 目标\n\nCheck.\n\n## 阻塞条件\n\nNeed evidence.\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  const stdout = execFileSync(process.execPath, [collector, "--repo", root, "--no-validate", "--no-hook-check"], { encoding: "utf8" });
  const snapshot = JSON.parse(stdout);
  assert.equal(snapshot.taskSystem.total, 3);
  assert.deepEqual(snapshot.taskSystem.ready, ["ONE-002"]);
  assert.deepEqual(snapshot.taskSystem.blocked, ["ONE-003"]);
  assert.ok(snapshot.taskSystem.selected.some((task) => task.id === "ONE-002"));
  assert.equal(snapshot.taskSystem.details.some((detail) => detail.id === "ONE-002"), false);
  assert.equal(snapshot.taskSystem.details.find((detail) => detail.id === "ONE-003").blockers, "Need evidence.");
  assert.deepEqual(snapshot.registeredManagerThreadIds, ["manager-1"]);
  assert.deepEqual(snapshot.nextThreadReads, ["exec-3"]);
});

test("reports an explicitly requested missing task", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "project-manager-collect-missing-"));
  await writeFile(path.join(root, "TASKS.csv"), "id,status,priority,boundary,title,dependencies,detail_path\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  let output = "";
  try {
    execFileSync(process.execPath, [collector, "--repo", root, "--task", "NOPE-1", "--no-validate", "--no-hook-check"], { encoding: "utf8" });
  } catch (error) {
    output = error.stdout;
    assert.equal(error.status, 2);
  }
  assert.deepEqual(JSON.parse(output).taskSystem.missingTaskIds, ["NOPE-1"]);
});


test("compact snapshot reads project heading variants and latest handoff", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "project-manager-compact-"));
  await mkdir(path.join(root, "tasks"));
  await writeFile(path.join(root, "TASKS.csv"), "id,status,priority,dependencies,detail_path,execution_thread_id,manager_thread_id\nONE-001,进行中,P0,[],tasks/ONE-001.md,exec-1,manager-1\n");
  await writeFile(path.join(root, "tasks/ONE-001.md"), "# Active\n\n## 目标与约束\nPreserve layout.\n\n## 旧阻碍\nOld.\n\n## 当前阻碍\nNeed rights.\n\n## 最新派发\nNew route.\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  await writeFile(path.join(root, "long-" + "x".repeat(150)), "dirty");
  for (let i = 0; i < 100; i++) await writeFile(path.join(root, `dirty-${i}-${"y".repeat(50)}.txt`), "dirty");
  const snapshot = JSON.parse(execFileSync(process.execPath, [collector, "--repo", root, "--compact", "--no-validate", "--no-hook-check"], { encoding: "utf8" }));
  const detail = snapshot.taskSystem.details[0];
  assert.equal(detail.objective, "Preserve layout.");
  assert.equal(detail.blockers, "Need rights.");
  assert.match(detail.recentProcess, /New route/);
  assert.deepEqual(snapshot.nextThreadReads, ["exec-1"]);
  assert.ok(snapshot.repository.status.stdout.length < 1900);
  assert.match(snapshot.repository.status.stdout, /truncated/);
  const full = JSON.parse(execFileSync(process.execPath, [collector, "--repo", root, "--no-validate", "--no-hook-check"], { encoding: "utf8" }));
  assert.ok(full.repository.status.stdout.length > 1900);
  assert.deepEqual(snapshot.taskSystem.active, full.taskSystem.active);
  assert.deepEqual(snapshot.taskSystem.selected, full.taskSystem.selected);
});

test("append-only task log snapshots keep the latest events within fixed bounds", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pm-log-tail-"));
  await mkdir(path.join(root, "tasks"));
  await writeFile(path.join(root, "TASKS.csv"), "id,status,priority,dependencies,detail_path\nONE-001,进行中,P0,[],tasks/ONE-001.md\n");
  const history = Array.from({ length: 90 }, (_, i) => `- 2026-10-14T10:00:00Z｜经理｜旧事件${i}｜${"历史记录".repeat(12)}`).join("\n");
  await writeFile(path.join(root, "tasks/ONE-001.md"), `# Active\n\n## 目标\nCurrent goal.\n\n## 当前阻碍\nNeed approval.\n\n## 任务日志\nFIRST_EVENT\n${history}\n- 2026-10-14T11:00:00Z｜经理｜LATEST_FAILURE 修正后仍需复验\n\n## 附件\nMetadata is not the latest task event.\n`);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "fixture"], { cwd: root });
  for (const mode of ["--init", "--compact"]) {
    const snapshot = JSON.parse(execFileSync(process.execPath, [collector, "--repo", root, mode, "--no-validate", "--no-hook-check"], { encoding: "utf8" }));
    const detail = snapshot.taskSystem.details[0];
    const excerpt = mode === "--init" ? detail.latest : detail.recentProcess;
    assert.match(excerpt, /^## 任务日志\n/);
    assert.match(excerpt, /LATEST_FAILURE/);
    assert.doesNotMatch(excerpt, /FIRST_EVENT/);
    assert.match(excerpt, /earlier truncated/);
    assert.ok(excerpt.length <= (mode === "--init" ? 700 : 1600));
    assert.equal(detail.blockers, "Need approval.");
  }
});

test('structured log snapshot follows newest event time rather than YAML field/file order',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'pm-yaml-log-'));await mkdir(path.join(root,'tasks'));
 await writeFile(path.join(root,'TASKS.csv'),'id,status,priority,dependencies,detail_path\nONE-001,进行中,P0,[],tasks/ONE-001.md\n');
 const ev=(id,at,title)=>({id,at,actor:'经理',type:'verification',title,detail:'按真实依据检查',result:'failed',evidence:[{label:'依据',ref:'用户指令'}]});
 const events=[ev('latest','2026-10-14T03:00:00Z','LATEST_FAILURE'),ev('old','2026-10-14T09:00:00+08:00','OLD_EVENT')];
 await writeFile(path.join(root,'tasks/ONE-001.md'),'# Active\n## 任务日志\n```yaml\n'+JSON.stringify({version:1,events})+'\n```\n## 附件\n后置附件');
 execFileSync('git',['init','-q'],{cwd:root});execFileSync('git',['-c','user.name=Test','-c','user.email=test@example.invalid','commit','--allow-empty','-qm','fixture'],{cwd:root});
 const snap=JSON.parse(execFileSync(process.execPath,[collector,'--repo',root,'--init','--no-validate','--no-hook-check'],{encoding:'utf8'}));
 const summary=snap.taskSystem.details[0].latest;assert.match(summary,/LATEST_FAILURE/);assert.ok(summary.indexOf('LATEST_FAILURE')<summary.indexOf('OLD_EVENT'));assert.doesNotMatch(summary,/evidence|后置附件/);
});
