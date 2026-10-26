#!/usr/bin/env python3
"""Explicitly scoped private knowledge records and rebuildable partitions (stdlib)."""
from __future__ import annotations
import argparse
import contextlib
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import stat
import sys
import tempfile
import time

# Keep companion-module exceptions identical when invoked as a script.
sys.modules.setdefault('knowledge', sys.modules[__name__])

VERSION = 1
START, END = '<!-- knowledge:begin -->', '<!-- knowledge:end -->'
MAX_FILE, MAX_FILES, MAX_ENTRIES = 262144, 100, 1000
MAX_TOTAL = 4 * 1024 * 1024
KINDS = ['decision', 'procedure', 'fact', 'lesson', 'proposal']
STATUSES = ['current', 'unverified', 'superseded', 'retired']
FIELDS = ['id', 'title', 'kind', 'summary', 'scope', 'keywords', 'aliases', 'sources',
          'status', 'recorded_at', 'verified_at', 'basis', 'replaces', 'related']
SCHEMA = {'format': 'knowledge/1', 'record_fields': FIELDS, 'kinds': KINDS,
          'statuses': STATUSES, 'basis': ['user-decision', 'engineering-evidence', 'unverified'],
          'block': {'start': START, 'end': END, 'encoding': 'JSON object, one or more blocks per Markdown file'},
          'limits': {'file_bytes': MAX_FILE, 'source_files_per_project': MAX_FILES,
                     'entries_per_project': MAX_ENTRIES, 'project_bytes': MAX_TOTAL,
                     'search_seconds': 5, 'result_limit': 20, 'snippet_chars': 400,
                     'organize_entries': 10, 'organize_bytes': 65536, 'organize_seconds': 5}}

SCHEMA['inventory'] = {'commands': ['inventory-state', 'inventory-plan', 'inventory-commit'],
                       'defaults': {'files': 3, 'bytes': 16384, 'seconds': 3},
                       'maximum': {'files': 5, 'bytes': 65536, 'seconds': 5, 'entries': 5},
                       'automatic_source_discovery': False, 'authorization_proven': False}

class Fault(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)

def require(condition, code):
    if not condition:
        raise Fault(code)

def canonical(obj):
    return json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(',', ':'))

def digest(data):
    return hashlib.sha256(data).hexdigest()

def no_duplicates(pairs):
    out = {}
    for key, value in pairs:
        require(key not in out, 'duplicate-json-key')
        out[key] = value
    return out

def loads(data):
    try:
        return json.loads(data, object_pairs_hook=no_duplicates)
    except (ValueError, UnicodeError):
        raise Fault('invalid-json') from None

def safe_path(path):
    path = Path(os.path.abspath(path))
    require(not any(p.is_symlink() for p in [path, *path.parents]), 'symlink-denied')
    return path

def read_bytes(path, limit=MAX_FILE):
    path = safe_path(path)
    try:
        require(stat.S_ISREG(path.stat().st_mode), 'regular-file-required')
        fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | os.O_NONBLOCK)
        with os.fdopen(fd, 'rb') as handle:
            require(stat.S_ISREG(os.fstat(handle.fileno()).st_mode), 'regular-file-required')
            data = handle.read(limit + 1)
        require(len(data) <= limit, 'read-budget-exceeded')
        return data
    except OSError:
        raise Fault('source-unavailable') from None

def date(value, nullable=False):
    if nullable and value is None:
        return
    require(isinstance(value, str), 'invalid-date')
    try:
        parsed = dt.date.fromisoformat(value)
        require(parsed.isoformat() == value and parsed <= dt.date.today(), 'invalid-date')
    except ValueError:
        raise Fault('invalid-date') from None

def strings(value, nonempty=False):
    require(isinstance(value, list) and len(value) <= 50 and (value or not nonempty), 'invalid-list')
    require(all(isinstance(s, str) and 0 < len(s.strip()) <= 1000 for s in value), 'invalid-list')
    require(len(set(value)) == len(value), 'duplicate-list-item')

def validate_entry(e):
    require(isinstance(e, dict) and set(e) == set(FIELDS), 'record-fields')
    require(isinstance(e['id'], str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,79}', e['id']), 'invalid-id')
    for key in ['title', 'summary', 'scope']:
        require(isinstance(e[key], str) and 0 < len(e[key].strip()) <= 2000, 'invalid-text')
    require(e['kind'] in KINDS and e['status'] in STATUSES, 'invalid-enum')
    require(e['basis'] in SCHEMA['basis'], 'invalid-basis')
    for key in ['keywords', 'aliases', 'sources', 'replaces', 'related']:
        strings(e[key], nonempty=key == 'sources')
    date(e['recorded_at']); date(e['verified_at'], nullable=True)
    if e['verified_at'] is not None:
        require(e['basis'] == 'engineering-evidence', 'verification-basis-mismatch')
    if e['basis'] == 'engineering-evidence':
        require(e['verified_at'] is not None, 'verification-date-required')
    if e['basis'] == 'unverified':
        require(e['status'] != 'current', 'unverified-current')
    require(e['kind'] != 'decision' or e['basis'] == 'user-decision', 'decision-basis-required')


def validate_relations(entries):
    ids = {e['id']: e for e in entries}
    require(len(ids) == len(entries), 'duplicate-id')
    incoming = set()
    graph = {}
    for e in entries:
        graph[e['id']] = e['replaces']
        for target in e['replaces'] + e['related']:
            require(target in ids and target != e['id'], 'relation-target-missing')
        for target in e['replaces']:
            require(ids[target]['status'] == 'superseded', 'replacement-status-mismatch')
            incoming.add(target)
    require(all(e['status'] != 'superseded' or e['id'] in incoming for e in entries), 'replacement-link-required')
    visiting, visited = set(), set()
    def visit(start):
        # Bounded iterative traversal avoids recursion failure on long histories.
        stack = [(start, False)]
        while stack:
            node, done = stack.pop()
            if done:
                visiting.discard(node); visited.add(node)
            elif node not in visited:
                require(node not in visiting, 'replacement-cycle')
                visiting.add(node); stack.append((node, True))
                stack.extend((n, False) for n in graph[node])
    for node in graph:
        visit(node)

class Store:
    def __init__(self, config):
        self.config_path = safe_path(config)
        self.config_bytes = read_bytes(self.config_path)
        c = loads(self.config_bytes)
        require(isinstance(c, dict) and set(c) == {'version', 'index_root', 'projects'} and c['version'] == 1, 'config-format')
        require(isinstance(c['index_root'], str) and c['index_root'].strip(), 'index-root-required')
        self.index = safe_path(self.config_path.parent / c['index_root'])
        require(isinstance(c['projects'], dict) and len(c['projects']) <= 100, 'projects-format')
        self.projects = c['projects']
        for key, p in self.projects.items():
            require(re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}', key), 'project-key')
            require(isinstance(p, dict) and set(p) in ({'root', 'files', 'authorization', 'writable'}, {'root', 'files', 'authorization', 'writable', 'inventory'}), 'project-format')
            require(isinstance(p['root'], str) and p['root'].strip(), 'root-required')
            require(isinstance(p['writable'], bool), 'writable-format')
            auth = p['authorization']
            require(isinstance(auth, dict) and set(auth) == {'reference', 'scope'} and
                    all(isinstance(v, str) and v.strip() for v in auth.values()), 'authorization-reference-required')
            require(isinstance(p['files'], list) and p['files'] and all(isinstance(n, str) and n.strip() for n in p['files']), 'files-format')
            require(len(set(p['files'])) == len(p['files']), 'duplicate-source-file')
            require(len(p['files']) <= MAX_FILES, 'file-budget-exceeded')
            # Validate lexical mapping now; unavailable projects are isolated when read.
            for name in p['files']:
                rel = Path(name)
                require(not rel.is_absolute() and '..' not in rel.parts and rel.suffix == '.md', 'source-path-denied')

    def root(self, key):
        require(key in self.projects, 'project-not-authorized')
        root = safe_path(self.config_path.parent / self.projects[key]['root'])
        require(root != self.index and root not in self.index.parents and self.index not in root.parents, 'index-source-overlap')
        return root

    def path(self, key, name):
        require(name in self.projects[key]['files'], 'file-not-authorized')
        root = self.root(key)
        p = safe_path(root / name)
        require(root in p.parents, 'source-path-denied')
        return p

    def active(self):
        # Re-read the grant before emitting private data or committing derived state.
        require(read_bytes(self.config_path) == self.config_bytes, 'authorization-changed')

    def scan(self, key, *, allow_empty=False, missing=()):
        entries, fingerprints, total = [], {}, 0
        for name in self.projects[key]['files']:
            path = self.path(key, name)
            if name in missing:
                try:
                    path.stat()
                except FileNotFoundError:
                    fingerprints[name] = None
                    continue
            raw = read_bytes(path)
            total += len(raw)
            require(total <= MAX_TOTAL, 'project-read-budget-exceeded')
            fingerprints[name] = digest(raw)
            try:
                text = raw.decode('utf-8')
            except UnicodeError:
                raise Fault('source-encoding') from None
            require(text.count(START) == text.count(END), 'metadata-block-unclosed')
            pos = 0
            while True:
                begin = text.find(START, pos)
                if begin < 0:
                    require(END not in text[pos:], 'metadata-block-order')
                    break
                require(END not in text[pos:begin], 'metadata-block-order')
                end = text.find(END, begin + len(START))
                require(end >= 0 and START not in text[begin + len(START):end], 'metadata-block-nested')
                e = loads(text[begin + len(START):end].strip())
                validate_entry(e)
                # Stable generated anchor is included in the source, not invented from headings.
                anchor = f'<a id="knowledge-{e["id"]}"></a>'
                require(anchor in text[max(pos, begin - len(anchor) - 2):begin], 'stable-anchor-required')
                entries.append({**e, 'file': name, 'anchor': 'knowledge-' + e['id']})
                require(len(entries) <= MAX_ENTRIES, 'entry-budget-exceeded')
                pos = end + len(END)
        require(entries or allow_empty, 'no-records')
        validate_relations(entries)
        return {'version': VERSION, 'fingerprints': fingerprints, 'entries': sorted(entries, key=lambda e: e['id'])}

    def snapshot(self, key):
        live = self.scan(key)
        try:
            cached = loads(read_bytes(self.index / (key + '.json'), MAX_TOTAL * 2))
        except Fault as exc:
            raise Fault('index-missing-or-corrupt') from exc
        require(cached == live, 'index-stale-or-tampered')
        return live

    @contextlib.contextmanager
    def lock(self, key):
        try:
            import fcntl
        except ImportError:
            raise Fault('posix-lock-required') from None
        safe_path(self.index)
        self.index.mkdir(mode=0o700, parents=True, exist_ok=True)
        lock = safe_path(self.index / (key + '.lock'))
        fd = os.open(lock, os.O_CREAT | os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0), 0o600)
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise Fault('partition-busy') from None
            yield
        finally:
            os.close(fd)

    def build_one(self, key):
        self.root(key)
        with self.lock(key):
            self.active()
            snapshot = self.scan(key)
            require(self.scan(key) == snapshot, 'source-changed-during-build')
            self.active()
            atomic(self.index / (key + '.json'), canonical(snapshot).encode())
        return len(snapshot['entries'])


def atomic(path, data):
    path = safe_path(path)
    fd, tmp = tempfile.mkstemp(prefix='.knowledge-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as handle:
            handle.write(data); handle.flush(); os.fsync(handle.fileno())
        safe_path(path)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)

@contextlib.contextmanager
def deadline(seconds):
    require(hasattr(signal, 'setitimer'), 'bounded-regex-unavailable')
    def expired(*_):
        raise Fault('query-timeout')
    previous = signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


def record(store, args):
    key = args.project
    require(key is not None and key in store.projects, 'project-required')
    require(store.projects[key]['writable'], 'source-read-only')
    target = store.path(key, args.file)
    entry = loads(read_bytes(Path(args.entry)))
    validate_entry(entry)
    body = read_bytes(Path(args.body)).decode('utf-8') if args.body else ''
    require(START not in body and END not in body, 'body-metadata-denied')
    with store.lock(key):
        store.active()
        require(not target.exists(), 'record-exists-use-source-editor')
        # Files are explicitly mapped before creation; no parent discovery or creation.
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        content = (f'<a id="knowledge-{entry["id"]}"></a>\n{START}\n' +
                   json.dumps(entry, ensure_ascii=False, indent=2) + f'\n{END}\n\n' + body).encode()
        require(len(content) <= MAX_FILE, 'read-budget-exceeded')
        atomic(target, content)
    try:
        count = store.build_one(key)
        return {'ok': True, 'source_written': True, 'indexed': True, 'entries': count}
    except (Fault, OSError) as exc:
        return {'ok': False, 'source_written': True, 'indexed': False, 'error': exc.code if isinstance(exc, Fault) else 'index-write-failed', 'recovery': 'build'}


def plan_check(store, args):
    p = loads(read_bytes(Path(args.plan)))
    require(isinstance(p, dict) and set(p) == {'mode', 'items', 'budget', 'confirmation'}, 'plan-format')
    require(p['mode'] in ['organize', 'retrospective'], 'plan-mode')
    require(isinstance(p['items'], list) and p['items'] and len(p['items']) <= 100, 'plan-items')
    budget = p['budget']
    require(isinstance(budget, dict) and set(budget) == {'entries', 'bytes', 'seconds'}, 'plan-budget')
    for field, cap in [('entries', 10), ('bytes', 65536), ('seconds', 5)]:
        require(type(budget[field]) in [int, float] and 0 < budget[field] <= cap, 'plan-budget-exceeded')
        if field != 'seconds':
            require(type(budget[field]) is int, 'plan-budget-integer-required')
    if p['mode'] == 'retrospective':
        c = p['confirmation']
        require(isinstance(c, dict) and set(c) == {'reference', 'scope', 'confirmed_at'} and
                all(isinstance(v, str) and v.strip() for v in c.values()), 'user-confirmation-reference-required')
        date(c['confirmed_at'])
    else:
        require(p['confirmation'] is None, 'organize-confirmation-format')
    # Validate the entire enumeration without reading source content first.
    mapped, seen = [], set()
    for item in p['items']:
        require(isinstance(item, dict) and set(item) in ({'project', 'file'}, {'project', 'file', 'offset'}), 'plan-item-format')
        key, name, offset = item['project'], item['file'], item.get('offset', 0)
        require(isinstance(key, str) and isinstance(name, str), 'plan-item-format')
        require(type(offset) is int and 0 <= offset <= MAX_FILE, 'plan-offset')
        require((key, name) not in seen, 'plan-duplicate-item'); seen.add((key, name))
        mapped.append((key, name, store.path(key, name), offset))
    result, read, started, finished = [], 0, time.monotonic(), 0
    reason, continuation = None, None
    try:
        # Includes source open/read, not only between-file checks.
        with deadline(budget['seconds']):
            for key, name, path, offset in mapped:
                if len(result) >= budget['entries'] or read >= budget['bytes']:
                    reason = 'entries' if len(result) >= budget['entries'] else 'bytes'
                    continuation = {'project': key, 'file': name, 'offset': offset}
                    break
                require(stat.S_ISREG(path.stat().st_mode), 'regular-file-required')
                fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | getattr(os, 'O_NOFOLLOW', 0))
                # Unbuffered byte reads: stop at the current metadata boundary without
                # prefetching the following entries behind the caller's budget.
                with os.fdopen(fd, 'rb', buffering=0) as handle:
                    info = os.fstat(handle.fileno())
                    require(stat.S_ISREG(info.st_mode), 'regular-file-required')
                    require(info.st_size <= MAX_FILE and offset <= info.st_size, 'plan-source-size')
                    handle.seek(offset)
                    begin, position, tail, has_block = offset, offset, b'', False
                    while position < info.st_size:
                        if read >= budget['bytes'] or len(result) >= budget['entries']:
                            reason = 'bytes' if read >= budget['bytes'] else 'entries'
                            continuation = {'project': key, 'file': name, 'offset': position}
                            break
                        byte = handle.read(1)
                        require(byte, 'source-changed-during-plan')
                        read += 1; position += 1
                        tail = (tail + byte)[-max(len(START.encode()), len(END.encode())):]
                        if tail.endswith(START.encode()):
                            has_block = True
                        if tail.endswith(END.encode()):
                            has_block = True
                            result.append({'project': key, 'file': name, 'start_byte': begin, 'end_byte': position})
                            begin = position
                    if reason:
                        break
                    require(os.fstat(handle.fileno()).st_size == info.st_size, 'source-changed-during-plan')
                    # A plain document is one unit. Body after a parsed block is
                    # included in bytes read but does not create another entry.
                    if not has_block and position > offset:
                        result.append({'project': key, 'file': name, 'start_byte': offset, 'end_byte': position})
                    finished += 1
    except Fault as exc:
        if exc.code != 'query-timeout':
            raise
        reason = 'seconds'
    store.active()
    return {'ok': True, 'complete': reason is None and finished == len(mapped),
            'processed_entries': len(result), 'read_bytes': read,
            'elapsed_seconds': round(time.monotonic() - started, 6),
            'limit_reached': reason is not None, 'limit_reason': reason,
            'authorization_proven': False, 'semantic_changes_applied': False,
            **({'items': result, 'continuation': continuation} if args.private_output else {})}


def run(args):
    if args.command == 'schema':
        return SCHEMA
    if args.command.startswith('inventory-'):
        import knowledge_inventory
        return knowledge_inventory.run(args)
    store = Store(args.config)
    if args.command == 'record':
        return record(store, args)
    if args.command == 'plan-check':
        return plan_check(store, args)
    keys = [args.project] if args.project else sorted(store.projects)
    require(all(k in store.projects for k in keys), 'project-not-authorized')
    issues, snapshots, count = [], {}, 0
    for key in keys:
        try:
            if args.command == 'build':
                count += store.build_one(key)
            else:
                snapshots[key] = store.snapshot(key)
                count += len(snapshots[key]['entries'])
        except (Fault, OSError) as exc:
            issues.append({'code': exc.code if isinstance(exc, Fault) else 'partition-io-failed', **({'project': key} if args.private_output else {})})
    if args.command != 'search':
        store.active()
        return {'ok': not issues, 'complete': not issues, 'projects': len(keys), 'entries': count, 'issues': issues}
    require(args.private_output, 'private-output-required')
    require(1 <= args.limit <= 20 and 1 <= args.snippet <= 400 and 0 < args.seconds <= 5, 'query-budget')
    require(1 <= len(args.terms) <= 10 and all(0 < len(t) <= 256 for t in args.terms), 'query-terms')
    hits = []
    with deadline(args.seconds):
        patterns = []
        if args.regex:
            try:
                patterns = [re.compile(t, re.IGNORECASE) for t in args.terms]
            except re.error:
                raise Fault('invalid-regex') from None
        for key, snap in snapshots.items():
            for e in snap['entries']:
                if args.status and e['status'] != args.status or args.kind and e['kind'] != args.kind:
                    continue
                if args.scope and args.scope.casefold() not in e['scope'].casefold():
                    continue
                fields = {name: e[name] for name in ['id', 'title', 'summary', 'scope']}
                fields.update({name: '\n'.join(e[name]) for name in ['keywords', 'aliases']})
                matched_fields = {}
                for n, term in enumerate(args.terms):
                    matched_fields[term] = [name for name, value in fields.items()
                                           if (patterns[n].search(value) if args.regex else term.casefold() in value.casefold())]
                matches = [bool(matched_fields[t]) for t in args.terms]
                if not (all(matches) if args.all else any(matches)):
                    continue
                score = sum(matches)
                hits.append({'project': key, 'id': e['id'], 'title': e['title'],
                             'kind': e['kind'], 'status': e['status'], 'basis': e['basis'],
                             'recorded_at': e['recorded_at'], 'verified_at': e['verified_at'],
                             'current_decision': e['kind'] == 'decision' and e['status'] == 'current',
                             'scope': e['scope'], 'sources': e['sources'], 'file': e['file'], 'anchor': e['anchor'],
                             'snippet': e['summary'][:args.snippet], 'snippet_truncated': len(e['summary']) > args.snippet,
                             'score': score, 'matched_fields': {t: names for t, names in matched_fields.items() if names},
                             'matched_terms': [t for t, m in zip(args.terms, matches) if m],
                             'replaces': e['replaces'], 'related': e['related']})
    hits.sort(key=lambda h: (not h['current_decision'], h['status'] != 'current', -h['score'], h['project'], h['id']))
    store.active()
    snippet_cut = any(h['snippet_truncated'] for h in hits[:args.limit])
    return {'ok': not issues, 'complete': not issues and len(hits) <= args.limit and not snippet_cut,
            'incomplete_projects': issues, 'truncated': len(hits) > args.limit or snippet_cut,
            'results_truncated': len(hits) > args.limit, 'snippets_truncated': snippet_cut,
            'searched_projects': len(snapshots), 'total_matches': len(hits),
            'ranking': 'current decision, current status, matched term count descending, project/id',
            'results': hits[:args.limit]}


class SafeParser(argparse.ArgumentParser):
    def error(self, message):
        # argparse's default error includes raw arguments even on a summary-only path.
        self.exit(2, json.dumps({'ok': False, 'complete': False, 'error': 'invalid-cli-arguments'}) + '\n')


def main(argv=None):
    parser = SafeParser(description=__doc__)
    parser.add_argument('--config', help='Explicit private grant/config file; never auto-discovered')
    parser.add_argument('--private-output', action='store_true', help='Include authorized local knowledge; never share as generic content')
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('schema', help='Print the fixed metadata profile and budgets')
    for name in ['build', 'check', 'search', 'record']:
        p = sub.add_parser(name)
        p.add_argument('--project', help='One currently granted project key; otherwise all granted partitions')
        if name == 'search':
            p.add_argument('terms', nargs='+', help='Literal OR terms by default; Unicode casefold, no tokenization')
            p.add_argument('--all', action='store_true'); p.add_argument('--regex', action='store_true')
            p.add_argument('--status', choices=STATUSES); p.add_argument('--kind', choices=KINDS)
            p.add_argument('--scope'); p.add_argument('--limit', type=int, default=5)
            p.add_argument('--snippet', type=int, default=200); p.add_argument('--seconds', type=float, default=2)
        if name == 'record':
            p.add_argument('--file', required=True); p.add_argument('--entry', required=True); p.add_argument('--body')
    p = sub.add_parser('plan-check', help='Read an enumerated batch within hard caps; does not organize or prove consent')
    p.add_argument('--plan', required=True)
    import knowledge_inventory
    knowledge_inventory.add_commands(sub)
    args = parser.parse_args(argv)
    if args.command not in ['schema', 'inventory-state'] and not args.config:
        parser.error('--config is required')
    try:
        result = run(args)
    except Fault as exc:
        result = {'ok': False, 'complete': False, 'error': exc.code}
    except (OSError, ValueError, TypeError, KeyError, AttributeError, UnicodeError):
        # Do not echo OS paths, source text or arbitrary config data in diagnostics.
        result = {'ok': False, 'complete': False, 'error': 'invalid-or-unavailable-input'}
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get('ok', True) else 1

if __name__ == '__main__':
    sys.exit(main())
