package application

import (
	"context"
	"errors"
	"fmt"
	"slices"
)

// The kinds of failure a tick reports: what an operator can tell from the logs, where the text of
// an error may name a feed or a channel and stays out.
var (
	ErrPanicked = errors.New("tick panicked")
	ErrPolling  = errors.New("polling failed")
	ErrStore    = errors.New("attempt bookkeeping failed")
)

// failure tags err with its kind. Its one Unwrap keeps the chain and marks where Failures stops
// splitting: only errors.Join has many.
type failure struct{ kind, err error }

func (f failure) Error() string        { return f.kind.Error() + ": " + f.err.Error() }
func (f failure) Unwrap() error        { return f.err }
func (f failure) Is(target error) bool { return target == f.kind }

func panicked(r any) error { return failure{ErrPanicked, fmt.Errorf("%v", r)} }

// Failures classifies a failed run, one sorted class per failure (each tenant's, as Scheduled
// joins them): panic, store, polling, polling_cancelled, timeout or rules.
func Failures(err error) []string {
	if err == nil {
		return nil
	}
	var classes []string
	if joined, ok := err.(interface{ Unwrap() []error }); ok {
		for _, e := range joined.Unwrap() {
			classes = append(classes, Failures(e)...)
		}
	} else {
		classes = []string{class(err)}
	}
	slices.Sort(classes)
	return classes
}

func class(err error) string {
	switch {
	case errors.Is(err, ErrPanicked):
		return "panic"
	case errors.Is(err, ErrStore):
		return "store"
	case errors.Is(err, ErrPolling) && errors.Is(err, context.Canceled):
		return "polling_cancelled" // a shutdown cuts the polling short on purpose
	case errors.Is(err, ErrPolling):
		return "polling"
	case errors.Is(err, context.DeadlineExceeded):
		return "timeout"
	}
	return "rules"
}
