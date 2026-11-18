package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/desktoprelease"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/desktopupdate"
)

// checkInstallForm keeps the install form (--release) apart from the launcher's options, as
// update.mjs and launcher.mjs are apart: --state and the trust options only go with --release,
// and --release takes none of the launcher's.
func checkInstallForm(o launcherOptions, seen map[string]bool) error {
	if o.release == "" {
		if o.state != "" || o.trustKey != "" || o.trustRelease {
			return errors.New("Missing --release") //nolint:staticcheck // ST1005: update.mjs's message
		}
		return nil
	}
	if seen["--releases"] || seen["--port"] || seen["--pg-bin"] || o.prepareOnly {
		return errInvalidOptions
	}
	if o.trustRelease && o.trustKey != "" {
		return errors.New("Use either --trust-key or --trust-release-key") //nolint:staticcheck // ST1005: update.mjs's message
	}
	return nil
}

// runInstall is update.mjs's first install (--install <root> --release <dir> --state <dir>) with
// desktopupdate.Install, so an installer needs no Node: it verifies the release, installs it into
// root, records the real path of the state folder in install.json and starts nothing.
func runInstall(ctx context.Context, root string, o launcherOptions, stdout, stderr io.Writer) int {
	fail := func(err error) int {
		_, _ = fmt.Fprintln(stderr, "Error: "+err.Error())
		return desktopupdate.ExitCode(err)
	}
	release, err := filepath.Abs(o.release)
	if err != nil {
		return fail(err)
	}
	current, err := desktopupdate.ReadCurrent(root)
	if err != nil {
		return fail(err)
	}
	if current != nil {
		if o.trustRelease {
			return fail(errors.New("--trust-release-key is only for a first install"))
		}
		return fail(errors.New("A version is already installed; use update")) //nolint:staticcheck // ST1005: the updater's message
	}
	if o.state == "" {
		return fail(errors.New("Missing --state for the first install")) //nolint:staticcheck // ST1005: update.mjs's message
	}
	state, err := filepath.Abs(o.state)
	if err != nil {
		return fail(err)
	}
	if o.trustKey == "" && !o.trustRelease {
		// Before Install, which would create the install root first.
		return fail(errors.New("The first install needs --trust-key")) //nolint:staticcheck // ST1005: the updater's message
	}
	var trust []byte
	switch {
	case o.trustKey != "":
		if trust, err = os.ReadFile(o.trustKey); err != nil {
			return fail(err)
		}
	case o.trustRelease:
		if trust, err = releaseKey(release); err != nil {
			return fail(err)
		}
		key, err := desktoprelease.LoadPublicKey(trust)
		if err != nil {
			return fail(err)
		}
		_, _ = fmt.Fprintf(stdout, "Trusting the update key that signed this release (SHA-256 %s).\n",
			desktoprelease.KeyFingerprint(key))
	}
	result, err := desktopupdate.Install(ctx, desktopupdate.InstallOptions{
		Root: root, Release: release, StateDir: state, TrustKey: trust, Verifier: releaseVerifier{},
	})
	if err != nil {
		return fail(err)
	}
	_, _ = fmt.Fprintf(stdout, "Installed %s\n", result.Version)
	return 0
}

// releaseKey is the public key a release ships in its package (update.mjs releaseKey).
func releaseKey(release string) ([]byte, error) {
	return os.ReadFile(filepath.Join(release, desktoprelease.PackageDir, desktoprelease.PublicKeyName)) //nolint:gosec // the release folder the operator named
}
