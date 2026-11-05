package application

import (
	"context"
	"errors"
	"slices"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/ontology/domain"
	privacy "github.com/Dreamcoder08/sipges/apps/api-go/internal/privacy/application"
	privacydomain "github.com/Dreamcoder08/sipges/apps/api-go/internal/privacy/domain"
	js "github.com/Dreamcoder08/sipges/apps/api-go/internal/situations/domain"
)

// Where an embedder runs. Local is loopback, not egress; anything else is treated as external.
const (
	EgressLocal    = "local"
	EgressExternal = "external"
)

const (
	// EmbedBatch is how many records one search embeds, so a project indexes itself gradually.
	EmbedBatch = 16
	// MaxVectors is how many embeddings one search compares.
	MaxVectors = 5000

	purposeIndex  = "index"
	purposeSearch = "search"
)

// Embedder gives text embeddings from a model. It accepts only a cleared payload, so a record
// bound for a model outside this machine cannot skip the egress guard (docs/adr/0030).
type Embedder interface {
	Model() string
	Egress() string
	Embed(ctx context.Context, text privacy.Sanitised[string]) ([]float64, error)
}

// EgressOpener is the egress guard: the only way a text reaches a model outside this machine.
type EgressOpener interface {
	Open(ctx context.Context, request privacy.Request) (*privacy.Session, error)
}

// EmbeddingSource is a record with its text, ready to embed. Payload reads fields by name; Entries
// keep the order JavaScript gives them.
type EmbeddingSource struct {
	NodeRef
	Payload domain.Payload
	Entries []domain.Entry
	Marking string
	// Hash is an opaque version of the payload, stored with the vector to detect changes.
	Hash string
}

// EmbeddingRow is one computed embedding.
type EmbeddingRow struct {
	NodeRef
	Vector []float64
	Hash   string
}

// StoredVector is a stored embedding.
type StoredVector struct {
	NodeRef
	Vector []float64
}

// EmbeddingIndex is the stored record embeddings (docs/adr/0014 §9).
type EmbeddingIndex interface {
	// Stale gives records without an embedding from model, or changed since it was computed,
	// oldest first. Restricted records are never embedded, so their text never reaches the model.
	Stale(ctx context.Context, model string, limit int) ([]EmbeddingSource, error)
	Save(ctx context.Context, rows []EmbeddingRow, model string, at time.Time) error
	// Vectors gives the visible records of modules with an embedding from model.
	Vectors(ctx context.Context, modules []string, model string, limit int) ([]StoredVector, error)
}

// InTenant runs one step in its own tenant transaction. A model call can take seconds, so no
// transaction stays open across one.
type InTenant func(work func(ctx context.Context, index EmbeddingIndex) error) error

// Semantic is the semantic half of search in ontology-service.ts. Egress is nil when
// SIPGES_DATA_KEY is missing: an embedder that is not local then gets nothing.
type Semantic struct {
	Embedder Embedder
	Egress   EgressOpener
	Now      func() time.Time
}

// session is egressFor: nil for a local model, which is not egress.
func (s *Semantic) session(ctx context.Context, tenantID, purpose string) (*privacy.Session, error) {
	if s.Embedder.Egress() == EgressLocal {
		return nil, nil
	}
	if s.Egress == nil {
		return nil, privacy.ErrDisabled
	}
	return s.Egress.Open(ctx, privacy.Request{TenantID: tenantID, Channel: privacy.ChannelEmbeddings, Purpose: purpose})
}

// Refs is semanticRefsFor: records closest in meaning to raw, best first. The caller keeps its
// lexical result on any error.
func (s *Semantic) Refs(ctx context.Context, tenantID, raw string, modules []string, limit int, tx InTenant) ([]NodeRef, error) {
	if err := s.refresh(ctx, tenantID, tx); err != nil {
		return nil, err
	}
	cleared, err := s.query(ctx, tenantID, js.TrimJS(raw))
	if err != nil {
		return nil, err
	}
	query, err := s.Embedder.Embed(ctx, cleared)
	if err != nil {
		return nil, err
	}
	var vectors []StoredVector
	err = tx(func(ctx context.Context, index EmbeddingIndex) (err error) {
		vectors, err = index.Vectors(ctx, modules, s.Embedder.Model(), MaxVectors)
		return err
	})
	if err != nil {
		return nil, err
	}
	return closest(query, vectors, limit), nil
}

func (s *Semantic) query(ctx context.Context, tenantID, raw string) (privacy.Sanitised[string], error) {
	session, err := s.session(ctx, tenantID, purposeSearch)
	if err != nil {
		return privacy.Sanitised[string]{}, err
	}
	if session == nil {
		return privacy.ExemptPayload(raw, privacy.ExemptLoopback), nil
	}
	return privacy.Release(ctx, session, session.Text(raw))
}

type scored struct {
	ref   NodeRef
	score float64
}

func closest(query []float64, vectors []StoredVector, limit int) []NodeRef {
	found := []scored{}
	for _, v := range vectors {
		if score := domain.Cosine(query, v.Vector); score >= domain.MinSimilarity {
			found = append(found, scored{v.NodeRef, score})
		}
	}
	slices.SortStableFunc(found, func(a, b scored) int {
		switch {
		case a.score > b.score:
			return -1
		case a.score < b.score:
			return 1
		}
		return 0
	})
	refs := make([]NodeRef, 0, min(len(found), limit))
	for _, f := range found[:min(len(found), limit)] {
		refs = append(refs, f.ref)
	}
	return refs
}

type staleRecord struct {
	source EmbeddingSource
	kind   domain.ObjectType
}

// refresh is refreshEmbeddings. A record the guard withholds is not embedded; it stays stale until
// it may be.
func (s *Semantic) refresh(ctx context.Context, tenantID string, tx InTenant) error {
	var sources []EmbeddingSource
	err := tx(func(ctx context.Context, index EmbeddingIndex) (err error) {
		sources, err = index.Stale(ctx, s.Embedder.Model(), EmbedBatch)
		return err
	})
	if err != nil {
		return err
	}
	stale := make([]staleRecord, 0, len(sources))
	for _, source := range sources {
		if kind, ok := domain.ObjectTypeForModule(source.Module); ok {
			stale = append(stale, staleRecord{source, kind})
		}
	}
	if len(stale) == 0 {
		return nil
	}
	session, err := s.session(ctx, tenantID, purposeIndex)
	if err != nil {
		return err
	}
	ready, cleared, err := clearRecords(ctx, session, stale)
	if err != nil {
		return err
	}
	rows := make([]EmbeddingRow, 0, len(ready))
	for i, source := range ready {
		vector, err := s.Embedder.Embed(ctx, cleared[i])
		if err != nil {
			return err
		}
		rows = append(rows, EmbeddingRow{NodeRef: source.NodeRef, Vector: vector, Hash: source.Hash})
	}
	if len(rows) == 0 {
		return nil
	}
	now := time.Now
	if s.Now != nil {
		now = s.Now
	}
	return tx(func(ctx context.Context, index EmbeddingIndex) error {
		// JavaScript dates hold milliseconds: store the instant the TypeScript API would.
		return index.Save(ctx, rows, s.Embedder.Model(), now().Truncate(time.Millisecond))
	})
}

// clearRecords gives the records that may be embedded and their cleared texts: for a local model
// the records as they are, for any other only what the guard's session lets out.
func clearRecords(ctx context.Context, session *privacy.Session, stale []staleRecord) ([]EmbeddingSource, []privacy.Sanitised[string], error) {
	ready := make([]EmbeddingSource, 0, len(stale))
	if session == nil {
		cleared := make([]privacy.Sanitised[string], 0, len(stale))
		for _, item := range stale {
			title := domain.TitleOf(item.kind, item.source.ID, item.source.Payload)
			text := domain.EmbeddingText(item.kind.Label, string(title), item.source.Entries)
			ready = append(ready, item.source)
			cleared = append(cleared, privacy.ExemptPayload(text, privacy.ExemptLoopback))
		}
		return ready, cleared, nil
	}
	raw := make([]privacydomain.RawRecord, 0, len(stale))
	for _, item := range stale {
		raw = append(raw, rawRecord(item))
	}
	sanitised := session.Records(raw)
	if len(sanitised) != len(stale) {
		return nil, nil, errors.New("ontology: the guard lost a record")
	}
	texts := make([]string, 0, len(stale))
	for i, clean := range sanitised {
		if clean.Withheld {
			continue
		}
		ready = append(ready, stale[i].source)
		texts = append(texts, domain.EmbeddingText(stale[i].kind.Label, cleanTitle(clean), cleanEntries(clean)))
	}
	cleared, err := privacy.ReleaseMany(ctx, session, texts)
	if err != nil {
		return nil, nil, err
	}
	return ready, cleared, nil
}

func rawRecord(item staleRecord) privacydomain.RawRecord {
	title := string(domain.TitleOf(item.kind, item.source.ID, item.source.Payload))
	marking := item.source.Marking
	fields := make([]privacydomain.RawField, 0, len(item.source.Entries))
	for _, entry := range item.source.Entries {
		fields = append(fields, privacydomain.RawField{Name: entry.Name, Value: entry.Value})
	}
	return privacydomain.RawRecord{
		Module: item.kind.Slug, ID: item.source.ID, Title: &title, Marking: &marking, Fields: fields,
	}
}

func cleanTitle(clean privacydomain.SanitisedRecord) string {
	if clean.Title != nil {
		return string(*clean.Title)
	}
	return string(clean.ID)
}

func cleanEntries(clean privacydomain.SanitisedRecord) []domain.Entry {
	entries := make([]domain.Entry, 0, len(clean.Fields))
	for _, field := range clean.Fields {
		if field.Value.IsNumber {
			entries = append(entries, domain.Entry{Name: field.Name, Value: field.Value.Number})
			continue
		}
		entries = append(entries, domain.Entry{Name: field.Name, Value: field.Value.Text})
	}
	return entries
}
