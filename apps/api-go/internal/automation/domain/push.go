package domain

import (
	"regexp"
	"slices"
	"unicode/utf16"
)

// PushOrigin is `new URL(endpoint).origin` for a push endpoint: the VAPID audience. ok is false
// for anything but an https URL without credentials.
func PushOrigin(endpoint string) (string, bool) {
	u, ok := parseHTTPS(endpoint)
	if !ok || u.userinfo {
		return "", false
	}
	return "https://" + u.host, true
}

// pushHosts is PUSH_HOSTS: the major browsers' push services, the only hosts a subscription may
// name, so a subscribe request cannot make this API call an arbitrary address.
var pushHosts = []*regexp.Regexp{
	regexp.MustCompile(`^fcm\.googleapis\.com$`),
	regexp.MustCompile(`^updates\.push\.services\.mozilla\.com$`),
	regexp.MustCompile(`^[a-z0-9-]+\.push\.apple\.com$`),
	regexp.MustCompile(`^web\.push\.apple\.com$`),
	regexp.MustCompile(`^[a-z0-9-]+\.notify\.windows\.com$`),
}

// IsPushEndpoint is isPushEndpoint: an https URL of a known push service, without credentials,
// of at most 1000 UTF-16 units. parseHTTPS reads a subset of URLs, so an endpoint outside it is
// refused here while TypeScript accepts it; the browsers' push services do not issue those.
func IsPushEndpoint(endpoint string) bool {
	u, ok := parseHTTPS(endpoint)
	if !ok || u.userinfo || len(utf16.Encode([]rune(endpoint))) > 1000 {
		return false
	}
	return slices.ContainsFunc(pushHosts, func(host *regexp.Regexp) bool { return host.MatchString(u.hostname) })
}
