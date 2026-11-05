package domain

import (
	"math"
	"regexp"
	"strconv"

	records "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/domain"
)

// Inbound webhooks (domain/ingest.ts, docs/adr/0014 §6). Bodies are the JSON values of the
// records context's reader (records.ParseBody): nil, bool, float64, string, []any, *Object.

// MaxIngestRecords is MAX_INGEST_RECORDS: records one call may create.
const MaxIngestRecords = 50

// maxFields is MAX_FIELDS: fields per record.
const maxFields = 200

var idempotencyKey = regexp.MustCompile(`^[\x21-\x7e]{1,200}$`)

// IngestProblem is the first refused record: Index is -1 when the problem is the whole call.
type IngestProblem struct {
	Index   int
	Message string
}

// IngestPayloads is ingestPayloads: one record object, an array of records, or {"records": [...]}.
func IngestPayloads(body any) ([]*records.Object, *IngestProblem) {
	var list []any
	switch b := body.(type) {
	case []any:
		list = b
	case *records.Object:
		inner, has := b.Get("records")
		if arr, isArray := inner.([]any); has && isArray && len(b.Keys()) == 1 {
			list = arr
		} else {
			list = []any{body}
		}
	default:
		list = []any{body}
	}
	if len(list) == 0 {
		return nil, &IngestProblem{Index: -1, Message: "Sin registros"}
	}
	if len(list) > MaxIngestRecords {
		return nil, &IngestProblem{Index: -1, Message: "Máximo " + strconv.Itoa(MaxIngestRecords) + " registros por llamada"}
	}
	payloads := make([]*records.Object, len(list))
	for i, item := range list {
		o, ok := item.(*records.Object)
		if !ok {
			return nil, &IngestProblem{Index: i, Message: "Cada registro debe ser un objeto JSON"}
		}
		switch n := len(o.Keys()); {
		case n == 0:
			return nil, &IngestProblem{Index: i, Message: "Registro vacío"}
		case n > maxFields:
			return nil, &IngestProblem{Index: i, Message: "Máximo " + strconv.Itoa(maxFields) + " campos"}
		}
		payloads[i] = o
	}
	return payloads, nil
}

// IdempotencyKey is idempotencyKey: "" without a key, invalid when it is not 1–200 printable
// ASCII characters without spaces.
func IdempotencyKey(header string, present bool) (key string, invalid bool) {
	if !present || header == "" {
		return "", false
	}
	if !idempotencyKey.MatchString(header) {
		return "", true
	}
	return header, false
}

// Truthy is JavaScript truthiness of a parsed JSON value.
func Truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case float64:
		return x != 0 && !math.IsNaN(x)
	case string:
		return x != ""
	}
	return true
}

// PayloadProject is payloadProject: payload.Proyecto_ID || payload.project_id. It reports
// whether that names a project other than projectID (a truthy value that is not that string).
func PayloadProject(payload *records.Object, projectID string) (other bool) {
	v, _ := payload.Get("Proyecto_ID")
	if !Truthy(v) {
		v, _ = payload.Get("project_id")
	}
	if !Truthy(v) {
		return false
	}
	s, isString := v.(string)
	return !isString || s != projectID
}
