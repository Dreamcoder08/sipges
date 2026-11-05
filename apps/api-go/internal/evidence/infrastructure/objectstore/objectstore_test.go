package objectstore

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Every credential, bucket and endpoint here is synthetic; no request leaves the process.

func TestSignMatchesTheAWSDocumentationExample(t *testing.T) {
	got := sign(signInput{
		Method: "GET", Path: "/test.txt", Host: "examplebucket.s3.amazonaws.com", Region: "us-east-1",
		Headers: map[string]string{
			"range":                "bytes=0-9",
			"x-amz-content-sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
			"x-amz-date":           "20130524T000000Z",
		},
		PayloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		At:          time.Date(2013, 5, 24, 0, 0, 0, 0, time.UTC),
		Credentials: Credentials{AccessKeyID: "AKIAIOSFODNN7EXAMPLE", SecretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"},
	})
	want := "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
		"SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, " +
		"Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
	if got != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
}

type call struct {
	method, url, host string
	header            http.Header
	body              []byte
}

// fakeS3 answers in memory, like the fake fetch of apps/api/test/evidence/object-storage.test.ts.
type fakeS3 struct {
	calls   []call
	objects map[string][]byte
	status  int // forced status, 0 for the in-memory behaviour
}

func (f *fakeS3) RoundTrip(r *http.Request) (*http.Response, error) {
	var body []byte
	if r.Body != nil {
		body, _ = io.ReadAll(r.Body)
	}
	f.calls = append(f.calls, call{method: r.Method, url: r.URL.String(), host: r.Host, header: r.Header.Clone(), body: body})
	respond := func(status int, b []byte) (*http.Response, error) {
		return &http.Response{StatusCode: status, Body: io.NopCloser(bytes.NewReader(b)), Header: http.Header{}, Request: r}, nil
	}
	if f.status != 0 {
		return respond(f.status, []byte("AccessDenied"))
	}
	key := r.URL.String()
	switch r.Method {
	case http.MethodPut:
		f.objects[key] = body
		return respond(200, nil)
	case http.MethodDelete:
		delete(f.objects, key)
		return respond(204, nil)
	}
	if b, ok := f.objects[key]; ok {
		return respond(200, b)
	}
	return respond(404, []byte("NoSuchKey"))
}

const key = "aaaaaaaaaaaaaaaaaaaaaaaa/0123456789abcdef0123456789abcdef_informe.pdf"

func newFake(t *testing.T, endpoint, bucket string) (*S3, *fakeS3) {
	t.Helper()
	fake := &fakeS3{objects: map[string][]byte{}}
	s, err := NewS3(S3Options{
		Endpoint: endpoint, Region: "auto", Bucket: bucket,
		Credentials: Credentials{AccessKeyID: "AKSYNTHETIC", SecretAccessKey: "synthetic-secret"},
		Client:      &http.Client{Transport: fake},
		Now:         func() time.Time { return time.Date(2026, 10, 13, 12, 34, 56, 789_000_000, time.UTC) },
	})
	if err != nil {
		t.Fatal(err)
	}
	return s, fake
}

// The signatures were recorded from createS3ObjectStorage of apps/api on the same synthetic
// inputs (endpoint with a default port, a path and a query; a bucket name needing escapes).
func TestS3SignsPathStyleRequestsLikeTheTypeScriptAdapter(t *testing.T) {
	s, fake := newFake(t, "https://ACCT.r2.cloudflarestorage.com:443/ignored?x=1", "sipges evidence!")
	ctx := context.Background()
	if err := s.Put(ctx, key, []byte("%PDF-"), "application/pdf"); err != nil {
		t.Fatal(err)
	}
	if data, found, err := s.Get(ctx, key); err != nil || !found || string(data) != "%PDF-" {
		t.Fatalf("get: %q %v %v", data, found, err)
	}
	if err := s.Delete(ctx, key); err != nil {
		t.Fatal(err)
	}
	if _, found, err := s.Get(ctx, key); err != nil || found {
		t.Fatalf("get after delete: %v %v", found, err)
	}
	if err := s.Delete(ctx, key); err != nil {
		t.Fatalf("deleting a missing object: %v", err)
	}
	const url = "https://acct.r2.cloudflarestorage.com/sipges%20evidence%21/" + key
	want := []struct{ method, ct, sha, auth string }{
		{"PUT", "application/pdf", "38523c087796e5d5dd1cf9bad1fb026781a838dd9dd2cf8af58b9f6502a46778",
			"AWS4-HMAC-SHA256 Credential=AKSYNTHETIC/20261013/auto/s3/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=df5d8f9587e182e89feac2a3893113c86720bb25826e3b0de7c10d1d70cdd3e0"},
		{"GET", "", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
			"AWS4-HMAC-SHA256 Credential=AKSYNTHETIC/20261013/auto/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=da176475059413d7832d7920c2b646853fd1804ba26eae6d45c717849d0e8df1"},
		{"DELETE", "", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
			"AWS4-HMAC-SHA256 Credential=AKSYNTHETIC/20261013/auto/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=edc863363a8b3d958d9b9a9a79aa976d58e6260f6f5791eb1ca2eca7f5ab6624"},
	}
	for i, w := range want {
		c := fake.calls[i]
		if c.method != w.method || c.url != url || c.host != "acct.r2.cloudflarestorage.com" ||
			c.header.Get("Content-Type") != w.ct || c.header.Get("X-Amz-Content-Sha256") != w.sha ||
			c.header.Get("X-Amz-Date") != "20261013T123456Z" || c.header.Get("Authorization") != w.auth {
			t.Errorf("call %d: %+v", i, c)
		}
		// Objects stay private: no ACL header is ever sent.
		if c.header.Get("X-Amz-Acl") != "" {
			t.Errorf("call %d sends an ACL", i)
		}
	}
}

func TestS3SurfacesErrorsInsteadOfPretendingSuccess(t *testing.T) {
	s, fake := newFake(t, "https://s3.example.org", "b")
	fake.status = 403
	ctx := context.Background()
	if err := s.Put(ctx, key, []byte("x"), "text/plain"); err == nil || !strings.Contains(err.Error(), "S3 PUT failed with 403") {
		t.Errorf("put: %v", err)
	}
	if _, _, err := s.Get(ctx, key); err == nil || !strings.Contains(err.Error(), "S3 GET failed with 403") {
		t.Errorf("get: %v", err)
	}
	if err := s.Delete(ctx, key); err == nil || !strings.Contains(err.Error(), "S3 DELETE failed with 403") {
		t.Errorf("delete: %v", err)
	}
}

func TestLocalStoresReadsAndDeletesWithoutTemporaryFiles(t *testing.T) {
	dir := t.TempDir()
	l, err := NewLocal(dir)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err := l.Put(ctx, key, []byte{1, 2, 3}, "application/pdf"); err != nil {
		t.Fatal(err)
	}
	if data, found, err := l.Get(ctx, key); err != nil || !found || !bytes.Equal(data, []byte{1, 2, 3}) {
		t.Fatalf("get: %v %v %v", data, found, err)
	}
	entries, _ := os.ReadDir(filepath.Join(dir, strings.Repeat("a", 24)))
	if len(entries) != 1 || entries[0].Name() != "0123456789abcdef0123456789abcdef_informe.pdf" {
		t.Errorf("entries %v", entries)
	}
	for range 2 {
		if err := l.Delete(ctx, key); err != nil {
			t.Fatal(err)
		}
	}
	if _, found, err := l.Get(ctx, key); err != nil || found {
		t.Errorf("after delete: %v %v", found, err)
	}
	for _, bad := range []string{"../escape.pdf", strings.Repeat("a", 24) + "/../../x", "/abs/path", strings.Repeat("a", 24) + "/a/b", strings.Repeat("A", 24) + "/x", strings.Repeat("a", 24) + "/..", ""} {
		if err := l.Put(ctx, bad, []byte{1}, "text/plain"); err == nil {
			t.Errorf("put %q accepted", bad)
		}
		if _, _, err := l.Get(ctx, bad); err == nil {
			t.Errorf("get %q accepted", bad)
		}
		if err := l.Delete(ctx, bad); err == nil {
			t.Errorf("delete %q accepted", bad)
		}
	}
}

func env(m map[string]string) Lookup {
	return func(k string) (string, bool) { v, ok := m[k]; return v, ok }
}

func TestFromEnvFollowsTheTypeScriptConfiguration(t *testing.T) {
	s3 := func(extra map[string]string) map[string]string {
		m := map[string]string{
			"SIPGES_STORAGE": "s3", "SIPGES_S3_ENDPOINT": "https://acct.r2.cloudflarestorage.com",
			"SIPGES_S3_BUCKET": "b", "SIPGES_S3_ACCESS_KEY_ID": "AK", "SIPGES_S3_SECRET_ACCESS_KEY": "SK",
		}
		for k, v := range extra {
			m[k] = v
		}
		return m
	}
	for _, c := range []struct {
		name string
		env  map[string]string
		err  string
	}{
		{"default local", map[string]string{}, ""},
		{"local dir", map[string]string{"SIPGES_STORAGE": "local", "SIPGES_UPLOAD_DIR": t.TempDir()}, ""},
		{"unknown kind", map[string]string{"SIPGES_STORAGE": "r2"}, "SIPGES_STORAGE must be 'local' or 's3'"},
		{"s3", s3(nil), ""},
		{"s3 on a local http server", s3(map[string]string{"SIPGES_S3_ENDPOINT": "http://127.0.0.1:9000"}), ""},
		{"s3 on [::1]", s3(map[string]string{"SIPGES_S3_ENDPOINT": "http://[::1]:9000"}), ""},
		{"s3 over plain http", s3(map[string]string{"SIPGES_S3_ENDPOINT": "http://r2.example.org"}), "SIPGES_S3_ENDPOINT must use https (http only for a local test server)"},
		{"s3 relative endpoint", s3(map[string]string{"SIPGES_S3_ENDPOINT": "r2.example.org"}), "SIPGES_S3_ENDPOINT must be an absolute URL"},
		{"s3 without endpoint", s3(map[string]string{"SIPGES_S3_ENDPOINT": ""}), "SIPGES_S3_ENDPOINT is required when SIPGES_STORAGE=s3"},
		{"s3 without bucket", s3(map[string]string{"SIPGES_S3_BUCKET": ""}), "SIPGES_S3_BUCKET is required when SIPGES_STORAGE=s3"},
		{"s3 without key id", s3(map[string]string{"SIPGES_S3_ACCESS_KEY_ID": ""}), "SIPGES_S3_ACCESS_KEY_ID is required when SIPGES_STORAGE=s3"},
		{"s3 without secret", s3(map[string]string{"SIPGES_S3_SECRET_ACCESS_KEY": ""}), "SIPGES_S3_SECRET_ACCESS_KEY is required when SIPGES_STORAGE=s3"},
	} {
		_, err := FromEnv(env(c.env))
		if got := ""; err != nil {
			got = err.Error()
			if got != c.err {
				t.Errorf("%s: %q, want %q", c.name, got, c.err)
			}
		} else if c.err != "" {
			t.Errorf("%s: accepted, want %q", c.name, c.err)
		}
		// The secret never shows in an error.
		if err != nil && strings.Contains(err.Error(), "SK") && !strings.Contains(err.Error(), "SIPGES_S3") {
			t.Errorf("%s: error mentions the secret", c.name)
		}
	}
	got, err := FromEnv(env(s3(map[string]string{"SIPGES_S3_REGION": "eu"})))
	if s, ok := got.(*S3); err != nil || !ok || s.opts.Region != "eu" || s.host != "acct.r2.cloudflarestorage.com" {
		t.Errorf("region: %+v %v", got, err)
	}
	if got, _ := FromEnv(env(s3(nil))); got.(*S3).opts.Region != "auto" {
		t.Error("default region is not auto")
	}
}

func TestMaxUploadBytes(t *testing.T) {
	for v, want := range map[string]int{"1": 1, "104857600": 104857600, "0010": 10} {
		if got, err := MaxUploadBytes(env(map[string]string{"SIPGES_MAX_UPLOAD_BYTES": v})); err != nil || got != want {
			t.Errorf("%q: %d %v", v, got, err)
		}
	}
	if got, err := MaxUploadBytes(env(nil)); err != nil || got != 10*1024*1024 {
		t.Errorf("default: %d %v", got, err)
	}
	for _, v := range []string{"", "0", "104857601", "-1", "1e3", " 1", "1.0", "99999999999999999999"} {
		if _, err := MaxUploadBytes(env(map[string]string{"SIPGES_MAX_UPLOAD_BYTES": v})); err == nil {
			t.Errorf("%q accepted", v)
		}
	}
}

func TestMemoryIsolatesCopies(t *testing.T) {
	m := NewMemory()
	ctx := context.Background()
	data := []byte("abc")
	_ = m.Put(ctx, key, data, "text/plain")
	data[0] = 'x'
	got, found, _ := m.Get(ctx, key)
	if !found || string(got) != "abc" || m.ContentType(key) != "text/plain" || len(m.Keys()) != 1 {
		t.Errorf("%q %v", got, found)
	}
	_ = m.Delete(ctx, key)
	if _, found, _ := m.Get(ctx, key); found {
		t.Error("still found")
	}
}
