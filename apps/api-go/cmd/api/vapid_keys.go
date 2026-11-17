package main

import (
	"fmt"
	"io"

	automation "github.com/Dreamcoder08/sipges/apps/api-go/internal/automation/infrastructure"
)

// vapidKeys prints a fresh key pair for device notifications as two .env lines. The local
// installer runs it once (deploy/local/sipges); the subject is the installer's to choose.
func vapidKeys(stdout io.Writer) error {
	public, private, err := automation.GenerateVapidKeys()
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(stdout, "SIPGES_VAPID_PUBLIC_KEY=%s\nSIPGES_VAPID_PRIVATE_KEY=%s\n", public, private)
	return err
}
