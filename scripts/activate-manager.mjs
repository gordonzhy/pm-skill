#!/usr/bin/env node

import { readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {createHash} from "node:crypto";
import {loadProjectConfig, normalizeProjectConfig, formatProjectConfig} from "./project-config-v2.mjs";
import { acquireProcessLock, runtimeLockPath } from "./process-lock.mjs";

const args = new Map();
for(let i=2;i<process.argv.length;i++){
 const key=process.argv[i];
 if(key==='--resume-existing')args.set(key,true);
 else if(['--repo','--manager-thread'].includes(key)&&process.argv[i+1]&&!process.argv[i+1].startsWith('--'))args.set(key,process.argv[++i]);
 else throw new Error('Unknown option or missing argument');
}
const resumeExisting=args.has('--resume-existing');
const identity=value=>{
 if(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value||''))return JSON.stringify(['codex',process.env.PM_SERVER_INSTANCE||'default',value.toLowerCase()]);
 try{const parts=(value||'').split(':').map(decodeURIComponent);if(parts.length===3&&['codex','claude-code','dsh'].includes(parts[0]))return JSON.stringify(parts.map((p,i)=>i===2&&parts[0]==='codex'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(p)?p.toLowerCase():p));}catch{}
 if(/^(?:session-|teammate:|subagent:)/.test(value||''))return JSON.stringify(['dsh',process.env.PM_SERVER_INSTANCE||'default',value]);
 return value;
};
const sameIdentity=(a,b)=>!!a&&!!b&&identity(a)===identity(b);
const repository = await realpath(path.resolve(args.get("--repo") || process.cwd()));
const manager = args.get("--manager-thread");
if (!/^(?:(?:codex|claude-code|dsh):[A-Za-z0-9%._~-]+:[A-Za-z0-9%._~-]+|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|session-[A-Za-z0-9._-]+|teammate:[A-Za-z0-9._-]+|subagent:[A-Za-z0-9._-]+)$/i.test(manager || "")) throw new Error("--manager-thread requires the current thread ID (Codex UUID or DSH session-/teammate:/subagent: identifier)");
const csvPath = path.join(repository, "TASKS.csv");
const lockPath = await runtimeLockPath(repository);

function parseCsv(source) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quoted) {
      if (c === '"' && source[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field.replace(/\r$/, "")); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (quoted) throw new Error("unterminated quoted CSV field");
  if (field || row.length) { row.push(field.replace(/\r$/, "")); rows.push(row); }
  return rows;
}

function encodeCsv(rows) {
  const encode = (value) => /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  return `${rows.map((row) => row.map(encode).join(",")).join("\n")}\n`;
}

const lock = await acquireProcessLock(lockPath, {timeoutMs: 2000});
try {
  const metadata = await stat(csvPath);
  const rows = parseCsv(await readFile(csvPath, "utf8"));
  const headers = rows[0] || [];
  const fields = ["id", "status", "manager_thread_id", "modified_at", "recovery_turn_id", "recovery_state", "recovery_state_at"];
  const col = Object.fromEntries(fields.map((field) => [field, headers.indexOf(field)]));
  for (const field of fields) if (col[field] < 0) throw new Error(`TASKS.csv missing ${field}`);
  for (const row of rows.slice(1)) if (row.length !== headers.length) throw new Error("TASKS.csv has a malformed row");
  const loaded = await loadProjectConfig(repository);
  if (!loaded.ok) throw new Error(loaded.errors.join("; "));
  const prefix = rows[1]?.[headers.indexOf("id")]?.match(/^([A-Z][A-Z0-9]*)-/)?.[1]
    || "PM" + createHash("sha256").update(repository).digest("hex").slice(0, 6).toUpperCase();
  const config = loaded.found ? loaded.config : normalizeProjectConfig({...loaded.config, project:{...loaded.config.project, name:path.basename(repository), prefix}});
  const projectChanged = resumeExisting?!sameIdentity(config.manager?.threadId,manager):config.manager?.threadId !== manager;
  const previous = [...new Set(rows.slice(1).map((row) => row[col.manager_thread_id]).filter(Boolean))];
  const resumeConflict=resumeExisting&&config.manager?.threadId&&!sameIdentity(config.manager.threadId,manager);
  const ownershipUnverified=resumeExisting&&!config.manager?.threadId&&(new Set(previous.map(identity)).size!==1||!previous.some(id=>sameIdentity(id,manager)));
  if(resumeConflict||ownershipUnverified){
   console.log(JSON.stringify({state:resumeConflict?'MANAGER_CHANGED':'OWNERSHIP_UNVERIFIED',verified:false,changed:0,projectChanged:false}));
   process.exitCode=3;
  }else{
  const resolvedManager=resumeExisting?(config.manager?.threadId||manager):manager;
  const changedTaskIds=[],skippedTaskIds=[];
  let changed = 0;
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  for (const row of rows.slice(1)) {
    if(resumeExisting&&!['进行中','待确认'].includes(row[col.status]))continue;
    if(resumeExisting&&['monitor_pause_until','monitor_pause_reason','monitor_pause_scope'].some(field=>headers.includes(field)&&row[headers.indexOf(field)])){skippedTaskIds.push(row[col.id]);continue;}
    if(resumeExisting?sameIdentity(row[col.manager_thread_id],resolvedManager):row[col.manager_thread_id]===resolvedManager)continue;
    row[col.manager_thread_id] = resolvedManager;
    changedTaskIds.push(row[col.id]);
    row[col.modified_at] = now;
    if (!resumeExisting && row[col.status] === "进行中") {
      row[col.recovery_turn_id] = "";
      row[col.recovery_state] = "";
      row[col.recovery_state_at] = "";
    }
    changed++;
  }
  if (changed) {
    const temporary = path.join(repository, `.TASKS.manager-${process.pid}-${Date.now()}.tmp`);
    await writeFile(temporary, encodeCsv(rows), { mode: metadata.mode & 0o777 });
    await rename(temporary, csvPath);
  }
  if (projectChanged) {
    config.manager = {threadId:resolvedManager, registeredAt:now};
    const temporary = path.join(repository, `.manager-config-${process.pid}.tmp`);
    await writeFile(temporary, formatProjectConfig(config));
    await rename(temporary, loaded.path);
  }
  const verified = await loadProjectConfig(repository);
  if (!verified.ok || !sameIdentity(verified.config.manager?.threadId,resolvedManager)) throw new Error("project manager read-back verification failed");
  const reread=parseCsv(await readFile(csvPath,'utf8'));
  if(changedTaskIds.some(id=>!reread.slice(1).some(row=>row[col.id]===id&&sameIdentity(row[col.manager_thread_id],resolvedManager))))throw new Error('task manager read-back verification failed');
  console.log(JSON.stringify({state:resumeExisting?(changed||projectChanged?'REPAIRED':'ALREADY_ALIGNED'):'ACTIVATED',manager:resolvedManager, previous, changed,changedTaskIds,skippedTaskIds,projectChanged, projectManager:verified.config.manager, verified:true }));
  }
} finally {
  await lock.release();
}
