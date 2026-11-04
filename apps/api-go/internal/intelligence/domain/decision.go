package domain

import (
	"slices"
	"unicode/utf16"
	"unicode/utf8"
)

// MaxNoteLength is MAX_NOTE_LENGTH: the longest reviewer note, in code points.
const MaxNoteLength = 2000

// maxDecisionID is the longest id (UTF-16 code units) decideAlert looks up.
const maxDecisionID = 64

// actionableStates is ACTIONABLE_STATES: alerts a preventive plan may follow.
var actionableStates = []string{"Corroborado", "En seguimiento"}

// IsAlertState is isAlertState.
func IsAlertState(s string) bool { return slices.Contains(AlertStates, s) }

// FourEyesOutcome is FourEyesOutcome of alerts.ts.
type FourEyesOutcome int

// The outcomes of FourEyes.
const (
	// Apply changes the status.
	Apply FourEyesOutcome = iota
	// First records the first of two validations without changing the status.
	First
	// SamePerson refuses a second validation by the first validator.
	SamePerson
)

// FourEyes is fourEyes (docs/adr/0024): moving a high-priority alert into an actionable state
// needs two different people. firstValidator "" means none.
func FourEyes(level, current, next, firstValidator, actor string) FourEyesOutcome {
	actionable := func(state string) bool { return slices.Contains(actionableStates, state) }
	if level != "Alta" || !actionable(next) || actionable(current) {
		return Apply
	}
	if firstValidator == "" {
		return First
	}
	if firstValidator == actor {
		return SamePerson
	}
	return Apply
}

// DecisionError is AlertDecisionError's kind; "" is none.
type DecisionError string

// The kinds of AlertDecisionError.
const (
	ErrStatus      DecisionError = "status"
	ErrNoteTooLong DecisionError = "note_too_long"
	ErrMissing     DecisionError = "missing"
	ErrSamePerson  DecisionError = "same_person"
)

// CheckDecision is decideAlert's checks before it reads the alert, in its order: a known
// status, a note of at most 2000 code points, an id of at most 64 UTF-16 code units.
func CheckDecision(id, status, note string) DecisionError {
	switch {
	case !IsAlertState(status):
		return ErrStatus
	case utf8.RuneCountInString(note) > MaxNoteLength:
		return ErrNoteTooLong
	case len(utf16.Encode([]rune(id))) > maxDecisionID:
		return ErrMissing
	}
	return ""
}

// DecisionDetail is the audit detail of a decision: the status, and the first validator when
// the updated alert still names one.
func DecisionDetail(status string, firstValidator *string) string {
	if firstValidator != nil && *firstValidator != "" {
		return status + " (primera validación: " + *firstValidator + ")"
	}
	return status
}

// FirstValidationDetail is the audit detail of a first validation.
func FirstValidationDetail(actor string) string { return "Primera validación: " + actor }
