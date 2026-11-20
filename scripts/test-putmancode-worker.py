import importlib.util
import os
from pathlib import Path
import re
import sqlite3
import tempfile
import unittest

path = Path(__file__).with_name("putmancode-worker.py")
spec = importlib.util.spec_from_file_location("worker", path)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.dbpath = self.root / "test.sqlite"
        self.db = sqlite3.connect(self.dbpath)
        self.addCleanup(self.db.close)
        self.db.row_factory = sqlite3.Row
        source = (path.parents[1] / "apps/server/src/persistence/Migrations/102_CoordinatorTeam.ts").read_text()
        for statement in re.findall(r"sql`(CREATE [^`]+)`",source):
            self.db.execute(statement)
        self.repo = self.root / "project"
        self.repo.mkdir()
        worker.git(self.repo, "init")
        (self.repo / "index.txt").write_text("fixture")
        worker.git(self.repo, "add", ".")
        worker.git(self.repo, "commit", "-m", "synthetic fixture")

    def queue(self, project, job, kind):
        with self.db:
            self.db.execute("""INSERT INTO coordinator_jobs(project_id,id,task,version,base_ref,kind,state,prompt,turns,dollars)
                VALUES(?,?,?,1,'HEAD',?,'queued','test',4,0.5)""",(project,job,job,kind))

    def test_claim_respects_both_project_limits_and_other_projects(self):
        for job,kind in [("one","browser"),("two","browser"),("three","agent"),("four","agent")]:
            self.queue("project",job,kind)
        self.queue("other","independent","browser")
        claims = [worker.claim(self.db,["project","other"])["id"] for _ in range(3)]
        self.assertEqual(claims,["one","three","independent"])
        self.assertIsNone(worker.claim(self.db,["project"]))
        self.db.execute("UPDATE coordinator_jobs SET state='completed' WHERE id='one'")
        self.db.commit()
        self.assertEqual(worker.claim(self.db,["project"])["id"],"two")

    def test_model_allowance_and_isolated_git_output(self):
        self.queue("p","agent","agent")
        row=worker.claim(self.db,["p"])
        work=self.root/"work"
        work.mkdir()
        trusted=self.root/"trusted"
        sha=worker.source_revision(self.repo,"HEAD")
        worker.git(self.root,"clone","--no-local","--no-checkout",str(self.repo),str(trusted))
        worker.git(trusted,"--work-tree="+str(work),"read-tree","--reset","-u",sha)
        self.assertFalse((work/".git").exists())
        key=self.root/"key"
        key.write_text("fixture-key")
        key.chmod(0o600)
        args,env=worker.sandbox_args({"api_key_file":str(key),"agent_image":"example@sha256:"+"a"*64},row,work)
        self.assertEqual(args[args.index("--max-budget-usd")+1],"0.5")
        self.assertEqual(args[args.index("--max-turns")+1],"4")
        self.assertNotIn("fixture-key",args)
        self.assertEqual(env["ANTHROPIC_API_KEY"],"fixture-key")
        (work/"index.txt").write_text("changed")
        branch=worker.return_changes(self.repo,trusted,work,row,sha)
        self.assertEqual(worker.git(self.repo,"show",branch+":index.txt"),"changed")
        self.assertEqual((self.repo/"index.txt").read_text(),"fixture")
        self.assertEqual(worker.bounded_usage(None,4),4)

    @unittest.skipUnless(os.environ.get("PUTMANCODE_TEST_IMAGE"),"requires a local digest-pinned Docker image")
    def test_networkless_browser_job(self):
        self.queue("p","browser","browser")
        row=worker.claim(self.db,["p"])
        config={"repository":str(self.repo),"browser_image":os.environ["PUTMANCODE_TEST_IMAGE"],
                "browser_command":["/bin/sh","-ec","test -f /work/index.txt && test ! -e /work/.git && test ! -S /var/run/docker.sock && test -z \"$ANTHROPIC_API_KEY\" && test ! -e /sys/class/net/eth0 && ! touch /readonly-probe"]}
        worker.execute(self.dbpath,config,row)
        self.assertEqual(self.db.execute("SELECT state FROM coordinator_jobs").fetchone()[0],"completed")


if __name__ == "__main__":
    unittest.main()
