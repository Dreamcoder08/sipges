//nolint:misspell // Spanish messages, verbatim from the TypeScript API.
package http

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"slices"
	"strings"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/integration/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/integration/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
	records "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/domain"
)

// The MCP server of mcp-routes.ts: stateless Streamable HTTP (docs/adr/0014 §7), each POST one
// JSON-RPC message answered with JSON, no session and no server-initiated stream. /mcp is a
// machine path, so the session and Origin gates let it through; the guard here and the API key
// are its own. Answers are built from JavaScript values and written by records.Stringify, so an
// id, a tool's data and its text come out as JSON.stringify writes them.

// mcpVersions is MCP_VERSIONS: newest first; a client asking for another gets the newest.
var mcpVersions = []string{"2025-11-25", "2025-06-18", "2025-03-26"}

const mcpInstructions = "SIPGES es una plataforma de gestión socioambiental territorial. Empieza con list_object_types, " +
	"busca con search_records y profundiza con get_links, get_timeline y get_briefing. Cita los " +
	"identificadores de los registros en tus respuestas."

// Tools runs a tool of the MCP server.
type Tools interface {
	Run(ctx context.Context, tool domain.Tool, principal domain.Principal, input *records.Object) (application.ToolResult, error)
}

// MCP is what the routes need.
type MCP struct {
	Keys  KeyService
	Tools Tools
	Log   *slog.Logger
}

// RegisterMCP mounts /mcp.
func RegisterMCP(mux *http.ServeMux, m MCP) {
	mux.HandleFunc("GET /mcp", func(w http.ResponseWriter, _ *http.Request) {
		detail(w, http.StatusMethodNotAllowed, "Use POST: este servidor MCP no abre flujos SSE")
	})
	mux.HandleFunc("DELETE /mcp", func(w http.ResponseWriter, _ *http.Request) {
		detail(w, http.StatusMethodNotAllowed, "Servidor MCP sin sesión")
	})
	mux.HandleFunc("POST /mcp", m.post)
}

// object is a JavaScript object from key, value pairs, in order.
func object(pairs ...any) *records.Object {
	out := records.NewObject()
	for i := 0; i+1 < len(pairs); i += 2 {
		key, _ := pairs[i].(string)
		out.Set(key, pairs[i+1])
	}
	return out
}

func writeValue(w http.ResponseWriter, status int, value any) {
	writeRaw(w, status, records.Stringify(value))
}

func rpcError(id any, code float64, message string) *records.Object {
	return object("jsonrpc", "2.0", "id", id, "error", object("code", code, "message", message))
}

func rpcResult(id, result any) *records.Object {
	return object("jsonrpc", "2.0", "id", id, "result", result)
}

// foreignOrigin is the DNS-rebinding guard of the MCP transport spec: a browser Origin must be
// this host.
func foreignOrigin(r *http.Request) bool {
	origin, _ := httpx.Header(r, "Origin")
	return origin != "" && origin != "null" && domain.URLHost(origin) != strings.ToLower(r.Host)
}

// toolError is what the client sees of a refused call: a result, never a JSON-RPC error.
func toolError(text string) *records.Object {
	return object("content", []any{object("type", "text", "text", text)}, "isError", true)
}

func (m MCP) post(w http.ResponseWriter, r *http.Request) {
	if foreignOrigin(r) {
		detail(w, http.StatusForbidden, "Origen de solicitud no permitido")
		return
	}
	principal, r, ok := Runtime{Keys: m.Keys, Log: m.Log}.authenticateKey(w, r, false)
	if !ok {
		return
	}
	data, err := io.ReadAll(r.Body)
	var body any
	if err == nil {
		body, err = records.ParseBody(data)
	}
	if err != nil {
		writeValue(w, http.StatusBadRequest, rpcError(nil, -32700, "Parse error"))
		return
	}
	message, isObject := body.(*records.Object)
	var version, method any
	if isObject {
		version, _ = message.Get("jsonrpc")
		method, _ = message.Get("method")
	}
	name, named := method.(string)
	if !isObject || version != "2.0" || !named {
		writeValue(w, http.StatusBadRequest, rpcError(nil, -32600, "Invalid Request: one JSON-RPC 2.0 message per POST"))
		return
	}
	id, hasID := message.Get("id")
	if !hasID { // notifications and responses from the client need no answer
		w.WriteHeader(http.StatusAccepted)
		return
	}
	raw, _ := message.Get("params")
	params, isParams := raw.(*records.Object)
	if !isParams {
		params = records.NewObject()
	}
	switch name {
	case "initialize":
		writeValue(w, http.StatusOK, rpcResult(id, initializeResult(params)))
	case "ping":
		writeValue(w, http.StatusOK, rpcResult(id, records.NewObject()))
	case "tools/list":
		tools := []any{}
		for _, tool := range domain.ToolsFor(*principal) {
			tools = append(tools, tool.Descriptor)
		}
		writeValue(w, http.StatusOK, rpcResult(id, object("tools", tools)))
	case "tools/call":
		writeValue(w, http.StatusOK, m.call(r, *principal, id, params))
	default:
		writeValue(w, http.StatusOK, rpcError(id, -32601, "Método no soportado: "+name))
	}
}

func initializeResult(params *records.Object) *records.Object {
	raw, _ := params.Get("protocolVersion")
	requested, _ := raw.(string)
	version := mcpVersions[0]
	if slices.Contains(mcpVersions, requested) {
		version = requested
	}
	return object(
		"protocolVersion", version,
		"capabilities", object("tools", object("listChanged", false)),
		"serverInfo", object("name", "sipges", "title", "SIPGES", "version", "1.0.0"),
		"instructions", mcpInstructions,
	)
}

func (m MCP) call(r *http.Request, principal domain.Principal, id any, params *records.Object) *records.Object {
	raw, _ := params.Get("name")
	name, _ := raw.(string)
	at := slices.IndexFunc(domain.ToolsFor(principal), func(t domain.Tool) bool { return t.Name == name })
	if at < 0 {
		return rpcError(id, -32602, "Herramienta desconocida: "+name)
	}
	tool := domain.ToolsFor(principal)[at]
	// params.arguments ?? {}: an absent or null value reads as no arguments.
	var input any = records.NewObject()
	if given, ok := params.Get("arguments"); ok && given != nil {
		input = given
	}
	parsed, issues := tool.ParseArguments(input)
	if issues != "" {
		return rpcResult(id, toolError("Argumentos no válidos: "+issues))
	}
	result, err := m.answer(r.Context(), tool, principal, parsed)
	if err != nil {
		// The tool's name only: the error may carry a record's content.
		if m.Log != nil {
			m.Log.LogAttrs(r.Context(), slog.LevelError, "mcp_tool_failed", slog.String("tool", name),
				slog.String("request_id", httpx.RequestIDFrom(r.Context())))
		}
		return rpcResult(id, toolError("Error interno de SIPGES"))
	}
	return rpcResult(id, result)
}

func (m MCP) answer(ctx context.Context, tool domain.Tool, principal domain.Principal, input *records.Object) (*records.Object, error) {
	outcome, err := m.Tools.Run(ctx, tool, principal, input)
	if err != nil {
		return nil, err
	}
	if !outcome.OK {
		return toolError(outcome.Error), nil
	}
	encoded, err := json.Marshal(outcome.Data)
	if err != nil {
		return nil, err
	}
	data, err := records.ParseBody(encoded)
	if err != nil {
		return nil, err
	}
	structured, isRecord := data.(*records.Object)
	if !isRecord {
		structured = object("result", data)
	}
	return object(
		"content", []any{object("type", "text", "text", string(records.Stringify(data)))},
		"structuredContent", structured,
		"isError", false,
	), nil
}
