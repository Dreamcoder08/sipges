package doctext

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"testing"
)

func storedZip(name string, data []byte) []byte {
	var b bytes.Buffer
	w := zip.NewWriter(&b)
	f, err := w.CreateHeader(&zip.FileHeader{Name: name, Method: zip.Store})
	if err != nil {
		panic(err)
	}
	if _, err := f.Write(data); err != nil {
		panic(err)
	}
	if err := w.Close(); err != nil {
		panic(err)
	}
	return b.Bytes()
}

func centralOffset(z []byte) int {
	for i := len(z) - 22; i >= 0; i-- {
		if binary.LittleEndian.Uint32(z[i:]) == sigEOCD {
			return int(binary.LittleEndian.Uint32(z[i+16:]))
		}
	}
	panic("no end of central directory")
}

// deflatedZip is a package with n entries named word/document.xml, each a deflated part of
// size bytes of spaces.
func deflatedZip(t *testing.T, n, size int) []byte {
	t.Helper()
	var b bytes.Buffer
	w := zip.NewWriter(&b)
	for range n {
		f, err := w.CreateHeader(&zip.FileHeader{Name: "word/document.xml", Method: zip.Deflate})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.Write(bytes.Repeat([]byte{' '}, size)); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}
