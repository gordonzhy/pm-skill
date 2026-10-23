#!/usr/bin/env python3
"""Choose conservative verification scope from Git changes (no third-party dependencies)."""
from __future__ import annotations
import argparse
import os
from pathlib import PurePosixPath
import subprocess


def classify(paths: list[str] | None) -> str:
    if not paths:
        return 'full'
    tier = 'quick'
    for name in paths:
        path = PurePosixPath(name)
        if path.is_absolute() or '..' in path.parts:
            return 'full'
        if (name.startswith(('scripts/core/', 'scripts/test-support/', '.github/', 'contracts/'))
                or name in {'runtime-manifest.json', 'release.json'}
                or path.name in {'verify_team_share.py', 'ci_scope.py', 'test_ci_scope.py',
                                 'check_structure.py', 'test_check_structure.py', 'install_local.py', 'test_install_local.py',
                                 'file-store.test.mjs', 'process-lock.mjs', 'process-lock.test.mjs'}):
            return 'full'
        if (path.suffix == '.md' and (len(path.parts) == 1 or path.parts[0] in {'references', 'docs'})):
            continue
        if len(path.parts) == 2 and path.parts[0] == 'scripts' and path.suffix in {'.mjs', '.py'}:
            tier = 'regular'
            continue
        return 'full'
    return tier


def changed_paths(base: str | None, head: str, event: str) -> list[str] | None:
    if not base or set(base) == {'0'}:
        return None
    try:
        # Validate both objects first; never turn a missing shallow-history base into an empty diff.
        for ref in (base, head):
            subprocess.run(['git', 'rev-parse', '--verify', f'{ref}^{{commit}}'], check=True, capture_output=True)
        start = subprocess.check_output(['git', 'merge-base', base, head], text=True).strip() if event == 'pull_request' else base
        # Disable rename detection so both deleted and added names participate in risk classification.
        raw = subprocess.check_output(['git', 'diff', '--name-only', '--no-renames', '-z', start, head, '--'])
        return raw.decode('utf-8').rstrip('\0').split('\0') if raw else []
    except (subprocess.CalledProcessError, OSError, UnicodeError):
        return None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base')
    parser.add_argument('--head', default='HEAD')
    parser.add_argument('--event', default='push')
    args = parser.parse_args()
    tier = classify(changed_paths(args.base, args.head, args.event)) if args.event in {'push', 'pull_request'} else 'full'
    print(f'tier={tier}')
    if os.environ.get('GITHUB_OUTPUT'):
        with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as stream:
            stream.write(f'tier={tier}\n')


if __name__ == '__main__':
    main()
