package application

import (
	"errors"
	"strings"
	"unicode/utf8"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/domain"
	privacy "github.com/Dreamcoder08/sipges/apps/api-go/internal/privacy/application"
)

// Follow-up questions (odd/tasks/chat-first-ui.md T9, owner decision L18): the earlier turns of a
// conversation travel with the new question. The person's tab keeps them; the server stores none.

// MaxHistoryTurns bounds the earlier turns of one question.
const MaxHistoryTurns = 6

// MaxHistoryChars bounds the characters (runes) of the earlier questions and answers together.
const MaxHistoryChars = 8000

// ErrInvalidHistory is a history beyond its limits, or with an empty question or answer.
var ErrInvalidHistory = errors.New("analyst: invalid history")

// Exchange is one earlier question and its answer, text only, as the person's tab kept them.
type Exchange struct {
	Question string
	Answer   string
}

// EarlierTurn is an Exchange as the egress guard released it, its answer without citations.
type EarlierTurn struct {
	Question privacy.Sanitised[string]
	Answer   privacy.Sanitised[string]
}

// CheckHistory refuses a history beyond MaxHistoryTurns or MaxHistoryChars, or with a blank text.
// An answer of citation markers alone is blank: without them nothing would be left to send.
func CheckHistory(history []Exchange) error {
	if len(history) > MaxHistoryTurns {
		return ErrInvalidHistory
	}
	chars := 0
	for _, e := range history {
		if strings.TrimSpace(e.Question) == "" || domain.StripCitations(e.Answer) == "" {
			return ErrInvalidHistory
		}
		chars += utf8.RuneCountInString(e.Question) + utf8.RuneCountInString(e.Answer)
	}
	if chars > MaxHistoryChars {
		return ErrInvalidHistory
	}
	return nil
}

// historyTexts lists the question and then each earlier question and answer, in order, for one
// release; the answers lose their citation numbers first.
func historyTexts(question string, history []Exchange) []string {
	texts := make([]string, 0, 1+2*len(history))
	texts = append(texts, question)
	for _, e := range history {
		texts = append(texts, strings.TrimSpace(e.Question), domain.StripCitations(e.Answer))
	}
	return texts
}
