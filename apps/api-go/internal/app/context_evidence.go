package app

import (
	"net/http"
	"os"

	evidencehttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/evidence/http"
	evidenceinfra "github.com/Dreamcoder08/sipges/apps/api-go/internal/evidence/infrastructure"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/evidence/infrastructure/objectstore"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/config"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/doctext"
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
		ocr, err := config.LoadOCR(os.LookupEnv)
		if err != nil {
			return nil, err
		}
		return func(mux *http.ServeMux) {
			evidencehttp.Register(mux, evidencehttp.Deps{
				Text:           evidenceinfra.DocText{OCR: doctext.NewOCR(ocr.Enabled, ocr.Languages)},
				DB:             d.Pool,
				Logger:         d.Logger,
				Storage:        storage,
				MaxUploadBytes: maxUpload,
				Now:            d.Now,
			})
		}, nil
	})
}
