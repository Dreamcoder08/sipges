// Package domain holds the rules of apps/api/src/contexts/indicators that are not engine logic:
// which module records the engine reads and how they are shaped, the project phase that
// replaces the IRSA weights (indicators-service.ts), the history `limit` query, and the static
// model status and validation template. The computation itself (computeIndicators, computeIrsa)
// runs in the Rust engine (ADR 0032); every engine answer is passed on as the engine wrote it.
package domain

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
)

// Modules are INDICATOR_MODULES, in their order: the modules the indicators read.
//
//nolint:misspell // Spanish module names, verbatim from the TypeScript API.
var Modules = []string{
	"Eventos", "Actores", "Demandas", "Compromisos", "Narrativas", "Alertas", "Acciones",
	"Directorio_Territorial",
}

// Record is one module_records row: its id and its payload, a JSON object as PostgreSQL wrote it.
type Record struct {
	ID      string
	Payload json.RawMessage
}

// Records are a tenant's records of each module; a module missing from the map has none.
type Records map[string][]Record

// JSON is the engine's `records` field: every module of Modules in order, each record its payload
// plus `_id`, like app.py records_of (`{...payload, _id}`). `_id` is appended as a duplicate key:
// a JSON object keeps a duplicate key's first position and last value (JSON.parse and the
// engine's parser alike), which is exactly where the spread puts it.
func (r Records) JSON() (json.RawMessage, error) {
	var b bytes.Buffer
	b.WriteByte('{')
	for i, module := range Modules {
		if i > 0 {
			b.WriteByte(',')
		}
		b.Write(mustString(module))
		b.WriteString(":[")
		for j, rec := range r[module] {
			if j > 0 {
				b.WriteByte(',')
			}
			obj, err := AppendMember(rec.Payload, "_id", mustString(rec.ID))
			if err != nil {
				return nil, fmt.Errorf("record %s/%s: %w", module, rec.ID, err)
			}
			b.Write(obj)
		}
		b.WriteByte(']')
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}

// ErrNotObject is returned when a JSON value that must be an object is not one.
var ErrNotObject = errors.New("indicators: not a JSON object")

// AppendMember returns the object obj with "key": value written last. When obj already has key,
// the result reads as `{...obj, [key]: value}`: the first position with the last value.
func AppendMember(obj json.RawMessage, key string, value json.RawMessage) (json.RawMessage, error) {
	trimmed := bytes.TrimSpace(obj)
	if len(trimmed) < 2 || trimmed[0] != '{' || trimmed[len(trimmed)-1] != '}' {
		return nil, ErrNotObject
	}
	body := bytes.TrimSpace(trimmed[1 : len(trimmed)-1])
	out := make([]byte, 0, len(body)+len(key)+len(value)+8)
	out = append(out, '{')
	out = append(out, body...)
	if len(body) > 0 {
		out = append(out, ',')
	}
	out = append(out, mustString(key)...)
	out = append(out, ':')
	out = append(out, value...)
	return append(out, '}'), nil
}

// Encode is JSON without Go's HTML escaping, closer to JSON.stringify.
func Encode(v any) ([]byte, error) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(b.Bytes(), []byte("\n")), nil
}

func mustString(s string) []byte {
	b, _ := Encode(s) // a Go string always encodes
	return b
}

// member is one key of a JSON object, in source order.
type member struct {
	key   string
	value json.RawMessage
}

// members splits a JSON object into its keys, in source order.
func members(obj json.RawMessage) ([]member, error) {
	dec := json.NewDecoder(bytes.NewReader(obj))
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	if tok != json.Delim('{') {
		return nil, ErrNotObject
	}
	var out []member
	for dec.More() {
		tok, err := dec.Token()
		if err != nil {
			return nil, err
		}
		key, _ := tok.(string) // object keys are always strings
		var value json.RawMessage
		if err := dec.Decode(&value); err != nil {
			return nil, err
		}
		out = append(out, member{key: key, value: value})
	}
	return out, nil
}

// writeObject writes members as one JSON object.
func writeObject(ms []member) []byte {
	var b bytes.Buffer
	b.WriteByte('{')
	for i, m := range ms {
		if i > 0 {
			b.WriteByte(',')
		}
		b.Write(mustString(m.key))
		b.WriteByte(':')
		b.Write(m.value)
	}
	b.WriteByte('}')
	return b.Bytes()
}
