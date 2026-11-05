package app

import (
	"errors"
	"net/http"
	"os"

	intelligencesql "github.com/Dreamcoder08/sipges/apps/api-go/internal/intelligence/infrastructure"
	ontology "github.com/Dreamcoder08/sipges/apps/api-go/internal/ontology/application"
	ontologyhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/ontology/http"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/config"
)

func init() {
	registerContext("ontology", func(d Deps) (func(*http.ServeMux), error) {
		semantic, err := semanticSearch(d)
		if err != nil {
			return nil, err
		}
		return func(mux *http.ServeMux) {
			ontologyhttp.Register(mux, ontologyhttp.Deps{DB: d.Pool, Logger: d.Logger, Now: d.Now, Semantic: semantic})
		}, nil
	})
}

// semanticSearch is the semantic half of search; nil unless SIPGES_SEMANTIC_SEARCH is on. Without
// SIPGES_DATA_KEY there is no guard, so a text goes to a local model or nowhere.
func semanticSearch(d Deps) (*ontology.Semantic, error) {
	ollama, err := config.LoadOllama(os.LookupEnv)
	if err != nil || !ollama.SemanticSearch {
		return nil, err
	}
	embedder, err := intelligencesql.NewOllama(ollama.BaseURL, ollama.Model)
	if err != nil {
		return nil, err
	}
	semantic := &ontology.Semantic{Embedder: embedder, Now: d.Now}
	guard, err := egressGuard(d)
	switch {
	case err == nil:
		semantic.Egress = guard
	case !errors.Is(err, config.ErrNoDataKey):
		return nil, err
	}
	return semantic, nil
}
