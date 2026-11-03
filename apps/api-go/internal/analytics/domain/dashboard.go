package domain

import (
	"bytes"
	"encoding/json"
	"slices"
	"strconv"
	"strings"
)

// Levels counts alerts per level in first-seen order, serialized as a JavaScript object built
// from that order (Object.fromEntries of a Map): array-index keys first, ascending.
type Levels struct {
	keys   []string
	counts map[string]int
}

func (l *Levels) add(level string) {
	if l.counts == nil {
		l.counts = map[string]int{}
	}
	if _, ok := l.counts[level]; !ok {
		l.keys = append(l.keys, level)
	}
	l.counts[level]++
}

// Count returns the alerts counted at level.
func (l Levels) Count(level string) int { return l.counts[level] }

// MarshalJSON writes the levels in JavaScript property order.
func (l Levels) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	b.WriteByte('{')
	for i, k := range jsKeyOrder(slices.Clone(l.keys)) {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(jsQuote(k))
		b.WriteByte(':')
		b.WriteString(strconv.Itoa(l.counts[k]))
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}

// DashboardSummary is dashboardSummary's result, in its key order.
type DashboardSummary struct {
	Eventos          int    `json:"eventos"`
	Actores          int    `json:"actores"`
	DemandasAbiertas int    `json:"demandas_abiertas"` //nolint:misspell // Spanish name kept verbatim from the TypeScript API
	AlertasActivas   int    `json:"alertas_activas"`
	Directorio       int    `json:"directorio"`
	Priorizados      int    `json:"priorizados"`
	Niveles          Levels `json:"niveles"`
}

func field(payload json.RawMessage, key string) (json.RawMessage, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(payload, &fields); err != nil {
		return nil, err
	}
	return fields[key], nil
}

// status is `pyStr(payload['Estado'] ?? "").trim().toLowerCase()`. strings.ToLower differs from
// toLowerCase only where a letter lowers to several runes (İ), which no closed status contains.
func status(payload json.RawMessage) (string, error) {
	v, err := field(payload, "Estado")
	if err != nil {
		return "", err
	}
	if bytes.Equal(bytes.TrimSpace(v), []byte("null")) {
		v = nil
	}
	s, err := PyStr(v)
	return strings.ToLower(JSTrim(s)), err
}

func countOpen(records []StoredRecord, closed ...string) (int, error) {
	n := 0
	for _, r := range records {
		s, err := status(r.Payload)
		if err != nil {
			return 0, err
		}
		if !slices.Contains(closed, s) {
			n++
		}
	}
	return n, nil
}

// alertLevel is `pyTruthy(Nivel_Preliminar) ? Nivel_Preliminar : pyTruthy(Nivel) ? Nivel :
// 'Sin nivel'`, then pyStr.
func alertLevel(payload json.RawMessage) (string, error) {
	for _, key := range []string{"Nivel_Preliminar", "Nivel"} {
		v, err := field(payload, key)
		if err != nil {
			return "", err
		}
		truthy, err := PyTruthy(v)
		if err != nil {
			return "", err
		}
		if truthy {
			return PyStr(v)
		}
	}
	return "Sin nivel", nil
}

// NewDashboardSummary is dashboardSummary (app.py:984 `/api/dashboard`): the executive counters
// of the dashboard.
func NewDashboardSummary(records RecordsByModule) (DashboardSummary, error) {
	s := DashboardSummary{
		Eventos:     len(records.Of("Eventos")),
		Actores:     len(records.Of("Actores")),
		Directorio:  len(records.Of("Directorio_Territorial")),
		Priorizados: len(records.Of("Actores_Priorizados")),
	}
	var err error
	if s.DemandasAbiertas, err = countOpen(records.Of("Demandas"), "cerrada", "cerrado"); err != nil { //nolint:misspell // Spanish name kept verbatim from the TypeScript API
		return DashboardSummary{}, err
	}
	alerts := records.Of("Alertas")
	if s.AlertasActivas, err = countOpen(alerts, "cerrada", "cerrado", "descartada", "descartado"); err != nil {
		return DashboardSummary{}, err
	}
	s.Niveles.counts = map[string]int{}
	for _, a := range alerts {
		level, err := alertLevel(a.Payload)
		if err != nil {
			return DashboardSummary{}, err
		}
		s.Niveles.add(level)
	}
	return s, nil
}
