package config

import (
	"errors"
	"strconv"
	"time"
)

// parseAutomationSchedule is what starts the Go cron. Only SIPGES_GO_AUTOMATION_CRON turns it on:
// SIPGES_AUTOMATION_INTERVAL belongs to the TypeScript API as well and is read only after the
// flag, so sharing an environment with TypeScript never starts a second runner. Off is zero.
func parseAutomationSchedule(lookup Lookup) (time.Duration, error) {
	on, err := parseSwitch(lookup, "SIPGES_GO_AUTOMATION_CRON", false)
	if err != nil || !on {
		return 0, err
	}
	raw, ok := lookup("SIPGES_AUTOMATION_INTERVAL")
	if !ok {
		return 30 * time.Second, nil // parseAutomation's default
	}
	seconds, err := strconv.Atoi(raw)
	if !digits.MatchString(raw) || err != nil || seconds < 5 || seconds > 3600 {
		// A flag that asks for the cron and an interval that runs none must not start quietly.
		return 0, errors.New("SIPGES_AUTOMATION_INTERVAL must be between 5 and 3600 seconds when SIPGES_GO_AUTOMATION_CRON is 1")
	}
	return time.Duration(seconds) * time.Second, nil
}
