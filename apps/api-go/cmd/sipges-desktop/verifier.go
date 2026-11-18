package main

import (
	"context"
	"crypto/ed25519"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/desktoprelease"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/desktopupdate"
)

// findUpdate is desktoprelease.FindUpdate for this computer.
func findUpdate(root, source string) (*desktoprelease.Found, error) {
	return desktoprelease.FindUpdate(root, source, desktoprelease.HostPlatform())
}

// releaseVerifier is desktoprelease's verification behind desktopupdate's Verifier: the
// signature with the trusted key, the manifest rules, a newer version, the minimum previous
// version, the platform, and every file's hash in place (updater.mjs trustedKey, readRelease,
// checkTarget, checkPackage).
type releaseVerifier struct{}

func (releaseVerifier) Verify(_ context.Context, req desktopupdate.VerifyRequest) (desktopupdate.Release, error) {
	release, err := verifyRelease(req)
	if err == nil {
		return release, nil
	}
	var re *desktoprelease.Error
	if errors.As(err, &re) {
		return desktopupdate.Release{}, &desktopupdate.Error{Code: desktopupdate.Code(re.Code), Message: re.Message}
	}
	return desktopupdate.Release{}, err
}

func verifyRelease(req desktopupdate.VerifyRequest) (desktopupdate.Release, error) {
	var current *desktoprelease.Current
	if req.Installed != nil {
		current = &desktoprelease.Current{Version: req.Installed.Version, Dir: req.Installed.Dir, Adopted: req.Installed.Adopted}
	}
	key, err := trustedKey(current, req.TrustKey)
	if err != nil {
		return desktopupdate.Release{}, err
	}
	rel, err := desktoprelease.ReadRelease(req.ReleaseDir, key)
	if err != nil {
		return desktopupdate.Release{}, err
	}
	m := rel.Manifest
	if err := desktoprelease.CheckTarget(current, m, desktoprelease.HostPlatform()); err != nil {
		return desktopupdate.Release{}, err
	}
	if err := desktoprelease.CheckPackage(req.ReleaseDir, m); err != nil {
		return desktopupdate.Release{}, err
	}
	return desktopupdate.Release{
		Version:     m.Version,
		PackageDir:  filepath.Join(req.ReleaseDir, desktoprelease.PackageDir),
		Files:       m.Files,
		Links:       m.Links,
		Directories: m.Directories,
		Manifest:    rel.Bytes,
		Signature:   []byte(rel.Signature),
	}, nil
}

// trustedKey is updater.mjs trustedKey: the installed version's key, or the operator's key for
// an install without one; a different operator key is refused.
func trustedKey(current *desktoprelease.Current, trust []byte) (ed25519.PublicKey, error) {
	if current == nil {
		if trust == nil {
			return nil, &desktopupdate.Error{Code: desktopupdate.CodeRefused, Message: "The first install needs --trust-key"}
		}
		return desktoprelease.LoadPublicKey(trust)
	}
	installed, err := os.ReadFile(filepath.Join(current.Dir, desktoprelease.PublicKeyName))
	if err == nil && trust != nil && strings.TrimSpace(string(trust)) != strings.TrimSpace(string(installed)) {
		return nil, &desktopupdate.Error{Code: desktopupdate.CodeRefused,
			Message: "The installed version already defines the update key; --trust-key is only for an install without one"}
	}
	if err != nil && trust != nil && errors.Is(err, os.ErrNotExist) {
		return desktoprelease.LoadPublicKey(trust)
	}
	return desktoprelease.TrustedKey(current.Dir)
}
