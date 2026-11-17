package main

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/config"
)

// healthcheckTimeout bounds one check, below the timeout of the Compose healthcheck that runs it.
const healthcheckTimeout = 3 * time.Second

// healthcheck asks the API in this container whether it is ready, for the Compose healthcheck of a
// local install: the image is distroless, with no shell, curl or wget (ADR 0035). It speaks as the
// first allowed host, read as the API reads it, since the host allowlist answers 400 to any other name.
func healthcheck(ctx context.Context, lookup config.Lookup) error {
	port, err := config.Port(lookup)
	if err != nil {
		return err
	}
	hosts, err := config.AllowedHosts(lookup)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, healthcheckTimeout)
	defer cancel()
	url := "http://" + net.JoinHostPort("127.0.0.1", strconv.Itoa(port)) + "/health/ready"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, http.NoBody)
	if err != nil {
		return err
	}
	if len(hosts) > 0 {
		req.Host = hosts[0]
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("not ready: %w", err)
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("not ready: /health/ready answered %d", res.StatusCode)
	}
	return nil
}
