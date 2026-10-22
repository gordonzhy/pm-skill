"""Schema migration preserves optional columns and shares Node runtime locks."""
import csv
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

from generate_tasks import CSV_HEADERS, MONITOR_HEADERS, load_tasks
from migrate_task_types import runtime_lock_path

SCRIPT = Path(__file__).with_name('migrate_task_types.py')


@unittest.skipUnless(os.name == 'posix', 'POSIX shared lock required')
class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='pm-migrate-test-')
        self.addCleanup(self.temporary.cleanup)
        self.repo = Path(self.temporary.name)
        self.index = self.repo / 'TASKS.csv'
        self.detail = self.repo / 'task.md'
        self.detail.write_text('# TEST-001 fixture\n\n## 任务日志\n历史不变\n', encoding='utf-8')
        self.row = ['TEST-001', '进行中', 'P0', '测试', '任务', '[]', '项目经理',
                    '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'task.md',
                    'dispatch-1', '11111111-1111-4111-8111-111111111111', 'turn-1',
                    '22222222-2222-4222-8222-222222222222', '', '', '', '']
        self.pause = ['2099-01-01T00:00:00Z', '等待批处理', json.dumps(dict(
            dispatch='dispatch-1', execution='e', csvTurn='turn-1', runtimeTurn='r', manager='m'))]
        # Permanent lock inode is removed only after all isolated test owners exit.
        self.addCleanup(lambda: runtime_lock_path(self.repo).unlink(missing_ok=True))

    def write(self, suffix=(), values=()):
        with self.index.open('w', newline='', encoding='utf-8') as output:
            writer = csv.writer(output)
            writer.writerow(CSV_HEADERS + tuple(suffix))
            writer.writerow(self.row + list(values))

    def run_migration(self, *args):
        return subprocess.run([sys.executable, str(SCRIPT), str(self.repo), *args],
                              capture_output=True, text=True, timeout=10)

    def test_pause_columns_preserved_and_second_apply_is_byte_identical(self):
        self.write(MONITOR_HEADERS, self.pause)
        detail_before = self.detail.read_bytes()
        result = self.run_migration('--apply')
        self.assertEqual(result.returncode, 0, result.stderr)
        with self.index.open(encoding='utf-8') as source:
            rows = list(csv.reader(source))
        self.assertEqual(rows[0], list(CSV_HEADERS) + ['task_type'] + list(MONITOR_HEADERS))
        self.assertEqual(rows[1], self.row + [''] + self.pause)
        self.assertEqual(len(load_tasks(self.index)), 1)
        first = self.index.read_bytes()
        result = self.run_migration('--apply')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Already migrated', result.stdout)
        self.assertEqual(self.index.read_bytes(), first)
        self.assertEqual(self.detail.read_bytes(), detail_before)

    def test_existing_type_and_pause_values_are_untouched(self):
        self.write(('task_type',) + MONITOR_HEADERS, ['开发'] + self.pause)
        before = self.index.read_bytes()
        self.assertEqual(self.run_migration('--apply').returncode, 0)
        self.assertEqual(self.index.read_bytes(), before)

    def test_unknown_extension_rejected_without_writing(self):
        self.write(('unexpected',), ['preserve me'])
        before = self.index.read_bytes()
        result = self.run_migration('--apply')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('header', result.stderr)
        self.assertEqual(self.index.read_bytes(), before)

    def test_dry_run_keeps_original_bytes(self):
        self.write(MONITOR_HEADERS, self.pause)
        before = self.index.read_bytes()
        result = self.run_migration()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('DRY RUN', result.stdout)
        self.assertEqual(self.index.read_bytes(), before)

    @unittest.skipUnless(shutil.which('node'), 'Node required for cross-language lock test')
    def test_node_lock_blocks_alias_repo_without_any_migration_write(self):
        self.write()
        before = self.index.read_bytes()
        module = SCRIPT.with_name('process-lock.mjs').as_uri()
        code = f"""
import {{acquireProcessLock,runtimeLockPath}} from {json.dumps(module)};
const lock=await acquireProcessLock(await runtimeLockPath(process.argv[1]));
console.log('LOCKED'); process.stdin.resume();
process.stdin.on('end',async()=>{{await lock.release();process.exit(0);}});
"""
        alias = self.repo.parent / (self.repo.name + '-alias')
        alias.symlink_to(self.repo, target_is_directory=True)
        self.addCleanup(alias.unlink)
        child = subprocess.Popen(['node', '--input-type=module', '-e', code, str(alias)],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, text=True)
        try:
            self.assertEqual(child.stdout.readline().strip(), 'LOCKED')
            result = self.run_migration('--apply', '--lock-timeout-ms', '100')
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('timed out waiting', result.stderr)
            self.assertEqual(self.index.read_bytes(), before)
            self.assertFalse(list(self.repo.glob('.task-types-*')))
            child.communicate('', timeout=5)
            result = self.run_migration('--apply')
            self.assertEqual(result.returncode, 0, result.stderr)
        finally:
            if child.poll() is None:
                child.kill()
            child.communicate(timeout=5)

    def test_legacy_live_pid_and_identityless_directory_are_not_stolen(self):
        self.write()
        before = self.index.read_bytes()
        lock = runtime_lock_path(self.repo)
        lock.write_text(json.dumps({'pid': os.getpid()}))
        result = self.run_migration('--apply', '--lock-timeout-ms', '50')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.index.read_bytes(), before)
        self.assertEqual(json.loads(lock.read_text()), {'pid': os.getpid()})
        lock.unlink()
        lock.mkdir()
        try:
            result = self.run_migration('--apply', '--lock-timeout-ms', '50')
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('legacy directory', result.stderr)
            self.assertEqual(self.index.read_bytes(), before)
            self.assertTrue(lock.is_dir())
        finally:
            lock.rmdir()


if __name__ == '__main__':
    unittest.main()
