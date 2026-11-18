package desktoprelease

import "runtime"

// Platform is a platform and architecture in Node's names (process.platform, process.arch), the
// names release manifests carry.
type Platform struct {
	OS   string
	Arch string
}

// NodePlatform maps a Go GOOS and GOARCH to Node's names, so a Go launcher checks a manifest
// written for the Node one: windows -> win32, amd64 -> x64, 386 -> ia32.
func NodePlatform(goos, goarch string) Platform {
	osName := goos
	switch goos {
	case "windows":
		osName = "win32"
	case "solaris", "illumos":
		osName = "sunos"
	}
	arch := goarch
	switch goarch {
	case "amd64":
		arch = "x64"
	case "386":
		arch = "ia32"
	case "ppc64le":
		arch = "ppc64"
	}
	return Platform{OS: osName, Arch: arch}
}

// HostPlatform is the computer this program runs on, in Node's names.
func HostPlatform() Platform { return NodePlatform(runtime.GOOS, runtime.GOARCH) }

// CheckTarget refuses a release that is not newer than the installed version, needs a newer
// installed version, or is for another platform (updater.mjs checkTarget). current is nil for a
// first install.
func CheckTarget(current *Current, m *Manifest, host Platform) error {
	if current != nil && CompareVersions(m.Version, current.Version) <= 0 {
		return refuse(KindNotNewer, "Version %s is not newer than the installed %s", m.Version, current.Version)
	}
	if current != nil && m.MinimumPrevious != nil && CompareVersions(current.Version, *m.MinimumPrevious) < 0 {
		return refuse(KindMinimumPrevious, "Version %s requires at least %s installed; found %s",
			m.Version, *m.MinimumPrevious, current.Version)
	}
	if m.Platform != host.OS || m.Arch != host.Arch {
		return refuse(KindPlatform, "Release is for %s/%s; this computer is %s/%s", m.Platform, m.Arch, host.OS, host.Arch)
	}
	return nil
}
