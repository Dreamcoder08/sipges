package desktopsnapshot

import (
	"context"
	"crypto/hmac"
	"crypto/sha1" //nolint:gosec // RFC 6238 TOTP, as authenticator apps compute it
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"syscall"
	"time"
)

// ModuleSlugs are client.mjs's MODULE_SLUGS: the record modules (/api/<slug>), in its order.
//
//nolint:misspell // Spanish module slugs, as the API names them
var ModuleSlugs = []string{
	"eventos", "actores", "demandas", "compromisos", "narrativas", "fuentes", "indicadores",
	"alertas", "acciones", "directorio", "priorizados", "usuarios", "roles", "proyectos",
	"intereses", "dialogos", "oportunidades", "hechos", "aarc", "buzon", "lecciones",
}

// Undici's defaults, which Node's fetch uses: the headers and every gap in a body.
const (
	headersTimeout = 300 * time.Second
	bodyTimeout    = 300 * time.Second
)

// SignInError is a refused sign-in.
type SignInError struct{ Status int }

func (e *SignInError) Error() string { return fmt.Sprintf("Sign-in failed (status %d)", e.Status) }

// RedirectError is a 3xx answer: never followed (the data would come from another server).
type RedirectError struct {
	Route  string
	Status int
}

func (e *RedirectError) Error() string {
	return fmt.Sprintf("%s answered %d, a redirect (not followed)", e.Route, e.Status)
}

// NetworkError is what Node's fetch rejects with a TypeError and a cause: the server could not be
// reached, or it dropped the connection.
type NetworkError struct {
	Message string
	Cause   string
}

func (e *NetworkError) Error() string { return e.Message }

var routeIDs = regexp.MustCompile(`^(/api/[^/]+|/system/uploads)/[^/]+`)

// routeOf is a route for messages: without its query or ids, which may be record or upload ids.
func routeOf(path string) string {
	path, _, _ = strings.Cut(path, "?")
	return routeIDs.ReplaceAllString(path, "$1/<id>")
}

// causeOf names a transport failure as Node's fetch does: the socket error code when there is one.
func causeOf(err error) string {
	for _, known := range errnoNames {
		if errors.Is(err, known.errno) {
			return known.name
		}
	}
	if errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, io.EOF) {
		return "UND_ERR_SOCKET"
	}
	var dns *net.DNSError
	if errors.As(err, &dns) {
		return "ENOTFOUND"
	}
	var timeout interface{ Timeout() bool }
	if errors.As(err, &timeout) && timeout.Timeout() {
		return "UND_ERR_HEADERS_TIMEOUT"
	}
	return err.Error()
}

type errnoName struct {
	errno error
	name  string
}

var errnoNames = append([]errnoName{
	{syscall.ECONNREFUSED, "ECONNREFUSED"},
	{syscall.ECONNRESET, "ECONNRESET"},
	{syscall.ECONNABORTED, "ECONNABORTED"},
	{syscall.EPIPE, "EPIPE"},
	{syscall.ETIMEDOUT, "ETIMEDOUT"},
	{syscall.EHOSTUNREACH, "EHOSTUNREACH"},
	{syscall.ENETUNREACH, "ENETUNREACH"},
}, platformErrnoNames...)

// Session is a signed-in client.mjs session: one cookie, never a redirect followed.
type Session struct {
	base     string
	http     *http.Client
	cookie   string
	WithCode bool
}

// callOptions are client.mjs's call options.
type callOptions struct {
	method         string
	scope          string
	headers        map[string]string
	body           string
	acceptRedirect bool
	// timeout bounds the whole answer, the stream's 120 s; zero leaves undici's gaps only.
	timeout time.Duration
}

// Answer is one response with its body still to read; Close it.
type Answer struct {
	Status int
	Header http.Header
	body   io.ReadCloser
}

// Bytes reads the whole body (a dropped connection is a NetworkError) and closes it.
func (a *Answer) Bytes() ([]byte, error) {
	defer func() { _ = a.body.Close() }()
	b, err := io.ReadAll(a.body)
	if err != nil {
		return nil, bodyError(err)
	}
	return b, nil
}

// Close drops what is left of the body.
func (a *Answer) Close() { _ = a.body.Close() }

func bodyError(err error) error {
	var ne *NetworkError
	if errors.As(err, &ne) {
		return err
	}
	return &NetworkError{Message: "terminated", Cause: causeOf(err)}
}

// idleBody ends a body that sends nothing for bodyTimeout, as undici does.
type idleBody struct {
	io.ReadCloser
	timer  *time.Timer
	cancel context.CancelFunc
}

func (b *idleBody) Read(p []byte) (int, error) {
	n, err := b.ReadCloser.Read(p)
	b.timer.Reset(bodyTimeout)
	return n, err
}

func (b *idleBody) Close() error {
	b.timer.Stop()
	err := b.ReadCloser.Close()
	b.cancel()
	return err
}

func (s *Session) call(path string, o callOptions) (*Answer, error) {
	var ctx context.Context
	var cancel context.CancelFunc
	if o.timeout > 0 {
		ctx, cancel = context.WithTimeout(context.Background(), o.timeout)
	} else {
		ctx, cancel = context.WithCancel(context.Background())
	}
	method := o.method
	if method == "" {
		method = http.MethodGet
	}
	var body io.Reader
	if o.body != "" {
		body = strings.NewReader(o.body)
	}
	req, err := http.NewRequestWithContext(ctx, method, s.base+path, body)
	if err != nil {
		cancel()
		return nil, &NetworkError{Message: "Failed to parse URL from " + routeOf(path), Cause: "Invalid URL"}
	}
	req.Header.Set("Origin", s.base)
	req.Header.Set("Accept", "application/json")
	if s.cookie != "" {
		req.Header.Set("Cookie", s.cookie)
	}
	if o.scope != "" {
		req.Header.Set("X-SIPGES-Scope", o.scope)
	}
	for k, v := range o.headers {
		req.Header.Set(k, v)
	}
	resp, err := s.http.Do(req) //nolint:bodyclose // the Answer owns the body and closes it
	if err != nil {
		cancel()
		if o.timeout > 0 && ctx.Err() != nil {
			return nil, context.DeadlineExceeded
		}
		var ue *url.Error
		if errors.As(err, &ue) {
			err = ue.Err
		}
		return nil, &NetworkError{Message: "fetch failed", Cause: causeOf(err)}
	}
	timer := time.AfterFunc(bodyTimeout, cancel)
	answer := &Answer{Status: resp.StatusCode, Header: resp.Header, body: &idleBody{ReadCloser: resp.Body, timer: timer, cancel: cancel}}
	if !o.acceptRedirect && resp.StatusCode >= 300 && resp.StatusCode < 400 {
		answer.Close()
		return nil, &RedirectError{Route: method + " " + routeOf(path), Status: resp.StatusCode}
	}
	for _, c := range resp.Header.Values("Set-Cookie") {
		first, _, _ := strings.Cut(c, ";")
		if strings.HasPrefix(first, "sipges_session=") {
			s.cookie = first
		}
	}
	return answer, nil
}

// Login are the credentials of a sign-in.
type Login struct {
	Base, Username, Password string
	// OTP is the typed code; TOTPSecret makes one instead (synthetic rehearsals).
	OTP, TOTPSecret, TOTPState string
}

// SignIn signs in like the login page (POST /login) and returns the session.
func SignIn(l Login) (*Session, error) {
	s := &Session{
		base: strings.TrimRight(l.Base, "/"),
		http: &http.Client{
			Transport: &http.Transport{Proxy: nil, ResponseHeaderTimeout: headersTimeout, TLSHandshakeTimeout: 10 * time.Second},
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}
	code := l.OTP
	if code == "" && l.TOTPSecret != "" {
		step, err := nextStep(l.TOTPState)
		if err != nil {
			return nil, err
		}
		if code, err = TOTP(l.TOTPSecret, step); err != nil {
			return nil, err
		}
	}
	form := url.Values{"username": {l.Username}, "password": {l.Password}, "otp": {code}}
	answer, err := s.call("/login", callOptions{
		method:  http.MethodPost,
		headers: map[string]string{"Content-Type": "application/x-www-form-urlencoded"},
		body:    form.Encode(),
	})
	if err != nil {
		return nil, err
	}
	if _, err := answer.Bytes(); err != nil {
		return nil, err
	}
	if answer.Status != http.StatusOK || s.cookie == "" {
		return nil, &SignInError{Status: answer.Status}
	}
	s.WithCode = code != ""
	return s, nil
}

// readJSON is client.mjs's readJson: a body that is not JSON is named by its route only.
func readJSON(a *Answer, path string) (any, error) {
	b, err := a.Bytes()
	if err != nil {
		return nil, err
	}
	v, err := ParseJSON(DecodeText(b))
	if err != nil {
		return nil, fmt.Errorf("GET %s answered %d with a body that is not valid JSON", routeOf(path), a.Status)
	}
	return v, nil
}

// getJSON is client.mjs's getJson: the parsed body of a 200, or only the status.
func (s *Session) getJSON(path, scope string) (int, any, error) {
	a, err := s.call(path, callOptions{scope: scope})
	if err != nil {
		return 0, nil, err
	}
	if a.Status != http.StatusOK {
		if _, err := a.Bytes(); err != nil {
			return 0, nil, err
		}
		return a.Status, nil, nil
	}
	v, err := readJSON(a, path)
	return http.StatusOK, v, err
}

// TOTP is the RFC 6238 code (SHA-1, 30 s, 6 digits) of a base32 secret, as client.mjs computes it.
func TOTP(secret string, step int64) (string, error) {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
	var bits strings.Builder
	for _, c := range strings.ToUpper(secret) {
		if c == '=' || isSpace(c) {
			continue
		}
		v := strings.IndexRune(alphabet, c)
		if v < 0 {
			return "", errors.New("The TOTP secret is not base32") //nolint:staticcheck // ST1005: client.mjs's message
		}
		fmt.Fprintf(&bits, "%05b", v)
	}
	text := bits.String()
	key := make([]byte, 0, len(text)/8)
	for i := 0; i+8 <= len(text); i += 8 {
		var b byte
		for _, c := range text[i : i+8] {
			b <<= 1
			if c == '1' {
				b |= 1
			}
		}
		key = append(key, b)
	}
	var counter [8]byte
	binary.BigEndian.PutUint64(counter[:], uint64(step)) //nolint:gosec // a positive time step
	mac := hmac.New(sha1.New, key)
	_, _ = mac.Write(counter[:])
	sum := mac.Sum(nil)
	at := sum[19] & 15
	n := binary.BigEndian.Uint32(sum[at:at+4]) & 0x7fffffff
	return fmt.Sprintf("%06d", n%1_000_000), nil
}
