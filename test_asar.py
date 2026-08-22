import json
import os
import struct
import sys
sys.stdout.reconfigure(encoding="utf-8")


def find_asar():
    install = os.environ.get("LOCALAPPDATA", "")
    for base in (
        os.path.join(install, "Programs", "openmausbot"),
        os.path.join(install, "openmausbot"),
    ):
        p = os.path.join(base, "resources", "app.asar")
        if os.path.isfile(p):
            return p
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.dirname(here)
    backups = os.path.join(root, "backups")
    if os.path.isdir(backups):
        for d2 in sorted(os.listdir(backups)):
            base = os.path.join(backups, d2)
            for sub in ("resources", "Contents", "Resources"):
                p = os.path.join(base, sub, "app.asar")
                if os.path.isfile(p):
                    return p
    return None


asar = sys.argv[1] if len(sys.argv) > 1 else find_asar()
if not asar:
    print("app.asar not found - pass its path as the first argument.", file=sys.stderr)
    sys.exit(1)

with open(asar, "rb") as f:
    f.seek(8)
    pickle_size = struct.unpack("<I", f.read(4))[0]
    str_size = struct.unpack("<I", f.read(4))[0]
    header = json.loads(f.read(str_size).decode("utf-8"))
    base = 16 + ((str_size + 3) // 4) * 4

def walk(node, path="", found=None):
    if found is None:
        found = {}
    for name, info in node.get("files", {}).items():
        p = path + "/" + name
        if "files" in info:
            walk(info, p, found)
        else:
            found[p] = info
    return found

files = walk(header)
print("total files in asar:", len(files))
target = None
for p in files:
    if p.endswith("package.json"):
        target = p
        break
print("package.json path:", target)
if target:
    info = files[target]
    with open(asar, "rb") as f:
        f.seek(base + int(info["offset"]))
        data = f.read(info["size"])
    pkg = json.loads(data.decode("utf-8"))
    print("name:", pkg.get("name"), "| version:", pkg.get("version"))