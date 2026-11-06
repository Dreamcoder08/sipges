#!/usr/bin/env python3
"""pdftotext candidate: <corpus> <out.json> [extra flags, e.g. -raw]."""
import json, subprocess, sys, time
from pathlib import Path
corpus, out, *flags = sys.argv[1:]
res = {}
for f in sorted(Path(corpus).glob("*.pdf")):
    t = time.time()
    info = subprocess.run(["pdfinfo", str(f)], capture_output=True, text=True, errors="replace")
    pages = next((int(l.split()[1]) for l in info.stdout.splitlines() if l.startswith("Pages:")), None)
    if pages is not None and pages > 100:
        res[f.name] = {"outcome": "too_many_pages", "ms": 0}; continue
    p = subprocess.run(["pdftotext", "-enc", "UTF-8", *flags, str(f), "-"], capture_output=True)
    if p.returncode != 0 or pages is None:
        res[f.name] = {"outcome": "error", "detail": p.stderr.decode(errors="replace")[:80]}
    else:
        res[f.name] = {"outcome": "pages", "pages": p.stdout.decode("utf8", "replace").split("\f")[:-1] or [""]}
    res[f.name]["ms"] = round((time.time() - t) * 1000)
json.dump(res, open(out, "w"))
