package database

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// tenantQuerier sends the tenant statement in one pipeline with the work's first query:
//
//	Parse/Bind/Execute(tenant) Sync Parse/Bind/Execute(first query) Sync
//
// written in one flush. The Sync between them is what keeps the TypeScript semantics: if the
// tenant statement fails, the transaction is aborted and PostgreSQL answers the first query
// with 25P02 instead of running it. A pgx.Batch cannot do this: in simple-protocol mode it
// joins the statements into one query string, and in extended mode it sends a single Sync, so
// either way the second statement is skipped rather than rejected with its own error.
//
// The tenant statement has no parameters, so the extended protocol costs no extra round trip
// (the reason the TypeScript API needed the simple protocol). The first query is encoded as
// pgx's QueryExecModeExec does; later queries go straight to the transaction.
type tenantQuerier struct {
	tx        pgx.Tx
	statement string
	// sent is true once the tenant statement went to the server.
	sent     bool
	enterErr error
	// pipeline is open while the rows of the first query are being read.
	pipeline *pgconn.Pipeline
	rows     *pipelinedRows
}

func (q *tenantQuerier) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	if q.sent {
		return q.tx.Exec(ctx, sql, args...)
	}
	// pgx runs an Exec without arguments with the simple protocol, which allows several
	// statements; the extended protocol does not. Enter first to keep that behaviour.
	eqb, ok := q.encodable(args)
	if len(args) == 0 || !ok {
		if err := q.enterAlone(ctx); err != nil {
			return pgconn.CommandTag{}, err
		}
		return q.tx.Exec(ctx, sql, args...)
	}
	reader, err := q.send(ctx, sql, eqb)
	if err != nil {
		return pgconn.CommandTag{}, err
	}
	tag, err := reader.Close()
	return tag, errors.Join(err, q.finishPipeline())
}

func (q *tenantQuerier) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	if q.sent {
		return q.tx.Query(ctx, sql, args...)
	}
	eqb, ok := q.encodable(args)
	if !ok {
		if err := q.enterAlone(ctx); err != nil {
			return nil, err
		}
		return q.tx.Query(ctx, sql, args...)
	}
	reader, err := q.send(ctx, sql, eqb)
	if err != nil {
		return nil, err
	}
	q.rows = &pipelinedRows{Rows: pgx.RowsFromResultReader(q.tx.Conn().TypeMap(), reader), q: q}
	return q.rows, nil
}

func (q *tenantQuerier) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	if q.sent {
		return q.tx.QueryRow(ctx, sql, args...)
	}
	rows, err := q.Query(ctx, sql, args...)
	return &row{rows: rows, err: err}
}

// encodable encodes args the way pgx's QueryExecModeExec does, which needs no statement
// description and so no extra round trip. It reports false for anything pgx handles before
// encoding (NamedArgs and other rewriters, exec-mode and result-format options) and for values
// that need the statement's parameter types (a map for jsonb, for example): those queries take
// the ordinary pgx path after entering alone, one round trip more but the same behaviour as a
// pgx.Tx.
func (q *tenantQuerier) encodable(args []any) (*pgx.ExtendedQueryBuilder, bool) {
	for _, arg := range args {
		switch arg.(type) {
		case pgx.QueryRewriter, pgx.QueryExecMode, pgx.QueryResultFormats, pgx.QueryResultFormatsByOID:
			return nil, false
		}
	}
	eqb := &pgx.ExtendedQueryBuilder{}
	if err := eqb.Build(q.tx.Conn().TypeMap(), nil, args); err != nil {
		return nil, false
	}
	return eqb, true
}

// enterAlone sends the tenant statement by itself.
func (q *tenantQuerier) enterAlone(ctx context.Context) error {
	q.sent = true
	q.enterErr = enter(ctx, q.tx, q.statement)
	return q.enterErr
}

// send pipelines the tenant statement with the first query and returns the first query's
// reader. When entering fails it records the failure and returns the first query's own error
// (25P02), so nothing from the work's query is ever returned.
func (q *tenantQuerier) send(ctx context.Context, sql string, eqb *pgx.ExtendedQueryBuilder) (*pgconn.ResultReader, error) {
	q.sent = true
	p := q.tx.Conn().PgConn().StartPipeline(ctx)
	q.pipeline = p
	p.SendQueryParams(q.statement, nil, nil, nil, nil)
	p.SendPipelineSync()
	p.SendQueryParams(sql, eqb.ParamValues, nil, eqb.ParamFormats, eqb.ResultFormats)
	p.SendPipelineSync()
	if err := p.Flush(); err != nil {
		q.enterErr = err
		return nil, errors.Join(err, q.finishPipeline())
	}

	if q.enterErr = readResult(p); q.enterErr != nil && !isPgError(q.enterErr) {
		return nil, errors.Join(q.enterErr, q.finishPipeline()) // connection lost
	}
	if err := readSync(p); err != nil {
		q.enterErr = errors.Join(q.enterErr, err)
		return nil, errors.Join(err, q.finishPipeline())
	}
	results, err := p.GetResults()
	if err != nil {
		return nil, errors.Join(err, q.finishPipeline())
	}
	reader, ok := results.(*pgconn.ResultReader)
	if !ok {
		err := fmt.Errorf("pipeline: unexpected result %T for the first query", results)
		return nil, errors.Join(err, q.finishPipeline())
	}
	return reader, nil
}

// finishPipeline reads what is left of the pipeline and returns the connection to normal mode.
// It runs when the first query's rows end and, as a safety net, after the work returns.
func (q *tenantQuerier) finishPipeline() error {
	p := q.pipeline
	if p == nil {
		return nil
	}
	q.pipeline = nil
	if q.rows != nil {
		q.rows.Rows.Close()
		q.rows = nil
	}
	var errs []error
	for {
		results, err := p.GetResults()
		if err != nil {
			if !isPgError(err) {
				// The connection is gone; Close would only repeat it.
				_ = p.Close()
				return errors.Join(append(errs, err)...)
			}
			errs = append(errs, err)
			continue
		}
		if results == nil {
			break
		}
		if reader, ok := results.(*pgconn.ResultReader); ok {
			if _, err := reader.Close(); err != nil {
				errs = append(errs, err)
			}
		}
	}
	errs = append(errs, p.Close())
	return errors.Join(errs...)
}

func readResult(p *pgconn.Pipeline) error {
	results, err := p.GetResults()
	if err != nil {
		return err
	}
	reader, ok := results.(*pgconn.ResultReader)
	if !ok {
		return fmt.Errorf("pipeline: unexpected result %T for the tenant statement", results)
	}
	_, err = reader.Close()
	return err
}

func readSync(p *pgconn.Pipeline) error {
	results, err := p.GetResults()
	if err != nil {
		return err
	}
	if _, ok := results.(*pgconn.PipelineSync); !ok {
		return fmt.Errorf("pipeline: unexpected result %T, want a sync", results)
	}
	return nil
}

func isPgError(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr)
}

// pipelinedRows streams the first query's rows and closes the pipeline when they end.
type pipelinedRows struct {
	pgx.Rows
	q      *tenantQuerier
	closed bool
	err    error
}

func (r *pipelinedRows) Next() bool {
	if r.Rows.Next() {
		return true
	}
	r.finish()
	return false
}

func (r *pipelinedRows) Close() {
	r.Rows.Close()
	r.finish()
}

func (r *pipelinedRows) Err() error {
	if err := r.Rows.Err(); err != nil {
		return err
	}
	return r.err
}

func (r *pipelinedRows) finish() {
	if r.closed {
		return
	}
	r.closed = true
	if r.q.rows == r {
		r.q.rows = nil
	}
	r.err = r.q.finishPipeline()
}

// row gives QueryRow the semantics of pgx: ErrNoRows when empty, rows closed after Scan.
type row struct {
	rows pgx.Rows
	err  error
}

func (r *row) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	defer r.rows.Close()
	if !r.rows.Next() {
		if err := r.rows.Err(); err != nil {
			return err
		}
		return pgx.ErrNoRows
	}
	if err := r.rows.Scan(dest...); err != nil {
		return err
	}
	r.rows.Close()
	return r.rows.Err()
}
