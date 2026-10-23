import json
from pathlib import Path
import tempfile
import unittest
from check_structure import check


class StructureTests(unittest.TestCase):
    def test_real_links_and_examples(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'agents').mkdir()
            (root / 'agents/openai.yaml').write_text('name: example\n')
            (root / 'SKILL.md').write_text('---\nname: project-manager\ndescription: Example\n---\n[Guide](guide.md)\n')
            (root / 'runtime-manifest.json').write_text(json.dumps({'schemaVersion': 1, 'files': ['runtime-manifest.json', 'SKILL.md', 'agents/openai.yaml']}))
            (root / 'guide.md').write_text('`[Example](not-a-file.md)`\n```md\n[Example](also-not-a-file.md)\n```\n')
            check(root)
            (root / 'guide.md').write_text('[Broken](missing.md)\n')
            with self.assertRaisesRegex(RuntimeError, 'Invalid local Markdown link'):
                check(root)
            (root / 'guide.md').write_text('[Escape](../outside.md)\n')
            with self.assertRaises(RuntimeError):
                check(root)
            (root / 'guide.md').write_text('Valid text\n')
            (root / 'data.json').write_text('{invalid')
            with self.assertRaises(ValueError):
                check(root)

    def test_malformed_description(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'agents').mkdir()
            (root / 'agents/openai.yaml').write_text('interface: {}\n')
            (root / 'runtime-manifest.json').write_text(json.dumps({'schemaVersion': 1, 'files': ['runtime-manifest.json', 'SKILL.md', 'agents/openai.yaml']}))
            for description in ['', '"', '""']:
                (root / 'SKILL.md').write_text('---\nname: project-manager\ndescription: ' + description + '\n---\n')
                with self.subTest(description=description), self.assertRaises((RuntimeError, ValueError)):
                    check(root)
