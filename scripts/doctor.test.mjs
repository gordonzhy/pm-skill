/**
 * `pm doctor` 回归：全通过 / 缺 Python / 端口占用 / 配置损坏 / 不可写目录。
 *
 * 全部使用临时仓库、显式随机端口或隔离状态目录；不启动常驻服务、不接触共享 9999、
 * 不安装宿主配置。需要 Python 3.10+ 与 Node 22+。
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOCTOR = path.join(HERE, 'doctor.mjs');
const INIT = path.join(HERE, 'init-project.mjs');
const SKILL_ROOT = path.resolve(HERE, '..');
const PY_ENV = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };

async function makeRepo() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pm-doctor-repo-'));
  await runFile(process.execPath, [
    INIT, '--repo', root, '--prefix', 'DOC', '--name', '诊断夹具', '--skip-validate',
  ], { env: PY_ENV });
  return root;
}

async function runDoctor(args, env = {}) {
  try {
    const { stdout, stderr } = await runFile(process.execPath, [DOCTOR, ...args], {
      env: { ...process.env, ...env },
      maxBuffer: 4 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: String(error.stdout ?? ''),
      stderr: String(error.stderr ?? ''),
    };
  }
}

function payload(result) {
  return JSON.parse(result.stdout.trim());
}

function checkOf(data, id) {
  const found = data.checks.find((item) => item.id === id);
  assert.ok(found, `缺少检查项 ${id}`);
  return found;
}

async function makeStateRoot(root) {
  const stateRoot = path.join(root, '.state');
  const workbench = path.join(stateRoot, 'project-manager-workbench');
  await mkdir(workbench, { recursive: true });
  const password = path.join(workbench, 'password.txt');
  await writeFile(password, '0123456789abcdef01234567\n', { mode: 0o600 });
  await chmod(password, 0o600);
  return { stateRoot, workbench, password };
}

async function makeCodexHome(root) {
  const home = path.join(root, 'codex-home');
  await mkdir(home, { recursive: true });
  await writeFile(path.join(home, 'hooks.json'), `${JSON.stringify({
    hooks: {
      SessionStart: [{ type: 'command', command: 'node /opt/pm/session-runtime-hook.mjs' }],
    },
  })}\n`, 'utf8');
  return home;
}

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test('全通过：Node/Python/仓库/配置/工作台/观察/宿主集成均 OK', async () => {
  const root = await makeRepo();
  try {
    const { stateRoot, workbench } = await makeStateRoot(root);
    const codexHome = await makeCodexHome(root);
    const result = await runDoctor([
      '--repo', root,
      '--host', 'codex',
      '--state-dir', stateRoot,
      '--workbench-state-dir', workbench,
      '--port', '0',
      '--json',
    ], { CODEX_HOME: codexHome, PYTHONDONTWRITEBYTECODE: '1' });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const data = payload(result);
    assert.equal(data.ok, true);
    assert.equal(data.exitCode, 0);
    assert.equal(data.host, 'codex');
    assert.equal(data.summary.fail, 0);
    assert.equal(data.summary.warn, 0, JSON.stringify(data.checks.filter((item) => item.status !== 'OK')));
    assert.equal(checkOf(data, 'runtime.node').status, 'OK');
    assert.equal(checkOf(data, 'python.runtime').status, 'OK');
    assert.equal(checkOf(data, 'repo.tasksCsv').status, 'OK');
    assert.equal(checkOf(data, 'config.project').status, 'OK');
    assert.equal(checkOf(data, 'python.validate').status, 'OK');
    assert.equal(checkOf(data, 'workbench.stateDir').status, 'OK');
    assert.equal(checkOf(data, 'workbench.auth').status, 'OK');
    assert.equal(checkOf(data, 'workbench.port').status, 'OK');
    assert.equal(checkOf(data, 'observe.runtimeCsv').status, 'OK');
    assert.equal(checkOf(data, 'host.integration').status, 'OK');
    assert.equal(checkOf(data, 'platform.lock').status, 'OK');

    // 人类可读输出必须逐项给出实际值/期望/修复命令。
    const human = await runDoctor([
      '--repo', root, '--host', 'codex', '--state-dir', stateRoot,
      '--workbench-state-dir', workbench, '--port', '0',
    ], { CODEX_HOME: codexHome });
    assert.equal(human.code, 0);
    assert.match(human.stdout, /实际：/);
    assert.match(human.stdout, /期望：/);
    assert.match(human.stdout, /修复：/);
    assert.match(human.stdout, /汇总：OK \d+ \/ WARN 0 \/ FAIL 0/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('缺 Python：诊断仍完成只读检查，Python 相关项明确阻塞/降级', async () => {
  const root = await makeRepo();
  try {
    const { stateRoot } = await makeStateRoot(root);
    const codexHome = await makeCodexHome(root);
    const missing = path.join(root, 'no-such-python3');
    const result = await runDoctor([
      '--repo', root,
      '--host', 'codex',
      '--state-dir', stateRoot,
      '--port', '0',
      '--python', missing,
      '--json',
    ], { CODEX_HOME: codexHome });
    assert.equal(result.code, 1);
    const data = payload(result);
    assert.equal(data.ok, false);
    assert.equal(checkOf(data, 'python.runtime').status, 'FAIL');
    assert.match(checkOf(data, 'python.runtime').fix, /安装 Python|PROJECT_MANAGER_PYTHON/);
    assert.equal(checkOf(data, 'python.validate').status, 'WARN');
    assert.equal(checkOf(data, 'platform.lock').status, 'WARN');
    // 只读能力仍被检查：任务索引/配置/仓库结构不因缺 Python 而跳过。
    assert.equal(checkOf(data, 'repo.tasksCsv').status, 'OK');
    assert.equal(checkOf(data, 'config.project').status, 'OK');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('端口被非工作台服务占用：FAIL 并给出换端口建议', async () => {
  const root = await makeRepo();
  const { server, port } = await listen((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/plain' });
    response.end('another service');
  });
  try {
    const { stateRoot } = await makeStateRoot(root);
    const codexHome = await makeCodexHome(root);
    const result = await runDoctor([
      '--repo', root,
      '--host', 'codex',
      '--state-dir', stateRoot,
      '--port', String(port),
      '--json',
    ], { CODEX_HOME: codexHome });
    assert.equal(result.code, 1);
    const data = payload(result);
    const portCheck = checkOf(data, 'workbench.port');
    assert.equal(portCheck.status, 'FAIL');
    assert.match(portCheck.actual, /不是 project-manager-workbench|HTTP 200/);
    assert.match(portCheck.fix, /端口冲突|其它端口/);
  } finally {
    await close(server);
    await rm(root, { recursive: true, force: true });
  }
});

test('端口由同技能工作台占用：认证 /health 匹配时报告可复用', async () => {
  const root = await makeRepo();
  try {
    const { stateRoot, workbench } = await makeStateRoot(root);
    const codexHome = await makeCodexHome(root);
    const { server, port } = await listen((request, response) => {
      if (request.url !== '/health') {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        kind: 'project-manager-workbench',
        stateDir: workbench,
        pid: process.pid,
        url: `http://127.0.0.1:${port}/`,
        skillRoot: SKILL_ROOT,
        authentication: 'cookie',
        publicOrigin: '',
        listenHost: '0.0.0.0',
      }));
    });
    try {
      const result = await runDoctor([
        '--repo', root,
        '--host', 'codex',
        '--state-dir', stateRoot,
        '--workbench-state-dir', workbench,
        '--port', String(port),
        '--json',
      ], { CODEX_HOME: codexHome });
      assert.equal(result.code, 0, result.stdout);
      const data = payload(result);
      const portCheck = checkOf(data, 'workbench.port');
      assert.equal(portCheck.status, 'OK');
      assert.ok(portCheck.actual.includes(String(process.pid)));
    } finally {
      await close(server);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('端口由其它技能副本占用：只 WARN 提示，不要求停止共享实例', async () => {
  const root = await makeRepo();
  try {
    const { stateRoot, workbench } = await makeStateRoot(root);
    const codexHome = await makeCodexHome(root);
    const { server, port } = await listen((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        kind: 'project-manager-workbench',
        stateDir: workbench,
        pid: process.pid,
        skillRoot: '/some/other/project-manager',
        authentication: 'cookie',
      }));
    });
    try {
      const result = await runDoctor([
        '--repo', root,
        '--host', 'codex',
        '--state-dir', stateRoot,
        '--workbench-state-dir', workbench,
        '--port', String(port),
        '--json',
      ], { CODEX_HOME: codexHome });
      assert.equal(result.code, 0, result.stdout);
      const portCheck = checkOf(payload(result), 'workbench.port');
      assert.equal(portCheck.status, 'WARN');
      assert.match(portCheck.fix, /不要停止/);
      assert.match(portCheck.fix, /workbenchSkillDir/);
    } finally {
      await close(server);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('项目配置损坏：FAIL 且保留可执行修复', async () => {
  const root = await makeRepo();
  try {
    const { stateRoot } = await makeStateRoot(root);
    const codexHome = await makeCodexHome(root);
    await writeFile(path.join(root, 'project-manager.config.json'), '{ this is not json\n', 'utf8');
    const result = await runDoctor([
      '--repo', root,
      '--host', 'codex',
      '--state-dir', stateRoot,
      '--port', '0',
      '--json',
    ], { CODEX_HOME: codexHome });
    assert.equal(result.code, 1);
    const data = payload(result);
    const configCheck = checkOf(data, 'config.project');
    assert.equal(configCheck.status, 'FAIL');
    assert.match(configCheck.actual, /JSON|解析/);
    assert.match(configCheck.fix, /schema|pm init --force/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('工作台状态目录不可写：FAIL 并给出权限修复命令', async (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('root 用户忽略目录权限位，无法构造不可写目录');
    return;
  }
  const root = await makeRepo();
  let workbench;
  try {
    const state = await makeStateRoot(root);
    workbench = state.workbench;
    const codexHome = await makeCodexHome(root);
    await chmod(workbench, 0o500);
    const result = await runDoctor([
      '--repo', root,
      '--host', 'codex',
      '--state-dir', state.stateRoot,
      '--workbench-state-dir', workbench,
      '--port', '0',
      '--json',
    ], { CODEX_HOME: codexHome });
    assert.equal(result.code, 1);
    const data = payload(result);
    const stateCheck = checkOf(data, 'workbench.stateDir');
    assert.equal(stateCheck.status, 'FAIL');
    assert.match(stateCheck.actual, /不可写/);
    assert.match(stateCheck.fix, /chmod u\+rwx/);
  } finally {
    if (workbench) await chmod(workbench, 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('调用错误：缺少 --repo 返回退出码 2', async () => {
  const result = await runDoctor(['--json']);
  assert.equal(result.code, 2);
  const data = payload(result);
  assert.equal(data.ok, false);
  assert.match(data.error, /--repo/);
});
