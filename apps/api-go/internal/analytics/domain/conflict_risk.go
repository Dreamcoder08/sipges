package domain

import (
	"encoding/json"
	"time"
)

// RiskModules are RISK_MODULES of signals.ts: the modules the conflict-risk prediction reads.
var RiskModules = []string{"Demandas", "Compromisos", "Narrativas", "Alertas", "Eventos"} //nolint:misspell // Spanish names kept verbatim from the TypeScript API

// RiskRecord is RiskRecord: a stored record with its last update, as the engine reads it.
type RiskRecord struct {
	Module    string          `json:"module"`
	ID        string          `json:"id"`
	Payload   json.RawMessage `json:"payload"`
	UpdatedAt *string         `json:"updatedAt"`
}

// RiskAlert is RiskAlert: a territorial alert, as the engine reads it.
type RiskAlert struct {
	ID         string  `json:"id"`
	CreatedAt  string  `json:"createdAt"`
	Territory  *string `json:"territory"`
	Level      string  `json:"level"`
	Status     string  `json:"status"`
	ReviewedAt *string `json:"reviewedAt"`
}

// IrsaPoint is IrsaPoint: one IRSA snapshot.
type IrsaPoint struct {
	TS   string  `json:"ts"`
	Irsa float64 `json:"irsa"`
}

// lima is America/Lima: UTC−5 all year, with no daylight saving since 1994.
var lima = time.FixedZone("America/Lima", -5*60*60)

// LimaToday is limaToday of @sipges/kernel: the calendar day in Peru, YYYY-MM-DD.
func LimaToday(now time.Time) string { return now.In(lima).Format(time.DateOnly) }

// ISOMillis is Date.prototype.toISOString.
func ISOMillis(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }
