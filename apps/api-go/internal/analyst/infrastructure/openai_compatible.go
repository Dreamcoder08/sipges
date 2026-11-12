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
	completionsPath     = "/v1/chat/completions"
	versionSegment      = "/v1"
	finishLength        = "length"
	finishContentFilter = "content_filter"
)

// OpenAICompatible rewrites the extractive briefing as prose (docs/adr/0013) through any provider
// that speaks Chat Completions: OpenAI, DeepSeek, Ollama, OpenRouter, Groq, vLLM. It has the safety
// of Claude: only the configured base URL is contacted, redirects fail the call, proxy variables
// are ignored, and its errors are fixed texts, so neither the credential, the URL nor the text
// reach a log.
type OpenAICompatible struct {
	endpoint   string
	credential string
	model      string
	client     *http.Client
}

// NewOpenAICompatible reads SIPGES_ANALYST_BASE_URL and SIPGES_ANALYST_API_KEY from the
// environment; values are trimmed and an empty key means none, which config allows on loopback only.
func NewOpenAICompatible(model string, lookup func(string) (string, bool)) *OpenAICompatible {
	return &OpenAICompatible{
		endpoint:   completionsEndpoint(environmentValue(lookup, "SIPGES_ANALYST_BASE_URL")),
		credential: environmentValue(lookup, "SIPGES_ANALYST_API_KEY"),
		model:      model,
		client:     narrationClient(),
	}
}

// completionsEndpoint appends /v1/chat/completions to the API root, or only /chat/completions
// when the base already ends in /v1.
func completionsEndpoint(base string) string {
	base = strings.TrimRight(base, "/")
	if strings.HasSuffix(base, versionSegment) {
		return base + strings.TrimPrefix(completionsPath, versionSegment)
	}
	return base + completionsPath
}

// Name is the narrator the briefing reports.
func (c *OpenAICompatible) Name() string { return "openai-compatible:" + c.model }

// Narrate returns the model's prose for a cleared briefing; a declined, cut or empty answer is an error.
func (c *OpenAICompatible) Narrate(ctx context.Context, briefing privacy.Sanitised[string]) (string, error) {
	body := c.requestBody(briefing.Value())
	header := map[string]string{}
	if c.credential != "" {
		header["Authorization"] = "Bearer " + c.credential
	}
	return narrate(ctx, func(ctx context.Context) ([]byte, time.Duration, error) {
		return post(ctx, c.client, c.endpoint, header, body)
	}, completionProse)
}

// requestBody is the request as JSON.stringify writes it, see stringify.
func (c *OpenAICompatible) requestBody(briefing string) []byte {
	body := append([]byte(`{"model":`), stringify(c.model)...)
	body = append(body, `,"max_tokens":`...)
	body = strconv.AppendInt(body, maxNarrationTokens, 10)
	body = append(body, `,"messages":[{"role":"system","content":`...)
	body = append(body, stringify(systemPrompt)...)
	body = append(body, `},{"role":"user","content":`...)
	body = append(body, stringify(briefingContent(briefing))...)
	return append(body, `}]}`...)
}

// completionProse reads the first choice's message, trimmed. Unknown fields are ignored.
func completionProse(raw []byte) (string, error) {
	var answer *struct {
		Choices []struct {
			FinishReason *string `json:"finish_reason"`
			Message      *struct {
				Content *string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(raw, &answer); err != nil || answer == nil {
		return "", errors.New("narrator: unreadable answer")
	}
	if len(answer.Choices) == 0 {
		return "", errors.New("narrator: the model returned no text")
	}
	choice := answer.Choices[0]
	if choice.FinishReason != nil {
		switch *choice.FinishReason {
		case finishLength:
			return "", errors.New("narrator: the narrative was truncated")
		case finishContentFilter:
			return "", errors.New("narrator: the model declined the briefing")
		}
	}
	if choice.Message == nil || choice.Message.Content == nil {
		return "", errors.New("narrator: the model returned no text")
	}
	text := js.TrimJS(*choice.Message.Content)
	if text == "" {
		return "", errors.New("narrator: the model returned no text")
	}
	return text, nil
}
