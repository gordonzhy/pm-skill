# Codex 观察与监测

运行观察、Hook 安装和后台监测由独立的 PM Server 提供。Skill 不包含观察写入器或安装器，不依赖后台存在。

```sh
pm-server adapter list
pm-server adapter check codex
pm-server adapter install codex --dry-run
pm-server status --json
```

首次显式启用Codex集成时，Server 0.1.0-rc.4 起使用 `pm-server setup` 终端引导检查并完成Hook配置、服务启动、项目连接及通知验证，可退出后继续；较早版本使用 `pm-server adapter install codex` 后再 `pm-server service start`。随后在Codex CLI使用 `/hooks` 检查并信任当前定义，运行含工具调用的真实会话，再核对事件。仅查询状态不执行安装。

配置检查通过不证明宿主支持事件、信任已经完成或真实事件已投递。历史 Codex 安装器已迁入应用；真实使用前核实目标宿主版本支持的 Hook 格式和信任步骤，不修改内部信任库或绕过信任。授权安装前说明变更用户级配置、影响范围和备份位置；已有明确安装授权不重复询问。

缺少观察时按未知降级，不把未知当空闲，也不把执行空闲当任务完成。新接入使用平台、实例和原生会话 ID 组成的完整引用；旧单宿主 CSV 桥接不能作为混合宿主路由。

后台由程序检查健康；经理负责核对任务事实、回调与验收。提醒去重、投递尝试和监测暂停存于应用目录，不修改任务 CSV。任务决定仍由经理按规则记录日志。

```sh
pm-server monitor pause --repo <仓库> --task <任务ID> --until <未来ISO时间> --reason <原因> --actor <身份>
pm-server monitor resume --repo <仓库> --task <任务ID> --reason <原因> --actor <身份>
```

队列接受不等于经理处理，不承诺 exactly-once。默认没有通知后端；只有显式配置且在目标环境验证的投递方式才允许自动通知。

Server 0.1.0-rc.4 起，CLI `pm-server setup` 为引导主入口，工作台“设置 → 接入引导”按项显示安装、Codex登录/Hook信任、真实事件、项目路由与通知缺口；也可用 `pm-server doctor --check-host --json` 查询。未知不当作完成。Hook按本机用户权限执行，信任前审查来源；通知测试明确指定目标，只有目标确实收到后才确认。较早版本未提供该引导时仍按分步流程检查，不伪造已接入。

## 有期处理检查点与合并提醒

支持此能力的PM Server通过 `pm-server monitor status --repo /project` 只读查看私有提醒状态、冷却或处理中原因及下一检查时间。`monitor checkpoint` 必须显式给出 `--task`、`--dispatch`、`--execution`、`--manager`、`--until`、`--reason`、`--actor`；期限必须在未来且不超过24小时。它只记录已实际核对后的有期处理状态，不改业务状态，也不暂停采集。`monitor release` 使用同样准确身份和原因提前解除检查点（不需 `--until`）。普通CSV或运行turn变化不会清掉检查点；身份变化失效，到期恢复。通知ACCEPTED、经理活动和只读查询都不能替代该显式操作。旧版无此CLI时如实保持人工覆盖，不声称已有程序保证。

活动事项首轮以10分钟窗口合并，同经理后台非最终投递共用至少10分钟间隔，未处理重复按1、2、4、8、16、24小时上限退避（到期再加入合并窗口）。待确认原有首次小时与重复天级策略保持，失败重试至少10分钟。真实最终交接仍走已有直接回调，后台普通运行结束不识别为最终完成。
