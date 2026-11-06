package app

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"os"
	"strconv"
	"time"

	documents "github.com/Dreamcoder08/sipges/apps/api-go/internal/documents/application"
	documentshttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/documents/http"
	documentssql "github.com/Dreamcoder08/sipges/apps/api-go/internal/documents/infrastructure"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/evidence/infrastructure/objectstore"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/config"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/doctext"
	records "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/application"
	recordsdomain "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/domain"
	recordssql "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/infrastructure"
)

func init() {
	registerContext("documents", func(d Deps) (func(*http.ServeMux), error) {
		// The upload limit comes from SIPGES_MAX_UPLOAD_BYTES, as in apps/api; an invalid value
		// stops the start.
		maxUpload, err := objectstore.MaxUploadBytes(os.LookupEnv)
		if err != nil {
			return nil, err
		}
		ocr, err := config.LoadOCR(os.LookupEnv)
		if err != nil {
			return nil, err
		}
		now := d.Now
		if now == nil {
			now = time.Now
		}
		service := documents.Service{Store: documentssql.Reviews{DB: d.Pool}}
		lab := documents.Lab{
			Reader:         documentssql.Reader{OCR: doctext.NewOCR(ocr.Enabled, ocr.Languages)},
			Renderer:       documentssql.DocxRenderer{},
			Reviews:        documentssql.Reviews{DB: d.Pool},
			Records:        reviewRecordsPort{store: recordssql.Records{DB: d.Pool}, now: now},
			Now:            now,
			RandomHex:      randomHex,
			MaxUploadBytes: maxUpload,
		}
		return func(mux *http.ServeMux) {
			documentshttp.Routes(mux, service, d.Logger)
			documentshttp.LabRoutes(mux, documentshttp.LabService{Lab: lab}, d.Logger)
		}, nil
	})
}

// reviewRecordsPort is reviewRecordsPort of compose.ts: approvals create records through the
// records use case, so validation, normalization and audit match every other record write
// (docs/adr/0002: the document lab never writes module_records itself).
type reviewRecordsPort struct {
	store records.InsertOnlyWriter
	now   func() time.Time
}

func (p reviewRecordsPort) CreateMissing(ctx context.Context, tenantID, slug string, items []documents.RecordItem, dryRun bool, source string) (documents.RecordCounts, error) {
	module, ok := recordsdomain.ModuleForSlug(slug)
	if !ok {
		return documents.RecordCounts{Problems: []string{"Módulo desconocido: " + slug}}, nil
	}
	missing := make([]records.MissingItem, len(items))
	for i, item := range items {
		fields := recordsdomain.NewObject()
		for _, f := range item.Fields {
			fields.Set(f.Key, f.Value)
		}
		missing[i] = records.MissingItem{ID: item.ID, Fields: fields}
	}
	report, err := records.CreateMissing(ctx, p.store, p.now, tenantID, module, missing, dryRun, source)
	if err != nil {
		return documents.RecordCounts{}, err
	}
	problems := make([]string, len(report.Problems))
	for i, problem := range report.Problems {
		problems[i] = "fila " + strconv.Itoa(problem.Row) + ": " + problem.Message
	}
	return documents.RecordCounts{Created: report.Created, Existing: report.Existing, Problems: problems}, nil
}

// randomHex is randomHex of compose.ts: n lower-case hexadecimal characters from crypto/rand.
func randomHex(n int) (string, error) {
	b := make([]byte, (n+1)/2)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b)[:n], nil
}
