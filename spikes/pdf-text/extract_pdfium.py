#!/usr/bin/env python3
"""PDFium candidate through pypdfium2: FPDFText_GetText per page, CRLF as line ends."""
import json, sys, time
from pathlib import Path
import pypdfium2 as pdfium
corpus, out = sys.argv[1:]
res = {}
for f in sorted(Path(corpus).glob("*.pdf")):
    t = time.time()
    try:
        d = pdfium.PdfDocument(str(f))
        if len(d) > 100:
            res[f.name] = {"outcome": "too_many_pages"}
        else:
            pages = []
            for i in range(len(d)):
                tp = d[i].get_textpage()
                pages.append(tp.get_text_range().replace("\r\n", "\n"))
            res[f.name] = {"outcome": "pages", "pages": pages}
    except Exception as e:
        res[f.name] = {"outcome": "error", "detail": str(e)[:80]}
    res[f.name]["ms"] = round((time.time() - t) * 1000)
json.dump(res, open(out, "w"))
