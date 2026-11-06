package httpx

import (
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestExtendWriteDeadlineOutlivesTheServerWriteTimeout(t *testing.T) {
	cases := []struct {
		name     string
		extend   bool
		wantBody string
		wantErr  bool
	}{
		{name: "extended", extend: true, wantBody: "ok"},
		{name: "not extended", wantErr: true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			handler := func(w http.ResponseWriter, _ *http.Request) {
				if c.extend {
					ExtendWriteDeadline(w, time.Minute)
				}
				time.Sleep(300 * time.Millisecond)
				_, _ = w.Write([]byte("ok"))
			}
			server := httptest.NewUnstartedServer(http.HandlerFunc(handler))
			server.Config.WriteTimeout = 100 * time.Millisecond
			server.Start()
			defer server.Close()
			res, err := http.Get(server.URL)
			if c.wantErr {
				if err == nil {
					_ = res.Body.Close()
					t.Fatal("the server's WriteTimeout must cut this one")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = res.Body.Close() }()
			body, _ := io.ReadAll(res.Body)
			if string(body) != c.wantBody {
				t.Fatalf("body=%q", body)
			}
		})
	}
}
