// Package postgres adapts pgx to the dbping ports.
package postgres

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/dreamcoder08/sipges/spikes/go-container/internal/dbping"
)

// Connector opens instrumented pgx connections to one DSN.
type Connector struct {
	dsn string
}

// NewConnector returns a connector for dsn.
func NewConnector(dsn string) Connector { return Connector{dsn: dsn} }

// Connect implements dbping.Connector. TCP covers DNS and the TCP handshake;
// TLS covers the PostgreSQL SSLRequest exchange (unless sslnegotiation=direct)
// plus the TLS handshake, which is forced here because pgx starts it lazily.
func (c Connector) Connect(ctx context.Context) (dbping.Session, dbping.ConnectTimings, error) {
	config, err := pgx.ParseConfig(c.dsn)
	if err != nil {
		// pgx parse errors may echo the DSN; never return them verbatim.
		return nil, dbping.ConnectTimings{}, errors.New("parse database url: invalid connection string")
	}

	var timings dbping.ConnectTimings
	var dialEnd time.Time
	start := time.Now()
	dial := config.DialFunc
	config.DialFunc = func(ctx context.Context, network, addr string) (net.Conn, error) {
		dialStart := time.Now()
		conn, err := dial(ctx, network, addr)
		dialEnd = time.Now()
		timings.TCP = dialEnd.Sub(dialStart)
		return conn, err
	}
	config.AfterNetConnect = func(ctx context.Context, _ *pgconn.Config, conn net.Conn) (net.Conn, error) {
		tlsConn, ok := conn.(*tls.Conn)
		if !ok {
			return conn, nil
		}
		if err := tlsConn.HandshakeContext(ctx); err != nil {
			return nil, fmt.Errorf("tls handshake: %w", err)
		}
		timings.TLS = time.Since(dialEnd)
		return conn, nil
	}

	conn, err := pgx.ConnectConfig(ctx, config)
	if err != nil {
		return nil, dbping.ConnectTimings{}, fmt.Errorf("connect: %w", redact(err))
	}
	timings.Total = time.Since(start)
	return session{conn: conn}, timings, nil
}

// redact keeps the pgconn error class and message but drops anything that
// could carry connection-string credentials.
func redact(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return fmt.Errorf("server error %s: %s", pgErr.Code, pgErr.Message)
	}
	var connectErr *pgconn.ConnectError
	if errors.As(err, &connectErr) {
		return connectErr.Unwrap()
	}
	return err
}

type session struct {
	conn *pgx.Conn
}

func (s session) Ping(ctx context.Context) error {
	var one int
	if err := s.conn.QueryRow(ctx, "SELECT 1").Scan(&one); err != nil {
		return fmt.Errorf("select 1: %w", err)
	}
	if one != 1 {
		return fmt.Errorf("select 1 returned %d", one)
	}
	return nil
}

func (s session) Encrypted() bool {
	_, ok := s.conn.PgConn().Conn().(*tls.Conn)
	return ok
}

func (s session) Close(ctx context.Context) error {
	if err := s.conn.Close(ctx); err != nil {
		return fmt.Errorf("close: %w", err)
	}
	return nil
}
