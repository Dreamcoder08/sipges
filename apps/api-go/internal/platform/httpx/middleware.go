package httpx

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"time"
)

// Middleware wraps a handler.
type Middleware func(http.Handler) http.Handler

// Chain applies middleware so that the first one listed runs first.
func Chain(h http.Handler, middleware ...Middleware) http.Handler {
	for _, m := range slices.Backward(middleware) {
		h = m(h)
	}
	return h
}

type requestIDKey struct{}

// RequestIDFrom returns the id RequestID gave the request.
func RequestIDFrom(ctx context.Context) string {
	id, _ := ctx.Value(requestIDKey{}).(string)
	return id
}

// safeRequestID keeps a caller-supplied id only when it cannot smuggle anything into logs.
var safeRequestID = regexp.MustCompile(`^[A-Za-z0-9._-]{8,64}$`)

// RequestID keeps a safe X-Request-Id or makes a UUID v4, and echoes it on the response.
func RequestID() Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			id := r.Header.Get("X-Request-Id")
			if !safeRequestID.MatchString(id) {
				id = newUUID()
			}
			w.Header().Set("X-Request-Id", id)
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), requestIDKey{}, id)))
		})
	}
}

func newUUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:]) // crypto/rand.Read never fails (Go 1.24+)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// statusRecorder remembers the status a handler wrote.
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(status int) {
	if s.status == 0 {
		s.status = status
	}
	s.ResponseWriter.WriteHeader(status)
}

func (s *statusRecorder) Write(b []byte) (int, error) {
	if s.status == 0 {
		s.status = http.StatusOK
	}
	return s.ResponseWriter.Write(b)
}

// Unwrap lets http.ResponseController reach the underlying writer (flush, deadlines).
func (s *statusRecorder) Unwrap() http.ResponseWriter { return s.ResponseWriter }

// AccessLog writes one line per request: method, path without query string, status, duration
// and request id. No headers, query strings or bodies: they may carry tokens or record data.
func AccessLog(log *slog.Logger) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			rec := &statusRecorder{ResponseWriter: w}
			next.ServeHTTP(rec, r)
			log.LogAttrs(r.Context(), slog.LevelInfo, "request",
				slog.String("request_id", RequestIDFrom(r.Context())),
				slog.String("method", r.Method),
				slog.String("path", r.URL.Path),
				slog.Int("status", rec.status),
				slog.Float64("duration_ms", float64(time.Since(start).Microseconds())/1000))
		})
	}
}

// Recover turns a panic into the 500 error contract and logs it without the request body.
func Recover(log *slog.Logger) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer recoverPanic(w, r, log)
			next.ServeHTTP(w, r)
		})
	}
}

func recoverPanic(w http.ResponseWriter, r *http.Request, log *slog.Logger) {
	v := recover()
	if v == nil {
		return
	}
	if err, ok := v.(error); ok && errors.Is(err, http.ErrAbortHandler) {
		panic(v) // the server's own signal to abort the response
	}
	log.LogAttrs(r.Context(), slog.LevelError, "panic",
		slog.String("request_id", RequestIDFrom(r.Context())),
		slog.String("panic", fmt.Sprint(v)))
	WriteError(w, http.StatusInternalServerError, "Internal Server Error")
}

// HostAllowlist rejects requests whose Host is not an expected public name (DNS rebinding,
// host-header poisoning), as in the TypeScript API. An empty list disables it.
func HostAllowlist(allowed []string) Middleware {
	return func(next http.Handler) http.Handler {
		if len(allowed) == 0 {
			return next
		}
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !slices.Contains(allowed, hostName(r.Host)) {
				WriteError(w, http.StatusBadRequest, "Host no permitido")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// hostName is the host of a Host header without port; IPv6 literals keep their brackets.
func hostName(header string) string {
	value := strings.ToLower(strings.TrimSpace(header))
	if strings.HasPrefix(value, "[") {
		if end := strings.IndexByte(value, ']'); end >= 0 {
			return value[:end+1]
		}
		return value
	}
	host, _, _ := strings.Cut(value, ":")
	return host
}
