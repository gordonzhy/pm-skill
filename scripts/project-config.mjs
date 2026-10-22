#!/usr/bin/env node

import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectConfig, resolveProjectPaths } from "./project-config-v2.mjs";

const modelKinds = ["ROUTINE", "COMPLEX", "HIGH_RISK"];
const keys = new Set([
  "PROJECT_MANAGER_PMO_THREAD_ID",
  ...modelKinds.flatMap((kind) => [`PROJECT_MANAGER_MODEL_${kind}`, `PROJECT_MANAGER_REASONING_${kind}`]),
]);
const reasoningValues = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);

function valueOf(raw, key) {
  let value = raw.trim();
  if (value.startsWith('"') || value.startsWith("'")) {
    const quote = value[0];
    const end = value.lastIndexOf(quote);
    if (end < 1 || value.slice(end + 1).trim() && !value.slice(end + 1).trim().startsWith("#")) {
      throw new Error(`.env 中 ${key} 的引号不完整`);
    }
    value = value.slice(1, end);
  } else {
    value = value.replace(/\s+#.*$/, "").trim();
  }
  return value;
}

export function defaultDashboardPort() {
  return 9999;
}

export async function readProjectConfig(repository) {
  const root = path.resolve(repository);
  const file = path.join(root, ".env");
  let source = "";
  try { source = await readFile(file, "utf8"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }

  const values = new Map();
  let pmoBindingError = null;
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || !keys.has(match[1])) continue;
    const key = match[1];
    if (values.has(key)) {
      if (key === "PROJECT_MANAGER_PMO_THREAD_ID") { pmoBindingError = "PMO绑定重复定义"; continue; }
      throw new Error(`.env 第 ${index + 1} 行重复定义 ${key}`);
    }
    if (key === "PROJECT_MANAGER_PMO_THREAD_ID") {
      try { values.set(key, valueOf(match[2], key)); }
      catch { pmoBindingError = "PMO绑定引号不完整"; values.set(key, ""); }
    } else { values.set(key, valueOf(match[2], key)); }
  }

  // 项目级配置是单一入口：工作台端口优先取 project-manager.config.json，
  // 缺失或无效时退回默认 9999 并在 projectConfigError 中报告，不让模型/PMO 字段失效。
  const loaded = await loadProjectConfig(root);
  let port = defaultDashboardPort();
  let portSource = "default";
  let projectConfigError = null;
  let projectConfig = null;
  let resolvedPaths = null;
  if (loaded.found) {
    if (loaded.ok) {
      projectConfig = loaded.config;
      resolvedPaths = resolveProjectPaths(loaded.config, root);
      port = loaded.config.workbench.port;
      portSource = "project-config";
    } else {
      projectConfigError = `project-manager.config.json 无效：${loaded.errors.join("；")}`;
    }
  }

  const models = {};
  for (const kind of modelKinds) {
    const model = values.get(`PROJECT_MANAGER_MODEL_${kind}`) || "";
    const reasoning = values.get(`PROJECT_MANAGER_REASONING_${kind}`) || "";
    if (model && (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(model) || model.length > 128)) {
      throw new Error(`.env 中 PROJECT_MANAGER_MODEL_${kind} 的模型名无效`);
    }
    if (reasoning && !reasoningValues.has(reasoning)) {
      throw new Error(`.env 中 PROJECT_MANAGER_REASONING_${kind} 的强度无效`);
    }
    models[kind.toLowerCase()] = { model: model || null, reasoning: reasoning || null };
  }
  let pmoThreadId = values.get("PROJECT_MANAGER_PMO_THREAD_ID") || null;
  // Codex UUID 与 DSH 的 session-/teammate:/subagent: 都作为有效绑定。
  if (pmoThreadId && !/^(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|session-[A-Za-z0-9._-]+|teammate:[A-Za-z0-9._-]+|subagent:[A-Za-z0-9._-]+)$/i.test(pmoThreadId)) {
    pmoBindingError = "PMO绑定不是有效会话标识（Codex UUID 或 session-/teammate:/subagent:）";
  }
  if (pmoBindingError) pmoThreadId = null;
  return {
    pmoThreadId,
    pmoBindingError,
    port,
    portSource,
    models,
    projectConfigPath: loaded.found ? loaded.path : null,
    projectConfigError,
    projectConfig,
    csvPath: resolvedPaths ? resolvedPaths.csvPath : path.join(root, "TASKS.csv"),
    detailsDir: resolvedPaths ? resolvedPaths.detailsDir : path.join(root, "work-items"),
    workbenchStateDir: resolvedPaths ? resolvedPaths.workbenchStateDir : null,
  };
}

// process.argv[1] 保留调用时的字面路径，import.meta.url 已被 Node 解析为 realpath；
// 比较前统一取真实路径，否则经符号链接路径调用（安装副本、/tmp 软链等）时 CLI 分支不执行。
async function isMainEntry() {
  if (!process.argv[1]) return false;
  try {
    return (await realpath(process.argv[1])) === (await realpath(fileURLToPath(import.meta.url)));
  } catch {
    return false;
  }
}
if (await isMainEntry()) {
  const index = process.argv.indexOf("--repo");
  if (index < 0 || !process.argv[index + 1]) throw new Error("--repo <repository-root> is required");
  process.stdout.write(`${JSON.stringify(await readProjectConfig(process.argv[index + 1]))}\n`);
}
