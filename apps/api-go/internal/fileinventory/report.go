// Package fileinventory walks a client's folder and says what is in it: how many files of each
// type, which can be read, which are the same file twice, and, for spreadsheets, how they are
// shaped. It reads only, needs no database, and is built so that no cell value leaves a file.
package fileinventory

import (
	"cmp"
	"fmt"
	"io"
	"maps"
	"slices"
	"time"
)

// Schema names this report's format.
const Schema = "sipges.file-inventory/v1"

// Status says what the scan could do with a file.
type Status string

// A file is readable, unreadable with a reason, or of a type the scan does not open.
const (
	StatusReadable     Status = "readable"
	StatusUnreadable   Status = "unreadable"
	StatusNotInspected Status = "not-inspected"
)

// Why a file could not be read.
const (
	ReasonCorrupt          = "corrupt"
	ReasonEmpty            = "empty"
	ReasonEncrypted        = "encrypted"
	ReasonLegacyFormat     = "legacy-format"
	ReasonLink             = "link"
	ReasonPermissionDenied = "permission-denied"
	ReasonSpecialFile      = "special-file"
	ReasonTooLarge         = "too-large"
)

// The Type of an entry that has no extension to go by.
const (
	typeNone    = "(none)"
	typeLink    = "(link)"
	typeFolder  = "(folder)"
	typeSpecial = "(special)"
	typeOther   = "other"
)

// Report is the whole inventory.
type Report struct {
	Schema      string        `json:"schema"`
	GeneratedAt time.Time     `json:"generatedAt"`
	Totals      Totals        `json:"totals"`
	ByType      []TypeCount   `json:"byType"`
	ByReason    []ReasonCount `json:"byReason"`
	Duplicates  []Duplicate   `json:"duplicates"`
	Tables      []Table       `json:"tables"`
	Files       []File        `json:"files"`
}

// Totals adds up the folder. DuplicateFiles and DuplicateBytes count only the extra copies.
type Totals struct {
	Files          int   `json:"files"`
	Bytes          int64 `json:"bytes"`
	Readable       int   `json:"readable"`
	Unreadable     int   `json:"unreadable"`
	NotInspected   int   `json:"notInspected"`
	DuplicateFiles int   `json:"duplicateFiles"`
	DuplicateBytes int64 `json:"duplicateBytes"`
}

// TypeCount is one line per file type.
type TypeCount struct {
	Type         string `json:"type"`
	Files        int    `json:"files"`
	Bytes        int64  `json:"bytes"`
	Readable     int    `json:"readable"`
	Unreadable   int    `json:"unreadable"`
	NotInspected int    `json:"notInspected"`
}

// ReasonCount is one line per reason a file could not be read.
type ReasonCount struct {
	Reason string `json:"reason"`
	Files  int    `json:"files"`
}

// Duplicate is one set of files with identical bytes.
type Duplicate struct {
	SHA256 string   `json:"sha256"`
	Bytes  int64    `json:"bytes"`
	Paths  []string `json:"paths"`
}

// File is one entry of the folder. Path is relative to the folder.
type File struct {
	Path   string `json:"path"`
	Type   string `json:"type"`
	Bytes  int64  `json:"bytes"`
	SHA256 string `json:"sha256,omitempty"`
	Status Status `json:"status"`
	Reason string `json:"reason,omitempty"`
}

// Table is the shape of one spreadsheet file.
type Table struct {
	Path      string  `json:"path"`
	Format    string  `json:"format"`
	Encoding  string  `json:"encoding,omitempty"`
	Delimiter string  `json:"delimiter,omitempty"`
	Sheets    []Sheet `json:"sheets"`
}

// Sheet holds names and counts, never a cell of data. HeaderRow is the row the header came from,
// on a CSV the line. Headers is empty when HeadersWithheld says why, and a cell that does not
// read like a column's name is WithheldCell. DataRows counts filled rows below the header.
type Sheet struct {
	Name            string   `json:"name,omitempty"`
	Hidden          bool     `json:"hidden,omitempty"`
	HeaderRow       int      `json:"headerRow"`
	DataRows        int      `json:"dataRows"`
	Columns         int      `json:"columns"`
	Headers         []string `json:"headers,omitempty"`
	HeadersWithheld string   `json:"headersWithheld,omitempty"`
}

func newReport(now time.Time, files []File, tables []Table) Report {
	report := Report{
		Schema: Schema, GeneratedAt: now, Files: files, Tables: tables,
		ByType: []TypeCount{}, ByReason: []ReasonCount{}, Duplicates: []Duplicate{},
	}
	types := map[string]*TypeCount{}
	reasons := map[string]int{}
	sameBytes := map[string][]File{}
	for _, f := range files {
		line := types[f.Type]
		if line == nil {
			line = &TypeCount{Type: f.Type}
			types[f.Type] = line
		}
		line.Files++
		line.Bytes += f.Bytes
		report.Totals.Files++
		report.Totals.Bytes += f.Bytes
		switch f.Status {
		case StatusReadable:
			line.Readable++
			report.Totals.Readable++
		case StatusUnreadable:
			line.Unreadable++
			report.Totals.Unreadable++
			reasons[f.Reason]++
		case StatusNotInspected:
			line.NotInspected++
			report.Totals.NotInspected++
		}
		if f.SHA256 != "" && f.Bytes > 0 {
			sameBytes[f.SHA256] = append(sameBytes[f.SHA256], f)
		}
	}
	for _, name := range slices.Sorted(maps.Keys(types)) {
		report.ByType = append(report.ByType, *types[name])
	}
	for _, reason := range slices.Sorted(maps.Keys(reasons)) {
		report.ByReason = append(report.ByReason, ReasonCount{reason, reasons[reason]})
	}
	for _, hash := range slices.Sorted(maps.Keys(sameBytes)) {
		group := sameBytes[hash]
		if len(group) < 2 {
			continue
		}
		duplicate := Duplicate{SHA256: hash, Bytes: group[0].Bytes}
		for _, f := range group {
			duplicate.Paths = append(duplicate.Paths, f.Path)
		}
		report.Duplicates = append(report.Duplicates, duplicate)
		report.Totals.DuplicateFiles += len(group) - 1
		report.Totals.DuplicateBytes += int64(len(group)-1) * group[0].Bytes
	}
	slices.SortStableFunc(report.Duplicates, func(a, b Duplicate) int { return cmp.Compare(b.Bytes, a.Bytes) })
	return report
}

// WriteSummary prints counts only: a terminal scrolls into logs and screenshots, so file, sheet
// and column names stay in the report file.
func (r Report) WriteSummary(out io.Writer) {
	print := func(format string, args ...any) { _, _ = fmt.Fprintf(out, format, args...) }
	t := r.Totals
	print("%d files, %s: %d readable, %d unreadable, %d not inspected\n",
		t.Files, size(t.Bytes), t.Readable, t.Unreadable, t.NotInspected)
	print("  %-12s %6s %10s %9s %11s %14s\n", "type", "files", "size", "readable", "unreadable", "not inspected")
	for _, line := range r.ByType {
		print("  %-12s %6d %10s %9d %11d %14d\n",
			line.Type, line.Files, size(line.Bytes), line.Readable, line.Unreadable, line.NotInspected)
	}
	for _, line := range r.ByReason {
		print("unreadable, %s: %d\n", line.Reason, line.Files)
	}
	if len(r.Duplicates) > 0 {
		print("duplicates: %d group(s), %d extra file(s), %s\n", len(r.Duplicates), t.DuplicateFiles, size(t.DuplicateBytes))
	}
	if len(r.Tables) > 0 {
		sheets, withheld := 0, 0
		for _, table := range r.Tables {
			sheets += len(table.Sheets)
			for _, sheet := range table.Sheets {
				if sheet.HeadersWithheld != "" {
					withheld++
				}
			}
		}
		print("spreadsheets: %d file(s), %d sheet(s), headers withheld on %d\n", len(r.Tables), sheets, withheld)
	}
}

func size(bytes int64) string {
	const unit = 1024
	if bytes < unit {
		return fmt.Sprintf("%d B", bytes)
	}
	value, prefix := float64(bytes)/unit, 0
	for value >= unit && prefix < 3 {
		value /= unit
		prefix++
	}
	return fmt.Sprintf("%.1f %ciB", value, "KMGT"[prefix])
}
