# Spike: PDF text without the TypeScript API (T57)

Which extractor gives the same lexical findings as pdf.js? The accept criterion was the same
findings on the corpus; identical text was not required. Result: only pdf.js itself does, and it can
run inside wazero. Decision in [ADR 0033](../../docs/adr/0033-pdf-text-in-wasm.md).

## Why findings need more than text

`documentInsights` splits on `\n` and on sentence ends, so where the extractor puts line ends and spaces
decides the fragments. Order, hyphenation and spaced-out letters change which words match at all.

## Results

51 synthetic files: tagged, scanned, multi-column, tables, Spanish accents, rotated, encrypted, malformed,
large, each through several producers (reportlab, Chromium, Ghostscript, Cairo, qpdf). A file passes when the
outcome class (text, no text, too many pages, unreadable) and every finding match pdf.js 5 from unpdf 2.1.0.

| Candidate | Files with same findings | Same text | Peak RSS, large files | Added to the image | Licence | Untrusted input |
| --- | --- | --- | --- | --- | --- | --- |
| **pdf.js in QuickJS, Rust wasm on wazero** | **51/51** | 51 | 298 MiB | 6 MiB (about 2 MiB gzip) | Apache-2.0, MIT | Sandboxed: no files, no network, capped memory, trap is an error |
| PDFium through pypdfium2 | 43/51 | 42 | 44 MiB | 8 MiB `.so` and glibc base | Apache-2.0, BSD-3 | C++ in process, needs a subprocess jail |
| Poppler `pdftotext -raw` | 42/51 | 41 | 16 MiB | about 27 MiB of libraries and glibc or musl base | GPL-2.0+ | C++, subprocess |
| Poppler default layout | 35/51 | 8 | 16 MiB | same | GPL-2.0+ | same |
| `pdf-extract` 0.12.1 | 35/51 | 9 | 58 MiB | not built for wasm | MIT | Safe Rust |
| `pdf_oxide` 0.3.78 | 34/51 | 14 | 103 MiB | not built for wasm | MIT or Apache-2.0 | Safe Rust; took 10 min to build |
| `lopdf` 0.40.0 | 17/51 | 7 | 41 MiB | not built for wasm | MIT | Safe Rust |

The closest native candidates miss on letter-spaced text (no findings in pdf.js, ten elsewhere), hyphenated
breaks, inline style changes, tables, and malformed files they read while pdf.js refuses them. The exact list is
in [results/differences.txt](results/differences.txt).

## Cost of the chosen one

Measured with `docker run --cpus=0.25 --memory=1g`, `GOMEMLIMIT=800MiB`, the `basic` instance's shape.

| File | pdf.js on Node, full core | Wasm, full core | Wasm, 1/4 vCPU |
| --- | --- | --- | --- |
| 1 page, base font | 167 ms | 306 ms | 1.1 s |
| 2 pages, Chromium, embedded font | 54 ms | 1.1 s | 3.6 s |
| 100 dense pages | 649 ms | 11.8 s | 51 s |
| 18 MB image plus text | 63 ms | 595 ms | 2.0 s |
| AES-256, owner password only | 88 ms | 14.1 s | 60 s |

- About 18 times slower than V8, because it is an interpreter inside wasm. With the 30 s limit, `basic` reads about
  58 dense pages, not 100, and no AES-256 file. Both answer 422 unreadable there. Node on the same quarter vCPU
  would read them.
- The first PDF after a start also pays about 3 s of wasm compilation at 1/4 vCPU.
- wazero's context interruption costs 3.7 times, so the time limit is QuickJS's interrupt handler against the
  monotonic clock. It stopped the 100-page read at 30.1 s.

## Dead ends

- `github.com/fastschema/qjs`: right idea, but it fails with wazero 1.12 (`signature mismatch` on its host
  import), its `MaxExecutionTime` is commented out in C, and it mounts a directory. Replaced with
  `rquickjs-sys` and a thin crate.
- `structuredClone` as identity saves 4% and loses text: pdf.js reuses the object it posts. The corpus caught it.

## Reproduce

    python -m venv venv && venv/bin/pip install reportlab==5.1.0 pikepdf==10.17.0 pypdfium2==5.14.0
    venv/bin/python gen_corpus.py corpus
    node extract_pdfjs.mjs corpus pdfjs.json      # next to unpdf 2.1.0
    python3 extract_poppler.py corpus raw.json -raw
    node compare.ts pdfjs.json raw.json
