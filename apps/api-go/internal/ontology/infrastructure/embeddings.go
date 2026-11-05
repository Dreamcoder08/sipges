package infrastructure

import (
	"context"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/ontology/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/ontology/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
)

const staleEmbeddings = `SELECT r.module, r.id, r.payload, r.marking, md5(r.payload::text) AS hash FROM module_records r
  LEFT JOIN record_embeddings e
    ON e.tenant_id = r.tenant_id AND e.module = r.module AND e.id = r.id
  WHERE r.marking <> 'restringido'
    AND (e.id IS NULL OR e.model <> $1 OR e.source_hash <> md5(r.payload::text))
  ORDER BY r.updated_at, r.module, r.id LIMIT $2`

// saveEmbedding stores the hash of the payload that was read: a concurrent edit makes it stale again.
const saveEmbedding = `INSERT INTO record_embeddings
    (tenant_id, module, id, model, vector, source_hash, embedded_at)
  VALUES (current_setting('app.tenant_id', true), $1, $2, $3, $4::real[], $5, $6)
  ON CONFLICT (tenant_id, module, id)
  DO UPDATE SET model = EXCLUDED.model, vector = EXCLUDED.vector,
                source_hash = EXCLUDED.source_hash, embedded_at = EXCLUDED.embedded_at`

// storedVectors joins module_records to apply its visibility policy to the embeddings. The vector
// is read as text: real values then parse to the float64 JavaScript's Number gives.
const storedVectors = `SELECT e.module, e.id, e.vector::text FROM record_embeddings e
  JOIN module_records r ON r.tenant_id = e.tenant_id AND r.module = e.module AND r.id = e.id
  WHERE e.model = $1 AND e.module = ANY($2::text[])
  ORDER BY r.updated_at DESC LIMIT $3`

// EmbeddingIndex is sql-embedding-index.ts, inside one tenant transaction.
type EmbeddingIndex struct {
	Q database.Querier
}

// Stale implements application.EmbeddingIndex.
func (i EmbeddingIndex) Stale(ctx context.Context, model string, limit int) ([]application.EmbeddingSource, error) {
	rows, err := i.Q.Query(ctx, staleEmbeddings, model, limit)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (application.EmbeddingSource, error) {
		var (
			source  application.EmbeddingSource
			payload []byte
		)
		if err := row.Scan(&source.Module, &source.ID, &payload, &source.Marking, &source.Hash); err != nil {
			return source, err
		}
		if source.Payload, err = domain.DecodePayload(payload); err != nil {
			return source, err
		}
		source.Entries, err = domain.OrderedEntries(payload)
		return source, err
	})
}

// Save implements application.EmbeddingIndex.
func (i EmbeddingIndex) Save(ctx context.Context, rows []application.EmbeddingRow, model string, at time.Time) error {
	for _, row := range rows {
		_, err := i.Q.Exec(ctx, saveEmbedding, row.Module, row.ID, model, domain.VectorText(row.Vector), row.Hash, at)
		if err != nil {
			return err
		}
	}
	return nil
}

// Vectors implements application.EmbeddingIndex.
func (i EmbeddingIndex) Vectors(ctx context.Context, modules []string, model string, limit int) ([]application.StoredVector, error) {
	rows, err := i.Q.Query(ctx, storedVectors, model, modules, limit)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (application.StoredVector, error) {
		var (
			stored application.StoredVector
			text   string
		)
		if err := row.Scan(&stored.Module, &stored.ID, &text); err != nil {
			return stored, err
		}
		stored.Vector, err = parseVector(text)
		return stored, err
	})
}

func parseVector(text string) ([]float64, error) {
	parts := strings.Split(strings.Trim(text, "{}"), ",")
	vector := make([]float64, len(parts))
	for i, part := range parts {
		value, err := strconv.ParseFloat(part, 64)
		if err != nil {
			return nil, err
		}
		vector[i] = value
	}
	return vector, nil
}
