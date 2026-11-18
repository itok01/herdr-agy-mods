import json
import os
import re
import subprocess
import sys
import tempfile
import time
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


class ModelUsageEmbeddedTest(unittest.TestCase):
    def test_py_usage_reads_3level_codex_and_deduplicates_claude_messages(self) -> None:
        py_code = extract_py("model-usage", "PY_USAGE")
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            codex_day = root / ".codex/sessions/2026/11/17"
            codex_day.mkdir(parents=True)
            future_rst = int(time.time()) + 3600
            (codex_day / "s1.jsonl").write_text(
                "\n".join(
                    [
                        json.dumps(
                            {
                                "payload": {
                                    "info": {
                                        "total_token_usage": {
                                            "input_tokens": 100,
                                            "cached_input_tokens": 20,
                                            "output_tokens": 30,
                                            "total_tokens": 150,
                                        }
                                    },
                                    "rate_limits": {
                                        "plan_type": "plus",
                                        "primary": {"used_percent": 25.0, "window_minutes": 300, "resets_at": future_rst},
                                        "secondary": {"used_percent": None, "window_minutes": 10080},
                                    },
                                }
                            }
                        )
                    ]
                )
                + "\n",
                encoding="utf-8",
            )

            claude_proj = root / ".claude/projects/demo"
            claude_proj.mkdir(parents=True)
            # Duplicate message.id should be deduplicated (keep max 150, not 100 + 150)
            (claude_proj / "c1.jsonl").write_text(
                "\n".join(
                    [
                        json.dumps({"message": {"id": "msg_1", "usage": {"input_tokens": 100, "output_tokens": 10}}}),
                        json.dumps({"message": {"id": "msg_1", "usage": {"input_tokens": 140, "output_tokens": 10}}}),
                    ]
                )
                + "\n",
                encoding="utf-8",
            )

            env = {**os.environ, "HERDR_USAGE_HOME": str(root), "HERDR_CLAUDE_OAUTH_QUOTA": "0"}
            proc = subprocess.run(
                [sys.executable, "-c", py_code, "--no-oauth"],
                capture_output=True,
                text=True,
                env=env,
                check=True,
            )
            data = json.loads(proc.stdout)
            self.assertEqual(data["codex"]["plan_type"], "plus")
            self.assertEqual(len(data["codex"]["rate_limits"]), 1)
            self.assertEqual(data["codex"]["rate_limits"][0]["remaining_percent"], 75.0)
            self.assertFalse(data["codex"]["rate_limits"][0]["stale"])
            self.assertEqual(data["claude"]["profiles"]["default"]["tokens_24h"], 150)

    def test_py_status_bar_handles_null_and_expired_codex_limits(self) -> None:
        py_code = extract_py("workspace-status-agy", "PY_STATUS_BAR")
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            codex_day = root / ".codex/sessions/2026/11/17"
            codex_day.mkdir(parents=True)
            past_rst = int(time.time()) - 600
            (codex_day / "s1.jsonl").write_text(
                json.dumps(
                    {
                        "payload": {
                            "rate_limits": {
                                "primary": {"used_percent": None, "window_minutes": 300},
                                "secondary": {"used_percent": 40.0, "window_minutes": 10080, "resets_at": past_rst},
                            }
                        }
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            env = {**os.environ, "HERDR_USAGE_HOME": str(root), "HERDR_CLAUDE_OAUTH_QUOTA": "0"}
            proc = subprocess.run(
                [sys.executable, "-c", py_code, "--no-oauth"],
                capture_output=True,
                text=True,
                env=env,
                check=True,
            )
            data = json.loads(proc.stdout)
            self.assertEqual(data["codex_rem"], 60)
            self.assertEqual(data["codex_win"], "7d")
            self.assertTrue(data["codex_stale"])

    def test_py_usage_handles_iso_resets_at_and_shared_cache_epoch(self) -> None:
        py_code = extract_py("model-usage", "PY_USAGE")
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            codex_day = root / ".codex/sessions/2026/11/17"
            codex_day.mkdir(parents=True)
            (codex_day / "s1.jsonl").write_text(
                json.dumps(
                    {
                        "payload": {
                            "rate_limits": {
                                "plan_type": "plus",
                                "primary": {"used_percent": 10.0, "window_minutes": 300, "resets_at": "2099-01-01T00:00:00Z"},
                            }
                        }
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            cdir = root / ".claude"
            cdir.mkdir(parents=True)
            import hashlib
            cache_dir = root / ".cache/herdr"
            cache_dir.mkdir(parents=True)
            cache_p = cache_dir / f"claude-limits-{hashlib.sha256(str(cdir).encode()).hexdigest()[:8]}.json"
            cache_p.write_text(
                json.dumps([{"label": "5h", "used_percent": 20.0, "remaining_percent": 80.0, "resets_at": time.time() + 3600}]),
                encoding="utf-8",
            )

            env = {**os.environ, "HERDR_USAGE_HOME": str(root)}
            proc = subprocess.run(
                [sys.executable, "-c", py_code],
                capture_output=True,
                text=True,
                env=env,
                check=True,
            )
            data = json.loads(proc.stdout)
            self.assertEqual(data["codex"]["rate_limits"][0]["remaining_percent"], 90.0)
            self.assertNotEqual(data["codex"]["rate_limits"][0]["reset_in"], "-")
            c_limits = data["claude"]["profiles"]["default"]["rate_limits"]
            self.assertEqual(len(c_limits), 1)
            self.assertNotEqual(c_limits[0]["reset_in"], "-")


if __name__ == "__main__":
    unittest.main()
