package domain

import (
	"bytes"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"golang.org/x/text/cases"
	"golang.org/x/text/language"
	"golang.org/x/text/unicode/norm"
)

// The upload rules of upload-policy.ts (app.py:1063-1127, corrected per docs/adr/0008 #9): the
// extension allowlist and name sanitizing keep parity; the content must also match the
// extension's file signature, so a renamed executable or HTML page is refused. Both APIs answer
// the same, pinned by testdata/upload-policy.json.

var (
	zipMagic  = []byte{0x50, 0x4b, 0x03, 0x04}
	oleMagic  = []byte{0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1}
	jpegMagic = []byte{0xff, 0xd8, 0xff}
	pngMagic  = []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a}
)

type signature struct {
	extension   string
	contentType string
	matches     func([]byte) bool
}

func prefix(p []byte) func([]byte) bool { return func(b []byte) bool { return bytes.HasPrefix(b, p) } }

// signatures is SIGNATURES, in its key order (ALLOWED_EXTENSIONS).
var signatures = []signature{
	{".pdf", "application/pdf", prefix([]byte("%PDF-"))},
	{".doc", "application/msword", prefix(oleMagic)},
	{".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", prefix(zipMagic)},
	{".xls", "application/vnd.ms-excel", prefix(oleMagic)},
	{".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", prefix(zipMagic)},
	{".csv", "text/csv", isText},
	{".txt", "text/plain", isText},
	{".jpg", "image/jpeg", prefix(jpegMagic)},
	{".jpeg", "image/jpeg", prefix(jpegMagic)},
	{".png", "image/png", prefix(pngMagic)},
	{".webp", "image/webp", func(b []byte) bool {
		return bytes.HasPrefix(b, []byte("RIFF")) && len(b) >= 12 && string(b[8:12]) == "WEBP"
	}},
}

// isText is plain text: valid UTF-8 (a BOM allowed) without NUL or other binary control bytes
// (U+0000-U+0008, U+000B, U+000E-U+001F, U+007F). Go's UTF-8 check refuses overlong forms and
// surrogates as TextDecoder's fatal mode does.
func isText(b []byte) bool {
	if !utf8.Valid(b) {
		return false
	}
	for _, c := range b {
		if c <= 0x08 || c == 0x0b || (c >= 0x0e && c <= 0x1f) || c == 0x7f {
			return false
		}
	}
	return true
}

// AllowedExtensions is ALLOWED_EXTENSIONS.
func AllowedExtensions() []string {
	out := make([]string, len(signatures))
	for i, s := range signatures {
		out[i] = s.extension
	}
	return out
}

func signatureOf(extension string) (signature, bool) {
	for _, s := range signatures {
		if s.extension == extension {
			return s, true
		}
	}
	return signature{}, false
}

var lower = cases.Lower(language.Und)

// ExtensionOf is extensionOf: the suffix from the last dot, lower-cased like JavaScript's
// toLowerCase, as Python's Path(name).suffix (a leading dot is not a suffix).
func ExtensionOf(name string) string {
	dot := strings.LastIndexByte(name, '.')
	if dot <= 0 {
		return ""
	}
	return lower.String(name[dot:])
}

const maxStem = 80

// SafeUploadName is safeUploadName (app.py _safe_upload_name): the base name only, its stem
// NFKD-folded to ASCII and limited to [A-Za-z0-9._-] (80 characters, trimmed of separators,
// `archivo` when empty), plus the lower-cased extension.
func SafeUploadName(raw string) string {
	if raw == "" {
		raw = "archivo"
	}
	base := raw[strings.LastIndexAny(raw, `\/`)+1:]
	if base == "" {
		base = "archivo"
	}
	ext := ExtensionOf(base)
	// base.slice(0, base.length - ext.length), in UTF-16 units: lower-casing can change the
	// extension's length. A cut inside a pair leaves a lone surrogate, which the ASCII fold
	// below drops either way.
	units := utf16.Encode([]rune(base))
	end := len(units) - len(utf16.Encode([]rune(ext)))
	if end < 0 {
		end = max(0, len(units)+end)
	}
	stem := string(utf16.Decode(units[:end]))
	var folded strings.Builder
	separator := false
	for _, r := range norm.NFKD.String(stem) {
		if r > 0x7f {
			continue // \P{ASCII} removed
		}
		if r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '.' || r == '_' || r == '-' {
			folded.WriteRune(r)
			separator = false
			continue
		}
		if !separator {
			folded.WriteByte('-')
			separator = true
		}
	}
	out := strings.Trim(folded.String(), "-._")
	if len(out) > maxStem {
		out = out[:maxStem]
	}
	if out == "" {
		out = "archivo"
	}
	return out + ext
}

// Rejection is the kind of an UploadRejection; empty when the upload is accepted.
type Rejection string

// The upload rejections of upload-policy.ts.
const (
	RejectExtension       Rejection = "extension"
	RejectEmpty           Rejection = "empty"
	RejectTooLarge        Rejection = "too_large"
	RejectContentMismatch Rejection = "content_mismatch"
)

// AcceptedUpload is the stored name and the content type detected from the bytes.
type AcceptedUpload struct {
	SafeName    string
	ContentType string
}

// CheckUpload is checkUpload: name, size and signature, in that order; the detected type
// ignores the client's claim.
func CheckUpload(originalName string, content []byte, maxBytes int) (AcceptedUpload, Rejection) {
	safeName := SafeUploadName(originalName)
	sig, ok := signatureOf(ExtensionOf(safeName))
	switch {
	case !ok:
		return AcceptedUpload{}, RejectExtension
	case len(content) == 0:
		return AcceptedUpload{}, RejectEmpty
	case len(content) > maxBytes:
		return AcceptedUpload{}, RejectTooLarge
	case !sig.matches(content):
		return AcceptedUpload{}, RejectContentMismatch
	}
	return AcceptedUpload{SafeName: safeName, ContentType: sig.contentType}, ""
}

// Text limits and defaults applied to metadata, like the app.py slices (METADATA_LIMITS).
const (
	MaxDocumentType     = 120
	MaxAuthor           = 160
	MaxVerification     = 80
	MaxNotes            = 1000
	DefaultDocumentType = "Reporte / evidencia"
	DefaultVerification = "E - No verificada"
)
