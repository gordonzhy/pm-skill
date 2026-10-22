#!/usr/bin/env node
/**
 * 项目级配置 `project-manager.config.json` 的单一读取/校验入口（configVersion 1）。
 *
 * 为什么是 JSON 而不是 YAML：
 * - 零第三方依赖：Node 内置 JSON.parse 即可读取，Python 侧也能独立解析；YAML 需要
 *   额外解析器（本技能只 vendored 了浏览器用的 js-yaml），会给 CLI/校验器增加一条
 *   新的运行时依赖。
 * - 可被 JSON Schema 直接约束，编辑器与 CI 都能做结构校验。
 * - 项目级配置只放“项目身份 + 任务文件位置 + 工作台默认值”，不需要注释和复杂结构；
 *   人类可读性由 init 生成的模板与 AGENTS 片段补足。
 *
 * 兼容边界：既有 `.env` 白名单（模型/PMO）继续由 project-config.mjs 读取；本文件
 * 不解析 `.env`，也不把 `.env` 的值写回项目配置。项目配置只作为“单一入口”，
 * 同一字段不再在 `.env` 重复定义（工作台端口以项目配置为准）。
 */
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_CONFIG_FILENAME = "project-manager.config.json";
export const CONFIG_VERSION = 1;
/** 与 validate_tasks.py / generate_tasks.py 的词表保持一致。 */
export const DEFAULT_STATUSES = Object.freeze([
  "待办",
  "进行中",
  "待确认",
  "受阻",
  "已完成",
  "已取消",
]);
export const DEFAULT_TASK_CSV = "TASKS.csv";
export const DEFAULT_DETAILS_DIR = "work-items";
export const DEFAULT_WORKBENCH_PORT = 9999;
export const DEFAULT_PROJECT_GROUP = "未分组";
export const MAX_NAME_LENGTH = 100;

const PREFIX_RE = /^[A-Z][A-Z0-9]*$/;
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;
const TOP_LEVEL_KEYS = new Set(["configVersion", "project", "taskSystem", "workbench", "manager"]);
const PROJECT_KEYS = new Set(["name", "prefix", "group"]);
const TASK_SYSTEM_KEYS = new Set(["csv", "detailsDir", "statuses"]);
const WORKBENCH_KEYS = new Set(["port", "stateDir"]);

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function displayNameValid(value) {
  return (
    typeof value === "string"
    && value.trim() !== ""
    && value.trim().length <= MAX_NAME_LENGTH
    && !CONTROL_CHARS_RE.test(value)
  );
}

function isSafeRelativePath(value) {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\\")) return false;
  if (path.isAbsolute(value) || value.includes("\u0000")) return false;
  const parts = value.split("/");
  return parts.every((part) => part !== "" && part !== "." && part !== "..");
}

function isAbsolutePath(value) {
  return typeof value === "string" && value.trim() !== "" && !value.includes("\u0000") && path.isAbsolute(value);
}

/** 默认项目配置（每次返回新对象，避免调用方共享可变状态）。 */
export function defaultProjectConfig() {
  return {
    configVersion: CONFIG_VERSION,
    project: {
      name: "",
      prefix: "",
      group: DEFAULT_PROJECT_GROUP,
    },
    taskSystem: {
      csv: DEFAULT_TASK_CSV,
      detailsDir: DEFAULT_DETAILS_DIR,
      statuses: [...DEFAULT_STATUSES],
    },
    workbench: {
      port: DEFAULT_WORKBENCH_PORT,
    },
  };
}

/**
 * 校验项目配置并返回填入默认值后的规范对象。
 * 纯函数：不读文件、不抛异常；调用方据 `ok`/`errors` 决定报错或降级。
 * @param {unknown} input
 * @returns {{ok: boolean, errors: string[], config: ReturnType<typeof defaultProjectConfig>}}
 */
export function validateProjectConfig(input) {
  const errors = [];
  const config = defaultProjectConfig();
  if (!isPlainObject(input)) {
    return { ok: false, errors: ["配置根必须是 JSON 对象"], config };
  }
  for (const key of Object.keys(input)) {
    if (!TOP_LEVEL_KEYS.has(key)) errors.push(`未知字段：${key}`);
  }
  if (input.configVersion !== CONFIG_VERSION) {
    errors.push(`configVersion 必须为 ${CONFIG_VERSION}（当前：${JSON.stringify(input.configVersion)}）`);
  }

  if (!isPlainObject(input.project)) {
    errors.push("project 必须是对象");
  } else {
    for (const key of Object.keys(input.project)) {
      if (!PROJECT_KEYS.has(key)) errors.push(`未知字段：project.${key}`);
    }
    if (!displayNameValid(input.project.name)) {
      errors.push(`project.name 必须是 1–${MAX_NAME_LENGTH} 个字符且不含控制字符`);
    } else {
      config.project.name = input.project.name.trim();
    }
    if (typeof input.project.prefix !== "string" || !PREFIX_RE.test(input.project.prefix)) {
      errors.push("project.prefix 必须匹配 ^[A-Z][A-Z0-9]*$（大写字母开头，仅大写字母与数字，不含连字符）");
    } else {
      config.project.prefix = input.project.prefix;
    }
    if (input.project.group !== undefined) {
      if (!displayNameValid(input.project.group)) {
        errors.push(`project.group 必须是 1–${MAX_NAME_LENGTH} 个字符且不含控制字符`);
      } else {
        config.project.group = input.project.group.trim();
      }
    }
  }

  if (!isPlainObject(input.taskSystem)) {
    errors.push("taskSystem 必须是对象");
  } else {
    for (const key of Object.keys(input.taskSystem)) {
      if (!TASK_SYSTEM_KEYS.has(key)) errors.push(`未知字段：taskSystem.${key}`);
    }
    if (input.taskSystem.csv !== DEFAULT_TASK_CSV) {
      errors.push(`taskSystem.csv 在 configVersion ${CONFIG_VERSION} 中固定为 "${DEFAULT_TASK_CSV}"（工作台与校验器以该文件为唯一入口）`);
    }
    if (!isSafeRelativePath(input.taskSystem.detailsDir)) {
      errors.push("taskSystem.detailsDir 必须是仓库内相对 POSIX 路径（不含反斜杠、空段、. 或 ..）");
    } else {
      config.taskSystem.detailsDir = input.taskSystem.detailsDir;
    }
    if (input.taskSystem.statuses !== undefined) {
      const statuses = input.taskSystem.statuses;
      const valid = Array.isArray(statuses)
        && statuses.length === DEFAULT_STATUSES.length
        && new Set(statuses).size === DEFAULT_STATUSES.length
        && DEFAULT_STATUSES.every((status) => statuses.includes(status));
      if (!valid) {
        errors.push(`taskSystem.statuses 在 configVersion ${CONFIG_VERSION} 中固定为 ${DEFAULT_STATUSES.join("/")}（顺序可变，不能增删）`);
      } else {
        config.taskSystem.statuses = [...statuses];
      }
    }
  }

  if (input.workbench !== undefined) {
    if (!isPlainObject(input.workbench)) {
      errors.push("workbench 必须是对象");
    } else {
      for (const key of Object.keys(input.workbench)) {
        if (!WORKBENCH_KEYS.has(key)) errors.push(`未知字段：workbench.${key}`);
      }
      if (input.workbench.port !== undefined) {
        const port = input.workbench.port;
        if (!Number.isInteger(port) || port < 0 || port > 65535) {
          errors.push("workbench.port 必须是 0–65535 的整数（0 仅用于隔离测试的随机端口）");
        } else {
          config.workbench.port = port;
        }
      }
      if (input.workbench.stateDir !== undefined) {
        if (!isSafeRelativePath(input.workbench.stateDir) && !isAbsolutePath(input.workbench.stateDir)) {
          errors.push("workbench.stateDir 必须是非空相对 POSIX 路径或绝对路径");
        } else {
          config.workbench.stateDir = input.workbench.stateDir;
        }
      }
    }
  }

  if (input.manager !== undefined) {
    const manager = input.manager;
    if (!isPlainObject(manager) || Object.keys(manager).some(key => !["threadId", "registeredAt"].includes(key))
        || typeof manager.threadId !== "string" || !/^(?:(?:codex|claude-code|dsh):[A-Za-z0-9%._~-]+:[A-Za-z0-9%._~-]+|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|session-[A-Za-z0-9._-]+|teammate:[A-Za-z0-9._-]+|subagent:[A-Za-z0-9._-]+)$/i.test(manager.threadId)
        || typeof manager.registeredAt !== "string" || !Number.isFinite(Date.parse(manager.registeredAt))) {
      errors.push("manager 必须包含有效的真实 threadId 和 registeredAt 时间");
    } else config.manager = {...manager};
  }
  return { ok: errors.length === 0, errors, config };
}

/** 规范化失败时抛错；成功返回规范配置。供 init 等“必须有效”的写路径使用。 */
export function normalizeProjectConfig(input) {
  const { ok, errors, config } = validateProjectConfig(input);
  if (!ok) throw new Error(`项目配置无效：${errors.join("；")}`);
  return config;
}

/** 稳定序列化：字段顺序固定，便于 diff 与幂等比较。 */
export function formatProjectConfig(config) {
  const normalized = normalizeProjectConfig(config);
  const ordered = {
    configVersion: normalized.configVersion,
    project: {
      name: normalized.project.name,
      prefix: normalized.project.prefix,
      group: normalized.project.group,
    },
    taskSystem: {
      csv: normalized.taskSystem.csv,
      detailsDir: normalized.taskSystem.detailsDir,
      statuses: normalized.taskSystem.statuses,
    },
    workbench: {
      port: normalized.workbench.port,
    },
  };
  if (normalized.workbench.stateDir !== undefined) {
    ordered.workbench.stateDir = normalized.workbench.stateDir;
  }
  if (normalized.manager) ordered.manager = normalized.manager;
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/** 把项目配置解析为仓库内绝对路径；不访问文件系统以外状态。 */
export function resolveProjectPaths(config, repository) {
  const normalized = normalizeProjectConfig(config);
  const root = path.resolve(repository);
  return {
    root,
    configPath: path.join(root, PROJECT_CONFIG_FILENAME),
    csvPath: path.join(root, normalized.taskSystem.csv),
    detailsDir: path.resolve(root, normalized.taskSystem.detailsDir),
    workbenchPort: normalized.workbench.port,
    workbenchStateDir: normalized.workbench.stateDir === undefined
      ? null
      : path.resolve(root, normalized.workbench.stateDir),
  };
}

/**
 * 读取仓库的项目配置。文件缺失是正常状态（返回默认值 + found:false）；
 * 语法/结构错误不抛，交给调用方决定降级还是报错。
 * @param {string} repository
 */
export async function loadProjectConfig(repository) {
  const root = path.resolve(repository);
  const file = path.join(root, PROJECT_CONFIG_FILENAME);
  let source;
  try {
    source = await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return { found: false, ok: true, path: file, config: defaultProjectConfig(), errors: [] };
    }
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    return {
      found: true,
      ok: false,
      path: file,
      config: defaultProjectConfig(),
      errors: [`JSON 解析失败：${error.message}`],
    };
  }
  const { ok, errors, config } = validateProjectConfig(parsed);
  return { found: true, ok, path: file, config, errors };
}

// process.argv[1] 保留调用时的字面路径，import.meta.url 已被 Node 解析为 realpath；
// 比较前统一取真实路径，否则经符号链接路径调用（安装副本等）时 CLI 分支不执行。
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
  if (index < 0 || !process.argv[index + 1]) {
    console.error("用法：node project-config-v2.mjs --repo <repository-root>");
    process.exitCode = 2;
  } else {
    const loaded = await loadProjectConfig(process.argv[index + 1]);
    const payload = {
      path: loaded.path,
      found: loaded.found,
      ok: loaded.ok,
      errors: loaded.errors,
      config: loaded.config,
      resolved: loaded.ok && loaded.found ? resolveProjectPaths(loaded.config, process.argv[index + 1]) : null,
    };
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    if (!loaded.ok) process.exitCode = 1;
  }
}
