"""Bounded first-knowledge inventory; companion to knowledge.py, never auto-discovers."""
from __future__ import annotations
import json
import os
from pathlib import Path
import stat
import time
import knowledge as k

MAX_DOCUMENTS = 5
MAX_BYTES = 65536
MAX_SECONDS = 5


def add_commands(sub):
    for name in ['inventory-state', 'inventory-plan', 'inventory-commit']:
        p = sub.add_parser(name, help='Inspect, plan or commit explicitly scoped first knowledge; not a retrospective')
        p.add_argument('--project', required=True)
        if name == 'inventory-plan':
            p.add_argument('--max-files', type=int, default=3)
            p.add_argument('--bytes', type=int, default=16384)
            p.add_argument('--seconds', type=float, default=3)
        if name == 'inventory-commit':
            p.add_argument('--plan-id', required=True)
            p.add_argument('--entries', required=True, help='Model-extracted JSON array; source references must come from plan')


def exists(path):
    try:
        path.lstat()
        return True
    except FileNotFoundError:
        return False


def specification(store, key):
    k.require(key in store.projects, 'project-not-authorized')
    spec = store.projects[key].get('inventory')
    if spec is None:
        return None
    k.require(isinstance(spec, dict) and set(spec) == {'root', 'files', 'authorization', 'output'}, 'inventory-config-format')
    k.require(isinstance(spec['root'], str) and spec['root'].strip(), 'inventory-root-required')
    auth = spec['authorization']
    k.require(isinstance(auth, dict) and set(auth) == {'reference', 'scope'} and
              all(isinstance(v, str) and v.strip() for v in auth.values()), 'inventory-authorization-required')
    k.require(isinstance(spec['files'], list) and 0 < len(spec['files']) <= MAX_DOCUMENTS, 'inventory-file-budget')
    k.require(all(isinstance(n, str) and n and not Path(n).is_absolute() and '..' not in Path(n).parts
                  and Path(n).suffix == '.md' for n in spec['files']), 'inventory-path-denied')
    k.require(len(set(spec['files'])) == len(spec['files']), 'inventory-duplicate-file')
    k.require(isinstance(spec['output'], str) and spec['output'] in store.projects[key]['files'], 'inventory-output-not-authorized')
    store.path(key, spec['output'])
    return spec


def document(store, spec, name, key):
    k.require(name in spec['files'], 'inventory-file-not-authorized')
    root = k.safe_path(store.config_path.parent / spec['root'])
    path = k.safe_path(root / name)
    k.require(root in path.parents, 'inventory-path-denied')
    # A read role cannot silently become a source/index/receipt write target.
    k.require(store.index != root and store.index not in root.parents and root not in store.index.parents,
              'inventory-index-overlap')
    for filename in store.projects[key]['files']:
        k.require(path != store.path(key, filename), 'inventory-role-overlap')
    return path


def receipt_path(store, key):
    return k.safe_path(store.index / (key + '.inventory.json'))


def get_receipt(store, key):
    path = receipt_path(store, key)
    if not exists(path):
        return None
    r = k.loads(k.read_bytes(path))
    k.require(isinstance(r, dict) and set(r) == {'plan', 'plan_id', 'output_hash', 'indexed'}, 'inventory-receipt-invalid')
    k.require(type(r['indexed']) is bool and (r['output_hash'] is None or
              isinstance(r['output_hash'], str) and len(r['output_hash']) == 64 and
              all(c in '0123456789abcdef' for c in r['output_hash'])), 'inventory-receipt-invalid')
    k.require(isinstance(r['plan'], dict) and k.digest(k.canonical(r['plan']).encode()) == r['plan_id'], 'inventory-receipt-invalid')
    k.require(r['plan'].get('grant') == k.digest(store.config_bytes), 'inventory-plan-stale')
    return r


def output_writable(store, key, spec):
    path = store.path(key, spec['output'])
    parent = path.parent
    while not exists(parent):
        parent = parent.parent
    k.require(parent.is_dir() and os.access(parent, os.W_OK | os.X_OK), 'inventory-output-not-writable')
    if exists(path):
        k.require(os.access(path, os.W_OK), 'inventory-output-not-writable')


def inspect(store, key):
    spec = specification(store, key)
    receipt = get_receipt(store, key)
    missing = [spec['output']] if spec else []
    cache = k.safe_path(store.index / (key + '.json'))
    if spec and not exists(store.path(key, spec['output'])) and (exists(cache) or receipt and receipt['output_hash']):
        raise k.Fault('inventory-output-lost')
    snap = store.scan(key, allow_empty=True, missing=missing)
    if snap['entries']:
        try:
            store.snapshot(key)
            return {'state': 'ready', 'entries': len(snap['entries']), 'next': 'none'}, snap, receipt
        except k.Fault as exc:
            return {'state': 'partial' if receipt else 'rebuild-needed', 'entries': len(snap['entries']),
                    'next': 'build-check', 'reason': exc.code}, snap, receipt
    k.require(not exists(cache), 'index-without-knowledge')
    k.require(not receipt or not receipt['output_hash'], 'inventory-output-lost')
    # Plain legacy prose might already be knowledge. Never guess that it is empty.
    for name, fingerprint in snap['fingerprints'].items():
        if fingerprint is not None and k.read_bytes(store.path(key, name)).strip():
            return {'state': 'unstructured', 'entries': 0, 'next': 'adapt-existing-metadata'}, snap, receipt
    if not store.projects[key]['writable']:
        raise k.Fault('source-read-only')
    if not spec:
        return {'state': 'inventory-not-configured', 'entries': 0, 'next': 'map-authorized-inventory-sources'}, snap, receipt
    output_writable(store, key, spec)
    for name in spec['files']:
        bounded_document(document(store, spec, name, key), 0)
    return {'state': 'planned' if receipt else 'empty', 'entries': 0, 'next': 'inventory-plan'}, snap, receipt


def bounded_document(path, limit, accounting=None):
    path = k.safe_path(path)
    k.require(stat.S_ISREG(path.stat().st_mode), 'regular-file-required')
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | getattr(os, 'O_NOFOLLOW', 0))
    with os.fdopen(fd, 'rb', buffering=0) as handle:
        before = os.fstat(handle.fileno())
        k.require(stat.S_ISREG(before.st_mode), 'regular-file-required')
        k.require(before.st_size <= k.MAX_FILE, 'inventory-source-size')
        try:
            raw = handle.read(limit)
        finally:
            if accounting is not None:
                accounting[0] += handle.tell()
        after = os.fstat(handle.fileno())
        k.require((before.st_size, before.st_mtime_ns) == (after.st_size, after.st_mtime_ns), 'inventory-source-changed')
    return raw, {'size': before.st_size, 'mtime_ns': before.st_mtime_ns}


def make_plan(store, args):
    k.require(args.private_output, 'private-output-required')
    k.require(1 <= args.max_files <= MAX_DOCUMENTS and 1 <= args.bytes <= MAX_BYTES and
              0 < args.seconds <= MAX_SECONDS, 'inventory-budget')
    key = args.project
    with store.lock(key):
        state, snap, old = inspect(store, key)
        if state['state'] not in ['empty', 'planned']:
            return {'ok': True, **state, 'inventory_started': False}
        spec = specification(store, key)
        selected, documents, accounting, reason = [], [], [0], None
        started = time.monotonic()
        try:
            with k.deadline(args.seconds):
                for name in spec['files']:
                    if len(selected) >= args.max_files or accounting[0] >= args.bytes:
                        reason = 'files' if len(selected) >= args.max_files else 'bytes'
                        break
                    raw, info = bounded_document(document(store, spec, name, key), args.bytes - accounting[0], accounting)
                    k.require(raw, 'inventory-source-empty')
                    binding = {'file': name, 'bytes': len(raw), 'sha256': k.digest(raw), **info}
                    binding['reference'] = 'inventory:' + name + '#bytes=0-' + str(len(raw)) + '@' + binding['sha256']
                    selected.append(binding)
                    documents.append({**binding, 'text': raw.decode('utf-8', errors='replace'), 'truncated': len(raw) < info['size']})
                    if len(raw) < info['size']:
                        reason = 'bytes'
                        break
        except k.Fault as exc:
            if exc.code != 'query-timeout':
                raise
            reason = 'seconds'
        store.active()
        if not selected:
            return {'ok': False, 'state': 'budget-exhausted', 'complete': False, 'read_bytes': accounting[0],
                    'limit_reason': reason, 'inventory_started': False}
        plan = {'version': 1, 'grant': k.digest(store.config_bytes), 'project': key, 'output': spec['output'],
                'before': snap['fingerprints'], 'sources': selected,
                'budget': {'files': args.max_files, 'bytes': args.bytes, 'seconds': args.seconds},
                'coverage_complete': reason is None and len(selected) == len(spec['files'])}
        plan_id = k.digest(k.canonical(plan).encode())
        # Never overwrite a partially committed receipt through repeated initialization.
        if old:
            k.require(old['plan_id'] == plan_id, 'inventory-plan-stale')
        k.atomic(receipt_path(store, key), k.canonical({'plan': plan, 'plan_id': plan_id, 'output_hash': None, 'indexed': False}).encode())
        return {'ok': True, 'state': 'planned', 'plan_id': plan_id, 'documents': documents,
                'read_bytes': accounting[0], 'elapsed_seconds': round(time.monotonic() - started, 6),
                'complete': plan['coverage_complete'], 'limit_reached': reason is not None,
                'limit_reason': reason, 'authorization_proven': False, 'semantic_extraction_applied': False}


def check_plan(store, key, receipt):
    plan = receipt['plan']
    k.require(set(plan) == {'version', 'grant', 'project', 'output', 'before', 'sources', 'budget', 'coverage_complete'} and
              type(plan['version']) is int and plan['version'] == 1 and plan['project'] == key and
              type(plan['coverage_complete']) is bool, 'inventory-receipt-invalid')
    spec = specification(store, key)
    k.require(spec and plan['output'] == spec['output'], 'inventory-output-not-authorized')
    b = plan['budget']
    k.require(isinstance(b, dict) and set(b) == {'files', 'bytes', 'seconds'} and type(b['files']) is int and
              1 <= b['files'] <= MAX_DOCUMENTS and type(b['bytes']) is int and 1 <= b['bytes'] <= MAX_BYTES and
              type(b['seconds']) in [int, float] and 0 < b['seconds'] <= MAX_SECONDS, 'inventory-budget')
    k.require(isinstance(plan['sources'], list) and 0 < len(plan['sources']) <= b['files'], 'inventory-receipt-invalid')
    total, seen = 0, set()
    with k.deadline(b['seconds']):
        for source in plan['sources']:
            k.require(isinstance(source, dict) and set(source) == {'file', 'bytes', 'sha256', 'size', 'mtime_ns', 'reference'}, 'inventory-receipt-invalid')
            name, size = source['file'], source['bytes']
            k.require(isinstance(name, str) and name not in seen and type(size) is int and 0 < size <= b['bytes'] - total,
                      'inventory-receipt-invalid')
            seen.add(name);total += size
            raw, info = bounded_document(document(store, spec, name, key), size)
            k.require(len(raw) == size and k.digest(raw) == source['sha256'] and info == {f: source[f] for f in ['size', 'mtime_ns']}, 'inventory-source-changed')
            ref = 'inventory:' + name + '#bytes=0-' + str(size) + '@' + source['sha256']
            k.require(ref == source['reference'], 'inventory-receipt-invalid')
    k.require(not plan['coverage_complete'] or
              len(seen) == len(spec['files']) and all(s['bytes'] == s['size'] for s in plan['sources']),
              'inventory-receipt-invalid')
    return spec


def commit(store, args):
    key = args.project
    entries = k.loads(k.read_bytes(Path(args.entries), MAX_BYTES))
    k.require(isinstance(entries, list) and 0 < len(entries) <= 5, 'inventory-entry-budget')
    for e in entries:
        k.validate_entry(e)
    k.validate_relations(entries)
    with store.lock(key):
        spec = specification(store, key)
        k.require(spec and store.projects[key]['writable'], 'source-read-only')
        output_writable(store, key, spec)
        receipt = get_receipt(store, key)
        k.require(receipt and receipt['plan_id'] == args.plan_id, 'inventory-plan-required')
        spec = check_plan(store, key, receipt)
        allowed = {s['reference'] for s in receipt['plan']['sources']}
        k.require(all(set(e['sources']) <= allowed for e in entries), 'inventory-source-reference-required')
        payload = '\n\n'.join(f'<a id="knowledge-{e["id"]}"></a>\n{k.START}\n' +
                              json.dumps(e, ensure_ascii=False, indent=2) + '\n' + k.END for e in entries).encode() + b'\n'
        path = store.path(key, spec['output'])
        before = receipt['plan']['before']
        k.require(isinstance(before, dict) and spec['output'] in before, 'inventory-plan-stale')
        prior_hash = before[spec['output']]
        raw = k.read_bytes(path) if exists(path) else None
        if raw is None:
            k.require(prior_hash is None, 'inventory-output-lost')
            content = payload
        elif not raw.strip():
            k.require(k.digest(raw) == prior_hash, 'inventory-knowledge-changed')
            content = raw + payload
        elif raw.endswith(payload):
            prefix = raw[:-len(payload)]
            k.require(not prefix.strip() and (k.digest(prefix) == prior_hash or
                      not prefix and prior_hash is None), 'inventory-output-exists')
            content = raw
        else:
            raise k.Fault('inventory-output-exists')
        k.require(len(content) <= k.MAX_FILE, 'inventory-output-budget')
        output_hash = k.digest(content)
        snap = store.scan(key, allow_empty=True, missing=[spec['output']])
        k.require(isinstance(before, dict) and set(before) == set(snap['fingerprints']), 'inventory-plan-stale')
        for name, value in snap['fingerprints'].items():
            if name == spec['output']:
                k.require(value in [None, prior_hash, output_hash], 'inventory-output-exists')
            else:
                k.require(value == before[name], 'inventory-knowledge-changed')
        if snap['entries']:
            k.require(snap['fingerprints'][spec['output']] == output_hash and
                      {e['id'] for e in snap['entries']} == {e['id'] for e in entries}, 'inventory-knowledge-exists')
        store.active()
        if snap['fingerprints'][spec['output']] != output_hash:
            path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            # New outputs use a no-replace link; empty pre-existing output uses
            # cooperative source CAS, with the same external-editor limits as build.
            if not exists(path):
                import tempfile
                fd, temp = tempfile.mkstemp(prefix='.inventory-', dir=path.parent)
                try:
                    with os.fdopen(fd, 'wb') as h:
                        h.write(content);h.flush();os.fsync(h.fileno())
                    os.link(temp, k.safe_path(path), follow_symlinks=False)
                finally:
                    if os.path.exists(temp):
                        os.unlink(temp)
            else:
                k.require(raw is not None and not raw.strip() and k.read_bytes(path) == raw, 'inventory-output-exists')
                k.atomic(path, content)
        receipt['output_hash'] = output_hash
        try:
            store.active()
            live = store.scan(key)
            k.require(store.scan(key) == live, 'source-changed-during-build')
            store.active()
            k.atomic(store.index / (key + '.json'), k.canonical(live).encode())
            # Completion is derived from actual body + index, never just this receipt.
            store.snapshot(key)
            receipt['indexed'] = True
            k.atomic(receipt_path(store, key), k.canonical(receipt).encode())
        except (k.Fault, OSError) as exc:
            return {'ok': False, 'state': 'partial', 'source_written': True, 'indexed': False,
                    'error': exc.code if isinstance(exc, k.Fault) else 'inventory-io-failed', 'next': 'build-check-or-retry-commit'}
        return {'ok': True, 'state': 'ready', 'source_written': True, 'indexed': True, 'entries': len(entries),
                'inventory_coverage_complete': receipt['plan']['coverage_complete'], 'authorization_proven': False}


def run(args):
    if args.command == 'inventory-state' and not args.config:
        return {'ok': True, 'state': 'unconfigured', 'next': 'map-authorized-private-knowledge'}
    try:
        if args.command == 'inventory-state':
            try:
                k.safe_path(args.config).stat()
            except FileNotFoundError:
                return {'ok': True, 'state': 'unconfigured', 'next': 'map-authorized-private-knowledge'}
        store = k.Store(args.config)
        if args.command == 'inventory-state':
            state, _, _ = inspect(store, args.project)
            store.active()
            return {'ok': True, **state}
        # Validate project + source roles before lock creates private index state.
        specification(store, args.project)
        store.root(args.project)
        return make_plan(store, args) if args.command == 'inventory-plan' else commit(store, args)
    except (k.Fault, OSError) as exc:
        code = exc.code if isinstance(exc, k.Fault) else 'inventory-io-failed'
        state = 'unauthorized' if code in ['project-not-authorized', 'authorization-reference-required',
                  'inventory-authorization-required', 'source-read-only', 'inventory-output-not-writable'] else 'invalid-or-unavailable'
        return {'ok': False, 'state': state, 'error': code, 'complete': False, 'next': 'inspect-scope-and-source; preserve-receipt-before-replanning'}
