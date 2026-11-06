# 0033 — PDF text with pdf.js in WebAssembly, OCR through the optional binary

## Status
Accepted (2026-11-05). Applies [0032](0032-go-backend-rust-engines.md) §3 to PDF reading. Records one choice that stays with the owner (Consequences).

## Context
The owner's order: «te autorizo pdf , ocr despues despliguie en cloudfare , despues trafico real en go , retirar typescript». The accept criterion: the same lexical findings as pdf.js on a synthetic corpus; byte-identical text not required.

Measured on 2026-11-05 ([spike](../../spikes/pdf-text/README.md), 51 synthetic files):
- `documentInsights` splits on line ends and sentence ends, so pdf.js's line ends and spaces decide the fragments. Text that reads the same still gives other findings.
- Files with the same findings as pdf.js: pdf.js in QuickJS on wazero 51 (51 with identical text), PDFium 43, Poppler `-raw` 42, Poppler default 35, `pdf-extract` 35, `pdf_oxide` 34, `lopdf` 17.
- `basic` is 1/4 vCPU, 1 GiB and 4 GB of disk ([Cloudflare limits](https://developers.cloudflare.com/containers/platform-details/limits/), read 2026-11-05).
- At 1/4 vCPU and `GOMEMLIMIT=800MiB`: one simple page 1.1 s, 100 dense pages 51 s, an AES-256 file 60 s; peak RSS 298 MiB with an 18 MB file. Node takes 649 ms for those 100 pages on a full core.
- Real `ocrmypdf` through the Go port at 1/4 vCPU on one page at 120 dpi: 24 s and 282 MiB peak (Debian 12 packages, ocrmypdf 14).

## Decision
1. Go reads PDF text with **pdf.js itself**: the serverless build of unpdf 2.1.0, the one the TypeScript API runs, compiled to QuickJS bytecode inside `sipges-pdf-text-wasm` (Rust over `rquickjs-sys`, `wasm32-wasip1`) and run with wazero.
2. `pdf-text.wasm` and `pdfjs.qbc` are generated, embedded in the binary and rebuilt by `engines/build-wasm.sh` with wasi-sdk 27. CI fails when they differ.
3. Every document gets a fresh instance, so nothing of one document reaches the next. The guest has no file, network or subprocess function; memory stops at 224 MiB in QuickJS and 240 MiB in wazero. QuickJS's stack stops at 1 MiB, because wazero's native stack grows with it on the Go heap: at 7 MiB a 3 MiB PDF of nested forms reached 1 GiB.
4. The port stays: `doctext.ReadPDF` answers pages, too many pages, or unreadable. Same 100-page limit, same 30 s limit including the queue, same pool size (at most two), same answers (`no_text` 422, unreadable 422, too many pages 413).
5. QuickJS's interrupt handler enforces the time limit against the monotonic clock, because wazero's interruption costs 3.7 times. The caller stops waiting 2 s later in any case; the slot stays taken until the guest really ends.
6. OCR is a port of `ocrmypdf.ts`, off unless `SIPGES_OCR=ocrmypdf` is set **and** the binary is in `PATH`. Same arguments, private `0600` copy, temporary directory removed, 5 minute limit, 1 MiB of output. It also kills the process group, which ocrmypdf's children would otherwise outlive, and refuses a sidecar that is not a plain file under 32 MiB. These routes extend their write deadline past the server's 120 s, which would otherwise cut an OCR answer with an EOF.
7. `ocrmypdf` and Tesseract are **not** in the image.

## Consequences
- Findings stay those of pdf.js by construction, on real files beyond the corpus too. The remaining gaps are engine details: QuickJS's Unicode tables and libm against V8's. Parity covers the corpus, 28 cases.
- Hostile files only: some that Node reads in under 3 s answer unreadable here, because of the memory limit or the time limit. 20 of the 73 hostile files differ from Node; no file of the corpus does. Forms nested 500 levels match Node; from 2,000 levels Node gives empty text and Go answers unreadable.
- A fourth toolchain piece: wasi-sdk in CI, for C. The bytecode only loads in the build that wrote it, so both files change together.
- **Slower than Node, about 18 times.** On `basic` the 30 s limit reads about 58 dense pages, not 100, and no AES-256 file; those answer 422 unreadable where TypeScript reads them. A long read also takes CPU from every other request on that instance.
- **Owner's choice before real traffic:** accept that limit, move to `standard-1` (1/2 vCPU), or give PDFs a longer limit.
- The first PDF after a start pays about 3 s of wasm compilation at 1/4 vCPU; a start without PDFs pays nothing.
- Adding OCR to the image costs 289 MiB (Debian 12: `ocrmypdf`, `tesseract-ocr-spa`, `--no-install-recommends`) and a base image with Python, instead of distroless. Memory and disk fit `basic`. CPU does not fit long scans: at about 22 s per page, the 5 minute limit ends near 13 pages, with the instance busy meanwhile. Alpine's packages do not work: its Tesseract prints device lines that ocrmypdf 16 rejects (exit 3).
- pdf.js stays as one vendored file, updated by `crates/pdf-text-wasm/js/vendor.mjs`; its Apache-2.0 licence is next to it. Retiring TypeScript does not remove it.

## Alternatives considered
- **PDFium or Poppler in the image.** Fast and small, but they miss the criterion (43 and 42 of 51) and parse hostile files in C++ outside any sandbox. Poppler is GPL.
- **A Rust PDF crate.** Same miss (at most 35 of 51), mostly in line ends and malformed files.
- **`github.com/fastschema/qjs`.** It fails with wazero 1.12, its execution limit is commented out in C, and it mounts a directory.
- **Porting pdf.js's text path to Rust.** Would be fast, but it means parser, fonts, encodings, encryption and recovery, and only the corpus would prove it.
- **`wazero` interruption instead of the interrupt handler.** 3.7 times slower, on a reader that is already slow.
