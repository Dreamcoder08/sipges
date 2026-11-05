package secrets

import (
	"bytes"
	"testing"
)

// Sealed by createSecretCipher of the TypeScript API with synthetic keys (bytes 7 and 9).
const (
	currentKey  = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc="
	previousKey = "CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk="
	sealedByTS  = "v1.WY1bGo1ur2O8BPfZZYkmRdMgFw8265ojPngMJFC_gQp7y2y1gu4g4QeXxSTMskgs8Ixv-iAqdV5FXSdw_dZFhttDTyXhKCESzFSvkU87wgtkgMK67lUHtp_yR8BlLQM"
	sealedOld   = "v1.W_SUdKbuC0axl9ZJnO_xkazHAsC06aNH09Q4Wwytya5lYx6fz_Vj"
)

func env(values map[string]string) Lookup {
	return func(k string) (string, bool) { v, ok := values[k]; return v, ok }
}

func TestCipherOpensWhatTheTypeScriptAPISealedWithEitherKey(t *testing.T) {
	key, prev, ok, err := DataKeys(env(map[string]string{"SIPGES_DATA_KEY": currentKey, "SIPGES_DATA_KEY_PREVIOUS": previousKey}))
	if err != nil || !ok {
		t.Fatal(ok, err)
	}
	c, err := NewCipher(key, prev)
	if err != nil {
		t.Fatal(err)
	}
	if got, err := c.Open(sealedByTS); err != nil || got != `{"kind":"slack","url":"https://hooks.slack.com/services/sintetico"}` {
		t.Fatalf("got %q, %v", got, err)
	}
	if got, err := c.Open(sealedOld); err != nil || got != "anterior ñ" {
		t.Fatalf("got %q, %v", got, err)
	}
	sealed, err := c.Seal("nuevo")
	if err != nil {
		t.Fatal(err)
	}
	onlyOld, _ := NewCipher(prev)
	if _, err := onlyOld.Open(sealed); err == nil {
		t.Fatal("a value sealed with the current key opened with the previous one")
	}
	if got, _ := c.Open(sealed); got != "nuevo" {
		t.Fatalf("round trip got %q", got)
	}
	for _, bad := range []string{"", "v2.abc", "v1.", "v1.AAAA", "v1.!!!!"} {
		if _, err := c.Open(bad); err == nil {
			t.Errorf("Open(%q) succeeded", bad)
		}
	}
}

func TestDataKeysFollowsTheTypeScriptConfig(t *testing.T) {
	if _, _, ok, err := DataKeys(env(nil)); ok || err != nil {
		t.Fatal("unset key must be unconfigured, not an error")
	}
	for _, bad := range []string{"", "short", "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH", "Bw-HBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc="} {
		if _, _, _, err := DataKeys(env(map[string]string{"SIPGES_DATA_KEY": bad})); err == nil {
			t.Errorf("accepted %q", bad)
		}
	}
	key, _, _, err := DataKeys(env(map[string]string{"SIPGES_DATA_KEY": "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc"}))
	if err != nil || !bytes.Equal(key, bytes.Repeat([]byte{7}, 32)) {
		t.Fatal("unpadded base64 must decode as Buffer.from does", err)
	}
}
