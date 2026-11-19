package pglitewasm

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"sync"
	"time"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"
)

// Paths and start parameters of @electric-sql/pglite 0.5.15 (src/initdb.ts, src/pglite.ts).
const (
	pgRoot       = "/pglite"
	pgData       = pgRoot + "/data"
	postgresExe  = pgRoot + "/bin/postgres"
	icuDataPath  = pgRoot + "/icu"
	exitAlive    = 99  // PGLITE_EXIT_ALIVE: callMain's result once single mode is up.
	mainLongJump = 100 // POSTGRES_MAIN_LONGJMP: an ereport(ERROR) unwound to the main loop.
	maxLogBytes  = 1 << 20
	maxHeapBytes = 1 << 31
	wasmPageSize = 1 << 16
	maxPages     = maxHeapBytes / wasmPageSize
)

var defaultStartParams = []string{
	"--single", "-F", "-O", "-j",
	"-c", "search_path=public",
	"-c", "exit_on_error=false",
	"-c", "log_checkpoints=false",
	"-c", "max_worker_processes=0",
	"-c", "max_parallel_workers=0",
	"-c", "max_parallel_workers_per_gather=0",
	"-c", "io_method=sync",
	"-c", "max_parallel_maintenance_workers=0",
}

// Backend is one PGlite backend running in wazero over a host data folder.
// It is not safe for concurrent use; calls are serialised by a mutex.
type Backend struct {
	mu      sync.Mutex
	rt      wazero.Runtime
	mod     api.Module
	mem     api.Memory
	fs      *vfs
	exports map[string]api.Function
	start   time.Time
	tempRet uint32

	log bytes.Buffer

	in    []byte // bytes PostgreSQL reads from its "socket"
	inOff int
	out   bytes.Buffer // bytes PostgreSQL wrote to its "socket"

	dlopens []string
}

// Open boots pglite.wasm from wasmDir (the pinned @electric-sql/pglite 0.5.15
// dist folder) over dataDir, which must be a scratch copy: PostgreSQL writes to it.
func Open(ctx context.Context, wasmDir, dataDir string) (_ *Backend, err error) {
	d, err := loadDist(wasmDir)
	if err != nil {
		return nil, err
	}
	if fi, err := os.Stat(dataDir); err != nil || !fi.IsDir() {
		return nil, fmt.Errorf("pglitewasm: data folder %s: not a directory", dataDir)
	}
	b := &Backend{exports: map[string]api.Function{}, start: time.Now()}
	b.fs = newVFS(d, pgData, dataDir, b.appendLog, b.appendLog)
	b.rt = wazero.NewRuntimeWithConfig(ctx, wazero.NewRuntimeConfig().WithCoreFeatures(api.CoreFeaturesV2))
	defer func() {
		if err != nil {
			_ = b.rt.Close(ctx)
		}
	}()
	compiled, err := b.rt.CompileModule(ctx, d.wasm)
	if err != nil {
		return nil, fmt.Errorf("pglitewasm: compile: %w", err)
	}
	if err := b.instantiateImports(ctx, compiled); err != nil {
		return nil, err
	}
	b.mod, err = b.rt.InstantiateModule(ctx, compiled, wazero.NewModuleConfig().WithName("pglite").WithStartFunctions())
	if err != nil {
		return nil, fmt.Errorf("pglitewasm: instantiate: %w", err)
	}
	for name := range b.mod.ExportedFunctionDefinitions() {
		b.exports[name] = b.mod.ExportedFunction(name)
	}
	if err := b.boot(ctx); err != nil {
		return nil, fmt.Errorf("%w\nbackend log:\n%s", err, b.Log())
	}
	return b, nil
}

func (b *Backend) appendLog(p []byte) {
	if b.log.Len() < maxLogBytes {
		b.log.Write(p)
	}
}

// Log returns what the backend wrote to stdout and stderr (PostgreSQL's log).
func (b *Backend) Log() string { return b.log.String() }

// DynamicLoads lists the libraries PostgreSQL tried to dlopen.
func (b *Backend) DynamicLoads() []string { return append([]string(nil), b.dlopens...) }

func (b *Backend) call(ctx context.Context, name string, args ...uint64) (uint64, error) {
	fn := b.exports[name]
	if fn == nil {
		return 0, fmt.Errorf("pglitewasm: export %s missing", name)
	}
	res, err := fn.Call(ctx, args...)
	if err != nil {
		return 0, err
	}
	if len(res) > 0 {
		return res[0], nil
	}
	return 0, nil
}

func (b *Backend) mustCall(ctx context.Context, name string, args ...uint64) uint64 {
	v, err := b.call(ctx, name, args...)
	if err != nil {
		panic(err)
	}
	return v
}

func (b *Backend) boot(ctx context.Context) error {
	if _, err := b.call(ctx, "__wasm_call_ctors"); err != nil {
		return fmt.Errorf("pglitewasm: constructors: %w", err)
	}
	if err := b.installCallbacks(ctx); err != nil {
		return err
	}
	if _, err := b.call(ctx, "pgl_setPGliteActive", 1); err != nil {
		return fmt.Errorf("pglitewasm: pgl_setPGliteActive: %w", err)
	}
	args := append([]string{postgresExe}, defaultStartParams...)
	args = append(args, "-D", pgData, "postgres")
	code, err := b.callMain(ctx, args)
	if err != nil {
		return fmt.Errorf("pglitewasm: main: %w", err)
	}
	if code != exitAlive {
		return fmt.Errorf("pglitewasm: PGlite failed to initialize properly (main returned %d)", code)
	}
	if _, err := b.call(ctx, "pgl_startPGlite"); err != nil {
		return fmt.Errorf("pglitewasm: pgl_startPGlite: %w", err)
	}
	return nil
}

func (b *Backend) callMain(ctx context.Context, args []string) (int32, error) {
	ptrs := make([]uint32, len(args)+1)
	for i, a := range args {
		p, err := b.stackString(ctx, a)
		if err != nil {
			return 0, err
		}
		ptrs[i] = p
	}
	argv, err := b.call(ctx, "_emscripten_stack_alloc", n64(4*len(ptrs)))
	if err != nil {
		return 0, err
	}
	for i, p := range ptrs {
		b.mem.WriteUint32Le(u32(argv)+n32(4*i), p)
	}
	ret, err := b.call(ctx, "__main_argc_argv", n64(len(args)), argv)
	if err != nil {
		var exit *exitSignal
		if errors.As(err, &exit) {
			return exit.code, nil
		}
		return 0, err
	}
	return i32(ret), nil
}

func (b *Backend) stackString(ctx context.Context, s string) (uint32, error) {
	p, err := b.call(ctx, "_emscripten_stack_alloc", n64(len(s)+1))
	if err != nil {
		return 0, err
	}
	b.mem.Write(u32(p), append([]byte(s), 0))
	return u32(p), nil
}

// Exchange feeds one batch of frontend wire-protocol messages to PostgreSQL and
// returns the backend messages it produced, mirroring execProtocolRawSync.
// A message starting with a zero byte is a startup packet.
func (b *Backend) Exchange(ctx context.Context, msg []byte) ([]byte, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.in, b.inOff = msg, 0
	b.out.Reset()
	if len(msg) == 0 || msg[0] == 'X' {
		return nil, nil
	}
	if msg[0] == 0 {
		port, err := b.call(ctx, "pgl_getMyProcPort")
		if err != nil {
			return nil, err
		}
		res, err := b.call(ctx, "ProcessStartupPacket", port, 1, 1)
		if err != nil {
			return nil, err
		}
		if res != 0 {
			return nil, fmt.Errorf("pglitewasm: startup packet refused (%d)", i32(res))
		}
		if _, err := b.call(ctx, "pgl_sendConnData"); err != nil {
			return nil, err
		}
		if _, err := b.call(ctx, "pgl_pq_flush"); err != nil {
			return nil, err
		}
		return b.takeOutput(), nil
	}
	for {
		remaining, err := b.call(ctx, "pq_buffer_remaining_data")
		if err != nil {
			return nil, err
		}
		if b.inOff >= len(b.in) && remaining == 0 {
			break
		}
		sp, err := b.call(ctx, "emscripten_stack_get_current")
		if err != nil {
			return nil, err
		}
		if _, err := b.call(ctx, "PostgresMainLoopOnce"); err != nil {
			if _, rerr := b.call(ctx, "_emscripten_stack_restore", sp); rerr != nil {
				return nil, rerr
			}
			var exit *exitSignal
			if errors.As(err, &exit) && exit.code == mainLongJump {
				if _, err := b.call(ctx, "PostgresMainLongJmp"); err != nil {
					return nil, fmt.Errorf("pglitewasm: PostgresMainLongJmp: %w", err)
				}
				continue
			}
			var lj *longjmpSignal
			if errors.As(err, &lj) {
				continue
			}
			return nil, fmt.Errorf("pglitewasm: PostgresMainLoopOnce: %w", err)
		}
	}
	if _, err := b.call(ctx, "PostgresSendReadyForQueryIfNecessary"); err != nil {
		return nil, err
	}
	if _, err := b.call(ctx, "pgl_pq_flush"); err != nil {
		return nil, err
	}
	return b.takeOutput(), nil
}

func (b *Backend) takeOutput() []byte {
	b.in, b.inOff = nil, 0
	return append([]byte(nil), b.out.Bytes()...)
}

// Close shuts the backend down and releases the runtime. The data folder is
// left as PostgreSQL wrote it.
func (b *Backend) Close(ctx context.Context) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	var errs []error
	if b.mod != nil {
		if _, err := b.call(ctx, "pgl_setPGliteActive", 0); err != nil {
			errs = append(errs, err)
		}
		if _, err := b.call(ctx, "pgl_run_atexit_funcs"); err != nil {
			var exit *exitSignal
			if !errors.As(err, &exit) {
				errs = append(errs, err)
			}
		}
	}
	b.fs.closeAll()
	errs = append(errs, b.rt.Close(ctx))
	return errors.Join(errs...)
}
