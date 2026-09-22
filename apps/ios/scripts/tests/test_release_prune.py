"""prune_archives keeps only the newest archives under a given root."""
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import release


class PruneArchivesTests(unittest.TestCase):
    @staticmethod
    def make_archive(root: Path, name: str, mtime: float) -> Path:
        path = root / name
        path.mkdir(parents=True)
        os.utime(path, (mtime, mtime))
        return path

    def test_prunes_everything_older_than_the_newest_three(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for index in range(1, 6):
                self.make_archive(root, f"build-{index}", mtime=float(index))
            removed = release.prune_archives(root)
            self.assertEqual(sorted(p.name for p in removed), ["build-1", "build-2"])
            self.assertEqual(sorted(p.name for p in root.iterdir()), ["build-3", "build-4", "build-5"])

    def test_keeps_everything_when_three_or_fewer(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for index in range(1, 4):
                self.make_archive(root, f"build-{index}", mtime=float(index))
            self.assertEqual(release.prune_archives(root), [])
            self.assertEqual(sorted(p.name for p in root.iterdir()), ["build-1", "build-2", "build-3"])

    def test_missing_root_prunes_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            missing = Path(tmp) / "never-created"
            self.assertEqual(release.prune_archives(missing), [])

    def test_files_are_left_alone(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            note = root / "notes.txt"
            note.write_text("keep\n", encoding="utf-8")
            for index in range(1, 5):
                self.make_archive(root, f"build-{index}", mtime=float(index))
            release.prune_archives(root)
            self.assertTrue(note.exists())
            self.assertEqual(
                sorted(p.name for p in root.iterdir() if p.is_dir()),
                ["build-2", "build-3", "build-4"],
            )


if __name__ == "__main__":
    unittest.main()
