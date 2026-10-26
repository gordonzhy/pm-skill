import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { defaultDashboardPort, readProjectConfig } from "./project-config.mjs";
import { formatProjectConfig, normalizeProjectConfig } from "./project-config-v2.mjs";

test("project defaults keep a stable port without inheriting process model choices", async () => {
  const first = await mkdtemp(path.join(os.tmpdir(), "project-manager-config-"));
  const previous = process.env.PROJECT_MANAGER_MODEL_ROUTINE;
  process.env.PROJECT_MANAGER_MODEL_ROUTINE = "unrelated-model";
  try {
    const config = await readProjectConfig(first);
    assert.equal(config.port, 9999);
    assert.equal(defaultDashboardPort(first), defaultDashboardPort("/unrelated/project"));
    assert.equal(config.portSource, "default");
    assert.deepEqual(config.models.routine, { model: null, reasoning: null });
    assert.equal((await readProjectConfig(first)).port, config.port);
  } finally {
    if (previous === undefined) delete process.env.PROJECT_MANAGER_MODEL_ROUTINE;
    else process.env.PROJECT_MANAGER_MODEL_ROUTINE = previous;
  }
});

test("project .env ignores obsolete port settings and preserves model fields", async () => {
  const first = await mkdtemp(path.join(os.tmpdir(), "project-manager-config-"));
  const second = await mkdtemp(path.join(os.tmpdir(), "project-manager-config-"));
  await writeFile(path.join(first, ".env"), [
    "UNRELATED_SECRET=never-print-this",
    "PROJECT_MANAGER_PORT=45123 # local dashboard",
    "PROJECT_MANAGER_MODEL_COMPLEX='example-model'",
    "PROJECT_MANAGER_REASONING_COMPLEX=high",
    "",
  ].join("\n"));
  const configured = await readProjectConfig(first);
  assert.equal(configured.port, 9999);
  assert.equal(configured.portSource, "default");
  assert.deepEqual(configured.models.complex, { model: "example-model", reasoning: "high" });
  assert.doesNotMatch(JSON.stringify(configured), /never-print-this/);
  assert.deepEqual((await readProjectConfig(second)).models.complex, { model: null, reasoning: null });
});

test("obsolete project port is ignored while invalid reasoning fails", async () => {
  const repository = await mkdtemp(path.join(os.tmpdir(), "project-manager-config-"));
  await writeFile(path.join(repository, ".env"), "PROJECT_MANAGER_PORT=0\n");
  assert.equal((await readProjectConfig(repository)).port, 9999);
  await writeFile(path.join(repository, ".env"), "PROJECT_MANAGER_REASONING_HIGH_RISK=automatic\n");
  await assert.rejects(readProjectConfig(repository), /PROJECT_MANAGER_REASONING_HIGH_RISK/);
});

test("PMO binding is local, validated, and does not expose unrelated fields", async () => {
  const first = await mkdtemp(path.join(os.tmpdir(), "project-manager-pmo-"));
  const second = await mkdtemp(path.join(os.tmpdir(), "project-manager-pmo-"));
  const id = "11111111-1111-4111-8111-111111111111"; // Fictional UUID for this fixture.
  await writeFile(path.join(first, ".env"), `PROJECT_MANAGER_PMO_THREAD_ID='${id}'\nUNRELATED_SECRET=keep-private\n`);
  const config = await readProjectConfig(first);
  assert.equal(config.pmoThreadId, id);
  assert.doesNotMatch(JSON.stringify(config), /keep-private/);
  assert.equal((await readProjectConfig(second)).pmoThreadId, null);
  await writeFile(path.join(first, ".env"), "PROJECT_MANAGER_PMO_THREAD_ID=not-a-thread\n");
  assert.match((await readProjectConfig(first)).pmoBindingError, /UUID/);
  await writeFile(path.join(first, ".env"), `PROJECT_MANAGER_PMO_THREAD_ID=${id}\nPROJECT_MANAGER_PMO_THREAD_ID=${id}\n`);
  assert.match((await readProjectConfig(first)).pmoBindingError, /重复定义/);
});

test("invalid PMO metadata preserves usable dashboard and model config without leaking it", async () => {
  const repository = await mkdtemp(path.join(os.tmpdir(), "project-manager-pmo-degrade-"));
  for (const binding of ["bad-secret-value", "'unterminated-secret"]) {
    await writeFile(path.join(repository, ".env"), `PROJECT_MANAGER_PORT=45123\nPROJECT_MANAGER_MODEL_ROUTINE=example-model\nPROJECT_MANAGER_REASONING_ROUTINE=medium\nPROJECT_MANAGER_PMO_THREAD_ID=${binding}\n`);
    const config = await readProjectConfig(repository);
    assert.equal(config.pmoThreadId, null);
    assert.ok(config.pmoBindingError);
    assert.equal(config.port, 9999);
    assert.deepEqual(config.models.routine, { model: "example-model", reasoning: "medium" });
    assert.doesNotMatch(JSON.stringify(config), /bad-secret-value|unterminated-secret/);
  }
});

test("CLI entry detection works through a symlinked invocation path", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "project-manager-config-cli-"));
  try {
    await writeFile(path.join(directory, ".env"), "PROJECT_MANAGER_MODEL_ROUTINE=example-model\n");
    const entry = fileURLToPath(new URL("./project-config.mjs", import.meta.url));
    const alias = path.join(directory, "project-config-alias.mjs");
    await symlink(entry, alias);
    const output = execFileSync(process.execPath, [alias, "--repo", directory], { encoding: "utf8" });
    assert.deepEqual(JSON.parse(output).models.routine, { model: "example-model", reasoning: null });
    assert.equal(JSON.parse(execFileSync(process.execPath, [entry, "--repo", directory], { encoding: "utf8" })).port, 9999);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("project-manager.config.json 是工作台端口的单一入口，并与 .env 白名单并存", async () => {
  const repository = await mkdtemp(path.join(os.tmpdir(), "project-manager-config-v2-"));
  try {
    const config = normalizeProjectConfig({
      configVersion: 1,
      project: { name: "集成测试项目", prefix: "ITP", group: "研发" },
      taskSystem: { csv: "TASKS.csv", detailsDir: "work-items" },
      workbench: { port: 9234 },
    });
    await writeFile(path.join(repository, "project-manager.config.json"), formatProjectConfig(config), "utf8");
    await writeFile(path.join(repository, ".env"), "PROJECT_MANAGER_MODEL_ROUTINE=example-model\n");
    const loaded = await readProjectConfig(repository);
    assert.equal(loaded.port, 9234);
    assert.equal(loaded.portSource, "project-config");
    assert.equal(loaded.projectConfig.project.prefix, "ITP");
    assert.equal(loaded.csvPath, path.join(repository, "TASKS.csv"));
    assert.equal(loaded.detailsDir, path.join(repository, "work-items"));
    assert.deepEqual(loaded.models.routine, { model: "example-model", reasoning: null });
    assert.equal(loaded.projectConfigError, null);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("项目配置无效时端口降级为默认值并报告错误，不吞掉 .env 模型字段", async () => {
  const repository = await mkdtemp(path.join(os.tmpdir(), "project-manager-config-bad-"));
  try {
    await writeFile(path.join(repository, "project-manager.config.json"), JSON.stringify({ configVersion: 1, project: { name: "x", prefix: "bad prefix" } }), "utf8");
    await writeFile(path.join(repository, ".env"), "PROJECT_MANAGER_MODEL_COMPLEX=example-model\n");
    const loaded = await readProjectConfig(repository);
    assert.equal(loaded.port, 9999);
    assert.equal(loaded.portSource, "default");
    assert.match(loaded.projectConfigError, /project-manager\.config\.json 无效/);
    assert.match(loaded.projectConfigError, /project\.prefix/);
    assert.equal(loaded.projectConfig, null);
    assert.deepEqual(loaded.models.complex, { model: "example-model", reasoning: null });
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});
