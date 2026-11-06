package config

import "testing"

func TestLoadOCR(t *testing.T) {
	cases := []struct {
		name      string
		env       map[string]string
		enabled   bool
		languages string
		wantErr   string
	}{
		{name: "unset", env: nil},
		{name: "blank", env: map[string]string{"SIPGES_OCR": "  "}},
		{name: "default languages", env: map[string]string{"SIPGES_OCR": " ocrmypdf "}, enabled: true, languages: "spa+eng"},
		{name: "blank languages", env: map[string]string{"SIPGES_OCR": "ocrmypdf", "SIPGES_OCR_LANGUAGES": " "}, enabled: true, languages: "spa+eng"},
		{name: "chosen languages", env: map[string]string{"SIPGES_OCR": "ocrmypdf", "SIPGES_OCR_LANGUAGES": "spa"}, enabled: true, languages: "spa"},
		{name: "unknown engine", env: map[string]string{"SIPGES_OCR": "tesseract"}, wantErr: `SIPGES_OCR must be "ocrmypdf" or unset`},
		{
			name:    "a language that could be an option",
			env:     map[string]string{"SIPGES_OCR": "ocrmypdf", "SIPGES_OCR_LANGUAGES": "--output"},
			wantErr: "SIPGES_OCR_LANGUAGES must be Tesseract codes joined by +, e.g. spa+eng",
		},
		{
			name:    "seven languages",
			env:     map[string]string{"SIPGES_OCR": "ocrmypdf", "SIPGES_OCR_LANGUAGES": "aaa+bbb+ccc+ddd+eee+fff+ggg"},
			wantErr: "SIPGES_OCR_LANGUAGES must be Tesseract codes joined by +, e.g. spa+eng",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := LoadOCR(func(k string) (string, bool) { v, ok := c.env[k]; return v, ok })
			if c.wantErr != "" {
				if err == nil || err.Error() != c.wantErr {
					t.Fatalf("err=%v", err)
				}
				return
			}
			if err != nil || got.Enabled != c.enabled || got.Languages != c.languages {
				t.Fatalf("got=%+v err=%v", got, err)
			}
		})
	}
}
