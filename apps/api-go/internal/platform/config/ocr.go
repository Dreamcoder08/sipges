package config

import (
	"errors"
	"regexp"
	"strings"
)

const defaultOCRLanguages = "spa+eng"

var ocrLanguages = regexp.MustCompile(`^[a-z_]{3,16}(\+[a-z_]{3,16}){0,5}$`)

// OCR is parseOcr of apps/api/src/platform/config.ts.
type OCR struct {
	// Enabled says SIPGES_OCR=ocrmypdf asked for OCR; it still needs the binary (doctext.NewOCR).
	Enabled bool
	// Languages is SIPGES_OCR_LANGUAGES, Tesseract codes joined by +.
	Languages string
}

// LoadOCR validates the OCR settings; a malformed value stops the start, as in apps/api.
func LoadOCR(lookup Lookup) (OCR, error) {
	raw, _ := lookup("SIPGES_OCR")
	engine := strings.TrimSpace(raw)
	if engine == "" {
		return OCR{}, nil
	}
	if engine != "ocrmypdf" {
		return OCR{}, errors.New(`SIPGES_OCR must be "ocrmypdf" or unset`)
	}
	raw, _ = lookup("SIPGES_OCR_LANGUAGES")
	languages := strings.TrimSpace(raw)
	if languages == "" {
		languages = defaultOCRLanguages
	}
	if !ocrLanguages.MatchString(languages) {
		return OCR{}, errors.New("SIPGES_OCR_LANGUAGES must be Tesseract codes joined by +, e.g. spa+eng")
	}
	return OCR{Enabled: true, Languages: languages}, nil
}
