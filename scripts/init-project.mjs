#!/usr/bin/env node
/**
 * `pm init`：从一个空目录生成可用的 project-manager 项目任务系统。
 *
 * 生成物（宿主无关，Codex / DSH / 任何能跑 Node+Python 的环境共用同一 CLI）：
 *   - --empty 创建空账本；默认保留演示初始化兼容行为。
 *   - TASKS.csv（标准 18 列）
 *   - <detailsDir>/<PREFIX>-001.md（含合法结构化任务日志的示例任务卡）
 *   - TASKS.html（调用技能自带 generate_tasks.py）
 *   - project-manager.config.json（单一项目配置）
 *   - AGENTS.md 片段（已有文件则追加带标记的段落）
 *
 * 幂等与安全：
 *   - 已有 TASKS.csv 时不做任何修改，输出 ALREADY_INITIALIZED（退出码 0）。
 *   - 其他生成物已存在时不覆盖，提示使用 --force。
 *   - --force 先备份到 <repo>/.project-manager/init-backup/<时间戳>/ 再覆盖。
 *   - 先在临时目录生成并跑 generate_tasks.py + validate_tasks.py；校验失败时回滚，
 *     仓库里不留半成品。
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_DETAILS_DIR,
  DEFAULT_PROJECT_GROUP,
  DEFAULT_STATUSES,
  DEFAULT_TASK_CSV,
  DEFAULT_WORKBENCH_PORT,
  PROJECT_CONFIG_FILENAME,
  formatProjectConfig,
  loadProjectConfig,
  normalizeProjectConfig,
} from "./project-config-v2.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(SCRIPT_DIR, "..");
const CSV_HEADERS = [
  "id", "status", "priority", "boundary", "title", "dependencies", "executor",
  "created_at", "modified_at", "detail_path", "dispatch_id", "execution_thread_id",
  "execution_turn_id", "manager_thread_id", "manager_turn_id", "recovery_turn_id",
  "recovery_state", "recovery_state_at",
];
const EXAMPLE_TITLE = "示例任务：替换为真实需求";
const EXAMPLE_PRIORITY = "P1";
const EXAMPLE_BOUNDARY = "工程基础";
const EXAMPLE_EXECUTOR = "待派发";
const AGENTS_BEGIN = "<!-- project-manager:begin -->";
const AGENTS_END = "<!-- project-manager:end -->";
const USAGE = [
  "用法：node init-project.mjs --repo <目录> --prefix <前缀> [--name <项目名>] [--group <分组>]",
  "       [--port <端口>] [--details-dir <目录>] [--python <解释器>] [--empty] [--force] [--skip-validate] [--json]",
  "",
  "示例：node init-project.mjs --repo ./my-project --prefix MY --name \"我的项目\" --group 研发",
].join("\n");

class InitError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.exitCode = exitCode;
  }
}

function parseArgs(argv) {
  const options = {
    force: false,
    json: false,
    skipValidate: false,
    python: process.env.PROJECT_MANAGER_PYTHON || "python3",
  };
  const takeValue = (flag, index) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new InitError(`${flag} 需要一个值`);
    return value;
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo") options.repo = takeValue(arg, index++);
    else if (arg === "--name") options.name = takeValue(arg, index++);
    else if (arg === "--prefix") options.prefix = takeValue(arg, index++);
    else if (arg === "--group") options.group = takeValue(arg, index++);
    else if (arg === "--port") options.port = takeValue(arg, index++);
    else if (arg === "--details-dir") options.detailsDir = takeValue(arg, index++);
    else if (arg === "--python") options.python = takeValue(arg, index++);
    else if (arg === "--empty") options.empty = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "--skip-validate") options.skipValidate = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new InitError(`未知参数：${arg}\n\n${USAGE}`);
  }
  return options;
}

function nowIso(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    + `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

function encodeCsv(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvRow(fields) {
  return fields.map(encodeCsv).join(",");
}

async function pathExists(target) {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

/** 在临时目录里运行 Python 脚本；返回结构化结果而不是抛进程异常。 */
function runPython(python, args, { cwd, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(python, args, {
      cwd,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    timer.unref?.();
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, exitCode: null, stdout, stderr, error: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, exitCode: code, stdout, stderr, error: null });
    });
  });
}

function tail(text, limit = 4_000) {
  const value = String(text ?? "").trim();
  return value.length <= limit ? value : `…（前文已截断）\n${value.slice(-limit)}`;
}

function buildConfig(options, repository) {
  return normalizeProjectConfig({
    configVersion: 1,
    project: {
      name: options.name || path.basename(repository) || "未命名项目",
      prefix: options.prefix,
      group: options.group || DEFAULT_PROJECT_GROUP,
    },
    taskSystem: {
      csv: DEFAULT_TASK_CSV,
      detailsDir: options.detailsDir || DEFAULT_DETAILS_DIR,
      statuses: [...DEFAULT_STATUSES],
    },
    workbench: {
      port: options.port === undefined ? DEFAULT_WORKBENCH_PORT : Number(options.port),
    },
  });
}

function taskIdFor(config) {
  return `${config.project.prefix}-001`;
}

function taskDetailMarkdown(config, taskId, at) {
  return [
    `# ${taskId} ${EXAMPLE_TITLE}`,
    "",
    `- 状态：待办`,
    `- 优先级：${EXAMPLE_PRIORITY}`,
    `- 所属边界：${EXAMPLE_BOUNDARY}`,
    `- 执行者：${EXAMPLE_EXECUTOR}`,
    `- 依赖：[]`,
    `- 任务类型：管理`,
    "",
    "## 目标",
    "",
    "用这个示例确认任务索引、详情卡、结构化任务日志与生成前端可用；确认后替换为真实需求或删除本任务。",
    "",
    "## 完成标准",
    "",
    "- 范围、依赖与验收证据按本项目约定写清。",
    "- `python3 <project-manager-skill>/scripts/validate_tasks.py .` 通过。",
    "",
    "## 任务日志",
    "",
    "```yaml",
    "version: 1",
    "events:",
    '  - id: "log-001"',
    `    at: "${at}"`,
    '    actor: "项目经理"',
    '    type: "created"',
    '    title: "初始化项目任务系统"',
    '    detail: "由 pm init 生成示例任务卡与项目配置，可用真实需求替换。"',
    "    evidence:",
    '      - label: "初始化命令"',
    '        ref: "project-manager/scripts/init-project.mjs"',
    "```",
    "",
  ].join("\n");
}

function agentsBlock(config, taskId) {
  const csvPath = config.taskSystem.csv;
  return [
    AGENTS_BEGIN,
    "## 项目任务系统（project-manager）",
    "",
    `- 任务真源：\`${csvPath}\`（标准 18 列）+ \`${config.taskSystem.detailsDir}/<任务ID>.md\`；\`TASKS.html\` 是生成前端，不手工编辑。`,
    `- 任务编号前缀：\`${config.project.prefix}\`（如 \`${taskId}\`）；同一工作台内不要与其他项目复用前缀。`,
    `- 状态只用：${config.taskSystem.statuses.join(" / ")}；每份详情必须有非空 \`## 任务日志\`。`,
    `- 项目配置：\`${PROJECT_CONFIG_FILENAME}\`（项目名「${config.project.name}」、分组「${config.project.group}」、工作台端口 \`${config.workbench.port}\`）。`,
    "- 校验：`python3 <project-manager-skill>/scripts/validate_tasks.py .`；首次缺少 `TASKS.html` 或模板变化时先运行 `python3 <project-manager-skill>/scripts/generate_tasks.py .`。",
    "- 中央索引、详情与日志由项目经理独占写入；执行者在阶段交接汇总证据。",
    AGENTS_END,
  ].join("\n");
}

function mergeAgents(existing, block) {
  if (existing === null) {
    return {
      action: "created",
      content: `# 项目工作约定\n\n${block}\n`,
    };
  }
  const begin = existing.indexOf(AGENTS_BEGIN);
  const end = existing.indexOf(AGENTS_END);
  if (begin >= 0 && end > begin) {
    const tailStart = end + AGENTS_END.length;
    return {
      action: "replaced",
      content: `${existing.slice(0, begin)}${block}${existing.slice(tailStart)}`,
    };
  }
  const separator = existing.endsWith("\n") ? "\n" : "\n\n";
  return { action: "appended", content: `${existing}${separator}${block}\n` };
}

async function buildStagedProject(stagingRoot, config, at, taskId, projectName, empty) {
  const projectDir = path.join(stagingRoot, projectName);
  const detailsDir = path.join(projectDir, config.taskSystem.detailsDir);
  await mkdir(detailsDir, { recursive: true });
  const detailRelative = `${config.taskSystem.detailsDir}/${taskId}.md`;
  const row = [
    taskId, "待办", EXAMPLE_PRIORITY, EXAMPLE_BOUNDARY, EXAMPLE_TITLE, "[]", EXAMPLE_EXECUTOR,
    at, at, detailRelative,
    "", "", "", "", "", "", "", "",
  ];
  await writeFile(
    path.join(projectDir, config.taskSystem.csv),
    `${csvRow(CSV_HEADERS)}\n${empty ? "" : csvRow(row) + "\n"}`,
    "utf8",
  );
  if (!empty) await writeFile(path.join(projectDir, detailRelative), taskDetailMarkdown(config, taskId, at), "utf8");
  await writeFile(path.join(projectDir, PROJECT_CONFIG_FILENAME), formatProjectConfig(config), "utf8");
  await writeFile(path.join(projectDir, "AGENTS.md"), `# 项目工作约定\n\n${agentsBlock(config, taskId)}\n`, "utf8");
  return projectDir;
}

async function generateAndValidate(projectDir, options) {
  const generate = await runPython(
    options.python,
    [path.join(SCRIPT_DIR, "generate_tasks.py"), projectDir],
    { cwd: SKILL_ROOT },
  );
  if (!generate.ok) {
    throw new InitError(
      `生成 TASKS.html 失败（${options.python}）：${tail(generate.stderr || generate.stdout || generate.error) || "无输出"}\n`
      + "如果本机没有 Python 3.10+，请先安装；也可以用 --skip-validate 跳过自检（不推荐，生成物未经验证）。",
      3,
    );
  }
  if (options.skipValidate) {
    return { ok: null, skipped: true, exitCode: null, output: "已按 --skip-validate 跳过 validate_tasks.py 自检" };
  }
  const validation = await runPython(
    options.python,
    [path.join(SCRIPT_DIR, "validate_tasks.py"), projectDir],
    { cwd: SKILL_ROOT },
  );
  const output = tail(validation.stdout || validation.stderr || validation.error);
  if (!validation.ok) {
    throw new InitError(
      `初始化产物未通过 validate_tasks.py 自检，已在临时目录回滚（仓库未写入）：\n${output || "无输出"}`,
      3,
    );
  }
  return { ok: true, exitCode: validation.exitCode, output: tail(validation.stdout) };
}

async function validateExisting(repository, options) {
  if (options.skipValidate) {
    return { ok: null, skipped: true, exitCode: null, output: "已按 --skip-validate 跳过校验" };
  }
  const validation = await runPython(
    options.python,
    [path.join(SCRIPT_DIR, "validate_tasks.py"), repository],
    { cwd: SKILL_ROOT },
  );
  if (validation.exitCode === null && validation.error) {
    return { ok: false, skipped: false, exitCode: null, output: `校验不可用：${validation.error}` };
  }
  return {
    ok: validation.ok,
    skipped: false,
    exitCode: validation.exitCode,
    output: tail(validation.stdout || validation.stderr),
  };
}

async function chooseBackupDir(repository, stamp) {
  const root = path.join(repository, ".project-manager", "init-backup");
  let candidate = path.join(root, stamp);
  let counter = 1;
  while (await pathExists(candidate)) {
    candidate = path.join(root, `${stamp}-${counter}`);
    counter += 1;
  }
  return { root, candidate };
}

/**
 * 把暂存产物写进仓库。所有目标内容先算好；写入失败时按备份恢复，避免半成品。
 */
async function commitProject({ projectDir, repository, config, taskId, force, empty }) {
  const detailRelative = `${config.taskSystem.detailsDir}/${taskId}.md`;
  const buildTargets = async () => {
    const targets = [];
    const csvContent = await readFile(path.join(projectDir, config.taskSystem.csv), "utf8");
    const detailContent = empty ? null : await readFile(path.join(projectDir, detailRelative), "utf8");
    const configContent = await readFile(path.join(projectDir, PROJECT_CONFIG_FILENAME), "utf8");
    const htmlContent = await readFile(path.join(projectDir, "TASKS.html"), "utf8");
    const block = agentsBlock(config, taskId);
    const agentsPath = path.join(repository, "AGENTS.md");
    const existingAgents = (await pathExists(agentsPath)) ? await readFile(agentsPath, "utf8") : null;
    const agents = mergeAgents(existingAgents, block);
    targets.push({ relative: config.taskSystem.csv, content: csvContent, kind: "file" });
    if (!empty) targets.push({ relative: detailRelative, content: detailContent, kind: "file" });
    targets.push({ relative: "TASKS.html", content: htmlContent, kind: "file" });
    targets.push({ relative: PROJECT_CONFIG_FILENAME, content: configContent, kind: "file" });
    targets.push({ relative: "AGENTS.md", content: agents.content, kind: "file", agentsAction: agents.action });
    return targets;
  };
  const targets = await buildTargets();

  // 预检：非 --force 时，已存在的生成物（除 AGENTS.md 可追加）不覆盖。
  const conflicts = [];
  if (!force) {
    for (const target of targets) {
      if (target.relative === "AGENTS.md") continue;
      if (empty && target.relative === PROJECT_CONFIG_FILENAME && await pathExists(path.join(repository, target.relative))) {
        const current = await loadProjectConfig(repository);
        if (current.ok && formatProjectConfig(current.config) === target.content) continue;
      }
      if (await pathExists(path.join(repository, target.relative))) conflicts.push(target.relative);
    }
  }
  if (conflicts.length > 0) {
    throw new InitError(
      `以下文件已存在，未做任何修改：${conflicts.join(", ")}\n`
      + "如需按当前参数重建，请使用 --force（会先备份到 .project-manager/init-backup/）。",
      2,
    );
  }

  // --force 时把被覆盖的原文件备份到仓库内（同时保留在内存中供失败回滚）。
  const originals = new Map();
  let backupDir = null;
  if (force) {
    const stamp = nowIso().replace(/[:+]/g, "-");
    const chosen = await chooseBackupDir(repository, stamp);
    for (const target of targets) {
      const absolute = path.join(repository, target.relative);
      if (!(await pathExists(absolute))) continue;
      if (!backupDir) {
        await mkdir(chosen.candidate, { recursive: true });
        backupDir = chosen.candidate;
      }
      const backupPath = path.join(chosen.candidate, target.relative);
      await mkdir(path.dirname(backupPath), { recursive: true });
      const original = await readFile(absolute, "utf8");
      await writeFile(backupPath, original, "utf8");
    }
  }

  const written = [];
  const tempFiles = [];
  try {
    for (const target of targets) {
      const absolute = path.join(repository, target.relative);
      const existed = await pathExists(absolute);
      if (empty && !force && target.relative === PROJECT_CONFIG_FILENAME && existed) continue;
      if (existed) {
        originals.set(absolute, await readFile(absolute, "utf8"));
      } else {
        originals.set(absolute, null);
      }
      await mkdir(path.dirname(absolute), { recursive: true });
      const temp = path.join(path.dirname(absolute), `.pm-init-${process.pid}-${written.length}.tmp`);
      tempFiles.push(temp);
      await writeFile(temp, target.content, "utf8");
      await rename(temp, absolute);
      written.push({ relative: target.relative, action: target.agentsAction ?? (existed ? "replaced" : "created") });
    }
    if (empty) await mkdir(path.join(repository, config.taskSystem.detailsDir), {recursive:true});
  } catch (error) {
    for (const temp of tempFiles) await unlink(temp).catch(() => {});
    for (const [absolute, original] of originals) {
      try {
        if (original === null) await unlink(absolute).catch(() => {});
        else await writeFile(absolute, original, "utf8");
      } catch { /* 回滚尽力而为，保留原始错误 */ }
    }
    throw new InitError(`写入项目文件失败，已回滚：${error.message}`, 3);
  }
  const rollback = async () => {
    for (const [absolute, original] of originals) {
      try {
        if (original === null) await unlink(absolute).catch(() => {});
        else await writeFile(absolute, original, "utf8");
      } catch { /* 回滚尽力而为 */ }
    }
  };
  return { written, backupDir, rollback };
}

async function runInit(options) {
  if (options.help) return { code: 0, payload: { ok: true, status: "help" }, lines: [USAGE] };
  if (!options.repo) throw new InitError(`--repo 是必需参数\n\n${USAGE}`);
  if (!options.prefix) throw new InitError(`--prefix 是必需参数\n\n${USAGE}`);
  const repository = path.resolve(options.repo);
  let config = buildConfig(options, repository);
  // A config-only project can resume initialization without overwriting its settings.
  const loadedConfig = await loadProjectConfig(repository);
  if (options.empty && loadedConfig.found && !options.force) {
    if (!loadedConfig.ok) throw new InitError(loadedConfig.errors.join("; "));
    config = loadedConfig.config;
  }

  const initialized = await pathExists(path.join(repository, config.taskSystem.csv));
  if (initialized && !options.force) {
    // 幂等路径以仓库里已有的配置为准，不用本次参数覆盖报告。
    const loaded = await loadProjectConfig(repository);
    const effective = loaded.found && loaded.ok ? loaded.config : config;
    const validation = await validateExisting(repository, options);
    const payload = {
      ok: true,
      status: "already-initialized",
      repo: repository,
      config: effective,
      configOk: loaded.found ? loaded.ok : null,
      configErrors: loaded.errors,
      files: [],
      validation,
    };
    const lines = [
      `ALREADY_INITIALIZED: ${repository}`,
      `${config.taskSystem.csv} 已存在；未做任何修改（使用 --force 可备份后重建）。`,
    ];
    if (validation.ok === true) lines.push(`校验：通过（${validation.output.split("\n")[0]}）`);
    else if (validation.ok === false) lines.push(`注意：现有任务系统校验未通过，请先修复：\n${validation.output}`);
    return { code: 0, payload, lines };
  }

  // 目标目录：空目录或已存在目录都接受；非目录则明确报错。
  const repositoryExists = await pathExists(repository);
  if (repositoryExists) {
    const info = await stat(repository);
    if (!info.isDirectory()) throw new InitError(`--repo 指向的不是目录：${repository}`);
  } else {
    await mkdir(repository, { recursive: true });
  }

  // 预检非 --force 的已存在生成物，尽量在写入前失败。
  if (!options.force) {
    const conflicts = [];
    for (const relative of [
      ...(options.empty && loadedConfig.found ? [] : [PROJECT_CONFIG_FILENAME]),
      "TASKS.html",
      ...(options.empty ? [] : [`${config.taskSystem.detailsDir}/${taskIdFor(config)}.md`]),
    ]) {
      if (await pathExists(path.join(repository, relative))) conflicts.push(relative);
    }
    if (conflicts.length > 0) {
      throw new InitError(
        `以下文件已存在，未做任何修改：${conflicts.join(", ")}\n`
        + "如需按当前参数重建，请使用 --force（会先备份到 .project-manager/init-backup/）。",
        2,
      );
    }
  }

  const at = nowIso();
  const taskId = taskIdFor(config);
  const stagingRoot = await mkdtemp(path.join(os.tmpdir(), "pm-init-"));
  try {
    // 暂存目录 basename 必须与仓库根一致：generate_tasks.py 用它生成看板标题，
    // 否则写入真实仓库后 TASKS.html 会被校验器判为 stale。
    const projectDir = await buildStagedProject(stagingRoot, config, at, taskId, path.basename(repository), options.empty);
    const stagedValidation = await generateAndValidate(projectDir, options);
    const { written, backupDir, rollback } = await commitProject({
      projectDir,
      repository,
      config,
      taskId,
      force: options.force,
      empty: options.empty,
    });
    // 写入后再对真实仓库跑一次自检，防止历史残留文件与新建账本冲突（--force 场景）。
    const validation = options.skipValidate ? stagedValidation : await validateExisting(repository, options);
    if (validation.ok === false) {
      await rollback();
      throw new InitError(
        `初始化产物写入后自检失败，已回滚仓库改动：\n${validation.output || "无输出"}`,
        3,
      );
    }
    const payload = {
      ok: true,
      status: "initialized",
      repo: repository,
      config,
      files: written,
      skipped: [],
      backupDir,
      validation,
      next: [
        `python3 ${path.join(SCRIPT_DIR, "validate_tasks.py")} .`,
        `pm-server project request --csv ${path.join(repository, config.taskSystem.csv)} --repo ${repository} --group ${config.project.group}`,
      ],
    };
    const lines = [
      `INITIALIZED: ${repository}`,
      `项目：${config.project.name}（前缀 ${config.project.prefix}，分组 ${config.project.group}）`,
      options.empty ? "任务：空账本，未创建业务或示例任务" : `任务：${taskId} ${EXAMPLE_TITLE}（示例，可替换或删除）`,
      `配置：${PROJECT_CONFIG_FILENAME}（端口 ${config.workbench.port}，详情目录 ${config.taskSystem.detailsDir}）`,
      `文件：${written.map((item) => `${item.relative}(${item.action})`).join("、")}`,
    ];
    if (backupDir) lines.push(`备份：${backupDir}`);
    if (validation.skipped) lines.push(`校验：跳过（--skip-validate）`);
    else lines.push(`校验：通过（${(validation.output || "").split("\n")[0]}）`);
    lines.push("下一步：运行 validate_tasks.py；把 AGENTS.md 片段按需并入项目规则；用真实需求替换示例任务。");
    return { code: 0, payload, lines };
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

let options;
try {
  options = parseArgs(process.argv);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = error instanceof InitError ? error.exitCode : 2;
}

if (options) {
  try {
    const result = await runInit(options);
    if (options.json) process.stdout.write(`${JSON.stringify(result.payload)}\n`);
    else process.stdout.write(`${result.lines.join("\n")}\n`);
    process.exitCode = result.code;
  } catch (error) {
    const text = error?.message || String(error);
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ ok: false, status: "failed", repo: options.repo ? path.resolve(options.repo) : null, errors: [text] })}\n`);
    } else {
      process.stderr.write(`ERROR: ${text}\n`);
    }
    process.exitCode = error instanceof InitError ? error.exitCode : 1;
  }
}
