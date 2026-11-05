package application

import (
	"context"
	"sync"
	"time"

	privacy "github.com/Dreamcoder08/sipges/apps/api-go/internal/privacy/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/domain"
)

// Where an embedder runs. Local is loopback, not egress; anything else is treated as external.
const (
	EgressLocal    = "local"
	EgressExternal = "external"
)

// Why an embedder is unavailable.
const (
	ReasonUnreachable        = "unreachable"
	ReasonExternalAIDisabled = "external_ai_disabled"
)

// probeText is written in the code: no tenant data is in it.
const probeText = "sipges"

const (
	probeTTL     = 60 * time.Second
	probeTimeout = 3 * time.Second
)

// Embedder gives text embeddings from a model. It accepts only a cleared payload, so a text bound
// for a model outside this machine cannot skip the egress guard (docs/adr/0030).
type Embedder interface {
	Model() string
	Egress() string
	Embed(ctx context.Context, text privacy.Sanitised[string]) ([]float64, error)
}

// EmbedderStatus says whether semantic features can run; Reason is "" while they can.
type EmbedderStatus struct {
	Available bool
	Reason    string
	Model     string
	Egress    string
}

// EmbedderProbe is embedderStatus of intelligence-service.ts.
type EmbedderProbe struct {
	// Timeout bounds one probe; it is probeTimeout unless a test shortens it.
	Timeout time.Duration

	embedder Embedder
	external privacy.Switch
	now      func() time.Time

	mu       sync.Mutex
	attempts int
	settled  *settledProbe
}

type settledProbe struct {
	attempt   int
	at        time.Time
	reachable bool
}

// NewEmbedderProbe builds the probe; a nil external means the project's switch is off, and a nil
// now is time.Now.
func NewEmbedderProbe(embedder Embedder, external privacy.Switch, now func() time.Time) *EmbedderProbe {
	if now == nil {
		now = time.Now
	}
	return &EmbedderProbe{Timeout: probeTimeout, embedder: embedder, external: external, now: now}
}

// Status reports the embedder for one project. An external embedder is not even probed while the
// project's external AI switch is off.
func (p *EmbedderProbe) Status(ctx context.Context, scope domain.Scope) (EmbedderStatus, error) {
	status := EmbedderStatus{Model: p.embedder.Model(), Egress: p.embedder.Egress()}
	if status.Egress != EgressLocal {
		enabled := false
		if p.external != nil {
			var err error
			if enabled, err = p.external.Enabled(ctx, scope.TenantID()); err != nil {
				return EmbedderStatus{}, err
			}
		}
		if !enabled {
			status.Reason = ReasonExternalAIDisabled
			return status, nil
		}
	}
	if p.reachable(ctx) {
		status.Available = true
	} else {
		status.Reason = ReasonUnreachable
	}
	return status, nil
}

// reachable shares only settled answers between requests: concurrent callers repeat the work
// instead of waiting on a probe in flight. The probe outlives its request, so a client that goes
// away does not leave a false failure cached for everyone else.
func (p *EmbedderProbe) reachable(ctx context.Context) bool {
	at := p.now()
	p.mu.Lock()
	if p.settled != nil && at.Sub(p.settled.at) < probeTTL {
		answer := p.settled.reachable
		p.mu.Unlock()
		return answer
	}
	p.attempts++
	attempt := p.attempts
	p.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), p.Timeout)
	defer cancel()
	_, err := p.embedder.Embed(ctx, privacy.ExemptPayload(probeText, privacy.ExemptConstant))
	answer := err == nil

	p.mu.Lock()
	defer p.mu.Unlock()
	// A slower probe that started earlier must not replace a newer answer.
	if p.settled == nil || p.settled.attempt < attempt {
		p.settled = &settledProbe{attempt: attempt, at: at, reachable: answer}
	}
	return answer
}
