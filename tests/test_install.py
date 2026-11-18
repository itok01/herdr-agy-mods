import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
INSTALL_SH = REPO_ROOT / "scripts/install.sh"


class InstallScriptTest(unittest.TestCase):
    def _setup_home(self, tmp: str) -> Path:
        home = Path(tmp)
        (home / "layouts").mkdir(parents=True)
        (home / "layouts/main.json").write_text(
            json.dumps(
                {
                    "id": "root",
                    "children": [
                        {"id": "agents", "content": {"mod": "agents"}},
                        {"id": "status", "content": {"mod": "workspace-chrome"}},
                        {"id": "panel-body", "children": []},
                    ],
                }
            ),
            encoding="utf-8",
        )
        return home

    def test_rejects_invalid_layout_names(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            home = self._setup_home(tmp)
            env = {**os.environ, "HERDR_APP_HOME": str(home), "PATH": "/usr/bin:/bin:/usr/local/bin"}
            for bad in ("../../evil", "main", "a/b"):
                proc = subprocess.run(
                    [str(INSTALL_SH), "usage", "--skip-check", "--layout", bad],
                    env=env,
                    capture_output=True,
                    text=True,
                )
                self.assertNotEqual(proc.returncode, 0, f"Expected failure for --layout {bad}")

    def test_incremental_install_preserves_existing_mods_and_uninstalls(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            home = self._setup_home(tmp)
            env = {**os.environ, "HERDR_APP_HOME": str(home), "PATH": "/usr/bin:/bin:/usr/local/bin"}

            subprocess.run([str(INSTALL_SH), "usage", "--skip-check"], env=env, check=True)
            subprocess.run([str(INSTALL_SH), "agy", "--skip-check"], env=env, check=True)

            layout = json.loads((home / "layouts/main-agy.json").read_text("utf-8"))
            self.assertEqual(layout["children"][0]["content"]["mod"], "agents-agy")
            self.assertEqual(layout["children"][1]["content"]["mod"], "workspace-status-agy")
            panel_ids = {c["id"] for c in layout["children"][2]["children"]}
            self.assertEqual(panel_ids, {"agy-inspector", "model-usage"})

            subprocess.run([str(INSTALL_SH), "--uninstall"], env=env, check=True)
            self.assertEqual(list((home / "mods").iterdir()), [])
            self.assertFalse((home / "layouts/main-agy.json").exists())
            self.assertFalse((home / "layouts/main-usage.json").exists())


if __name__ == "__main__":
    unittest.main()
