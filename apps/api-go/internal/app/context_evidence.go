package app

import (
	"net/http"
	"os"

	evidencehttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/evidence/http"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/evidence/infrastructure/objectstore"
)

func init() {
	registerContext("evidence", func(d Deps) (func(*http.ServeMux), error) {
		// The object storage and upload limit come from the same variables as apps/api
		// (SIPGES_STORAGE, SIPGES_UPLOAD_DIR, SIPGES_S3_*, SIPGES_MAX_UPLOAD_BYTES); an invalid
		// setting stops the start, as it does there.
		storage, err := objectstore.FromEnv(os.LookupEnv)
		if err != nil {
			return nil, err
		}
		maxUpload, err := objectstore.MaxUploadBytes(os.LookupEnv)
		if err != nil {
			return nil, err
		}
		return func(mux *http.ServeMux) {
			evidencehttp.Register(mux, evidencehttp.Deps{
				DB:             d.Pool,
				Logger:         d.Logger,
				Storage:        storage,
				MaxUploadBytes: maxUpload,
				Now:            d.Now,
			})
		}, nil
	})
}
