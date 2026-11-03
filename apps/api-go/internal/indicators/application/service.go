// Package application is the read side of
// apps/api/src/contexts/indicators/application/indicators-service.ts: the indicators report, the
// IRSA and its configuration, the snapshot history, the model status and the validation
// template. computeIndicators and computeIrsa run in the Rust engine (ADR 0032); saving the
// configuration and snapshots stays in TypeScript for now.
package application

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"sync"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/indicators/domain"
)

// Engine runs one request of the indicators engine (engines/README.md) and returns its value.
// *wasmengine.Engine satisfies it.
type Engine interface {
	Call(ctx context.Context, request []byte) (json.RawMessage, error)
}

// IrsaInputs are what the IRSA of one tenant reads, in one tenant transaction.
type IrsaInputs struct {
	// Config is the stored configuration; nil means the defaults.
	Config  json.RawMessage
	Records domain.Records
	// Phase is the project's phase with saved weights, when it has one.
	Phase *domain.Phase
}

// Snapshot is one irsa_snapshots row as GET /system/irsa/history returns it.
type Snapshot struct {
	ID            int64           `json:"id"`
	TS            string          `json:"ts"`
	Irsa          float64         `json:"irsa"`
	Level         string          `json:"level"`
	Scores        json.RawMessage `json:"scores"`
	ConfigVersion *string         `json:"config_version"`
	Note          *string         `json:"note"`
}

// Store reads one tenant's rows.
type Store interface {
	// Config is the stored IRSA configuration, or nil when the tenant uses the defaults.
	Config(ctx context.Context, tenantID string) (json.RawMessage, error)
	Records(ctx context.Context, tenantID string) (domain.Records, error)
	IrsaInputs(ctx context.Context, tenantID string) (IrsaInputs, error)
	// History is newest first; a nil limit means every snapshot.
	History(ctx context.Context, tenantID string, limit *int64) ([]Snapshot, error)
}

// Service answers the indicators read routes. Each answer is the JSON to send.
type Service struct {
	Store  Store
	Engine Engine

	once     sync.Once
	defaults defaults
	err      error
}

// defaults are the engine's INDICATOR_CONFIG and DEFAULT_IRSA_CONFIG, as JSON.stringify writes
// them, and the validation template built from the first.
type defaults struct {
	IndicatorConfig json.RawMessage `json:"indicator_config"`
	IrsaConfig      json.RawMessage `json:"irsa_config"`
	template        json.RawMessage
}

func (s *Service) loadDefaults(ctx context.Context) (defaults, error) {
	s.once.Do(func() {
		value, err := s.Engine.Call(context.WithoutCancel(ctx), []byte(`{"op":"defaults"}`))
		if err == nil {
			err = json.Unmarshal(value, &s.defaults)
		}
		if err == nil {
			s.defaults.template, err = domain.ValidationTemplate(s.defaults.IndicatorConfig)
		}
		s.err = err
	})
	return s.defaults, s.err
}

// request writes an engine request: op, then each non-nil field in order.
func request(op string, fields ...any) []byte {
	var b bytes.Buffer
	fmt.Fprintf(&b, `{"op":%q`, op)
	for i := 0; i+1 < len(fields); i += 2 {
		value, _ := fields[i+1].(json.RawMessage)
		if value == nil {
			continue
		}
		fmt.Fprintf(&b, `,%q:`, fields[i])
		b.Write(value)
	}
	b.WriteByte('}')
	return b.Bytes()
}

// Indicators is computeIndicators over the tenant's module records.
func (s *Service) Indicators(ctx context.Context, tenantID string) (json.RawMessage, error) {
	records, err := s.Store.Records(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	payload, err := records.JSON()
	if err != nil {
		return nil, err
	}
	return s.Engine.Call(ctx, request("indicators", "records", payload))
}

// Irsa is computeIrsa with the tenant's configuration, or, when the project's phase has saved
// weights, that configuration with those weights, plus the phase and its note.
func (s *Service) Irsa(ctx context.Context, tenantID string) (json.RawMessage, error) {
	in, err := s.Store.IrsaInputs(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	records, err := in.Records.JSON()
	if err != nil {
		return nil, err
	}
	config := in.Config
	if in.Phase != nil {
		if config == nil {
			d, err := s.loadDefaults(ctx)
			if err != nil {
				return nil, err
			}
			config = d.IrsaConfig
		}
		if config, err = in.Phase.Config(config); err != nil {
			return nil, err
		}
	}
	result, err := s.Engine.Call(ctx, request("irsa", "config", config, "records", records))
	if err != nil || in.Phase == nil {
		return result, err
	}
	return in.Phase.Decorate(result)
}

// Config is the tenant's IRSA configuration, or DEFAULT_IRSA_CONFIG.
func (s *Service) Config(ctx context.Context, tenantID string) (json.RawMessage, error) {
	config, err := s.Store.Config(ctx, tenantID)
	if err != nil || config != nil {
		return config, err
	}
	d, err := s.loadDefaults(ctx)
	return d.IrsaConfig, err
}

// History is the tenant's IRSA snapshots, newest first.
func (s *Service) History(ctx context.Context, tenantID string, limit *int64) ([]Snapshot, error) {
	snapshots, err := s.Store.History(ctx, tenantID, limit)
	if snapshots == nil {
		snapshots = []Snapshot{}
	}
	return snapshots, err
}

// ValidationTemplate is one pending expert-validation row per indicator.
func (s *Service) ValidationTemplate(ctx context.Context) (json.RawMessage, error) {
	d, err := s.loadDefaults(ctx)
	return d.template, err
}
