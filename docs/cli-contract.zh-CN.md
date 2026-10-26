# 确定性本地 CLI

`node scripts/pm-cli.mjs` 提供独立启用的 project-files 接口。项目 CSV 和必要文本仍是真源；受支持的本地命令自动完成锁/CAS、关联文件、审计/义务、持久决定、读回与一致发布。它独立于既有项目脚本，不自动迁移旧项目、调用 AI 宿主、连接工作台、安装软件或启动服务。

需要 Node.js 22+、Python 3.10+。当前写适配器限 macOS 本地 APFS；其他平台、linked worktree 和不支持的 Git index 布局明确拒绝。协议为 `project-files/1`，schema `1.3.0`，不等于现有 Server 协议。准确命令与可用性由 `help`、`capability inspect`、`schema` 和 `api describe` 从同一注册表生成。

## 初始化与本地身份

仅在明确接管新的隔离项目时使用 `project init` 或 `flow take-control`。`repo` 和 `input.root` 指向项目绝对路径；提供 opaque project_id、`actor_proof: "local-owner"`，以及 `input: {"root":"/example/atlas","identity":"local-owner","policy":"policy-1"}`。初始 expected_revision 从能力发现返回的空项目 revision 取得。初始化不创建示例任务，拒绝既有旧格式任务。

程序实际检查进程 OS 用户、目录归属及私有本地绑定，固定 checkout 和永久内核锁 inode，登记 **owner-attested** 本地经理。`local-owner` 是策略名称，传入名字本身不是身份证明。这是明确的弱本地信任，不能证明人类、AI 会话、外部授权或宿主角色，不适合作为多用户/多代理安全边界。真实宿主调用、换经理、自动验收及执行再激活仍不可用；同一 OS 所有者可以绕过工具。

永久锁和 bootstrap 绑定位于用户的本地 state 目录，独立于 checkout。不得通过删锁解除争用；已固定身份缺失或变化即阻断。没有 force 或 assume-authorized 入口。

## 一条命令完成关联

请求结构和纯虚构示例见[英文参考](cli-contract.md)。写入包含 command/repo/project_id/actor_proof/idempotency_key/expected_revision/input；查询包含 query/repo/projection/snapshot_token/input。输入 JSON 上限 1 MiB、64 层，拒绝未知字段、重复键、原型键及不安全路径。`input validate` 和 `plan` 只验证结构/返回契约，不读取项目、不授予权限。`input validate` 被拒时返回 `valid: false` 并在 `field` 中给出失败的 schema 路径（如 `projection`、`input.scope.criteria[0]`）；该路径只含注册表定义的属性名与下标，意外键按父路径报告，不回显传入的键名或值。每次查询都必须带 `projection`（`summary` 或 `private-local`），省略按 `INVALID_INPUT` 拒绝。`scope.criteria` 的每一项是 Ref（`^[A-Za-z0-9][A-Za-z0-9._:-]*$`，最多128字符），不是自然语言；人类可读的验收描述写在 `scope.goal`。

已实现的本地动作包括创建、规划阶段范围/依赖修改、审计、owner-attested 授权记录及开工承诺。承诺自动写入关联义务与审计，不启动宿主。活动/已验/已关闭任务和已承诺范围的修改依赖尚未提供的能力，会被拒绝。暂停、取消、撤权先独立持久 deny；旧事务可判时自动续交，再追加保护后继，只发布最后受保护代。pending 明确区分保护已持久与业务文本待合入，不宣称远端已停止。

CSV 独占当前 phase/control/title/dependencies 等索引字段；任务文本保存 scope、对象正文、审计及义务；项目文本保存政策与授权。`.yaml` 文件使用严格 JSON 这一 YAML 1.2 子集，当前不接受通用 YAML 语法。模型不提交原始多文件 patch，也不手工依次同步文件。

## 一致发布与自动恢复

命令在稳定 OS 锁内读取完整受管发现集合和原字节，校 CAS，持久 before/after 与 journal，全量校验后持久 `DECIDED`，才逐文件替换真源。文件/目录 flush 失败不会被忽略；macOS 普通文件请求 `F_FULLFSYNC`。这是有平台边界的进程中断机制，不承诺任意设备断电安全。

唯一 clean Publication 绑定不可变快照，是受支持读者的可见点。替换期间根文件可能混合，因此查询必须使用 snapshot/project snapshot/project inspect/project validate，不分别读活动 CSV 和详情。一个 token 对应同一代；查询不初始化、不恢复、不写缓存。未结事务只返回有校验依据的旧快照并标 stale，或明确拒绝。最新保护 overlay 和高水位独立报告，快照不是执行许可。

请求显式指定 projection=summary 时使用别名，不输出任务标题、路由或路径；private-local 仅按上述 OS 所有者绑定显示必要模型。错误只给稳定 code 和 opaque case，不回显输入或原始异常。

下一次有权写命令会自动 reconcile；也可显式 `project reconcile`。未决定且全 before 的计划自动放弃，已决定的 before/after 混合自动前向完成。恢复不调用宿主、不重放 unknown 效果。第三字节、镜像损坏、身份缺失或不可证明的 Git 漂移保留现场并阻断。派生 Publication/快照丢失时，显式写可从保留的发布证明重建，查询不会暗中写回。

## 结构化冲突与 Git

`project resolve` 使用 exact case ID/digest、typed decision 和授权引用。当前适配器处理任务标题冲突，以及受管 CSV 各 index stage 只在该标题不同的普通 merge；其他冲突明确返回不支持或缺项，不让模型手改 CSV。程序保留原 case/已决定意图，追加决议审计和恢复发布单元；恢复本身中断后继续同一恢复单元。

Git index 重写支持 SHA-1、完整 index v2/v3 和 cache-tree 扩展；保留无关 entry，只把受管已解决路径写成 stage 0，保留 HEAD/merge 控制，不创建 merge commit。split/sparse index、未知扩展、rebase/cherry-pick 恢复和 linked worktree 当前不可用。

取得 index.lock 前先持久同文件系统不可变 seed 与 journal，再用独占 hard-link 证明锁归属。恢复只在原项目锁内操作与 seed 同 inode 的自身锁；同 hash、PID 消失或锁龄均不足以证明归属。外来锁不删除。格式依据见 [Git index](https://git-scm.com/docs/index-format) 与 [lockfile](https://git-scm.com/docs/api-lockfile)。

外部编辑器/Git 不遵守项目锁，后续屏障会检测变化，不能承诺阻止同 OS 所有者任意绕过。业务字节相同的 Git 锚变化可以自动刷新；业务回退不能静默变成当前事实或重新授予执行权。

## 结果与验证边界

非零不等于此前没有提交；unknown（11）优先于 recovery（12）、阻断（20–26/70）、待效果（10）和成功（0）。相同 key/摘要从版本化审计先查原语义收据，不因旧 CAS 或缓存丢失重复操作；相同 key 改输入拒绝。CLI 的本地成功不代表真实宿主运行、专业验收或远端停止。

默认 stdin CLI 不建立宿主身份或调用宿主；实验性进程内 profile 见下文，工作台接入仍不可用。`node --test scripts/pm-cli.test.mjs scripts/file-store.test.mjs` 区分实际强杀/权限错误和注入 IO 故障，不执行物理断电、正式安装或真实数据迁移。`.pm-local/` 和外部锁身份是私有恢复证据，不是可分享文档或可随意删除的缓存。

## 原生项目克隆

新克隆的受支持原生规划数据可先用 private-local 的 `project inspect` 获取未绑定源码 CAS 提示。此结果明确拒绝，不是一致快照，也不创建本地状态。显式 `project adopt` 使用该 revision、原 project_id/policy 及当前 root/identity 建立新 checkout 绑定和 manager epoch，撤销继承 grant，保留业务义务及其期限。私有快照 runtime 标明 checkout_origin 和 execution_activation_required=true。本地规划可以继续，外部执行权不继承；复制私有运行目录或丢失已绑定安全身份时拒绝自动接管。当前仅支持 planned/cancelled 且没有宿主 dispatch/candidate/report/decision 的原生模型，旧格式不迁移。

Node 写进程持有传给锁助手的同一打开文件描述符直到写入结束；助手退出本身不会提前释放写锁。每次发布重新落实全部已接受 deny，独立固定安全 inode 上的校验追加账本防止本地 P 副本丢失抹除保护。普通 Git title 合并还要求其他授权、承诺、义务、审计和证据在应用保护后保持一致。

中断与恢复后的 operation_receipt 使用同一稳定操作标识，operation inspect 可继续查询。历史结果的 effective-control step 明确当前本地控制与保护高水位；结构化恢复取代原未发布意图后，原 key 重试返回 NO_CHANGE/superseded-by-resolution 及关联，不再宣称旧意图已发布。私有 operation view 将原 recorded_result 与当前有效结果、版本化 resolution 关联分开，原始审计不改写。

已决定的恢复单元再次遇到本版支持的 title 第三字节时，新 exact-case 决议可承接原恢复及其全部原单元；程序验证完整承接图，仅发布最后单元，原收据保留传递的决议关联。Git 再次标题决议要求前一已解决 index 完成；保护后继保留祖先的 Git 适配，最终标题和保护字段一起写入暂存区后才发布。未知或不可证明的 index/锁状态仍拒绝。

## 只读义务评估

`monitor evaluate` 为本地查询，`input` 提供当前 snapshot ID 与项目 policy ID。它复用一致快照读取，拒绝陈旧/错配 token 和调用方提供的 observations，扫描项目及全部任务的持久义务，不局限 executing。`private-local` 返回等待/活动/终态计数与逾期 root；summary 仅给 opaque attention 引用。

root 由 project/obligation/obligation_revision/violation_kind 确定。技术 generation、无关审计或自述已消费不改变 root 或期限。查询不发送、消费、回应、满足义务，不恢复事务或启动后台。时钟仍为 owner-attested；逾期结果不是自动效果许可。

## 实验性进程内宿主 profile

此内部集成 API 默认不在 stdin CLI 启用。所有者必须指定已安装 executable、私有 HOME/profile、已认证专属 stdio 连接，以及 route/actor/role/epoch 绑定。JSON 和模型参数不能签发绑定。动态工具 envelope 可生成一次性精确请求身份；程序角色使用独立的所有者进程内绑定。关闭连接使实时授权失效，不证明远端停止。

`HostStore` 复用同一文件事务、保护和恢复引擎，支持原生初始化、lane select/prepare/bind/start、校验、持久 claim/对账、交付/独审/经理决定/关闭及有界义务提醒。固定外部 inventory 在调用前记录许可、调用后记录结果；丢失或损坏即阻断。未知调用只按原身份对账，不重放。`effect refresh-fence` 仅在从未签发许可且持久 validation readset 不变时保留原 claim；相关变更或已签发许可拒绝刷新。暂停/撤权压制尚未签发的调用，对可能运行的任务保留停止义务。

固定适配器只接受注册宿主操作，不接受任意 shell。transport accepted 不等于运行、交付、消费、回应或关闭。宿主创建/开始/停止收据保留宿主时间，缺发生时间时保持 accepted/unknown，不把采集时间当新活动。交付、决定和关闭前核候选 manifest 实际字节。系统 uptime 与墙钟锚检测时钟跳变，不证明外部可信时间。普通列表可见、恢复是独立证明，默认 unknown；要求相应证明的 lane 在 unknown 时不能 bind。

`HostMonitor` 由调用方显式构造，使用独立只读 evaluator 子进程，从源码重建 root，每 root/经理 epoch 一次经理提醒及至多一次独立 owner 升级，固定交付/消费/回应窗口，分别记录运输、消费、实质回应和根解决。技术 ready 不代表项目无需回应；owner 需通过 `attention channel-bind` 显式绑定自身通道，缺通道如实报告不可用；owner 消费/通道处置不解除经理业务责任，窗口耗尽不递归生成提醒。不会安装全局后台服务。经理交接、新 profile 执行重新激活、续行/普通消息命令、通用项目级提醒路由和工作台集成尚未实现，缺能力时拒绝。

当前集成测试使用合成协议进程、真实文件事务及真实 validator/evaluator 子进程，不证明已认证 AI 调用、普通 UI 可见/恢复或真实无人值守闭环。同 OS 所有者绕过、物理断电不在证据范围。运行 inventory、路由、凭据和项目资料应保持私有，不进入通用模板或默认摘要。

## 显式 owner 入口

`node scripts/pm-host.mjs help` 提供独立启用入口，不安装服务、不发现 profile、不登录/复制凭据、不自动发起模型回合。`inspect --config <私有绝对配置路径>` 只检查选定连接，输出布尔状态和 unknown，不以握手证明模型或 UI 可用。配置完整虚构例子见英文同页；JSON 文件须 0600、父目录及 HOME/CODEX_HOME/runtime 须私有 0700，且在受管项目写入范围之外。未知字段、凭据字段和不安全权限拒绝。

`CODEX_HOME` 选择状态/凭据目录；Codex `--profile` 只是配置层，不能作为认证隔离。`file_credentials:true` 仅给本次子进程覆盖 `cli_auth_credentials_store="file"`，不改全局配置。没有可用认证时，prepare/serve 拒绝。新专属 profile 可由 owner 手动使用官方 CLI 登录：

```sh
env HOME=/path/to/private-owner/home CODEX_HOME=/path/to/private-owner/profile \
  /path/to/codex -c 'cli_auth_credentials_store="file"' login --device-auth
```

此为 owner 显式操作，会进入认证流程并在所选私有 profile 存储凭据；入口不自动触发，只读原生认证状态，不解析/复制凭据文件或要求粘贴密钥；认证存储由原生 CLI 管理。官方[认证说明](https://learn.chatgpt.com/docs/auth)与[app-server 生命周期](https://learn.chatgpt.com/docs/app-server)不代替实际账号/政策验证。

`prepare-controller --config <路径>` 显式创建带动态工具、只读 sandbox 的 dormant manager/owner/reviewer 上下文，不发模型 turn、不改项目业务真源。它复用 OS 项目锁/flush 和 inventory 解析器，原生创建前写技术许可；结果未知不重建。保留私有记录，不当缓存删除。默认不输出路由；加 `--private-local` 才向本机 owner 显示上下文 ID。

`serve --config <路径>` 仅绑定配置/已准备的真实上下文并显式 resume，只有原生 dynamic-tool envelope 可提交模型意图。可选 `--instruction <私有绝对文本路径> --message-id <稳定标识>` 向已准备 controller 提交 owner 自写文本；文件须 0600 且不在项目可写范围内。提交前记稳定 ID/digest，同 ID 改输入或前次 unknown 拒绝重发。该显式选项会发生模型用量；accepted 不等于 running，停止网关也不证明远端工作停止。

bootstrap 时先保留 `monitor:false`，待真实 controller 工具调用完成项目初始化后再显式启用监测，不安装 OS 托管后台。现有角色/activation/领域引擎检查继续适用，owner 准备上下文或发指令不能绕过业务派发门槛。

`socket` 可替代 `executable` 选择私有父目录下的专属 Unix listener，不发现/兜底正式 socket；断开客户端不停止外部服务。合成 socket 接入有测试，实际 CLI 的 Unix listener 必须另核可用性。专属 profile 的列表或 CLI resume 不能证明另一应用普通 UI 的可见/恢复；缺独立可信宿主接口时，两项硬门槛继续 unknown。

## 私有本机执行交接

新增显式 `worker ...` 命令复用同一注册表、source CAS、FileStore journal/Publication及持久操作回执。`project.worker_control`记录派发与经理责任，不另造任务账本。本机profile只有owner-attested保证，不能升格为强宿主身份；host-origin项目仍必须走已有真实宿主绑定。跨项目handoff/inbox保持独立且尚不可执行。

经理先显式登记dispatch、worker、私有spool/证据根及稳定commitment/lineage身份，再执行任务。每项责任有初始检查、固定总期限、最多两次带实际新证据的延期及一次本机owner升级。修订、观察变化、重启和本机协调epoch轮换均不重置预算；epoch轮换不实现宿主经理交接。

publish先核精确目录/证据字节/不可变序列链，flush私有信封后原子发布且不替换已有事件；即使项目镜像事务前崩溃，经理仍可发现已持久信封。同事件异字节拒绝；final只是执行者自报，不代表业务完成。文件缺失/损坏不授权重放业务动作。

reconcile只拉取已登记spool，保留单信封问题，并在缺运行观察时仍检查责任期限，记录有限升级；不发送消息、不启动或重派执行者。通知记录独立：每dispatch仅一个汇总提示尝试，拒绝/unknown不能换key或目标重发。此保守实现依赖后续本机拉取，不自动启用后台进程。

consume只记录读到精确信封；dispose必须关联新产生且相关的经理业务收据，或具有实际证据文件、动作、负责人和期限的有界检查点。检查点不满足业务审阅/关闭根义务。接受候选的业务收据还须匹配信封候选；未完worker责任阻止host work close。多承诺独立，修订不恢复已耗预算。

runtime observe仅允许显式本机owner-attested样本，发生时间与采集时间分离，重读旧缓存不能延长active有效期；该本机输入不能取得host-origin保证。claim明确保证层和新鲜度；pm-worker claim先reconcile，失败只返回unknown，不回退旧runningHint。软件不能保证不受约束的助手每次发言都调用工具。

### 入口与旧账本兼容

运行 `node scripts/pm-worker.mjs help`。私有目录中的0600配置严格包含以下字段：

```json
{"version":1,"mode":"legacy-compat","project_id":"ATLAS","control_repo":"/path/to/private-owner/control","state":"/path/to/private-owner/state","legacy_root":"/path/to/atlas"}
```

control_repo/state需已存在且位于旧项目外；本机原生项目用native及legacy_root:null。request显式选择注册表命令；新协调项目须另行显式project init、work create和dispatch register，不自动发现/接管旧任务，不安装、不修改真实任务文件。

旧18列项目的sidecar同样用FileStore/同一reducer。legacy prepare先持久记录CSV前/后精确digest及任务日志digest，授权经理再改中央。reconcile核实际after字节和日志中的稳定operation_id标记，才完成回执；CLI不写中央CSV/详情。未完成或冲突保持需对账，恢复不重放经理写入。兼容回执只有owner-attested保证，不能证明专业验收。

finish --config仅接受worker-publish请求，持久发布后才返回成功；调用者可据此结束自己的进程/回合，不能拦截未托管宿主的终止。失败不会声称交接成功。coverage --installed-root检查明确安装根，入口缺失时报告legacy-manual；源码存在不代表自动交接/补扫/唤醒已启用。本机协调不需要认证。

默认包装输出省略项目名、路径、路由及信封正文；完整数据必须显式--private-local。保留私有信封与回执作为恢复数据，不能当缓存清理。隔离测试只证明相应层，不证明真实认证AI、普通App UI、正式安装或所有参与者停止后仍会永久推进。

本地 worker 私有配置还须明确 `control_epoch`（例如 `epoch-a`）；除登记外每次写入均校验该 epoch，刷新 CAS 不会刷新旧意图。协调者变更须显式更新配置。legacy 核验要求标准18列、其他行与任务字段不变、派发/路由/详情匹配，以及有效结构化经理日志将操作、任务、派发、envelope、候选、scope revision和决定绑定；仅字节hash或无关operation标记不足以消责。

显式 owner 程序可通过 `attemptWorkerNotice` 接入自己的原生回调：先持久取得许可，目标取自合同，正文固定通用，调用后登记结果。每个派发仅一次经理提示、每个承诺lineage最多一次owner提示；拒绝、未知或许可后崩溃均不重发。它不是模型通用发送器，不自动启用外发或后台服务。
