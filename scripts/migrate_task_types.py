#!/usr/bin/env python3
"""Manager-only, opt-in append of task_type; no guessed historical classification."""
import argparse
from contextlib import contextmanager
import csv
import hashlib
import io
import json
import os
from pathlib import Path
import stat
import tempfile
import time

from generate_tasks import CSV_HEADERS, load_tasks

try:
    import fcntl
except ImportError:
    fcntl = None


def runtime_lock_path(repo):
    key = hashlib.sha256(str(repo.resolve()).encode()).hexdigest()[:16]
    return Path(tempfile.gettempdir()) / f'project-manager-task-runtime-{key}.lock'


@contextmanager
def runtime_lock(repo, timeout_ms):
    """Share the permanent flock-v1 inode with Node process-lock.mjs."""
    if fcntl is None:
        raise RuntimeError('migration requires POSIX fcntl.flock support')
    filename = runtime_lock_path(repo)
    if filename.is_dir():
        raise RuntimeError(f'legacy directory lock requires an explicit quiescent migration: {filename}')
    fd = os.open(filename, os.O_CREAT | os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise RuntimeError(f'lock must be a regular file: {filename}')
        deadline = time.monotonic() + timeout_ms / 1000
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                os.lseek(fd, 0, os.SEEK_SET)
                try:
                    previous = json.loads(os.read(fd, 4096))
                except (ValueError, UnicodeDecodeError):
                    previous = {}
                if isinstance(previous, int):
                    previous = {'pid': previous}
                if not isinstance(previous, dict):
                    previous = {}
                owner = previous.get('pid')
                if (previous.get('protocol') != 'flock-v1'
                        and isinstance(owner, int) and owner > 0):
                    try:
                        os.kill(owner, 0)
                        live = True
                    except ProcessLookupError:
                        live = False
                    except PermissionError:
                        live = True
                    if live:
                        fcntl.flock(fd, fcntl.LOCK_UN)
                        raise BlockingIOError('legacy live lock owner')
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise TimeoutError(f'timed out waiting for process lock: {filename}')
                time.sleep(0.025)
        os.ftruncate(fd, 0)
        os.lseek(fd, 0, os.SEEK_SET)
        os.write(fd, json.dumps({'protocol': 'flock-v1', 'pid': os.getpid()}).encode())
        yield
    finally:
        os.close(fd)


def migrate(repo, apply=False, timeout_ms=2000):
    repo = repo.resolve()
    with runtime_lock(repo, timeout_ms):
        index = repo / 'TASKS.csv'
        before = index.read_bytes()
        load_tasks(index)
        rows = list(csv.reader(io.StringIO(before.decode('utf-8'))))
        if 'task_type' in rows[0]:
            print('Already migrated')
            return
        position = len(CSV_HEADERS)
        rows[0].insert(position, 'task_type')
        for row in rows[1:]:
            if row:
                row.insert(position, '')
        rows = [row for row in rows if row]
        if not apply:
            print(f'DRY RUN: append task_type to {len(rows)-1} rows; existing rows remain unclassified. Use --apply in manager write window.')
            return
        fd, temporary = tempfile.mkstemp(dir=repo, prefix='.task-types-', suffix='.csv')
        try:
            with os.fdopen(fd, 'w', newline='', encoding='utf-8') as output:
                csv.writer(output).writerows(rows)
            load_tasks(Path(temporary))
            if index.read_bytes() != before:
                raise RuntimeError('Index changed outside shared lock; abort')
            os.chmod(temporary, stat.S_IMODE(index.stat().st_mode))
            os.replace(temporary, index)
        finally:
            Path(temporary).unlink(missing_ok=True)
    print('Migrated schema; manager may classify selected rows and sync 任务类型 in their details. No status/routing/timestamps changed.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('repo', type=Path)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--lock-timeout-ms', type=int, default=2000)
    args = parser.parse_args()
    if not 0 <= args.lock_timeout_ms <= 30000:
        parser.error('--lock-timeout-ms must be 0..30000')
    try:
        migrate(args.repo, args.apply, args.lock_timeout_ms)
    except (OSError, RuntimeError, ValueError) as error:
        parser.exit(1, f'ERROR: {error}\n')


if __name__ == '__main__':
    main()
