package main

import (
	"encoding/json"
	"fmt"
	"io"
	"maps"
	"slices"
)

type importCounts struct {
	Source  int `json:"source"`
	Mapped  int `json:"mapped"`
	Written int `json:"written"`
}

type importProblem struct {
	Code string `json:"code"`
}

type importTenant struct {
	TenantID string         `json:"tenantId"`
	Source   map[string]int `json:"source"`
	Mapped   map[string]int `json:"mapped"`
	Written  map[string]int `json:"written"`
	Target   map[string]int `json:"target"`
	Objects  struct {
		Expected int `json:"expected"`
		Copied   int `json:"copied"`
		Verified int `json:"verified"`
	} `json:"objects"`
	Problems []importProblem `json:"problems"`
}

type importSummary struct {
	Mode     string `json:"mode"`
	Applied  bool   `json:"applied"`
	Identity struct {
		Users           importCounts `json:"users"`
		Tenants         importCounts `json:"tenants"`
		Grants          importCounts `json:"grants"`
		SessionsSkipped int          `json:"sessionsSkipped"`
	} `json:"identity"`
	Problems []importProblem `json:"problems"`
	Tenants  []importTenant  `json:"tenants"`
}

const importRow = "  %-22s %4d %7d %7d"

// importReport prints migrate-legacy's JSON report one table per line, so an operator reads the
// counts without a JSON tool: the image is the one program sure to be on the machine. The report
// holds counts, codes and ids only, and only the first two reach this output.
func importReport(in io.Reader, out io.Writer) error {
	var report importSummary
	if err := json.NewDecoder(in).Decode(&report); err != nil {
		return fmt.Errorf("not an import report: %w", err)
	}
	print := func(format string, args ...any) { _, _ = fmt.Fprintf(out, format, args...) }
	state := "nothing written"
	if report.Applied {
		state = "written"
	}
	print("mode %s, %s\n", report.Mode, state)
	print("  %-22s %4s %7s %7s\n", "accounts", "file", "usable", "written")
	identity := report.Identity
	for _, row := range []struct {
		name   string
		counts importCounts
	}{{"users", identity.Users}, {"projects", identity.Tenants}, {"grants", identity.Grants}} {
		print(importRow+"\n", row.name, row.counts.Source, row.counts.Mapped, row.counts.Written)
	}
	print("  sessions, not moved %d\n", identity.SessionsSkipped)
	codes := map[string]int{}
	for _, p := range report.Problems {
		codes[p.Code]++
	}
	for _, tenant := range report.Tenants {
		print("%s\n  %-22s %4s %7s %7s %7s\n", tenant.TenantID, "table", "file", "usable", "written", "in db")
		for _, table := range slices.Sorted(maps.Keys(tenant.Source)) {
			print(importRow+" %7d\n", table, tenant.Source[table], tenant.Mapped[table], tenant.Written[table], tenant.Target[table])
		}
		print("  %-22s %4d expected, %d copied, %d verified\n", "files", tenant.Objects.Expected, tenant.Objects.Copied, tenant.Objects.Verified)
		for _, p := range tenant.Problems {
			codes[p.Code]++
		}
	}
	for _, code := range slices.Sorted(maps.Keys(codes)) {
		print("problem %s x%d\n", code, codes[code])
	}
	return nil
}
