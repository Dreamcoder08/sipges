package desktoprelease

import (
	"regexp"
	"strconv"
	"strings"
)

// semverPattern is release.mjs SEMVER, unchanged (RE2 accepts it as written).
var semverPattern = regexp.MustCompile(`^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$`)

var numericIdentifier = regexp.MustCompile(`^\d+$`)

// IsVersion reports whether v is a Semantic Versioning 2.0 version.
func IsVersion(v string) bool { return semverPattern.MatchString(v) }

// jsNumber converts a run of digits the way JavaScript's Number() does: to the nearest float64.
func jsNumber(digits string) float64 {
	f, _ := strconv.ParseFloat(digits, 64)
	return f
}

func sign(f float64) int {
	switch {
	case f > 0:
		return 1
	case f < 0:
		return -1
	}
	return 0
}

// CompareVersions returns -1, 0 or 1 by Semantic Versioning 2.0 precedence, ignoring build
// metadata, exactly as release.mjs compareVersions (numbers compared as JavaScript numbers).
// Both arguments must be valid versions; it panics otherwise, as the Node function throws.
func CompareVersions(a, b string) int {
	ma, mb := semverPattern.FindStringSubmatch(a), semverPattern.FindStringSubmatch(b)
	if ma == nil || mb == nil {
		bad := a
		if ma != nil {
			bad = b
		}
		panic("desktoprelease: invalid version: " + bad)
	}
	for i := 1; i <= 3; i++ {
		if d := sign(jsNumber(ma[i]) - jsNumber(mb[i])); d != 0 {
			return d
		}
	}
	if ma[4] == "" || mb[4] == "" {
		switch {
		case ma[4] != "":
			return -1
		case mb[4] != "":
			return 1
		}
		return 0
	}
	pa, pb := strings.Split(ma[4], "."), strings.Split(mb[4], ".")
	for i := 0; i < min(len(pa), len(pb)); i++ {
		na, nb := numericIdentifier.MatchString(pa[i]), numericIdentifier.MatchString(pb[i])
		if na && nb && jsNumber(pa[i]) != jsNumber(pb[i]) {
			return sign(jsNumber(pa[i]) - jsNumber(pb[i]))
		}
		if na != nb {
			if na {
				return -1
			}
			return 1
		}
		if pa[i] != pb[i] {
			if pa[i] < pb[i] {
				return -1
			}
			return 1
		}
	}
	return sign(float64(len(pa) - len(pb)))
}
