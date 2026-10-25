# DSH 适配

复用 PM Skill 核心规则和工具。会话真实身份须由环境提供，不从名称或日志猜测。派发、恢复和回调按当前宿主实际暴露能力执行，不能套用 Codex 工具名。经理命名按[初始化](../manager-session.md)尝试并回读；正式实现、独立验收和 PMO 按[执行车道](../execution-lanes.md)核对用户可见独立宿主会话，不凭 `agent/created` 或路由名称推断可见性。缺能力时明确未完成项，不降级为子智能体或由经理代做。

运行观察由 PM Server 的 `adapters/dsh/observer.js` 可选提供。只依赖 Cordis `apply(ctx)` 和 `agent/created`、`agent/status`、`agent/disposed`，不注册模型工具、命令或 agent preset。新包路径的真实加载仍需验证。

实例加载标记不证明生命周期事件已经到达。安装或修改插件后按实际宿主要求重载，再用真实事件核验。通知需要显式配置并验证后端，不默认回退到 Codex。
