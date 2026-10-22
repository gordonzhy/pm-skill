#!/usr/bin/env python3
"""Regression tests for task index generation and validation."""

from __future__ import annotations

import csv
import importlib.util
import sys
import subprocess
import tempfile
import unittest
from pathlib import Path
from urllib.parse import quote
from unittest.mock import patch


MODULE_DIR = Path(__file__).parent
sys.path.insert(0, str(MODULE_DIR))
import generate_tasks as GENERATOR  # noqa: E402

SPEC = importlib.util.spec_from_file_location(
    "validate_tasks", MODULE_DIR / "validate_tasks.py"
)
assert SPEC and SPEC.loader
VALIDATOR = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = VALIDATOR
SPEC.loader.exec_module(VALIDATOR)


class TaskToolsTests(unittest.TestCase):
    def write_detail(
        self,
        path: Path,
        task_id: str,
        title: str,
        status: str,
        dependencies: str,
        boundary: str = "Operations",
    ) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            f"# {task_id} {title}\n\n"
            f"- 状态：{status}\n"
            "- 优先级：P0\n"
            f"- 所属边界：{boundary}\n"
            "- 执行者：Automation QA\n"
            f"- 依赖：{dependencies}\n\n## 任务日志\n\n"
                "- 2026-09-09T10:00:00+08:00｜Automation QA｜创建｜建立隔离测试任务。｜依据：测试场景。\n",
            encoding="utf-8",
        )

    def write_repo(
        self,
        root: Path,
        tasks: dict[str, tuple[str, str]],
        csv_overrides: dict[str, tuple[str, str]] | None = None,
        generate: bool = True,
    ) -> None:
        task_dir = root / "work-items/details"
        task_dir.mkdir(parents=True)
        rows: list[list[str]] = []
        overrides = csv_overrides or {}
        for task_id, (status, dependencies) in tasks.items():
            (task_dir / f"{task_id}.md").write_text(
                f"# {task_id} Test\n\n"
                f"- 状态：{status}\n"
                "- 优先级：P0\n"
                "- 所属边界：Operations\n"
                "- 执行者：AI QA 工作流\n"
                f"- 依赖：{dependencies}\n\n## 任务日志\n\n"
                "- 2026-09-09T10:00:00+08:00｜Automation QA｜创建｜建立隔离测试任务。｜依据：测试场景。\n",
                encoding="utf-8",
            )
            csv_status, csv_dependencies = overrides.get(
                task_id, (status, dependencies)
            )
            rows.append(
                [
                    task_id,
                    csv_status,
                    "P0",
                    "Operations",
                    "Test",
                    csv_dependencies,
                    "AI QA 工作流",
                    "2026-09-08T10:00:00+08:00",
                    "2026-09-09T10:00:00+08:00",
                    f"work-items/details/{task_id}.md",
                    *( [
                        f"dispatch-{task_id.lower()}",
                        "11111111-1111-4111-8111-111111111111",
                        "turn-execution",
                        "22222222-2222-4222-8222-222222222222",
                        "turn-manager",
                        "", "", "",
                    ] if csv_status == "进行中" else ["", "", "", "", "", "", "", ""] ),
                ]
            )
        with (root / "TASKS.csv").open("w", encoding="utf-8", newline="") as handle:
            writer = csv.writer(handle, lineterminator="\n")
            writer.writerow(GENERATOR.CSV_HEADERS)
            writer.writerows(rows)
        if generate:
            GENERATOR.update_views(root)

    def validate_repo(
        self,
        tasks: dict[str, tuple[str, str]],
        csv_overrides: dict[str, tuple[str, str]] | None = None,
        generate: bool = True,
    ) -> tuple[list[str], list[str], list[str], list[str]]:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            self.write_repo(root, tasks, csv_overrides, generate=generate)
            return VALIDATOR.validate(root)

    def test_active_routes_accept_qualified_platform_identities(self) -> None:
        for host in ["codex", "claude-code", "dsh"]:
            with self.subTest(host=host), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                self.write_repo(root, {"TEST-001": ("进行中", "[]")}, generate=False)
                file = root / "TASKS.csv"
                with file.open() as handle:
                    reader = csv.DictReader(handle)
                    headers, rows = reader.fieldnames, list(reader)
                rows[0]["execution_thread_id"] = f"{host}:sandbox:session%3Aworker"
                rows[0]["manager_thread_id"] = "claude-code:sandbox:manager"
                with file.open("w", newline="") as handle:
                    writer = csv.DictWriter(handle, fieldnames=headers, lineterminator="\n")
                    writer.writeheader()
                    writer.writerows(rows)
                GENERATOR.update_views(root)
                errors, active, _, _ = VALIDATOR.validate(root)
                self.assertEqual(errors, [])
                self.assertEqual(active, ["TEST-001"])

    def test_valid_graph_and_execution_views(self) -> None:
        errors, active, ready, blocked = self.validate_repo(
            {
                "OPS-001": ("已完成", "[]"),
                "OPS-002": ("进行中", "[OPS-001]"),
                "OPS-003": ("待办", "[OPS-001]"),
                "OPS-004": ("受阻", "[OPS-001]"),
                "OPS-005": ("待确认", "[OPS-001]"),
                "OPS-006": ("待办", "[OPS-005]"),
            }
        )
        self.assertEqual(errors, [])
        self.assertEqual(active, ["OPS-002"])
        self.assertEqual(ready, ["OPS-003"])
        self.assertEqual(blocked, ["OPS-004"])

    def test_rejects_natural_language_dependency(self) -> None:
        errors, _, _, _ = self.validate_repo(
            {"OPS-001": ("待办", "Prerequisite completed")}, generate=False
        )
        self.assertTrue(any("must use []" in error for error in errors))

    def test_rejects_unknown_and_duplicate_dependencies(self) -> None:
        errors, _, _, _ = self.validate_repo(
            {"OPS-001": ("待办", "[OPS-099]")}
        )
        self.assertIn("unknown dependency: OPS-001 -> OPS-099", errors)
        errors, _, _, _ = self.validate_repo(
            {
                "OPS-001": ("已完成", "[]"),
                "OPS-002": ("待办", "[OPS-001, OPS-001]"),
            },
            generate=False,
        )
        self.assertTrue(any("contains duplicate task IDs" in error for error in errors))

    def test_rejects_self_dependency_and_cycle(self) -> None:
        errors, _, _, _ = self.validate_repo(
            {
                "OPS-001": ("待办", "[OPS-001]"),
                "OPS-002": ("待办", "[OPS-003]"),
                "OPS-003": ("待办", "[OPS-002]"),
            }
        )
        self.assertIn("self-dependency: OPS-001", errors)
        self.assertTrue(any(error.startswith("dependency cycle:") for error in errors))

    def test_rejects_active_task_with_incomplete_dependency(self) -> None:
        errors, _, _, _ = self.validate_repo(
            {
                "OPS-001": ("待办", "[]"),
                "OPS-002": ("进行中", "[OPS-001]"),
            }
        )
        self.assertTrue(any("has incomplete dependencies" in error for error in errors))

    def test_rejects_csv_detail_mismatch(self) -> None:
        errors, _, _, _ = self.validate_repo(
            {"OPS-001": ("待办", "[]")},
            {"OPS-001": ("受阻", "[]")},
        )
        self.assertTrue(any("metadata mismatch" in error for error in errors))

    def test_rejects_invalid_or_reversed_timestamps(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            self.write_repo(root, {"OPS-001": ("待办", "[]")}, generate=False)
            csv_path = root / "TASKS.csv"
            page = csv_path.read_text(encoding="utf-8")
            csv_path.write_text(
                page.replace(
                    "2026-09-08T10:00:00+08:00,2026-09-09T10:00:00+08:00",
                    "2026-09-10T10:00:00+08:00,not-a-time",
                ),
                encoding="utf-8",
            )
            errors, _, _, _ = VALIDATOR.validate(root)
            self.assertTrue(any("invalid modified_at" in error for error in errors))

            csv_path.write_text(
                page.replace(
                    "2026-09-08T10:00:00+08:00,2026-09-09T10:00:00+08:00",
                    "2026-09-10T10:00:00+08:00,2026-09-09T10:00:00+08:00",
                ),
                encoding="utf-8",
            )
            errors, _, _, _ = VALIDATOR.validate(root)
            self.assertTrue(any("created_at must not be later" in error for error in errors))

    def test_rejects_unindexed_detail_and_legacy_markdown_index(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            self.write_repo(root, {"OPS-001": ("待办", "[]")})
            (root / "work-items/details/OPS-002.md").write_text(
                "# OPS-002 Test\n\n- 状态：待办\n- 优先级：P0\n"
                "- 所属边界：Operations\n- 执行者：AI QA 工作流\n- 依赖：[]\n",
                encoding="utf-8",
            )
            (root / ("TASKS" + ".md")).write_text("legacy\n", encoding="utf-8")
            errors, _, _, _ = VALIDATOR.validate(root)
            self.assertIn("TASKS.csv has no row for task ID: OPS-002", errors)
            self.assertTrue(any("legacy Markdown task index" in error for error in errors))

    def test_discovery_excludes_nested_project_roots(self) -> None:
        for marker in ("TASKS.csv", "project-manager.config.json", ".git"):
            with self.subTest(marker=marker), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                self.write_repo(root, {})
                nested = root / "components/independent"
                self.write_detail(nested / "work-items/OTHER-001.md", "OTHER-001", "Independent", "待办", "[]")
                (nested / marker).write_text("", encoding="utf-8")
                self.assertEqual(VALIDATOR.validate(root)[0], [])
                self.write_detail(root / "work-items/local-orphan.md", "OPS-099", "Local orphan", "待办", "[]")
                self.assertIn("TASKS.csv has no row for task ID: OPS-099", VALIDATOR.validate(root)[0])

    def test_git_ignored_discovery_preserves_explicit_and_tracked_details(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            subprocess.run(["git", "init", "-q", str(root)], check=True)
            self.write_repo(root, {"OPS-001": ("待办", "[]")})
            (root / ".gitignore").write_text("archive/\nwork-items/\n", encoding="utf-8")
            self.write_detail(root / "archive/old.md", "OLD-001", "Historical fixture", "待办", "[]")
            self.assertEqual(VALIDATOR.validate(root)[0], [])
            linked = root / "work-items/details/OPS-001.md"
            linked.write_text(linked.read_text().replace("- 优先级：P0", "- 优先级：invalid"), encoding="utf-8")
            self.assertTrue(any("priority" in issue or "metadata mismatch" in issue for issue in VALIDATOR.validate(root)[0]))
            linked.unlink()
            self.assertIn("TASKS.csv linked task file does not exist: work-items/details/OPS-001.md", VALIDATOR.validate(root)[0])
            self.write_detail(root / "archive/tracked.md", "OLD-002", "Tracked orphan", "待办", "[]")
            subprocess.run(["git", "-C", str(root), "add", "-f", "archive/tracked.md"], check=True)
            self.assertIn("TASKS.csv has no row for task ID: OLD-002", VALIDATOR.validate(root)[0])

    def test_git_unavailable_or_failed_keeps_filesystem_validation(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.write_repo(root, {})
            self.write_detail(root / "records/orphan.md", "OPS-099", "Local orphan", "待办", "[]")
            for outcome in (FileNotFoundError(), subprocess.CompletedProcess([], 128, b"", b"unavailable")):
                options = {"side_effect": outcome} if isinstance(outcome, Exception) else {"return_value": outcome}
                with self.subTest(outcome=type(outcome).__name__), patch.object(VALIDATOR.subprocess, "run", **options):
                    self.assertEqual(VALIDATOR.task_files(root, []), [(root / "records/orphan.md").resolve()])

    def test_explicit_detail_inside_nested_root_is_still_validated(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.write_repo(root, {"OPS-001": ("待办", "[]")})
            (root / "work-items/TASKS.csv").write_text("", encoding="utf-8")
            self.assertEqual(VALIDATOR.validate(root)[0], [])
            linked = root / "work-items/details/OPS-001.md"
            linked.write_text(linked.read_text().replace("## 任务日志", "## Other"), encoding="utf-8")
            self.assertTrue(any("missing 任务日志" in issue for issue in VALIDATOR.validate(root)[0]))

    def test_detects_missing_and_stale_dashboard(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            self.write_repo(root, {"OPS-001": ("待办", "[]")}, generate=False)
            errors, _, _, _ = VALIDATOR.validate(root)
            self.assertIn("generated view is missing: TASKS.html", errors)
            GENERATOR.update_views(root)
            (root / "TASKS.html").write_text("stale\n", encoding="utf-8")
            errors, _, _, _ = VALIDATOR.validate(root)
            self.assertIn("generated view is stale: TASKS.html", errors)

    def test_csv_changes_do_not_rebuild_fixed_dashboard_frontend(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            self.write_repo(root, {"OPS-001": ("待办", "[]")})
            html_before = (root / "TASKS.html").read_bytes()
            csv_path = root / "TASKS.csv"
            csv_path.write_text(
                csv_path.read_text(encoding="utf-8").replace(
                    "2026-09-09T10:00:00+08:00",
                    "2026-09-09T10:00:01+08:00",
                ),
                encoding="utf-8",
            )
            self.assertEqual(GENERATOR.update_views(root, check=True), [])
            self.assertEqual((root / "TASKS.html").read_bytes(), html_before)

    def test_dashboard_is_deterministic_and_contains_combined_filters(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            self.write_repo(root, {"OPS-001": ("待办", "[]")})
            first = (root / "TASKS.html").read_bytes()
            self.assertEqual(GENERATOR.update_views(root), [])
            self.assertEqual((root / "TASKS.html").read_bytes(), first)
            page = first.decode("utf-8")
            logo = GENERATOR.LOGO_PATH.read_text(encoding="utf-8").strip()
            self.assertIn(logo, page)
            self.assertIn(f'href="data:image/svg+xml,{quote(logo, safe="")}"', page)
            for control in (
                "keyword", "status", "boundary", "priority", "execution",
                "execution-runtime", "manager-runtime", "recovery-state",
                "notification-permission", "enable-notifications", "dependency-graph",
                "dependency-graph-toggle",
                "graph-zoom-out", "graph-zoom-reset",
            ):
                self.assertIn(f'id="{control}"', page)
            for field in GENERATOR.CSV_HEADERS[:10]:
                key = "task_id" if field == "id" else field
                self.assertIn(f'data-sort="{key}"', page)
            for interaction_hook in (
                '.card[data-execution]',
                'document.querySelectorAll("[data-sort]")',
                "function relativeTime",
                "function highlightDependency",
                "function renderDependencyGraph",
                "function connectUpdates",
                "function updateConfirmNotifications",
                "function tasksFromCsv",
                "function runtimeBadge",
            ):
                self.assertIn(interaction_hook, page)
            for runtime_class in (
                "runtime-running", "runtime-waiting", "runtime-interrupted",
                "runtime-unknown", "runtime-stale", "recovery-pending", "recovery-sent",
            ):
                self.assertIn(runtime_class, page)
            self.assertIn('new URL("session-runtime.csv",location.href)', page)
            self.assertIn("function applyRuntimeObservation()", page)
            self.assertIn("return {state,at:session.status_at||observedAt};", page)
            for removed_field in ("execution_state", "execution_state_at", "manager_state", "manager_state_at"):
                self.assertNotIn(removed_field, GENERATOR.CSV_HEADERS)

    def test_dashboard_push_updates_notifications_and_filtered_dependency_graph(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            self.write_repo(
                root,
                {
                    "OPS-001": ("已完成", "[]"),
                    "OPS-002": ("进行中", "[OPS-001]"),
                    "OPS-003": ("待办", "[OPS-002]"),
                    "OPS-004": ("受阻", "[OPS-002]"),
                },
            )
            page = (root / "TASKS.html").read_text(encoding="utf-8")
            self.assertNotIn('id="auto-refresh"', page)
            self.assertNotIn('id="refresh-now"', page)
            self.assertIn('id="enable-notifications"', page)
            self.assertNotIn('id="test-notifications"', page)
            self.assertIn('setInterval(updateRelativeTimes,1000)', page)
            self.assertIn('document.addEventListener("visibilitychange",updateRelativeTimes)', page)
            self.assertIn('new EventSource(new URL("events",location.href))', page)
            self.assertIn('eventSource.addEventListener("change"', page)
            self.assertIn('Notification.requestPermission()', page)
            self.assertIn('new Notification(', page)
            self.assertIn('fetch(sourceUrl,{cache:"no-store"})', page)
            self.assertIn('sourceUrl.searchParams.set("_",String(Date.now()))', page)
            self.assertNotIn('location.reload()', page)
            self.assertIn('id="dependency-graph-panel"', page)
            self.assertLess(page.index('class="filters"'), page.index('id="dependency-graph-panel"'))
            self.assertLess(page.index('id="dependency-graph-panel"'), page.index('class="table-wrap"'))
            self.assertNotIn('class="tabs"', page)
            self.assertNotIn('id="include-completed"', page)
            self.assertIn('function renderDependencyGraph(graphTasks,selected=', page)
            self.assertIn('renderDependencyGraph(document.getElementById', page)
            self.assertIn('id="dependency-graph-toggle"', page)
            self.assertIn('aria-expanded="true" aria-controls="dependency-graph-body"', page)
            self.assertIn('function setDependencyGraphExpanded(expanded,persist=true)', page)
            self.assertIn('dependencyGraphBody.hidden=!expanded', page)
            self.assertIn('max-height:520px', page)
            self.assertIn('.graph-node.execution-completed rect', page)
            self.assertIn('const graphZoomSteps=[0.1,0.25,0.5,0.75,1]', page)
            self.assertNotIn('id="graph-zoom-in"', page)
            self.assertIn('function applyDependencyGraphZoom()', page)
            self.assertIn('Math.round(graphBaseWidth*graphZoom)', page)
            self.assertIn('graphZoomOut.disabled=stepIndex===0', page)
            self.assertIn('function shrinkDependencyGraph()', page)
            for removed_fullscreen_hook in (
                'id="dependency-graph-fullscreen"', ':fullscreen', 'requestFullscreen',
                'exitFullscreen', 'fullscreenchange', 'webkitFullscreen',
            ):
                self.assertNotIn(removed_fullscreen_hook, page)
            self.assertIn('const dashboardStateKey=`task-dashboard:view:v5:${location.pathname}`', page)
            self.assertIn('function persistDashboardState()', page)
            self.assertIn('localStorage.setItem(dashboardStateKey,JSON.stringify(state))', page)
            self.assertIn('function restoreDashboardState()', page)
            self.assertIn('JSON.parse(localStorage.getItem(dashboardStateKey)||"null")', page)
            for persisted_state in (
                'filters:Object.fromEntries', 'sortKey,', 'sortDirection,',
                'graphExpanded:', 'graphZoom,',
            ):
                self.assertIn(persisted_state, page)
            self.assertNotIn('taskGroup,', page)
            self.assertNotIn('includeCompleted:', page)
            self.assertNotIn('statuses:statusControls.filter', page)
            self.assertLess(page.rindex('restoreDashboardState();'), page.rindex('render();'))
            self.assertIn('task.dependencies.filter(id=>positions.has(id))', page)
            self.assertIn('title.textContent=task.title', page)
            self.assertIn('row.classList.toggle("task-focus",active)', page)

    def test_dashboard_explains_all_postures_and_colors_dependency_statuses(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            self.write_repo(
                root,
                {
                    "OPS-001": ("已完成", "[]"),
                    "OPS-002": ("待办", "[OPS-001]"),
                    "OPS-003": ("待办", "[OPS-004]"),
                    "OPS-004": ("受阻", "[]"),
                    "OPS-005": ("已取消", "[]"),
                    "OPS-006": ("待确认", "[OPS-001]"),
                    "OPS-007": ("待确认", "[OPS-001]"),
                },
            )
            page = (root / "TASKS.html").read_text(encoding="utf-8")
            for posture in ("active", "ready", "waiting", "confirm", "blocked"):
                self.assertIn(f'data-execution="{posture}"', page)
            self.assertNotIn('data-execution="completed"', page)
            self.assertNotIn('data-execution="cancelled"', page)
            self.assertNotIn('data-group="current"', page)
            self.assertNotIn('data-group="closed"', page)
            self.assertIn('<select id="status"><option value="active-set">全部进行中</option><option value="">全部任务</option>', page)
            self.assertIn('const statuses=["待办","进行中","待确认","受阻","已完成","已取消"]', page)
            self.assertNotIn('name="status"', page)
            self.assertIn('status==="active-set"?!["已完成","已取消"].includes(task.status)', page)
            self.assertIn(':!status||task.status===status', page)
            self.assertIn('document.getElementById("status").value="active-set"', page)
            for task_id in ("OPS-001", "OPS-002", "OPS-003", "OPS-004", "OPS-005", "OPS-006", "OPS-007"):
                self.assertNotIn(task_id, page)
            self.assertIn('function tasksFromCsv(source)', page)
            self.assertIn('function executionFor(task,statusById)', page)
            self.assertIn('normalized.dependency_statuses=dependencies.map', page)
            self.assertIn('taskGroupHeading("其他任务",otherTasks.length)', page)
            self.assertIn('confirmTasks=filtered.filter(task=>task.execution==="confirm").sort(compareTasks)', page)
            self.assertIn('otherTasks=filtered.filter(task=>task.execution!=="confirm").sort(compareTasks)', page)
            self.assertIn("点击列名排序；待确认置顶", page)
            self.assertIn('status-${key}', page)
            self.assertNotIn('状态默认选择“全部进行中”', page)
            self.assertNotIn('同一组筛选同时控制依赖图和任务表', page)

    def test_summary_ids_stay_compact(self) -> None:
        tasks = [
            GENERATOR.Task(
                task_id=f"OPS-{index:03d}", status="已完成", priority="P0",
                boundary="Operations", title="Test", dependencies=(),
                executor="Automation QA", created_at="2026-09-08T10:00:00+08:00",
                modified_at="2026-09-09T10:00:00+08:00", detail_path=f"items/{index}.md",
                dispatch_id="", execution_thread_id="", execution_turn_id="",
                manager_thread_id="", manager_turn_id="",
                recovery_turn_id="", recovery_state="", recovery_state_at="",
            )
            for index in range(1, 9)
        ]
        self.assertEqual(
            GENERATOR.summary_ids(tasks),
            "OPS-001, OPS-002, OPS-003, OPS-004, OPS-005, OPS-006 · 另 2 项",
        )

    def test_neutral_repository_supports_custom_paths_and_dashboard_features(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "Example Project"
            root.mkdir()
            details = root / "work-items/records"
            self.write_detail(
                details / "completed-runbook.md",
                "OPS-001",
                "Establish runbook",
                "已完成",
                "[]",
            )
            self.write_detail(
                details / "ready-follow-up.md",
                "OPS-002",
                "Exercise recovery",
                "待办",
                "[OPS-001]",
            )
            rows = [
                [
                    "OPS-001", "已完成", "P0", "Operations", "Establish runbook",
                    "[]", "Automation QA", "2026-09-08T10:00:00+08:00",
                    "2026-09-09T10:00:00+08:00",
                    "work-items/records/completed-runbook.md",
                    "", "", "", "", "", "", "", "",
                ],
                [
                    "OPS-002", "待办", "P0", "Operations", "Exercise recovery",
                    "[OPS-001]", "Automation QA", "2026-09-08T11:00:00+08:00",
                    "2026-09-09T11:00:00+08:00",
                    "work-items/records/ready-follow-up.md",
                    "", "", "", "", "", "", "", "",
                ],
            ]
            with (root / "TASKS.csv").open("w", encoding="utf-8", newline="") as handle:
                writer = csv.writer(handle, lineterminator="\n")
                writer.writerow(GENERATOR.CSV_HEADERS)
                writer.writerows(rows)

            GENERATOR.update_views(root)
            errors, active, ready, blocked = VALIDATOR.validate(root)
            self.assertEqual(errors, [])
            self.assertEqual(active, [])
            self.assertEqual(ready, ["OPS-002"])
            self.assertEqual(blocked, [])

            page = (root / "TASKS.html").read_text(encoding="utf-8")
            self.assertIn("Example Project 任务看板", page)
            for source_specific_text in ("unrelated-project", "unrelated-task"):
                self.assertNotIn(source_specific_text, page)
            for control in (
                "keyword", "status", "boundary", "priority", "execution",
                "execution-runtime", "manager-runtime", "recovery-state",
                "notification-permission", "enable-notifications", "dependency-graph",
                "dependency-graph-toggle",
                "graph-zoom-out", "graph-zoom-reset",
            ):
                self.assertIn(f'id="{control}"', page)
            for field in GENERATOR.CSV_HEADERS[:10]:
                key = "task_id" if field == "id" else field
                self.assertIn(f'data-sort="{key}"', page)
            self.assertIn("relativeTime", page)
            self.assertIn("dependency-target", page)
            self.assertNotIn("work-items/records/ready-follow-up.md", page)
            self.assertIn('new URL("TASKS.csv",location.href)', page)

    def test_rejects_unsafe_duplicate_missing_and_unregistered_detail_paths(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            self.write_repo(
                root,
                {"OPS-001": ("已完成", "[]"), "OPS-002": ("待办", "[OPS-001]")}
            )
            csv_path = root / "TASKS.csv"
            original = csv_path.read_text(encoding="utf-8")

            for unsafe in (
                "/tmp/OPS-001.md",
                "C:/OPS-001.md",
                "../OPS-001.md",
                "details\\OPS-001.md",
            ):
                csv_path.write_text(
                    original.replace("work-items/details/OPS-001.md", unsafe),
                    encoding="utf-8",
                )
                with self.assertRaises(GENERATOR.TaskIndexError):
                    GENERATOR.load_tasks(csv_path)

            duplicate = original.replace(
                "work-items/details/OPS-002.md",
                "work-items/details/OPS-001.md",
            )
            csv_path.write_text(duplicate, encoding="utf-8")
            with self.assertRaises(GENERATOR.TaskIndexError) as duplicate_error:
                GENERATOR.load_tasks(csv_path)
            self.assertTrue(
                any("duplicate detail path" in issue for issue in duplicate_error.exception.errors)
            )

            csv_path.write_text(original, encoding="utf-8")
            (root / "work-items/details/OPS-002.md").unlink()
            errors, _, _, _ = VALIDATOR.validate(root)
            self.assertIn(
                "TASKS.csv linked task file does not exist: work-items/details/OPS-002.md",
                errors,
            )

            self.write_detail(
                root / "untracked-area/orphan-record.md",
                "OPS-099",
                "Orphan record",
                "待办",
                "[]",
            )
            errors, _, _, _ = VALIDATOR.validate(root)
            self.assertIn("TASKS.csv has no row for task ID: OPS-099", errors)

    def test_project_name_has_neutral_fallback(self) -> None:
        self.assertEqual(GENERATOR.project_name(Path("/")), "Repository")

    def test_task_module_uses_installed_skill_paths(self) -> None:
        skill_text = (MODULE_DIR.parent / "SKILL.md").read_text(encoding="utf-8")
        task_text = (MODULE_DIR.parent / "references/task-system.md").read_text(encoding="utf-8")
        self.assertIn("references/task-system.md", skill_text)
        self.assertIn("<project-manager-skill-dir>/scripts/generate_tasks.py <repository-root>", task_text)
        self.assertIn("<project-manager-skill-dir>/scripts/validate_tasks.py <repository-root>", task_text)

    def test_task_log_is_mandatory_and_cannot_be_placeholder(self) -> None:
        cases = ["", "## 任务日志\n", "## 任务日志\n待补充\n",
                 "## 任务日志\n- 2026-09-09T10:00:00+08:00｜经理｜TODO｜待填写\n",
                 "## 任务日志\n```markdown\n- 2026-09-09T10:00:00+08:00｜经理｜创建测试任务。\n```\n",
                 "## 任务日志\n| 时间 | 事件 |\n| --- | --- |\n"]
        for log in cases:
            with self.subTest(log=log), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                self.write_repo(root, {"OPS-001": ("待办", "[]")})
                detail = root / "work-items/details/OPS-001.md"
                detail.write_text(detail.read_text().split("## 任务日志")[0] + log, encoding="utf-8")
                errors, *_ = VALIDATOR.validate(root)
                self.assertTrue(any("任务日志" in error for error in errors), errors)

    def test_task_log_rejects_invalid_or_missing_timezone(self) -> None:
        for timestamp in ("2026-99-09T10:00:00+08:00", "2026-09-09T10:00:00", "2026-09-09"):
            with self.subTest(timestamp=timestamp), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                self.write_repo(root, {"OPS-001": ("待办", "[]")})
                detail = root / "work-items/details/OPS-001.md"
                detail.write_text(detail.read_text().split("## 任务日志")[0] + f"## 任务日志\n- {timestamp}｜经理｜创建隔离任务。\n", encoding="utf-8")
                errors, *_ = VALIDATOR.validate(root)
                self.assertTrue(any("任务日志" in error for error in errors), errors)

    def test_task_log_accepts_dated_changes_and_preserves_failure_evidence(self) -> None:
        for table in (False, True):
            with self.subTest(table=table), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                self.write_repo(root, {"OPS-001": ("待办", "[]")})
                detail = root / "work-items/details/OPS-001.md"
                log = ("| 时间 | 记录者 | 事件 | 内容与结果 | 证据 |\n| --- | --- | --- | --- | --- |\n" if table else "")
                log += "- 2026-09-09T10:01:00+08:00｜经理｜需求变更｜追加同任务颜色调整。｜用户指令。\n" if not table else "| 2026-09-09T10:01:00+08:00 | 经理 | 需求变更 | 追加同任务颜色调整。 | 用户指令。 |\n"
                log += "- 2026-09-09T10:02:00+08:00｜经理｜验证失败｜实际检查失败，保持待办。｜失败检查记录。\n"
                detail.write_text(detail.read_text() + log, encoding="utf-8")
                csv_path = root / "TASKS.csv"
                csv_path.write_text(csv_path.read_text().replace("2026-09-09T10:00:00+08:00", "2026-09-09T10:03:00+08:00"), encoding="utf-8")
                GENERATOR.update_views(root)
                errors, *_ = VALIDATOR.validate(root)
                self.assertEqual(errors, [])
                self.assertIn("验证失败", detail.read_text())

    def test_task_log_cannot_be_supplied_by_other_sections_or_quoted_examples(self) -> None:
        for log in ("## 任务日志\n\n## 其他\n- 2026-09-09T10:00:00+08:00 创建任务。\n",
                    "> ## 任务日志\n> - 2026-09-09T10:00:00+08:00 创建任务。\n",
                    "## 任务日志\n- 2026-09-09T10:00:00+08:00 创建任务。\n## 任务日志\n- 2026-09-09T10:01:00+08:00 追加范围。\n"):
            with self.subTest(log=log):
                errors = []
                VALIDATOR.validate_task_log(log, Path("test.md"), errors)
                self.assertTrue(errors)

    def test_dashboard_template_is_an_asset(self) -> None:
        self.assertTrue(GENERATOR.TEMPLATE_PATH.is_file())
        source = (MODULE_DIR / "generate_tasks.py").read_text(encoding="utf-8")
        self.assertNotIn("<!doctype html>", source)

    def test_cli_parses_structured_logs_through_symlinked_skill_path(self) -> None:
        import json
        import subprocess

        event = {
            "id": "log-1",
            "at": "2026-10-14T10:00:00+08:00",
            "actor": "经理",
            "type": "checkpoint",
            "title": "符号链接路径回归",
            "detail": "经软链路径调用时结构化日志仍被解析，而非报假的 JSONDecodeError。",
            "evidence": [{"label": "依据", "ref": "work-items/PMX-016.md"}],
        }
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            repository = root / "repo"
            self.write_repo(repository, {"OPS-001": ("待办", "[]")})
            detail = repository / "work-items/details/OPS-001.md"
            structured = "## 任务日志\n```yaml\n" + json.dumps(
                {"version": 1, "events": [event]}, ensure_ascii=False
            ) + "\n```\n"
            detail.write_text(detail.read_text(encoding="utf-8").split("## 任务日志")[0] + structured, encoding="utf-8")
            GENERATOR.update_views(repository)
            alias = root / "skill-alias"
            alias.symlink_to(MODULE_DIR, target_is_directory=True)
            result = subprocess.run(
                [sys.executable, str(alias / "validate_tasks.py"), str(repository)],
                capture_output=True,
                text=True,
                timeout=60,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("OK:", result.stdout)
            self.assertNotIn("JSONDecodeError", result.stdout + result.stderr)


class StructuredLogTests(unittest.TestCase):
    def test_structured_yaml_log_validation(self):
        import json
        event = {"id": "log-1", "at": "2026-10-14T10:00:00+08:00", "actor": "经理", "type": "verification", "title": "失败后复验", "detail": "保留首次失败", "evidence": [{"label": "依据", "ref": "用户要求"}]}
        def validate(events):
            errors = []
            VALIDATOR.validate_task_log("## 任务日志\n```yaml\n" + json.dumps({"version": 1, "events": events}) + "\n```", Path("task.md"), errors)
            return errors
        self.assertEqual(validate([event]), [])
        self.assertTrue(validate([{**event, "at": "2026-02-30T10:00:00Z"}]))
        self.assertTrue(validate([{**event, "evidence": []}]))
        self.assertTrue(validate([event, event]))
        self.assertTrue(validate([]))
        broken = "## 任务日志\n- 2026-10-14T10:00:00Z｜经理｜创建｜真实依据\n```YAML\nversion: broken"
        errors = []
        VALIDATOR.validate_task_log(broken, Path("task.md"), errors)
        self.assertTrue(errors)
        good = "## 任务日志\n```yaml\n" + json.dumps({"version": 1, "events": [event]}) + "\n```\n```yaml\nversion: broken"
        errors = []
        VALIDATOR.validate_task_log(good, Path("task.md"), errors)
        self.assertTrue(errors)


if __name__ == "__main__":
    unittest.main()
