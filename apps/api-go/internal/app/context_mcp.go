package app

import (
	"net/http"

	integration "github.com/Dreamcoder08/sipges/apps/api-go/internal/integration/application"
	integrationhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/integration/http"
)

func init() {
	registerContext("mcp", func(d Deps) (func(*http.ServeMux), error) {
		mcp := integrationhttp.MCP{Keys: apiKeys(d), Tools: integration.MCP{}, Log: d.Logger}
		return func(mux *http.ServeMux) { integrationhttp.RegisterMCP(mux, mcp) }, nil
	})
}
