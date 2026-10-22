import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { readProjectConfig } from "./project-config.mjs";
import { mkdir } from "node:fs/promises";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "activate-manager.mjs");
const oldManager = "11111111-1111-4111-8111-111111111111";
const dshManager = "session-9f8e7d6c-1a2b-3c4d-5e6f-7890abcdef12";
const headers = "id,status,priority,boundary,title,dependencies,executor,created_at,modified_at,detail_path,dispatch_id,execution_thread_id,execution_turn_id,manager_thread_id,manager_turn_id,recovery_turn_id,recovery_state,recovery_state_at";

test("DSH session identifier is accepted as a stable manager route", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "pm-dsh-route-"));
  const csv = path.join(repo, "TASKS.csv");
  await writeFile(csv, `${headers}\nA,进行中,P0,x,x,[],AI,2026-01-01T00:00:00Z,2026-01-01T00:00:00Z,a.md,dispatch-a,teammate:lane,turn-a,${oldManager},,warning:abc,warning-muted,2026-01-01T00:00:00Z\n`);
  const result = JSON.parse(execFileSync(process.execPath, [script, "--repo", repo, "--manager-thread", dshManager], { encoding: "utf8" }));
  assert.equal(result.changed, 1);
  const changed = await readFile(csv, "utf8");
  assert.match(changed, new RegExp(dshManager));
  assert.doesNotMatch(changed, new RegExp(oldManager));
});

test("PMO binding accepts a DSH session identifier", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "pm-dsh-pmo-"));
  await writeFile(path.join(repo, ".env"), `PROJECT_MANAGER_PMO_THREAD_ID='${dshManager}'\n`);
  const config = await readProjectConfig(repo);
  assert.equal(config.pmoThreadId, dshManager);
  assert.equal(config.pmoBindingError, null);
});

test("collect-project-state skips the Codex Hook check under DSH", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "pm-dsh-collect-"));
  const init = fileURLToPath(new URL("./init-project.mjs", import.meta.url));
  const collect = fileURLToPath(new URL("./collect-project-state.mjs", import.meta.url));
  execFileSync(process.execPath, [init, "--repo", repo, "--prefix", "DSC", "--name", "DSH 采集夹具"], { stdio: "pipe" });
  const env = { ...process.env, DSH_HOME: path.join(repo, ".dsh"), PYTHONDONTWRITEBYTECODE: "1" };
  delete env.CODEX_HOME;
  // 非 --init 模式才会执行 Hook 检查分支；非 git 仓库会返回非零退出码，只断言 JSON 内容。
  const result = spawnSync(process.execPath, [collect, "--repo", repo], { encoding: "utf8", env });
  const data = JSON.parse(result.stdout);
  assert.equal(data.hookCheck.skipped, true);
  assert.match(data.hookCheck.reason || "", /DSH host/);
});

test('qualified cross-platform manager reference is preserved as an opaque route',async()=>{
 const repo=await mkdtemp(path.join(os.tmpdir(),'pm-qualified-route-')),csv=path.join(repo,'TASKS.csv');
 const manager='claude-code:main:same-native-id';
 await writeFile(csv,`${headers}\nA,进行中,P0,x,x,[],AI,2026-01-01T00:00:00Z,2026-01-01T00:00:00Z,a.md,dispatch-a,dsh:main:same-native-id,turn-a,${oldManager},,,,\n`);
 const result=JSON.parse(execFileSync(process.execPath,[script,'--repo',repo,'--manager-thread',manager],{encoding:'utf8'}));assert.equal(result.changed,1);assert.match(await readFile(csv,'utf8'),/claude-code:main:same-native-id/);
});
