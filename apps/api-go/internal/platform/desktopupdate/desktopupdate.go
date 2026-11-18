// Package desktopupdate is the Go port of the run-time transaction of the desktop updater
// (deploy/desktop/updater/updater.mjs): an atomic, recoverable update of a managed desktop
// install. It reads and writes the same files as the Node updater, so an install that Node left
// half-updated recovers here, and the other way round. Layout of an install root:
//
//	versions/<version>/   complete verified copies (files copied, never hard-linked)
//	current.json          the pointer, replaced only by one rename of a fully written temp file
//	install.json          absolute state folder, written once
//	update.lock, update-journal.json, update.log (JSON lines), first-start.json
//
// The state folder lives outside versions/. The updater only copies it; the injected migration
// is the only writer, and every failure after it restores the folder from the pre-update copy.
// Release signatures and manifest rules belong to the Verifier the caller injects.
package desktopupdate

import (
	"context"
	"errors"
	"fmt"
)

// Steps are the points an update passes, in order, reported to UpdateOptions.OnStep.
var Steps = []string{
	"locked", "verified", "staged", "installed", "state-copied",
	"rehearsed", "migrated", "switched", "ready", "committed",
}

// Code classifies an updater error as the Node updater does (error.code).
type Code string

// The error codes of the Node updater.
const (
	CodeRefused            Code = "REFUSED"
	CodeBusy               Code = "BUSY"
	CodeCorrupt            Code = "CORRUPT"
	CodeRolledBack         Code = "ROLLED_BACK"
	CodeRollbackIncomplete Code = "ROLLBACK_INCOMPLETE"
)

// ErrRefused matches every refusal: a refused *Error, and a Verifier error that reports one.
var ErrRefused = errors.New("refused")

// Error is an updater error with its Node code. PreUpdateCopy is set on ROLLBACK_INCOMPLETE.
type Error struct {
	Code          Code
	Message       string
	PreUpdateCopy string
}

func (e *Error) Error() string { return e.Message }

// Is lets errors.Is(err, ErrRefused) match a refusal.
func (e *Error) Is(target error) bool { return target == ErrRefused && e.Code == CodeRefused }

func refuse(format string, args ...any) *Error {
	return &Error{Code: CodeRefused, Message: fmt.Sprintf(format, args...)}
}

func newError(code Code, format string, args ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...)}
}

func codeIs(err error, codes ...Code) bool {
	var e *Error
	if !errors.As(err, &e) {
		return false
	}
	for _, code := range codes {
		if e.Code == code {
			return true
		}
	}
	return false
}

// Exit codes of update.mjs: 0 done, 1 refused or invalid, 2 failed and rolled back, 3 rollback
// incomplete (do not start SIPGES on the state folder).
const (
	ExitDone               = 0
	ExitRefused            = 1
	ExitRolledBack         = 2
	ExitRollbackIncomplete = 3
)

// ExitCode maps the result of an operation to the exit code update.mjs gives it.
func ExitCode(err error) int {
	switch {
	case err == nil:
		return ExitDone
	case codeIs(err, CodeRolledBack):
		return ExitRolledBack
	case codeIs(err, CodeRollbackIncomplete):
		return ExitRollbackIncomplete
	default:
		return ExitRefused
	}
}

// Target is what a migration or readiness hook works on.
type Target struct {
	VersionDir string
	StateDir   string
	Version    string
}

// Hook migrates or checks a state folder for a version; the caller decides how to boot it.
type Hook func(ctx context.Context, target Target) error

// Installed is the version whose update key a release must be signed with.
type Installed struct {
	Version string
	Dir     string
	Adopted bool
}

// VerifyRequest asks a Verifier to check one release directory.
type VerifyRequest struct {
	ReleaseDir string
	// Installed is nil for a first install; for an adoption it is the old plain package.
	Installed *Installed
	// TrustKey is the PEM public key the operator supplied, or nil.
	TrustKey []byte
}

// Release is a release whose signature, manifest and target the Verifier accepted.
type Release struct {
	Version     string
	PackageDir  string            // <release>/package, the files to stage
	Files       map[string]string // POSIX relative path -> SHA-256 hex
	Links       map[string]string // POSIX relative path -> relative directory target
	Directories []string
	Manifest    []byte // the exact verified release.json bytes, written into the version
	Signature   []byte // the release.sig text to write into the version
}

// Verifier checks a release before anything is staged: the signature with the trusted key (the
// installed version's update-public-key.pem, or TrustKey when it has none), the manifest rules,
// a newer version, the minimum previous version and the platform. Its refusals must match
// errors.Is(err, ErrRefused); their message is reported as is.
type Verifier interface {
	Verify(ctx context.Context, req VerifyRequest) (Release, error)
}
