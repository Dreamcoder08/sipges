package infrastructure

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/automation/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/automation/domain"
	records "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/domain"
)

// SendTimeout is SEND_TIMEOUT_MS of http-channel-sender.ts.
const SendTimeout = 10 * time.Second

// Sender is createHttpChannelSender: POST over HTTPS, no redirects, any non-2xx is an error.
type Sender struct {
	// Client overrides the HTTP client (tests); nil means one with SendTimeout and no redirects.
	Client *http.Client
}

var errRedirect = errors.New("redirect refused")

var defaultClient = &http.Client{
	Timeout: SendTimeout,
	CheckRedirect: func(*http.Request, []*http.Request) error {
		return errRedirect // fetch's redirect: 'error'
	},
}

// Request is one outbound request: URL, extra headers in order, and the body.
type Request struct {
	URL     string
	Headers [][2]string
	Body    []byte
}

// SignWebhook is signWebhook: Standard Webhooks, base64 HMAC-SHA256 of `id.timestamp.body`.
func SignWebhook(secret, id string, timestamp int64, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(id + "." + strconv.FormatInt(timestamp, 10) + "."))
	mac.Write(body)
	return "v1," + base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

func object(pairs ...any) *records.Object {
	o := records.NewObject()
	for i := 0; i < len(pairs); i += 2 {
		o.Set(pairs[i].(string), pairs[i+1]) //nolint:forcetypeassert,gosec // literal key/value pairs
	}
	return o
}

func plain(m application.Message) string { return m.Title + "\n" + m.Text }

// RequestFor is requestFor: the request each channel kind expects, bodies as JSON.stringify
// writes them.
func RequestFor(c domain.ChannelConfig, m application.Message) Request {
	switch c.Kind {
	case "webhook":
		body := object("id", m.ID, "title", m.Title, "text", m.Text)
		if m.Event != nil {
			for _, k := range m.Event.Keys() {
				v, _ := m.Event.Get(k)
				body.Set(k, v)
			}
		}
		raw := records.Stringify(body)
		timestamp := m.At.UnixMilli() / 1000
		if m.At.UnixMilli() < 0 && m.At.UnixMilli()%1000 != 0 {
			timestamp-- // Math.floor
		}
		return Request{URL: c.URL, Body: raw, Headers: [][2]string{
			{"webhook-id", m.ID},
			{"webhook-timestamp", strconv.FormatInt(timestamp, 10)},
			{"webhook-signature", SignWebhook(c.Secret, m.ID, timestamp, raw)},
		}}
	case "slack":
		return Request{URL: c.URL, Body: records.Stringify(object("text", "*"+m.Title+"*\n"+m.Text))}
	case "discord":
		return Request{URL: c.URL, Body: records.Stringify(object(
			"content", domain.Slice16(plain(m), 2000),
			"allowed_mentions", object("parse", []any{})))}
	case "gchat":
		return Request{URL: c.URL, Body: records.Stringify(object("text", plain(m)))}
	case "teams":
		card := object(
			"$schema", "http://adaptivecards.io/schemas/adaptive-card.json",
			"type", "AdaptiveCard",
			"version", "1.4",
			"body", []any{
				object("type", "TextBlock", "text", m.Title, "weight", "Bolder", "wrap", true),
				object("type", "TextBlock", "text", m.Text, "wrap", true),
			})
		return Request{URL: c.URL, Body: records.Stringify(object(
			"type", "message",
			"attachments", []any{object("contentType", "application/vnd.microsoft.card.adaptive", "content", card)}))}
	case "telegram":
		return Request{URL: "https://api.telegram.org/bot" + c.BotToken + "/sendMessage", Body: records.Stringify(object(
			"chat_id", c.ChatID,
			"text", domain.Slice16(plain(m), 4096),
			"disable_web_page_preview", true))}
	case "email":
		to := make([]any, len(c.To))
		for i, a := range c.To {
			to[i] = a
		}
		return Request{
			URL:     "https://api.resend.com/emails",
			Headers: [][2]string{{"authorization", "Bearer " + c.APIKey}, {"idempotency-key", m.ID}},
			Body: records.Stringify(object("from", c.From, "to", to, "subject", m.Title,
				"text", m.Text+"\n\n— Automatización de SIPGES")),
		}
	}
	return Request{}
}

// Send posts the message. Errors never echo the URL: it may embed a token.
func (s Sender) Send(ctx context.Context, c domain.ChannelConfig, m application.Message) error {
	r := RequestFor(c, m)
	if r.URL == "" {
		return errors.New("Canal " + c.Kind + ": sin conexión")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, r.URL, bytes.NewReader(r.Body))
	if err != nil {
		return errors.New("Canal " + c.Kind + ": sin conexión")
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("user-agent", "SIPGES-Automation/1")
	for _, h := range r.Headers {
		req.Header.Set(h[0], h[1])
	}
	client := s.Client
	if client == nil {
		client = defaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		reason := "sin conexión"
		var timeout interface{ Timeout() bool }
		if errors.As(err, &timeout) && timeout.Timeout() || errors.Is(err, context.DeadlineExceeded) {
			reason = "tiempo agotado"
		}
		return errors.New("Canal " + c.Kind + ": " + reason)
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	_ = resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return errors.New("Canal " + c.Kind + ": respuesta HTTP " + strconv.Itoa(resp.StatusCode))
	}
	return nil
}
