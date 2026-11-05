//nolint:misspell // Spanish module names, fields and messages, verbatim from the TypeScript API.
package application

import (
	"context"
	"errors"
	"strconv"
	"sync"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/integration/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
	recordsapp "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/application"
	records "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/domain"
)

// The integration runtime of apps/api/src/contexts/integration/application: API key
// verification, inbound webhooks with idempotency receipts, media monitoring by RSS/Atom feeds
// (docs/adr/0021) and the Defensoría connector, plus the cron hook that polls both. Every time is
// the clock's, truncated to milliseconds like a JavaScript Date.

// Clock is the time source; JavaScript dates hold milliseconds.
type Clock func() time.Time

func (c Clock) now() time.Time { return c().Truncate(time.Millisecond) }

// ---- API keys ----

// ActiveKey is an active (not revoked) key with its stored hash.
type ActiveKey struct {
	domain.Principal
	SecretHash string
	LastUsedAt *time.Time
}

// KeyStore is the part of sql-api-key-store.ts the runtime uses. api_keys is global: it is read
// on the owner connection, before any tenant is known.
type KeyStore interface {
	Active(ctx context.Context, prefix string) (*ActiveKey, error)
	Touch(ctx context.Context, id int, at time.Time) error
	// Revoke marks the tenant's key revoked and audits it; false when it is missing or revoked.
	Revoke(ctx context.Context, tenantID string, id int, at time.Time) (bool, error)
}

// touchInterval is TOUCH_INTERVAL_MS: last_used_at is refreshed at most this often.
const touchInterval = 60 * time.Second

// Keys is the verification side of api-key-service.ts. Issuing keys stays in TypeScript.
type Keys struct {
	Store KeyStore
	Clock Clock
}

// Authenticate is authenticate(bearerToken(header)): the key of a well-formed, active token
// whose secret matches the stored SHA-256, or nil.
func (k Keys) Authenticate(ctx context.Context, header string, present bool) (*domain.Principal, error) {
	bearer, ok := domain.BearerToken(header, present)
	if !ok {
		return nil, nil
	}
	prefix, secret, ok := domain.ParseToken(bearer)
	if !ok {
		return nil, nil
	}
	found, err := k.Store.Active(ctx, prefix)
	if err != nil || found == nil || !domain.SecretMatches(secret, found.SecretHash) {
		return nil, err
	}
	now := k.Clock.now()
	if found.LastUsedAt == nil || now.Sub(*found.LastUsedAt) > touchInterval {
		if err := k.Store.Touch(ctx, found.KeyID, now); err != nil {
			return nil, err
		}
	}
	p := found.Principal
	return &p, nil
}

// Revoke is api-key-service.ts `revoke`.
func (k Keys) Revoke(ctx context.Context, tenantID string, id int) (bool, error) {
	return k.Store.Revoke(ctx, tenantID, id, k.Clock.now())
}

// ---- Inbound webhooks ----

// Response is an ingest answer: its status and its body as JSON text.
type Response struct {
	Status int
	Body   []byte
}

// ClaimKind is the outcome of claiming an idempotency key.
type ClaimKind int

// The claims of IngestClaim.
const (
	Claimed ClaimKind = iota
	InProgress
	Stored
)

// Receipts are the idempotency receipts of inbound webhooks, per key, in the key's tenant.
type Receipts interface {
	// Claim inserts the receipt; when it exists, Stored carries its answer, or InProgress.
	Claim(ctx context.Context, tenantID string, keyID int, key string, at time.Time) (ClaimKind, Response, error)
	Complete(ctx context.Context, tenantID string, keyID int, key string, response Response) error
	Release(ctx context.Context, tenantID string, keyID int, key string) error
}

// RecordCreator is records.create of the records context (its Writes.Create).
type RecordCreator interface {
	Create(ctx context.Context, tenantID, module string, payload *records.Object) (string, *records.Problem, error)
}

// Ingest is ingest-service.ts: each record is created like one from the app, with its own CREATE
// audit row; every payload is checked before the first one is written; with an idempotency key
// a retried call replays the first answer.
type Ingest struct {
	Records  RecordCreator
	Receipts Receipts
	Clock    Clock
}

// IngestRequest is IngestRequest.
type IngestRequest struct {
	Principal domain.Principal
	// ProjectID is the key's project, which a payload may not contradict.
	ProjectID string
	Slug      string
	Body      any
	// Key is the idempotency key, "" without one.
	Key string
}

// Outcome is IngestOutcome: the answer and whether it was replayed.
type Outcome struct {
	Response
	Replayed bool
}

func reply(status int, fields ...any) Response {
	o := records.NewObject()
	for i := 0; i+1 < len(fields); i += 2 {
		o.Set(fields[i].(string), fields[i+1])
	}
	return Response{Status: status, Body: records.Stringify(o)}
}

func (in Ingest) create(ctx context.Context, req IngestRequest) (Response, error) {
	module, ok := records.ModuleForSlug(req.Slug)
	if !ok {
		return reply(404, "detail", "Módulo no válido"), nil
	}
	payloads, problem := domain.IngestPayloads(req.Body)
	if problem != nil {
		var index any
		if problem.Index >= 0 {
			index = float64(problem.Index)
		}
		return reply(422, "detail", problem.Message, "index", index), nil
	}
	for i, payload := range payloads {
		if domain.PayloadProject(payload, req.ProjectID) {
			return reply(403, "detail", "No se permite escribir en otro proyecto", "index", float64(i)), nil
		}
		if p := records.ValidatePayload(module, payload); p != nil {
			return reply(422, "detail", p.Message, "index", float64(i)), nil
		}
	}
	ids := []any{}
	for _, payload := range payloads {
		id, problem, err := in.Records.Create(ctx, req.Principal.TenantID, module, payload)
		if errors.Is(err, recordsapp.ErrExhausted) || err == nil && problem != nil {
			status := 500
			if len(ids) > 0 {
				status = 207
			}
			return reply(status, "detail", "No se pudo asignar un id", "module", req.Slug, "ids", ids), nil
		}
		if err != nil {
			return Response{}, err
		}
		ids = append(ids, id)
	}
	return reply(201, "ok", true, "module", req.Slug, "ids", ids), nil
}

// Run is ingest.ingest.
func (in Ingest) Run(ctx context.Context, req IngestRequest) (Outcome, error) {
	if req.Key == "" {
		r, err := in.create(ctx, req)
		return Outcome{Response: r}, err
	}
	tenant, keyID := req.Principal.TenantID, req.Principal.KeyID
	kind, stored, err := in.Receipts.Claim(ctx, tenant, keyID, req.Key, in.Clock.now())
	if err != nil {
		return Outcome{}, err
	}
	switch kind {
	case Stored:
		return Outcome{Response: stored, Replayed: true}, nil
	case InProgress:
		return Outcome{Response: reply(409, "detail", "Una llamada con la misma Idempotency-Key está en curso")}, nil
	}
	r, err := in.create(ctx, req)
	if err != nil {
		_ = in.Receipts.Release(context.WithoutCancel(ctx), tenant, keyID, req.Key)
		return Outcome{}, err
	}
	// Only answers that wrote something are kept; a rejected call may be corrected and retried.
	if r.Status == 201 || r.Status == 207 {
		err = in.Receipts.Complete(ctx, tenant, keyID, req.Key, r)
	} else {
		err = in.Receipts.Release(ctx, tenant, keyID, req.Key)
	}
	return Outcome{Response: r}, err
}

// ---- Narratives from authorized sources ----

// NarrativeStore is the part of the records store the importer uses.
type NarrativeStore interface {
	Create(ctx context.Context, tenantID, module string, candidates func(yield func(string) bool), payloadFor func(string) *records.Object, note recordsapp.AuditNote, at time.Time) (string, error)
	Get(ctx context.Context, tenantID, module, id string) (*recordsapp.StoredRecord, error)
}

// Importer is sourceImporter of compose.ts: a narrative created once per canonical id.
type Importer struct {
	Store NarrativeStore
	Clock Clock
}

var importNote = recordsapp.AuditNote{Action: "CREATE", Detail: "Importación de fuente pública autorizada"}

// CreateOnce creates the narrative under id, or reports it as already there when the stored one
// came from the same source with the same fingerprint (source_identity_collision otherwise).
func (im Importer) CreateOnce(ctx context.Context, tenantID, id string, payload *records.Object) (bool, error) {
	created, err := im.Store.Create(ctx, tenantID, "Narrativas", func(yield func(string) bool) { yield(id) },
		func(string) *records.Object { return payload }, importNote, im.Clock.now())
	if err != nil {
		return false, err
	}
	if created != "" {
		return true, nil
	}
	existing, err := im.Store.Get(ctx, tenantID, "Narrativas", id)
	if err != nil {
		return false, err
	}
	same := func(key string) bool {
		if existing == nil {
			return false
		}
		a, _ := existing.Payload.Get(key)
		b, _ := payload.Get(key)
		as, aok := a.(string)
		bs, bok := b.(string)
		return aok && bok && as == bs
	}
	if !same("Fuente_Integracion") || !same("Fuente_Huella_SHA256") {
		return false, &domain.SourceError{Code: domain.SourceCollision}
	}
	return false, nil
}

// ---- Media monitoring ----

// FeedWrite is FeedWrite: a validated feed with its actor and instant.
type FeedWrite struct {
	domain.FeedInput
	Actor string
	At    time.Time
}

// FeedStore is MediaFeedStore of media-monitor.ts.
type FeedStore interface {
	// Create inserts the feed; refused is "duplicate" or "limit".
	Create(ctx context.Context, tenantID string, feed FeedWrite) (saved *domain.MediaFeed, refused string, err error)
	// Update replaces the feed; nil without duplicate when it is missing.
	Update(ctx context.Context, tenantID string, id int, feed FeedWrite) (saved *domain.MediaFeed, duplicate bool, err error)
	Remove(ctx context.Context, tenantID string, id int, at time.Time) (bool, error)
	// ClaimDue marks enabled feeds not polled in the last minutes as polled at `at`, by id.
	ClaimDue(ctx context.Context, tenantID string, at time.Time, minutes int) ([]domain.MediaFeed, error)
	Finish(ctx context.Context, tenantID string, id int, at time.Time, imported, matched int, errorText string) error
}

// FeedGateway reads a public feed; it never follows redirects or reads private addresses.
type FeedGateway interface {
	Read(ctx context.Context, url string) ([]domain.FeedItem, error)
}

// Media is media-monitor.ts.
type Media struct {
	Feeds    FeedStore
	Gateway  FeedGateway
	Importer Importer
	Clock    Clock
}

// normalize is normalize of media-monitor.ts: the URL rules, unique keywords, the URL's href.
func normalize(in domain.FeedInput) (domain.FeedInput, string) {
	if problem := domain.FeedURLProblem(in.URL); problem != "" {
		return in, problem
	}
	seen := map[string]bool{}
	keywords := []string{}
	for _, k := range in.Keywords {
		k = domain.TrimJS(k)
		if k != "" && !seen[k] {
			seen[k] = true
			keywords = append(keywords, k)
		}
	}
	if len(keywords) > domain.MaxFeedKeywords {
		return in, "Máximo " + strconv.Itoa(domain.MaxFeedKeywords) + " palabras clave"
	}
	u, _ := domain.ParseURL(in.URL)
	in.URL, in.Keywords = u.Href, keywords
	return in, ""
}

const duplicateFeed = "Esa fuente ya está registrada"

// Create is media.create: the saved feed, or the problem (the route's 422).
func (m Media) Create(ctx context.Context, tenantID string, in domain.FeedInput, actor string) (*domain.MediaFeed, string, error) {
	feed, problem := normalize(in)
	if problem != "" {
		return nil, problem, nil
	}
	saved, refused, err := m.Feeds.Create(ctx, tenantID, FeedWrite{FeedInput: feed, Actor: actor, At: m.Clock.now()})
	switch {
	case err != nil:
		return nil, "", err
	case refused == "duplicate":
		return nil, duplicateFeed, nil
	case refused == "limit":
		return nil, "Máximo " + strconv.Itoa(domain.MaxFeeds) + " fuentes por proyecto", nil
	}
	return saved, "", nil
}

// Update is media.update: nil without a problem when the feed is missing.
func (m Media) Update(ctx context.Context, tenantID string, id int, in domain.FeedInput, actor string) (*domain.MediaFeed, string, error) {
	feed, problem := normalize(in)
	if problem != "" {
		return nil, problem, nil
	}
	saved, duplicate, err := m.Feeds.Update(ctx, tenantID, id, FeedWrite{FeedInput: feed, Actor: actor, At: m.Clock.now()})
	if duplicate {
		return nil, duplicateFeed, err
	}
	return saved, "", err
}

// Remove is media.remove.
func (m Media) Remove(ctx context.Context, tenantID string, id int) (bool, error) {
	return m.Feeds.Remove(ctx, tenantID, id, m.Clock.now())
}

// PreviewItem is one item of a preview.
type PreviewItem struct {
	Title       string   `json:"title"`
	Link        string   `json:"link"`
	Summary     string   `json:"summary"`
	PublishedAt *string  `json:"published_at"`
	Matched     []string `json:"matched"`
}

// Preview is media.preview's answer.
type Preview struct {
	Total int           `json:"total"`
	Items []PreviewItem `json:"items"`
}

// Preview reads a feed without saving anything; the problem is the route's 422, an error the
// gateway's failure (its 502).
func (m Media) Preview(ctx context.Context, url string, keywords []string) (*Preview, string, error) {
	if problem := domain.FeedURLProblem(url); problem != "" {
		return nil, problem, nil
	}
	u, _ := domain.ParseURL(url)
	items, err := m.Gateway.Read(ctx, u.Href)
	if err != nil {
		return nil, "", err
	}
	out := &Preview{Total: len(items), Items: []PreviewItem{}}
	for _, item := range items[:min(len(items), domain.ItemsPerPoll)] {
		out.Items = append(out.Items, PreviewItem{
			Title: item.Title, Link: item.Link, Summary: item.Summary, PublishedAt: item.PublishedAt,
			Matched: domain.MatchedKeywords(item, keywords),
		})
	}
	return out, "", nil
}

// PollReport is media.poll's answer.
type PollReport struct {
	Feeds      int `json:"feeds"`
	Imported   int `json:"imported"`
	Duplicates int `json:"duplicates"`
	Errors     int `json:"errors"`
}

// Poll is media.poll: the project's due feeds (every enabled one with force). Feeds are fetched
// in parallel; items are imported one by one, so each narrative gets its own audit row.
func (m Media) Poll(ctx context.Context, tenantID string, force bool) (PollReport, error) {
	var report PollReport
	at := m.Clock.now()
	minutes := domain.PollMinutes
	if force {
		minutes = 0
	}
	due, err := m.Feeds.ClaimDue(ctx, tenantID, at, minutes)
	if err != nil {
		return report, err
	}
	type read struct {
		items []domain.FeedItem
		err   error
	}
	reads := make([]read, len(due))
	var wg sync.WaitGroup
	for i, feed := range due {
		wg.Add(1)
		go func() {
			defer wg.Done()
			items, err := m.Gateway.Read(ctx, feed.URL)
			reads[i] = read{items, err}
		}()
	}
	wg.Wait()
	for i, feed := range due {
		report.Feeds++
		if reads[i].err != nil {
			report.Errors++
			if err := m.Feeds.Finish(ctx, tenantID, feed.ID, at, 0, 0, domain.FeedErrorMessage(reads[i].err)); err != nil {
				return report, err
			}
			continue
		}
		imported, duplicates, matched, err := m.pollFeed(ctx, tenantID, feed, reads[i].items)
		if err != nil {
			report.Errors++
			if err := m.Feeds.Finish(ctx, tenantID, feed.ID, at, 0, 0, "No se pudieron guardar las narrativas de esta fuente."); err != nil {
				return report, err
			}
			continue
		}
		report.Imported += imported
		report.Duplicates += duplicates
		if err := m.Feeds.Finish(ctx, tenantID, feed.ID, at, imported, matched, ""); err != nil {
			return report, err
		}
	}
	return report, nil
}

func (m Media) pollFeed(ctx context.Context, tenantID string, feed domain.MediaFeed, items []domain.FeedItem) (imported, duplicates, matched int, err error) {
	for _, item := range items {
		keywords := domain.MatchedKeywords(item, feed.Keywords)
		if len(feed.Keywords) > 0 && len(keywords) == 0 {
			continue
		}
		matched++
		id, payload := domain.FeedNarrative(feed.URL, feed.Name, feed.Territory, item, keywords, m.Clock.now())
		created, err := m.Importer.CreateOnce(ctx, tenantID, id, payload)
		if err != nil {
			return imported, duplicates, matched, err
		}
		if created {
			imported++
		} else {
			duplicates++
		}
		if imported >= domain.ItemsPerPoll {
			break
		}
	}
	return imported, duplicates, matched, nil
}

// ---- Defensoría connector ----

// SettingsStore is SourceSettingsStore of authorized-sources.ts.
type SettingsStore interface {
	// Get returns the tenant's settings, or the empty state.
	Get(ctx context.Context, tenantID string) (domain.SourceState, error)
	Save(ctx context.Context, tenantID string, in domain.SourceConfig, username string, at time.Time) (domain.SourceState, error)
	ClaimPoll(ctx context.Context, tenantID string, revision int, at time.Time) (bool, error)
	FinishPoll(ctx context.Context, tenantID string, at time.Time, imported, duplicates int, errorText string) error
	ActiveTenants(ctx context.Context) ([]string, error)
}

// OfficialGateway reads the Defensoría's WordPress API.
type OfficialGateway interface {
	Preview(ctx context.Context, query string) ([]domain.OfficialPost, error)
	Get(ctx context.Context, id int) (domain.OfficialPost, error)
}

// Sources is authorized-sources.ts.
type Sources struct {
	Gateway  OfficialGateway
	Settings SettingsStore
	Importer Importer
	Clock    Clock
}

// Preview is sources.preview.
func (s Sources) Preview(ctx context.Context, query string) ([]domain.OfficialPost, error) {
	return s.Gateway.Preview(ctx, query)
}

// Configure is sources.configure (the route refuses enabling without a note first).
func (s Sources) Configure(ctx context.Context, tenantID string, in domain.SourceConfig, username string) (domain.SourceState, error) {
	return s.Settings.Save(ctx, tenantID, in, username, s.Clock.now())
}

func (s Sources) importPost(ctx context.Context, tenantID string, post domain.OfficialPost, territory string) (string, bool, error) {
	id, payload := domain.OfficialNarrative(post, territory, s.Clock.now())
	created, err := s.Importer.CreateOnce(ctx, tenantID, id, payload)
	return id, created, err
}

// Import is sources.importPost: the narrative's id and whether it was created.
func (s Sources) Import(ctx context.Context, tenantID string, in domain.SourceImport) (string, bool, error) {
	post, err := s.Gateway.Get(ctx, in.PostID)
	if err != nil {
		return "", false, err
	}
	territory := ""
	if in.Territory != nil {
		territory = *in.Territory
	}
	return s.importPost(ctx, tenantID, post, territory)
}

// SourcePoll is sources.poll's answer.
type SourcePoll struct {
	Skipped    bool `json:"skipped"`
	Imported   int  `json:"imported"`
	Duplicates int  `json:"duplicates"`
}

// Poll is sources.poll: at most every 15 minutes per revision, ten publications, stopping when
// the settings change; a failure is stored as its source_<reason> code and returned.
func (s Sources) Poll(ctx context.Context, tenantID string) (SourcePoll, error) {
	config, err := s.Settings.Get(ctx, tenantID)
	if err != nil {
		return SourcePoll{}, err
	}
	at := s.Clock.now()
	if !config.Enabled {
		return SourcePoll{Skipped: true}, nil
	}
	claimed, err := s.Settings.ClaimPoll(ctx, tenantID, config.Revision, at)
	if err != nil {
		return SourcePoll{}, err
	}
	if !claimed {
		return SourcePoll{Skipped: true}, nil
	}
	imported, duplicates := 0, 0
	fail := func(err error) (SourcePoll, error) {
		code := domain.PollErrorCode(err)
		if ferr := s.Settings.FinishPoll(ctx, tenantID, at, imported, duplicates, code); ferr != nil {
			return SourcePoll{}, ferr
		}
		return SourcePoll{}, errors.Join(&domain.SourceError{Code: code}, err)
	}
	posts, err := s.Gateway.Preview(ctx, config.Query)
	if err != nil {
		return fail(err)
	}
	for _, post := range posts[:min(len(posts), 10)] {
		current, err := s.Settings.Get(ctx, tenantID)
		if err != nil {
			return fail(err)
		}
		if !current.Enabled || current.Revision != config.Revision {
			break
		}
		_, created, err := s.importPost(ctx, tenantID, post, config.Territory)
		if err != nil {
			return fail(err)
		}
		if created {
			imported++
		} else {
			duplicates++
		}
	}
	if err := s.Settings.FinishPoll(ctx, tenantID, at, imported, duplicates, ""); err != nil {
		return SourcePoll{}, err
	}
	return SourcePoll{Imported: imported, Duplicates: duplicates}, nil
}

// ---- Cron ----

// Runtime is the integration half of the automation runtime's beforeTick (compose.ts): on a
// cron tick, before the rules run, each visited tenant polls the Defensoría connector and its
// due media feeds, as the `automation` actor with full clearance. The Go automation runtime
// calls it once it exists; until then the TypeScript cron keeps polling.
type Runtime struct {
	Sources Sources
	Media   Media
}

// BeforeTick polls both sources of tenantID; media feeds are polled even when the Defensoría
// connector fails, and vice versa. The first failure (the connector's, then the feeds') is
// returned.
func (rt Runtime) BeforeTick(ctx context.Context, tenantID string) error {
	ctx = database.WithActor(ctx, database.Actor{Name: "automation", Clearance: database.ClearanceFull})
	var official, feeds error
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); _, official = rt.Sources.Poll(ctx, tenantID) }()
	go func() { defer wg.Done(); _, feeds = rt.Media.Poll(ctx, tenantID, false) }()
	wg.Wait()
	if official != nil {
		return official
	}
	return feeds
}

// ActiveTenants is sources.activeTenants: tenants with the connector enabled.
func (rt Runtime) ActiveTenants(ctx context.Context) ([]string, error) {
	return rt.Sources.Settings.ActiveTenants(ctx)
}
