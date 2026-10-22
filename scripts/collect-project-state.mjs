#!/usr/bin/env node
import {cachedRuntimeClaim} from './core/worker-runtime.mjs';
import {loadProjectConfig} from "./project-config-v2.mjs";

import {serverStateDir} from './server-client.mjs';
import { parse as parseTaskLog } from "./task-log.mjs";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function parseArgs(argv) {
  const result = { repo: process.cwd(), taskIds: [], validate: true, hook: true, compact: false, init: false, budgetMs: 5000, maxReady: 12 };
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--repo") result.repo = argv[++index];
    else if (argument === "--worker-config") result.workerConfig=argv[++index];
    else if (argument === "--task") result.taskIds.push(argv[++index]);
    else if (argument === "--init") { result.init = true; result.compact = true; result.hook = false; result.maxReady = 3; }
    else if (argument === "--budget-ms") result.budgetMs = Number(argv[++index]);
    else if (argument === "--compact") result.compact = true;
    else if (argument === "--no-validate") result.validate = false;
    else if (argument === "--no-hook-check") result.hook = false;
    else if (argument === "--max-ready") result.maxReady = Number(argv[++index]);
    else if (argument === "--help") result.help = true;
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (!result.repo) throw new Error("--repo requires a path");
  if (result.taskIds.some((value) => !value)) throw new Error("--task requires an ID");
  if (!Number.isInteger(result.maxReady) || result.maxReady < 0 || result.maxReady > 100) {
    throw new Error("--max-ready must be an integer from 0 to 100");
  }
  if (!Number.isInteger(result.budgetMs) || result.budgetMs < 100 || result.budgetMs > 30000) throw new Error("--budget-ms must be 100..30000");
  result.repo = path.resolve(result.repo);
  result.taskIds = [...new Set(result.taskIds)];
  return result;
}

function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') { field += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"') quoted = true;
    else if (character === ",") { row.push(field); field = ""; }
    else if (character === "\n") { row.push(field.replace(/\r$/, "")); rows.push(row); row = []; field = ""; }
    else field += character;
  }
  if (field || row.length) { row.push(field.replace(/\r$/, "")); rows.push(row); }
  return rows;
}

function records(text) {
  const rows = parseCsv(text);
  const headers = rows[0] || [];
  return rows.slice(1).filter((row) => row.some(Boolean)).map((row) =>
    Object.fromEntries(headers.map((header, index) => [header, row[index] || ""])),
  );
}

function dependencyIds(value) {
  const text = String(value || "").trim();
  if (!text || text === "[]") return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {}
  return text.replace(/^\[|\]$/g, "").split(/[;,，\s]+/).map((item) => item.trim()).filter(Boolean);
}

let deadline = Infinity;
function run(command, args, options = {}) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return { ok: false, status: null, stdout: "", stderr: "", error: "initialization budget exhausted" };
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    timeout: Math.max(1, Math.min(options.timeout || 20_000, remaining)),
    env: options.env || process.env,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: bounded((result.stdout || "").trim(), options.maxChars || 12_000),
    stderr: bounded((result.stderr || "").trim(), options.maxChars || 12_000),
    error: result.error?.message || "",
  };
}

function parseSections(markdown) {
  const sections = {};
  const matches = [...markdown.matchAll(/^##\s+(.+)$/gm)];
  for (let index = 0; index < matches.length; index += 1) {
    const heading = matches[index][1].trim();
    const start = matches[index].index + matches[index][0].length;
    const end = matches[index + 1]?.index ?? markdown.length;
    sections[heading] = markdown.slice(start, end).trim();
  }
  return sections;
}

function bounded(value, limit) {
  if (!value || value.length <= limit) return value || "";
  return `${value.slice(0, limit)}\n...[truncated ${value.length - limit} chars]`;
}

// Task logs are append-only: retain the latest events, not the creation prefix.
function boundedTail(value, limit) {
  if (!value || value.length <= limit) return value || "";
  const marker = "...[earlier truncated]\n";
  return marker + value.slice(-(limit - marker.length));
}

function sectionTail(entry, fallback, limit) {
  if (!entry) return boundedTail(fallback, limit);
  const heading = `## ${entry[0]}\n`;
  // Keep even an unusually long heading bounded without losing the latest body.
  const prefix = heading.slice(0, Math.min(heading.length, Math.floor(limit / 3)));
  return prefix + boundedTail(entry[1], limit - prefix.length);
}

function taskSummary(task, statusById) {
  const dependencies = dependencyIds(task.dependencies);
  const incompleteDependencies = dependencies.filter((id) => statusById.get(id) !== "已完成");
  return {
    id: task.id,
    status: task.status,
    priority: task.priority,
    boundary: task.boundary,
    title: task.title,
    dependencies,
    incompleteDependencies,
    detailPath: task.detail_path,
    dispatchId: task.dispatch_id,
    executionThreadId: task.execution_thread_id,
    executionTurnId: task.execution_turn_id,
    managerThreadId: task.manager_thread_id,
    modifiedAt: task.modified_at,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.init) deadline = Date.now() + args.budgetMs;
  if (args.help) {
    console.log("Usage: collect-project-state.mjs --repo <path> [--task ID ...] [--worker-config <private-config>] [--max-ready N] [--compact|--init] [--budget-ms N] [--no-validate] [--no-hook-check]");
    return;
  }

  const csvPath = path.join(args.repo, "TASKS.csv");
  const tasks = records(await readFile(csvPath, "utf8"));
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const statusById = new Map(tasks.map((task) => [task.id, task.status]));
  const missingTaskIds = args.taskIds.filter((id) => !byId.has(id));
  const statusCounts = Object.fromEntries([...new Set(tasks.map((task) => task.status))].sort().map((status) => [status, tasks.filter((task) => task.status === status).length]));
  const ready = tasks.filter((task) => task.status === "待办" && dependencyIds(task.dependencies).every((id) => statusById.get(id) === "已完成"));
  const priorityRank = new Map([["P0", 0], ["P1", 1], ["P2", 2], ["P3", 3]]);
  ready.sort((left, right) => (priorityRank.get(left.priority) ?? 99) - (priorityRank.get(right.priority) ?? 99) || left.id.localeCompare(right.id));
  const postureIds = tasks
    .filter((task) => ["进行中", "待确认", "受阻"].includes(task.status))
    .map((task) => task.id);
  const readyIds = ready.slice(0, args.maxReady).map((task) => task.id);
  const selectedIds = [...new Set([...args.taskIds, ...postureIds, ...readyIds])];
  const detailIds = [...new Set([...args.taskIds, ...postureIds])];
  const details = [];
  for (const id of detailIds) {
    const task = byId.get(id);
    if (!task?.detail_path) continue;
    const detailPath = path.resolve(args.repo, task.detail_path);
    try {
      if (args.init && Date.now() >= deadline) throw new Error("initialization budget exhausted");
      const markdown = await readFile(detailPath, "utf8");
      const sections = parseSections(markdown);
      const entries = Object.entries(sections);
      const first = (pattern) => entries.find(([heading]) => pattern.test(heading))?.[1];
      const latest = (pattern) => entries.filter(([heading]) => pattern.test(heading)).at(-1)?.[1];
      const structuredLog = parseTaskLog(markdown);
      const logSummary = structuredLog.mode === 'structured'
        ? '## 任务日志\n' + (structuredLog.errors.length ? '日志格式错误：'+structuredLog.errors.join('；') : structuredLog.events.slice(0,3).map(e=>`${e.at===null?'发生时间未知；补记 '+e.recorded_at:e.at}｜${e.actor}｜${e.type}｜${e.title}｜${e.result||''}｜${e.detail}`).join('\n'))
        : '';
      const logEntry = entries.find(([heading]) => heading === "任务日志");
      const recent = entries.slice(-2).map(([heading, body]) => `## ${heading}\n${body}`).join("\n\n");
      details.push({
        id,
        path: detailPath,
        ...(args.init ? { latestSection: logSummary ? bounded(logSummary, 700) : sectionTail(logEntry || entries.at(-1), markdown, 700) } : {}),
        objective: bounded(first(/^目标/), args.compact ? 700 : 1800),
        outcome: bounded(latest(/成果|验收|核对|复审/), args.compact ? 700 : 3200),
        blockers: bounded(latest(/阻塞|阻碍|暂停|待答|决策/), args.compact ? 1000 : 3200),
        recentProcess: logSummary ? bounded(logSummary, args.compact ? 1600 : 4000) : logEntry
          ? sectionTail(logEntry, markdown, args.compact ? 1600 : 4000)
          : boundedTail(recent || markdown, args.compact ? 1600 : 4000),
      });
    } catch (error) {
      details.push({ id, path: detailPath, error: error.message });
    }
  }

  const gitHead = run("git", ["log", "-1", "--format=%H%n%s"], { cwd: args.repo });
  const gitStatus = run("git", ["status", "--porcelain=v2", "--branch"], { cwd: args.repo, maxChars: args.compact ? 1800 : 12_000 });
  const gitWorktrees = args.init ? { skipped: true, reason: "not required for initialization" } : run("git", ["worktree", "list", "--porcelain"], { cwd: args.repo });

  // 宿主状态目录：显式 PROJECT_MANAGER_HOST_HOME → DSH_HOME → CODEX_HOME → 默认 ~/.codex。
  const codexHome = process.env.PROJECT_MANAGER_HOST_HOME || process.env.CODEX_HOME || process.env.DSH_HOME || path.join(os.homedir(), '.codex');
  const runtimePath = path.resolve(process.env.CODEX_SESSION_RUNTIME_CSV || path.join(serverStateDir(), "session-runtime.csv"));
  let runtime = { path: runtimePath, present: false, sessions: [] };
  try {
    const runtimeTasks = new Set(selectedIds.flatMap((id) => {
      const task = byId.get(id) || {};
      return [task.execution_thread_id, task.manager_thread_id].filter(Boolean);
    }));
    const runtimeRows = records(await readFile(runtimePath, "utf8"));
    runtime = {
      path: runtimePath,
      present: true,
      sessions: runtimeRows.filter((row) => runtimeTasks.has(row.session_id)),
    };
  } catch (error) {
    runtime.error = error.message;
  }

  runtime.claims=selectedIds.map(id=>{const task=byId.get(id)||{},samples=runtime.sessions.filter(r=>r.session_id===task.execution_thread_id);return {task_id:id,business_status:task.status??'unknown',...cachedRuntimeClaim(samples.length===1?samples[0]:null,{route:task.execution_thread_id,turn:task.execution_turn_id})};});
  runtime.workerCoordination={mode:'legacy-manual',automatic_wake:false,reconciled:false};
  if(args.workerConfig){
    try{
      const {readWorkerConfig,scanWorkerClaims}=await import('./core/worker-client.mjs');const c=await readWorkerConfig(path.resolve(args.workerConfig));
      if((c.mode==='legacy-compat'?path.resolve(c.legacy_root):path.resolve(c.control_repo))!==path.resolve(args.repo))throw new Error('worker project mismatch');
      const entries=selectedIds.map(id=>({config:c,work:id,dispatch:byId.get(id)?.dispatch_id})).filter(e=>e.dispatch);
      const remaining=args.init?Math.max(1,deadline-Date.now()):args.budgetMs;
      const scan=await scanWorkerClaims(entries,{maxProjects:64,budgetMs:Math.min(30000,remaining)});
      runtime.claims=selectedIds.map(id=>{const index=entries.findIndex(e=>e.work===id);return {task_id:id,business_status:byId.get(id)?.status??'unknown',...(index<0?{runtime:'unknown',running:false,reconcile_failed:true,reason:'dispatch-unregistered'}:scan.results[index])};});
      runtime.workerCoordination={mode:c.mode,automatic_wake:false,reconciled:true,coverage_complete:scan.coverage_complete&&entries.length===selectedIds.length,healthy:scan.healthy&&entries.length===selectedIds.length};
    }catch{runtime.claims=selectedIds.map(id=>({task_id:id,business_status:byId.get(id)?.status??'unknown',runtime:'unknown',running:false,reconcile_failed:true}));runtime.workerCoordination={mode:'unavailable',automatic_wake:false,reconciled:false};}
  }

  const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
  // DSH 没有 Codex Hook：跳过检查并说明，避免把“缺 Hook”当成观察异常。
  const hostIsDsh = Boolean(process.env.DSH_HOME) && !process.env.CODEX_HOME;
  const hookCheck = !args.hook
    ? { skipped: true }
    : hostIsDsh
      ? { skipped: true, reason: "DSH host: no Codex lifecycle Hook; write session-runtime.csv explicitly if needed" }
      : run(process.env.PM_SERVER_BIN || "pm-server", ["adapter", "check", "codex"], { cwd: args.repo });

  const skillValidator = path.join(scriptsDir, "validate_tasks.py");
  const validatorPath = existsSync(skillValidator) ? skillValidator : "";
  const validation = args.validate && validatorPath
    ? { path: validatorPath, ...run("python3", [validatorPath, args.repo], { cwd: args.repo, timeout: 60_000 }) }
    : { skipped: true, reason: args.validate ? "validator not found" : "disabled" };

  const watchKey = createHash("sha256").update(args.repo).digest("hex").slice(0, 16);
  const watchLock = path.join(os.tmpdir(), `codex-project-manager-watch-${watchKey}.lock`);
  let watch = { lockPath: watchLock, runningHint: false };
  try {
    const metadata = await stat(watchLock);
    watch = { lockPath: watchLock, runningHint: true, modifiedAt: metadata.mtime.toISOString() };
  } catch {}

  const selected = tasks.filter((task) => selectedIds.includes(task.id)).map((task) => taskSummary(task, statusById));
  const projectConfig = await loadProjectConfig(args.repo);
  if (!projectConfig.ok) throw new Error(projectConfig.errors.join("; "));
  // Git is optional for an explicitly initialized directory.
  for (const check of [gitHead, gitStatus]) if (!check.ok && /not a git repository/i.test(check.stderr || "")) check.skipped = true;
  const output = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    repository: {
      root: args.repo,
      head: gitHead,
      status: gitStatus,
      worktrees: gitWorktrees,
    },
    taskSystem: {
      csvPath,
      total: tasks.length,
      statusCounts,
      missingTaskIds,
      active: tasks.filter((task) => task.status === "进行中").map((task) => task.id),
      confirm: tasks.filter((task) => task.status === "待确认").map((task) => task.id),
      blocked: tasks.filter((task) => task.status === "受阻").map((task) => task.id),
      ready: readyIds,
      readyTotal: ready.length,
      selected,
      details,
      validation,
    },
    runtime,
    hookCheck,
    watch:{...watch,runningHintIsRuntimeEvidence:false},
    projectManager: projectConfig.config.manager || null,
    registeredManagerThreadIds: [...new Set([projectConfig.config.manager?.threadId, ...tasks.map(task => task.manager_thread_id)].filter(Boolean))],
    routeIssues: tasks.filter(task => task.status === "进行中").flatMap(task => [
      ...(!task.manager_thread_id ? [{taskId:task.id,reason:"manager_route_missing"}] : []),
      ...(!task.execution_thread_id ? [{taskId:task.id,reason:"execution_route_missing"}] : []),
      ...(!task.dispatch_id ? [{taskId:task.id,reason:"dispatch_identity_missing"}] : []),
    ]),
    nextThreadReads: [...new Set(selected.map((task) => task.executionThreadId).filter(Boolean))],
  };
  if (args.init) {
    output.mode = "init";
    output.repository.status = { ...gitStatus, stdout: undefined, dirty: Boolean(gitStatus.stdout.split("\n").filter((line) => line && !line.startsWith("#")).length) };
    output.taskSystem.details = details.map((detail) => ({ id: detail.id, path: detail.path, error: detail.error, blockers: bounded(detail.blockers, 500), latest: detail.latestSection }));
    output.checkFailures = [gitHead, gitStatus, validation].filter((check) => !check.ok && !check.skipped).map((check) => check.error || check.stderr || `exit ${check.status}`);
    output.budgetExceeded = Date.now() >= deadline;
  }
  console.log(JSON.stringify(output, null, args.init ? 0 : 2));
  if (missingTaskIds.length || !validation.ok && !validation.skipped || args.init && (output.checkFailures.length || output.budgetExceeded)) process.exitCode = 2;
}

main().catch((error) => {
  console.error(JSON.stringify({ schemaVersion: 1, error: error.message }));
  process.exitCode = 1;
});
