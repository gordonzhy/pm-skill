#!/usr/bin/env python3
"""Validate TASKS.csv, Markdown task details, the dependency DAG, and TASKS.html."""

from __future__ import annotations

import re
import os
import json
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from generate_tasks import Task, TaskIndexError, build_views, load_tasks


ALLOWED_STATUSES = {"待办", "进行中", "待确认", "受阻", "已完成", "已取消"}
PROJECT_CONFIG_FILENAME = "project-manager.config.json"
REQUIRED_FIELDS = ("状态", "优先级", "所属边界", "执行者", "依赖")
FORBIDDEN_SCHEDULE_FIELDS = ("目标日期", "预计工期", "计划周期", "计划窗口")
HEADING_RE = re.compile(r"^#\s+([A-Z][A-Z0-9]*-\d+)\s+(.+?)\s*$")


@dataclass(frozen=True)
class TaskRecord:
    task_id: str
    title: str
    path: Path
    status: str
    priority: str
    boundary: str
    executor: str
    dependencies: tuple[str, ...]


def markdown_candidates(root: Path) -> list[Path]:
    """Use Git's tracked/nonignored view when available, without changing the index."""
    try:
        result = subprocess.run(
            ["git", "-C", str(root), "ls-files", "--cached", "--others",
             "--exclude-standard", "-z", "--", "*.md"],
            capture_output=True, timeout=30,
        )
        if result.returncode == 0:
            return [root / os.fsdecode(name) for name in result.stdout.split(b"\0") if name]
    except (OSError, subprocess.SubprocessError):
        pass
    return list(root.rglob("*.md"))


def task_files(root: Path, tasks: list[Task]) -> list[Path]:
    """Discover this project's details; explicit CSV links override discovery filters.

    Ignored unregistered files and independent nested task/repository roots are
    outside automatic discovery. Tracked files remain candidates even if ignored.
    Non-Git projects retain filesystem discovery and nested-root boundaries.
    """
    root = root.resolve()
    registered = {(root / task.detail_path).resolve() for task in tasks}
    directories = {path.parent for path in registered}
    discovered: set[Path] = set()
    for path in [*registered, *markdown_candidates(root)]:
        resolved = path.resolve()
        try:
            relative = resolved.relative_to(root)
        except ValueError:
            continue
        if not resolved.is_file():
            continue
        if resolved in registered:
            discovered.add(resolved)
            continue
        if any(part in {".project-manager", ".git", "node_modules"} for part in relative.parts[:-1]):
            continue
        if any(
            (parent / "TASKS.csv").is_file()
            or (parent / PROJECT_CONFIG_FILENAME).is_file()
            or (parent / ".git").exists()
            for parent in resolved.parents if parent != root and root in parent.parents
        ):
            continue
        if path.name.lower() == "readme.md":
            continue
        if resolved.parent in directories:
            discovered.add(resolved)
            continue
        text = resolved.read_text(encoding="utf-8", errors="replace")
        first_line = first_content_line(text)
        fields = parse_fields(text)
        if HEADING_RE.fullmatch(first_line) and all(field in fields for field in REQUIRED_FIELDS):
            discovered.add(resolved)
    return sorted(discovered)


def validate_project_config(root: Path, errors: list[str]) -> None:
    """Validate project-manager.config.json when present via the single Node parser.

    项目级配置是 pm init 的产物，语义校验只有 project-config-v2.mjs 一份实现；
    这里只转述其结构化错误，避免 Python 侧复制一套字段规则。文件缺失是正常状态。
    """
    config_path = root / PROJECT_CONFIG_FILENAME
    if not config_path.is_file():
        return
    parser = Path(__file__).with_name("project-config-v2.mjs")
    try:
        result = subprocess.run(
            ["node", str(parser), "--repo", str(root)],
            text=True, capture_output=True, timeout=10,
        )
        payload = json.loads((result.stdout or "").strip() or "null")
    except (OSError, subprocess.SubprocessError, ValueError) as exc:
        errors.append(f"project config validation unavailable: {type(exc).__name__}")
        return
    if not isinstance(payload, dict):
        errors.append("project config validation returned no result")
        return
    for message in payload.get("errors") or []:
        errors.append(f"invalid {PROJECT_CONFIG_FILENAME}: {message}")


def parse_fields(text: str) -> dict[str, str]:
    return {
        key.strip(): value.strip()
        for key, value in re.findall(r"^- ([^：\n]+)：(.+)$", text, re.MULTILINE)
    }


def first_content_line(text: str) -> str:
    """Return the first Markdown line after optional YAML front matter."""
    lines = text.splitlines()
    if lines and lines[0] == "---":
        for index, line in enumerate(lines[1:], start=1):
            if line == "---":
                return next((item for item in lines[index + 1 :] if item.strip()), "")
    return next((line for line in lines if line.strip()), "")


_STRUCTURED_LOGS: dict[str, dict] = {}


def cache_structured_logs(texts: list[str]) -> None:
    pending = list(dict.fromkeys(text for text in texts if text not in _STRUCTURED_LOGS and re.search(r"^\s{0,3}(?:`{3,}|~{3,})(?:yaml|yml)(?:\s|$)", text, re.M | re.I)))
    if not pending:
        return
    try:
        result = subprocess.run(["node", str(Path(__file__).with_name("task-log.mjs"))], input=json.dumps(pending), text=True, capture_output=True, timeout=10, check=True)
        _STRUCTURED_LOGS.update(zip(pending, json.loads(result.stdout)))
    except (OSError, subprocess.SubprocessError, ValueError) as exc:
        for text in pending:
            _STRUCTURED_LOGS[text] = {"mode": "structured", "errors": [f"structured log parser unavailable: {type(exc).__name__}"], "events": []}


def validate_task_log(text: str, relative_path: Path, errors: list[str]) -> None:
    """Require a real dated log section; semantic completeness remains manager review."""
    cache_structured_logs([text])
    structured = _STRUCTURED_LOGS.get(text)
    if structured and structured.get("mode") == "structured":
        errors.extend(f"invalid 任务日志: {relative_path}: {message}" for message in structured["errors"])
        return
    sections: list[list[str]] = []
    active = False
    fence: str | None = None
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith(("```", "~~~")):
            marker = stripped[0]
            if fence is None:
                fence = marker
            elif marker == fence:
                fence = None
            continue
        if fence is not None or stripped.startswith(">"):
            continue
        if re.fullmatch(r"##\s+任务日志\s*#*", stripped):
            sections.append([])
            active = True
        elif re.match(r"#{1,2}\s", stripped):
            active = False
        elif active:
            sections[-1].append(stripped)
    if not sections:
        errors.append(f"missing 任务日志: {relative_path}")
        return
    if len(sections) != 1:
        errors.append(f"duplicate 任务日志 sections: {relative_path}")
    dated_entries = 0
    timestamp = re.compile(r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})")
    placeholder = re.compile(r"(?:(?:TODO|TBD|待补充|待填写|待记录|暂无|无|经理|执行者|记录者|事件|内容|结果|证据|依据)|[\s|｜:：;；`*\-.])+", re.IGNORECASE)
    for line in (item for section in sections for item in section):
        match = timestamp.search(line)
        if not match:
            continue
        try:
            value = datetime.fromisoformat(match.group().replace("Z", "+00:00"))
            if value.utcoffset() is None:
                raise ValueError("timezone required")
        except ValueError:
            errors.append(f"invalid 任务日志 timestamp: {relative_path}: {match.group()}")
            continue
        content = line[match.end():].strip(" |｜:：;-`*")
        if content and not placeholder.fullmatch(content):
            dated_entries += 1
    if not dated_entries:
        errors.append(f"任务日志 requires a non-placeholder dated entry with timezone: {relative_path}")


def parse_task(path: Path, root: Path, errors: list[str]) -> TaskRecord | None:
    text = path.read_text(encoding="utf-8")
    relative_path = path.relative_to(root)
    first_line = first_content_line(text)
    heading = HEADING_RE.fullmatch(first_line)
    if heading is None:
        errors.append(f"invalid task heading: {relative_path}")
        return None
    task_id, title = heading.groups()
    validate_task_log(text, relative_path, errors)
    fields = parse_fields(text)
    for field in REQUIRED_FIELDS:
        if field not in fields:
            errors.append(f"missing {field}: {relative_path}")
    for field in FORBIDDEN_SCHEDULE_FIELDS:
        if field in fields:
            errors.append(f"forbidden schedule field {field}: {relative_path}")
    if any(field not in fields for field in REQUIRED_FIELDS):
        return None

    status = fields["状态"]
    if status not in ALLOWED_STATUSES:
        errors.append(f"invalid status {status}: {relative_path}")

    from generate_tasks import parse_dependencies

    dependencies, dependency_error = parse_dependencies(fields["依赖"])
    if dependency_error:
        errors.append(f"{relative_path} dependency {dependency_error}")
        dependencies = ()

    return TaskRecord(
        task_id=task_id,
        title=title,
        path=path.resolve(),
        status=status,
        priority=fields["优先级"],
        boundary=fields["所属边界"],
        executor=fields["执行者"],
        dependencies=dependencies or (),
    )


def find_cycles(graph: dict[str, tuple[str, ...]]) -> list[tuple[str, ...]]:
    state: dict[str, int] = {}
    stack: list[str] = []
    cycles: set[tuple[str, ...]] = set()

    def visit(task_id: str) -> None:
        state[task_id] = 1
        stack.append(task_id)
        for dependency in graph.get(task_id, ()):
            if dependency not in graph:
                continue
            if state.get(dependency, 0) == 0:
                visit(dependency)
            elif state.get(dependency) == 1:
                start = stack.index(dependency)
                cycle = tuple(stack[start:] + [dependency])
                rotations = [cycle[i:-1] + cycle[:i] for i in range(len(cycle) - 1)]
                canonical = min(rotations)
                cycles.add(canonical + (canonical[0],))
        stack.pop()
        state[task_id] = 2

    for task_id in graph:
        if state.get(task_id, 0) == 0:
            visit(task_id)
    return sorted(cycles)


def index_metadata(task: Task) -> tuple[object, ...]:
    return (
        task.title,
        task.status,
        task.priority,
        task.boundary,
        task.dependencies,
        task.executor,
    )


def detail_metadata(record: TaskRecord) -> tuple[object, ...]:
    return (
        record.title,
        record.status,
        record.priority,
        record.boundary,
        record.dependencies,
        record.executor,
    )


def validate(
    root: Path,
) -> tuple[list[str], list[str], list[str], list[str]]:
    root = root.resolve()
    errors: list[str] = []
    legacy_indexes = sorted(
        path.name for path in root.iterdir() if path.is_file() and path.name.lower() == "tasks.md"
    )
    if legacy_indexes:
        errors.append(f"legacy Markdown task index must be removed: {', '.join(legacy_indexes)}")
    validate_project_config(root, errors)

    try:
        tasks = load_tasks(root / "TASKS.csv")
    except TaskIndexError as error:
        return errors + error.errors, [], [], []

    index = {task.task_id: task for task in tasks}
    records: dict[str, TaskRecord] = {}
    discovered_files = task_files(root, tasks)
    _STRUCTURED_LOGS.clear()
    cache_structured_logs([path.read_text(encoding="utf-8") for path in discovered_files])
    for path in discovered_files:
        record = parse_task(path, root, errors)
        if record is None:
            continue
        if record.task_id in records:
            errors.append(
                f"duplicate task ID {record.task_id}: "
                f"{records[record.task_id].path.relative_to(root)} and {path.relative_to(root)}"
            )
        records[record.task_id] = record

    for task in tasks:
        expected_path = (root / task.detail_path).resolve()
        if not expected_path.is_file():
            errors.append(f"TASKS.csv linked task file does not exist: {task.detail_path}")
        record = records.get(task.task_id)
        if record is None:
            errors.append(f"TASKS.csv row has no discovered task file: {task.task_id}")
            continue
        if record.path != expected_path:
            errors.append(
                f"TASKS.csv row {task.task_id} links {task.detail_path}, expected "
                f"{record.path.relative_to(root)}"
            )
        fields = parse_fields(expected_path.read_text(encoding="utf-8")) if expected_path.is_file() else {}
        if task.task_type and fields.get("任务类型") != task.task_type:
            errors.append(f"task type mismatch: {task.task_id}")
        if task.task_type == "测试":
            from testing import validate_task_suite
            errors.extend(validate_task_suite(root, task, fields))
        if index_metadata(task) != detail_metadata(record):
            errors.append(
                f"metadata mismatch for {task.task_id}: "
                f"detail={detail_metadata(record)}, TASKS.csv={index_metadata(task)}"
            )

    for task_id in sorted(set(records) - set(index)):
        errors.append(f"TASKS.csv has no row for task ID: {task_id}")

    graph = {task.task_id: task.dependencies for task in tasks}
    for task_id, dependencies in graph.items():
        for dependency in dependencies:
            if dependency == task_id:
                errors.append(f"self-dependency: {task_id}")
            elif dependency not in index:
                errors.append(f"unknown dependency: {task_id} -> {dependency}")
    for cycle in find_cycles(graph):
        errors.append(f"dependency cycle: {' -> '.join(cycle)}")

    for task in tasks:
        if task.status not in {"进行中", "待确认", "已完成"}:
            continue
        incomplete = [
            dependency
            for dependency in task.dependencies
            if dependency in index and index[dependency].status != "已完成"
        ]
        if incomplete:
            errors.append(
                f"{task.task_id} is {task.status} but has incomplete dependencies: "
                f"{', '.join(incomplete)}"
            )

    try:
        expected_html = build_views(root)[root / "TASKS.html"]
        dashboard = root / "TASKS.html"
        if not dashboard.is_file():
            errors.append("generated view is missing: TASKS.html")
        elif dashboard.read_text(encoding="utf-8") != expected_html:
            errors.append("generated view is stale: TASKS.html")
    except TaskIndexError:
        pass

    active = sorted(task.task_id for task in tasks if task.status == "进行中")
    ready = sorted(
        task.task_id
        for task in tasks
        if task.status == "待办"
        and all(
            dependency in index and index[dependency].status == "已完成"
            for dependency in task.dependencies
        )
    )
    blocked = sorted(task.task_id for task in tasks if task.status == "受阻")
    return errors, active, ready, blocked


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else ".")
    errors, active, ready, blocked = validate(root)
    if errors:
        for error in errors:
            print(f"ERROR: {error}")
        print(f"FAILED: {len(errors)} issue(s)")
        return 1

    try:
        task_count = len(
            task_files(root.resolve(), load_tasks(root.resolve() / "TASKS.csv"))
        )
    except TaskIndexError:
        task_count = 0
    print(
        f"OK: {task_count} task files; "
        "CSV metadata, dependency DAG, and HTML view are consistent"
    )
    print(f"ACTIVE: {', '.join(active) if active else 'none'}")
    print(f"READY: {', '.join(ready) if ready else 'none'}")
    try:
        confirm = sorted(
            task.task_id
            for task in load_tasks(root.resolve() / "TASKS.csv")
            if task.status == "待确认"
        )
    except TaskIndexError:
        confirm = []
    print(f"CONFIRM: {', '.join(confirm) if confirm else 'none'}")
    print(f"BLOCKED: {', '.join(blocked) if blocked else 'none'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
