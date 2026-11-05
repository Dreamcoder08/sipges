package app

import (
	"net/http"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/automation/application"
	automationsql "github.com/Dreamcoder08/sipges/apps/api-go/internal/automation/infrastructure"
)

// pushTransport overrides how the push sender reaches its service (tests); nil means the
// default client.
var pushTransport http.RoundTripper

// withPush adds browser push to the service: the subscriptions always, the sender only with
// SIPGES_VAPID_* set. Invalid keys stop the start, as parseVapid does; their values never appear.
func withPush(service application.Service, pool *pgxpool.Pool) (application.Service, error) {
	service.Subscriptions = automationsql.Subscriptions{DB: pool}
	keys, err := automationsql.LoadVapid(automationEnv)
	if err != nil || keys == nil {
		return service, err
	}
	var client *http.Client
	if pushTransport != nil {
		client = automationsql.NewPushClient(pushTransport)
	}
	sender, err := automationsql.NewWebPushSender(keys, client)
	if err != nil {
		return service, err
	}
	service.PushSender = sender
	return service, nil
}
