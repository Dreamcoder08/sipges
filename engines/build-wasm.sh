#!/usr/bin/env sh
# Builds the two WebAssembly modules the Go API embeds (apps/api-go/internal/platform/engines/wasm)
# reproducibly: the toolchain is pinned in rust-toolchain.toml and every machine-specific path
# (the cargo home, this workspace, the Rust sysroot) is remapped, so the same sources give the same
# bytes on any machine. CI rebuilds them and fails when the committed files differ (rust.yml).
#
#   engines/build-wasm.sh          # rebuild and copy into apps/api-go
set -eu

cd "$(dirname "$0")"
engines=$(pwd)
cargo_home=${CARGO_HOME:-$HOME/.cargo}
sysroot=$(rustc --print sysroot)
out=$engines/../apps/api-go/internal/platform/engines/wasm
target=$engines/target/reproducible

RUSTFLAGS="--remap-path-prefix=$cargo_home=/cargo --remap-path-prefix=$engines=/engines --remap-path-prefix=$sysroot=/rust" \
  cargo build --locked --release --target wasm32-wasip1 --target-dir "$target" \
  -p sipges-indicators-wasm -p sipges-analytics-wasm

mkdir -p "$out"
cp "$target/wasm32-wasip1/release/sipges_indicators_wasm.wasm" "$out/indicators.wasm"
cp "$target/wasm32-wasip1/release/sipges_analytics_wasm.wasm" "$out/analytics.wasm"
sha256sum "$out/indicators.wasm" "$out/analytics.wasm" 2>/dev/null || shasum -a 256 "$out/indicators.wasm" "$out/analytics.wasm"
