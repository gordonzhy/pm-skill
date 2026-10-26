# PM Skill 安装与开发

[产品介绍](../README.zh-CN.md) · [English](getting-started.md)

## 安装

本目录本身是可独立安装的 Skill，入口为 `SKILL.md`，内部名称为 `project-manager`。从本项目 GitHub 的固定版本或 Release 获取，保留整个目录结构。

### Codex 标准安装

在 Codex 对话中调用内置安装技能，来源为本仓库根目录：

```text
$skill-installer 将 https://github.com/gordonzhy/pm-skill 仓库根目录的技能安装为 project-manager。
```

需要可复现安装时指定 tag 或 commit。须具备仓库访问权限；这条说明不代表已验证匿名获取。由于 `SKILL.md` 位于仓库根目录，请明确安装名称为 `project-manager`。该方式使用 [OpenAI 官方说明中的标准安装技能](https://learn.chatgpt.com/docs/build-skills#install-curated-skills-for-local-use)。

已有本地副本时，也可将完整技能目录放到 `~/.agents/skills/project-manager/`（用户级）或 `<你的项目>/.agents/skills/project-manager/`（项目级），保留脚本、引用和资源。目录规则见[官方发现路径](https://learn.chatgpt.com/docs/build-skills#where-codex-loads-local-skills)。安装后调用 `$project-manager`；如未出现，重启 Codex。

标准安装器遇到已存在的目标目录会拒绝覆盖；更新前先备份已有安装，避免多份副本。已有 `pm-skill` 安装时，下方本地更新工具会核验产品归属，将旧副本备份到技能发现目录以外并迁移为 `project-manager`；遇到无关技能或链接目录会拒绝操作。使用标准安装器时，先将旧副本备份到发现目录以外。安装技能本身不启用 Hook、不启动 PM Server、不登记项目。

### 可选的本地候选更新

从下载或克隆的技能目录更新，需要备份、哈希校验及失败回滚时，可运行：

```sh
python3 scripts/install_local.py --codex-root /path/to/codex-root
```

它安装到 `<codex-root>/skills/project-manager` 并备份已有安装，用于本地候选更新，不是标准 Codex 安装的前置条件。使用前确认目标宿主会发现该目录；当前标准发现路径可采用上面的目录安装方式。避免在多个位置重复安装同一技能。

Claude Code 的用户级 Skill 从 `~/.claude/skills/<name>/` 加载：把完整目录放到 `~/.claude/skills/project-manager/`，用 `/project-manager` 调用。本机在 Claude Code 2.1.310 上观测到加载与斜杠调用成功；会话列表、续行、回调与验收在该宿主仍未验证。DSH 请按实际宿主的 Skill 发现机制安装。平台说明见 `references/adapters/`；本版尚未完成三平台真实加载验收，不把文件安装成功表述成平台全能力通过。

## 本机CLI常用短流程

新项目首选 `project-files/1` 本机接口，需要 Node.js 22+、Python 3.10+，当前写入限 macOS 本地 APFS。已有项目沿用自己的后端，不自动迁移。此入口是OS owner-attested本机协调，不是真实AI经理路由、宿主派发或工作台接管。

从本Skill目录运行实际发现入口：

```sh
node scripts/pm-cli.mjs help
node scripts/pm-cli.mjs capability inspect
node scripts/pm-cli.mjs schema
```

命令名出现在help中不代表可执行。仅在能力清单标为 `local-command` / `local-query` 的入口执行本机流程；`host-command`需要另行建立宿主绑定，`unavailable`明确未实现。

| 日常动作 | 实际入口 |
| --- | --- |
| 初始化空项目、创建任务 | `project init` → `work create` |
| 调整目标/依赖 | `work amend` / `work dependencies` |
| 查看当前真源 | `snapshot`；请求显式指定projection=summary，private-local仅本机详情 |
| 检查结构/查看合同 | `input validate` / `plan`；不执行、不授权。`input validate` 被拒时在 `field` 中给出失败字段，不回显传入的键名或值 |
| 执行者本机交接 | `worker dispatch register` 后 `pm-worker finish --config <私有配置>` |
| 经理拉取与处理 | `worker reconcile` → `worker handoff inspect` → `worker handoff consume` → `worker handoff dispose` |

上表除发现入口和pm-worker外，每个命令从stdin读取JSON：`node scripts/pm-cli.mjs work create < request.json`。写请求包含协议、项目根/ID、local-owner、唯一幂等键、当前expected_revision与input；首个revision取capability的empty_project_revision，后续取上一成功结果或新snapshot。查询使用query而不是command，且必须携带 `projection`（`summary` 或 `private-local`），省略即按 `INVALID_INPUT` 拒绝。例如：

```json
{
  "protocol": "project-files/1",
  "query": "project validate",
  "repo": "/example/atlas",
  "projection": "summary",
  "snapshot_token": null,
  "input": {}
}
```

精确字段由schema生成，参见[最小请求与本机信任边界](cli-contract.zh-CN.md)。`scope.criteria` 的每一项是 Ref 而不是自然语言：需匹配 `^[A-Za-z0-9][A-Za-z0-9._:-]*$`、最多128字符的 ASCII 标识；人类可读的验收描述写在 `scope.goal`。不要复制占位revision执行；同一意图重试须保留原请求/键，不把冲突请求改成覆盖。

可直接运行一条完整虚构流程：

```sh
node examples/local-worker-walkthrough.mjs --run --private-local
```

示例只创建自己的临时空项目、私有HOME/状态/spool，不读改已有项目或全局安装。源码逐步调用上述真实CLI：创建 → 校验/规划 → 调整目标 → 查询 → 持久交接 → 经理consume并登记有证据与期限的检查点。输出应为created/planned/handoff_published/manager_consumed/checkpoint_recorded=true，responsibility_open=true、runtime=unknown、business_accepted=false。`--private-local`仅向本机显示证据目录，其中transcript保留每条实际JSON输入/输出；分享前不要带该私有目录或实例数据。省略该参数时输出不含路径。示例保留临时证据，不自动删除。

检查点不是业务验收，consume不是消责；模型判断异常、续办与质量，再通过受控业务命令记录实际决定。这个短流程不启动AI、发送通知、常驻扫描或自动唤醒；强宿主换代、跨项目handoff/inbox与自动legacy处置未实现。真实宿主与验收另读[CLI契约](cli-contract.zh-CN.md)，不得据示例声明业务完成。

## 已有18列项目与manual边界

旧项目继续使用已安装版本的管理脚本；下列入口仅适用于明确选择旧18列CSV/HTML后端的项目，不能写native项目：

```sh
node scripts/init-project.mjs --repo /project --prefix DEMO --name '示例项目'
python3 scripts/validate_tasks.py /project
node scripts/collect-project-state.mjs --repo /project --init
```

仅查询不初始化。未安装、配置并登记worker协调能力时为manual：授权本机报告供经理拉取，无自动outbox/唤醒保证。显式legacy-compat只在私有sidecar登记/回读，中央仍由授权经理写；不自动迁移、生成新业务任务或猜真实会话身份。

## 搭配 PM Server

以下现有工作台登记面向旧18列后端；native短流程不自动接入或迁移到它。

PM Skill 负责规划、派发、证据核对与验收；[PM Server](https://github.com/gordonzhy/pm-server) 提供统一任务工作台和后台执行跟进。按应用指南安装并启动服务后，检查状态并自动登记项目：

```sh
pm-server status --json
pm-server project request --repo /project
```

有效项目自动登记，无需确认；在工作台设置中移除会加入黑名单，禁止自动重加，需要时可显式恢复或取消屏蔽。工作台聚合各项目的任务真源、依赖和证据，不接管任务状态。

要启用任务执行兜底，还需按 [PM Server 使用指南](https://github.com/gordonzhy/pm-server/blob/main/docs/usage.zh-CN.md)接入目标宿主的运行观察，并显式配置通知后端。后台检查无需保持浏览器页面打开；执行会话不活动时，可提醒登记经理核对遗漏的回调或交接；观察缺失、过期时发出警告，不据此推断执行失败。经理核对实际成果，协调继续执行或修正，再作验收决定。监测不会自动重试任务或接受交付。监测工作进程故障或超时可有界重启，顶层服务仍须保持运行。在依赖兜底前，应在目标宿主验证实际观察与提醒投递。详见[监测规则](../references/acceptance-watch.md)。

没有应用时，基础任务管理继续工作。需要应用能力时按其安装说明安装；只读查询不会自动安装、启动或接管项目。应用停用后，Skill 不应重新拉起它。

Skill 通过公共 CLI 调用 PM Server，可用 `PM_SERVER_BIN` 显式指定可执行文件。两者不依赖相邻源码目录，跨项目契约见 `contracts/protocol.json`。

## 开发检查

```sh
python3 scripts/verify_team_share.py
```

该命令执行已支持能力与未支持能力的准确拒绝回归，不代表完整D3验收。完整33场景/62组合保留独立入口：

```sh
node --test scripts/worker-full-d3.acceptance.mjs
```

强宿主管理权换代仍未实现，完整D3的native S28保持失败；普通回归覆盖其准确拒绝且不改变领域/外部效果，不把该负测算成D3成功迁移。


检查在临时 Codex 根目录安装后运行 Node 与 Python 回归，不修改真实全局配置。这个结果证明候选安装和工具行为，不代替真实平台加载或业务项目验收。

源码、使用说明和发布包均独立于 PM Server。采用 [MIT 许可证](../LICENSE)，稳定发布版本独立维护。

仅旧18列后端明确要求接管经理时，`scripts/initialize-manager.mjs --repo /project --manager-thread <真实会话ID>` 会自动创建缺失的管理结构，使用空账本，不生成示例或业务任务。项目经理写入 `project-manager.config.json` 的 `manager` 并回读验证，维护文档中的角色记录不算登记。既有执行路由、任务状态及授权保留，接管不启动交付。
