package domain

import (
	"strings"
	"unicode"
)

// Proposals the Inicio analyst stores (odd/tasks/agentic-analyst.md S4). Their content comes from
// a model, so it is untrusted: every text is bounded and checked here before any store sees it,
// and the write rules of the owning contexts run on top (the composition root's job).

// The bounds of a stored proposal.
const (
	MaxProposedFields   = 30
	MaxProposedKey      = 64
	MaxProposedValue    = 2000
	MaxProposedID       = 200
	MaxProposalReason   = 500
	MaxPendingProposals = 200
)

// storedPrefix marks the fingerprint of a stored proposal in proposal_decisions.
const storedPrefix = "stored:"

// StoredFingerprint is the decision fingerprint of the stored proposal id.
func StoredFingerprint(id string) string { return storedPrefix + id }

// The refusals of a proposal the model made, as the model reads them.
const (
	RefusedNoReason   = "Falta el motivo de la propuesta"
	RefusedModule     = "Módulo no válido para una propuesta"
	RefusedFields     = "Los campos propuestos no son válidos"
	RefusedLinkEnds   = "Los registros del vínculo no son válidos"
	RefusedLinkType   = "Tipo de vínculo no válido"
	RefusedRole       = "Tu rol no puede escribir en ese módulo"
	RefusedTooMany    = "Hay demasiadas propuestas pendientes en este proyecto"
	RefusedValidation = "La propuesta no cumple las reglas del módulo: "
)

// printable rejects control characters: a key or id is one line of plain text.
func printable(s string) bool {
	return !strings.ContainsFunc(s, unicode.IsControl)
}

func validText(s string, limit int) bool {
	return strings.TrimSpace(s) != "" && len(units(s)) <= limit && printable(s)
}

// ProposalReason is the model's reason, collapsed and cut; "" when it gave none.
func ProposalReason(reason string) string {
	if strings.TrimSpace(reason) == "" {
		return ""
	}
	return cut(reason, MaxProposalReason)
}

// RecordDraft is the stored-proposal form of a record the model proposed, or why it is refused.
// Values are strings: the analyst proposes text, a person reviews it before anything is written.
func RecordDraft(record ProposedRecord, reason string) (Proposal, string) {
	why := ProposalReason(reason)
	if why == "" {
		return Proposal{}, RefusedNoReason
	}
	t, ok := ObjectTypeForSlug(record.Slug)
	if !ok {
		return Proposal{}, RefusedModule
	}
	if len(record.Payload) == 0 || len(record.Payload) > MaxProposedFields {
		return Proposal{}, RefusedFields
	}
	seen := map[string]bool{}
	for _, f := range record.Payload {
		value, isText := f.Value.(string)
		if !isText || !validText(f.Key, MaxProposedKey) || seen[f.Key] || len(units(value)) > MaxProposedValue {
			return Proposal{}, RefusedFields
		}
		seen[f.Key] = true
	}
	payload := make([]Field, 0, len(record.Payload))
	payload = append(payload, record.Payload...)
	draft := ProposedRecord{Slug: record.Slug, Payload: payload}
	title := TitleOf(t, "", Payload(payload))
	if title == "" {
		title = "sin título"
	}
	return Proposal{
		Kind:   "record",
		Title:  "Crear " + t.Label + ": «" + short(title) + "»",
		Reason: why,
		Record: &draft,
	}, ""
}

// LinkDraft is the stored-proposal form of a link the model proposed, or why it is refused.
func LinkDraft(link ProposedLink, reason string) (Proposal, string) {
	why := ProposalReason(reason)
	if why == "" {
		return Proposal{}, RefusedNoReason
	}
	for _, end := range []Ref{link.Source, link.Target} {
		if _, ok := ObjectTypeForSlug(end.Slug); !ok || !validText(end.ID, MaxProposedID) {
			return Proposal{}, RefusedLinkEnds
		}
	}
	linkType, ok := LinkTypeByID(link.LinkType)
	if !ok {
		return Proposal{}, RefusedLinkType
	}
	if !linkAllowed(link.LinkType, link.Source, link.Target) {
		return Proposal{}, RefusedLinkType
	}
	source, _ := ObjectTypeForSlug(link.Source.Slug)
	target, _ := ObjectTypeForSlug(link.Target.Slug)
	draft := link
	return Proposal{
		Kind: "link",
		Title: "Vincular: " + source.Label + " " + short(link.Source.ID) + " " + linkType.Label + " " +
			target.Label + " " + short(link.Target.ID),
		Reason: why,
		Link:   &draft,
	}, ""
}
