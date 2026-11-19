package pglitemove

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"net"
	"os"
	"syscall"

	"github.com/jackc/pgx/v5/pgconn"
)

// errnoNames are the file system and socket errors a move meets, by their usual names.
var errnoNames = []struct {
	err  error
	name string
}{
	{fs.ErrNotExist, "ENOENT"}, {fs.ErrPermission, "EACCES"}, {fs.ErrExist, "EEXIST"},
	{syscall.ENOSPC, "ENOSPC"}, {syscall.EBUSY, "EBUSY"}, {syscall.EROFS, "EROFS"},
	{syscall.ENOTEMPTY, "ENOTEMPTY"}, {syscall.EIO, "EIO"},
	{syscall.ECONNREFUSED, "ECONNREFUSED"}, {syscall.ECONNRESET, "ECONNRESET"},
	{syscall.ETIMEDOUT, "ETIMEDOUT"}, {syscall.EHOSTUNREACH, "EHOSTUNREACH"},
	{syscall.ENETUNREACH, "ENETUNREACH"}, {syscall.EPIPE, "EPIPE"},
}

// errnoName names a system error, "error" when it has no usual name.
func errnoName(err error) string {
	for _, e := range errnoNames {
		if errors.Is(err, e.err) {
			return e.name
		}
	}
	return "error"
}

func sqlstate(err error) string {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code
	}
	return "?"
}

// connectionError tells a broken or unreachable connection apart from an answer of the server.
func connectionError(err error) bool {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return false
	}
	var netErr net.Error
	var opErr *net.OpError
	return errors.As(err, &netErr) || errors.As(err, &opErr) || errors.Is(err, io.EOF) ||
		errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, net.ErrClosed) ||
		errors.Is(err, syscall.ECONNREFUSED) || errors.Is(err, syscall.ECONNRESET) ||
		errors.Is(err, syscall.EPIPE) || errors.Is(err, context.DeadlineExceeded) || pgconn.Timeout(err)
}

// failureCode names a connection failure: its errno, CONNECT_TIMEOUT, or CONNECTION_CLOSED.
func failureCode(err error) string {
	if name := errnoName(err); name != "error" {
		return name
	}
	if pgconn.Timeout(err) || errors.Is(err, context.DeadlineExceeded) {
		return "CONNECT_TIMEOUT"
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return "SQLSTATE " + pgErr.Code
	}
	return "CONNECTION_CLOSED"
}

// safeReason is why a run stopped, without any text PGlite, pg_dump or SQL could carry
// (tables.mjs safeReason).
func safeReason(err error) string {
	var r *Refusal
	if errors.As(err, &r) {
		return r.msg
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return "the database could not be read (SQLSTATE " + pgErr.Code + ")"
	}
	var pathErr *fs.PathError
	if errors.As(err, &pathErr) {
		return "file system error " + errnoName(err) + " (" + pathErr.Op + ")"
	}
	var linkErr *os.LinkError
	if errors.As(err, &linkErr) {
		return "file system error " + errnoName(err) + " (" + linkErr.Op + ")"
	}
	if connectionError(err) {
		return "the connection failed (" + failureCode(err) + "); nothing was committed"
	}
	return "unexpected error"
}
