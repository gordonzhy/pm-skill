/**
 * `pm init`（初始化项目任务系统）的端到端契约测试。
 *
 * 使用真实 generate_tasks.py / validate_tasks.py 与临时目录，不启动服务、
 * 不接触真实项目；验证空目录初始化、幂等、--force 备份、失败回滚与配置校验。
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(SCRIPT_DIR, 'init-project.mjs')
const VALIDATE = path.join(SCRIPT_DIR, 'validate_tasks.py')
const PY_ENV = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }

async function tempRoot() {
  return mkdtemp(path.join(os.tmpdir(), 'pm-init-test-'))
}

async function exists(target) {
  try { await stat(target); return true } catch { return false }
}

async function init(repo, extra = [], { expectFailure = false } = {}) {
  const args = [SCRIPT, '--repo', repo, '--prefix', 'DEMO', '--name', '演示项目', '--group', '研发', '--json', ...extra]
  try {
    const { stdout } = await run(process.execPath, args, { env: PY_ENV })
    assert.equal(expectFailure, false, '预期失败但 init 成功了')
    return JSON.parse(stdout)
  } catch (error) {
    assert.equal(expectFailure, true, `init 失败：${error.stderr || error.stdout || error.message}`)
    return JSON.parse(error.stdout || '{}')
  }
}

async function validate(repo) {
  return run('python3', [VALIDATE, repo], { env: PY_ENV })
}

test('空目录一条命令初始化：生成 18 列 CSV、示例任务卡、TASKS.html、配置与 AGENTS 片段', async () => {
  const root = await tempRoot()
  const repo = path.join(root, 'empty-project')
  try {
    const payload = await init(repo)
    assert.equal(payload.ok, true)
    assert.equal(payload.status, 'initialized')
    assert.deepEqual(payload.config.project, { name: '演示项目', prefix: 'DEMO', group: '研发' })
    assert.equal(payload.config.workbench.port, 9999)
    assert.equal(payload.validation.ok, true)
    assert.match(payload.validation.output, /OK: 1 task files/)

    const headers = (await readFile(path.join(repo, 'TASKS.csv'), 'utf8')).split('\n')[0].split(',')
    assert.deepEqual(headers, [
      'id', 'status', 'priority', 'boundary', 'title', 'dependencies', 'executor',
      'created_at', 'modified_at', 'detail_path', 'dispatch_id', 'execution_thread_id',
      'execution_turn_id', 'manager_thread_id', 'manager_turn_id', 'recovery_turn_id',
      'recovery_state', 'recovery_state_at',
    ])
    assert.match(await readFile(path.join(repo, 'TASKS.csv'), 'utf8'), /^DEMO-001,待办,/m)

    const detail = await readFile(path.join(repo, 'work-items', 'DEMO-001.md'), 'utf8')
    assert.match(detail, /^# DEMO-001 /)
    assert.match(detail, /## 任务日志/)
    assert.match(detail, /```yaml/)
    assert.match(detail, /type: "created"/)
    assert.match(detail, /at: "\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}"/)

    const config = JSON.parse(await readFile(path.join(repo, 'project-manager.config.json'), 'utf8'))
    assert.equal(config.project.prefix, 'DEMO')
    assert.equal(config.taskSystem.csv, 'TASKS.csv')

    const agents = await readFile(path.join(repo, 'AGENTS.md'), 'utf8')
    assert.match(agents, /<!-- project-manager:begin -->/)
    assert.match(agents, /DEMO/)
    assert.ok(await exists(path.join(repo, 'TASKS.html')))

    const validation = await validate(repo)
    assert.match(validation.stdout, /OK: 1 task files/)
    assert.match(validation.stdout, /READY: DEMO-001/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('重复执行幂等：不覆盖任何文件，状态为 already-initialized', async () => {
  const root = await tempRoot()
  const repo = path.join(root, 'idempotent')
  try {
    await init(repo)
    const before = new Map()
    for (const relative of ['TASKS.csv', 'TASKS.html', 'project-manager.config.json', 'work-items/DEMO-001.md', 'AGENTS.md']) {
      before.set(relative, await readFile(path.join(repo, relative), 'utf8'))
    }
    const second = await init(repo)
    assert.equal(second.ok, true)
    assert.equal(second.status, 'already-initialized')
    assert.deepEqual(second.files, [])
    for (const [relative, content] of before) {
      assert.equal(await readFile(path.join(repo, relative), 'utf8'), content, `${relative} 不应被修改`)
    }
    assert.match((await validate(repo)).stdout, /OK: 1 task files/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('--force：先备份再重建，已有账本内容被替换且可通过校验', async () => {
  const root = await tempRoot()
  const repo = path.join(root, 'force')
  try {
    await init(repo)
    await writeFile(path.join(repo, 'TASKS.csv'), 'tampered\n', 'utf8')
    await writeFile(path.join(repo, 'work-items', 'DEMO-001.md'), 'tampered detail\n', 'utf8')
    const forced = await init(repo, ['--force'])
    assert.equal(forced.ok, true)
    assert.equal(forced.status, 'initialized')
    assert.ok(forced.backupDir, '应报告备份目录')
    assert.ok(forced.backupDir.includes(path.join(repo, '.project-manager', 'init-backup')), '备份目录应在仓库内')
    assert.equal(await readFile(path.join(forced.backupDir, 'TASKS.csv'), 'utf8'), 'tampered\n')
    assert.match(await readFile(path.join(repo, 'TASKS.csv'), 'utf8'), /^DEMO-001,待办,/m)
    const validation = await validate(repo)
    assert.match(validation.stdout, /OK: 1 task files/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('参数/配置校验失败：不创建任何项目文件', async () => {
  const root = await tempRoot()
  const repo = path.join(root, 'bad-prefix')
  try {
    const payload = await init(repo, ['--prefix', 'demo', '--json'], { expectFailure: true })
    assert.equal(payload.ok, false)
    assert.match(payload.errors.join('；'), /project\.prefix/)
    assert.equal(await exists(path.join(repo, 'TASKS.csv')), false)
    assert.equal(await exists(repo), false, '配置校验失败时不应先创建目录')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('自检失败即回滚：仓库不留半成品', async () => {
  const root = await tempRoot()
  const repo = path.join(root, 'no-python')
  try {
    const payload = await init(repo, ['--python', path.join(root, 'missing-python')], { expectFailure: true })
    assert.equal(payload.ok, false)
    assert.match(payload.errors.join('；'), /Python|回滚|生成 TASKS\.html 失败/)
    assert.equal(await exists(path.join(repo, 'TASKS.csv')), false)
    assert.deepEqual(await readdir(repo), [], '失败后不应留下半成品')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('已有 AGENTS.md 时追加带标记的片段并保留原文', async () => {
  const root = await tempRoot()
  const repo = path.join(root, 'agents')
  try {
    await mkdir(repo, { recursive: true })
    const original = '# 团队约定\n\n- 已有规则。\n'
    await writeFile(path.join(repo, 'AGENTS.md'), original, 'utf8')
    const payload = await init(repo)
    assert.equal(payload.ok, true)
    const agents = await readFile(path.join(repo, 'AGENTS.md'), 'utf8')
    assert.ok(agents.startsWith(original), '应保留已有 AGENTS.md 内容')
    assert.match(agents, /<!-- project-manager:begin -->/)
    assert.equal(agents.match(/project-manager:begin/g).length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('已存在非 CSV 生成物时拒绝覆盖，提示 --force 且不写任何文件', async () => {
  const root = await tempRoot()
  const repo = path.join(root, 'partial')
  try {
    await mkdir(repo, { recursive: true })
    await writeFile(path.join(repo, 'TASKS.html'), 'existing dashboard', 'utf8')
    const payload = await init(repo, [], { expectFailure: true })
    assert.equal(payload.ok, false)
    assert.match(payload.errors.join('；'), /--force/)
    assert.equal(await readFile(path.join(repo, 'TASKS.html'), 'utf8'), 'existing dashboard')
    assert.equal(await exists(path.join(repo, 'TASKS.csv')), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('项目配置损坏时 validate_tasks.py 明确失败（单一配置入口生效）', async () => {
  const root = await tempRoot()
  const repo = path.join(root, 'broken-config')
  try {
    await init(repo)
    await writeFile(path.join(repo, 'project-manager.config.json'), JSON.stringify({ configVersion: 1, project: { name: 'x', prefix: 'bad prefix' } }), 'utf8')
    await assert.rejects(() => validate(repo), (error) => {
      assert.match(error.stdout, /invalid project-manager\.config\.json/)
      assert.match(error.stdout, /project\.prefix/)
      return true
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('自定义 detailsDir 生效，仍通过校验', async () => {
  const root = await tempRoot()
  const repo = path.join(root, 'custom-details')
  try {
    const payload = await init(repo, ['--details-dir', 'tasks/cards'])
    assert.equal(payload.ok, true)
    assert.ok(await exists(path.join(repo, 'tasks/cards/DEMO-001.md')))
    const config = JSON.parse(await readFile(path.join(repo, 'project-manager.config.json'), 'utf8'))
    assert.equal(config.taskSystem.detailsDir, 'tasks/cards')
    assert.match((await validate(repo)).stdout, /OK: 1 task files/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})


test('--empty ignores archived fixtures and independent nested task roots', async () => {
  const root = await tempRoot()
  const repo = path.join(root, 'workspace')
  try {
    await mkdir(path.join(repo, 'archive'), { recursive: true })
    await run('git', ['init', '-q', repo])
    await writeFile(path.join(repo, '.gitignore'), 'archive/\n')
    const detail = '# OTHER-001 Fixture\n\n- 状态：待办\n- 优先级：P0\n- 所属边界：Operations\n- 执行者：Automation QA\n- 依赖：[]\n'
    await writeFile(path.join(repo, 'archive', 'old.md'), detail)
    await mkdir(path.join(repo, 'components', 'independent'), { recursive: true })
    await writeFile(path.join(repo, 'components', 'independent', 'TASKS.csv'), 'independent index\n')
    await writeFile(path.join(repo, 'components', 'independent', 'other.md'), detail)
    const payload = await init(repo, ['--empty'])
    assert.equal(payload.ok, true)
    assert.equal(payload.validation.ok, true)
    assert.match((await validate(repo)).stdout, /OK: 0 task files/)
    assert.equal((await readFile(path.join(repo, 'TASKS.csv'), 'utf8')).trim().split('\n').length, 1)
    assert.equal(await readFile(path.join(repo, 'archive', 'old.md'), 'utf8'), detail)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
