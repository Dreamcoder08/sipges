// Package domain holds the evidence rules of apps/api/src/contexts/evidence/domain: the metadata
// of a stored file and the upload policy. File bytes live in object storage, which the Go API
// does not reach yet; only metadata reads are ported.
package domain

import (
	"strings"
	"time"
)

// Attachment is the metadata of one evidence file linked to a territorial record of a tenant
// (attachment.ts). The storage key stays internal and never reaches a response.
type Attachment struct {
	ID           string
	StorageKey   string
	OriginalName string
	ContentType  string
	SizeBytes    int64
	SHA256       string
	// LinkedModule is the URL slug of the linked module, e.g. `eventos`.
	LinkedModule   string
	LinkedRecordID string
	DocumentType   string
	Author         string
	Verification   string
	Notes          string
	ProjectID      string
	ProjectName    string
	CreatedAt      time.Time
}

// DownloadURL is `/system/uploads/${encodeURIComponent(id)}/download`.
func DownloadURL(id string) string {
	return "/system/uploads/" + encodeURIComponent(id) + "/download"
}

// encodeURIComponent escapes every byte of the UTF-8 encoding except A-Z a-z 0-9 - _ . ! ~ * ' ( ).
func encodeURIComponent(s string) string {
	const hex = "0123456789ABCDEF"
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if 'A' <= c && c <= 'Z' || 'a' <= c && c <= 'z' || '0' <= c && c <= '9' || strings.IndexByte("-_.!~*'()", c) >= 0 {
			b.WriteByte(c)
			continue
		}
		b.WriteByte('%')
		b.WriteByte(hex[c>>4])
		b.WriteByte(hex[c&0x0f])
	}
	return b.String()
}
