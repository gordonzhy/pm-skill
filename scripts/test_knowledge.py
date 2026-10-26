"""Behavior checks using only disposable fictional knowledge projects."""
import contextlib
import io
import json
import multiprocessing
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import knowledge as k


def entry(ident='DEMO-K-001', **changes):
    e = dict(id=ident, title='请求401先检查凭据', kind='lesson', summary='登录失败时检查过期条件；不是根因证明。',
             scope='fictional client v1', keywords=['HTTP 401', 'a+b[0]'], aliases=['认证失败', '凭据过期'],
             sources=['evidence/demo.md#sample'], status='unverified', recorded_at='2026-01-01',
             verified_at=None, basis='unverified', replaces=[], related=[])
    return dict(e, **changes)


def block(e):
    return f'<a id="knowledge-{e["id"]}"></a>\n{k.START}\n{json.dumps(e, ensure_ascii=False)}\n{k.END}\n\n正文独占标记，不进入索引。\n'


def hold_lock(config, ready, release):
    store = k.Store(config)
    with store.lock('alpha'):
        ready.set(); release.wait(10)


class KnowledgeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name).resolve()
        for name in ['alpha', 'beta']:
            (self.base / name).mkdir()
            (self.base / name / 'notes.md').write_text(block(entry()), encoding='utf-8')
        self.cfg = self.base / 'config.json'
        self.config = {'version': 1, 'index_root': 'index', 'projects': {
            name: {'root': name, 'files': ['notes.md'], 'authorization':
                   {'reference': 'fictional-grant', 'scope': 'local private knowledge'}, 'writable': True}
            for name in ['alpha', 'beta']}}
        self.save()

    def save(self):
        self.cfg.write_text(json.dumps(self.config), encoding='utf-8')

    def cli(self, *args, private=False, ok=True):
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            status = k.main(['--config', str(self.cfg)] + (['--private-output'] if private else []) + list(args))
        result = json.loads(stdout.getvalue())
        self.assertEqual(status, 0 if ok else 1, result)
        return result

    def write(self, *entries, project='alpha'):
        (self.base / project / 'notes.md').write_text('\n'.join(block(e) for e in entries), encoding='utf-8')

    def test_build_search_aliases_literals_filters_and_ranking(self):
        self.write(entry(), entry('DEMO-D-001', kind='decision', basis='user-decision', status='current',
                                  title='HTTP 401 的用户决定', summary='先检查有效期', aliases=[], keywords=['HTTP 401']))
        self.cli('build')
        for query in ['认证失败', '凭据过期', 'a+b[0]', 'http 401']:
            r = self.cli('search', query, private=True)
            self.assertTrue(r['results'])
        r = self.cli('search', 'HTTP 401', private=True)
        self.assertTrue(r['results'][0]['current_decision'])
        self.assertNotIn('正文独占标记', json.dumps(r, ensure_ascii=False))
        self.assertEqual(self.cli('search', '认证失败', 'absent', '--all', private=True)['total_matches'], 0)
        self.assertEqual(self.cli('search', '认证失败', '--scope', 'v2', private=True)['total_matches'], 0)
        self.assertEqual(self.cli('search', '认证失败', '--kind', 'decision', private=True)['total_matches'], 0)
        self.assertTrue(self.cli('search', '401', '--limit', '1', private=True)['truncated'])
        self.assertFalse(self.cli('search', '401', '--limit', '1', private=True)['complete'])
        self.assertEqual(self.cli('search', '认证失败', ok=False)['error'], 'private-output-required')

    def test_regex_errors_timeout_and_explicit_mode(self):
        self.write(entry(summary='a' * 1800 + '!'))
        self.cli('build')
        self.assertTrue(self.cli('search', r'HTTP\s*401', '--regex', private=True)['results'])
        self.assertEqual(self.cli('search', '[', '--regex', private=True, ok=False)['error'], 'invalid-regex')
        r = self.cli('search', '(a+)+$', '--regex', '--seconds', '.01', private=True, ok=False)
        self.assertEqual(r['error'], 'query-timeout')
        self.assertEqual(self.cli('search', 'x', '--seconds', '10', private=True, ok=False)['error'], 'query-budget')

    def test_stale_partial_failure_and_rebuild(self):
        self.cli('build')
        cached = (self.base / 'index/alpha.json').read_bytes()
        beta = (self.base / 'index/beta.json').read_bytes()
        self.write(entry(summary='changed'))
        r = self.cli('check', ok=False)
        self.assertIn('index-stale-or-tampered', str(r))
        self.cli('build', '--project', 'alpha')
        self.assertEqual(beta, (self.base / 'index/beta.json').read_bytes())
        cached = (self.base / 'index/alpha.json').read_bytes()
        (self.base / 'alpha/notes.md').write_text(k.START)
        r = self.cli('build', ok=False)
        self.assertEqual(r['projects'], 2)
        self.assertEqual(cached, (self.base / 'index/alpha.json').read_bytes())
        r = self.cli('search', '401', private=True, ok=False)
        self.assertEqual(r['searched_projects'], 1)
        self.assertTrue(r['results'])

    def test_revocation_and_cache_tamper_do_not_read_cache_paths(self):
        self.cli('build')
        del self.config['projects']['alpha']; self.save()
        r = self.cli('search', '401', private=True)
        self.assertEqual({h['project'] for h in r['results']}, {'beta'})
        cache = self.base / 'index/beta.json'
        data = json.loads(cache.read_text()); data['entries'][0]['file'] = '../../outside.md'
        data['entries'][0]['summary'] = 'cached-private-canary'
        cache.write_text(json.dumps(data))
        r = self.cli('search', 'canary', private=True, ok=False)
        self.assertEqual(r['results'], [])
        self.assertNotIn('cached-private-canary', str(r))

    def test_boundaries_symlink_source_index_root_and_traversal(self):
        outside = self.base / 'outside.md'; outside.write_text('private-canary')
        source = self.base / 'alpha/notes.md'; source.unlink(); source.symlink_to(outside)
        r = self.cli('build', ok=False)
        self.assertIn('symlink-denied', str(r)); self.assertNotIn('private-canary', str(r))
        self.config['projects']['alpha']['files'] = ['../outside.md']; self.save()
        self.assertEqual(self.cli('check', ok=False)['error'], 'source-path-denied')
        self.config['projects']['alpha']['files'] = ['notes.md']; self.save()
        self.config['index_root'] = 'linked-index'; self.save()
        (self.base / 'linked-index').symlink_to(self.base / 'beta', target_is_directory=True)
        self.assertEqual(self.cli('check', ok=False)['error'], 'symlink-denied')

    def test_invalid_fields_duplicate_ids_and_relations(self):
        cases = [([entry(), entry()], 'duplicate-id'),
                 ([entry(related=['MISSING'])], 'relation-target-missing'),
                 ([entry(status='superseded')], 'replacement-link-required'),
                 ([entry(verified_at='2026-01-01')], 'verification-basis-mismatch'),
                 ([entry(kind='decision')], 'decision-basis-required'),
                 ([entry(status='current')], 'unverified-current'),
                 ([entry(sources=[])], 'invalid-list')]
        for entries, code in cases:
            self.write(*entries)
            self.assertIn(code, str(self.cli('build', '--project', 'alpha', ok=False)))
        self.write(entry('A', status='superseded', replaces=['B']), entry('B', status='superseded', replaces=['A']))
        self.assertIn('replacement-cycle', str(self.cli('build', '--project', 'alpha', ok=False)))
        self.write(entry('OLD', status='superseded'), entry('NEW', replaces=['OLD']))
        self.cli('build', '--project', 'alpha')

    def test_record_then_build_and_partial_completion(self):
        target = 'new.md'
        self.config['projects']['alpha']['files'].append(target); self.save()
        e = self.base / 'entry.json'; e.write_text(json.dumps(entry('NEW')))
        r = self.cli('record', '--project', 'alpha', '--file', target, '--entry', str(e))
        self.assertTrue(r['indexed'])
        self.assertEqual(len(self.cli('search', '401', '--project', 'alpha', private=True)['results']), 2)
        self.cli('record', '--project', 'alpha', '--file', target, '--entry', str(e), ok=False)
        self.config['projects']['alpha']['files'].append('duplicate.md'); self.save()
        r = self.cli('record', '--project', 'alpha', '--file', 'duplicate.md', '--entry', str(e), ok=False)
        self.assertTrue(r['source_written']); self.assertFalse(r['indexed']); self.assertEqual(r['recovery'], 'build')
        self.assertTrue((self.base / 'alpha/duplicate.md').exists())

    def test_partition_lock_busy_and_release(self):
        ready, release = multiprocessing.Event(), multiprocessing.Event()
        proc = multiprocessing.Process(target=hold_lock, args=(str(self.cfg), ready, release))
        proc.start()
        try:
            self.assertTrue(ready.wait(5))
            self.assertIn('partition-busy', str(self.cli('build', '--project', 'alpha', ok=False)))
            self.cli('build', '--project', 'beta')
        finally:
            release.set(); proc.join(5)
        self.cli('build', '--project', 'alpha')

    def test_source_and_authorization_cas_and_atomic_failure(self):
        store = k.Store(self.cfg)
        store.build_one('alpha')
        original = (self.base / 'index/alpha.json').read_bytes()
        with patch.object(store, 'scan', side_effect=[{'old': 1}, {'new': 1}]):
            with self.assertRaisesRegex(k.Fault, 'source-changed-during-build'):
                store.build_one('alpha')
        self.assertEqual(original, (self.base / 'index/alpha.json').read_bytes())
        with patch.object(k.os, 'replace', side_effect=OSError('secret-private-path')):
            self.cli('build', '--project', 'alpha', ok=False)
        self.assertEqual(original, (self.base / 'index/alpha.json').read_bytes())
        self.config['projects'] = {}; self.save()
        with self.assertRaisesRegex(k.Fault, 'authorization-changed'):
            store.build_one('alpha')

    def test_summary_diagnostics_and_index_corruption(self):
        self.cli('build')
        (self.base / 'index/alpha.json').write_text('{')
        r = self.cli('check', ok=False)
        self.assertNotIn(str(self.base), json.dumps(r)); self.assertNotIn('alpha', json.dumps(r))
        self.assertIn('index-missing-or-corrupt', str(r))
        self.config['projects']['beta']['authorization'] = {}; self.save()
        self.assertEqual(self.cli('build', ok=False)['error'], 'authorization-reference-required')

    def test_plan_budget_and_retrospective_confirmation(self):
        plan = {'mode': 'organize', 'items': [{'project': p, 'file': 'notes.md'} for p in ['alpha', 'beta']],
                'budget': {'entries': 1, 'bytes': 65536, 'seconds': 5}, 'confirmation': None}
        path = self.base / 'plan.json'
        def run(ok=True):
            path.write_text(json.dumps(plan)); return self.cli('plan-check', '--plan', str(path), ok=ok)
        r = run(); self.assertTrue(r['limit_reached']); self.assertEqual(r['processed_entries'], 1)
        plan['budget']['entries'] = 10; plan['budget']['bytes'] = 5
        self.assertEqual(run()['read_bytes'], 5)
        plan['budget']['bytes'] = 65536; plan['mode'] = 'retrospective'
        self.assertEqual(run(False)['error'], 'user-confirmation-reference-required')
        plan['confirmation'] = {'reference': 'fictional-explicit-user-request', 'scope': 'two demo files', 'confirmed_at': '2026-01-01'}
        r = run(); self.assertTrue(r['complete']); self.assertFalse(r['authorization_proven'])
        plan['budget']['entries'] = 11
        self.assertEqual(run(False)['error'], 'plan-budget-exceeded')

    def test_private_parse_errors_are_sanitized(self):
        for options in [['search', 'x', '--status', 'FICTIONAL_PRIVATE_VALUE'],
                        ['search', 'x', '--limit', 'FICTIONAL_PRIVATE_VALUE'],
                        ['--private-FICTIONAL_PRIVATE_VALUE', 'schema']]:
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr), self.assertRaises(SystemExit) as exc:
                k.main(options)
            self.assertEqual(exc.exception.code, 2)
            self.assertNotIn('FICTIONAL_PRIVATE_VALUE', stderr.getvalue())
            self.assertEqual(json.loads(stderr.getvalue())['error'], 'invalid-cli-arguments')

    def test_plan_stops_at_entry_and_exact_byte_boundaries(self):
        self.write(entry('A'), entry('B'), entry('C'), entry('D'))
        path = self.base / 'plan.json'
        plan = {'mode': 'organize', 'items': [{'project': 'alpha', 'file': 'notes.md'}],
                'budget': {'entries': 1, 'bytes': 65536, 'seconds': 5}, 'confirmation': None}
        path.write_text(json.dumps(plan))
        r = self.cli('plan-check', '--plan', str(path), private=True)
        self.assertEqual(r['processed_entries'], 1)
        self.assertTrue(r['limit_reached'])
        raw = (self.base / 'alpha/notes.md').read_bytes()
        boundary = raw.index(k.END.encode()) + len(k.END.encode())
        self.assertEqual(r['read_bytes'], boundary)
        self.assertEqual(r['items'][0]['end_byte'], boundary)
        self.assertEqual(r['continuation']['offset'], boundary)
        plan['budget']['bytes'] = 15; path.write_text(json.dumps(plan))
        r = self.cli('plan-check', '--plan', str(path), private=True)
        self.assertEqual(r['read_bytes'], 15)
        self.assertEqual(r['processed_entries'], 0)
        self.assertEqual(r['limit_reason'], 'bytes')
        plan['budget']['entries'] = 1.5; path.write_text(json.dumps(plan))
        self.assertEqual(self.cli('plan-check', '--plan', str(path), ok=False)['error'], 'plan-budget-integer-required')

    def test_special_files_rejected_without_blocking(self):
        source = self.base / 'alpha/notes.md'
        source.unlink(); os.mkfifo(source)
        self.assertIn('regular-file-required', str(self.cli('build', '--project', 'alpha', ok=False)))
        plan = self.base / 'plan.json'
        plan.write_text(json.dumps({'mode': 'organize', 'items': [{'project': 'alpha', 'file': 'notes.md'}],
                                   'budget': {'entries': 1, 'bytes': 100, 'seconds': .01}, 'confirmation': None}))
        self.assertEqual(self.cli('plan-check', '--plan', str(plan), ok=False)['error'], 'regular-file-required')

    def test_search_dates_fields_and_snippet_signal(self):
        self.cli('build')
        r = self.cli('search', '认证失败', '--snippet', '3', private=True)
        self.assertFalse(r['complete']); self.assertTrue(r['truncated'])
        self.assertTrue(r['snippets_truncated']); self.assertFalse(r['results_truncated'])
        hit = r['results'][0]
        self.assertEqual(hit['recorded_at'], '2026-01-01'); self.assertIsNone(hit['verified_at'])
        self.assertEqual(hit['matched_fields']['认证失败'], ['aliases'])
        self.assertTrue(hit['snippet_truncated'])

    def test_no_discovery_missing_source_and_read_only_record(self):
        self.cli('build')
        (self.base / 'alpha/unmapped.md').write_text('SECRET-NOT-MAPPED')
        self.assertNotIn('SECRET-NOT-MAPPED', json.dumps(self.cli('search', 'SECRET', private=True)))
        (self.base / 'alpha/notes.md').unlink()
        self.assertIn('source-unavailable', str(self.cli('search', '401', private=True, ok=False)))
        self.config['projects']['alpha']['writable'] = False; self.save()
        r = self.cli('record', '--project', 'alpha', '--file', 'notes.md', '--entry', str(self.base / 'absent.json'), ok=False)
        self.assertEqual(r['error'], 'source-read-only')

if __name__ == '__main__':
    unittest.main()
