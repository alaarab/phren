"""resolve_setting finds a build setting from the same places Xcode does."""
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import release

KEY = "DEVELOPMENT_TEAM"


class ResolveSettingTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        base = Path(self._tmp.name)
        self.checkout = base / "checkout"
        self.main = base / "main"
        self.checkout.mkdir()
        self.main.mkdir()

    @staticmethod
    def write(path: Path, body: str) -> Path:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body, encoding="utf-8")
        return path

    def resolve(self, *, env=None, remote=None):
        return release.resolve_setting(
            KEY, env=env, checkout=self.checkout, main_worktree=self.main,
            remote_settings=lambda: remote or {},
        )

    def test_environment_wins_over_every_file(self):
        self.write(self.checkout / "Config/Local.xcconfig", f"{KEY} = CHECKOUTCFG\n")
        self.write(self.main / "Local.xcconfig", f"{KEY} = MAINCFG\n")
        value, source = self.resolve(env="ENVVALUE", remote={KEY: "REMOTE"})
        self.assertEqual(value, "ENVVALUE")
        self.assertEqual(source, "environment")

    def test_config_file_wins_over_app_root_and_main_worktree(self):
        config = self.write(self.checkout / "Config/Local.xcconfig", f"{KEY} = CHECKOUTCFG\n")
        self.write(self.checkout / "Local.xcconfig", f"{KEY} = APP_ROOT\n")
        self.write(self.main / "Config/Local.xcconfig", f"{KEY} = MAINCFG\n")
        value, source = self.resolve(remote={KEY: "REMOTE"})
        self.assertEqual(value, "CHECKOUTCFG")
        self.assertEqual(source, str(config))

    def test_app_root_file_is_used_when_config_is_absent(self):
        app_root = self.write(self.checkout / "Local.xcconfig", f"{KEY} = APP_ROOT\n")
        self.write(self.main / "Config/Local.xcconfig", f"{KEY} = MAINCFG\n")
        value, source = self.resolve(remote={KEY: "REMOTE"})
        self.assertEqual(value, "APP_ROOT")
        self.assertEqual(source, str(app_root))

    def test_main_worktree_file_is_used_when_checkout_has_none(self):
        main_config = self.write(self.main / "Config/Local.xcconfig", f"{KEY} = MAINCFG\n")
        value, source = self.resolve(remote={KEY: "REMOTE"})
        self.assertEqual(value, "MAINCFG")
        self.assertEqual(source, str(main_config))

    def test_main_worktree_build_settings_are_the_last_resort(self):
        value, source = self.resolve(remote={KEY: "REMOTE"})
        self.assertEqual(value, "REMOTE")
        self.assertEqual(source, f"{self.main} build settings")

    def test_nothing_anywhere_resolves_empty(self):
        value, source = release.resolve_setting(
            KEY, env=None, checkout=self.checkout, main_worktree=None,
            remote_settings=lambda: self.fail("remote settings should not be read"),
        )
        self.assertEqual(value, "")
        self.assertIsNone(source)

    def test_remote_settings_are_not_read_when_a_file_supplies_the_value(self):
        self.write(self.checkout / "Local.xcconfig", f"{KEY} = APP_ROOT\n")
        value, _ = release.resolve_setting(
            KEY, env=None, checkout=self.checkout, main_worktree=self.main,
            remote_settings=lambda: self.fail("remote settings should not be read"),
        )
        self.assertEqual(value, "APP_ROOT")

    def test_same_worktree_does_not_require_remote_settings_for_a_file(self):
        self.write(self.checkout / "Local.xcconfig", f"{KEY} = SAME\n")
        value, source = release.resolve_setting(
            KEY, env=None, checkout=self.checkout, main_worktree=self.checkout,
            remote_settings=lambda: self.fail("remote settings should not be read"),
        )
        self.assertEqual(value, "SAME")
        self.assertEqual(source, str(self.checkout / "Local.xcconfig"))


class FindMainWorktreeTests(unittest.TestCase):
    def test_maps_the_same_subdirectory_onto_the_main_worktree(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            top = base / "worktree"
            checkout = top / "apps" / "ios"
            checkout.mkdir(parents=True)
            main = base / "main"
            main.mkdir()
            listing = (
                f"worktree {main}\nHEAD abc\nbranch refs/heads/main\n\n"
                f"worktree {top}\nHEAD abc\nbranch refs/heads/topic\n"
            )

            def fake_run(command, **kwargs):
                if "--show-toplevel" in command:
                    return subprocess.CompletedProcess(command, 0, stdout=str(top), stderr="")
                return subprocess.CompletedProcess(command, 0, stdout=listing, stderr="")

            with mock.patch.object(release, "root", checkout), \
                    mock.patch.object(release.subprocess, "run", side_effect=fake_run):
                self.assertEqual(release.find_main_worktree(), main / "apps" / "ios")

    def test_not_a_repository_is_none(self):
        def fake_run(command, **kwargs):
            raise subprocess.CalledProcessError(128, command)

        with mock.patch.object(release.subprocess, "run", side_effect=fake_run):
            self.assertIsNone(release.find_main_worktree())


class ReadXcconfigTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.path = Path(self._tmp.name) / "Local.xcconfig"

    def test_reads_a_plain_assignment(self):
        self.path.write_text("DEVELOPMENT_TEAM = LYB298P4U6\n", encoding="utf-8")
        self.assertEqual(release.read_xcconfig(self.path, "DEVELOPMENT_TEAM"), "LYB298P4U6")

    def test_ignores_comments_blank_lines_and_other_keys(self):
        self.path.write_text(
            "// DEVELOPMENT_TEAM = NOPE\n\nOTHER = 1\nDEVELOPMENT_TEAM = REAL // trailing\n",
            encoding="utf-8",
        )
        self.assertEqual(release.read_xcconfig(self.path, "DEVELOPMENT_TEAM"), "REAL")

    def test_empty_value_is_unset(self):
        self.path.write_text("DEVELOPMENT_TEAM =\n", encoding="utf-8")
        self.assertIsNone(release.read_xcconfig(self.path, "DEVELOPMENT_TEAM"))

    def test_missing_file_is_unset(self):
        self.assertIsNone(release.read_xcconfig(self.path, "DEVELOPMENT_TEAM"))


if __name__ == "__main__":
    unittest.main()
