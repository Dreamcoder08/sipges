package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/config"
)

// healthcheckTimeout bounds one check, below the timeout of the Compose healthcheck that runs it.
const healthcheckTimeout = 3 * time.Second

// healthcheck asks the API in this container whether it is ready, for the Compose healthcheck of a
// local install: the image is distroless, with no shell, curl or wget (ADR 0035). It speaks as the
// first allowed host, since the host allowlist answers 400 to any other name.
func healthcheck(ctx context.Context, lookup config.Lookup) error {
	port, ok := lookup("SIPGES_PORT")
	if !ok {
		port = "8000" // config.Load's default
	}
	if n, err := strconv.Atoi(port); err != nil || n < 1 || n > 65535 {
		return errors.New("SIPGES_PORT must be an integer between 1 and 65535")
	}
	ctx, cancel := context.WithTimeout(ctx, healthcheckTimeout)
	defer cancel()
	url := "http://" + net.JoinHostPort("127.0.0.1", port) + "/health/ready"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, http.NoBody)
	if err != nil {
		return err
	}
	if hosts, _ := lookup("SIPGES_ALLOWED_HOSTS"); hosts != "" {
		first, _, _ := strings.Cut(hosts, ",")
		req.Host = strings.TrimSpace(first)
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
