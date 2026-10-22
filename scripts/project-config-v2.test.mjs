/**
 * 项目级配置（project-manager.config.json）单一入口的契约测试。
 *
 * 只测 Node 内置能力：不启动服务、不安装、不写真实项目。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_DETAILS_DIR,
  DEFAULT_STATUSES,
  DEFAULT_TASK_CSV,
  DEFAULT_WORKBENCH_PORT,
  PROJECT_CONFIG_FILENAME,
  defaultProjectConfig,
  formatProjectConfig,
  loadProjectConfig,
  normalizeProjectConfig,
  resolveProjectPaths,
  validateProjectConfig,
} from './project-config-v2.mjs'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const SKILL_DIR = path.resolve(SCRIPT_DIR, '..')
const EXAMPLE_PATH = path.join(SKILL_DIR, 'assets', 'project-manager.config.example.json')
const SCHEMA_PATH = path.join(SKILL_DIR, 'assets', 'project-manager.config.schema.json')

async function fixture() {
  return mkdtemp(path.join(os.tmpdir(), 'pm-project-config-'))
}

function validConfig(overrides = {}) {
  return {
    configVersion: 1,
    project: { name: '示例项目', prefix: 'DEMO', group: '研发' },
    taskSystem: { csv: DEFAULT_TASK_CSV, detailsDir: DEFAULT_DETAILS_DIR, statuses: [...DEFAULT_STATUSES] },
    workbench: { port: 9123 },
    ...overrides,
  }
}

test('缺失配置文件时返回默认值，不算错误', async () => {
  const root = await fixture()
  try {
    const loaded = await loadProjectConfig(root)
    assert.equal(loaded.found, false)
    assert.equal(loaded.ok, true)
    assert.deepEqual(loaded.errors, [])
    assert.equal(loaded.config.configVersion, 1)
    assert.equal(loaded.config.taskSystem.csv, DEFAULT_TASK_CSV)
    assert.equal(loaded.config.taskSystem.detailsDir, DEFAULT_DETAILS_DIR)
    assert.equal(loaded.config.workbench.port, DEFAULT_WORKBENCH_PORT)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('默认配置与示例配置都能通过校验，序列化稳定可复读', async () => {
  const defaults = defaultProjectConfig()
  assert.deepEqual(defaults.taskSystem.statuses, [...DEFAULT_STATUSES])
  const example = JSON.parse(await readFile(EXAMPLE_PATH, 'utf8'))
  const validated = validateProjectConfig(example)
  assert.equal(validated.ok, true, validated.errors.join('；'))
  const formatted = formatProjectConfig(validated.config)
  assert.equal(formatProjectConfig(JSON.parse(formatted)), formatted, '序列化应幂等')
  assert.deepEqual(JSON.parse(formatted), normalizeProjectConfig(JSON.parse(formatted)))
})

test('JSON Schema 资产存在且覆盖核心字段', async () => {
  const schema = JSON.parse(await readFile(SCHEMA_PATH, 'utf8'))
  assert.equal(schema.type, 'object')
  for (const key of ['configVersion', 'project', 'taskSystem', 'workbench']) {
    assert.ok(schema.properties[key], `schema 缺少 ${key}`)
  }
  assert.equal(schema.properties.project.required.includes('prefix'), true)
  assert.equal(schema.properties.taskSystem.properties.csv.const, DEFAULT_TASK_CSV)
  assert.equal(schema.properties.workbench.properties.port.default, DEFAULT_WORKBENCH_PORT)
  assert.equal(schema.properties.taskSystem.properties.statuses.maxItems, DEFAULT_STATUSES.length)
})

test('非法配置逐字段报错，不静默接受', () => {
  const cases = [
    [validConfig({ project: { name: '示例', prefix: 'demo' } }), /project\.prefix/],
    [validConfig({ project: { name: '', prefix: 'DEMO' } }), /project\.name/],
    [validConfig({ taskSystem: { csv: 'MY-TASKS.csv', detailsDir: 'work-items' } }), /taskSystem\.csv/],
    [validConfig({ taskSystem: { csv: 'TASKS.csv', detailsDir: '../escape' } }), /taskSystem\.detailsDir/],
    [validConfig({ taskSystem: { csv: 'TASKS.csv', detailsDir: 'work-items', statuses: ['待办'] } }), /taskSystem\.statuses/],
    [validConfig({ workbench: { port: '9999' } }), /workbench\.port/],
    [validConfig({ workbench: { port: 70000 } }), /workbench\.port/],
    [validConfig({ configVersion: 2 }), /configVersion/],
    [validConfig({ extra: true }), /未知字段：extra/],
    [validConfig({ project: { name: '示例', prefix: 'DEMO', colour: 'red' } }), /project\.colour/],
  ]
  for (const [input, pattern] of cases) {
    const result = validateProjectConfig(input)
    assert.equal(result.ok, false, `应拒绝：${JSON.stringify(input)}`)
    assert.match(result.errors.join('；'), pattern)
  }
  assert.throws(() => normalizeProjectConfig({ configVersion: 1 }), /项目配置无效/)
})

test('读取仓库配置：有效/JSON 损坏/结构非法都返回可判断结果', async () => {
  const root = await fixture()
  try {
    await writeFile(path.join(root, PROJECT_CONFIG_FILENAME), formatProjectConfig(validConfig()), 'utf8')
    const loaded = await loadProjectConfig(root)
    assert.equal(loaded.found, true)
    assert.equal(loaded.ok, true)
    assert.equal(loaded.config.project.prefix, 'DEMO')
    assert.equal(loaded.config.workbench.port, 9123)

    await writeFile(path.join(root, PROJECT_CONFIG_FILENAME), '{ not json', 'utf8')
    const broken = await loadProjectConfig(root)
    assert.equal(broken.found, true)
    assert.equal(broken.ok, false)
    assert.match(broken.errors.join('；'), /JSON 解析失败/)

    await writeFile(path.join(root, PROJECT_CONFIG_FILENAME), JSON.stringify(validConfig({ project: { name: 'x', prefix: 'bad prefix' } })), 'utf8')
    const invalid = await loadProjectConfig(root)
    assert.equal(invalid.ok, false)
    assert.match(invalid.errors.join('；'), /project\.prefix/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('resolveProjectPaths 解析仓库内绝对路径，stateDir 可选', async () => {
  const config = normalizeProjectConfig(validConfig({ workbench: { port: 9123, stateDir: '.project-manager/state' } }))
  const resolved = resolveProjectPaths(config, '/tmp/pm-demo-repo')
  assert.equal(resolved.csvPath, path.join('/tmp/pm-demo-repo', 'TASKS.csv'))
  assert.equal(resolved.detailsDir, path.join('/tmp/pm-demo-repo', 'work-items'))
  assert.equal(resolved.workbenchPort, 9123)
  assert.equal(resolved.workbenchStateDir, path.join('/tmp/pm-demo-repo', '.project-manager/state'))
  const withoutState = resolveProjectPaths(normalizeProjectConfig(validConfig()), '/tmp/pm-demo-repo')
  assert.equal(withoutState.workbenchStateDir, null)
})

test('CLI 读取可经符号链接入口调用（安装副本场景）', async () => {
  const root = await fixture()
  try {
    await writeFile(path.join(root, PROJECT_CONFIG_FILENAME), formatProjectConfig(validConfig()), 'utf8')
    const entry = path.join(SCRIPT_DIR, 'project-config-v2.mjs')
    const alias = path.join(root, 'project-config-v2-alias.mjs')
    await symlink(entry, alias)
    const output = JSON.parse(execFileSync(process.execPath, [alias, '--repo', root], { encoding: 'utf8' }))
    assert.equal(output.ok, true)
    assert.equal(output.config.project.prefix, 'DEMO')
    assert.equal(output.resolved.csvPath, path.join(root, 'TASKS.csv'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
