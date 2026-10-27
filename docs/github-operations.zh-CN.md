# GitHub 运营巡检

`hourly-operations` 每小时受理开放的人类 issue，维护唯一的 **Maintainer operations queue** 汇总 issue。在仓库 Issues 中按作者 `github-actions[bot]` 查找，或查看工作流末尾 JSON 中的队列编号。仅使用内置 `GITHUB_TOKEN`，权限为 contents/actions 读、issues 写；无需外部 AI 或新秘密，不自动修复、合并或关闭用户 issue。

尚未受理的人类 issue 收到一次固定回执与 `needs-triage` 标签。回复与队列不复制用户标题、正文、身份或日志，只用编号和公开链接。回执代表等待维护者分诊，不能代表已审阅或修复。完成分诊后移除标签，问题解决后关闭用户 issue；重新打开会返回分诊队列，不重复回执。只信任准确 GitHub Actions 机器人身份写的回执，用户粘贴 marker 无法抑制受理。其他机器人 issue 和 PR 不在受理范围。关闭汇总队列不会停用机制，下次成功扫描会重开。

Actions 覆盖各分支的 push、schedule、workflow_dispatch、pull_request、pull_request_target、workflow_run 和 merge_group，包括本巡检此前失败，其他事件不在范围内。`action_required` 单列为“等待维护者审批”，不能当测试失败；是否批准 PR 始终由维护者安全审查决定。本工作流不批准或执行 fork、不检出 PR、不重跑其他作业、不向 PR 评论。

队列保留原 run、attempt、workflow、事件和失败结论链接。同一工作流、事件、分支、来源仓 ID 及 GitHub 提供的 PR 编号集合，后续成功 attempt 或更高 run number 才标记恢复，其他分支/fork/PR 不互相覆盖。队列不复制分支名称，具体分支和提交请查看准确公开 run 链接；若 GitHub 未提供 PR 元数据，则按可用来源仓和分支身份匹配。工作流成功不证明产品问题解决。有后继匹配运行的取消标记 superseded，但未确认取消原因；其他取消需人工查看。未完成运行不算成功，手动成功不能代替定时失败所需的同事件恢复。

扫描预算与限制：

- 每轮按创建顺序取最多 50 个开放 issue，持久轮换分页，已在等待队列的 issue 每轮重检。新旧遗漏 issue 在成功扫描、变动允许时逐步覆盖；页面移动/删除可能延迟覆盖，不保证即时触发。
- 最多 200 个等待分诊 issue、100 条失败、800 次 API 请求；每个选中 issue 的评论/事件各最多三页。最近 Actions 窗口七天且少于 500 条，恰满分页边界时保守失败。扫描前已完成的中间重跑 attempt、未观测到的旧失败可能遗漏；已跟踪未恢复 run 超出七天仍逐一读取。删除/不可读 run 需人工处理。
- 已恢复/superseded 记录在容量不足时淘汰，未恢复失败不静默丢弃。预算耗尽、状态损坏、API 错误会令本轮失败，需要维护者排查、减少积压或调整经审阅实现。失败通过匹配成功运行恢复，不通过编辑队列正文销账。

完整成功后才更新队列“最后成功检查时间”。部分写入（标签、回执）在 API 失败后保留，重试时协调恢复。GitHub 无事务式 exactly-once 保证，外部并发写入或删除/修改机器人回执可能需要人工协调；不要编辑机器状态或删除回执。分诊后维护者仍应跟进，通知送达、回执都不代表问题已处理完成。

手动补跑：**Actions → hourly-operations → Run workflow**，选择默认分支。工作流串行、十分钟超时，API 调用前先跑合成测试。本地逻辑测试不需要凭据或网络：

```sh
python3 -m unittest discover -s .github/scripts -p 'test_*.py'
```

cron 按 UTC 每小时错开整点。GitHub 可能延迟/丢弃定时运行，公开仓长期无活动可能停用 schedule；须保持 Actions 启用并关注队列时间，见 [GitHub schedule 说明](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)。完全停摆时同一 GitHub 平台不能保证自唤醒，手动入口用于恢复。内置令牌写 issue 通常不触发其他工作流，本机制依赖后续定时/手动协调，不添加递归 issue 触发器。

红色运行可查看固定错误码（如 `github_http_403`、`pagination_budget_exhausted`），核对权限、API/速率限制与队列状态；不要粘贴凭据、API 原文或私有日志。失败不更新上次成功时间，后续成功可在覆盖范围内捕获此前巡检失败。首次创建队列会显示“not yet completed”，直到完整成功。

若 GitHub 缺少来源仓身份（例如 fork 已删除），保守限制为同一准确 run 的后续成功 attempt 才恢复。

同一准确 run 与 attempt 的终态变化也会更新记录（例如维护者批准后继续运行）：保留最初关注结论，刷新后来的失败，观测到成功后标记恢复，不会批准或重跑任何运行。未观测到终态前，审批关注记录仍未解除；实时执行阶段请查看对应 run 链接。
