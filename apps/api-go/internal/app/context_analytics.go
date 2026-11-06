package app

import (
	"net/http"
	"time"

	analytics "github.com/Dreamcoder08/sipges/apps/api-go/internal/analytics/domain"
	analyticshttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/analytics/http"
	documents "github.com/Dreamcoder08/sipges/apps/api-go/internal/documents/domain"
	documentssql "github.com/Dreamcoder08/sipges/apps/api-go/internal/documents/infrastructure"
)

func init() {
	registerContext("analytics", func(d Deps) (func(*http.ServeMux), error) {
		return func(mux *http.ServeMux) {
			analyticshttp.Register(mux, analyticshttp.Deps{
				Pool: d.Pool, Engine: d.Engines.Analytics, Renderer: reportRenderer{}, Logger: d.Logger, Now: d.Now,
			})
		}, nil
	})
}

// reportRenderer lends analytics the document lab's Word renderer, as compose.ts hands one
// docxRenderer to both contexts.
type reportRenderer struct{}

func (reportRenderer) ContentType() string { return documentssql.DocxRenderer{}.ContentType() }

func (reportRenderer) Render(blocks []analytics.ReportBlock, at time.Time) ([]byte, error) {
	out := make([]documents.ReportBlock, len(blocks))
	for i, b := range blocks {
		out[i] = documents.ReportBlock{Kind: documents.BlockKind(b.Kind), Level: b.Level, Text: b.Text}
	}
	return documentssql.DocxRenderer{}.Render(out, at)
}
