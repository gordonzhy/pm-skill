# Platform support

[Product overview](../README.md) · [简体中文](platform-support.zh-CN.md)

**Codex ✅ Ready to try · Claude Code 🚧 Not ready · DSH 🚧 Not ready**

Status as of 2026-10-22. The main matrix covers the existing Skill + optional PM Server daily management workflow. Codex has been verified in actual use, including manager-led dispatch, continuation, handoff and evidence review. It is not held back by unfinished experimental native CLI work. Claude Code and DSH have shared rules and partial adapters, but are not yet validated as usable platform workflows.

✅ Verified usable · 🚧 Not ready. Short notes describe what still needs implementation or platform validation.

| Feature | Codex | Claude Code | DSH |
| --- | --- | --- | --- |
| Installation / use | ✅ Standard Skill installation and actual use verified [1] | 🚧 Host discovery guidance; loading validation pending [1] | 🚧 Host discovery guidance; loading validation pending [1] |
| Planning / task records | ✅ Rules and task tools verified in use [2] | 🚧 Shared rules / tools; platform use pending [2] | 🚧 Shared rules / tools; platform use pending [2] |
| Manager dispatch / continuation | ✅ Existing manager-led workflow verified [4] | 🚧 Native session collaboration pending [4] | 🚧 Native session collaboration pending [4] |
| Delivery / handoff | ✅ Existing delivery and manager handoff verified [5] | 🚧 Real platform handoff pending [5] | 🚧 Real platform handoff pending [5] |
| Shared workbench | ✅ Via optional PM Server [6] | 🚧 Shared project display; host workflow pending [6] | 🚧 Shared project display; host workflow pending [6] |
| Runtime observation | ✅ Via configured PM Server integration [6] | 🚧 Server event ingress; native Hook auto-install not provided [6] | 🚧 Cordis observer implemented; real host validation pending [6] |
| Exception reminders / manager follow-up | ✅ Existing workflow via configured PM Server [6] | 🚧 Native delivery, wake-up and follow-up pending [6] | 🚧 Observer has no sender; native delivery/follow-up pending [6] |
| Evidence / acceptance | ✅ Manager-led evidence review and acceptance verified [7] | 🚧 Review rules available; platform workflow pending [7] | 🚧 Review rules available; platform workflow pending [7] |

PM Server features require the service, runtime observation and an explicitly configured notification backend. Configuration, event ingestion, transport acceptance and manager handling remain different evidence. The verified Codex workflow includes human/model manager judgment; it does not promise fully unattended execution, automatic retry or automatic acceptance.

## Experimental additions / remaining work

The current source label `0.1.0-rc.8` includes **Unreleased** native CLI additions; older downloads may differ. Check the selected commit, [changelog](../CHANGELOG.md) and runtime capability output. These additions are separate from the verified workflow above:

- **Local tools implemented:** shared local CSV transactions, consistent snapshots, bounded recovery and explicit worker publish/pull [3][5]. This is one implementation, not three host integrations. Writes support macOS local APFS, Node.js 22+ and Python 3.10+, using OS owner attestation rather than authenticated AI identity. Unsupported platforms, linked worktrees and Git index layouts are rejected.
- **Native capabilities not provided:** `dispatch continue`, `dispatch message`, strong-host manager handover, cross-project handoff/inbox and native workbench integration [4][7]. This does not remove manager-led continuation or the existing Server workbench.
- **Still unverified:** complete authenticated native-host delivery, ordinary application visibility/recovery and fully unattended operation [4][7]. Shared local tests and synthetic peers do not establish these results.

## Scope and references

1. **Installation:** see [setup](getting-started.md#install) and the [Codex](../references/adapters/codex.md), [Claude Code](../references/adapters/claude-code.md) and [DSH](../references/adapters/dsh.md) adapters. Codex is verified usable in the existing management workflow. File placement alone is not a loading check for an untested host or a new installation; Claude Code and DSH still require that check.
2. **Planning:** [management rules](../SKILL.md) and [task system](../references/task-system.md) provide goals, ownership, dependencies, task logs and evidence review. Legacy 18-column CSV/HTML projects use their existing tools. New `project-files/1` projects use the local CLI; do not mix their writers or infer successful model management from script availability.
3. **Local CLI:** [CLI contract](cli-contract.md) covers initialization, planning edits, protection, consistent snapshots and bounded recovery. Run `node scripts/pm-cli.mjs capability inspect` from the Skill directory: `local-command` / `local-query` are local implementations, `host-command` requires a separate trusted host binding, and `unavailable` rejects. A schema or command name is not proof of executable support.
4. **Execution:** manager-led dispatch requires checking the current host for user-visible independent sessions, real identities, listing/reading, continuation and callbacks; see the [Codex adapter](../references/adapters/codex.md#工具映射与能力验证). Team agents or a fresh context cannot replace formal implementation, independent acceptance or PMO sessions. Historical calls do not establish current visibility or idle-manager wake-up. The experimental [owner host entry](cli-contract.md#explicit-owner-entry) requires explicit private configuration and authentication; it does not establish ordinary application visibility/recovery. Native `dispatch continue`, `dispatch message` and manager handover remain unavailable. Other hosts must not inherit Codex tool assumptions.
5. **Handoff:** the existing workflow uses execution reports, manager pull and evidence review. Separately, opt-in [private local worker handoffs](cli-contract.md#private-local-worker-handoffs) implement registration, durable publication, manager pull, consumption and evidenced disposition. The [fictional walkthrough](../examples/local-worker-walkthrough.mjs) exercises the local file flow. It starts no AI, notification service or continuous scanner. A worker must explicitly publish; the wrapper cannot intercept an unmanaged host's termination. Legacy compatibility does not write the central ledger. A consumed handoff or checkpoint leaves unfinished business responsibility open.
6. **Observation and reminders:** these are optional [PM Server integrations](getting-started.md#use-with-pm-server), separate from the native CLI. The DSH observer records only Cordis lifecycle events; it does not create tools, dispatch agents or send notifications. Configuration, event ingestion, transport acceptance, actual receipt, wake-up and manager action need separate evidence. Missing observation means unknown, not idle or complete. The local worker coordinator offers explicit reconciliation and bounded responsibilities; PM Server does not automatically consume that protocol. The experimental host monitor is explicitly constructed and installs no background service.
7. **Acceptance:** the existing Codex manager-led review and acceptance workflow is verified in use. [Delivery rules](../references/delivery-loop.md) and [independent testing](../references/independent-testing.md) guide the manager; quality decisions still require evidence and judgment. The [experimental host profile](cli-contract.md#experimental-in-process-host-profile) implements guarded delivery/review/decision/closure APIs, tested with synthetic peers. It does not prove an authenticated model journey. Cross-project handoff/inbox and native workbench integration remain unavailable; complete real-host unattended delivery is unverified on all three hosts.

Codex is ready to try for the existing manager-led workflow. Treat Claude Code and DSH as adaptation targets until their actual loading, collaboration and follow-up paths have been verified. Installing the Skill alone does not enable PM Server integrations.
