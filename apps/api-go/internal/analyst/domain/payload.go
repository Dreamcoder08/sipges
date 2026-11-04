package domain

import (
	"bytes"
	"encoding/json"
	"errors"
	"sort"
	"strconv"
	"strings"
)

// Field is one payload entry.
type Field struct {
	Key   string
	Value any // decoded JSON: string, json.Number, bool, nil, []any or map[string]any
}

// Payload is a record's JSON object in the order Object.entries gives after JSON.parse: integer
// keys (array indices) first in ascending order, then the rest as stored.
type Payload []Field

// Get is payload[key]; ok is false when the key is absent.
func (p Payload) Get(key string) (any, bool) {
	for _, f := range p {
		if f.Key == key {
			return f.Value, true
		}
	}
	return nil, false
}

// ParsePayload reads a JSON object (jsonb's text output) keeping its key order, then orders it as
// a JavaScript object would.
func ParsePayload(text []byte) (Payload, error) {
	dec := json.NewDecoder(bytes.NewReader(text))
	dec.UseNumber()
	open, err := dec.Token()
	if err != nil {
		return nil, err
	}
	if open != json.Delim('{') {
		return Payload{}, nil // a non-object payload has no own fields to read
	}
	var out Payload
	seen := map[string]int{}
	for dec.More() {
		token, err := dec.Token()
		if err != nil {
			return nil, err
		}
		key, ok := token.(string)
		if !ok {
			return nil, errors.New("payload: object key is not a string")
		}
		var value any
		if err := dec.Decode(&value); err != nil {
			return nil, err
		}
		if at, dup := seen[key]; dup { // JSON.parse keeps the first position, last value
			out[at].Value = value
			continue
		}
		seen[key] = len(out)
		out = append(out, Field{Key: key, Value: value})
	}
	sort.SliceStable(out, func(i, j int) bool {
		a, aok := arrayIndex(out[i].Key)
		b, bok := arrayIndex(out[j].Key)
		switch {
		case aok && bok:
			return a < b
		default:
			return aok && !bok
		}
	})
	return out, nil
}

// arrayIndex reports whether key is a canonical array index (0 … 2³²−2), which JavaScript
// objects list first.
func arrayIndex(key string) (uint64, bool) {
	if key == "" || len(key) > 10 || (len(key) > 1 && key[0] == '0') || strings.TrimLeft(key, "0123456789") != "" {
		return 0, false
	}
	n, err := strconv.ParseUint(key, 10, 64)
	return n, err == nil && n < 1<<32-1
}

// textOf is text() of ontology-service.ts: String(value).trim() for strings, numbers and
// booleans, else "".
func textOf(value any) string {
	switch v := value.(type) {
	case string:
		return trimJS(v)
	case json.Number:
		return jsNumber(numberOf(v))
	case bool:
		if v {
			return "true"
		}
		return "false"
	}
	return ""
}
