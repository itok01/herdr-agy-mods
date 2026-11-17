import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]


def extract_py(mod_name: str, var_name: str) -> str:
    txt = (REPO_ROOT / "mods" / mod_name / "main.js").read_text(encoding="utf-8")
    m = re.search(rf"const {re.escape(var_name)} = `([\s\S]*?)`;", txt)
    if not m:
        raise AssertionError(f"{var_name} not found in mods/{mod_name}/main.js")
    raw = m.group(1)
    return raw.replace("\\\\", "\\").replace("\\x24", "$")


class AgyInspectEmbeddedTest(unittest.TestCase):
    def test_py_inspect_reads_swarm_subagents_and_handles_malformed_json(self) -> None:
        py_code = extract_py("agy-inspector", "PY_INSPECT")
        with tempfile.TemporaryDirectory() as tmp:
            brain = Path(tmp) / "brain"
            conv = brain / "11111111-1111-1111-1111-111111111111"
            sg = conv / ".system_generated"
            (sg / "swarm").mkdir(parents=True)
            (sg / "subagents").mkdir(parents=True)
            (sg / "logs").mkdir(parents=True)

            (sg / "swarm/members.json").write_text(
                json.dumps(
                    {
                        "title": "Test Swarm",
                        "members": {
                            "worker": {
                                "role": "worker",
                                "applied_model": "MODEL_TEST",
                                "phase": "waiting",
                                "last_read_seq": 3,
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )
            (sg / "swarm/board.jsonl").write_text(
                json.dumps({"seq": 1, "agent": "coordinator", "text": "hello swarm"}) + "\n",
                encoding="utf-8",
            )
            (sg / "subagents/sub1.json").write_text(
                json.dumps(
                    {
                        "conversationId": "22222222-2222-2222-2222-222222222222",
                        "state": "DONE",
                        "subagentDescriptor": {"role": "Researcher", "typeName": "research"},
                    }
                ),
                encoding="utf-8",
            )
            (sg / "logs/transcript.jsonl").write_text(
                json.dumps({"step_index": 0, "type": "USER_INPUT", "content": "hi"}) + "\n",
                encoding="utf-8",
            )

            # Malformed non-dict JSON in another conversation must not crash the collector
            bad_conv = brain / "33333333-3333-3333-3333-333333333333"
            bad_sg = bad_conv / ".system_generated"
            (bad_sg / "swarm").mkdir(parents=True)
            (bad_sg / "swarm/members.json").write_text("[1, 2, 3]", encoding="utf-8")

            env = {**os.environ, "AGY_BRAIN_ROOT": str(brain)}
            proc = subprocess.run(
                [sys.executable, "-c", py_code, "11111111-1111-1111-1111-111111111111"],
                capture_output=True,
                text=True,
                env=env,
                check=True,
            )
            data = json.loads(proc.stdout)
            self.assertEqual(data["selected"]["swarm_title"], "Test Swarm")
            self.assertEqual(data["selected"]["members"][0]["name"], "worker")
            self.assertEqual(data["selected"]["board"][0]["text"], "hello swarm")
            self.assertEqual(data["selected"]["subagents"][0]["role"], "Researcher")

    def test_py_agy_tree_handles_malformed_json(self) -> None:
        py_code = extract_py("agents-agy", "PY_AGY_TREE")
        with tempfile.TemporaryDirectory() as tmp:
            brain = Path(tmp) / "brain"
            conv = brain / "44444444-4444-4444-4444-444444444444"
            sg = conv / ".system_generated"
            (sg / "swarm").mkdir(parents=True)
            (sg / "swarm/members.json").write_text(
                json.dumps({"title": "Tree Swarm", "members": {"a": {"phase": "working"}}}),
                encoding="utf-8",
            )
            bad = brain / "55555555-5555-5555-5555-555555555555" / ".system_generated" / "swarm"
            bad.mkdir(parents=True)
            (bad / "members.json").write_text("[1]", encoding="utf-8")

            env = {**os.environ, "AGY_BRAIN_ROOT": str(brain)}
            proc = subprocess.run(
                [sys.executable, "-c", py_code],
                capture_output=True,
                text=True,
                env=env,
                check=True,
            )
            rows = json.loads(proc.stdout)
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["kids"][0]["name"], "@a")
            self.assertEqual(rows[0]["kids"][0]["status"], "working")


if __name__ == "__main__":
    unittest.main()
