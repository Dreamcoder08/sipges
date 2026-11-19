package pglitewasm

import (
	"context"
	"fmt"

	"github.com/tetratelabs/wazero/api"
)

// installCallbacks mirrors #onRuntimeInitialized: system(), popen() and pclose()
// are refused, and the read/write callbacks connect PostgreSQL's client socket
// to Exchange's buffers.
func (b *Backend) installCallbacks(ctx context.Context) error {
	i := api.ValueTypeI32
	type cb struct {
		name   string
		setter string
		sig    wasmSig
		fn     api.GoFunc
	}
	cbs := []cb{
		{"system", "pgl_set_system_fn", wasmSig{[]api.ValueType{i}, []api.ValueType{i}}, func(_ context.Context, s []uint64) {
			b.appendLog(fmt.Appendf(nil, "pglitewasm: refused system(%q)\n", b.cstr(u32(s[0]))))
			s[0] = 1
		}},
		{"popen", "pgl_set_popen_fn", wasmSig{[]api.ValueType{i, i}, []api.ValueType{i}}, func(_ context.Context, s []uint64) {
			b.appendLog(fmt.Appendf(nil, "pglitewasm: refused popen(%q)\n", b.cstr(u32(s[0]))))
			s[0] = 0
		}},
		{"pclose", "pgl_set_pclose_fn", wasmSig{[]api.ValueType{i}, []api.ValueType{i}}, func(_ context.Context, s []uint64) {
			s[0] = ret(-1)
		}},
		{"read", "", wasmSig{[]api.ValueType{i, i}, []api.ValueType{i}}, func(_ context.Context, s []uint64) {
			n := min(len(b.in)-b.inOff, int(u32(s[1])))
			b.mem.Write(u32(s[0]), b.in[b.inOff:b.inOff+n])
			b.inOff += n
			s[0] = n64(n)
		}},
		{"write", "", wasmSig{[]api.ValueType{i, i}, []api.ValueType{i}}, func(_ context.Context, s []uint64) {
			buf, ok := b.mem.Read(u32(s[0]), u32(s[1]))
			if !ok {
				s[0] = ret(-1)
				return
			}
			b.out.Write(buf)
			s[0] = n64(len(buf))
		}},
	}
	host := b.rt.NewHostModuleBuilder("pglcb")
	names := make([]string, len(cbs))
	sigs := make([]wasmSig, len(cbs))
	for k, c := range cbs {
		host.NewFunctionBuilder().WithGoFunction(c.fn, c.sig.params, c.sig.results).Export(c.name)
		names[k], sigs[k] = c.name, c.sig
	}
	if _, err := host.Instantiate(ctx); err != nil {
		return fmt.Errorf("pglitewasm: callbacks: %w", err)
	}
	tab, err := b.instantiateNamed(ctx, "pgltab", tableModule("pglite", "__indirect_function_table", "pglcb", names, sigs))
	if err != nil {
		return fmt.Errorf("pglitewasm: table helper: %w", err)
	}
	idx := make([]uint64, len(cbs))
	for k := range cbs {
		res, err := tab.ExportedFunction(fmt.Sprintf("add%d", k)).Call(ctx)
		if err != nil {
			return fmt.Errorf("pglitewasm: table grow: %w", err)
		}
		if i32(res[0]) < 0 {
			return fmt.Errorf("pglitewasm: function table cannot grow")
		}
		idx[k] = res[0]
	}
	for k, c := range cbs {
		if c.setter != "" {
			if _, err := b.call(ctx, c.setter, idx[k]); err != nil {
				return fmt.Errorf("pglitewasm: %s: %w", c.setter, err)
			}
		}
	}
	if _, err := b.call(ctx, "pgl_set_rw_cbs", idx[3], idx[4]); err != nil {
		return fmt.Errorf("pglitewasm: pgl_set_rw_cbs: %w", err)
	}
	return nil
}
