// Package application is the update notice of a managed desktop install, as
// apps/api/src/contexts/system/application/desktop-update.ts. The desktop launcher verifies the
// local release (signature with the installed key, newer version) and owns the update; the API
// only reports what it verified and passes on an explicit request.
package application

import (
	"context"
	"sync/atomic"
)

// DesktopUpdateAvailable is the newer release the launcher verified.
type DesktopUpdateAvailable struct {
	Version string
	Notes   *string
}

// DesktopUpdateCheck is what the launcher verified at startup; Available is nil when nothing
// newer is signed.
type DesktopUpdateCheck struct {
	Installed *string
	Available *DesktopUpdateAvailable
}

// DesktopUpdateChannel is the folder shared with the launcher. A missing or invalid status reads
// as "nothing found".
type DesktopUpdateChannel interface {
	Read(ctx context.Context) (DesktopUpdateCheck, error)
	// Request asks the launcher to stop SIPGES, install version and start it again.
	Request(ctx context.Context, version string) error
}

// DesktopUpdateStatus is the answer of GET /system/desktop/update (DesktopUpdateStatus in
// @sipges/contracts), in the same key order.
type DesktopUpdateStatus struct {
	Installed *string `json:"installed"`
	Available *string `json:"available"`
	Notes     *string `json:"notes"`
	Dismissed bool    `json:"dismissed"`
}

// DesktopUpdates is createDesktopUpdateService: «Ahora no» is kept in memory, so the notice
// returns on the next start.
type DesktopUpdates struct {
	channel   DesktopUpdateChannel
	dismissed atomic.Bool
}

// NewDesktopUpdates builds the service on channel.
func NewDesktopUpdates(channel DesktopUpdateChannel) *DesktopUpdates {
	return &DesktopUpdates{channel: channel}
}

// Status reports the installed version, the verified update and whether it was dismissed.
func (s *DesktopUpdates) Status(ctx context.Context) (DesktopUpdateStatus, error) {
	check, err := s.channel.Read(ctx)
	if err != nil {
		return DesktopUpdateStatus{}, err
	}
	status := DesktopUpdateStatus{Installed: check.Installed, Dismissed: s.dismissed.Load()}
	if check.Available != nil {
		version := check.Available.Version
		status.Available, status.Notes = &version, check.Available.Notes
	}
	return status, nil
}

// Dismiss hides the notice until the next start.
func (s *DesktopUpdates) Dismiss() { s.dismissed.Store(true) }

// Start asks the launcher for the verified version and returns it; ok is false when no verified
// update is available, and then nothing is requested.
func (s *DesktopUpdates) Start(ctx context.Context) (version string, ok bool, err error) {
	check, err := s.channel.Read(ctx)
	if err != nil || check.Available == nil {
		return "", false, err
	}
	if err := s.channel.Request(ctx, check.Available.Version); err != nil {
		return "", false, err
	}
	return check.Available.Version, true, nil
}
