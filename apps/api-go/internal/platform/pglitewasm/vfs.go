package pglitewasm

import (
	"crypto/rand"
	"errors"
	"hash/fnv"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

// WASI errno values, which Emscripten uses for its syscalls.
const (
	eACCES    = 2
	eAGAIN    = 6
	eBADF     = 8
	eEXIST    = 20
	eINVAL    = 28
	eIO       = 29
	eISDIR    = 31
	eNOENT    = 44
	eNOSYS    = 52
	eNOTDIR   = 54
	eNOTEMPTY = 55
	eNOTTY    = 59
	ePERM     = 63
	eRANGE    = 68
)

// Emscripten (musl, Linux generic) open flags and mode bits.
const (
	oACCMODE   = 3
	oWRONLY    = 1
	oRDWR      = 2
	oCREAT     = 64
	oEXCL      = 128
	oTRUNC     = 512
	oAPPEND    = 1024
	oDIRECTORY = 65536

	sIFMT  = 0o170000
	sIFDIR = 0o040000
	sIFREG = 0o100000
	sIFCHR = 0o020000
	sIFLNK = 0o120000
)

type errno int32

type devKind int

const (
	devNone devKind = iota
	devNull
	devRandom
	devStdout
	devStderr
	devPipe
)

// vnode is a node of the in-memory part of the filesystem: the pglite.data image,
// /tmp and the few devices PostgreSQL opens.
type vnode struct {
	mode     uint32
	data     []byte
	children map[string]*vnode
	dev      devKind
	ino      uint64
	mtime    time.Time
}

func (n *vnode) isDir() bool { return n.mode&sIFMT == sIFDIR }

type vfile struct {
	vpath    string
	node     *vnode
	host     *os.File
	hostPath string
	isDir    bool
	pos      int64
	flags    int32
	dents    []dirent
}

type dirent struct {
	name string
	ino  uint64
	typ  uint8
}

type statInfo struct {
	mode  uint32
	size  int64
	ino   uint64
	mtime time.Time
}

// vfs is the filesystem seen by the backend: an in-memory tree plus one host
// folder mounted at mountPoint. Nothing outside hostRoot is ever touched.
type vfs struct {
	root       *vnode
	mountPoint string
	hostRoot   string
	cwd        string
	fds        map[int32]*vfile
	umask      uint32
	stdout     func([]byte)
	stderr     func([]byte)
	nextIno    uint64
	goos       string // runtime.GOOS; tests set "windows"
}

func newVFS(d *dist, mountPoint, hostRoot string, stdout, stderr func([]byte)) *vfs {
	v := &vfs{mountPoint: mountPoint, hostRoot: hostRoot, cwd: "/", fds: map[int32]*vfile{}, umask: 0o022,
		stdout: stdout, stderr: stderr, nextIno: 1, goos: runtime.GOOS}
	v.root = v.newDir()
	for _, dir := range []string{"/tmp", "/home/web_user", "/dev", "/dev/shm"} {
		v.mkdirAll(dir)
	}
	v.mkdirAll(mountPoint)
	dev := v.mkdirAll("/dev")
	dev.children["null"] = &vnode{mode: sIFCHR | 0o666, dev: devNull, ino: v.ino()}
	dev.children["random"] = &vnode{mode: sIFCHR | 0o666, dev: devRandom, ino: v.ino()}
	dev.children["urandom"] = &vnode{mode: sIFCHR | 0o666, dev: devRandom, ino: v.ino()}
	dev.children["stdout"] = &vnode{mode: sIFCHR | 0o666, dev: devStdout, ino: v.ino()}
	dev.children["stderr"] = &vnode{mode: sIFCHR | 0o666, dev: devStderr, ino: v.ino()}
	if d != nil {
		for _, dir := range d.dirs {
			v.mkdirAll(dir)
		}
		for _, f := range d.files {
			parent := v.mkdirAll(path.Dir(f.name))
			mode := uint32(sIFREG | 0o666)
			if strings.HasPrefix(f.name, "/pglite/bin/") {
				mode = sIFREG | 0o555
			}
			if f.name == "/home/postgres/.pgpass" {
				mode = sIFREG | 0o600
			}
			parent.children[path.Base(f.name)] = &vnode{mode: mode, data: d.data[f.start:f.end:f.end], ino: v.ino(), mtime: time.Unix(0, 0)}
		}
	}
	// Standard streams.
	v.fds[0] = &vfile{vpath: "/dev/null", node: dev.children["null"]}
	v.fds[1] = &vfile{vpath: "/dev/stdout", node: dev.children["stdout"], flags: oWRONLY}
	v.fds[2] = &vfile{vpath: "/dev/stderr", node: dev.children["stderr"], flags: oWRONLY}
	return v
}

func (v *vfs) ino() uint64 { v.nextIno++; return v.nextIno }

func (v *vfs) newDir() *vnode {
	return &vnode{mode: sIFDIR | 0o777, children: map[string]*vnode{}, ino: v.ino(), mtime: time.Now()}
}

func (v *vfs) mkdirAll(p string) *vnode {
	n := v.root
	for _, part := range strings.Split(strings.Trim(p, "/"), "/") {
		if part == "" {
			continue
		}
		c, ok := n.children[part]
		if !ok {
			c = v.newDir()
			n.children[part] = c
		}
		n = c
	}
	return n
}

// abs turns a guest path, relative to dirfd or the cwd, into a clean absolute guest path.
func (v *vfs) abs(dirfd int32, p string) (string, errno) {
	if p == "" {
		return "", eNOENT
	}
	if !strings.HasPrefix(p, "/") {
		base := v.cwd
		if dirfd != atFDCWD {
			f, ok := v.fds[dirfd]
			if !ok {
				return "", eBADF
			}
			base = f.vpath
		}
		p = base + "/" + p
	}
	p = path.Clean(p)
	if _, ok := v.mountRel(p); !ok && v.inMount(p) {
		return "", eINVAL
	}
	return p, 0
}

func (v *vfs) inMount(p string) bool {
	return p == v.mountPoint || strings.HasPrefix(p, v.mountPoint+"/")
}

// mountRel is the part of a clean guest path below the mount, refused (false) outside the mount
// and, on Windows, when a component holds a backslash or a colon: a separator, a drive or a data
// stream there would let the host path leave hostRoot.
func (v *vfs) mountRel(p string) (string, bool) {
	if p == v.mountPoint {
		return "", true
	}
	rel, ok := strings.CutPrefix(p, v.mountPoint+"/")
	if !ok || (v.goos == "windows" && strings.ContainsAny(rel, `\:`)) {
		return "", false
	}
	return rel, true
}

const atFDCWD = -100

// host maps a clean absolute guest path inside the mount to a host path.
// abs already refused a component the host would read as a separator, drive or stream.
func (v *vfs) host(p string) (string, bool) {
	rel, ok := v.mountRel(p)
	switch {
	case !ok:
		return "", false
	case rel == "":
		return v.hostRoot, true
	}
	return filepath.Join(v.hostRoot, filepath.FromSlash(rel)), true
}

func (v *vfs) lookup(p string) (*vnode, errno) {
	n := v.root
	for _, part := range strings.Split(strings.Trim(p, "/"), "/") {
		if part == "" {
			continue
		}
		if !n.isDir() {
			return nil, eNOTDIR
		}
		c, ok := n.children[part]
		if !ok {
			return nil, eNOENT
		}
		n = c
	}
	return n, 0
}

func (v *vfs) parent(p string) (*vnode, string, errno) {
	dir, name := path.Split(p)
	n, e := v.lookup(dir)
	if e != 0 {
		return nil, "", e
	}
	if !n.isDir() {
		return nil, "", eNOTDIR
	}
	return n, name, 0
}

func hostErr(err error) errno {
	switch {
	case err == nil:
		return 0
	case errors.Is(err, fs.ErrNotExist):
		return eNOENT
	case errors.Is(err, fs.ErrExist):
		return eEXIST
	case errors.Is(err, fs.ErrPermission):
		return eACCES
	}
	var pe *fs.PathError
	if errors.As(err, &pe) && strings.Contains(pe.Err.Error(), "not a directory") {
		return eNOTDIR
	}
	return eIO
}

func pathIno(p string) uint64 {
	h := fnv.New64a()
	_, _ = h.Write([]byte(p))
	return h.Sum64() >> 12
}

func hostStat(guest string, fi fs.FileInfo) statInfo {
	st := statInfo{size: fi.Size(), ino: pathIno(guest), mtime: fi.ModTime()}
	switch {
	case fi.IsDir():
		st.mode = sIFDIR | 0o700
	case fi.Mode()&fs.ModeSymlink != 0:
		st.mode = sIFLNK | 0o777
	default:
		st.mode = sIFREG | 0o600
	}
	return st
}

func (v *vfs) stat(p string) (statInfo, errno) {
	if hp, ok := v.host(p); ok {
		fi, err := os.Stat(hp)
		if err != nil {
			return statInfo{}, hostErr(err)
		}
		return hostStat(p, fi), 0
	}
	n, e := v.lookup(p)
	if e != 0 {
		return statInfo{}, e
	}
	return statInfo{mode: n.mode, size: int64(len(n.data)), ino: n.ino, mtime: n.mtime}, 0
}

func (v *vfs) open(p string, flags int32, mode uint32) (int32, errno) {
	f := &vfile{vpath: p, flags: flags}
	if hp, ok := v.host(p); ok {
		fi, err := os.Stat(hp)
		switch {
		case err == nil && fi.IsDir():
			if flags&oACCMODE != 0 {
				return 0, eISDIR
			}
			f.isDir, f.hostPath = true, hp
		case err == nil && flags&oCREAT != 0 && flags&oEXCL != 0:
			return 0, eEXIST
		case err != nil && (!errors.Is(err, fs.ErrNotExist) || flags&oCREAT == 0):
			return 0, hostErr(err)
		case flags&oDIRECTORY != 0:
			return 0, eNOTDIR
		default:
			osFlags := os.O_RDONLY
			switch flags & oACCMODE {
			case oWRONLY:
				osFlags = os.O_WRONLY
			case oRDWR:
				osFlags = os.O_RDWR
			}
			if flags&oCREAT != 0 {
				osFlags |= os.O_CREATE
			}
			if flags&oEXCL != 0 {
				osFlags |= os.O_EXCL
			}
			if flags&oTRUNC != 0 {
				osFlags |= os.O_TRUNC
			}
			hf, err := os.OpenFile(hp, osFlags, 0o600) //nolint:gosec // hp is confined to the mounted scratch folder.
			if err != nil {
				return 0, hostErr(err)
			}
			f.host, f.hostPath = hf, hp
		}
		return v.install(f), 0
	}
	n, e := v.lookup(p)
	switch {
	case e == eNOENT && flags&oCREAT != 0:
		parent, name, pe := v.parent(p)
		if pe != 0 {
			return 0, pe
		}
		n = &vnode{mode: sIFREG | (mode &^ v.umask & 0o777), ino: v.ino(), mtime: time.Now()}
		parent.children[name] = n
	case e != 0:
		return 0, e
	case flags&oCREAT != 0 && flags&oEXCL != 0:
		return 0, eEXIST
	}
	if n.isDir() {
		if flags&oACCMODE != 0 {
			return 0, eISDIR
		}
		f.isDir = true
	} else if flags&oDIRECTORY != 0 {
		return 0, eNOTDIR
	}
	if flags&oTRUNC != 0 && n.mode&sIFMT == sIFREG {
		n.data = nil
	}
	f.node = n
	return v.install(f), 0
}

func (v *vfs) install(f *vfile) int32 {
	fd := int32(3)
	for v.fds[fd] != nil {
		fd++
	}
	v.fds[fd] = f
	return fd
}

func (v *vfs) close(fd int32) errno {
	f, ok := v.fds[fd]
	if !ok {
		return eBADF
	}
	delete(v.fds, fd)
	if f.host != nil && !v.shared(f) {
		if err := f.host.Close(); err != nil {
			return eIO
		}
	}
	return 0
}

// shared reports whether another descriptor still uses f (dup).
func (v *vfs) shared(f *vfile) bool {
	for _, o := range v.fds {
		if o == f {
			return true
		}
	}
	return false
}

func (v *vfs) closeAll() {
	for fd := range v.fds {
		_ = v.close(fd)
	}
}

func (v *vfs) pread(f *vfile, buf []byte, off int64) (int, errno) {
	if f.isDir {
		return 0, eISDIR
	}
	if f.host != nil {
		n, err := f.host.ReadAt(buf, off)
		if err != nil && !errors.Is(err, io.EOF) {
			return n, eIO
		}
		return n, 0
	}
	switch f.node.dev {
	case devNull, devStdout, devStderr:
		return 0, 0
	case devRandom:
		_, _ = rand.Read(buf)
		return len(buf), 0
	case devPipe:
		if len(f.node.data) == 0 {
			return 0, eAGAIN
		}
		n := copy(buf, f.node.data)
		f.node.data = f.node.data[n:]
		return n, 0
	}
	if off >= int64(len(f.node.data)) {
		return 0, 0
	}
	return copy(buf, f.node.data[off:]), 0
}

func (v *vfs) pwrite(f *vfile, buf []byte, off int64) (int, errno) {
	if f.isDir {
		return 0, eISDIR
	}
	if f.flags&oACCMODE == 0 {
		return 0, eBADF
	}
	if f.host != nil {
		if f.flags&oAPPEND != 0 {
			fi, err := f.host.Stat()
			if err != nil {
				return 0, eIO
			}
			off = fi.Size()
		}
		n, err := f.host.WriteAt(buf, off)
		if err != nil {
			return n, eIO
		}
		return n, 0
	}
	switch f.node.dev {
	case devNull, devRandom:
		return len(buf), 0
	case devStdout:
		v.stdout(buf)
		return len(buf), 0
	case devStderr:
		v.stderr(buf)
		return len(buf), 0
	case devPipe:
		f.node.data = append(f.node.data, buf...)
		return len(buf), 0
	}
	n := f.node
	if f.flags&oAPPEND != 0 {
		off = int64(len(n.data))
	}
	if end := off + int64(len(buf)); end > int64(len(n.data)) {
		grown := make([]byte, end)
		copy(grown, n.data)
		n.data = grown
	}
	copy(n.data[off:], buf)
	n.mtime = time.Now()
	return len(buf), 0
}

func (v *vfs) size(f *vfile) (int64, errno) {
	if f.host != nil {
		fi, err := f.host.Stat()
		if err != nil {
			return 0, eIO
		}
		return fi.Size(), 0
	}
	if f.node != nil {
		return int64(len(f.node.data)), 0
	}
	return 0, 0
}

func (v *vfs) fstat(f *vfile) (statInfo, errno) {
	if f.host != nil {
		fi, err := f.host.Stat()
		if err != nil {
			return statInfo{}, eIO
		}
		return hostStat(f.vpath, fi), 0
	}
	if f.hostPath != "" {
		return v.stat(f.vpath)
	}
	return statInfo{mode: f.node.mode, size: int64(len(f.node.data)), ino: f.node.ino, mtime: f.node.mtime}, 0
}

func (v *vfs) truncate(f *vfile, size int64) errno {
	if f.host != nil {
		return hostErr(f.host.Truncate(size))
	}
	if f.node == nil || f.node.isDir() {
		return eISDIR
	}
	if size <= int64(len(f.node.data)) {
		f.node.data = f.node.data[:size:size]
	} else {
		grown := make([]byte, size)
		copy(grown, f.node.data)
		f.node.data = grown
	}
	return 0
}

func (v *vfs) readdir(f *vfile) ([]dirent, errno) {
	ents := []dirent{{name: ".", typ: 4}, {name: "..", typ: 4}}
	if f.hostPath != "" {
		list, err := os.ReadDir(f.hostPath)
		if err != nil {
			return nil, hostErr(err)
		}
		for _, e := range list {
			typ := uint8(8)
			if e.IsDir() {
				typ = 4
			}
			ents = append(ents, dirent{name: e.Name(), typ: typ, ino: pathIno(f.vpath + "/" + e.Name())})
		}
		return ents, 0
	}
	names := make([]string, 0, len(f.node.children))
	for name := range f.node.children {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		c := f.node.children[name]
		typ := uint8(8)
		switch c.mode & sIFMT {
		case sIFDIR:
			typ = 4
		case sIFCHR:
			typ = 2
		}
		ents = append(ents, dirent{name: name, typ: typ, ino: c.ino})
	}
	return ents, 0
}

func (v *vfs) mkdir(p string, mode uint32) errno {
	if hp, ok := v.host(p); ok {
		return hostErr(os.Mkdir(hp, 0o700))
	}
	parent, name, e := v.parent(p)
	if e != 0 {
		return e
	}
	if _, ok := parent.children[name]; ok {
		return eEXIST
	}
	d := v.newDir()
	d.mode = sIFDIR | (mode &^ v.umask & 0o777)
	parent.children[name] = d
	return 0
}

func (v *vfs) unlink(p string, dir bool) errno {
	if hp, ok := v.host(p); ok {
		if p == v.mountPoint {
			return ePERM
		}
		fi, err := os.Lstat(hp)
		if err != nil {
			return hostErr(err)
		}
		if dir != fi.IsDir() {
			if dir {
				return eNOTDIR
			}
			return eISDIR
		}
		if dir {
			list, err := os.ReadDir(hp)
			if err != nil {
				return hostErr(err)
			}
			if len(list) > 0 {
				return eNOTEMPTY
			}
		}
		return hostErr(os.Remove(hp))
	}
	parent, name, e := v.parent(p)
	if e != 0 {
		return e
	}
	n, ok := parent.children[name]
	if !ok {
		return eNOENT
	}
	if dir != n.isDir() {
		if dir {
			return eNOTDIR
		}
		return eISDIR
	}
	if dir && len(n.children) > 0 {
		return eNOTEMPTY
	}
	delete(parent.children, name)
	return 0
}

func (v *vfs) rename(from, to string) errno {
	hf, fromHost := v.host(from)
	ht, toHost := v.host(to)
	switch {
	case fromHost && toHost:
		return hostErr(os.Rename(hf, ht))
	case fromHost || toHost:
		return 75 // EXDEV
	}
	fp, fname, e := v.parent(from)
	if e != 0 {
		return e
	}
	n, ok := fp.children[fname]
	if !ok {
		return eNOENT
	}
	tp, tname, e := v.parent(to)
	if e != 0 {
		return e
	}
	delete(fp.children, fname)
	tp.children[tname] = n
	return 0
}

func (v *vfs) truncatePath(p string, size int64) errno {
	if hp, ok := v.host(p); ok {
		return hostErr(os.Truncate(hp, size))
	}
	n, e := v.lookup(p)
	if e != 0 {
		return e
	}
	return v.truncate(&vfile{node: n}, size)
}

// pipe creates an in-memory pipe (PostgreSQL's latch self-pipe) and returns its read and write ends.
func (v *vfs) pipe(flags int32) (int32, int32) {
	n := &vnode{mode: sIFCHR | 0o600, dev: devPipe, ino: v.ino()}
	r := v.install(&vfile{vpath: "/dev/pipe", node: n, flags: flags &^ oACCMODE})
	w := v.install(&vfile{vpath: "/dev/pipe", node: n, flags: flags&^oACCMODE | oWRONLY})
	return r, w
}
