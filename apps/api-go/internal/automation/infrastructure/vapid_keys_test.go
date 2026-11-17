package infrastructure

import (
	"testing"
)

func TestGeneratedVapidKeysAreAPairTheServerAccepts(t *testing.T) {
	t.Parallel()
	public, private, err := GenerateVapidKeys()
	if err != nil {
		t.Fatal(err)
	}
	env := map[string]string{
		"SIPGES_VAPID_PUBLIC_KEY": public, "SIPGES_VAPID_PRIVATE_KEY": private, "SIPGES_VAPID_SUBJECT": "mailto:sipges@localhost",
	}
	keys, err := LoadVapid(func(name string) (string, bool) { v, ok := env[name]; return v, ok })
	if err != nil || keys == nil {
		t.Fatalf("LoadVapid: %v", err)
	}
	if _, err := NewWebPushSender(keys, nil); err != nil {
		t.Fatalf("the sender refuses the pair: %v", err)
	}
	other, _, _ := GenerateVapidKeys()
	if other == public {
		t.Fatal("two calls gave the same key")
	}
}
