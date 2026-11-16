package infrastructure

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// pki is a synthetic root → intermediate → leaf chain, the shape GEOCATMIN serves.
type pki struct {
	root, intermediate *x509.Certificate
	leafDER            []byte
	leafKey            *ecdsa.PrivateKey
}

func newPKI(t *testing.T, leafDNS ...string) pki {
	t.Helper()
	return newPKIWith(t, nil, leafDNS...)
}

// newPKIWith lets a test change the leaf before it is signed (validity, key usage).
func newPKIWith(t *testing.T, leaf func(*x509.Certificate), leafDNS ...string) pki {
	t.Helper()
	now := time.Now()
	issue := func(tmpl, parent *x509.Certificate, pub, signer any) *x509.Certificate {
		der, err := x509.CreateCertificate(rand.Reader, tmpl, parent, pub, signer)
		if err != nil {
			t.Fatal(err)
		}
		c, err := x509.ParseCertificate(der)
		if err != nil {
			t.Fatal(err)
		}
		return c
	}
	key := func() *ecdsa.PrivateKey {
		k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		return k
	}
	ca := func(serial int64, cn string) *x509.Certificate {
		return &x509.Certificate{
			SerialNumber: big.NewInt(serial), Subject: pkix.Name{CommonName: cn},
			NotBefore: now.Add(-time.Hour), NotAfter: now.Add(time.Hour),
			IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign,
		}
	}
	rootKey, interKey, leafKey := key(), key(), key()
	root := issue(ca(1, "Synthetic Root"), ca(1, "Synthetic Root"), &rootKey.PublicKey, rootKey)
	inter := issue(ca(2, "Synthetic Intermediate"), root, &interKey.PublicKey, rootKey)
	leafTmpl := &x509.Certificate{
		SerialNumber: big.NewInt(3), Subject: pkix.Name{CommonName: "synthetic leaf"},
		NotBefore: now.Add(-time.Hour), NotAfter: now.Add(time.Hour),
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames: leafDNS,
	}
	if leaf != nil {
		leaf(leafTmpl)
	}
	signed := issue(leafTmpl, inter, &leafKey.PublicKey, interKey)
	return pki{root: root, intermediate: inter, leafDER: signed.Raw, leafKey: leafKey}
}

// leafOnlyServer answers 200 over TLS and, like GEOCATMIN, sends the leaf without its intermediate.
func leafOnlyServer(t *testing.T, p pki) *httptest.Server {
	t.Helper()
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("{}"))
	}))
	srv.TLS = &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{p.leafDER}, PrivateKey: p.leafKey}}}
	srv.StartTLS()
	t.Cleanup(srv.Close)
	return srv
}

// testHost is the name the client asks for; every connection is dialled to the test server, so
// the handshake carries a real SNI name, as it does for geocatmin.ingemmet.gob.pe.
const testHost = "geocatmin.test"

func get(t *testing.T, srv *httptest.Server, cfg *tls.Config) error {
	t.Helper()
	_, err := getState(t, srv, cfg)
	return err
}

// getState makes one request, reads the whole body (so a TLS 1.3 session ticket is stored) and
// returns the connection state.
func getState(t *testing.T, srv *httptest.Server, cfg *tls.Config) (*tls.ConnectionState, error) {
	t.Helper()
	addr := srv.Listener.Addr().String()
	tr := &http.Transport{TLSClientConfig: cfg, DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, addr)
	}}
	defer tr.CloseIdleConnections()
	resp, err := (&http.Client{Transport: tr, Timeout: 5 * time.Second}).Get("https://" + testHost + "/")
	if err != nil {
		return nil, err
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()
	return resp.TLS, nil
}

func pool(certs ...*x509.Certificate) *x509.CertPool {
	p := x509.NewCertPool()
	for _, c := range certs {
		p.AddCert(c)
	}
	return p
}

func TestStandardVerificationFailsWhenTheServerOmitsItsIntermediate(t *testing.T) {
	p := newPKI(t, testHost)
	srv := leafOnlyServer(t, p)
	err := get(t, srv, &tls.Config{RootCAs: pool(p.root), MinVersion: tls.VersionTLS12})
	if err == nil || !strings.Contains(err.Error(), "unknown authority") {
		t.Fatalf("want an unknown-authority failure, got %v", err)
	}
}

func TestChainVerifierCompletesAKnownMissingIntermediate(t *testing.T) {
	p := newPKI(t, testHost)
	srv := leafOnlyServer(t, p)
	if err := get(t, srv, chainVerifyingTLS(pool(p.root), pool(p.intermediate))); err != nil {
		t.Fatalf("want success with the intermediate supplied, got %v", err)
	}
}

func TestChainVerifierNeverTrustsTheSuppliedIntermediateAsARoot(t *testing.T) {
	p := newPKI(t, testHost)
	srv := leafOnlyServer(t, p)
	// The root is missing from the trust store: the intermediate alone must not be enough.
	if err := get(t, srv, chainVerifyingTLS(x509.NewCertPool(), pool(p.intermediate))); err == nil {
		t.Fatal("a chain ending at the supplied intermediate was accepted")
	}
}

func TestChainVerifierRejectsAChainFromAnotherRoot(t *testing.T) {
	served := newPKI(t, testHost)
	trusted := newPKI(t, testHost)
	srv := leafOnlyServer(t, served)
	if err := get(t, srv, chainVerifyingTLS(pool(trusted.root), pool(served.intermediate, trusted.intermediate))); err == nil {
		t.Fatal("a leaf from an untrusted root was accepted")
	}
}

func TestChainVerifierRejectsTheWrongHost(t *testing.T) {
	p := newPKI(t, "other.example")
	srv := leafOnlyServer(t, p)
	err := get(t, srv, chainVerifyingTLS(pool(p.root), pool(p.intermediate)))
	if err == nil || !strings.Contains(err.Error(), testHost) {
		t.Fatalf("want a host name mismatch for %s, got %v", testHost, err)
	}
}

func TestChainVerifierRefusesAnEmptyServerName(t *testing.T) {
	p := newPKI(t, testHost)
	cfg := chainVerifyingTLS(pool(p.root), pool(p.intermediate))
	leaf, err := x509.ParseCertificate(p.leafDER)
	if err != nil {
		t.Fatal(err)
	}
	if err := cfg.VerifyConnection(tls.ConnectionState{PeerCertificates: []*x509.Certificate{leaf}}); err == nil {
		t.Fatal("verification without a server name skipped the hostname check")
	}
	if err := cfg.VerifyConnection(tls.ConnectionState{ServerName: testHost}); err == nil {
		t.Fatal("a handshake without certificates was accepted")
	}
}

func TestChainVerifierRejectsAnExpiredLeaf(t *testing.T) {
	p := newPKIWith(t, func(c *x509.Certificate) {
		c.NotBefore, c.NotAfter = time.Now().Add(-2*time.Hour), time.Now().Add(-time.Minute)
	}, testHost)
	err := get(t, leafOnlyServer(t, p), chainVerifyingTLS(pool(p.root), pool(p.intermediate)))
	if err == nil || !strings.Contains(err.Error(), "expired") {
		t.Fatalf("want an expired-certificate failure, got %v", err)
	}
}

func TestChainVerifierRejectsALeafNotIssuedForServers(t *testing.T) {
	p := newPKIWith(t, func(c *x509.Certificate) {
		c.ExtKeyUsage = []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}
	}, testHost)
	if err := get(t, leafOnlyServer(t, p), chainVerifyingTLS(pool(p.root), pool(p.intermediate))); err == nil {
		t.Fatal("a client-auth-only leaf was accepted for a server")
	}
}

func TestChainVerifierReverifiesResumedSessions(t *testing.T) {
	for _, version := range []uint16{tls.VersionTLS12, tls.VersionTLS13} {
		p := newPKI(t, testHost)
		srv := leafOnlyServer(t, p)
		srv.TLS.MaxVersion = version
		cache := tls.NewLRUClientSessionCache(4)
		withCache := func(cfg *tls.Config) *tls.Config { cfg.ClientSessionCache = cache; return cfg }
		trusting := func() *tls.Config { return withCache(chainVerifyingTLS(pool(p.root), pool(p.intermediate))) }

		if _, err := getState(t, srv, trusting()); err != nil {
			t.Fatalf("version %x: first connection: %v", version, err)
		}
		st, err := getState(t, srv, trusting())
		if err != nil || !st.DidResume {
			t.Fatalf("version %x: the second connection did not resume (state %+v, err %v)", version, st, err)
		}
		// Same cached session, but the root is no longer trusted: resumption must not bypass it.
		untrusting := withCache(chainVerifyingTLS(x509.NewCertPool(), pool(p.intermediate)))
		if _, err := getState(t, srv, untrusting); err == nil {
			t.Fatalf("version %x: a resumed session skipped chain verification", version)
		}
	}
}

func TestTheEmbeddedIntermediateIsSectigoOVR36(t *testing.T) {
	certs := embeddedIntermediates(t)
	if len(certs) != 1 {
		t.Fatalf("want one embedded intermediate, got %d", len(certs))
	}
	c := certs[0]
	if c.Subject.CommonName != "Sectigo Public Server Authentication CA OV R36" ||
		c.Issuer.CommonName != "Sectigo Public Server Authentication Root R46" || !c.IsCA {
		t.Fatalf("unexpected intermediate: subject %q issuer %q CA %v", c.Subject, c.Issuer, c.IsCA)
	}
	sum := sha256.Sum256(c.Raw)
	if got := hex.EncodeToString(sum[:]); got != "6542d176bed50f193c0ce297ae44ecd8a0a86bec2ede682769344059b4e78530" {
		t.Fatalf("embedded intermediate SHA-256 %s, want the Sectigo OV R36 certificate cited in tlschain.go", got)
	}
	// Fails after 2036-03-21 on purpose: replace the intermediate before it expires.
	if time.Now().After(c.NotAfter) {
		t.Fatalf("the embedded intermediate expired on %s", c.NotAfter)
	}
}

func TestTheProductionGatewayVerifiesThroughTheChainVerifier(t *testing.T) {
	g := NewGateway(nil)
	tr, ok := g.client.Transport.(*http.Transport)
	if !ok || tr.TLSClientConfig == nil || tr.TLSClientConfig.VerifyConnection == nil {
		t.Fatalf("the gateway does not use the chain verifier: %#v", g.client.Transport)
	}
	if tr.TLSClientConfig.RootCAs != nil {
		t.Fatal("the gateway must trust the system roots, not a custom pool")
	}
}

func embeddedIntermediates(t *testing.T) []*x509.Certificate {
	t.Helper()
	var out []*x509.Certificate
	rest := ingemmetIntermediatesPEM
	for {
		var block []byte
		block, rest = nextPEM(rest)
		if block == nil {
			return out
		}
		c, err := x509.ParseCertificate(block)
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, c)
	}
}
