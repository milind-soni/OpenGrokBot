import json
import os
import re
import sys
sys.stdout.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
zh = json.load(open(os.path.join(ROOT, "locales", "zh-CN.json"), encoding="utf-8"))
d = [k for k in zh if not k.startswith("_")]


def find_bundle():
    candidates = []
    backups = os.path.join(ROOT, "backups")
    if os.path.isdir(backups):
        for d2 in sorted(os.listdir(backups)):
            base = os.path.join(backups, d2)
            for sub in ("resources/ui/assets", "ui/assets"):
                p = os.path.join(base, sub)
                if os.path.isdir(p):
                    for f in sorted(os.listdir(p)):
                        if f.endswith(".js"):
                            candidates.append(os.path.join(p, f))
    install = os.environ.get("LOCALAPPDATA", "")
    for root2 in (
        os.path.join(install, "Programs", "openmausbot"),
        os.path.join(install, "openmausbot"),
    ):
        p = os.path.join(root2, "resources", "ui", "assets")
        if os.path.isdir(p):
            for f in sorted(os.listdir(p)):
                if f.endswith(".js"):
                    candidates.append(os.path.join(p, f))
    return candidates[0] if candidates else None


bundle_path = find_bundle()
if not bundle_path:
    print("UI bundle not found - run hanhua.py first to create a backup.", file=sys.stderr)
    sys.exit(1)
c = open(bundle_path, encoding="utf-8").read()

danger = []
for k in d:
    e = re.escape(k)
    if re.search(r'case"' + e + r'"\s*:', c):
        danger.append(("case", k))
    if re.search(r'==="' + e + r'"|!=="' + e + r'"', c):
        danger.append(("compare", k))
    if re.search(r'\.(?:includes|indexOf|has|get|getAttribute|setAttribute)\(\s*"' + e + r'"', c):
        danger.append(("lookup", k))
    if re.search(r'\[\s*"' + e + r'"\s*\]', c):
        danger.append(("bracket-key", k))

print("remaining dangerous keys:", len(danger))
for kind, k in danger:
    print("   ", kind, repr(k))