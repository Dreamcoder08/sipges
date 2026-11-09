package infrastructure

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	privacy "github.com/Dreamcoder08/sipges/apps/api-go/internal/privacy/application"
	js "github.com/Dreamcoder08/sipges/apps/api-go/internal/situations/domain"
)

const (
	defaultBaseURL = "https://api.anthropic.com"
	messagesPath   = "/v1/messages"
	apiVersion     = "2026-10-21"
	fallbackBeta   = "server-side-fallback-2026-07-01"
	stopRefusal    = "refusal"
	stopMaxTokens  = "max_tokens"
	textBlock      = "text"
)

// Claude rewrites the extractive briefing as prose (docs/adr/0013), the port of claude-narrator.ts.
// It sends what TypeScript's SDK sends. Only the configured base URL is contacted: redirects fail
// the call and proxy variables are ignored. Its errors are fixed texts, so neither the credential,
// the URL nor the text reach a log.
type Claude struct {
	endpoint   string
	credential string
	model      string
	client     *http.Client
}

// NewClaude reads the base URL and the credential from the environment, as the TypeScript SDK does:
// values are trimmed, an empty one counts as unset, and the API key wins over the auth token.
func NewClaude(model string, lookup func(string) (string, bool)) *Claude {
	base := environmentValue(lookup, "ANTHROPIC_BASE_URL")
	if base == "" {
		base = defaultBaseURL
	}
	credential := environmentValue(lookup, "ANTHROPIC_API_KEY")
	if credential == "" {
		credential = environmentValue(lookup, "ANTHROPIC_AUTH_TOKEN")
	}
	return &Claude{
		endpoint: strings.TrimRight(base, "/") + messagesPath, credential: credential, model: model,
		client: narrationClient(),
	}
}

// Name is the narrator the briefing reports.
func (c *Claude) Name() string { return "claude:" + c.model }

// Narrate returns the model's prose for a cleared briefing; a refusal or a cut answer is an error.
func (c *Claude) Narrate(ctx context.Context, briefing privacy.Sanitised[string]) (string, error) {
	if c.credential == "" {
		return "", errors.New("narrator: no credential") // TypeScript's SDK sends nothing either
	}
	body := narrationBody(c.model, briefing.Value())
	return narrate(ctx, func(ctx context.Context) ([]byte, time.Duration, error) {
		return post(ctx, c.client, c.endpoint, map[string]string{
			"anthropic-version": apiVersion,
			"anthropic-beta":    fallbackBeta,
			"Authorization":     "Bearer " + c.credential,
		}, body)
	}, prose)
}

// prose reads the answer: its text blocks, trimmed. Numbers and unknown fields are ignored.
func prose(raw []byte) (string, error) {
	var answer *struct {
		StopReason string `json:"stop_reason"`
		Content    []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := json.Unmarshal(raw, &answer); err != nil || answer == nil {
		return "", errors.New("narrator: unreadable answer")
	}
	switch answer.StopReason {
	case stopRefusal:
		return "", errors.New("narrator: the model declined the briefing")
	case stopMaxTokens:
		return "", errors.New("narrator: the narrative was truncated")
	}
	var text strings.Builder
	for _, block := range answer.Content {
		if block.Type == textBlock {
			text.WriteString(block.Text)
		}
	}
	return js.TrimJS(text.String()), nil
}

// narrationBody is the request as JSON.stringify writes it: half an emoji stays the escape
// TypeScript sends, which encoding/json would turn into a replacement character.
func narrationBody(model, briefing string) []byte {
	content := briefingContent(briefing)
	body := append([]byte(`{"model":`), stringify(model)...)
	body = append(body, `,"max_tokens":`...)
	body = strconv.AppendInt(body, maxNarrationTokens, 10)
	body = append(body, `,"output_config":{"effort":"low"},"fallbacks":"default","system":`...)
	body = append(body, stringify(systemPrompt)...)
	body = append(body, `,"messages":[{"role":"user","content":`...)
	body = append(body, stringify(content)...)
	return append(body, `}]}`...)
}
