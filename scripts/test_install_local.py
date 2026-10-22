#!/usr/bin/env python3
"""Installer regression tests; all writes target isolated temporary roots."""

import importlib.util
import json
import re
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

SCRIPT = Path(__file__).with_name("install_local.py")
spec = importlib.util.spec_from_file_location("install_local", SCRIPT)
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


@unittest.skipUnless(installer.fcntl is not None, "POSIX flock required")
class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="pm-installer-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "candidate"
        shutil.copytree(SCRIPT.parent.parent, self.source,
                        ignore=installer.IGNORED_PATTERNS)
        self.codex = self.root / "codex"

    def install(self):
        return installer.install_skill(self.source, self.codex)

    def test_update_preserves_exact_backup_and_installed_hashes(self):
        destination, backup = self.install()
        self.assertIsNone(backup)
        before = installer.file_hashes(destination)
        (self.source / "README.md").write_text("updated candidate", encoding="utf-8")
        destination, backup = self.install()
        self.assertEqual(installer.file_hashes(backup), before)
        self.assertEqual(installer.file_hashes(destination), installer.file_hashes(self.source))
        self.assertFalse((destination / "pm-skill").exists())

    def legacy(self):
        target = self.codex / "skills" / "pm-skill"
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(self.source, target)
        text = (target / "SKILL.md").read_text().replace("name: project-manager\n", "name: pm-skill\n")
        (target / "SKILL.md").write_text(text)
        release = json.loads((target / "release.json").read_text())
        release["name"] = "pm-skill"
        (target / "release.json").write_text(json.dumps(release))
        return target

    def test_legacy_migration_backs_up_exact_bytes_and_removes_duplicate(self):
        legacy = self.legacy()
        before = installer.file_hashes(legacy)
        destination, backup = self.install()
        self.assertEqual(destination.name, "project-manager")
        self.assertFalse(legacy.exists())
        self.assertEqual(installer.file_hashes(backup), before)
        self.assertEqual(installer.file_hashes(destination), installer.file_hashes(self.source))

    def test_both_owned_copies_are_backed_up(self):
        destination, _ = self.install()
        legacy = self.legacy()
        originals = [installer.file_hashes(path) for path in (destination, legacy)]
        self.install()
        backups = list((self.codex / "skill-backups/project-manager").iterdir())
        self.assertEqual(len(backups), 2)
        self.assertCountEqual([installer.file_hashes(path) for path in backups], originals)
        self.assertFalse(legacy.exists())

    def test_unknown_or_linked_installations_are_untouched(self):
        for name in ("pm-skill", "project-manager"):
            for kind in ("unknown", "symlink", "nested-link"):
                with self.subTest(name=name, kind=kind):
                    target = self.codex / "skills" / name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    if kind == "symlink":
                        target.symlink_to(self.source, target_is_directory=True)
                    elif kind == "nested-link":
                        shutil.copytree(self.source, target)
                        (target / "extra").symlink_to(self.source)
                    else:
                        target.mkdir(); (target / "SKILL.md").write_text("unrelated")
                    before = installer.file_hashes(self.source)
                    with self.assertRaises(installer.InstallError):
                        self.install()
                    self.assertTrue(target.is_symlink() or target.exists())
                    self.assertEqual(installer.file_hashes(self.source), before)
                    if target.is_symlink(): target.unlink()
                    else: shutil.rmtree(target)

    def test_failed_migration_restores_both_original_locations(self):
        destination, _ = self.install()
        legacy = self.legacy()
        originals = {path: installer.file_hashes(path) for path in (destination, legacy)}
        rename = installer.rename_exact
        def fail_promotion(source, target):
            if source.parent.name.startswith(".project-manager-stage-"):
                raise OSError("injected migration failure")
            return rename(source, target)
        with mock.patch.object(installer, "rename_exact", side_effect=fail_promotion):
            with self.assertRaises(OSError): self.install()
        for path, hashes in originals.items():
            self.assertEqual(installer.file_hashes(path), hashes)

    def test_legacy_installer_lock_blocks_migration(self):
        skills = self.codex / "skills"
        skills.mkdir(parents=True)
        with installer._name_lock(skills, "pm-skill"):
            with self.assertRaisesRegex(installer.InstallError, "another installation"):
                self.install()

    def test_missing_runtime_dependency_refuses_before_replacing_install(self):
        destination, _ = self.install()
        before = installer.file_hashes(destination)
        # Truncate each operational entrypoint/dependency in turn, including
        # watcher, Hook, compatible service and initialization subprocesses.
        for dependency in installer.required_paths(self.source):
            name = dependency.relative_to(self.source).as_posix()
            with self.subTest(name=name):
                original = dependency.read_bytes()
                dependency.unlink()
                try:
                    with self.assertRaises(installer.InstallError):
                        installer.validate_candidate(self.source)
                    self.assertEqual(installer.file_hashes(destination), before)
                finally:
                    dependency.write_bytes(original)

    def test_required_manifest_covers_all_operational_scripts(self):
        # Detect future new entrypoints omitted from the explicit installer
        # manifest; discovery belongs in this test, never in candidate validation.
        operational = {
            candidate.name for candidate in (self.source / 'scripts').iterdir()
            if candidate.suffix in {'.mjs', '.py'}
            and not candidate.name.endswith('.test.mjs')
            and not candidate.name.startswith('test_')
        }
        listed = {path.name for path in installer.required_paths(self.source)
                  if path.parent == self.source / 'scripts'}
        self.assertEqual(listed, operational)

    def test_manifest_rejects_unsafe_duplicate_and_missing_identity_paths(self):
        manifest = self.source / 'runtime-manifest.json'
        original = json.loads(manifest.read_text())
        for invalid in ('../outside.py', '/absolute.py', 'scripts\\outside.py',
                        'scripts/../outside.py', '', './SKILL.md'):
            with self.subTest(invalid=invalid):
                data = dict(original, files=original['files'] + [invalid])
                manifest.write_text(json.dumps(data))
                with self.assertRaises(installer.InstallError):
                    installer.validate_candidate(self.source)
        for files in (original['files'] + ['SKILL.md'],
                      [name for name in original['files'] if name != 'runtime-manifest.json']):
            manifest.write_text(json.dumps(dict(original, files=files)))
            with self.assertRaises(installer.InstallError):
                installer.validate_candidate(self.source)

    def test_manifest_covers_relative_module_imports(self):
        required = {path.resolve() for path in installer.required_paths(self.source)}
        pattern = re.compile(r'''(?:from\s+|import\s*(?:\(\s*)?)["'](\.{1,2}/[^"']+)["']''')
        for module in required:
            if module.suffix not in {'.js', '.mjs'}:
                continue
            for reference in pattern.findall(module.read_text(encoding='utf-8')):
                with self.subTest(module=module.name, reference=reference):
                    self.assertIn((module.parent / reference).resolve(), required)

    def test_manifest_rejects_symlink_escape(self):
        dependency = self.source / 'README.md'
        dependency.unlink()
        outside = self.root / 'outside.md'
        outside.write_text('outside candidate')
        dependency.symlink_to(outside)
        with self.assertRaisesRegex(installer.InstallError, 'escapes candidate'):
            installer.validate_candidate(self.source)

    def test_missing_transitive_asset_dependencies_refuse_install(self):
        for relative in ('assets/task-log.js', 'assets/vendor/js-yaml.min.js',
                         'assets/task-log.js',
                         'assets/task-dashboard.html'):
            with self.subTest(relative=relative):
                dependency = self.source / relative
                original = dependency.read_bytes()
                dependency.unlink()
                try:
                    with self.assertRaises(installer.InstallError):
                        self.install()
                    self.assertFalse((self.codex / 'skills/project-manager').exists())
                finally:
                    dependency.write_bytes(original)

    def test_final_hash_failure_restores_previous_install(self):
        destination, _ = self.install()
        before = installer.file_hashes(destination)
        (self.source / "README.md").write_text("new candidate", encoding="utf-8")
        validate = installer.validate_candidate

        def corrupt_after_promotion(candidate):
            validate(candidate)
            if candidate == destination:
                (candidate / "README.md").write_text("corrupt", encoding="utf-8")

        with mock.patch.object(installer, "validate_candidate", side_effect=corrupt_after_promotion):
            with self.assertRaisesRegex(installer.InstallError, "installed package"):
                self.install()
        self.assertEqual(installer.file_hashes(destination), before)
        failed = list((self.codex / "skill-backups" / "project-manager").glob("failed-install*"))
        self.assertEqual(len(failed), 1)
        self.assertEqual((failed[0] / "README.md").read_text(), "corrupt")

    def test_failed_promotion_restores_previous_install(self):
        destination, _ = self.install()
        before = installer.file_hashes(destination)
        rename = installer.rename_exact

        def fail_stage(source, target):
            if source.parent.name.startswith(".project-manager-stage-"):
                raise OSError("injected rename failure")
            return rename(source, target)

        with mock.patch.object(installer, "rename_exact", side_effect=fail_stage):
            with self.assertRaisesRegex(OSError, "injected"):
                self.install()
        self.assertEqual(installer.file_hashes(destination), before)

    def test_source_changes_during_promotion_rolls_back(self):
        destination, _ = self.install()
        before = installer.file_hashes(destination)
        rename = installer.rename_exact

        def mutate_source_after_promotion(source, target):
            rename(source, target)
            if source.parent.name.startswith(".project-manager-stage-"):
                (self.source / "README.md").write_text("changed in flight", encoding="utf-8")

        with mock.patch.object(installer, "rename_exact", side_effect=mutate_source_after_promotion):
            with self.assertRaisesRegex(installer.InstallError, "changed during installation"):
                self.install()
        self.assertEqual(installer.file_hashes(destination), before)

    def test_exact_rename_rejects_directory_instead_of_nesting(self):
        source = self.root / "from"
        target = self.root / "to"
        source.mkdir()
        target.mkdir()
        with self.assertRaises(installer.InstallError):
            installer.rename_exact(source, target)
        self.assertTrue(source.is_dir())
        self.assertEqual(list(target.iterdir()), [])

    def test_candidate_containing_install_root_is_rejected(self):
        with self.assertRaises(installer.InstallError):
            installer.install_skill(self.source, self.source / "nested-codex")
        self.assertFalse((self.source / "nested-codex").exists())

    def test_competing_process_is_rejected_and_dead_owner_releases_lock(self):
        destination, _ = self.install()
        before = installer.file_hashes(destination)
        code = """
import importlib.util, pathlib, sys
s = importlib.util.spec_from_file_location('installer', sys.argv[1])
m = importlib.util.module_from_spec(s); s.loader.exec_module(m)
with m.installation_lock(pathlib.Path(sys.argv[2])):
    print('LOCKED', flush=True)
    sys.stdin.read()
"""
        child = subprocess.Popen([sys.executable, "-c", code, str(SCRIPT),
                                  str(self.codex / "skills")],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, text=True)
        try:
            self.assertEqual(child.stdout.readline().strip(), "LOCKED")
            with self.assertRaisesRegex(installer.InstallError, "another installation"):
                self.install()
            self.assertEqual(installer.file_hashes(destination), before)
            child.kill()
            child.wait(timeout=5)
            destination, _ = self.install()
            self.assertEqual(installer.file_hashes(destination), installer.file_hashes(self.source))
        finally:
            if child.poll() is None:
                child.kill()
                child.wait(timeout=5)
            child.communicate(timeout=5)


if __name__ == "__main__":
    unittest.main()
