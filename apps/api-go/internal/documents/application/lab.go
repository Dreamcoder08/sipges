package application

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/documents/domain"
	evidence "github.com/Dreamcoder08/sipges/apps/api-go/internal/evidence/domain"
)

// The rest of document-lab-service.ts: reading, comparing and reporting on uploaded documents
// (never stored), importing review excerpts and deciding them, one at a time or in bulk.

// DocumentReader parses untrusted document bytes into plain text; any other error is an
// unreadable document (422, without parser details).
type DocumentReader interface {
	// ReadPDF returns the page texts, or tooMany before any page beyond maxPages is read.
	ReadPDF(ctx context.Context, data []byte, maxPages int) (pages []string, tooMany bool, err error)
	ReadDOCX(ctx context.Context, data []byte) (domain.DocxContent, error)
}

// ReportRenderer turns a report outline into a downloadable file.
type ReportRenderer interface {
	ContentType() string
	Render(blocks []domain.ReportBlock, at time.Time) ([]byte, error)
}

// PendingSelector selects pending items of one project: explicit ids, or a theme and/or
// source document (nil means any).
type PendingSelector struct {
	ProjectID    string
	IDs          []string // nil when the selector is a filter
	Theme        *string
	SourceSHA256 *string
}

// Decision is one review decision.
type Decision struct {
	Status   string
	Reviewer string
	Note     string
	At       time.Time
}

// NewReviewItem is one excerpt to import (status pendiente, no reviewer or note).
type NewReviewItem struct {
	ID, ProjectID, SourceFile, SourceSHA256, Location, Theme, Excerpt, Action string
	CreatedAt                                                                 time.Time
}

// ReviewWriter is the write side of the review store; each call is one tenant transaction.
type ReviewWriter interface {
	// ImportItems inserts items, skipping exact duplicates; how many rows were new.
	ImportItems(ctx context.Context, tenantID string, items []NewReviewItem) (int, error)
	// Decide updates one item and writes its audit row in the same transaction; nil when missing.
	Decide(ctx context.Context, tenantID, id string, d Decision) (*domain.ReviewItem, error)
	// Pending returns pending items matching the selector, in id order, at most limit.
	Pending(ctx context.Context, tenantID string, s PendingSelector, limit int) ([]domain.ReviewItem, error)
	CountPending(ctx context.Context, tenantID string, s PendingSelector) (int, error)
	// DecidePending decides up to limit items still pending, each with Decide's audit row, in
	// one transaction; items decided meanwhile are left alone. The decided items, in id order.
	DecidePending(ctx context.Context, tenantID string, s PendingSelector, d Decision, limit int) ([]domain.ReviewItem, error)
}

// RecordItem is one record an approval creates.
type RecordItem struct {
	ID     string
	Fields []domain.Field
}

// RecordCounts is what one module's insert-only write did (or, in a dry run, would do).
type RecordCounts struct {
	Created  int
	Existing int
	Problems []string
}

// RecordWriter is the records context seen from the document lab (reviewRecordsPort of
// compose.ts): insert-only creation under deterministic ids, validated like a records import.
type RecordWriter interface {
	CreateMissing(ctx context.Context, tenantID, slug string, items []RecordItem, dryRun bool, source string) (RecordCounts, error)
}

// Lab is the document lab's upload and write use cases.
type Lab struct {
	Reader         DocumentReader
	Renderer       ReportRenderer
	Reviews        ReviewWriter
	Records        RecordWriter
	Now            func() time.Time
	RandomHex      func(n int) (string, error)
	MaxUploadBytes int
}

// ReadError is the kind of a refused document (ReadError of document-lab-service.ts).
type ReadError string

// The kinds of ReadError.
const (
	ReadExtension    ReadError = "extension"
	ReadEmpty        ReadError = "empty"
	ReadTooLarge     ReadError = "too_large"
	ReadTooManyPages ReadError = "too_many_pages"
	ReadUnreadable   ReadError = "unreadable"
	ReadNoText       ReadError = "no_text"
)

// DocumentFile is one uploaded file: the name the client gave and its bytes.
type DocumentFile struct {
	FileName string
	Data     []byte
}

// now is the clock as a JavaScript Date holds it (milliseconds).
func (l Lab) now() time.Time { return l.Now().Truncate(time.Millisecond) }

func (l Lab) chunksOf(ctx context.Context, kind domain.DocumentKind, data []byte) ([]domain.TextChunk, ReadError) {
	switch kind {
	case domain.KindText:
		return domain.TextChunks(data), ""
	case domain.KindDOCX:
		c, err := l.Reader.ReadDOCX(ctx, data)
		if err != nil {
			return nil, ReadUnreadable
		}
		return domain.DocxChunks(c), ""
	}
	pages, tooMany, err := l.Reader.ReadPDF(ctx, data, domain.MaxPDFPages)
	switch {
	case err != nil:
		return nil, ReadUnreadable
	case tooMany:
		return nil, ReadTooManyPages
	}
	return domain.PDFChunks(pages), ""
}

type readDocument struct {
	name   string
	sha256 string
	chunks []domain.TextChunk
	domain.Insights
}

// read validates and reads one document; the bytes are never stored.
func (l Lab) read(ctx context.Context, f DocumentFile) (readDocument, ReadError) {
	raw := f.FileName
	if raw == "" {
		raw = "documento.txt"
	}
	name := evidence.SafeUploadName(raw)
	kind := domain.DocumentKindOf(evidence.ExtensionOf(name))
	switch {
	case kind == "":
		return readDocument{}, ReadExtension
	case len(f.Data) > l.MaxUploadBytes:
		return readDocument{}, ReadTooLarge
	case len(f.Data) == 0:
		return readDocument{}, ReadEmpty
	}
	chunks, refused := l.chunksOf(ctx, kind, f.Data)
	if refused != "" {
		return readDocument{}, refused
	}
	if len(chunks) == 0 {
		return readDocument{}, ReadNoText
	}
	sum := sha256.Sum256(f.Data)
	return readDocument{name: name, sha256: hex.EncodeToString(sum[:]), chunks: chunks, Insights: domain.DocumentInsights(chunks)}, ""
}

// Analyze is analyze: the candidate findings of one document.
func (l Lab) Analyze(ctx context.Context, f DocumentFile, projectID string) (domain.DocumentAnalysis, ReadError) {
	doc, refused := l.read(ctx, f)
	if refused != "" {
		return domain.DocumentAnalysis{}, refused
	}
	return domain.DocumentAnalysis{
		Version:         domain.AnalysisVersion,
		ProjectID:       projectID,
		Filename:        doc.name,
		SHA256:          doc.sha256,
		GeneratedAt:     l.now().UTC().Format("2006-01-02T15:04:05") + "Z",
		TextSections:    len(doc.chunks),
		Items:           doc.Items,
		Themes:          doc.Themes,
		Recommendations: domain.RecommendationsFor(doc.Themes),
		Method:          domain.AnalysisMethod,
		Limitations:     domain.AnalysisLimitations,
	}, ""
}

// Report is report: the analysis as a Word document.
func (l Lab) Report(ctx context.Context, f DocumentFile, projectID string) ([]byte, ReadError, error) {
	analysis, refused := l.Analyze(ctx, f, projectID)
	if refused != "" {
		return nil, refused, nil
	}
	out, err := l.Renderer.Render(domain.LabReport(analysis), l.now())
	return out, "", err
}

// DocumentRef names a compared document.
type DocumentRef struct {
	Filename string `json:"filename"`
	SHA256   string `json:"sha256"`
}

// Comparison is the answer of compare, with the TypeScript keys in order.
type Comparison struct {
	Version         string                       `json:"version"`
	ProjectID       string                       `json:"project_id"`
	Documents       []DocumentRef                `json:"documents"`
	Comparaciones   []domain.ComparisonCandidate `json:"comparaciones"`
	TotalCandidatos int                          `json:"total_candidatos"`
	Method          string                       `json:"method"`
	Limitations     []string                     `json:"limitations"`
}

// Compare is compare: same-theme findings of two documents sharing distinctive vocabulary.
func (l Lab) Compare(ctx context.Context, a, b DocumentFile, projectID string) (Comparison, ReadError) {
	first, refused := l.read(ctx, a)
	if refused != "" {
		return Comparison{}, refused
	}
	second, refused := l.read(ctx, b)
	if refused != "" {
		return Comparison{}, refused
	}
	comparisons, total := domain.CompareFindings(first.Items, second.Items)
	return Comparison{
		Version:   domain.AnalysisVersion,
		ProjectID: projectID,
		Documents: []DocumentRef{
			{Filename: first.name, SHA256: first.sha256},
			{Filename: second.name, SHA256: second.sha256},
		},
		Comparaciones:   comparisons,
		TotalCandidatos: total,
		Method:          domain.CompareMethod,
		Limitations:     domain.CompareLimitations,
	}, ""
}

// ImportError is the kind of a refused review batch.
type ImportError string

// The kinds of ImportError.
const (
	ImportSHA256      ImportError = "sha256"
	ImportTooMany     ImportError = "too_many"
	ImportInvalidText ImportError = "invalid_text"
)

// ImportText is one batch item's four fields, already read as Python's `str(x.get(key, ”))`.
type ImportText struct {
	Tema, Fragmento, Ubicacion, AccionSugerida string
}

// ReviewBatch is one batch of excerpts to import.
type ReviewBatch struct {
	ProjectID string
	Filename  string
	SHA256    string
	Items     []ImportText
}

func isSHA256(s string) bool {
	if len(s) != 64 {
		return false
	}
	for i := 0; i < len(s); i++ {
		if (s[i] < '0' || s[i] > '9') && (s[i] < 'a' || s[i] > 'f') {
			return false
		}
	}
	return true
}

// ImportReview is importReview: stores review excerpts only (never the document); items
// without an excerpt or location are skipped, duplicates are skipped by the store.
func (l Lab) ImportReview(ctx context.Context, tenantID string, batch ReviewBatch) (int, ImportError, error) {
	if !isSHA256(batch.SHA256) {
		return 0, ImportSHA256, nil
	}
	if len(batch.Items) > domain.MaxReviewImport {
		return 0, ImportTooMany, nil
	}
	at := l.now()
	var rows []NewReviewItem
	for _, item := range batch.Items {
		row := NewReviewItem{
			ProjectID:    domain.TakeCodePoints(batch.ProjectID, domain.LimitProjectID),
			SourceFile:   domain.TakeCodePoints(batch.Filename, domain.LimitSourceFile),
			SourceSHA256: batch.SHA256,
			Location:     domain.TakeCodePoints(item.Ubicacion, domain.LimitLocation),
			Theme:        domain.TakeCodePoints(item.Tema, domain.LimitTheme),
			Excerpt:      domain.TakeCodePoints(item.Fragmento, domain.LimitExcerpt),
			Action:       domain.TakeCodePoints(item.AccionSugerida, domain.LimitAction),
			CreatedAt:    at,
		}
		if row.Excerpt == "" || row.Location == "" {
			continue
		}
		id, err := l.RandomHex(32)
		if err != nil {
			return 0, "", err
		}
		row.ID = strings.ToLower(id)
		rows = append(rows, row)
	}
	for _, r := range rows {
		for _, text := range []string{r.ProjectID, r.SourceFile, r.Location, r.Theme, r.Excerpt, r.Action} {
			if domain.HasNul(text) {
				return 0, ImportInvalidText, nil
			}
		}
	}
	if len(rows) == 0 {
		return 0, "", nil
	}
	n, err := l.Reviews.ImportItems(ctx, tenantID, rows)
	return n, "", err
}

// moduleCounts is BulkModule: one module's record counts.
type moduleCounts struct {
	target domain.ReviewTarget
	RecordCounts
}

// errRecordRefused is materialize's throw: records refused the approval's record.
var errRecordRefused = errors.New("documents: review record refused by records")

// writeRecords creates the approved items' records unless they exist, one records call per
// module in slug order (localeCompare on ASCII slugs); a dry run only counts. tolerant reports
// a failing module as a problem instead of failing (bulk decisions).
func (l Lab) writeRecords(ctx context.Context, tenantID string, items []domain.ReviewItem, dryRun, tolerant bool) ([]moduleCounts, error) {
	byModule := map[string][]domain.ReviewItem{}
	for _, item := range items {
		if !domain.IsApproval(item.Status) {
			continue
		}
		slug := domain.ReviewTargetFor(item.Theme).Module
		byModule[slug] = append(byModule[slug], item)
	}
	slugs := make([]string, 0, len(byModule))
	for slug := range byModule {
		slugs = append(slugs, slug)
	}
	slices.Sort(slugs)
	project := domain.ProjectOf(tenantID)
	var out []moduleCounts
	for _, slug := range slugs {
		group := byModule[slug]
		records := make([]RecordItem, len(group))
		for i, item := range group {
			records[i] = RecordItem{ID: domain.ReviewRecordID(item.ID), Fields: domain.ReviewRecordFields(item, project)}
		}
		counts, err := l.Records.CreateMissing(ctx, tenantID, slug, records, dryRun, domain.ReviewSource)
		if err != nil {
			if !tolerant {
				return nil, err
			}
			counts = RecordCounts{Problems: []string{strconv.Itoa(len(group)) + " hallazgos decididos sin registro: use review:materialize"}}
		}
		out = append(out, moduleCounts{target: domain.ReviewTargetFor(group[0].Theme), RecordCounts: counts})
	}
	return out, nil
}

// RecordResult is the approval's record of a single decision.
type RecordResult struct {
	Module  string `json:"module"`
	ID      string `json:"id"`
	Created bool   `json:"created"`
}

// DecisionResult is the answer of a single decision.
type DecisionResult struct {
	ID     string
	Status string
	Record *RecordResult
}

// Decide is decide: one item's decision, then (for an approval) its record. The decision
// commits first; a failed record write leaves the backfill to create it under the same id.
func (l Lab) Decide(ctx context.Context, tenantID, id, status, reviewer, note string) (DecisionResult, domain.DecisionError, error) {
	if refused := domain.CheckDecision(status, note); refused != "" {
		return DecisionResult{}, refused, nil
	}
	if domain.HasNul(id) || len16(id) > 64 {
		return DecisionResult{}, domain.ErrMissing, nil
	}
	reviewer = domain.TakeCodePoints(reviewer, domain.LimitReviewer)
	note = domain.TakeCodePoints(note, domain.LimitNote)
	if domain.HasNul(reviewer) || domain.HasNul(note) {
		return DecisionResult{}, domain.ErrInvalidText, nil
	}
	decided, err := l.Reviews.Decide(ctx, tenantID, id, Decision{Status: status, Reviewer: reviewer, Note: note, At: l.now()})
	if err != nil {
		return DecisionResult{}, "", err
	}
	if decided == nil {
		return DecisionResult{}, domain.ErrMissing, nil
	}
	result := DecisionResult{ID: id, Status: status}
	if domain.IsApproval(decided.Status) {
		counts, err := l.writeRecords(ctx, tenantID, []domain.ReviewItem{*decided}, false, false)
		if err != nil {
			return DecisionResult{}, "", err
		}
		if len(counts) == 0 || len(counts[0].Problems) > 0 {
			return DecisionResult{}, "", errRecordRefused
		}
		result.Record = &RecordResult{Module: counts[0].target.Module, ID: domain.ReviewRecordID(decided.ID), Created: counts[0].Created == 1}
	}
	return result, "", nil
}

// BulkInput is one bulk decision request.
type BulkInput struct {
	ProjectID    string
	IDs          []string // nil for a filter
	Theme        *string
	SourceSHA256 *string
	Status       string
	Reviewer     string
	Note         string
	DryRun       bool
}

// BulkModule is one module's counts in the answer.
type BulkModule struct {
	Module       string `json:"module"`
	Label        string `json:"label"`
	Nuevos       int    `json:"nuevos"`
	YaExistentes int    `json:"ya_existentes"`
}

// BulkDecision is the answer of decideMany.
type BulkDecision struct {
	Decided        int
	RecordsCreated int
	Skipped        int
	Remaining      int
	Modules        []BulkModule
	Problems       []string
}

// addCounts adds one batch's module counts to the running totals, keeping first-seen order.
func addCounts(order *[]string, totals map[string]*moduleCounts, batch []moduleCounts) {
	for _, c := range batch {
		seen, ok := totals[c.target.Module]
		if !ok {
			copied := c
			copied.Problems = slices.Clone(c.Problems)
			totals[c.target.Module] = &copied
			*order = append(*order, c.target.Module)
			continue
		}
		seen.Created += c.Created
		seen.Existing += c.Existing
		seen.Problems = append(seen.Problems, c.Problems...)
	}
}

// DecideMany is decideMany: up to MaxBulkDecision pending items, in transactions of
// BulkBatch, each with the single decision's audit row and record. Items no longer pending
// are skipped, so a re-run never duplicates; a dry run counts and writes nothing.
func (l Lab) DecideMany(ctx context.Context, tenantID string, in BulkInput) (BulkDecision, domain.DecisionError, error) {
	if refused := domain.CheckDecision(in.Status, in.Note); refused != "" {
		return BulkDecision{}, refused, nil
	}
	if in.Status == domain.StatusPending {
		return BulkDecision{}, domain.ErrStatus, nil
	}
	var ids []string
	if in.IDs != nil {
		ids = []string{}
		seen := map[string]bool{}
		for _, id := range in.IDs {
			if !seen[id] {
				seen[id] = true
				ids = append(ids, id)
			}
		}
		if len(ids) > domain.MaxBulkDecision {
			return BulkDecision{}, domain.ErrTooMany, nil
		}
	}
	reviewer := domain.TakeCodePoints(in.Reviewer, domain.LimitReviewer)
	note := domain.TakeCodePoints(in.Note, domain.LimitNote)
	texts := append([]string{reviewer, note, in.ProjectID, deref(in.Theme)}, ids...)
	for _, t := range texts {
		if domain.HasNul(t) {
			return BulkDecision{}, domain.ErrInvalidText, nil
		}
	}
	selector := PendingSelector{ProjectID: in.ProjectID, IDs: ids, Theme: in.Theme, SourceSHA256: in.SourceSHA256}
	decision := Decision{Status: in.Status, Reviewer: reviewer, Note: note, At: l.now()}
	var order []string
	totals := map[string]*moduleCounts{}
	decided := 0
	if in.DryRun {
		items, err := l.Reviews.Pending(ctx, tenantID, selector, domain.MaxBulkDecision)
		if err != nil {
			return BulkDecision{}, "", err
		}
		for i := range items {
			items[i].Status, items[i].Reviewer, items[i].Note, items[i].UpdatedAt = decision.Status, decision.Reviewer, decision.Note, decision.At
		}
		for start := 0; start < len(items); start += domain.BulkBatch {
			batch, err := l.writeRecords(ctx, tenantID, items[start:min(start+domain.BulkBatch, len(items))], true, false)
			if err != nil {
				return BulkDecision{}, "", err
			}
			addCounts(&order, totals, batch)
		}
		decided = len(items)
	} else {
		var chunks [][]string
		if ids != nil {
			for start := 0; start < len(ids); start += domain.BulkBatch {
				chunks = append(chunks, ids[start:min(start+domain.BulkBatch, len(ids))])
			}
		}
		for n := 0; (ids != nil && n < len(chunks)) || (ids == nil && decided < domain.MaxBulkDecision); n++ {
			limit, s := min(domain.BulkBatch, domain.MaxBulkDecision-decided), selector
			if ids != nil {
				limit, s.IDs = domain.BulkBatch, chunks[n]
			}
			batch, err := l.Reviews.DecidePending(ctx, tenantID, s, decision, limit)
			if err != nil {
				return BulkDecision{}, "", err
			}
			decided += len(batch)
			counts, err := l.writeRecords(ctx, tenantID, batch, false, true)
			if err != nil {
				return BulkDecision{}, "", err
			}
			addCounts(&order, totals, counts)
			if ids == nil && len(batch) < limit {
				break
			}
		}
	}
	out := BulkDecision{Decided: decided, Modules: []BulkModule{}, Problems: []string{}}
	for _, slug := range order {
		m := totals[slug]
		out.RecordsCreated += m.Created
		out.Modules = append(out.Modules, BulkModule{Module: m.target.Module, Label: m.target.Label, Nuevos: m.Created, YaExistentes: m.Existing})
		for _, p := range m.Problems {
			out.Problems = append(out.Problems, m.target.Module+": "+p)
		}
	}
	if ids != nil {
		out.Skipped = len(ids) - decided
		return out, "", nil
	}
	left, err := l.Reviews.CountPending(ctx, tenantID, selector)
	if err != nil {
		return BulkDecision{}, "", err
	}
	out.Remaining = left
	if in.DryRun {
		out.Remaining = max(0, left-decided)
	}
	return out, "", nil
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// len16 is a string's JavaScript length (UTF-16 code units).
func len16(s string) int {
	n := 0
	for _, r := range s {
		n += utf16.RuneLen(r)
	}
	return n
}
