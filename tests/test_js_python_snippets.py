import ast
import json
import re
import shutil
import subprocess
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


class JsPythonSnippetsTest(unittest.TestCase):
    def test_all_embedded_python_snippets_parse_after_js_evaluation(self) -> None:
        node = shutil.which("node")
        if not node:
            self.skipTest("node is required to evaluate JS template literals")

        js_files = sorted((REPO_ROOT / "mods").glob("*/main.js"))
        self.assertGreaterEqual(len(js_files), 1)

        for js_path in js_files:
            txt = js_path.read_text(encoding="utf-8")
            for idx, m in enumerate(re.finditer(r"const (PY_\w+) = `([\s\S]*?)`;", txt)):
                eval_script = (
                    "const fs=require('fs'),vm=require('vm');"
                    f"const t=fs.readFileSync({json.dumps(str(js_path))},'utf8');"
                    r"const ms=[...t.matchAll(/const PY_\w+ = `([\s\S]*?)`;/g)];"
                    f"process.stdout.write(vm.runInNewContext('`' + ms[{idx}][1] + '`'));"
                )
                proc = subprocess.run([node, "-e", eval_script], capture_output=True, text=True, check=True)
                with self.subTest(mod=js_path.parent.name, var=m.group(1)):
                    ast.parse(proc.stdout)


if __name__ == "__main__":
    unittest.main()
