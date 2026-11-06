package httpx

import (
	"net/http"
	"time"
)

// ExtendWriteDeadline gives one response more time than the server's WriteTimeout, which would
// otherwise cut a slow answer with an EOF the handler never sees. Best effort: a writer without
// deadlines keeps the server's.
func ExtendWriteDeadline(w http.ResponseWriter, d time.Duration) {
	_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(d))
}
