import contextlib
import importlib.util
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[2] / "apps/desktop/resources/assistant/worker.py"
spec = importlib.util.spec_from_file_location("assistant", SOURCE)
assistant = importlib.util.module_from_spec(spec)
spec.loader.exec_module(assistant)


class AssistantTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.root = self.home / ".local/share/putmancode-assistant"
        patches = contextlib.ExitStack()
        self.addCleanup(patches.close)
        patches.enter_context(patch.object(assistant, "ROOT", self.root))
        patches.enter_context(patch.object(assistant, "lingering", return_value=True))
        patches.enter_context(patch.object(assistant, "system", return_value=subprocess.CompletedProcess([], 0)))
        self.db = assistant.database()
        self.addCleanup(self.db.close)

    def send(self, text, notify=False, task_id=None):
        return assistant.request(self.db, {"kind": "send", "id": task_id or str(uuid.uuid4()), "prompt": text, "notify": notify})

    def test_client_exits_and_second_client_reads_finished_research(self):
        fake = self.home / ".local/bin/codex"
        fake.parent.mkdir(parents=True)
        fake.write_text("""#!/usr/bin/env python3
import sys, json, pathlib
args = sys.argv
assert 'read-only' in args and '--ignore-user-config' in args and 'web_search="live"' in args
assert 'features.shell_tool=false' in args
prompt = sys.stdin.read()
assert 'Find remote openings' in prompt
answer = {'status':'done', 'answer':'[Listing](https://example.org/job)'}
pathlib.Path(args[args.index('--output-last-message')+1]).write_text(json.dumps(answer))
""")
        fake.chmod(0o700)
        for name, output in [("systemctl", ""), ("loginctl", "yes")]:
            helper = fake.parent / name
            helper.write_text("#!/bin/sh\necho " + output + "\n")
            helper.chmod(0o700)
        env = dict(os.environ, HOME=str(self.home), PATH=str(fake.parent) + os.pathsep + os.defpath)
        def client(data):
            process = subprocess.run([sys.executable, SOURCE, "request"], input=json.dumps(data),
                                     env=env, capture_output=True, text=True, timeout=10, check=True)
            return json.loads(process.stdout)
        task = {"kind":"send","prompt":"Find remote openings","id":str(uuid.uuid4()),"notify":False}
        self.assertEqual(client(task)["tasks"][0]["status"], "queued")
        self.assertEqual(len(client(task)["tasks"]), 1)
        with subprocess.Popen([sys.executable, SOURCE, "serve"], env=env) as service:
            try:
                until = time.monotonic() + 10
                while time.monotonic() < until:
                    result = client({"kind":"state"})["tasks"][0]
                    if result["status"] == "done": break
                    time.sleep(.2)
                self.assertEqual(result["answer"], "[Listing](https://example.org/job)")
                self.assertEqual(result["delivery"], "off")
            finally:
                service.terminate()
                service.wait(timeout=5)

    def test_phone_opt_in_and_follow_up(self):
        with self.assertRaisesRegex(ValueError, "Connect Android"):
            self.send("sensitive task", True)
        with patch.object(assistant, "push") as send_push:
            assistant.request(self.db, {"kind":"phone","token":"A"*30,"userKey":"U"*30})
            self.send("sensitive task", True)
            self.send("silent task")
            with patch.object(assistant, "run_task", return_value=("needs_input", "Which location?")):
                self.assertTrue(assistant.process_one(self.db))
                self.assertTrue(assistant.process_one(self.db))
            self.assertTrue(assistant.deliver_one(self.db))
            self.assertFalse(assistant.deliver_one(self.db))
            self.assertEqual(send_push.call_count, 2)
            self.assertEqual(send_push.call_args.args[1], "Your assistant has a question.")
            self.assertNotIn("sensitive", send_push.call_args.args[1])
            self.assertEqual(assistant.request(self.db, {"kind":"state"})["tasks"][0]["delivery"], "sent")
            self.send("pending", True)
            assistant.request(self.db, {"kind":"forgetPhone"})
            self.assertFalse(assistant.phone_keys(self.db))
            self.assertEqual(self.db.execute("SELECT delivery FROM tasks ORDER BY seq DESC").fetchone()[0], "off")

    def test_unconfirmed_delivery_retains_answer(self):
        with self.db:
            self.db.execute("INSERT INTO phone VALUES(1,'user','token')")
        self.send("Research", True)
        with patch.object(assistant, "run_task", return_value=("done","Ready")):
            assistant.process_one(self.db)
        with patch.object(assistant, "push", side_effect=OSError):
            assistant.deliver_one(self.db)
        task = assistant.request(self.db, {"kind":"state"})["tasks"][0]
        self.assertEqual((task["answer"],task["delivery"]), ("Ready","failed"))

    def test_pagination_and_dedup(self):
        for n in range(19):
            self.send(str(n))
        page = assistant.request(self.db, {"kind":"state"})
        self.assertTrue(page["older"])
        self.assertEqual(page["tasks"][-1]["prompt"], "18")
        older = assistant.request(self.db, {"kind":"state", "before":page["tasks"][0]["seq"]})
        self.assertFalse(older["older"])
        self.assertEqual([r["prompt"] for r in older["tasks"]], ["0","1","2","3"])


if __name__ == "__main__":
    unittest.main()
