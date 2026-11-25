import runpy
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch


snapshot = runpy.run_path(str(Path(__file__).resolve().parents[1] / "backup-putmancode-mac.command"))["snapshot"]


class MacProfileBackupTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.base = Path(tmp.name).resolve() / "home"
        self.userdata = self.base / "userdata"
        self.userdata.mkdir(parents=True)
        self.database = self.userdata / "statev2.sqlite"
        self.support = Path(tmp.name) / "Application Support"

    def create_database(self):
        db = sqlite3.connect(self.database)
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("CREATE TABLE messages (body TEXT)")
        db.execute("INSERT INTO messages VALUES ('saved message')")
        db.commit()
        return db

    def test_closed_read_only_wal_database_needs_no_source_sidecars(self):
        with closing(self.create_database()) as db:
            self.assertEqual(db.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone(), (0, 0, 0))
        # Apple's SQLite can retain empty sidecars on close. Recreate the
        # checkpointed, single-file profile that exposed the original failure.
        for suffix in ("-wal", "-shm"):
            Path(str(self.database) + suffix).unlink(missing_ok=True)
        connect = sqlite3.connect
        self.assertEqual(list(self.userdata.iterdir()), [self.database])

        def connect_inside_copy(path, *args, **kwargs):
            self.assertTrue(Path(path).is_relative_to(self.base / "backups"), path)
            return connect(path, *args, **kwargs)

        self.userdata.chmod(0o500)
        self.addCleanup(self.userdata.chmod, 0o700)
        self.database.chmod(0o400)
        with patch.object(sqlite3, "connect", side_effect=connect_inside_copy):
            saved = snapshot(self.base, self.support)
        with closing(connect((saved / "userdata" / self.database.name).as_uri() + "?immutable=1", uri=True)) as db:
            self.assertEqual(db.execute("SELECT * FROM messages").fetchall(), [("saved message",)])
        self.assertEqual(list(self.userdata.iterdir()), [self.database])

    def test_live_wal_is_included_in_standalone_database(self):
        with closing(self.create_database()) as db:
            self.assertGreater(self.database.with_suffix(".sqlite-wal").stat().st_size, 32)
            db.execute("INSERT INTO messages VALUES ('uncommitted')")
            saved = snapshot(self.base, self.support) / "userdata"
            self.assertEqual(list(saved.iterdir()), [saved / self.database.name])
            with closing(sqlite3.connect((saved / self.database.name).as_uri() + "?immutable=1", uri=True)) as restored:
                self.assertEqual(restored.execute("SELECT * FROM messages").fetchall(), [("saved message",)])
                self.assertEqual(restored.execute("PRAGMA integrity_check").fetchone(), ("ok",))

    def test_profile_change_discards_incomplete_snapshot(self):
        self.create_database().close()
        settings = self.userdata / "settings.json"
        settings.write_text("{}")
        copyfile = snapshot.__globals__["shutil"].copyfile

        def copy_then_change(source, destination, **kwargs):
            result = copyfile(source, destination, **kwargs)
            if Path(source) == self.database:
                settings.write_text('{"updated":true}')
            return result

        with patch("shutil.copyfile", side_effect=copy_then_change):
            with self.assertRaisesRegex(RuntimeError, "changed during the backup"):
                snapshot(self.base, self.support)
        self.assertEqual(list((self.base / "backups").iterdir()), [])


if __name__ == "__main__":
    unittest.main()
