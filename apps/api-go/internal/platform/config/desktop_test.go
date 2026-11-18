package config

import (
	"path/filepath"
	"testing"
)

// Twin of 'accepts only an absolute channel folder' (apps/api/test/desktop/desktop-update.test.ts).
func TestDesktopUpdateDirAcceptsOnlyAnAbsoluteFolder(t *testing.T) {
	abs, err := filepath.Abs("channel")
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name    string
		env     map[string]string
		want    string
		wantErr string
	}{
		{name: "unset", env: nil},
		{name: "absolute", env: map[string]string{"SIPGES_DESKTOP_UPDATE_DIR": abs}, want: abs},
		{name: "relative", env: map[string]string{"SIPGES_DESKTOP_UPDATE_DIR": "relative/dir"}, wantErr: "SIPGES_DESKTOP_UPDATE_DIR must be an absolute path"},
		{name: "empty", env: map[string]string{"SIPGES_DESKTOP_UPDATE_DIR": ""}, wantErr: "SIPGES_DESKTOP_UPDATE_DIR must be an absolute path"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := DesktopUpdateDir(func(k string) (string, bool) { v, ok := c.env[k]; return v, ok })
			if c.wantErr != "" {
				if err == nil || err.Error() != c.wantErr {
					t.Fatalf("err=%v", err)
				}
				return
			}
			if err != nil || got != c.want {
				t.Fatalf("got=%q err=%v", got, err)
			}
		})
	}
}

func TestNodeIsAbsolute(t *testing.T) {
	for _, c := range []struct {
		path    string
		windows bool
		want    bool
	}{
		{"/srv/channel", false, true},
		{`C:\channel`, false, false},
		{`C:\channel`, true, true},
		{"c:/channel", true, true},
		{`\channel`, true, true},
		{"/channel", true, true},
		{"C:channel", true, false},
		{"channel", true, false},
		{"", true, false},
	} {
		if got := nodeIsAbsolute(c.path, c.windows); got != c.want {
			t.Errorf("nodeIsAbsolute(%q, windows=%v) = %v", c.path, c.windows, got)
		}
	}
}
