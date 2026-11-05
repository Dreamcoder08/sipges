package http

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

// formFixture is testdata/form.json: synthetic upload bodies and what Hono's parseBody({all:
// true}) read from them on Node (testdata/generate-form.mjs).
type formFixture struct {
	Node  string `json:"node"`
	Cases []struct {
		Name        string  `json:"name"`
		ContentType *string `json:"content_type"`
		Body        string  `json:"body"`
		Result      struct {
			OK      bool                       `json:"ok"`
			Entries map[string][]recordedEntry `json:"entries"`
		} `json:"result"`
	} `json:"cases"`
}

type recordedEntry struct {
	Text *string `json:"text,omitempty"`
	File *string `json:"file,omitempty"`
	Data *string `json:"data,omitempty"`
}

func TestParseFormReadsBodiesLikeHonoOnNode(t *testing.T) {
	raw, err := os.ReadFile("testdata/form.json")
	if err != nil {
		t.Fatal(err)
	}
	var f formFixture
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	if len(f.Cases) < 70 {
		t.Fatalf("only %d recorded cases", len(f.Cases))
	}
	for _, c := range f.Cases {
		body, err := base64.StdEncoding.DecodeString(c.Body)
		if err != nil {
			t.Fatal(err)
		}
		contentType := ""
		if c.ContentType != nil {
			b, err := base64.StdEncoding.DecodeString(*c.ContentType)
			if err != nil {
				t.Fatal(err)
			}
			contentType = string(b)
		}
		entries, ok := parseForm(contentType, c.ContentType != nil, body)
		if ok != c.Result.OK {
			t.Errorf("%s: ok = %v, Hono %v", c.Name, ok, c.Result.OK)
			continue
		}
		if !ok {
			continue
		}
		got := map[string][]recordedEntry{}
		for _, e := range entries {
			e := e
			if e.file {
				data := base64.StdEncoding.EncodeToString(e.data)
				got[e.name] = append(got[e.name], recordedEntry{File: &e.text, Data: &data})
			} else {
				got[e.name] = append(got[e.name], recordedEntry{Text: &e.text})
			}
		}
		if c.Result.Entries == nil {
			c.Result.Entries = map[string][]recordedEntry{}
		}
		if !reflect.DeepEqual(got, c.Result.Entries) {
			g, _ := json.Marshal(got)
			w, _ := json.Marshal(c.Result.Entries)
			t.Errorf("%s:\ngot  %s\nwant %s", c.Name, g, w)
		}
	}
}
