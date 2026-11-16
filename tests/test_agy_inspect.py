import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "bin"))
import agy_inspect  # noqa: E402


class AgyInspectTest(unittest.TestCase):
    def test_collect_reads_swarm_and_subagents(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            brain = Path(tmp)
            sg = brain / "conv-123" / ".system_generated"
            (sg / "swarm").mkdir(parents=True)
            (sg / "subagents").mkdir(parents=True)
            (sg / "logs").mkdir(parents=True)

            (sg / "swarm" / "swarm.json").write_text(
                json.dumps({"version": 1, "backend": "local"}), encoding="utf-8"
            )
            (sg / "swarm" / "members.json").write_text(
                json.dumps(
                    {
                        "title": "Test Swarm",
                        "members": {
                            "carbon": {
                                "conversation_id": "sub-1",
                                "role": "worker",
                                "applied_model": "gemini-4-carbon-high",
                                "phase": "RUNNING",
                                "wake_mode": "working",
                                "last_read_seq": 2,
                                "killed": False,
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )
            (sg / "swarm" / "board.jsonl").write_text(
                json.dumps({"seq": 1, "agent": "coordinator", "text": "hello"}) + "\n",
                encoding="utf-8",
            )
            (sg / "subagents" / "sub-a.json").write_text(
                json.dumps(
                    {
                        "conversationId": "sub-a",
                        "subagentDescriptor": {"typeName": "research", "role": "Investigator"},
                        "state": "DONE",
                        "spawnStepIndex": 4,
                    }
                ),
                encoding="utf-8",
            )
            (sg / "logs" / "transcript.jsonl").write_text(
                json.dumps(
                    {
                        "step_index": 1,
                        "type": "PLANNER_RESPONSE",
                        "status": "DONE",
                        "tool_calls": [{"name": "read_file"}],
                        "content": "checked",
                    }
                )
                + "\n",
                encoding="utf-8",
            )

            res = agy_inspect.collect(brain)
            self.assertEqual(len(res["conversations"]), 1)
            sel = res["selected"]
            self.assertIsNotNone(sel)
            self.assertEqual(sel["swarm_title"], "Test Swarm")
            self.assertEqual(sel["members"][0]["name"], "carbon")
            self.assertEqual(sel["board"][0]["seq"], 1)
            self.assertEqual(sel["subagents"][0]["role"], "Investigator")
            self.assertEqual(sel["recent_steps"][0]["tools"], ["read_file"])


if __name__ == "__main__":
    unittest.main()
