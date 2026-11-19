package desktopsnapshot

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"strings"
)

// Hasher is client.mjs's keyed(salt): the keyed hash of a typed value.
type Hasher func(value any) string

// saltKey is Buffer.from(salt, 'hex'): byte pairs up to the first one that is not hex.
func saltKey(salt string) []byte {
	var key []byte
	for i := 0; i+1 < len(salt); i += 2 {
		b, err := hex.DecodeString(salt[i : i+2])
		if err != nil {
			break
		}
		key = append(key, b[0])
	}
	return key
}

// Keyed is HMAC-SHA256 with the salt of JSON.stringify(canonical(value)).
func Keyed(salt string) Hasher {
	key := saltKey(salt)
	return func(value any) string {
		text, ok := Stringify(Canonical(value), "")
		if !ok {
			text = "undefined"
		}
		mac := hmac.New(sha256.New, key)
		_, _ = mac.Write([]byte(text))
		return hex.EncodeToString(mac.Sum(nil))
	}
}

// KeyedBytes is keyedBytes(salt): the keyed hash of raw bytes, never their plain SHA-256.
func KeyedBytes(salt string) func([]byte) string {
	key := saltKey(salt)
	return func(b []byte) string {
		mac := hmac.New(sha256.New, key)
		_, _ = mac.Write(b)
		return hex.EncodeToString(mac.Sum(nil))
	}
}

// Short is the first eight characters a line prints of a hash.
func Short(hash string) string {
	if len(hash) > 8 {
		return hash[:8]
	}
	return hash
}

// entries is Object.entries: [key, value] pairs in key order.
func entries(v any) [][2]any {
	switch x := v.(type) {
	case *Object:
		out := make([][2]any, 0, x.Len())
		for _, k := range x.Keys() {
			out = append(out, [2]any{k, x.vals[k]})
		}
		return out
	case []any:
		out := make([][2]any, len(x))
		for i, item := range x {
			out[i] = [2]any{NumberString(float64(i)), item}
		}
		return out
	case string:
		units := utf16Units(x)
		out := make([][2]any, len(units))
		for i, u := range units {
			var b strings.Builder
			writeUnit(&b, u)
			out[i] = [2]any{NumberString(float64(i)), b.String()}
		}
		return out
	}
	return nil
}

// ContentHash is snapshot.mjs's contentHash: a record's own fields (not _id or _updated_at),
// sorted by name, hashed as [name, value] pairs.
func ContentHash(h Hasher, row any) string {
	var pairs [][2]any
	for _, e := range entries(row) {
		if k := e[0].(string); k != "_id" && k != "_updated_at" {
			pairs = append(pairs, e)
		}
	}
	keys := make([]string, len(pairs))
	byKey := map[string]any{}
	for i, p := range pairs {
		keys[i] = p[0].(string)
		byKey[keys[i]] = p[1]
	}
	SortStrings(keys)
	list := make([]any, len(keys))
	for i, k := range keys {
		list[i] = []any{k, byKey[k]}
	}
	return h(list)
}

// exportBigintColumns are snapshot.mjs's EXPORT_BIGINT_COLUMNS: compared by value.
var exportBigintColumns = map[string]map[string]bool{"attachments": {"size_bytes": true}}

// ExportRowHash is snapshot.mjs's exportRowHash: a safe integer in a bigint column hashes as its
// digits, so 1234 and "1234" are the same row.
func ExportRowHash(h Hasher, table string, row any) string {
	bigints := exportBigintColumns[table]
	o, isObject := row.(*Object)
	if bigints == nil || !isObject {
		if bigints != nil {
			return h(objectFrom(entries(row)))
		}
		return h(row)
	}
	byValue := NewObject()
	for _, k := range o.Keys() {
		v := o.vals[k]
		if bigints[k] && IsSafeInteger(v) {
			v = ToString(v)
		}
		byValue.Set(k, v)
	}
	return h(byValue)
}

// objectFrom is Object.fromEntries.
func objectFrom(pairs [][2]any) *Object {
	o := NewObject()
	for _, p := range pairs {
		o.Set(ToString(p[0]), p[1])
	}
	return o
}
