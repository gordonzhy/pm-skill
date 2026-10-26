# PM Skill setup and development

[Product overview](../README.md) · [简体中文](getting-started.zh-CN.md)

## Install

This directory is an independently installable Skill. Its entry point is `SKILL.md` and its internal name is `project-manager`. Download a fixed GitHub tag, commit or Release and preserve the directory structure.

### Standard Codex installation

Ask Codex's built-in installer to install the skill from this repository's root:

```text
$skill-installer Install the skill at the root of https://github.com/gordonzhy/pm-skill as project-manager.
```

Specify a tag or commit for a reproducible install. The repository must be accessible with your existing permissions; this command does not imply anonymous availability. The explicit name matters because `SKILL.md` is at the repository root. This uses the standard installer documented in [OpenAI's skills guide](https://learn.chatgpt.com/docs/build-skills#install-curated-skills-for-local-use).

For a local copy, put the complete skill folder at `~/.agents/skills/project-manager/` (user scope) or `<your-project>/.agents/skills/project-manager/` (repository scope), preserving scripts, references and assets. See the [official discovery locations](https://learn.chatgpt.com/docs/build-skills#where-codex-loads-local-skills). Invoke `$project-manager` after installation; restart Codex if it does not appear.

The built-in installer refuses an existing destination. Back up an existing installation before replacing it, and avoid duplicate copies. For an existing `pm-skill` installation, the local update helper below migrates recognized product installations into `project-manager`, backs up previous copies outside discovery paths, and refuses unrelated or linked directories. Standard installers require you to back up the old copy outside discovery paths first. Installing the skill does not install Hooks, start PM Server or register a project.

### Optional local candidate update

For a downloaded or cloned candidate that needs backup, hash verification and rollback, run from this skill directory:

```sh
python3 scripts/install_local.py --codex-root /path/to/codex-root
```

This targets `<codex-root>/skills/project-manager`, preserving a backup of an existing installation. It is a local update helper, not a prerequisite for standard Codex installation. Confirm that your target host discovers that location; for current standard discovery locations use the local placement above. Avoid installing the same skill in multiple locations.

For Claude Code, user-scope Skills load from `~/.claude/skills/<name>/`: place the complete folder at `~/.claude/skills/project-manager/` and invoke `/project-manager`. Loading and slash invocation were observed on Claude Code 2.1.310 in one local environment; session listing, continuation, callbacks and acceptance remain unverified there. For DSH, use the actual host's Skill discovery mechanism. See `references/adapters/`. Native loading and full collaboration capabilities have not been validated for all three hosts; copying files alone is not proof of host integration.

## Local CLI short flow

For a new project, start with the `project-files/1` local interface. It requires Node.js 22+ and Python 3.10+; writes currently support macOS local APFS. Keep an existing project's backend. This is OS owner-attested local coordination, with no automatic host dispatch, real AI manager binding or workbench connection.

Run discovery from the Skill directory:

```sh
node scripts/pm-cli.mjs help
node scripts/pm-cli.mjs capability inspect
node scripts/pm-cli.mjs schema
```

A name in help is not proof that it is executable. Use entries marked `local-command` / `local-query` for this flow. `host-command` requires a separately established host binding; `unavailable` is not implemented.

| Common action | Actual entry |
| --- | --- |
| Initialize an empty project and create work | `project init` → `work create` |
| Adjust scope or dependencies | `work amend` / `work dependencies` |
| Read current source | `snapshot`; explicit projection=summary; private-local only for local details |
| Validate input or inspect the contract | `input validate` / `plan`; neither executes nor grants permission. A rejected `input validate` names the failing schema field in `field`, without echoing supplied keys or values |
| Publish a local worker handoff | `worker dispatch register`, then `pm-worker finish --config <private-config>` |
| Manager pull and disposition | `worker reconcile` → `worker handoff inspect` → `worker handoff consume` → `worker handoff dispose` |

Except discovery and pm-worker, these commands read a JSON request from stdin, for example `node scripts/pm-cli.mjs work create < request.json`. Writes carry protocol, repository/project ID, local-owner policy, a unique idempotency key, current expected_revision and input. The first revision comes from capability.empty_project_revision; subsequent revisions come from the last successful result or a fresh snapshot. Queries use query rather than command and always carry `projection` (`summary` or `private-local`); omitting it is rejected as `INVALID_INPUT`. For example:

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

Use generated schema for exact fields and the [request/trust contract](cli-contract.md). `scope.criteria` entries are Refs, not prose: an ASCII identifier matching `^[A-Za-z0-9][A-Za-z0-9._:-]*$` up to 128 characters. Put human-readable acceptance text in `scope.goal`. Never execute a placeholder revision or turn a conflict into an overwrite; retries of one intent keep its exact request/key.

Run a complete fictional flow:

```sh
node examples/local-worker-walkthrough.mjs --run --private-local
```

The example creates only its own private temporary project, HOME, state and spool. It calls the actual CLI to create → validate/plan → amend → query → publish → manager consume and record an evidenced, finite checkpoint. Expected output has created/planned/handoff_published/manager_consumed/checkpoint_recorded=true, responsibility_open=true, runtime=unknown and business_accepted=false. The optional --private-local flag prints its private evidence directory, where transcript retains each JSON input/output. Omit the flag for output without paths. Do not share private directories or instance data. The example retains its evidence and changes no existing project or installation.

A checkpoint is not business acceptance; consumption does not discharge responsibility. The model judges exceptions, continuation and quality, then records actual decisions through controlled business commands. This flow starts no AI, notifications, continuous scanner or automatic wake. Strong host handover, cross-project handoff/inbox and automatic legacy disposition remain unavailable. See the [CLI contract](cli-contract.md) for separate host/acceptance requirements.

## Existing 18-column projects and manual coverage

Keep the installed management scripts for existing projects. These commands apply only when explicitly choosing the legacy 18-column CSV/HTML backend; never write a native project with them:

```sh
node scripts/init-project.mjs --repo /project --prefix DEMO --name 'Example project'
python3 scripts/validate_tasks.py /project
node scripts/collect-project-state.mjs --repo /project --init
```

A read-only query does not initialize. Without installed, configured and registered worker coordination, coverage is manual: retain an authorized local report for manager pull, with no automatic outbox or wake guarantee. Explicit legacy-compat uses a private sidecar for coordination and verification; the authorized manager still writes the central files. It does not migrate data, create business tasks or infer real session identities.

## Use with PM Server

The existing workbench registration below applies to the legacy backend. The native short flow does not automatically connect or migrate to it.

PM Skill manages planning, dispatch, evidence review and acceptance. [PM Server](https://github.com/gordonzhy/pm-server) provides the shared task workbench and background execution follow-up. Follow its setup guide to install and start the service, then check status and register the project:

```sh
pm-server status --json
pm-server project request --repo /project
```

Valid projects register automatically. Remove an unwanted project in workbench settings to blacklist it and prevent automatic rejoining; restore or unblock it explicitly when needed. The workbench reads each project's task source, dependencies and evidence without taking over task state.

For the execution safety net, connect the target host's runtime observation and explicitly configure a notification backend as described in [PM Server's usage guide](https://github.com/gordonzhy/pm-server/blob/main/docs/usage.md). Background checks run without an open browser page. Inactive execution can trigger a reminder to the registered manager to check missed callbacks or handoffs; missing or stale observations produce warnings, not an inference that execution failed. The manager checks actual results, coordinates continuation or correction, and decides acceptance. Monitoring does not automatically retry tasks or accept delivery. A failed or timed-out monitoring worker can be restarted within limits; the top-level service must still be running. Validate actual observation and reminder delivery in your host before relying on them. See [monitoring rules](../references/acceptance-watch.md).

Basic task management continues when the application is absent. Read-only queries do not install or start services, or take over project routing. A disabled service stays disabled.

The Skill calls the application's public CLI. Set `PM_SERVER_BIN` to use an explicit executable path. Neither project depends on an adjacent source directory; the public contract is in `contracts/protocol.json`.

PM Server's interface supports English and Simplified Chinese, automatically following the browser language unless you choose an override. Project content and canonical task values remain unchanged. The Skill's operational references currently use Chinese, with commands and protocol identifiers preserved as written.

## Development checks

```sh
python3 scripts/verify_team_share.py
```

This command runs supported-capability and unavailable-capability rejection regressions, not full D3 acceptance. The complete 33-case/62-combination requirement has its own unchanged driver:

```sh
node --test scripts/worker-full-d3.acceptance.mjs
```

Strong-host manager handover remains unavailable: native S28 in full D3 still fails. Ordinary regression checks exact rejection without domain/external mutation; that negative test does not count as successful D3 handover.


This installs the candidate into a temporary Codex root and runs Node and Python regressions without changing real user configuration. It validates installation and tool behavior, not actual host loading or business-project acceptance.

This repository, its installation and its releases are independent of PM Server. It is distributed under the [MIT license](../LICENSE).

For the legacy backend only, explicit manager takeover also initializes missing management files automatically, with an empty ledger and no example or business task. Pass the actual current session ID to `scripts/initialize-manager.mjs --repo /project --manager-thread <actual-session-id>`. The project manager is stored in `project-manager.config.json` under `manager` and read back before success is reported; a prose maintenance note is not registration. Existing execution routes and task states are preserved. This does not dispatch work.
