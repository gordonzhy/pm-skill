#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import {existsSync} from "node:fs";
import {createHash} from "node:crypto";
import {loadProjectConfig} from "./project-config-v2.mjs";
import { fileURLToPath } from "node:url";
const scripts = path.dirname(fileURLToPath(import.meta.url));
const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i];
  if (key === "--no-registration") args.set(key, true);
  else if (["--repo", "--manager-thread", "--state-dir", "--prefix", "--name"].includes(key) && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) args.set(key, process.argv[++i]);
  else throw new Error(`unknown option or missing value: ${key}`);
}
const repo = path.resolve(args.get("--repo") || process.cwd());
const manager = args.get("--manager-thread");
const start = Date.now();
let deadline = start + 5000;
function run(command, argv, limit = deadline) {
  const remaining = limit - Date.now();
  if (remaining <= 0) throw new Error("initialization budget exhausted");
  const env = {...process.env};
  if (args.has("--state-dir")) {
    env.PM_SERVER_STATE_DIR = path.resolve(args.get("--state-dir"));
    env.CODEX_SESSION_RUNTIME_CSV = path.join(env.PM_SERVER_STATE_DIR, "session-runtime.csv");
  }
  const result = spawnSync(command, argv, { encoding: "utf8", timeout: remaining, cwd: existsSync(repo) ? repo : scripts, env });
  if (result.status !== 0) throw new Error(result.error?.message || result.stderr || result.stdout || `exit ${result.status}`);
  return result.stdout;
}
let stage = "prevalidation";
let routing;
let snapshot;
let registration;
let initialization = {state:"existing"};
try {
  // Codex UUID 与 DSH 的 session-/teammate:/subagent: 标识都作为稳定路由标识接受。
  if (!/^(?:(?:codex|claude-code|dsh):[A-Za-z0-9%._~-]+:[A-Za-z0-9%._~-]+|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|session-[A-Za-z0-9._-]+|teammate:[A-Za-z0-9._-]+|subagent:[A-Za-z0-9._-]+)$/i.test(manager || "")) throw new Error("--manager-thread requires the actual current thread ID (Codex UUID or DSH session-/teammate:/subagent: identifier)");
  const config = await loadProjectConfig(repo);
  if (!config.ok) throw new Error(config.errors.join("; "));
  if (!existsSync(path.join(repo, "TASKS.csv"))) {
    stage = "initialization";
    const prefix = args.get("--prefix") || config.config.project.prefix || "PM" + createHash("sha256").update(repo).digest("hex").slice(0, 6).toUpperCase();
    initialization = JSON.parse(run(process.execPath, [path.join(scripts, "init-project.mjs"), "--repo", repo, "--prefix", prefix, "--name", args.get("--name") || path.basename(repo), "--empty", "--json"], Date.now() + 30000));
    if (!initialization.ok) throw new Error("project structure initialization failed");
    deadline = Date.now() + 5000;
  }
  stage = "prevalidation";
  if (!existsSync(path.join(repo, "TASKS.html"))) run("python3", [path.join(scripts, "generate_tasks.py"), repo]);
  run("python3", [path.join(scripts, "validate_tasks.py"), repo]);
  stage = "route";
  routing = JSON.parse(run(process.execPath, [path.join(scripts, "activate-manager.mjs"), "--repo", repo, "--manager-thread", manager]));
  stage = "snapshot-and-postvalidation";
  snapshot = JSON.parse(run(process.execPath, [path.join(scripts, "collect-project-state.mjs"), "--repo", repo, "--init", "--budget-ms", String(Math.max(100, deadline - Date.now()))]));
  if (!routing.verified || !snapshot.registeredManagerThreadIds.includes(manager)) throw new Error("manager registration did not survive read-back");
  // 注册检查由程序一次完成；不依赖服务运行，不启动服务；有效来源由应用自动登记，黑名单由应用阻止。
  stage = "registration";
  if (args.has("--no-registration")) registration = { state: "skipped", reason: "--no-registration" };
  else {
    const registrationArgs = ["project", "request", "--csv", path.join(repo, "TASKS.csv"), "--repo", repo, "--auto"];
    if (args.has("--state-dir")) registrationArgs.push("--state-dir", path.resolve(args.get("--state-dir")));
    const application=process.env.PM_SERVER_BIN || 'pm-server';
    const result=spawnSync(application,registrationArgs,{encoding:'utf8',timeout:5000,cwd:repo});
    if(result.error?.code==='ENOENT')registration={state:'unavailable',reason:'pm-server is not installed; task management remains available'};
    else if(result.error||result.status!==0)throw new Error(result.error?.message||result.stderr||result.stdout);
    else registration=JSON.parse(result.stdout);
  }
  console.log(JSON.stringify({ ok: true, initialization, elapsedMs: Date.now() - start, routing, snapshot, registration }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, initialization, elapsedMs: Date.now() - start, stage, routing, snapshot, registration, error: error.message }));
  process.exitCode = 2;
}
