#!/usr/bin/env python3
"""Build the deterministic live task-dashboard frontend."""

from __future__ import annotations

import argparse
import csv
from datetime import datetime
import html
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path, PurePosixPath, PureWindowsPath
from urllib.parse import quote


CSV_HEADERS = (
    "id",
    "status",
    "priority",
    "boundary",
    "title",
    "dependencies",
    "executor",
    "created_at",
    "modified_at",
    "detail_path",
    "dispatch_id",
    "execution_thread_id",
    "execution_turn_id",
    "manager_thread_id",
    "manager_turn_id",
    "recovery_turn_id",
    "recovery_state",
    "recovery_state_at",
)
TASK_TYPES = {"需求", "设计", "开发", "测试", "部署", "管理"}
EXTENDED_HEADERS = CSV_HEADERS + ("task_type",)
MONITOR_HEADERS = ("monitor_pause_until", "monitor_pause_reason", "monitor_pause_scope")
STATUS_ORDER = ("待办", "进行中", "待确认", "受阻", "已完成", "已取消")
ALLOWED_STATUSES = set(STATUS_ORDER)
RECOVERY_STATES = {"pending", "sent", "warning-sent", "warning-muted"}
TASK_ID_RE = re.compile(r"^[A-Z][A-Z0-9]*-\d+$")
PRIORITY_RE = re.compile(r"^P\d+$")
DISPATCH_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]*$")
THREAD_ID_RE = re.compile(
    # 公共契约的平台限定引用，以及历史 Codex UUID / DSH 会话标识。
    r"^(?:(?:codex|claude-code|dsh):[A-Za-z0-9%._~-]+:[A-Za-z0-9%._~-]+"
    r"|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}"
    r"|session-[A-Za-z0-9._-]+"
    r"|teammate:[A-Za-z0-9._-]+"
    r"|subagent:[A-Za-z0-9._-]+)$",
    re.IGNORECASE,
)
TIMESTAMP_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$"
)
TEMPLATE_PATH = Path(__file__).resolve().parent.parent / "assets/task-dashboard.html"
LOGO_PATH = TEMPLATE_PATH.with_name("project-manager-logo.svg")


class TaskIndexError(ValueError):
    """Raised when TASKS.csv is malformed."""

    def __init__(self, errors: list[str]) -> None:
        super().__init__("; ".join(errors))
        self.errors = errors


@dataclass(frozen=True)
class Task:
    task_id: str
    status: str
    priority: str
    boundary: str
    title: str
    dependencies: tuple[str, ...]
    executor: str
    created_at: str
    modified_at: str
    detail_path: str
    dispatch_id: str
    execution_thread_id: str
    execution_turn_id: str
    manager_thread_id: str
    manager_turn_id: str
    recovery_turn_id: str
    recovery_state: str
    recovery_state_at: str
    task_type: str = ""


def parse_dependencies(value: str) -> tuple[tuple[str, ...] | None, str | None]:
    raw = value.strip()
    if not (raw.startswith("[") and raw.endswith("]")):
        return None, "must use [] or [TASK-ID, TASK-ID]"
    inner = raw[1:-1].strip()
    if not inner:
        return (), None
    dependencies = tuple(part.strip() for part in inner.split(","))
    if any(not dependency for dependency in dependencies):
        return None, "contains an empty dependency"
    invalid = [item for item in dependencies if not TASK_ID_RE.fullmatch(item)]
    if invalid:
        return None, f"contains invalid task ID(s): {', '.join(invalid)}"
    if len(dependencies) != len(set(dependencies)):
        return None, "contains duplicate task IDs"
    return dependencies, None


def project_name(root: Path) -> str:
    """Derive a deterministic display name without adding another project source."""
    return re.sub(r"\s+", " ", root.resolve().name).strip() or "Repository"


def valid_detail_path(value: str, root: Path) -> bool:
    """Accept safe repository-relative Markdown paths chosen by TASKS.csv."""
    parts = value.split("/")
    pure_path = PurePosixPath(value)
    windows_path = PureWindowsPath(value)
    if (
        "\\" in value
        or any(part in {"", ".", ".."} for part in parts)
        or pure_path.is_absolute()
        or windows_path.drive
        or pure_path.suffix != ".md"
        or not pure_path.stem
    ):
        return False
    resolved = (root / Path(*pure_path.parts)).resolve()
    try:
        resolved.relative_to(root.resolve())
    except ValueError:
        return False
    return True


def parse_timestamp(value: str) -> datetime | None:
    if not TIMESTAMP_RE.fullmatch(value):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.utcoffset() is not None else None


def load_tasks(csv_path: Path) -> list[Task]:
    errors: list[str] = []
    tasks: list[Task] = []
    seen_ids: set[str] = set()
    seen_paths: set[str] = set()

    if not csv_path.is_file():
        raise TaskIndexError([f"missing central index: {csv_path}"])

    with csv_path.open(encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        headers = tuple(reader.fieldnames or ())
        if headers[:len(CSV_HEADERS)] != CSV_HEADERS or headers[len(CSV_HEADERS):] not in ((), ("task_type",), MONITOR_HEADERS, ("task_type",) + MONITOR_HEADERS):
            errors.append(
                "TASKS.csv header must begin with: " + ",".join(CSV_HEADERS)
                + "; optional suffix: task_type, then monitor_pause_until,monitor_pause_reason,monitor_pause_scope"
            )
            raise TaskIndexError(errors)

        for row in reader:
            line_number = reader.line_num
            if None in row:
                errors.append(f"TASKS.csv:{line_number} contains extra columns")
                continue
            values = {key: (row.get(key) or "").strip() for key in CSV_HEADERS}
            missing = [key for key in CSV_HEADERS[:10] if not values[key]]
            if missing:
                errors.append(
                    f"TASKS.csv:{line_number} missing value(s): {', '.join(missing)}"
                )
                continue

            pause = [(row.get(field) or "").strip() for field in MONITOR_HEADERS]
            if any(pause):
                if not all(pause) or parse_timestamp(pause[0]) is None:
                    errors.append(f"TASKS.csv:{line_number} monitoring pause requires valid until, reason and scope")
                try:
                    scope = json.loads(pause[2])
                    keys = {"dispatch", "execution", "csvTurn", "runtimeTurn", "manager"}
                    if not isinstance(scope, dict) or set(scope) != keys or not all(isinstance(value, str) for value in scope.values()):
                        raise ValueError("invalid scope")
                except (ValueError, TypeError):
                    errors.append(f"TASKS.csv:{line_number} invalid monitor_pause_scope")

            task_type = (row.get("task_type") or "").strip()
            if task_type and task_type not in TASK_TYPES:
                errors.append(f"TASKS.csv:{line_number} invalid task_type: {task_type}")
            task_id = values["id"]
            if not TASK_ID_RE.fullmatch(task_id):
                errors.append(f"TASKS.csv:{line_number} invalid task ID: {task_id}")
            if task_id in seen_ids:
                errors.append(f"TASKS.csv contains duplicate task ID row: {task_id}")
            seen_ids.add(task_id)

            status = values["status"]
            if status not in ALLOWED_STATUSES:
                errors.append(f"TASKS.csv:{line_number} invalid status: {status}")
            priority = values["priority"]
            if not PRIORITY_RE.fullmatch(priority):
                errors.append(f"TASKS.csv:{line_number} invalid priority: {priority}")

            if values["dispatch_id"] and not DISPATCH_ID_RE.fullmatch(values["dispatch_id"]):
                errors.append(f"TASKS.csv:{line_number} invalid dispatch_id: {values['dispatch_id']}")
            for field in ("execution_thread_id", "manager_thread_id"):
                if values[field] and not THREAD_ID_RE.fullmatch(values[field]):
                    errors.append(f"TASKS.csv:{line_number} invalid {field}: {values[field]}")
            for field in ("recovery_state_at",):
                if values[field] and parse_timestamp(values[field]) is None:
                    errors.append(
                        f"TASKS.csv:{line_number} invalid {field}; use ISO 8601 with timezone"
                    )
            if values["recovery_state"] and values["recovery_state"] not in RECOVERY_STATES:
                errors.append(
                    f"TASKS.csv:{line_number} invalid recovery_state: {values['recovery_state']}"
                )

            recovery_metadata = (
                values["recovery_turn_id"], values["recovery_state"], values["recovery_state_at"]
            )
            execution_route = (values["execution_thread_id"], values["execution_turn_id"])
            manager_route = (values["manager_thread_id"], values["manager_turn_id"])
            if any(execution_route) and not values["execution_thread_id"]:
                errors.append(
                    f"TASKS.csv:{line_number} execution turn requires an execution thread"
                )
            if any(manager_route) and not values["manager_thread_id"]:
                errors.append(
                    f"TASKS.csv:{line_number} manager turn requires a manager thread"
                )
            if any(recovery_metadata) and not all(recovery_metadata):
                errors.append(
                    f"TASKS.csv:{line_number} recovery turn, state, and timestamp must be all blank or all present"
                )
            if status == "进行中" and not (
                values["dispatch_id"]
                and values["execution_thread_id"]
                and values["manager_thread_id"]
            ):
                errors.append(
                    f"TASKS.csv:{line_number} active task requires dispatch and execution/manager session routing"
                )

            created_at = parse_timestamp(values["created_at"])
            modified_at = parse_timestamp(values["modified_at"])
            if created_at is None:
                errors.append(
                    f"TASKS.csv:{line_number} invalid created_at; use ISO 8601 with timezone"
                )
            if modified_at is None:
                errors.append(
                    f"TASKS.csv:{line_number} invalid modified_at; use ISO 8601 with timezone"
                )
            if created_at is not None and modified_at is not None and created_at > modified_at:
                errors.append(
                    f"TASKS.csv:{line_number} created_at must not be later than modified_at"
                )

            dependencies, dependency_error = parse_dependencies(values["dependencies"])
            if dependency_error:
                errors.append(
                    f"TASKS.csv:{line_number} {task_id} dependency {dependency_error}"
                )

            detail_path = values["detail_path"]
            if not valid_detail_path(detail_path, csv_path.resolve().parent):
                errors.append(
                    f"TASKS.csv:{line_number} invalid repository-relative detail path: {detail_path}"
                )
            if detail_path in seen_paths:
                errors.append(f"TASKS.csv contains duplicate detail path: {detail_path}")
            seen_paths.add(detail_path)

            tasks.append(
                Task(
                    task_id=task_id,
                    status=status,
                    priority=priority,
                    boundary=values["boundary"],
                    title=values["title"],
                    dependencies=dependencies or (),
                    executor=values["executor"],
                    created_at=values["created_at"],
                    modified_at=values["modified_at"],
                    detail_path=detail_path,
                    dispatch_id=values["dispatch_id"],
                    execution_thread_id=values["execution_thread_id"],
                    execution_turn_id=values["execution_turn_id"],
                    manager_thread_id=values["manager_thread_id"],
                    manager_turn_id=values["manager_turn_id"],
                    recovery_turn_id=values["recovery_turn_id"],
                    recovery_state=values["recovery_state"],
                    recovery_state_at=values["recovery_state_at"],
                    task_type=task_type,
                )
            )

    if errors:
        raise TaskIndexError(errors)
    return tasks


def execution_sets(
    tasks: list[Task],
) -> tuple[list[Task], list[Task], list[Task], list[Task]]:
    by_id = {task.task_id: task for task in tasks}
    active = [task for task in tasks if task.status == "进行中"]
    ready = [
        task
        for task in tasks
        if task.status == "待办"
        and all(
            dependency in by_id and by_id[dependency].status == "已完成"
            for dependency in task.dependencies
        )
    ]
    confirm = [task for task in tasks if task.status == "待确认"]
    blocked = [task for task in tasks if task.status == "受阻"]
    return active, ready, confirm, blocked


def dependency_text(task: Task) -> str:
    return "[" + ", ".join(task.dependencies) + "]"


def execution_view(task: Task, ready_ids: set[str]) -> str:
    """Return a complete, user-facing task posture derived from state and dependencies."""
    if task.status == "进行中":
        return "active"
    if task.status == "待办":
        return "ready" if task.task_id in ready_ids else "waiting"
    if task.status == "待确认":
        return "confirm"
    if task.status == "受阻":
        return "blocked"
    if task.status == "已完成":
        return "completed"
    if task.status == "已取消":
        return "cancelled"
    raise AssertionError(f"unhandled task status: {task.status}")


def summary_ids(tasks: list[Task], limit: int = 6) -> str:
    """Keep summary cards compact while retaining deterministic examples."""
    if not tasks:
        return "无"
    visible = ", ".join(task.task_id for task in tasks[:limit])
    remaining = len(tasks) - limit
    return f"{visible} · 另 {remaining} 项" if remaining > 0 else visible


def render_html(
    tasks: list[Task],
    template_path: Path = TEMPLATE_PATH,
    display_name: str = "Repository",
) -> str:
    # Loading, parsing, derived posture, filters, and counters belong to the
    # browser frontend. Keeping task rows out of this artifact makes CSV the
    # sole live data source and means task/runtime changes never rebuild HTML.
    _ = tasks

    if not template_path.is_file():
        raise TaskIndexError([f"missing dashboard template: {template_path}"])
    if not LOGO_PATH.is_file():
        raise TaskIndexError([f"missing dashboard logo: {LOGO_PATH}"])
    template = template_path.read_text(encoding="utf-8")
    logo = LOGO_PATH.read_text(encoding="utf-8").strip()
    replacements = {
        "{{DASHBOARD_TITLE}}": html.escape(f"{display_name} 任务看板"),
        "{{DASHBOARD_LOGO}}": logo,
        "{{DASHBOARD_FAVICON}}": f"data:image/svg+xml,{quote(logo, safe='')}",
        "{{TASK_JSON}}": "[]",
        "{{TASK_LOG_VENDOR}}": (TEMPLATE_PATH.parent / "vendor/js-yaml.min.js").read_text(encoding="utf-8"),
        "{{TASK_LOG_SCRIPT}}": (TEMPLATE_PATH.parent / "task-log.js").read_text(encoding="utf-8"),
        "{{TASK_LOG_CSS}}": (TEMPLATE_PATH.parent / "task-log.css").read_text(encoding="utf-8"),
        "{{STATUS_OPTIONS}}": "",
        "{{BOUNDARY_OPTIONS}}": "",
        "{{PRIORITY_OPTIONS}}": "",
        "{{ACTIVE_COUNT}}": "0",
        "{{READY_COUNT}}": "0",
        "{{CONFIRM_COUNT}}": "0",
        "{{BLOCKED_COUNT}}": "0",
        "{{ACTIVE_IDS}}": "无",
        "{{READY_IDS}}": "无",
        "{{CONFIRM_IDS}}": "无",
        "{{BLOCKED_IDS}}": "无",
        "{{WAITING_COUNT}}": "0",
        "{{WAITING_IDS}}": "无",
    }
    for placeholder, value in replacements.items():
        template = template.replace(placeholder, value)
    unresolved = sorted(set(re.findall(r"\{\{[A-Z_]+\}\}", template)))
    if unresolved:
        raise TaskIndexError(
            [f"unresolved dashboard template placeholder(s): {', '.join(unresolved)}"]
        )
    return template


def build_views(root: Path) -> dict[Path, str]:
    root = root.resolve()
    tasks = load_tasks(root / "TASKS.csv")
    return {root / "TASKS.html": render_html(tasks, display_name=project_name(root))}


def update_views(root: Path, check: bool = False) -> list[str]:
    stale: list[str] = []
    for path, content in build_views(root).items():
        existing = path.read_text(encoding="utf-8") if path.is_file() else None
        if existing != content:
            stale.append(path.name)
            if not check:
                path.write_text(content, encoding="utf-8", newline="\n")
    return stale


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", nargs="?", default=".", type=Path)
    parser.add_argument(
        "--check", action="store_true", help="fail when generated views are missing or stale"
    )
    args = parser.parse_args(argv)
    try:
        stale = update_views(args.root, check=args.check)
    except TaskIndexError as error:
        for issue in error.errors:
            print(f"ERROR: {issue}")
        return 1
    if args.check and stale:
        print(f"STALE: {', '.join(stale)}")
        return 1
    if stale:
        print(f"GENERATED: {', '.join(stale)}")
    else:
        print("OK: generated task views are current")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
