#!/usr/bin/env python3
"""Safely install or update the repository candidate Project Manager Skill."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import tempfile
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path, PurePosixPath

try:
    import fcntl
except ImportError:  # The local installer currently supports POSIX hosts only.
    fcntl = None


SKILL_NAME = "project-manager"
LEGACY_NAME = "pm-skill"
IGNORED_PATTERNS = shutil.ignore_patterns("__pycache__", "*.pyc", "*.pyo", ".DS_Store")



class InstallError(RuntimeError):
    """Raised when the candidate cannot be installed safely."""


@contextmanager
def _name_lock(skills_dir: Path, name: str):
    """Serialize installers targeting this skill; kernel releases lock on exit.

    Keep the lock inode permanently: unlinking it would allow two holders on
    different inodes. No timeout/stale-file deletion can revoke a live owner.
    """
    if fcntl is None:
        raise InstallError("safe installation requires POSIX fcntl.flock support")
    lock_path = skills_dir / f".{name}-install.lock"
    flags = os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0)
    with os.fdopen(os.open(lock_path, flags, 0o600), "a+") as handle:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise InstallError(f"another installation owns {lock_path}") from error
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


@contextmanager
def installation_lock(skills_dir: Path):
    # Acquire the legacy lock first so an older installer cannot race migration.
    with _name_lock(skills_dir, LEGACY_NAME), _name_lock(skills_dir, SKILL_NAME):
        yield


def validate_owned_install(path: Path, expected_name: str) -> None:
    if path.is_symlink() or not path.is_dir():
        raise InstallError(f"refusing linked or non-directory installation: {path}")
    if any(item.is_symlink() for item in path.rglob("*")):
        raise InstallError(f"refusing installation containing links: {path}")
    try:
        release = json.loads((path / "release.json").read_text(encoding="utf-8"))
        text = (path / "SKILL.md").read_text(encoding="utf-8")
        if (release.get("name") != expected_name or release.get("contractVersion") != 1
                or release.get("license") != "MIT" or not isinstance(release.get("version"), str)
                or not text.startswith("---\n")
                or f"\nname: {expected_name}\n" not in text.split("\n---", 1)[0]):
            raise InstallError(f"unrecognized existing skill: {path}")
        required = required_paths(path)
        if any(not item.is_file() for item in required):
            raise InstallError(f"incomplete existing product installation: {path}")
        protocol = json.loads((path / "contracts/protocol.json").read_text(encoding="utf-8"))
        if protocol.get("name") != "pm-server-pm-skill" or protocol.get("application") != "pm-server":
            raise InstallError(f"unrecognized product contract: {path}")
    except (OSError, ValueError, AttributeError) as error:
        raise InstallError(f"cannot establish existing skill ownership: {path}") from error


def rename_exact(source: Path, destination: Path) -> None:
    """Rename on the same filesystem without shutil.move directory nesting."""
    if os.path.lexists(destination):
        raise InstallError(f"rename destination already exists: {destination}")
    source.rename(destination)


def default_codex_root() -> Path:
    configured = os.environ.get("CODEX_HOME")
    return Path(configured).expanduser() if configured else Path.home() / ".codex"


def file_hashes(root: Path) -> dict[str, str]:
    return {
        path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(root.rglob("*"))
        if path.is_file()
        and "__pycache__" not in path.parts
        and path.suffix not in {".pyc", ".pyo"}
        and path.name != ".DS_Store"
    }


def unique_path(parent: Path, stem: str) -> Path:
    candidate = parent / stem
    counter = 1
    while candidate.exists():
        candidate = parent / f"{stem}-{counter}"
        counter += 1
    return candidate


def required_paths(skill_dir: Path) -> list[Path]:
    manifest = skill_dir / "runtime-manifest.json"
    try:
        data = json.loads(manifest.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise InstallError(f"cannot read required runtime-manifest.json: {error}") from error
    files = data.get("files") if isinstance(data, dict) else None
    if (not isinstance(data, dict) or data.get("schemaVersion") != 1
            or not isinstance(files, list) or not files):
        raise InstallError("invalid runtime manifest schema")
    paths = []
    seen = set()
    for name in files:
        if (not isinstance(name, str) or not name or "\\" in name or "\x00" in name
                or PurePosixPath(name).is_absolute()
                or any(part in {"", ".", ".."} for part in name.split("/"))
                or name in seen):
            raise InstallError("runtime manifest requires unique safe relative file paths")
        seen.add(name)
        candidate = skill_dir / name
        if not candidate.resolve().is_relative_to(skill_dir.resolve()):
            raise InstallError(f"runtime manifest path escapes candidate: {name}")
        paths.append(candidate)
    if not {"runtime-manifest.json", "SKILL.md", "agents/openai.yaml"}.issubset(seen):
        raise InstallError("runtime manifest is missing its identity files")
    return paths


def validate_candidate(skill_dir: Path) -> None:
    required = required_paths(skill_dir)
    missing = [path.relative_to(skill_dir).as_posix() for path in required if not path.is_file()]
    if missing:
        raise InstallError("candidate is missing required files: " + ", ".join(missing))
    text = (skill_dir / "SKILL.md").read_text(encoding="utf-8")
    if not text.startswith("---\n") or "\nname: project-manager\n" not in text.split("\n---", 1)[0]:
        raise InstallError("SKILL.md has invalid project-manager frontmatter")


def install_skill(source_skill: Path, codex_root: Path) -> tuple[Path, Path | None]:
    source_skill = source_skill.resolve()
    codex_root = codex_root.expanduser().resolve()
    validate_candidate(source_skill)

    skills_dir = codex_root / "skills"
    destination = skills_dir / SKILL_NAME
    resolved_destination = destination.resolve(strict=False)
    if (source_skill == resolved_destination
            or source_skill.is_relative_to(resolved_destination)
            or codex_root.is_relative_to(source_skill)
            or source_skill.is_relative_to((skills_dir / LEGACY_NAME).resolve(strict=False))):
        raise InstallError("run the installer from the repository candidate")

    backup_root = codex_root / "skill-backups" / SKILL_NAME
    skills_dir.mkdir(parents=True, exist_ok=True)
    with installation_lock(skills_dir):
        return _install_locked(source_skill, codex_root, destination, backup_root)


def _install_locked(source_skill: Path, codex_root: Path, destination: Path,
                   backup_root: Path) -> tuple[Path, Path | None]:
    legacy = destination.parent / LEGACY_NAME
    existing = [(path, name) for path, name in ((destination, SKILL_NAME), (legacy, LEGACY_NAME))
                if os.path.lexists(path)]
    for path, name in existing:
        validate_owned_install(path, name)
    backup_root.mkdir(parents=True, exist_ok=True)
    stage_root = Path(tempfile.mkdtemp(prefix=f".{SKILL_NAME}-stage-", dir=codex_root))
    staged_skill = stage_root / SKILL_NAME
    previous_backup: Path | None = None
    moved: list[tuple[Path, Path]] = []
    try:
        shutil.copytree(source_skill, staged_skill, ignore=IGNORED_PATTERNS)
        validate_candidate(staged_skill)
        if file_hashes(source_skill) != file_hashes(staged_skill):
            raise InstallError("staged package does not match the repository candidate")
        candidate_hashes = file_hashes(staged_skill)

        try:
            for path, name in existing:
                # Recheck immediately before moving a discovered installation.
                validate_owned_install(path, name)
                stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
                backup = unique_path(backup_root, stamp if name == SKILL_NAME else stamp + "-legacy-pm-skill")
                rename_exact(path, backup)
                moved.append((path, backup))
                previous_backup = previous_backup or backup
            rename_exact(staged_skill, destination)
            validate_candidate(destination)
            if file_hashes(destination) != candidate_hashes:
                raise InstallError("installed package does not match the staged candidate")
            if file_hashes(source_skill) != candidate_hashes:
                raise InstallError("repository candidate changed during installation")
        except Exception:
            failed = unique_path(backup_root, "failed-install")
            # Only remove our promoted candidate; untouched destinations remain.
            if destination.exists() and not staged_skill.exists():
                rename_exact(destination, failed)
            for original, backup in reversed(moved):
                rename_exact(backup, original)
            raise
        return destination, previous_backup
    finally:
        shutil.rmtree(stage_root, ignore_errors=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--codex-root", type=Path, default=default_codex_root())
    args = parser.parse_args(argv)
    source_skill = Path(__file__).resolve().parent.parent
    try:
        backups = args.codex_root.expanduser().resolve() / "skill-backups" / SKILL_NAME
        before = set(backups.iterdir()) if backups.is_dir() else set()
        destination, backup = install_skill(source_skill, args.codex_root)
    except (InstallError, OSError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    print(f"INSTALLED: {destination}")
    for backup in sorted(set(backups.iterdir()) - before):
        print(f"BACKUP: {backup}")
    print("Open a new Codex task to load the installed Skill.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
