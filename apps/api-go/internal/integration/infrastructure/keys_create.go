package infrastructure

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/integration/domain"
	records "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/domain"
)

const createKey = `INSERT INTO api_keys (tenant_id, name, prefix, secret_hash, access, clearance, created_by, created_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  ON CONFLICT (tenant_id, name) DO NOTHING RETURNING id`

// Create is sql-api-key-store.ts `create`: the insert and its audit row in one owner transaction,
// the audit row written in the tenant (app.tenant_id set for the transaction).
func (k Keys) Create(ctx context.Context, tenantID string, key domain.NewKey, actor string, at time.Time) (id int, created bool, err error) {
	tx, err := k.DB.Begin(ctx)
	if err != nil {
		return 0, false, err
	}
	defer func() {
		if err != nil || !created {
			_ = tx.Rollback(context.WithoutCancel(ctx))
		}
	}()
	// A lone surrogate reaches PostgreSQL as U+FFFD, as the driver's UTF-8 encoding writes it.
	name := records.WellFormed(key.Name)
	err = tx.QueryRow(ctx, createKey, tenantID, name, key.Prefix, key.SecretHash, key.Access, key.Clearance, actor, at).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, err
	}
	if _, err = tx.Exec(ctx, "SELECT set_config('app.tenant_id', $1, true)", tenantID); err != nil {
		return 0, false, err
	}
	detail := "Clave de API «" + name + "» (" + key.Access + ", " + key.Clearance + ") " + key.Prefix
	if _, err = tx.Exec(ctx, appendAudit, at, "Integraciones", "clave-"+itoa(id), "CREATE", detail); err != nil {
		return 0, false, err
	}
	if err = tx.Commit(ctx); err != nil {
		return 0, false, err
	}
	return id, true, nil
}

// KeyCrypto is key-crypto.ts: the random parts of a new key.
type KeyCrypto struct{}

// Prefix is 6 random bytes in hexadecimal.
func (KeyCrypto) Prefix() (string, error) {
	prefix := make([]byte, 6)
	if _, err := rand.Read(prefix); err != nil {
		return "", err
	}
	return hex.EncodeToString(prefix), nil
}

// Secret is 32 random bytes in unpadded base64url.
func (KeyCrypto) Secret() (string, error) {
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(secret), nil
}
