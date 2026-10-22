#!/usr/bin/env node
/**
 * `pm doctor`：宿主无关的环境诊断 CLI（Node 内置模块，零第三方依赖）。
 *
 * 目标：新用户遇到“跑不起来”时，一条命令定位问题并给出可执行修复。
 *
 * 安全边界（重要）：
 *   - 只读探测：不安装宿主、不写项目真源、不停止/重启任何工作台实例。
 *   - 端口探测只访问 `127.0.0.1:<port>/health`；发现属于其它技能副本或其它
 *     进程的实例时只报告，不杀进程。共享 9999 的状态目录也只做只读检查。
 *   - 需要写权限的检查使用 `access(W_OK)` 或临时探针文件，并在结束时删除；
 *     不修改业务文件。
 *
 * 退出码：
 *   0 = 没有 FAIL（可以有 WARN；降级能力仍可用）
 *   1 = 存在 FAIL（有阻塞项，按修复命令处理）
 *   2 = 调用/环境错误（参数无效、仓库不存在、诊断自身异常）
 *
 * 用法：
 *   node doctor.mjs --repo <目录> [--host codex|dsh|auto] [--json]
 *                   [--python <解释器>] [--state-dir <运行数据根>]
 *                   [--workbench-state-dir <工作台状态目录>]
 *                   [--runtime-csv <观察缓存>] [--port <端口>]
 */
import { spawn } from 'node:child_process';
import { constants, existsSync, readFileSync } from 'node:fs';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_DETAILS_DIR,
  DEFAULT_TASK_CSV,
  PROJECT_CONFIG_FILENAME,
  loadProjectConfig,
} from './project-config-v2.mjs';
import { authorizationFor, passwordPath, readPassword, serverStateDir } from './server-client.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(SCRIPT_DIR, '..');
const NODE_MIN_MAJOR = 22;
const PYTHON_MIN = [3, 10];
const DEFAULT_PORT = 9999;
const USAGE = [
  '用法：node doctor.mjs --repo <目录> [--host codex|dsh|auto] [--json]',
  '                   [--python <解释器>] [--state-dir <运行数据根>]',
  '                   [--workbench-state-dir <工作台状态目录>]',
  '                   [--runtime-csv <观察缓存>] [--port <端口>]',
  '',
  '示例：node doctor.mjs --repo ./my-project',
  '      node doctor.mjs --repo ./my-project --json --host dsh',
].join('\n');
const CSV_HEADERS = [
  'id', 'status', 'priority', 'boundary', 'title', 'dependencies', 'executor',
  'created_at', 'modified_at', 'detail_path', 'dispatch_id', 'execution_thread_id',
  'execution_turn_id', 'manager_thread_id', 'manager_turn_id', 'recovery_turn_id',
  'recovery_state', 'recovery_state_at',
];
const RUNTIME_HEADERS = ['session_id', 'status', 'current_turn_id', 'status_at', 'last_seen_at'];

class DoctorError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.exitCode = exitCode;
  }
}

function parseArgs(argv) {
  const options = {
    host: 'auto',
    json: false,
    python: process.env.PROJECT_MANAGER_PYTHON || undefined,
  };
  const takeValue = (flag, index) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new DoctorError(`${flag} 需要一个值\n\n${USAGE}`);
    return value;
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--repo') options.repo = takeValue(arg, index++);
    else if (arg === '--host') options.host = takeValue(arg, index++);
    else if (arg === '--python') options.python = takeValue(arg, index++);
    else if (arg === '--state-dir') options.stateDir = takeValue(arg, index++);
    else if (arg === '--workbench-state-dir') options.workbenchStateDir = takeValue(arg, index++);
    else if (arg === '--runtime-csv') options.runtimeCsv = takeValue(arg, index++);
    else if (arg === '--port') options.port = Number(takeValue(arg, index++));
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new DoctorError(`未知参数：${arg}\n\n${USAGE}`);
  }
  if (!['codex', 'dsh', 'auto'].includes(options.host)) {
    throw new DoctorError(`--host 只支持 codex|dsh|auto，收到：${options.host}`);
  }
  if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)) {
    throw new DoctorError('--port 必须是 0–65535 的整数（0 表示随机端口，仅隔离测试）');
  }
  return options;
}

/** 平台与宿主状态根：与技能/插件默认状态目录保持一致。 */
function hostPaths(host) {
  const home = os.homedir();
  const codexRoot = process.env.CODEX_HOME || path.join(home, '.codex');
  const dshRoot = process.env.DSH_HOME || path.join(home, '.dsh');
  return {
    codexRoot,
    dshRoot,
    codexState: path.join(codexRoot, 'state'),
    dshState: path.join(dshRoot, 'state'),
  };
}

/** auto：显式 DSH_HOME → 显式 CODEX_HOME → 已存在 DSH 加载标记 → 已存在 Codex Hook → codex。 */
function resolveHost(explicit) {
  if (explicit !== 'auto') return explicit;
  const { codexRoot, dshRoot, codexState, dshState } = hostPaths('auto');
  if (process.env.DSH_HOME) return 'dsh';
  if (process.env.CODEX_HOME) return 'codex';
  try {
    if (readFileSyncContains(path.join(codexRoot, 'hooks.json'), 'session-runtime-hook.mjs')) return 'codex';
  } catch { /* 读取失败时按默认宿主处理 */ }
  return existsSync(dshRoot) && !existsSync(codexRoot) ? 'dsh' : 'codex';
}

function readFileSyncContains(filename, needle) {
  // 只在 auto 探测中用同步读，避免把宿主判断变成异步时序依赖。
  return readFileSync(filename, 'utf8').includes(needle);
}

/** 运行子进程并收敛为结构化结果；不抛进程异常。 */
function run(command, args, { cwd, env, timeoutMs = 15_000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      finish({ ok: false, exitCode: null, stdout: '', stderr: '', error: error.message });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    timer.unref?.();
    child.on('error', (error) => {
      clearTimeout(timer);
      finish({ ok: false, exitCode: null, stdout, stderr, error: error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish({ ok: code === 0, exitCode: code, stdout, stderr, error: null });
    });
  });
}

function tail(text, limit = 500) {
  const value = String(text ?? '').trim();
  return value.length <= limit ? value : `…（已截断）\n${value.slice(-limit)}`;
}

/** 探测 Python：返回真实解释器路径与版本；找不到/版本过低不抛异常。 */
async function probePython(command) {
  const code = 'import sys,json;print(json.dumps({"path":sys.executable,"version":sys.version.split()[0]}))';
  const result = await run(command, ['-c', code], { timeoutMs: 8_000 });
  if (!result.ok) return { found: false, command, error: result.error || tail(result.stderr) || `退出码 ${result.exitCode}` };
  try {
    const parsed = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) || '');
    if (typeof parsed.path === 'string' && typeof parsed.version === 'string') {
      return { found: true, command, path: parsed.path, version: parsed.version };
    }
  } catch { /* 落到下面的失败结果 */ }
  return { found: false, command, error: tail(result.stdout || result.stderr) || '无法解析 Python 版本' };
}

function versionAtLeast(version, minimum) {
  const parts = String(version).split('.').map((item) => Number.parseInt(item, 10) || 0);
  for (let index = 0; index < minimum.length; index += 1) {
    if (parts[index] > minimum[index]) return true;
    if (parts[index] < minimum[index]) return false;
  }
  return true;
}

async function detectPython(explicit) {
  const candidates = explicit ? [explicit] : ['python3', 'python'];
  const attempted = [];
  for (const candidate of candidates) {
    const result = await probePython(candidate);
    attempted.push({ command: candidate, ...result });
    if (result.found) return { explicit, candidate, attempted, ...result };
  }
  return { explicit, attempted, found: false };
}

async function canonicalPath(target) {
  try { return await realpath(target); } catch { return path.resolve(target); }
}

/** 目录是否存在、是否为目录、当前用户是否可写；不存在时检查最近的可写父目录。 */
async function inspectDirectory(target) {
  try {
    const info = await stat(target);
    if (!info.isDirectory()) return { exists: true, writable: false, reason: '路径不是目录' };
    try {
      await access(target, constants.W_OK);
      return { exists: true, writable: true, mode: info.mode & 0o777 };
    } catch (error) {
      return { exists: true, writable: false, mode: info.mode & 0o777, reason: error.code || error.message };
    }
  } catch (error) {
    if (error.code !== 'ENOENT') return { exists: false, writable: false, reason: error.code || error.message };
    let ancestor = path.dirname(target);
    while (true) {
      try {
        const info = await stat(ancestor);
        if (!info.isDirectory()) return { exists: false, writable: false, reason: '父路径不是目录' };
        await access(ancestor, constants.W_OK);
        return { exists: false, writable: true, ancestor };
      } catch (inner) {
        if (inner.code !== 'ENOENT') return { exists: false, writable: false, reason: inner.code || inner.message };
        const parent = path.dirname(ancestor);
        if (parent === ancestor) return { exists: false, writable: false, reason: '找不到可写父目录' };
        ancestor = parent;
      }
    }
  }
}

function parseCsvLine(line) {
  const fields = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') { current += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else current += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { fields.push(current); current = ''; }
    else current += char;
  }
  fields.push(current);
  return fields;
}

async function readTaskCsv(csvPath) {
  try {
    const source = await readFile(csvPath, 'utf8');
    const lines = source.split(/\r?\n/).filter((line) => line.trim() !== '');
    return { found: true, header: lines.length > 0 ? parseCsvLine(lines[0]) : [], rows: Math.max(0, lines.length - 1), source };
  } catch (error) {
    return { found: false, error, header: [], rows: 0, source: '' };
  }
}

function sameList(left, right) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

/** 探测本地工作台 /health；只发请求，不做任何管理动作。 */
async function probeHealth(port, authorization) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1_500),
      headers: authorization ? { Authorization: authorization } : {},
    });
    const text = await response.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* 非 JSON，视为其它服务 */ }
    return { status: response.status, body, text: tail(text, 200) };
  } catch (error) {
    return { error, code: error?.cause?.code || error?.code || error?.name };
  }
}

function check(status, id, title, actual, expected, fix) {
  return { id, title, status, actual: String(actual), expected: String(expected), fix: String(fix) };
}

/**
 * 执行全部检查。导出给测试直接调用；CLI 入口只负责参数与输出。
 * @param {ReturnType<typeof parseArgs> & {repo: string}} options
 */
export async function runDoctor(options) {
  const repo = path.resolve(options.repo);
  const host = resolveHost(options.host);
  const paths = hostPaths(host);
  const loaded = await loadProjectConfig(repo);
  const config = loaded.config;
  const stateRoot = path.resolve(
    options.stateDir
    || serverStateDir(),
  );
  const configuredWorkbenchState = loaded.found && loaded.ok && config.workbench?.stateDir
    ? config.workbench.stateDir
    : null;
  const workbenchStateDir = path.resolve(
    options.workbenchStateDir
    || (configuredWorkbenchState ? path.resolve(repo, configuredWorkbenchState) : options.stateDir ? path.join(stateRoot, 'project-manager-workbench') : stateRoot),
  );
  const port = options.port === undefined ? (config.workbench?.port ?? DEFAULT_PORT) : options.port;
  const runtimeCsv = path.resolve(
    options.runtimeCsv
    || (host === 'codex' && process.env.CODEX_SESSION_RUNTIME_CSV)
    || path.join(stateRoot, 'session-runtime.csv'),
  );
  const checks = [];

  // 1. Node.js 版本。
  const nodeVersion = process.versions.node;
  const nodeMajor = Number.parseInt(nodeVersion.split('.')[0], 10) || 0;
  checks.push(check(
    nodeMajor >= NODE_MIN_MAJOR ? 'OK' : 'FAIL',
    'runtime.node',
    'Node.js 版本',
    `v${nodeVersion}（${process.execPath}）`,
    `>= ${NODE_MIN_MAJOR}`,
    nodeMajor >= NODE_MIN_MAJOR ? '无需修复' : '安装 Node.js 22+，确认 `node --version` 与运行本命令的解释器一致',
  ));

  // 2. 运行平台（Windows 未验证项不可写成通过）。
  if (process.platform === 'win32') {
    checks.push(check(
      'WARN',
      'runtime.platform',
      '操作系统',
      `win32 ${process.arch}（路径分隔符 \\）`,
      'macOS / Linux（POSIX）；Windows 为未验证平台，写操作锁不可用',
      '优先使用 macOS/Linux 或 WSL2；Windows 原生环境需逐项人工验证，不要据此宣称支持',
    ));
  } else {
    checks.push(check(
      'OK',
      'runtime.platform',
      '操作系统',
      `${process.platform} ${process.arch}（路径分隔符 ${path.sep}）`,
      'Node.js 支持的 POSIX 平台（macOS / Linux）',
      '无需修复',
    ));
  }

  // 3. Python 路径/版本；缺失时只读能力仍可用，但校验/写路径不可用。
  const python = await detectPython(options.python);
  let pythonBin = null;
  if (!python.found) {
    checks.push(check(
      'FAIL',
      'python.runtime',
      'Python 解释器',
      options.python ? `未找到：${options.python}` : '未找到 python3 / python',
      `Python >= ${PYTHON_MIN.join('.')}（推荐命令名 python3）`,
      '安装 Python 3.10+ 并确保 `python3` 在 PATH；或用 `--python <解释器>` / `PROJECT_MANAGER_PYTHON` 指定。无 Python 时只读查询与看板查看仍可用。',
    ));
  } else if (!versionAtLeast(python.version, PYTHON_MIN)) {
    checks.push(check(
      'FAIL',
      'python.runtime',
      'Python 解释器',
      `${python.version}（${python.path}）`,
      `Python >= ${PYTHON_MIN.join('.')}`,
      '升级 Python 到 3.10+，或把 `--python` / `PROJECT_MANAGER_PYTHON` 指向新版解释器',
    ));
  } else {
    pythonBin = python.path || python.command;
    const onlyAlias = !options.python && path.basename(python.command) !== 'python3' && !python.attempted.some((item) => item.command === 'python3' && item.found);
    checks.push(check(
      onlyAlias ? 'WARN' : 'OK',
      'python.runtime',
      'Python 解释器',
      `${python.version}（${python.path}；命令 ${python.command}）`,
      `Python >= ${PYTHON_MIN.join('.')}，默认命令 python3`,
      onlyAlias
        ? '脚本默认调用 `python3`：把 python 链接为 python3，或设置 `PROJECT_MANAGER_PYTHON=$(which python)` 并在宿主配置中指定'
        : '无需修复',
    ));
  }

  // 4. 仓库任务索引。
  const csvPath = path.join(repo, DEFAULT_TASK_CSV);
  const csv = await readTaskCsv(csvPath);
  if (!csv.found) {
    checks.push(check(
      'FAIL',
      'repo.tasksCsv',
      '任务索引 TASKS.csv',
      `${csvPath} 不存在`,
      '仓库根存在标准 18 列 TASKS.csv',
      `初始化项目：node "${path.join(SCRIPT_DIR, 'init-project.mjs')}" --repo "${repo}" --prefix <大写前缀> --name "<项目名>"`,
    ));
  } else if (!sameList(csv.header, CSV_HEADERS)) {
    checks.push(check(
      'FAIL',
      'repo.tasksCsv',
      '任务索引 TASKS.csv',
      `${csv.header.length} 列表头：${csv.header.join(',') || '（空文件）'}`,
      `标准 18 列：${CSV_HEADERS.join(',')}`,
      '从 `pm init` 生成的模板恢复表头；不要手工删改列。先备份现有 TASKS.csv',
    ));
  } else {
    checks.push(check(
      'OK',
      'repo.tasksCsv',
      '任务索引 TASKS.csv',
      `${csv.rows} 条任务，18 列表头`,
      '标准 18 列 TASKS.csv，可被 validate_tasks.py 读取',
      '无需修复',
    ));
  }

  // 5. 任务详情目录。
  const detailsDir = path.resolve(repo, loaded.ok && loaded.found ? config.taskSystem.detailsDir : DEFAULT_DETAILS_DIR);
  const detailsInfo = await inspectDirectory(detailsDir);
  const detailsRelative = path.relative(repo, detailsDir) || '.';
  if (detailsInfo.exists && !detailsInfo.writable && detailsInfo.reason === '路径不是目录') {
    checks.push(check(
      'FAIL', 'repo.detailsDir', '任务详情目录', `${detailsRelative} 不是目录`, '详情目录存在且可写',
      `删除同名文件或改用其它 detailsDir：node "${path.join(SCRIPT_DIR, 'init-project.mjs')}" --repo "${repo}" --force`,
    ));
  } else if (!detailsInfo.exists) {
    checks.push(check(
      csv.rows > 0 ? 'FAIL' : 'WARN',
      'repo.detailsDir',
      '任务详情目录',
      `${detailsRelative} 不存在（CSV 有 ${csv.rows} 条任务）`,
      `${DEFAULT_DETAILS_DIR}/（或 project-manager.config.json 的 taskSystem.detailsDir）`,
      csv.rows > 0
        ? `恢复任务卡目录（从 Git 或备份），或按实际详情路径修正 CSV；不要直接删除任务行`
        : `运行 pm init 生成示例项目，或先创建 ${detailsRelative}/`,
    ));
  } else {
    checks.push(check(
      detailsInfo.writable ? 'OK' : 'WARN',
      'repo.detailsDir',
      '任务详情目录',
      `${detailsRelative}（可写=${detailsInfo.writable}${detailsInfo.writable ? '' : `：${detailsInfo.reason}`}）`,
      '详情目录存在且与配置一致',
      detailsInfo.writable ? '无需修复' : `目录可读但不可写，任务卡写入会失败：chmod u+rwx "${detailsDir}"`,
    ));
  }

  // 6. 项目配置校验。
  if (!loaded.found) {
    checks.push(check(
      'WARN',
      'config.project',
      '项目配置 project-manager.config.json',
      '未找到（使用默认值：TASKS.csv / work-items / 端口 9999）',
      PROJECT_CONFIG_FILENAME,
      '运行 pm init 生成单一项目配置；不要手工编造 .env 端口覆盖项目配置',
    ));
  } else if (!loaded.ok) {
    checks.push(check(
      'FAIL',
      'config.project',
      '项目配置 project-manager.config.json',
      `${loaded.path}：${loaded.errors.join('；')}`,
      'JSON 可解析，configVersion 1，字段符合 schema',
      '按 project-manager.config.schema.json 修正；或备份后 `pm init --force` 重建',
    ));
  } else {
    checks.push(check(
      'OK',
      'config.project',
      '项目配置 project-manager.config.json',
      `configVersion 1；项目「${config.project.name}」前缀 ${config.project.prefix}；端口 ${config.workbench.port}`,
      '可解析且通过单一路径校验',
      '无需修复',
    ));
  }

  // 7. validate_tasks.py 能否运行。
  if (!pythonBin) {
    checks.push(check(
      'WARN',
      'python.validate',
      '任务结构校验 validate_tasks.py',
      '跳过：没有可用的 Python 3.10+',
      '退出码 0，输出 OK: <n> task files',
      '安装 Python 3.10+ 后重跑：node doctor.mjs --repo <目录>；只读状态查询与看板不受影响',
    ));
  } else {
    const validation = await run(pythonBin, [path.join(SCRIPT_DIR, 'validate_tasks.py'), repo], {
      cwd: SKILL_ROOT,
      env: { PYTHONDONTWRITEBYTECODE: '1' },
      timeoutMs: 60_000,
    });
    if (validation.ok) {
      checks.push(check(
        'OK', 'python.validate', '任务结构校验 validate_tasks.py',
        tail(validation.stdout, 200) || '退出码 0',
        '退出码 0，输出 OK: <n> task files',
        '无需修复',
      ));
    } else {
      checks.push(check(
        'FAIL', 'python.validate', '任务结构校验 validate_tasks.py',
        tail(validation.stderr || validation.stdout, 500) || `退出码 ${validation.exitCode}`,
        '退出码 0，输出 OK: <n> task files',
        `修复上面的校验错误后重跑：python3 "${path.join(SCRIPT_DIR, 'validate_tasks.py')}" "${repo}"`,
      ));
    }
  }

  // 8. 工作台状态目录可写性。
  const stateInfo = await inspectDirectory(workbenchStateDir);
  if (!stateInfo.exists) {
    checks.push(check(
      stateInfo.writable ? 'OK' : 'FAIL',
      'workbench.stateDir',
      '工作台状态目录',
      `${workbenchStateDir} 不存在${stateInfo.writable ? `；父目录可写（${stateInfo.ancestor}）` : `；${stateInfo.reason || '父目录不可写'}`}`,
      '不存在时可由 ensure 创建；已存在时必须可写',
      stateInfo.writable
        ? '由 pm-server service start 创建'
        : `选择可写目录：--state-dir <可写目录>，或修复父目录权限`,
    ));
  } else {
    checks.push(check(
      stateInfo.writable ? 'OK' : 'FAIL',
      'workbench.stateDir',
      '工作台状态目录',
      `${workbenchStateDir}（${stateInfo.writable ? '可写' : `不可写：${stateInfo.reason}`}，权限 ${stateInfo.mode?.toString(8)}）`,
      '目录存在且当前用户可写（工作台登记/密码/锁）',
      stateInfo.writable ? '无需修复' : `chmod u+rwx "${workbenchStateDir}"；若目录属于其他用户，改用 --state-dir`,
    ));
  }

  // 9. 工作台密码文件（复用既有实例的必要凭据）。
  let authorization = null;
  try {
    const password = await readPassword(passwordPath(workbenchStateDir));
    authorization = authorizationFor(password);
    checks.push(check(
      'OK', 'workbench.auth', '工作台密码文件',
      `${passwordPath(workbenchStateDir)}（0600，${password.length} 字符）`,
      '存在、普通文件、仅本人可读写（0600），至少 16 字符',
      '无需修复',
    ));
  } catch (error) {
    const missing = error.code === 'ENOENT';
    checks.push(check(
      missing ? 'WARN' : 'FAIL',
      'workbench.auth',
      '工作台密码文件',
      missing ? '未找到 password.txt（工作台尚未启动）' : `${passwordPath(workbenchStateDir)}：${error.message}`,
      '首次 ensure 自动生成 0600 密码；已有实例时使用其 stateDir',
      missing
        ? `工作台首次启动时自动生成；若实例已在运行，用 --state-dir 指向它的状态目录`
        : `chmod 600 "${passwordPath(workbenchStateDir)}"；拒绝符号链接与空文件；不要删除正在使用的密码`,
    ));
  }

  // 10. 端口占用/复用（只探测，不杀进程、不重启共享实例）。
  if (port === 0) {
    checks.push(check(
      'OK', 'workbench.port', '工作台端口',
      '0（随机端口，仅隔离测试）',
      '隔离测试显式使用 0；正式使用 9999 或项目配置端口',
      '无需修复',
    ));
  } else {
    const health = await probeHealth(port, authorization);
    const canonicalState = await canonicalPath(workbenchStateDir);
    const canonicalSkill = await canonicalPath(SKILL_ROOT);
    if (health.error) {
      const code = health.code;
      if (code === 'ECONNREFUSED') {
        checks.push(check(
          'OK', 'workbench.port', '工作台端口',
          `127.0.0.1:${port} 未监听（端口空闲）`,
          '端口空闲，或由当前技能副本复用同一工作台',
          `需要看板时运行：pm-server service start --port ${port}`,
        ));
      } else {
        checks.push(check(
          'WARN', 'workbench.port', '工作台端口',
          `探测 127.0.0.1:${port} 失败：${health.error.message || code}`,
          '能连接本地工作台或端口空闲',
          '检查本机防火墙/回环网络；不要据此停止既有服务',
        ));
      }
    } else if (health.status === 200 && health.body?.kind === 'project-manager-workbench') {
      const body = health.body;
      const sameState = (await canonicalPath(body.stateDir || '')) === canonicalState;
      const sameSkill = (await canonicalPath(body.skillRoot || '')) === canonicalSkill;
      const modernAuth = body.authentication === 'cookie';
      if (sameState && (sameSkill || (body.application === 'pm-server' && body.contractVersion === 1)) && modernAuth) {
        checks.push(check(
          'OK', 'workbench.port', '工作台端口',
          `HTTP 200，pid ${body.pid}，stateDir 与受支持应用契约匹配，authentication=cookie`,
          '复用已核验状态目录和契约的认证工作台',
          '无需修复',
        ));
      } else {
        checks.push(check(
          'WARN', 'workbench.port', '工作台端口',
          `HTTP 200，但 stateDir 匹配=${sameState}、skillRoot 匹配=${sameSkill}、authentication=${body.authentication || '未知'}`,
          '同一 stateDir 且 skillRoot 与当前技能完全一致，并启用 cookie 认证',
          `不要停止正在使用的共享实例。把 workbenchSkillDir 指向 ${body.skillRoot || '<该实例技能目录>'}，或用 --state-dir 指向其状态目录；旧版实例需所有者明确决定后再重启`,
        ));
      }
    } else if (health.status === 401) {
      checks.push(check(
        'WARN', 'workbench.port', '工作台端口',
        `HTTP 401（端口由工作台占用，但当前密码无法通过认证）`,
        '使用该实例状态目录的密码文件完成 /health 认证',
        `用 --state-dir 指向既有实例的状态目录；不要为消除 401 而停止共享 9999 实例`,
      ));
    } else if (health.status === 200) {
      checks.push(check(
        'FAIL', 'workbench.port', '工作台端口',
        `HTTP 200，但响应不是 project-manager-workbench（${health.text || '非 JSON'}）`,
        '端口空闲，或由 project-manager 工作台占用',
        `端口冲突：改用其它端口（--port 或项目配置 workbench.port）；确认占用进程由你自行决定，doctor 不会杀进程`,
      ));
    } else {
      checks.push(check(
        'FAIL', 'workbench.port', '工作台端口',
        `HTTP ${health.status}（${health.text || '无响应正文'}）`,
        '端口空闲，或由 project-manager 工作台占用',
        `端口冲突：改用其它端口（--port 或项目配置 workbench.port）；doctor 不会停止任何实例`,
      ));
    }
  }

  // 11. 观察缓存路径/可写性/schema。
  const runtimeDir = path.dirname(runtimeCsv);
  const runtimeDirInfo = await inspectDirectory(runtimeDir);
  try {
    const source = await readFile(runtimeCsv, 'utf8');
    const header = source.split(/\r?\n/).find((line) => line.trim() !== '') || '';
    const fields = header ? parseCsvLine(header) : [];
    const schemaOk = sameList(fields, RUNTIME_HEADERS);
    checks.push(check(
      schemaOk && runtimeDirInfo.writable ? 'OK' : 'WARN',
      'observe.runtimeCsv',
      '运行观察缓存',
      schemaOk
        ? `${runtimeCsv}（5 列 schema${runtimeDirInfo.writable ? '' : '；目录不可写'}）`
        : `${runtimeCsv} 表头不符：${header || '空文件'}`,
      `${RUNTIME_HEADERS.join(',')}，且目录当前用户可写`,
      schemaOk && runtimeDirInfo.writable
        ? '无需修复'
        : `该缓存可重建，不影响任务事实：${schemaOk ? `修复目录权限：chmod u+rwx "${runtimeDir}"` : `删除 "${runtimeCsv}" 后由宿主/工作台重新生成`}`,
    ));
  } catch (error) {
    if (error.code === 'ENOENT') {
      checks.push(check(
        runtimeDirInfo.writable ? 'OK' : 'FAIL',
        'observe.runtimeCsv',
        '运行观察缓存',
        `${runtimeCsv} 尚未生成${runtimeDirInfo.writable ? '；目录可写（宿主运行时创建）' : `；目录不可写：${runtimeDirInfo.reason}`}`,
        '宿主首次运行后生成 5 列缓存；目录当前用户可写',
        runtimeDirInfo.writable
          ? '无需修复；Codex 需安装 Hook，其他环境由使用者显式写入'
          : `修复目录权限或改用可写的 --runtime-csv / --state-dir：chmod u+rwx "${runtimeDir}"`,
      ));
    } else {
      checks.push(check(
        'WARN', 'observe.runtimeCsv', '运行观察缓存',
        `${runtimeCsv} 读取失败：${error.message}`,
        '文件可读且为 5 列 schema',
        `检查文件权限；该缓存可重建，不影响任务事实`,
      ));
    }
  }

  // 12. 宿主集成标记：Codex Hook 或 DSH 插件加载标记。
  if (host === 'codex') {
    const hooksFile = path.join(paths.codexRoot, 'hooks.json');
    try {
      const hooks = await readFile(hooksFile, 'utf8');
      const installed = hooks.includes('session-runtime-hook.mjs');
      checks.push(check(
        installed ? 'OK' : 'WARN',
        'host.integration',
        'Codex Hook 安装标记',
        installed ? `${hooksFile} 已引用 session-runtime-hook.mjs` : `${hooksFile} 存在但未引用 session-runtime-hook.mjs`,
        '用户级 hooks.json 包含 session-runtime-hook.mjs 处理器',
        installed
          ? `安装状态已确认；真实事件投递仍需真实会话验收：pm-server adapter check codex`
          : `先检查：pm-server adapter check codex；安装需用户明确授权`,
      ));
    } catch (error) {
      checks.push(check(
        'WARN', 'host.integration', 'Codex Hook 安装标记',
        error.code === 'ENOENT' ? `${hooksFile} 不存在（Hook 未安装或 CODEX_HOME 不同）` : `读取失败：${error.message}`,
        '用户级 hooks.json 包含 session-runtime-hook.mjs 处理器',
        `运行 --check 查看状态；安装 Hook 会修改 CODEX_HOME/hooks.json，必须先取得用户授权`,
      ));
    }
  } else {
    checks.push(check(
      'OK',
      'host.integration',
      'DSH 宿主：无插件层',
      'DSH 只按 CLI 使用：没有工具、命令或预设层，也不需要加载标记',
      '直接调用技能脚本',
      '无需修复；按 README 的 CLI 步骤使用',
    ));
  }

  // 13. 跨平台路径规范（配置层禁止反斜杠）。
  if (process.platform === 'win32') {
    checks.push(check(
      'WARN', 'platform.paths', '跨平台路径规范',
      `win32，path.sep=${JSON.stringify(path.sep)}；项目配置禁止反斜杠，Windows 路径未验证`,
      '配置中的相对路径使用 POSIX `/`；Windows 由 Node path 适配',
      'Windows 未验证，需逐项人工验证；当前不作为已支持平台',
    ));
  } else {
    checks.push(check(
      'OK', 'platform.paths', '跨平台路径规范',
      `POSIX 路径，path.sep=${JSON.stringify(path.sep)}；配置检查拒绝反斜杠`,
      '相对路径使用 POSIX `/`，绝对路径按平台解析',
      '无需修复',
    ));
  }

  // 14. 锁实现（技能使用 Python fcntl；Windows 原生缺失）。
  if (!pythonBin) {
    checks.push(check(
      'WARN', 'platform.lock', '锁实现（进程/工作台登记）',
      '无法检测：没有可用的 Python',
      'Python fcntl 可用（POSIX flock）',
      '安装 Python 3.10+ 后重跑；无 Python 时只读操作可用，写入/工作台登记不可用',
    ));
  } else {
    const lockProbe = await run(pythonBin, ['-c', 'import fcntl; print("fcntl-ok")'], { timeoutMs: 5_000 });
    const available = lockProbe.ok && lockProbe.stdout.includes('fcntl-ok');
    checks.push(check(
      available ? 'OK' : 'WARN',
      'platform.lock',
      '锁实现（进程/工作台登记）',
      available ? 'Python fcntl 可用（POSIX flock）' : `不可用：${tail(lockProbe.stderr || lockProbe.stdout, 200) || `退出码 ${lockProbe.exitCode}`}`,
      'Python fcntl 可用；任务运行锁与工作台登记锁依赖它',
      available
        ? '无需修复'
        : 'Windows 原生 Python 无 fcntl：在 WSL2/macOS/Linux 执行写入与工作台管理；只读查看不受影响。Windows 未验证',
    ));
  }

  const summary = {
    ok: checks.filter((item) => item.status === 'OK').length,
    warn: checks.filter((item) => item.status === 'WARN').length,
    fail: checks.filter((item) => item.status === 'FAIL').length,
  };
  const ok = summary.fail === 0;
  return {
    schemaVersion: 1,
    ok,
    exitCode: ok ? 0 : 1,
    host,
    hostSource: options.host === 'auto' ? 'auto' : 'explicit',
    repo,
    skillRoot: SKILL_ROOT,
    stateRoot,
    workbenchStateDir,
    port,
    runtimeCsv,
    platform: {
      os: process.platform,
      arch: process.arch,
      node: nodeVersion,
      pathSeparator: path.sep,
    },
    python: python.found
      ? { path: python.path, version: python.version, command: python.command }
      : { path: null, version: null, command: options.python || null },
    config: {
      path: loaded.path,
      found: loaded.found,
      ok: loaded.ok,
      errors: loaded.errors,
    },
    checks,
    summary,
  };
}

export function renderHuman(payload) {
  const lines = [
    'pm doctor — project-manager 环境诊断',
    `仓库：${payload.repo}`,
    `宿主：${payload.host}${payload.hostSource === 'auto' ? '（自动检测；可用 --host 指定）' : ''}`,
    `技能：${payload.skillRoot}`,
    `工作台：stateDir=${payload.workbenchStateDir}，port=${payload.port}`,
    `观察缓存：${payload.runtimeCsv}`,
    '',
  ];
  for (const item of payload.checks) {
    lines.push(`[${item.status}] ${item.title}`);
    lines.push(`  实际：${item.actual}`);
    lines.push(`  期望：${item.expected}`);
    lines.push(`  修复：${item.fix}`);
    lines.push('');
  }
  lines.push(`汇总：OK ${payload.summary.ok} / WARN ${payload.summary.warn} / FAIL ${payload.summary.fail}`);
  lines.push(payload.ok
    ? '结论：通过（退出码 0；WARN 表示降级能力，按需处理）'
    : '结论：存在阻塞项（退出码 1；先按 FAIL 的修复命令处理）');
  return `${lines.join('\n')}\n`;
}

function writeError(message, json) {
  if (json) process.stdout.write(`${JSON.stringify({ schemaVersion: 1, ok: false, status: 'error', error: message })}\n`);
  else process.stderr.write(`ERROR: ${message}\n`);
}

async function main(argv) {
  const jsonRequested = argv.includes('--json');
  let options;
  try {
    options = parseArgs(argv);
    if (options.help) {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    }
    if (!options.repo) throw new DoctorError(`--repo 是必需参数\n\n${USAGE}`);
    const repo = path.resolve(options.repo);
    let info;
    try {
      info = await stat(repo);
    } catch (error) {
      throw new DoctorError(`--repo 指向的路径不可访问：${repo}（${error.code || error.message}）`);
    }
    if (!info.isDirectory()) throw new DoctorError(`--repo 不是目录：${repo}`);
    const payload = await runDoctor({ ...options, repo });
    if (options.json) process.stdout.write(`${JSON.stringify(payload)}\n`);
    else process.stdout.write(renderHuman(payload));
    return payload.exitCode;
  } catch (error) {
    writeError(error?.message || String(error), options?.json ?? jsonRequested);
    return error instanceof DoctorError ? error.exitCode : 2;
  }
}

const isMain = process.argv[1]
  && await realpath(process.argv[1]).then((value) => value === fileURLToPath(import.meta.url)).catch(() => false);
if (isMain) {
  process.exitCode = await main(process.argv);
}
