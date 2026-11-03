package httpx

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"time"
)

// NewServer returns an http.Server with timeouts that bound slow clients.
func NewServer(h http.Handler) *http.Server {
	return &http.Server{
		Handler:           h,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second,
		WriteTimeout:      120 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    64 << 10,
	}
}

// Serve runs srv on ln until ctx ends, then stops accepting connections and waits up to grace
// for in-flight requests before closing what is left.
func Serve(ctx context.Context, srv *http.Server, ln net.Listener, grace time.Duration) error {
	errc := make(chan error, 1)
	go func() { errc <- srv.Serve(ln) }()
	select {
	case err := <-errc:
		return fmt.Errorf("serve: %w", err)
	case <-ctx.Done():
	}
	shutdownCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), grace)
	defer cancel()
	err := srv.Shutdown(shutdownCtx)
	if serveErr := <-errc; !errors.Is(serveErr, http.ErrServerClosed) {
		err = errors.Join(err, serveErr)
	}
	if err != nil {
		return errors.Join(fmt.Errorf("shutdown: %w", err), srv.Close())
	}
	return nil
}
