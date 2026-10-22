"""监测暂停扩展保持旧CSV兼容，并拒绝不完整/损坏元数据。"""
import csv
import json
import tempfile
import unittest
from pathlib import Path
from generate_tasks import CSV_HEADERS, MONITOR_HEADERS, TaskIndexError, load_tasks


class MonitorPauseSchemaTests(unittest.TestCase):
    def load(self, suffix=(), values=()):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'task.md').write_text('# TEST-001 fixture\n', encoding='utf-8')
            row = ['TEST-001', '进行中', 'P0', '测试', '任务', '[]', '项目经理',
                   '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'task.md',
                   'dispatch-1', '11111111-1111-4111-8111-111111111111', 'turn-1',
                   '22222222-2222-4222-8222-222222222222', '', '', '', '']
            with (root / 'TASKS.csv').open('w', newline='', encoding='utf-8') as output:
                writer = csv.writer(output)
                writer.writerow(CSV_HEADERS + tuple(suffix))
                writer.writerow(row + list(values))
            return load_tasks(root / 'TASKS.csv')

    def test_old_and_empty_extended_tables_remain_valid(self):
        self.assertEqual(len(self.load()), 1)
        self.assertEqual(len(self.load(MONITOR_HEADERS, ['', '', ''])), 1)
        self.assertEqual(len(self.load(('task_type',) + MONITOR_HEADERS, ['开发', '', '', ''])), 1)

    def test_valid_pause_with_or_without_task_type(self):
        pause = ['2099-01-01T22:00:00+08:00', '等待批处理', json.dumps(dict(dispatch='dispatch-1', execution='e', csvTurn='turn-1', runtimeTurn='r', manager='m'))]
        self.assertEqual(len(self.load(MONITOR_HEADERS, pause)), 1)
        self.assertEqual(len(self.load(('task_type',) + MONITOR_HEADERS, ['开发'] + pause)), 1)

    def test_partial_invalid_time_and_corrupt_scope_rejected(self):
        for values in [['2099-01-01T22:00:00Z', '', '{}'], ['2099-01-01', '等待批处理', '{}'], ['2099-01-01T22:00:00Z', '等待批处理', 'bad'], ['2099-01-01T22:00:00Z', '等待批处理', '{"execution":"e"}']]:
            with self.subTest(values=values), self.assertRaises(TaskIndexError):
                self.load(MONITOR_HEADERS, values)

    def test_partial_extension_header_rejected(self):
        with self.assertRaises(TaskIndexError):
            self.load(MONITOR_HEADERS[:1], ['2099-01-01T22:00:00Z'])
