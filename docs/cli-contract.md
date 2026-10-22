# Deterministic local CLI

`node scripts/pm-cli.mjs` provides an opt-in project-files interface, separate from the existing project scripts. It keeps each project's CSV and task documents authoritative and performs supported local changes in one command. It does not migrate existing projects, call an AI host, connect the workbench, install software, or start a service.

```sh
node scripts/pm-cli.mjs help
node scripts/pm-cli.mjs capability inspect
node scripts/pm-cli.mjs schema
node scripts/pm-cli.mjs api describe
node scripts/pm-cli.mjs input validate < request.json
node scripts/pm-cli.mjs plan < request.json
node scripts/pm-cli.mjs work create < request.json
```

Use Node.js 22+ and Python 3.10+. The current write adapter supports local APFS on macOS. Other platforms, linked worktrees and unsupported Git index layouts are rejected. This interface has protocol `project-files/1`, schema `1.3.0`; it is not the existing Server protocol. Check the generated capability document for the exact implemented commands. Unsupported commands remain unavailable.

## Initialization and identity

Only explicitly initialize a new, isolated project with `project init` or `flow take-control`. Provide its absolute repository path in `repo` and `input.root`, an opaque `project_id`, `actor_proof: "local-owner"`, and `input: {"root":"/example/atlas","identity":"local-owner","policy":"policy-1"}`. Use the empty project's source revision from capability discovery for its initial `expected_revision`. Initialization creates no example tasks. Existing legacy task data is refused.

A fresh clone of supported native planning data can use `project inspect` with `private-local` to obtain an unbound source CAS hint. This is a rejected Result, not a clean snapshot; it creates no local state. An explicit `project adopt` with that revision, the existing project ID and policy, and the same root/identity fields creates a new checkout binding and manager epoch, revokes inherited grants, and preserves business obligations and their due dates. The private snapshot reports `runtime.checkout_origin` and `execution_activation_required: true`. Planning can continue; no external execution authority is inherited. Copying private runtime directories or losing pinned safety identities is refused rather than silently adopted. Current native adoption supports only planned/cancelled work without host dispatch, candidate, report or decision records.

The adapter verifies the process's OS user against the directory owner and private local binding, pins the checkout and permanent kernel-lock inode identities, and records an **owner-attested** local manager. `local-owner` names this policy; a supplied name alone is not an identity proof. This deliberately weak local policy does not authenticate a human, AI session, external authorization, or host role. It is unsuitable as a multi-user or agent security boundary. Host effects, manager handover, automatic acceptance and execution reactivation remain unavailable. The same OS owner can bypass filesystem permissions or edit files outside this tool.

The Node writer retains the same open lock descriptor inherited by its locking helper until all writes finish; helper termination alone cannot release the writer’s lock. The permanent lock and bootstrap binding live under the current user's local state directory, outside the checkout. Do not delete them to clear contention. A changed or missing pinned identity blocks further use. No force or assume-authorized option exists.

## One local command

For example, a synthetic create request is:

```json
{
  "protocol": "project-files/1",
  "command": "work create",
  "repo": "/example/atlas",
  "project_id": "ATLAS",
  "actor_proof": "local-owner",
  "idempotency_key": "create-example-1",
  "expected_revision": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  "input": {
    "work": "ATLAS-01",
    "scope": {"goal":"Build example","allowed_writes":["src/example.mjs"],"exclusions":[],"criteria":["criterion-1"]},
    "label": "Example",
    "deps": [],
    "impact": []
  }
}
```

Replace the placeholder revision with the current snapshot revision. Reuse the identical request and key after an interrupted operation; changing its input under the same key is rejected. The CLI reads the original semantic receipt from versioned audit data before applying a new CAS. Deleting an acceleration cache cannot repeat the operation. Pending and completed results keep the same `operation_receipt`, which remains usable by `operation inspect` after recovery. Historical results include an `effective-control` step with current local control and protection high-water mark. If a structured resolution supersedes an unpublished original intention, its retry returns `NO_CHANGE` with a `superseded-by-resolution` association, never a new claim that the old intention published. Private operation views keep the original `recorded_result` separately from the effective result and versioned resolution links.

Implemented local changes include task creation, planning amendments/dependencies, audit records, owner-attested grant records and start commitments. A commitment creates its linked obligation and audit in the same transaction; it does not start a host. Amendments to active/accepted/closed work and committed scopes require capabilities that are not implemented yet and are rejected. Pause, cancel and grant revocation first persist a deny-only protection record; an interrupted ordinary transaction is then completed and joined to a protection successor before publication. Every accepted deny is reapplied at publication, including after older Git text returns. A checksummed append ledger on a separately pinned permanent safety inode retains these denies when local protection copies disappear. A pending result reports that the protection is durable while the business update is still blocked. It never claims that a remote execution stopped.

CSV owns the current index scalars, including phase/control/title/dependencies. `work-items/<id>.yaml` owns scope, grants references, audits and responsibility objects; `.pm/project.yaml` owns project policy and grants. The `.yaml` files use the strict JSON subset of YAML 1.2. General YAML syntax is currently rejected. Input JSON is limited to 1 MiB and 64 nesting levels; unknown fields, duplicate keys and unsafe paths are rejected. The CLI generates all associated files; there is no arbitrary patch or shell interface.

## Publication, reads and recovery

A writer holds the stable OS project lock, reads raw bytes and the complete discovered managed set, checks CAS, prepares before/after images and an immutable journal, validates the whole candidate, then persists `DECIDED`. Only after that decision may it replace source files. File and directory flush failures are not ignored; the macOS adapter requests `F_FULLFSYNC` for regular files. This is a process-interruption mechanism with an explicit platform boundary, not a promise of safety under arbitrary device power loss.

A single clean Publication, referring to a verified immutable snapshot, is the supported reader's visibility point. Raw root files can be mixed during replacement. Read through `snapshot`, `project snapshot`, `project inspect` or `project validate` instead of fetching active CSV and details separately. Each query uses one snapshot token. It never initializes state, recovers a journal, or writes a cache. An interrupted write yields a verifiable old snapshot marked stale, or an explicit refusal when none is reliable. Protection overlay and its high-water mark are separate from the base snapshot. A query result is never an execution permit.

Queries use `query`, `repo`, `projection`, `snapshot_token` (null or the token to retain), and `input`, with the same protocol. Explicit `projection: "summary"` contains opaque aliases rather than task labels or routes. `private-local` reveals the model only to the local OS owner under the binding policy above. Errors emit stable codes and opaque case references, not input values, paths or raw exceptions.

Each authorized write automatically reconciles a known interrupted transaction before applying the new intention. `project reconcile` also does this explicitly. Undecided, unchanged preparation is abandoned; decided before/after mixtures continue forward. Recovery never calls a host or replays an unknown external effect. Third-party bytes, damaged images, missing identities and unprovable Git changes remain blocked with their evidence intact. Lost derived publication/snapshots can be reconstructed by an explicit write from retained publication proofs; a query never recreates them.

## Structured conflict resolution and Git

`project resolve` requires the exact case ID and digest, a typed decision and its authorization references. The current adapter handles a task's title conflict and a narrow ordinary Git merge whose managed CSV stages differ only in that title. The merge must also preserve all other business records, grants, commitments, obligations, audit and evidence after effective protection is reapplied. All other semantic conflicts remain blocked with `UNSUPPORTED_RESOLUTION_STATE` or a missing-input error. It preserves the original case and decided intention, adds resolution audit, and publishes a new recovery unit. An interrupted recovery unit is itself resumable; it does not repeatedly enter the old ordinary-write rejection. If another supported title edit occurs after that decision, a new exact-case resolution can absorb the earlier recovery and all of its original units. The adapter verifies the complete graph and publishes only the final unit; original receipts retain transitive resolution links. A repeated Git title resolution requires the earlier resolved index to be complete. A protection successor retains its ancestor Git adaptation, so the final title and protection fields are staged together before publication; unsupported or unprovable index/lock states stay blocked.

Git index rewriting supports SHA-1, full index versions 2/3, and the cache-tree extension. It preserves unrelated entries, replaces only the resolved managed path with stage 0, and leaves HEAD and merge control in place. It does not create a merge commit. Split/sparse indexes, unknown extensions, rebase/cherry-pick recovery and linked worktrees are unavailable. The adapter rejects a foreign index lock even when its bytes match its own intended index.

Before acquiring `index.lock`, the adapter flushes an immutable same-filesystem seed and records its identity in the recovery journal. Exclusive hard-link acquisition gives an atomic ownership proof. Recovery may release/reuse only the exact seed inode while holding the original project lock; it never uses lock age or PID absence as ownership proof. See Git's [index format](https://git-scm.com/docs/index-format) and [lockfile mechanism](https://git-scm.com/docs/api-lockfile).

External editors and Git do not honor the project lock. Their changes are detected at subsequent read/write barriers; the CLI cannot prevent arbitrary same-owner activity between checks. A Git anchor change with identical business bytes can be refreshed automatically. A business rollback cannot silently become an accepted current state or reinstate execution permission.

## Results and evidence limits

Write Results separate local commit, pending recovery and external effects. Exit priority is unknown (11), unpublished recovery (12), blocking errors (20–26; internal failure 70), pending effect (10), then success (0). A nonzero exit does not mean that no earlier part committed. An exit-0 local transaction does not establish real host execution, professional acceptance, or a stopped remote process.

`registry.mjs` is the single source of command schemas, availability, roles, read/write sets, invariants and effect categories. The file adapter reuses its definitions and domain validator. Pure readset/self-transition comparisons still grant no execution permission. The default stdin CLI does not establish host identity or perform host effects. The experimental in-process host profile below shares this engine; workbench integration remains unavailable.

Local verification:

```sh
node --test scripts/pm-cli.test.mjs scripts/file-store.test.mjs
```

The tests distinguish actual process kills and permission errors from injected IO faults. They do not perform physical power-loss tests, real host execution, production installation or migration. Preserve `.pm-local/` recovery evidence and external lock identities; these are private runtime data, not shareable project documentation or disposable caches.

## Read-only obligation evaluation

`monitor evaluate` is a local query. Supply the current snapshot ID and project policy ID in `input: {"snapshot":"snapshot-reference","policy":"policy-1"}`. It uses the same consistent reader as `snapshot`, rejects stale or mismatched snapshots, and refuses caller-supplied observations. It scans all persisted project and task obligations, including work outside the executing phase. The `private-local` projection includes active/waiting/terminal counts and overdue roots; summary returns opaque attention references only.

Each root uses project identity, obligation identity, obligation revision and violation kind. Technical generations, unrelated audit and statements of consumption do not change its identity or due date. Evaluation does not send, consume, respond, satisfy, recover or start a background worker. Clock assurance remains owner-attested; no automatic effect is authorized by an overdue result.

## Experimental in-process host profile

The host profile is an internal integration API, disabled in the default stdin CLI. It requires an owner-selected installed executable, explicit private HOME/profile, authenticated dedicated stdio connection and owner-established route/actor/role/epoch bindings. Neither JSON requests nor model arguments can mint those bindings. A dynamic tool envelope can mint a one-use, exact-request identity; program roles use a separate owner-established in-process binding. Closing a connection invalidates its live authority and does not prove remote work stopped.

`HostStore` uses the same file transaction, protection and recovery engine. It supports native initialization, lane selection/prepare/bind/start, validation, durable effect claims and reconciliation, delivery/review/manager decision/closure, and bounded obligation notifications. A pinned external execution inventory records permission before a call and its outcome afterward. Missing or corrupt inventory blocks execution; an uncertain call becomes unknown and is reconciled by its original identity without replay. `effect refresh-fence` preserves an unissued claim only when its durable validation readset is unchanged; relevant changes or a previously issued permit reject that refresh. Pause/revocation suppress unissued calls and retain stop obligations for possible running work.

The fixed adapter accepts only registered host operations, not arbitrary shell commands. Accepted transport results do not establish running, delivery, consumption, response or closure. Host creation/start/stop receipts retain the host timestamp; missing occurrence time stays accepted or unknown, and receipt collection never refreshes activity. Candidate file bytes are checked against the manifest before submission, decision and closure. A monotonic-uptime/wall-clock fence rejects clock discontinuity; it does not establish externally authenticated time. Ordinary list visibility and recovery are separate proofs and default to unknown. A lane requiring either proof cannot bind while it is unknown.

`HostMonitor` is an explicitly constructed supervisor with a separate read-only evaluator process. It rebuilds roots from source, records one manager notification and at most one separately bound owner escalation per root/manager epoch, with fixed delivery/consumption/response windows, and keeps transport, consume, substantive response and root satisfaction distinct. Its technical readiness does not mean a project needs no response. An owner must explicitly bind its own channel through `attention channel-bind`; missing owner routing is reported as unavailable. Owner consumption or channel disposition does not discharge manager business duties. Exhausted windows do not recursively create alerts. It installs no global background service. Manager handover, execution reactivation after a new profile, continuation/message commands, general project-level notification routing and workbench integration are not implemented; unavailable capabilities reject instead of inferring success.

Current integration tests use a synthetic protocol peer, real filesystem transactions and real validator/evaluator subprocesses. They do not establish authenticated AI calls, ordinary UI visibility/recovery, or unattended real-host operation. Same-OS-owner bypass and physical power loss remain outside the evidence. Keep runtime inventory, routes, credentials and project data private; generic templates and default summaries must contain none of them.

## Explicit owner entry

`node scripts/pm-host.mjs help` describes the opt-in owner process. It does not install a service, discover profiles, log in, copy credentials or start a model turn automatically. `inspect` checks the selected connection and emits booleans and unknown assurance fields. It cannot establish UI visibility, recovery or a working model from a successful handshake. Starting a native stdio process may initialize logs and caches in the explicitly selected profile.

Use an owner-only JSON file (mode 0600, private parent directory) outside the managed project:

```json
{
  "version": 1,
  "executable": "/path/to/codex",
  "home": "/path/to/private-owner/home",
  "codex_home": "/path/to/private-owner/profile",
  "file_credentials": true,
  "state": "/path/to/private-owner/runtime",
  "project": {"id":"ATLAS","repo":"/path/to/example-project","manager_epoch":"epoch-1"},
  "bindings": [],
  "controller": {"operation_id":"controller-1","actor":"manager-1","role":"manager"},
  "monitor": false
}
```

Create the selected directories with mode 0700. HOME, CODEX_HOME and runtime state must be outside the managed project's write scope. Unknown fields, credential values and unsafe permissions are rejected. `CODEX_HOME` selects the state/credential location; Codex's `--profile` option selects a configuration layer and is not credential isolation. `file_credentials` applies a child-process override only, without editing global configuration.

```sh
node scripts/pm-host.mjs inspect --config /path/to/private-owner/config.json
node scripts/pm-host.mjs prepare-controller --config /path/to/private-owner/config.json
node scripts/pm-host.mjs serve --config /path/to/private-owner/config.json
```

An unauthenticated connection refuses preparation and serving. If the owner chooses a fresh dedicated profile, the owner can sign in directly using the official CLI, without giving this program a token:

```sh
env HOME=/path/to/private-owner/home CODEX_HOME=/path/to/private-owner/profile \
  /path/to/codex -c 'cli_auth_credentials_store="file"' login --device-auth
```

This is an explicit owner action, not an automatic retry. It may open an authentication flow and stores credentials in the selected private profile. The entry reads only the native authentication status, never a credential file. See official [authentication](https://learn.chatgpt.com/docs/auth) and [app-server lifecycle](https://learn.chatgpt.com/docs/app-server) documentation; account and policy availability still need actual verification.

`prepare-controller` explicitly creates a dormant manager/owner/reviewer context with the registered dynamic tool and read-only sandbox. It records a technical permit before the native call, uses the shared OS project lock/flush adapter and inventory parser, and never changes project business truth. A missing outcome is unknown and is not retried. Keep these private records; they are not disposable caches. `--private-local` reveals the prepared context ID to the local owner; default output does not reveal paths or routes.

`serve` binds only configured/previously prepared routes and explicitly resumes them. It accepts model intentions only from the native dynamic-tool envelope. An optional `--instruction /path/to/private-owner/instruction.txt --message-id message-1` submits owner-authored text to the prepared controller. The instruction must be an owner-only file outside project write scope. Its stable ID/digest is recorded before submission; changed input or an unknown earlier submission is refused. This explicit option can incur model usage. An accepted turn is not a running proof, and stopping the gateway is not proof that remote work stopped.

For bootstrap, keep `monitor:false` until the project is initialized through the actual controller tool call. Monitoring can then be explicitly enabled; it is not an OS-managed background service. Existing project activation/role checks continue to apply. Owner context preparation or instructions cannot dispatch business work outside the shared domain engine.

An explicit `socket` path may replace `executable` for a dedicated owner-selected Unix listener with a private parent directory. It never discovers or falls back to the app's formal socket. Socket connect/close does not start or stop that external server. Local synthetic socket integration is tested; native Unix-listener availability must be checked for the installed CLI. A profile-local list or CLI resume is not proof of visibility/recovery in a different application UI. The entry keeps both hard lane proofs unknown until a separate trusted host integration can establish them.

## Private local worker handoffs

The opt-in `worker ...` commands use the same registry, source revision checks, FileStore journal, publication and durable operation receipts. `project.worker_control` records dispatch contracts and manager responsibility; it is not a second task ledger. The local profile is **owner-attested**, not strong host identity. A host-origin profile still requires the existing live host binding; a local CLI cannot upgrade it. Cross-project `handoff`/`inbox` commands remain separate and unavailable.

A manager explicitly registers one dispatch, its allowed worker, exact private spool/evidence roots and stable commitment/lineage identities before execution. Each commitment has an initial check, fixed absolute deadline, at most two evidenced extensions and at most one local owner escalation. Revision, observation changes, restart and a local coordinator epoch rollover preserve those budgets. The rollover command does not implement host manager handover.

`worker handoff publish` validates the configured roots, evidence bytes and immutable sequence chain, flushes an owner-only envelope, then publishes it atomically without replacing an existing event. A durable envelope can be discovered after a crash even if its project mirror was not committed. Reusing an event with changed bytes is rejected. Published/final is a self-report, not task completion. A missing or damaged file never becomes permission to replay a business action.

`worker reconcile` pulls only the registered spool. It imports verified envelopes, retains per-envelope problems, checks open responsibilities even when runtime evidence is missing, and records finite escalation state. It never sends a message or starts/restarts a worker. The explicit owner-program `attemptWorkerNotice` adapter claims a durable permit before invoking its owner-supplied native callback. It derives the target from the contract, uses a fixed generic body, and records the outcome afterward. There is one consolidated manager attempt and at most one owner attempt per commitment lineage; rejection, unknown or a crash after the permit never authorizes replay or another destination. This adapter is not a model-callable sender or an automatically enabled transport. This deliberately conservative implementation depends on local pulls for subsequent events. No background process is enabled automatically.

`worker handoff consume` records reading the exact envelope. `worker handoff dispose` needs either a new, relevant manager business receipt or a bounded checkpoint with actual evidence files, an action, responsible manager and deadline. Checkpoints do not satisfy business review or close obligations. Business acceptance receipts must match the envelope's candidate. Unfinished worker commitments prevent host `work close`. Multiple commitments remain independent; a new envelope does not restore exhausted budgets.

`worker runtime observe` accepts explicit owner-attested local samples. Source event time and collection time are separate; rereading a cache cannot renew an expired active sample. Host-origin assurance is not available through this local input. Claims include assurance and freshness. `worker claim inspect` reads a consistent projection; `pm-worker claim` first reconciles and falls back to unknown on failure, never to an old running hint. A structured claim cannot ensure that an unconstrained assistant uses the tool before speaking.

### Local entry and legacy compatibility

`node scripts/pm-worker.mjs help` documents the opt-in entry. Configuration is an owner-only file in a private directory, with exactly these fields:

```json
{"version":1,"control_epoch":"epoch-a","mode":"legacy-compat","project_id":"ATLAS","control_repo":"/path/to/private-owner/control","state":"/path/to/private-owner/state","legacy_root":"/path/to/atlas"}
```

Every worker write except registration requires the dispatch `control_epoch`. The private configuration supplies it without refreshing it from source; an old intention stays stale even with a new CAS revision. A coordinator change requires an explicit configuration update.

`control_repo` and `state` must exist and stay outside the legacy project. Use `mode: "native"` and `legacy_root: null` for an existing local native project. Explicit `request` inputs select registry operations; a new coordination project requires a separate explicit `project init`, then `work create` and dispatch registration. There is no auto-discovery, legacy adoption, global installation or change to a real project's task files.

For a legacy 18-column project, the sidecar uses the same FileStore/reducer. `worker legacy prepare` saves an exact before/after CSV digest and a task-log digest before the authorized manager changes the central files. Reconcile requires the exact standard 18 columns, unchanged unrelated rows and task fields, matching dispatch/route/detail path, and a valid structured manager log event. The event must bind the operation, task, dispatch, envelope, candidate, scope revision and decision; status/type/result must agree. A matching byte digest or unrelated operation marker is insufficient. The CLI does not write the central CSV or task detail. A pending or conflicting change requires reconciliation; recovery never replays the manager's write. Legacy receipts remain owner-attested and do not prove professional acceptance.

`pm-worker finish --config <private-config>` accepts only a worker-publish request and returns success only after durable publication. A caller may use it before ending its own process/turn; it cannot intercept termination of an unmanaged host. A failure does not claim handoff success. `pm-worker coverage --installed-root <explicit-skill-root>` reports `legacy-manual` when the required installed entry is absent. Merely having checkout code does not enable automatic delivery, sweeping or wake-up. No authentication is needed for local coordination.

Default wrapper output omits project names, paths, routes and envelope text. Full dispatch/claim data requires `--private-local`. Keep private envelopes and receipts; they are recovery data, not disposable caches. Isolated fixture results prove only their tested file/transport layers, not an authenticated AI host, ordinary application UI, installed monitoring or perpetual progress when every participant has stopped.
