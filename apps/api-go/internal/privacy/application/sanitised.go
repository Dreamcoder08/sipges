package application

import "encoding/json"

// Sanitised is what may leave SIPGES for an external model or client (docs/adr/0030). Adapters
// accept only this type. Its value is unexported and only this package builds one, so where
// TypeScript needs a brand and a structural test, the compiler refuses a payload the guard did not
// seal.
type Sanitised[T any] struct {
	value T
}

// Value is the cleared payload.
func (s Sanitised[T]) Value() T { return s.value }

// MarshalJSON writes the cleared payload.
func (s Sanitised[T]) MarshalJSON() ([]byte, error) { return json.Marshal(s.value) }

func seal[T any](data T) Sanitised[T] { return Sanitised[T]{value: data} }

// ExemptReason says why a payload is cleared without sanitising: it is not tenant data leaving.
type ExemptReason string

// The reasons a payload is exempt.
const (
	// ExemptConstant is text written in the code.
	ExemptConstant ExemptReason = "constant"
	// ExemptAcknowledgement is the id a caller's own write was given.
	ExemptAcknowledgement ExemptReason = "acknowledgement"
	// ExemptLoopback is text for a model on this machine, which is not egress.
	ExemptLoopback ExemptReason = "loopback"
)

// ExemptPayload clears data without sanitising it, for one of the reasons above.
func ExemptPayload[T any](data T, _ ExemptReason) Sanitised[T] { return seal(data) }
