#!/usr/bin/env sh
# Builds the WebAssembly modules the Go API embeds (apps/api-go/internal/platform/engines/wasm)
# reproducibly: the toolchain is pinned in rust-toolchain.toml and every machine-specific path
# (the cargo home, this workspace, the Rust sysroot) is remapped, so the same sources give the same
# bytes on any machine. CI rebuilds them and fails when the committed files differ (rust.yml).
#
# The PDF reader's QuickJS is C, so it needs wasi-sdk: WASI_SDK must point to version 27.
#
#   WASI_SDK=/opt/wasi-sdk engines/build-wasm.sh          # rebuild and copy into apps/api-go
set -eu

: "${WASI_SDK:?WASI_SDK must point to wasi-sdk 27}"

cd "$(dirname "$0")"
engines=$(pwd)
cargo_home=${CARGO_HOME:-$HOME/.cargo}
sysroot=$(rustc --print sysroot)
out=$engines/../apps/api-go/internal/platform/engines/wasm
target=$engines/target/reproducible

# rquickjs-sys sets CFLAGS itself; this variable wins, and also removes the machine's paths from C.
CFLAGS_wasm32_wasip1="--sysroot=$WASI_SDK/share/wasi-sysroot -ffile-prefix-map=$target=/target -ffile-prefix-map=$WASI_SDK=/wasi-sdk -ffile-prefix-map=$cargo_home=/cargo"
export CFLAGS_wasm32_wasip1 WASI_SDK

RUSTFLAGS="--remap-path-prefix=$cargo_home=/cargo --remap-path-prefix=$engines=/engines --remap-path-prefix=$sysroot=/rust" \
  cargo build --locked --release --target wasm32-wasip1 --target-dir "$target" \
  -p sipges-indicators-wasm -p sipges-analytics-wasm -p sipges-pdf-text-wasm

mkdir -p "$out"
cp "$target/wasm32-wasip1/release/sipges_indicators_wasm.wasm" "$out/indicators.wasm"
cp "$target/wasm32-wasip1/release/sipges_analytics_wasm.wasm" "$out/analytics.wasm"
cp "$target/wasm32-wasip1/release/sipges_pdf_text_wasm.wasm" "$out/pdf-text.wasm"
chmod 0644 "$out/indicators.wasm" "$out/analytics.wasm" "$out/pdf-text.wasm"
(cd go && go run ./cmd/pdf-bytecode "$out/pdf-text.wasm" ../crates/pdf-text-wasm/js "$out/pdfjs.qbc")
chmod 0644 "$out/pdfjs.qbc"
sha256sum "$out"/*.wasm "$out/pdfjs.qbc" 2>/dev/null || shasum -a 256 "$out"/*.wasm "$out/pdfjs.qbc"
