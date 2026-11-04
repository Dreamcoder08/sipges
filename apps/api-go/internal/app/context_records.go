package app

import (
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"strings"
	"time"

	records "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/application"
	recordshttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/http"
	recordssql "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/infrastructure"
)

func init() {
	registerContext("records", func(d Deps) (func(*http.ServeMux), error) {
		store := recordssql.Records{DB: d.Pool}
		service := records.Service{Store: store}
		now := d.Now
		if now == nil {
			now = time.Now
		}
		writes := records.Writes{Store: store, Now: now, RandomHex: randomHexUpper}
		return func(mux *http.ServeMux) {
			recordshttp.Register(mux, service, d.Logger)
			recordshttp.RegisterWrites(mux, writes, d.Logger)
		}, nil
	})
}

// randomHexUpper is the records service's randomHex of apps/api/src/compose.ts: crypto-random
// hexadecimal digits, upper case.
func randomHexUpper(length int) string {
	b := make([]byte, (length+1)/2)
	_, _ = rand.Read(b) // crypto/rand.Read never fails (Go 1.24+)
	return strings.ToUpper(hex.EncodeToString(b)[:length])
}
