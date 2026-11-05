package application

import (
	"context"
	"encoding/json"
	"errors"
	"sync"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/intelligence/domain"
	privacy "github.com/Dreamcoder08/sipges/apps/api-go/internal/privacy/application"
	tenancy "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/domain"
)

// The kinds of a semantic analysis' refusal, beside TextError's.
const (
	ErrMode        TextError = "mode"
	ErrURL         TextError = "url"
	ErrUnavailable TextError = "unavailable"
)

const (
	semanticVersion = "2.5"
	egressPurpose   = "semantic-analyze"
	reviewPending   = "Pendiente de corroboración"
	hybridMethod    = "Análisis híbrido: reglas y similitud semántica local. Requiere corroboración."

	rulesSemanticMethod = "Reglas verificables; sin modelo semántico"
	rulesNote           = "Análisis de temas por reglas. No se ha interpretado semánticamente el texto."
	modelSemanticMethod = "Similitud coseno de embeddings del modelo local Ollama"
	modelNote           = "Los valores son similitudes relativas, no probabilidades de conflicto ni pruebas de veracidad."
	rulesOnlyNote       = "Ollama local no disponible; se aplicaron únicamente reglas. El análisis semántico NO se ejecutó."
)

// TextAnalyzer is the rules analysis of a text (Writes).
type TextAnalyzer interface {
	AnalyzeText(ctx context.Context, scope tenancy.Scope, text, sourceURL string) (json.RawMessage, TextError, error)
}

// EgressOpener is the egress guard: the only way a text reaches a model outside this machine.
type EgressOpener interface {
	Open(ctx context.Context, request privacy.Request) (*privacy.Session, error)
}

// Semantic is the semantic analysis of intelligence-service.ts: the rules report, plus the themes
// close in meaning to the text when the model can be used. Egress is nil when SIPGES_DATA_KEY is
// missing: an embedder that is not local then gets nothing.
type Semantic struct {
	Text     TextAnalyzer
	Embedder Embedder
	Egress   EgressOpener

	mu       sync.Mutex
	concepts map[string][]float64 // reference concepts never change for a model
}

type semanticJSON struct {
	Active  bool           `json:"active"`
	Method  string         `json:"method"`
	Model   string         `json:"model,omitempty"`
	Matches []domain.Match `json:"matches"`
	Note    string         `json:"note"`
}

// Analyze is semantic(scope, input). The report is the engine's, with the fields TypeScript sets
// over it. Any failure on the way to the model, the guard's refusal included, leaves the rules
// report in automatic mode and the "unavailable" refusal in semantic mode.
func (s *Semantic) Analyze(ctx context.Context, scope tenancy.Scope, text, sourceURL, mode string) (json.RawMessage, TextError, error) {
	if !domain.IsAnalysisMode(mode) {
		return nil, ErrMode, nil
	}
	if sourceURL != "" && !domain.IsPublicHTTPURL(sourceURL) {
		return nil, ErrURL, nil
	}
	base, kind, err := s.Text.AnalyzeText(ctx, scope, text, sourceURL)
	if err != nil || kind != "" {
		return nil, kind, err
	}
	semantic := semanticJSON{Method: rulesSemanticMethod, Matches: []domain.Match{}, Note: rulesNote}
	method := ""
	if mode != domain.ModeRules {
		matches, err := s.matches(ctx, scope, text)
		switch {
		case err == nil:
			semantic = semanticJSON{
				Active: true, Method: modelSemanticMethod, Model: s.Embedder.Model(), Matches: matches, Note: modelNote,
			}
			method = hybridMethod
		case mode == domain.ModeSemantic:
			return nil, ErrUnavailable, nil
		default:
			semantic.Note = rulesOnlyNote
		}
	}
	fields := []domain.Field{
		{Key: "version", Value: semanticVersion},
		{Key: "semantic", Value: semantic},
		{Key: "verification_status", Value: reviewPending},
		{Key: "source_retrieved", Value: false},
	}
	if method != "" {
		fields = append(fields, domain.Field{Key: "method", Value: method})
	}
	report, err := domain.Overlay(base, fields...)
	return report, "", err
}

func (s *Semantic) matches(ctx context.Context, scope tenancy.Scope, text string) ([]domain.Match, error) {
	cleared, err := s.clear(ctx, scope, domain.TrimJS(text))
	if err != nil {
		return nil, err
	}
	content, concepts, err := s.vectors(ctx, cleared)
	if err != nil {
		return nil, err
	}
	return domain.Rank(content, concepts), nil
}

// clear is the only path of a tenant's text to the embedder: a model on this machine is not egress,
// anything else goes through the guard, or nowhere.
func (s *Semantic) clear(ctx context.Context, scope tenancy.Scope, text string) (privacy.Sanitised[string], error) {
	if s.Embedder.Egress() == EgressLocal {
		return privacy.ExemptPayload(text, privacy.ExemptLoopback), nil
	}
	if s.Egress == nil {
		return privacy.Sanitised[string]{}, privacy.ErrDisabled
	}
	session, err := s.Egress.Open(ctx, privacy.Request{
		TenantID: scope.TenantID(), Channel: privacy.ChannelEmbeddings, Purpose: egressPurpose,
	})
	if err != nil {
		return privacy.Sanitised[string]{}, err
	}
	return privacy.Release(ctx, session, session.Text(text))
}

// vectors embeds the text and any uncached concept concurrently: one model round trip. The first
// failure cancels the others, as the rejected Promise.all stops waiting for them.
func (s *Semantic) vectors(ctx context.Context, cleared privacy.Sanitised[string]) ([]float64, [][]float64, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var (
		wg       sync.WaitGroup
		mu       sync.Mutex
		first    error
		content  []float64
		concepts = make([][]float64, len(domain.SemanticConcepts))
	)
	failed := func(err error) {
		mu.Lock()
		defer mu.Unlock()
		if first == nil {
			first = err
		}
		cancel()
	}
	wg.Go(func() {
		vector, err := s.Embedder.Embed(ctx, cleared)
		if err != nil {
			failed(err)
			return
		}
		content = vector
	})
	for i, concept := range domain.SemanticConcepts {
		wg.Go(func() {
			vector, err := s.conceptVector(ctx, concept.Reference)
			if err != nil {
				failed(err)
				return
			}
			concepts[i] = vector
		})
	}
	wg.Wait()
	if first != nil {
		return nil, nil, first
	}
	if content == nil {
		return nil, nil, errors.New("intelligence: no vector")
	}
	return content, concepts, nil
}

func (s *Semantic) conceptVector(ctx context.Context, reference string) ([]float64, error) {
	s.mu.Lock()
	known, ok := s.concepts[reference]
	s.mu.Unlock()
	if ok {
		return known, nil
	}
	// A reference is written in the code: no tenant data is in it.
	vector, err := s.Embedder.Embed(ctx, privacy.ExemptPayload(reference, privacy.ExemptConstant))
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.concepts == nil {
		s.concepts = map[string][]float64{}
	}
	s.concepts[reference] = vector
	return vector, nil
}
