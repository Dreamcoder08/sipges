package domain

// PushOrigin is `new URL(endpoint).origin` for a push endpoint: the VAPID audience. ok is false
// for anything but an https URL without credentials.
func PushOrigin(endpoint string) (string, bool) {
	u, ok := parseHTTPS(endpoint)
	if !ok || u.userinfo {
		return "", false
	}
	return "https://" + u.host, true
}
