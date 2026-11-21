package domain

import (
	"regexp"
	"strconv"
	"strings"
)

// withheldText matches what the guard puts in place of personal data: a pseudonym token and the
// contact and identity placeholders.
var withheldText = regexp.MustCompile(`\b(?:` + string(Actor) + `|` + string(Persona) + `|` + string(Org) + `)-[0-9A-F]{` +
	strconv.Itoa(tokenHex) + `}\b|` + regexp.QuoteMeta(PlaceholderEmail) + `|` + regexp.QuoteMeta(PlaceholderPhone) + `|` +
	regexp.QuoteMeta(PlaceholderDNI) + `|` + regexp.QuoteMeta(PlaceholderRUC))

// Withheld reports whether text carries a pseudonym or a placeholder in place of personal data:
// the model only ever saw those, so a value holding one is not the real datum.
func Withheld(text string) bool {
	return strings.ContainsAny(text, "[-") && withheldText.MatchString(text)
}
