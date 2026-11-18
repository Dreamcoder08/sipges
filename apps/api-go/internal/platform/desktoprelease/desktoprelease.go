// Package desktoprelease verifies signed desktop releases the way the Node updater does
// (deploy/desktop/updater/release.mjs and the verification half of updater.mjs), so a Go
// launcher accepts and refuses exactly the releases Node accepts and refuses.
//
// A release is a folder with `package/` (the builder output), `release.json` (version, minimum
// previous version, platform, SHA-256 of every file, internal folder links) and `release.sig`
// (base64 Ed25519 signature of the exact `release.json` bytes). The signature is checked over the
// raw bytes before the manifest is parsed. Refusals carry the Node updater's messages, so logs and
// update notices read the same whichever runtime wrote them. Nothing here writes to disk.
package desktoprelease

import (
	"errors"
	"fmt"
)

// File names inside a release folder and its package, as release.mjs defines them.
const (
	ManifestName  = "release.json"
	SignatureName = "release.sig"
	PublicKeyName = "update-public-key.pem"
	// PointerName is the install root's pointer to the current version (updater.mjs POINTER).
	PointerName = "current.json"
	// PackageDir is the package folder inside a release folder.
	PackageDir = "package"
)

// MaxManifestBytes is the largest release.json accepted.
const MaxManifestBytes = 64 * 1024 * 1024

// MaxNotesLength is the longest release notes text, in UTF-16 code units as JavaScript counts.
const MaxNotesLength = 4000

// requiredFiles must be listed in every manifest.
var requiredFiles = []string{"metadata.json", "start.mjs", PublicKeyName}

// Code is the Node updater's UpdateError code.
type Code string

// The codes this package returns.
const (
	// CodeRefused: the release (or the install's key) must not be used; nothing was changed.
	CodeRefused Code = "REFUSED"
	// CodeCorrupt: the install itself is not in a usable state.
	CodeCorrupt Code = "CORRUPT"
)

// Kind tells refusals apart without parsing their message.
type Kind string

// The kinds of Error.
const (
	KindKey                Kind = "key"                 // the trusted key is not a valid Ed25519 public key
	KindUpdatesDisabled    Kind = "updates-disabled"    // the installed version has no update key
	KindNoManifest         Kind = "no-manifest"         // release.json missing, not a file or too large
	KindNoSignature        Kind = "no-signature"        // release.sig missing or unreadable
	KindSignatureMalformed Kind = "signature-malformed" // release.sig is not canonical base64 of 64 bytes
	KindSignatureMismatch  Kind = "signature-mismatch"  // release.sig does not verify with the trusted key
	KindManifestInvalid    Kind = "manifest-invalid"    // the signed manifest breaks a release.mjs rule
	KindNotNewer           Kind = "not-newer"           // the release is not newer than the installed version
	KindMinimumPrevious    Kind = "minimum-previous"    // the installed version is below the release's minimum
	KindPlatform           Kind = "platform"            // the release is for another platform or architecture
	KindPackageMissing     Kind = "package-missing"     // no package folder, or it is not a real folder
	KindPackageMismatch    Kind = "package-mismatch"    // the package's file, link or folder lists differ
	KindUnsupportedFile    Kind = "unsupported-file"    // the package holds a device, pipe or socket
	KindFileHash           Kind = "file-hash"           // a file's SHA-256 differs from the signed one
	KindMetadata           Kind = "metadata"            // metadata.json names another version
	KindNotInstalled       Kind = "not-installed"       // no current.json (CORRUPT)
	KindPointer            Kind = "pointer"             // current.json is invalid (CORRUPT)
)

// Error is a typed refusal with the Node updater's code and message.
type Error struct {
	Code    Code
	Kind    Kind
	Message string
}

func (e *Error) Error() string { return e.Message }

func refuse(kind Kind, format string, args ...any) *Error {
	return &Error{Code: CodeRefused, Kind: kind, Message: fmt.Sprintf(format, args...)}
}

func corrupt(kind Kind, message string) *Error {
	return &Error{Code: CodeCorrupt, Kind: kind, Message: message}
}

// IsRefused reports whether err is a refusal (code REFUSED): the release, or the install's key,
// must not be used. Any other error is an I/O or state failure.
func IsRefused(err error) bool {
	var e *Error
	return errors.As(err, &e) && e.Code == CodeRefused
}
