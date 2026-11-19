// Package pglitewasm runs PGlite's pglite.wasm (PostgreSQL 18 compiled to
// wasm32-unknown-emscripten) inside wazero, without Node. It reimplements the
// part of the Emscripten JavaScript glue the backend needs: the syscalls over a
// small virtual filesystem (the preloaded pglite.data image plus the data folder
// mounted from the host), setjmp/longjmp through invoke_* and the PGlite
// startup and wire-protocol exchange of @electric-sql/pglite 0.5.15.
package pglitewasm

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
)

// Pinned @electric-sql/pglite 0.5.15 dist files, verified before use.
const (
	wasmFile = "pglite.wasm"
	dataFile = "pglite.data"
	glueFile = "pglite.js"

	wasmSHA256 = "cdca79cacb3c128b4634d4ce9fa1da76de8464ef4c1272669bafde14f49a03e6"
	dataSHA256 = "d73cf4ba1b0bf92f80f088ce7d23b17f9bc175327d7584ec2a713b27e9758c31"
	glueSHA256 = "b4ee8cc358344c9e495a57b4301938178bec1a2c6d6fad10cd600f5f8632b2a0"
)

// dist holds the verified PGlite files and the file-packager manifest of pglite.data.
type dist struct {
	wasm  []byte
	data  []byte
	files []packagedFile
	dirs  []string
}

type packagedFile struct {
	name       string
	start, end int
}

var (
	manifestFileRE = regexp.MustCompile(`\{filename:"([^"]+)",start:(\d+),end:(\d+)\}`)
	manifestDirRE  = regexp.MustCompile(`FS_createPath"\]\("([^"]*)","([^"]*)"`)
	manifestSizeRE = regexp.MustCompile(`remote_package_size:(\d+)`)
)

func loadDist(dir string) (*dist, error) {
	read := func(name, want string) ([]byte, error) {
		b, err := os.ReadFile(filepath.Join(dir, name)) //nolint:gosec // the caller names the pinned dist folder; content is hash-checked.
		if err != nil {
			return nil, err
		}
		sum := sha256.Sum256(b)
		if got := hex.EncodeToString(sum[:]); got != want {
			return nil, fmt.Errorf("pglitewasm: %s has sha256 %s, want the pinned PGlite 0.5.15 %s", name, got, want)
		}
		return b, nil
	}
	wasm, err := read(wasmFile, wasmSHA256)
	if err != nil {
		return nil, err
	}
	data, err := read(dataFile, dataSHA256)
	if err != nil {
		return nil, err
	}
	glue, err := read(glueFile, glueSHA256)
	if err != nil {
		return nil, err
	}
	d := &dist{wasm: wasm, data: data}
	size := manifestSizeRE.FindSubmatch(glue)
	if size == nil || string(size[1]) != strconv.Itoa(len(data)) {
		return nil, fmt.Errorf("pglitewasm: %s does not describe a %d-byte %s", glueFile, len(data), dataFile)
	}
	for _, m := range manifestDirRE.FindAllSubmatch(glue, -1) {
		parent := string(m[1])
		if parent == "/" {
			parent = ""
		}
		d.dirs = append(d.dirs, parent+"/"+string(m[2]))
	}
	for _, m := range manifestFileRE.FindAllSubmatch(glue, -1) {
		start, _ := strconv.Atoi(string(m[2]))
		end, _ := strconv.Atoi(string(m[3]))
		if start < 0 || end < start || end > len(data) {
			return nil, fmt.Errorf("pglitewasm: bad manifest entry %s", m[1])
		}
		d.files = append(d.files, packagedFile{name: string(m[1]), start: start, end: end})
	}
	if len(d.files) == 0 {
		return nil, fmt.Errorf("pglitewasm: no file-packager manifest in %s", glueFile)
	}
	return d, nil
}
