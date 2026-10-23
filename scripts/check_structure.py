#!/usr/bin/env python3
"""Check installed product identity, JSON data, and relative Markdown links."""
import json
from pathlib import Path
import re
from urllib.parse import unquote, urlsplit
from install_local import validate_candidate


def check(root: Path) -> None:
    validate_candidate(root)
    frontmatter = (root / 'SKILL.md').read_text(encoding='utf-8').split('\n---', 1)[0]
    match = re.search(r'^description: (.+)$', frontmatter, re.MULTILINE)
    if not match or not match.group(1).strip():
        raise RuntimeError('SKILL.md requires a nonempty description scalar')
    description = match.group(1).strip()
    if description.startswith('"'):
        if not isinstance(json.loads(description), str) or not json.loads(description).strip():
            raise RuntimeError('SKILL.md requires a nonempty description scalar')
    for file in root.rglob('*.json'):
        json.loads(file.read_text(encoding='utf-8'))
    count = 0
    for file in root.rglob('*.md'):
        text = re.sub(r'(?ms)^```.*?^```[^\n]*', '', file.read_text(encoding='utf-8'))
        text = re.sub(r'`[^`\n]*`', '', text)
        for target in re.findall(r'!?\[[^\]]*\]\(([^\s)]+)(?:\s+[^)]*)?\)', text):
            target = target.strip('<>')
            link = urlsplit(target)
            if link.scheme or link.netloc or not link.path:
                continue
            resolved = (file.parent / unquote(link.path)).resolve()
            if not resolved.is_relative_to(root.resolve()) or not resolved.exists():
                raise RuntimeError(f'Invalid local Markdown link in {file.relative_to(root)}: {target}')
            count += 1
    print(f'Structure OK; {count} relative Markdown links checked.')


if __name__ == '__main__':
    check(Path(__file__).resolve().parent.parent)
