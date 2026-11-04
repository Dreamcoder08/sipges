// Package application is apps/api/src/contexts/indicators/application/indicators-service.ts: the
// indicators report, the IRSA and its configuration, the snapshot history, the model status and
// the validation template, and the two writes, updating the configuration and saving a
// snapshot. computeIndicators, computeIrsa and applyIrsaConfigPatch run in the Rust engine
// (ADR 0032).
package application

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

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

// NewSnapshot is NewIrsaSnapshot: one irsa_snapshots row to insert with its audit entry.
type NewSnapshot struct {
	TS    time.Time
	Irsa  float64
	Level string
	// Scores are the result's scores as the engine wrote them (JSON.stringify).
	Scores        json.RawMessage
	ConfigVersion string
	Note          string
	AuditDetail   string
}

// Store reads and writes one tenant's rows.
type Store interface {
	// Config is the stored IRSA configuration, or nil when the tenant uses the defaults.
	Config(ctx context.Context, tenantID string) (json.RawMessage, error)
	Records(ctx context.Context, tenantID string) (domain.Records, error)
	IrsaInputs(ctx context.Context, tenantID string) (IrsaInputs, error)
	// History is newest first; a nil limit means every snapshot.
	History(ctx context.Context, tenantID string, limit *int64) ([]Snapshot, error)
	// SaveConfig stores the configuration (its exact bytes) and its audit entry atomically.
	SaveConfig(ctx context.Context, tenantID string, config json.RawMessage, at time.Time, auditDetail string) error
	// InsertSnapshot stores the snapshot and its audit entry atomically; it returns the new id.
	InsertSnapshot(ctx context.Context, tenantID string, snapshot NewSnapshot) (int64, error)
}

// Service answers the indicators read routes. Each answer is the JSON to send.
type Service struct {
	Store  Store
	Engine Engine
	// Now is the clock of the writes.
	Now func() time.Time

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

// configAudit is the audit detail of a configuration update.
const configAudit = "Parámetros IRSA actualizados"

// ErrUnexpectedEngineAnswer is an engine answer without the fields the writes read.
var ErrUnexpectedEngineAnswer = errors.New("indicators: unexpected engine answer")

// UpdateConfig is updateConfig: applyIrsaConfigPatch over the stored configuration (or the
// defaults), saved with its audit entry. ok is false, and nothing is saved, when the weights do
// not sum to 1 ± 0.02. patch is the parsed payload (domain.ParseConfigUpdate).
func (s *Service) UpdateConfig(ctx context.Context, tenantID string, patch json.RawMessage) (config json.RawMessage, ok bool, err error) {
	stored, err := s.Store.Config(ctx, tenantID)
	if err != nil {
		return nil, false, err
	}
	answer, err := s.Engine.Call(ctx, request("irsa_config_patch", "config", stored, "patch", patch))
	if err != nil {
		return nil, false, err
	}
	var result struct {
		OK    bool            `json:"ok"`
		Value json.RawMessage `json:"value"`
	}
	if err := json.Unmarshal(answer, &result); err != nil {
		return nil, false, err
	}
	if !result.OK {
		return nil, false, nil
	}
	if len(result.Value) == 0 {
		return nil, false, ErrUnexpectedEngineAnswer
	}
	if err := s.Store.SaveConfig(ctx, tenantID, result.Value, s.now(), configAudit); err != nil {
		return nil, false, err
	}
	return result.Value, true, nil
}

// Snapshot is snapshot: the IRSA as GET /system/irsa answers it, saved with the note and an
// audit entry. It returns {id, ...result} as the route spreads it after "ok".
func (s *Service) Snapshot(ctx context.Context, tenantID, note string) (id int64, result json.RawMessage, err error) {
	result, err = s.Irsa(ctx, tenantID)
	if err != nil {
		return 0, nil, err
	}
	var fields struct {
		Irsa          *float64        `json:"irsa"`
		Level         *string         `json:"level"`
		Scores        json.RawMessage `json:"scores"`
		ConfigVersion *string         `json:"config_version"`
	}
	if err := json.Unmarshal(result, &fields); err != nil {
		return 0, nil, err
	}
	if fields.Irsa == nil || fields.Level == nil || len(fields.Scores) == 0 || fields.ConfigVersion == nil {
		return 0, nil, ErrUnexpectedEngineAnswer
	}
	id, err = s.Store.InsertSnapshot(ctx, tenantID, NewSnapshot{
		TS:            s.now(),
		Irsa:          *fields.Irsa,
		Level:         *fields.Level,
		Scores:        fields.Scores,
		ConfigVersion: *fields.ConfigVersion,
		Note:          note,
		AuditDetail:   "Corte IRSA guardado: " + domain.PyFloat(*fields.Irsa) + " " + *fields.Level,
	})
	return id, result, err
}

// now is the clock at JavaScript's precision: a Date holds milliseconds.
func (s *Service) now() time.Time {
	now := time.Now
	if s.Now != nil {
		now = s.Now
	}
	return now().UTC().Truncate(time.Millisecond)
}
