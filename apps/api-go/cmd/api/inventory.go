package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/fileinventory"
)

// inventory scans a folder and writes the report. It takes no configuration on purpose: it never
// reads a database address, so it cannot reach a database. The group may read the report, because
// on a local install the owner reads it through that group; a report is never overwritten.
func inventory(ctx context.Context, args []string, stdout io.Writer) error {
	flags := flag.NewFlagSet("inventory", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	root := flags.String("root", "", "folder to read")
	report := flags.String("report", "", "file to write")
	show := flags.Bool("show-unconfirmed-headers", false, "show first rows nothing proves are headers")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *root == "" || *report == "" || flags.NArg() > 0 {
		return errors.New("usage: inventory --root <folder> --report <file> [--show-unconfirmed-headers]")
	}
	result, err := fileinventory.Scan(ctx, *root, fileinventory.Options{ShowUnconfirmedHeaders: *show})
	if err != nil {
		return err
	}
	body, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		return err
	}
	out, err := os.OpenFile(*report, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o640) //nolint:gosec // see above
	if err != nil {
		return fmt.Errorf("write the report: %w", err)
	}
	if _, err := out.Write(append(body, '\n')); err != nil {
		_ = out.Close()
		_ = os.Remove(*report)
		return fmt.Errorf("write the report: %w", err)
	}
	if err := out.Close(); err != nil {
		return fmt.Errorf("write the report: %w", err)
	}
	result.WriteSummary(stdout)
	return nil
}
