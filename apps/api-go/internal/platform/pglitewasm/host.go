package pglitewasm

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"
	"github.com/tetratelabs/wazero/experimental/table"
)

// exitSignal unwinds the wasm stack on exit()/proc_exit(), like Emscripten's ExitStatus.
type exitSignal struct{ code int32 }

func (e *exitSignal) Error() string { return fmt.Sprintf("exit(%d)", e.code) }

// longjmpSignal unwinds to the nearest invoke_* like Emscripten's EmscriptenSjLj.
type longjmpSignal struct{}

func (*longjmpSignal) Error() string { return "longjmp" }

type hostFunc func(ctx context.Context, s []uint64)

func (b *Backend) cstr(p uint32) string {
	var sb strings.Builder
	for {
		chunk, ok := b.mem.Read(p, 64)
		if !ok {
			chunk, _ = b.mem.Read(p, 1)
			if len(chunk) == 0 {
				return sb.String()
			}
		}
		if i := strings.IndexByte(string(chunk), 0); i >= 0 {
			sb.Write(chunk[:i])
			return sb.String()
		}
		sb.Write(chunk)
		p += n32(len(chunk))
	}
}

func (b *Backend) putCString(p uint32, s string, max int) {
	if len(s) >= max {
		s = s[:max-1]
	}
	b.mem.Write(p, append([]byte(s), 0))
}

func (b *Backend) writeStat(buf uint32, st statInfo) {
	m := b.mem
	m.WriteUint32Le(buf, 1)
	m.WriteUint32Le(buf+4, st.mode)
	m.WriteUint32Le(buf+8, 1)
	m.WriteUint32Le(buf+12, 0)
	m.WriteUint32Le(buf+16, 0)
	m.WriteUint32Le(buf+20, 0)
	m.WriteUint64Le(buf+24, w64(st.size))
	m.WriteUint32Le(buf+32, 4096)
	m.WriteUint32Le(buf+36, u32(w64((st.size+511)/512)))
	sec, nsec := st.mtime.Unix(), st.mtime.Nanosecond()
	for _, off := range []uint32{40, 56, 72} {
		m.WriteUint64Le(buf+off, w64(sec))
		m.WriteUint32Le(buf+off+8, n32(nsec))
	}
	m.WriteUint64Le(buf+88, st.ino)
}

func (b *Backend) fd(fd uint64) (*vfile, errno) {
	f, ok := b.fs.fds[i32(fd)]
	if !ok {
		return nil, eBADF
	}
	return f, 0
}

func (b *Backend) path(dirfd, p uint64) (string, errno) {
	return b.fs.abs(i32(dirfd), b.cstr(u32(p)))
}

// iovecs walks a WASI iovec array.
func (b *Backend) iovecs(iov, n uint32, fn func(buf []byte) (int, errno, bool)) (uint32, errno) {
	var total uint32
	for i := uint32(0); i < n; i++ {
		ptr, _ := b.mem.ReadUint32Le(iov + 8*i)
		ln, _ := b.mem.ReadUint32Le(iov + 8*i + 4)
		buf, ok := b.mem.Read(ptr, ln)
		if !ok {
			return total, 21 // EFAULT
		}
		got, e, more := fn(buf)
		total += n32(got)
		if e != 0 {
			return total, e
		}
		if !more || got < len(buf) {
			break
		}
	}
	return total, 0
}

func (b *Backend) envStrings() []string {
	return []string{
		"USER=postgres", "LOGNAME=postgres", "PATH=/", "PWD=/", "HOME=/home/postgres",
		"LANG=en_US.UTF-8", "_=" + postgresExe, "PGDATA=" + pgData, "PGUSER=postgres",
		"PGDATABASE=postgres", "LC_COLLATE=en_US.UTF-8", "LC_CTYPE=en_US.UTF-8", "TZ=UTC",
		"PGTZ=UTC", "PGCLIENTENCODING=UTF8", "ICU_DATA=" + icuDataPath,
	}
}

func (b *Backend) writeTM(tm uint32, t time.Time) {
	t = t.UTC()
	vals := []int{t.Second(), t.Minute(), t.Hour(), t.Day(), int(t.Month()) - 1,
		t.Year() - 1900, int(t.Weekday()), t.YearDay() - 1, 0, 0}
	for i, v := range vals {
		b.mem.WriteUint32Le(tm+n32(4*i), w32(ni32(v)))
	}
}

// imports returns the implementation of every env and wasi_snapshot_preview1 function
// pglite.wasm imports. Names absent from the map trap when called.
func (b *Backend) imports() map[string]hostFunc {
	fs := b.fs
	statPath := func(s []uint64, dirfd uint64, p uint64, buf uint64) {
		vp, e := b.path(dirfd, p)
		if e == 0 {
			var st statInfo
			if st, e = fs.stat(vp); e == 0 {
				b.writeStat(u32(buf), st)
			}
		}
		s[0] = neg(e)
	}
	zero := func(_ context.Context, s []uint64) { s[0] = 0 }
	nosys := func(_ context.Context, s []uint64) { s[0] = neg(eNOSYS) }
	exit := func(_ context.Context, s []uint64) { panic(&exitSignal{code: i32(s[0])}) }
	m := map[string]hostFunc{
		"__syscall_chdir": func(_ context.Context, s []uint64) {
			vp, e := b.path(atFDCWDu, s[0])
			if e == 0 {
				var st statInfo
				if st, e = fs.stat(vp); e == 0 {
					if st.mode&sIFMT != sIFDIR {
						e = eNOTDIR
					} else {
						fs.cwd = vp
					}
				}
			}
			s[0] = neg(e)
		},
		"__syscall_chmod": zero, "__syscall_fchmod": zero, "__syscall_fchmodat2": zero,
		"__syscall_fchown32": zero, "__syscall_fchownat": zero, "__syscall_utimensat": zero,
		"__syscall_fadvise64": zero, "__syscall_fdatasync": zero,
		"__syscall_getuid32": zero, "__syscall_geteuid32": zero, "__syscall_getgid32": zero, "__syscall_getegid32": zero,
		"__syscall_dup": func(_ context.Context, s []uint64) {
			f, e := b.fd(s[0])
			if e != 0 {
				s[0] = neg(e)
				return
			}
			s[0] = ret(fs.install(f))
		},
		"__syscall_dup3": func(_ context.Context, s []uint64) {
			f, e := b.fd(s[0])
			if e != 0 {
				s[0] = neg(e)
				return
			}
			nfd := i32(s[1])
			if nfd == i32(s[0]) {
				s[0] = neg(eINVAL)
				return
			}
			if _, ok := fs.fds[nfd]; ok {
				_ = fs.close(nfd)
			}
			fs.fds[nfd] = f
			s[0] = ret(nfd)
		},
		"__syscall_faccessat": func(_ context.Context, s []uint64) {
			vp, e := b.path(s[0], s[1])
			if e == 0 {
				_, e = fs.stat(vp)
			}
			s[0] = neg(e)
		},
		"__syscall_fallocate": func(_ context.Context, s []uint64) {
			f, e := b.fd(s[0])
			if e == 0 {
				end := i64(s[2]) + i64(s[3])
				var size int64
				if size, e = fs.size(f); e == 0 && end > size {
					e = fs.truncate(f, end)
				}
			}
			s[0] = neg(e)
		},
		"__syscall_fcntl64": func(_ context.Context, s []uint64) {
			f, e := b.fd(s[0])
			if e != 0 {
				s[0] = neg(e)
				return
			}
			arg, _ := b.mem.ReadUint32Le(u32(s[2]))
			switch i32(s[1]) {
			case 0: // F_DUPFD
				nfd := s32(arg)
				for fs.fds[nfd] != nil {
					nfd++
				}
				fs.fds[nfd] = f
				s[0] = ret(nfd)
			case 1, 2, 13, 14:
				s[0] = 0
			case 3:
				s[0] = ret(f.flags)
			case 4:
				f.flags = (f.flags &^ 289792) | (s32(arg) & 289792)
				s[0] = 0
			case 12: // F_GETLK: report unlocked
				b.mem.WriteUint16Le(arg, 2)
				s[0] = 0
			default:
				s[0] = neg(eINVAL)
			}
		},
		"__syscall_fstat64": func(_ context.Context, s []uint64) {
			f, e := b.fd(s[0])
			if e == 0 {
				var st statInfo
				if st, e = fs.fstat(f); e == 0 {
					b.writeStat(u32(s[1]), st)
				}
			}
			s[0] = neg(e)
		},
		"__syscall_stat64":  func(_ context.Context, s []uint64) { statPath(s, atFDCWDu, s[0], s[1]) },
		"__syscall_lstat64": func(_ context.Context, s []uint64) { statPath(s, atFDCWDu, s[0], s[1]) },
		"__syscall_newfstatat": func(_ context.Context, s []uint64) {
			if s[1] != 0 && b.cstr(u32(s[1])) == "" && i32(s[3])&4096 != 0 {
				f, e := b.fd(s[0])
				if e == 0 {
					var st statInfo
					if st, e = fs.fstat(f); e == 0 {
						b.writeStat(u32(s[2]), st)
					}
				}
				s[0] = neg(e)
				return
			}
			statPath(s, s[0], s[1], s[2])
		},
		"__syscall_ftruncate64": func(_ context.Context, s []uint64) {
			f, e := b.fd(s[0])
			if e == 0 {
				e = fs.truncate(f, i64(s[1]))
			}
			s[0] = neg(e)
		},
		"__syscall_truncate64": func(_ context.Context, s []uint64) {
			vp, e := b.path(atFDCWDu, s[0])
			if e == 0 {
				e = fs.truncatePath(vp, i64(s[1]))
			}
			s[0] = neg(e)
		},
		"__syscall_getcwd": func(_ context.Context, s []uint64) {
			if uint64(len(fs.cwd)+1) > s[1] {
				s[0] = neg(eRANGE)
				return
			}
			b.putCString(u32(s[0]), fs.cwd, len(fs.cwd)+1)
			s[0] = ret(ni32(len(fs.cwd) + 1))
		},
		"__syscall_getdents64": func(_ context.Context, s []uint64) {
			f, e := b.fd(s[0])
			if e == 0 && !f.isDir {
				e = eNOTDIR
			}
			if e != 0 {
				s[0] = neg(e)
				return
			}
			if f.dents == nil || f.pos == 0 {
				if f.dents, e = fs.readdir(f); e != 0 {
					s[0] = neg(e)
					return
				}
			}
			const reclen = 280
			dirp, count := u32(s[1]), u32(s[2])
			start := int(f.pos / reclen)
			end := min(len(f.dents), start+int(count/reclen))
			var pos uint32
			for idx := start; idx < end; idx++ {
				de := f.dents[idx]
				rec := make([]byte, reclen)
				binary.LittleEndian.PutUint64(rec[0:], de.ino)
				binary.LittleEndian.PutUint64(rec[8:], n64((idx+1)*reclen))
				binary.LittleEndian.PutUint16(rec[16:], reclen)
				rec[18] = de.typ
				copy(rec[19:19+255], de.name)
				b.mem.Write(dirp+pos, rec)
				pos += reclen
			}
			f.pos = int64(end * reclen)
			s[0] = uint64(pos)
		},
		"__syscall_ioctl": func(_ context.Context, s []uint64) { s[0] = neg(eNOTTY) },
		"__syscall_linkat": func(_ context.Context, s []uint64) {
			s[0] = neg(eNOSYS)
		},
		"__syscall_mkdirat": func(_ context.Context, s []uint64) {
			vp, e := b.path(s[0], s[1])
			if e == 0 {
				e = fs.mkdir(vp, u32(s[2]))
			}
			s[0] = neg(e)
		},
		"__syscall_openat": func(_ context.Context, s []uint64) {
			vp, e := b.path(s[0], s[1])
			if e != 0 {
				s[0] = neg(e)
				return
			}
			var mode uint32
			if s[3] != 0 {
				mode, _ = b.mem.ReadUint32Le(u32(s[3]))
			}
			fd, e := fs.open(vp, i32(s[2]), mode)
			if e != 0 {
				s[0] = neg(e)
				return
			}
			s[0] = ret(fd)
		},
		"__syscall_readlinkat": func(_ context.Context, s []uint64) { s[0] = neg(eINVAL) },
		"__syscall_renameat": func(_ context.Context, s []uint64) {
			from, e := b.path(s[0], s[1])
			if e == 0 {
				var to string
				if to, e = b.path(s[2], s[3]); e == 0 {
					e = fs.rename(from, to)
				}
			}
			s[0] = neg(e)
		},
		"__syscall_rmdir": func(_ context.Context, s []uint64) {
			vp, e := b.path(atFDCWDu, s[0])
			if e == 0 {
				e = fs.unlink(vp, true)
			}
			s[0] = neg(e)
		},
		"__syscall_unlinkat": func(_ context.Context, s []uint64) {
			vp, e := b.path(s[0], s[1])
			if e == 0 {
				e = fs.unlink(vp, i32(s[2])&512 != 0)
			}
			s[0] = neg(e)
		},
		"__syscall_statfs64": func(_ context.Context, s []uint64) {
			buf := u32(s[2])
			m := b.mem
			m.WriteUint32Le(buf+4, 4096)
			m.WriteUint32Le(buf+60, 4096)
			m.WriteUint64Le(buf+8, 1<<20)
			m.WriteUint64Le(buf+16, 1<<19)
			m.WriteUint64Le(buf+24, 1<<19)
			m.WriteUint64Le(buf+32, 1<<20)
			m.WriteUint64Le(buf+40, 1<<19)
			m.WriteUint32Le(buf+48, 42)
			m.WriteUint32Le(buf+64, 2)
			m.WriteUint32Le(buf+56, 255)
			s[0] = 0
		},
		"__syscall_umask": func(_ context.Context, s []uint64) {
			old := fs.umask
			fs.umask = u32(s[0]) & 0o777
			s[0] = uint64(old)
		},
		"__syscall_poll":      func(_ context.Context, s []uint64) { s[0] = 0 },
		"__syscall_symlinkat": nosys,
		"__syscall_pipe2": func(_ context.Context, s []uint64) {
			r, w := fs.pipe(i32(s[1]))
			b.mem.WriteUint32Le(u32(s[0]), w32(r))
			b.mem.WriteUint32Le(u32(s[0])+4, w32(w))
			s[0] = 0
		},
		"__syscall_socket": nosys, "__syscall_bind": nosys, "__syscall_connect": nosys,
		"__syscall_listen": nosys, "__syscall_accept4": nosys, "__syscall_recvfrom": nosys,
		"__syscall_sendto": nosys,
		"getaddrinfo":      b.getaddrinfo,
		"getnameinfo":      b.getnameinfo,

		"_abort_js": func(context.Context, []uint64) { panic(errors.New("pglitewasm: abort()")) },
		"__assert_fail": func(_ context.Context, s []uint64) {
			panic(fmt.Errorf("pglitewasm: assertion failed: %s at %s:%d (%s)",
				b.cstr(u32(s[0])), b.cstr(u32(s[1])), i32(s[2]), b.cstr(u32(s[3]))))
		},
		"_dlopen_js": func(_ context.Context, s []uint64) {
			// Side modules are not linked: record which one PostgreSQL wanted and fail
			// the dlopen, which PostgreSQL reports as a SQL error.
			b.dlopens = append(b.dlopens, b.dsoName(u32(s[0])))
			s[0] = 0
		},
		"_dlsym_js":                           func(_ context.Context, s []uint64) { s[0] = 0 },
		"_emscripten_runtime_keepalive_clear": func(context.Context, []uint64) {},
		"_emscripten_throw_longjmp":           func(context.Context, []uint64) { panic(&longjmpSignal{}) },
		"_gmtime_js": func(_ context.Context, s []uint64) {
			b.writeTM(u32(s[1]), time.Unix(i64(s[0]), 0))
			s[0] = 0
		},
		"_localtime_js": func(_ context.Context, s []uint64) {
			b.writeTM(u32(s[1]), time.Unix(i64(s[0]), 0))
			s[0] = 0
		},
		"_mmap_js": func(ctx context.Context, s []uint64) {
			// Like Emscripten's MEMFS/NODEFS mmap: a private, zeroed copy of the file range.
			f, e := b.fd(s[3])
			if e != 0 {
				s[0] = neg(e)
				return
			}
			length := u32(s[0])
			size := (length + wasmPageSize - 1) / wasmPageSize * wasmPageSize
			ptr := u32(b.mustCall(ctx, "emscripten_builtin_memalign", wasmPageSize, uint64(size)))
			if ptr == 0 {
				s[0] = neg(48) // ENOMEM
				return
			}
			buf, _ := b.mem.Read(ptr, size)
			clear(buf)
			if _, e := fs.pread(f, buf[:length], i64(s[4])); e != 0 {
				s[0] = neg(e)
				return
			}
			b.mem.WriteUint32Le(u32(s[5]), 1)
			b.mem.WriteUint32Le(u32(s[6]), ptr)
			s[0] = 0
		},
		"_munmap_js": func(_ context.Context, s []uint64) {
			// munmap(addr, len, prot, flags, fd, offset): write back shared writable mappings.
			f, e := b.fd(s[4])
			if e == 0 && u32(s[2])&2 != 0 && u32(s[3])&2 == 0 {
				buf, _ := b.mem.Read(u32(s[0]), u32(s[1]))
				_, e = fs.pwrite(f, buf, i64(s[5]))
			}
			s[0] = neg(e)
		},
		"_setitimer_js": zero,
		"_tzset_js": func(_ context.Context, s []uint64) {
			b.mem.WriteUint32Le(u32(s[0]), 0)
			b.mem.WriteUint32Le(u32(s[1]), 0)
			b.putCString(u32(s[2]), "UTC", 17)
			b.putCString(u32(s[3]), "UTC", 17)
		},
		"emscripten_date_now": func(_ context.Context, s []uint64) {
			s[0] = f64(float64(time.Now().UnixNano()) / 1e6)
		},
		"emscripten_get_now": func(_ context.Context, s []uint64) {
			s[0] = f64(float64(time.Since(b.start).Nanoseconds()) / 1e6)
		},
		"emscripten_force_exit":   exit,
		"exit":                    exit,
		"proc_exit":               exit,
		"emscripten_get_heap_max": func(_ context.Context, s []uint64) { s[0] = maxHeapBytes },
		"emscripten_resize_heap": func(_ context.Context, s []uint64) {
			want := uint64(u32(s[0]))
			have := uint64(b.mem.Size())
			if want > maxHeapBytes {
				s[0] = 0
				return
			}
			grow := max(want, have+have/5)
			grow = min(maxHeapBytes, (grow+wasmPageSize-1)/wasmPageSize*wasmPageSize)
			if _, ok := b.mem.Grow(u32((grow - have) / wasmPageSize)); !ok {
				s[0] = 0
				return
			}
			s[0] = 1
		},
		"getTempRet0": func(_ context.Context, s []uint64) { s[0] = uint64(b.tempRet) },
		"setTempRet0": func(_ context.Context, s []uint64) { b.tempRet = u32(s[0]) },
		"__call_sighandler": func(ctx context.Context, s []uint64) {
			fn := table.LookupFunction(b.mod, 0, u32(s[0]), []api.ValueType{api.ValueTypeI32}, nil)
			if _, err := fn.Call(ctx, s[1]); err != nil {
				panic(err)
			}
		},

		// WASI.
		"environ_sizes_get": func(_ context.Context, s []uint64) {
			env := b.envStrings()
			size := 0
			for _, e := range env {
				size += len(e) + 1
			}
			b.mem.WriteUint32Le(u32(s[0]), n32(len(env)))
			b.mem.WriteUint32Le(u32(s[1]), n32(size))
			s[0] = 0
		},
		"environ_get": func(_ context.Context, s []uint64) {
			envp, buf := u32(s[0]), u32(s[1])
			for i, e := range b.envStrings() {
				b.mem.WriteUint32Le(envp+n32(4*i), buf)
				b.mem.Write(buf, append([]byte(e), 0))
				buf += n32(len(e) + 1)
			}
			s[0] = 0
		},
		"clock_time_get": func(_ context.Context, s []uint64) {
			var ns int64
			if s[0] == 0 {
				ns = time.Now().UnixNano()
			} else {
				ns = time.Since(b.start).Nanoseconds()
			}
			b.mem.WriteUint64Le(u32(s[2]), w64(ns))
			s[0] = 0
		},
		"random_get": func(_ context.Context, s []uint64) {
			buf, _ := b.mem.Read(u32(s[0]), u32(s[1]))
			_, _ = rand.Read(buf)
			s[0] = 0
		},
		"sched_yield": zero,
		"fd_close":    func(_ context.Context, s []uint64) { s[0] = wasi(fs.close(i32(s[0]))) },
		"fd_sync":     func(_ context.Context, s []uint64) { s[0] = 0 },
		"fd_fdstat_get": func(_ context.Context, s []uint64) {
			f, e := b.fd(s[0])
			if e != 0 {
				s[0] = wasi(e)
				return
			}
			typ := byte(4)
			if f.isDir {
				typ = 3
			}
			buf := make([]byte, 24)
			buf[0] = typ
			b.mem.Write(u32(s[1]), buf)
			s[0] = 0
		},
		"fd_read": func(_ context.Context, s []uint64) {
			f, e := b.fd(s[0])
			if e != 0 {
				s[0] = wasi(e)
				return
			}
			n, e := b.iovecs(u32(s[1]), u32(s[2]), func(buf []byte) (int, errno, bool) {
				got, e := fs.pread(f, buf, f.pos)
				f.pos += int64(got)
				return got, e, true
			})
			b.mem.WriteUint32Le(u32(s[3]), n)
			s[0] = wasi(e)
		},
		"fd_write": func(_ context.Context, s []uint64) {
			f, e := b.fd(s[0])
			if e != 0 {
				s[0] = wasi(e)
				return
			}
			n, e := b.iovecs(u32(s[1]), u32(s[2]), func(buf []byte) (int, errno, bool) {
				got, e := fs.pwrite(f, buf, f.pos)
				f.pos += int64(got)
				return got, e, true
			})
			b.mem.WriteUint32Le(u32(s[3]), n)
			s[0] = wasi(e)
		},
		"fd_pread": func(_ context.Context, s []uint64) {
			f, e := b.fd(s[0])
			if e != 0 {
				s[0] = wasi(e)
				return
			}
			off := i64(s[3])
			n, e := b.iovecs(u32(s[1]), u32(s[2]), func(buf []byte) (int, errno, bool) {
				got, e := fs.pread(f, buf, off)
				off += int64(got)
				return got, e, true
			})
			b.mem.WriteUint32Le(u32(s[4]), n)
			s[0] = wasi(e)
		},
		"fd_pwrite": func(_ context.Context, s []uint64) {
			f, e := b.fd(s[0])
			if e != 0 {
				s[0] = wasi(e)
				return
			}
			off := i64(s[3])
			n, e := b.iovecs(u32(s[1]), u32(s[2]), func(buf []byte) (int, errno, bool) {
				got, e := fs.pwrite(f, buf, off)
				off += int64(got)
				return got, e, true
			})
			b.mem.WriteUint32Le(u32(s[4]), n)
			s[0] = wasi(e)
		},
		"fd_seek": func(_ context.Context, s []uint64) {
			f, e := b.fd(s[0])
			if e != 0 {
				s[0] = wasi(e)
				return
			}
			off := i64(s[1])
			switch i32(s[2]) {
			case 1:
				off += f.pos
			case 2:
				size, e := fs.size(f)
				if e != 0 {
					s[0] = wasi(e)
					return
				}
				off += size
			}
			if off < 0 {
				s[0] = wasi(eINVAL)
				return
			}
			if f.node != nil && f.node.dev != devNone {
				off = 0
			}
			f.pos = off
			if f.isDir && off == 0 {
				f.dents = nil
			}
			b.mem.WriteUint64Le(u32(s[3]), w64(off))
			s[0] = 0
		},
	}
	return m
}

const atFDCWDu = uint64(uint32(0xffffff9c)) // AT_FDCWD (-100) as a raw i32 parameter

// dsoName reads the file name of Emscripten's struct dso (at offset 36, as
// dlopenInternal does), for diagnostics only.
func (b *Backend) dsoName(p uint32) string { return b.cstr(p + 36) }

// invoke implements Emscripten's invoke_<sig>(index, args...): call the table
// entry and turn a longjmp into setThrew(1, 0) after restoring the stack.
func (b *Backend) invoke(params, results []api.ValueType) hostFunc {
	return func(ctx context.Context, s []uint64) {
		idx := u32(s[0])
		fn := table.LookupFunction(b.mod, 0, idx, params, results)
		sp := b.mustCall(ctx, "emscripten_stack_get_current")
		res, err := fn.Call(ctx, s[1:1+len(params)]...)
		if err != nil {
			var lj *longjmpSignal
			if !errors.As(err, &lj) {
				var exit *exitSignal
				if errors.As(err, &exit) {
					panic(exit)
				}
				panic(err)
			}
			b.mustCall(ctx, "_emscripten_stack_restore", sp)
			b.mustCall(ctx, "setThrew", 1, 0)
			for i := range results {
				s[i] = 0
			}
			return
		}
		copy(s, res)
	}
}

// instantiateImports provides env (with memory), wasi_snapshot_preview1 and the
// modules behind them, from the imports declared by compiled.
func (b *Backend) instantiateImports(ctx context.Context, compiled wazero.CompiledModule) error {
	impls := b.imports()
	envHost := b.rt.NewHostModuleBuilder("pglhost")
	wasi := b.rt.NewHostModuleBuilder("wasi_snapshot_preview1")
	var envNames []string
	var envSigs []wasmSig
	for _, def := range compiled.ImportedFunctions() {
		module, name, _ := def.Import()
		params, results := def.ParamTypes(), def.ResultTypes()
		var impl hostFunc
		switch {
		case strings.HasPrefix(name, "invoke_"):
			impl = b.invoke(params[1:], results)
		default:
			impl = impls[name]
		}
		if impl == nil {
			missing := module + "." + name
			impl = func(context.Context, []uint64) {
				panic(fmt.Errorf("pglitewasm: unimplemented import %s", missing))
			}
		}
		fn := api.GoFunc(impl)
		switch module {
		case "env":
			envHost.NewFunctionBuilder().WithGoFunction(fn, params, results).Export(name)
			envNames = append(envNames, name)
			envSigs = append(envSigs, wasmSig{params: params, results: results})
		case "wasi_snapshot_preview1":
			wasi.NewFunctionBuilder().WithGoFunction(fn, params, results).Export(name)
		default:
			return fmt.Errorf("pglitewasm: unexpected import module %s", module)
		}
	}
	if _, err := envHost.Instantiate(ctx); err != nil {
		return fmt.Errorf("pglitewasm: host functions: %w", err)
	}
	if _, err := wasi.Instantiate(ctx); err != nil {
		return fmt.Errorf("pglitewasm: wasi functions: %w", err)
	}
	mems := compiled.ImportedMemories()
	if len(mems) != 1 {
		return fmt.Errorf("pglitewasm: want one imported memory, got %d", len(mems))
	}
	minPages := max(mems[0].Min(), 2048) // PGlite's default initialMemory (128 MiB).
	env, err := b.instantiateNamed(ctx, "env", envModule("pglhost", envNames, envSigs, minPages, maxPages))
	if err != nil {
		return fmt.Errorf("pglitewasm: env module: %w", err)
	}
	b.mem = env.ExportedMemory("memory")
	if b.mem == nil {
		return errors.New("pglitewasm: env module exports no memory")
	}
	return nil
}

func (b *Backend) instantiateNamed(ctx context.Context, name string, bin []byte) (api.Module, error) {
	compiled, err := b.rt.CompileModule(ctx, bin)
	if err != nil {
		return nil, err
	}
	return b.rt.InstantiateModule(ctx, compiled, wazero.NewModuleConfig().WithName(name).WithStartFunctions())
}
