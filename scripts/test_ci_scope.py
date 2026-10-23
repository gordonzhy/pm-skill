import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from ci_scope import classify, changed_paths


class ScopeTests(unittest.TestCase):
    def test_documentation(self):
        for name in ['README.md', 'SKILL.md', 'references/delivery.md', 'docs/getting-started.md']:
            with self.subTest(name=name):
                self.assertEqual(classify([name]), 'quick')

    def test_ordinary_code_keeps_file_store_regressions(self):
        self.assertEqual(classify(['README.md', 'scripts/doctor.mjs']), 'regular')
        self.assertEqual(classify(['scripts/test_validate_tasks.py']), 'regular')

    def test_critical_unknown_and_empty_are_full(self):
        for name in ['scripts/core/file-store.mjs', 'scripts/core/other.mjs', 'scripts/file-store.test.mjs',
                     'scripts/process-lock.test.mjs', 'scripts/process-lock.mjs', 'scripts/test-support/fixture.mjs', 'scripts/ci_scope.py',
                     'scripts/test_ci_scope.py', 'scripts/check_structure.py', 'scripts/verify_team_share.py',
                     'scripts/install_local.py', 'scripts/test_install_local.py', '.github/workflows/check.yml',
                     'contracts/protocol.json', 'runtime-manifest.json', 'release.json', 'assets/example.md',
                     'agents/openai.yaml', 'unknown', '../README.md', '/README.md']:
            with self.subTest(name=name):
                self.assertEqual(classify(['README.md', name]), 'full')
        self.assertEqual(classify([]), 'full')
        self.assertEqual(classify(None), 'full')

    def test_git_ranges_rename_deletion_and_fallback(self):
        with tempfile.TemporaryDirectory() as temporary:
            previous = Path.cwd()
            os.chdir(temporary)
            try:
                def git(*args):
                    return subprocess.check_output(['git', *args], stderr=subprocess.DEVNULL, text=True).strip()
                git('init', '-q')
                git('config', 'user.name', 'Example Contributor')
                git('config', 'user.email', 'contributor@example.invalid')
                Path('README.md').write_text('start\n')
                Path('scripts/core').mkdir(parents=True)
                Path('scripts/core/store.mjs').write_text('store\n')
                git('add', '.')
                git('commit', '-qm', 'Initial example')
                base = git('rev-parse', 'HEAD')
                self.assertIsNone(changed_paths('0'*40, 'HEAD', 'push'))
                self.assertIsNone(changed_paths('unavailable', 'HEAD', 'push'))
                self.assertEqual(classify(changed_paths(base, 'HEAD', 'push')), 'full')
                git('checkout', '-qb', 'topic')
                Path('README.md').write_text('topic\n')
                git('commit', '-qam', 'Edit documentation')
                topic = git('rev-parse', 'HEAD')
                git('checkout', '-qb', 'base-side', base)
                Path('scripts/core/store.mjs').write_text('base changed\n')
                git('commit', '-qam', 'Change base only')
                diverged = git('rev-parse', 'HEAD')
                self.assertEqual(classify(changed_paths(diverged, topic, 'pull_request')), 'quick')
                self.assertEqual(classify(changed_paths(diverged, topic, 'push')), 'full')
                git('checkout', '-q', 'topic')
                git('mv', 'scripts/core/store.mjs', 'store.md')
                git('commit', '-qm', 'Rename core file')
                names = changed_paths(topic, 'HEAD', 'push')
                self.assertIn('scripts/core/store.mjs', names)
                self.assertIn('store.md', names)
                self.assertEqual(classify(names), 'full')
                last = git('rev-parse', 'HEAD')
                git('rm', '-q', 'store.md')
                git('commit', '-qm', 'Remove documentation')
                self.assertEqual(changed_paths(last, 'HEAD', 'push'), ['store.md'])
            finally:
                os.chdir(previous)

    def test_regular_filter_only_targets_explicit_stress_names(self):
        source = (Path(__file__).parent / 'file-store.test.mjs').read_text()
        self.assertEqual(source.count("test('[stress] ") + source.count('test(`[stress] '), 7)
        self.assertIn("test('local commands atomically", source)
        verifier = (Path(__file__).parent / 'verify_team_share.py').read_text()
        self.assertIn('--test-skip-pattern=^\\\\[stress\\\\] ', verifier)
        self.assertIn('default="full"', verifier)


if __name__ == '__main__':
    unittest.main()
