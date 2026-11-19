package pglitewasm

import (
	"github.com/tetratelabs/wazero/api"
)

// Tiny hand-assembled WebAssembly modules that bridge what wazero's host
// modules cannot express: an "env" module that owns the imported linear memory
// and re-exports the Go host functions, and a helper that appends Go callbacks
// to pglite's function table (Emscripten's addFunction).

type wasmSig struct {
	params, results []api.ValueType
}

func (s wasmSig) key() string { return string(s.params) + "/" + string(s.results) }

type wasmBuf []byte

func (b *wasmBuf) u32(v uint32) {
	for {
		c := byte(v & 0x7f)
		v >>= 7
		if v != 0 {
			*b = append(*b, c|0x80)
			continue
		}
		*b = append(*b, c)
		return
	}
}

func (b *wasmBuf) name(s string) { b.u32(n32(len(s))); *b = append(*b, s...) }

func (b *wasmBuf) section(id byte, body wasmBuf) {
	*b = append(*b, id)
	b.u32(n32(len(body)))
	*b = append(*b, body...)
}

func wasmHeader() wasmBuf { return wasmBuf{0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00} }

// typeSection encodes sigs and returns the index of each signature key.
func typeSection(sigs []wasmSig) (wasmBuf, map[string]uint32) {
	idx := map[string]uint32{}
	var uniq []wasmSig
	for _, s := range sigs {
		if _, ok := idx[s.key()]; !ok {
			idx[s.key()] = n32(len(uniq))
			uniq = append(uniq, s)
		}
	}
	var body wasmBuf
	body.u32(n32(len(uniq)))
	for _, s := range uniq {
		body = append(body, 0x60)
		body.u32(n32(len(s.params)))
		body = append(body, s.params...)
		body.u32(n32(len(s.results)))
		body = append(body, s.results...)
	}
	return body, idx
}

// envModule imports every function name from module hostModule and re-exports
// it, and defines the memory pglite.wasm imports as env.memory.
func envModule(hostModule string, names []string, sigs []wasmSig, minPages, maxPages uint32) []byte {
	out := wasmHeader()
	types, idx := typeSection(sigs)
	out.section(1, types)
	var imports wasmBuf
	imports.u32(n32(len(names)))
	for i, n := range names {
		imports.name(hostModule)
		imports.name(n)
		imports = append(imports, 0x00)
		imports.u32(idx[sigs[i].key()])
	}
	out.section(2, imports)
	var mem wasmBuf
	mem.u32(1)
	mem = append(mem, 0x01)
	mem.u32(minPages)
	mem.u32(maxPages)
	out.section(5, mem)
	var exports wasmBuf
	exports.u32(n32(len(names) + 1))
	exports.name("memory")
	exports = append(exports, 0x02)
	exports.u32(0)
	for i, n := range names {
		exports.name(n)
		exports = append(exports, 0x00)
		exports.u32(n32(i))
	}
	out.section(7, exports)
	return out
}

// tableModule imports pglite's function table and the callbacks of cbModule
// and exports add<i>() which appends callback i to the table and returns its index.
func tableModule(tableFrom, tableName, cbModule string, names []string, sigs []wasmSig) []byte {
	out := wasmHeader()
	adder := wasmSig{results: []api.ValueType{api.ValueTypeI32}}
	types, idx := typeSection(append(append([]wasmSig{}, sigs...), adder))
	out.section(1, types)
	var imports wasmBuf
	imports.u32(n32(len(names) + 1))
	imports.name(tableFrom)
	imports.name(tableName)
	imports = append(imports, 0x01, 0x70, 0x00)
	imports.u32(0)
	for i, n := range names {
		imports.name(cbModule)
		imports.name(n)
		imports = append(imports, 0x00)
		imports.u32(idx[sigs[i].key()])
	}
	out.section(2, imports)
	var funcs wasmBuf
	funcs.u32(n32(len(names)))
	for range names {
		funcs.u32(idx[adder.key()])
	}
	out.section(3, funcs)
	var exports wasmBuf
	exports.u32(n32(len(names)))
	for i := range names {
		exports.name("add" + string(rune('0'+i)))
		exports = append(exports, 0x00)
		exports.u32(n32(len(names) + i))
	}
	out.section(7, exports)
	// Declarative element segment so ref.func may name the imported callbacks.
	var elems wasmBuf
	elems.u32(1)
	elems = append(elems, 0x03, 0x00)
	elems.u32(n32(len(names)))
	for i := range names {
		elems.u32(n32(i))
	}
	out.section(9, elems)
	var code wasmBuf
	code.u32(n32(len(names)))
	for i := range names {
		var body wasmBuf
		body = append(body, 0x00, 0xd2)
		body.u32(n32(i))
		body = append(body, 0x41, 0x01, 0xfc)
		body.u32(15)
		body = append(body, 0x00, 0x0b)
		code.u32(n32(len(body)))
		code = append(code, body...)
	}
	out.section(10, code)
	return out
}
