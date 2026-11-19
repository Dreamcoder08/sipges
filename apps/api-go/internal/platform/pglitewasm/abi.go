package pglitewasm

import "math"

// Conversions between Go integers and wasm32 values. WebAssembly passes every
// i32 as raw bits, so these reinterpret two's complement on purpose; sizes and
// offsets handed to the guest are bounded by its 2 GiB linear memory.

func i32(v uint64) int32   { return int32(uint32(v)) }  //nolint:gosec // wasm i32 bits.
func u32(v uint64) uint32  { return uint32(v) }         //nolint:gosec // wasm i32 bits.
func i64(v uint64) int64   { return int64(v) }          //nolint:gosec // wasm i64 bits.
func ret(v int32) uint64   { return uint64(uint32(v)) } //nolint:gosec // wasm i32 bits.
func neg(e errno) uint64   { return ret(-int32(e)) }
func wasi(e errno) uint64  { return ret(int32(e)) }
func s32(v uint32) int32   { return int32(v) }  //nolint:gosec // wasm i32 bits.
func w32(v int32) uint32   { return uint32(v) } //nolint:gosec // wasm i32 bits.
func w64(v int64) uint64   { return uint64(v) } //nolint:gosec // wasm i64 bits.
func n32(v int) uint32     { return uint32(v) } //nolint:gosec // bounded by guest memory.
func n64(v int) uint64     { return uint64(v) } //nolint:gosec // non-negative length.
func ni32(v int) int32     { return int32(v) }  //nolint:gosec // bounded by guest memory.
func f64(v float64) uint64 { return math.Float64bits(v) }
