import json
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "bin"))
import model_usage  # noqa: E402


class ModelUsageTest(unittest.TestCase):
    def test_collect_usage_reads_codex_rate_limits_and_agy(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            (home / ".gemini" / "antigravity-cli" / "presence").mkdir(parents=True)
            (home / ".gemini" / "antigravity-cli" / "brain" / "c1" / ".system_generated" / "logs").mkdir(parents=True)
            (home / ".gemini" / "antigravity-cli" / "presence" / "c1.lock").write_text("", encoding="utf-8")
            (home / ".gemini" / "antigravity-cli" / "brain" / "c1" / ".system_generated" / "logs" / "transcript.jsonl").write_text(
                "{}\n", encoding="utf-8"
            )
            (home / ".gemini" / "antigravity-cli" / "settings.json").write_text(
                json.dumps({"defaultModel": "gemini-4-hydrogen-medium"}), encoding="utf-8"
            )

            (home / ".codex" / "sessions" / "2026").mkdir(parents=True)
            now = time.time()
            event = {
                "type": "event_msg",
                "payload": {
                    "type": "token_count",
                    "info": {
                        "total_token_usage": {
                            "input_tokens": 1000,
                            "cached_input_tokens": 500,
                            "output_tokens": 200,
                            "reasoning_output_tokens": 50,
                            "total_tokens": 1200,
                        }
                    },
                    "rate_limits": {
                        "plan_type": "prolite",
                        "primary": {"used_percent": 25.0, "window_minutes": 10080, "resets_at": now + 3600},
                        "secondary": None,
                    },
                },
            }
            (home / ".codex" / "sessions" / "2026" / "s1.jsonl").write_text(
                json.dumps(event) + "\n", encoding="utf-8"
            )
            (home / ".claude" / "projects" / "p1").mkdir(parents=True)
            (home / ".claude" / "projects" / "p1" / "chat.jsonl").write_text("{}\n", encoding="utf-8")

            with patch.object(
                model_usage,
                "collect_hc_agents",
                return_value=[{"address": "t1", "agent": "codex", "status": "working", "turn": 5}],
            ):
                res = model_usage.collect_usage(home=home, now=now)

            self.assertEqual(res["codex"]["plan_type"], "prolite")
            self.assertEqual(res["codex"]["rate_limits"][0]["remaining_percent"], 75.0)
            self.assertEqual(res["codex"]["tokens"]["total"], 1200)
            self.assertEqual(res["agy"]["active_locks"], 1)
            self.assertEqual(res["agy"]["recent_24h_convs"], 1)
            self.assertEqual(res["claude"]["recent_24h_sessions"], 1)
            self.assertEqual(res["agent_summary"]["codex"]["working"], 1)


if __name__ == "__main__":
    unittest.main()
