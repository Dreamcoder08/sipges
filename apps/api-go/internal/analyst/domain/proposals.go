//nolint:misspell // Spanish record fields, modules and messages, verbatim from the TypeScript API.
package domain

import "time"

// Proposals of apps/api/src/contexts/analyst/domain/proposals.ts: actions the analyst offers and a
// person approves or discards, each with a stable fingerprint.

const maxProposalTitle = 80

// ProposedLink is a link a proposal would create.
type ProposedLink struct {
	LinkType string
	Source   Ref
	Target   Ref
}

// ProposedRecord is a record a proposal would create.
type ProposedRecord struct {
	Slug    string
	Payload []Field // string values, in the TypeScript literal's order
}

// Proposal is one open proposal.
type Proposal struct {
	Fingerprint string
	Kind        string // "link" or "record"
	Title       string
	Reason      string
	Link        *ProposedLink
	Record      *ProposedRecord
}

// MentionFound is a text mention found by the ontology, with the link it suggests.
type MentionFound struct {
	ProposedLink
	Other Summary
	// Label reads source → target, e.g. "participa en".
	Label string
	// HolderIsSelf: the subject's text holds the mention (holder 'self').
	HolderIsSelf bool
	Field        string
	Excerpt      string
}

func short(text string) string { return cut(text, maxProposalTitle) }

func refText(r Ref) string { return r.Slug + "/" + r.ID }

// LinkFingerprint is linkFingerprint.
func LinkFingerprint(l ProposedLink) string {
	return "link:" + l.LinkType + ":" + refText(l.Source) + ":" + refText(l.Target)
}

// addDays is addDays: the ISO date days after today (UTC).
func addDays(today string, days int) string {
	date, err := time.Parse(time.DateOnly, today)
	if err != nil {
		return "Invalid Date" // unreachable: today comes from the clock
	}
	return date.AddDate(0, 0, days).Format(time.DateOnly)
}

// MentionProposal is mentionProposal.
func MentionProposal(subject Summary, m MentionFound) Proposal {
	from, to := m.Other, subject
	if m.Source == subject.Ref() {
		from, to = subject, m.Other
	}
	holder := m.Other
	if m.HolderIsSelf {
		holder = subject
	}
	link := m.ProposedLink
	return Proposal{
		Fingerprint: LinkFingerprint(m.ProposedLink),
		Kind:        "link",
		Title: "Vincular: " + from.TypeLabel + " «" + short(from.Title) + "» " + m.Label + " " +
			to.TypeLabel + " «" + short(to.Title) + "»",
		Reason: holder.TypeLabel + " " + holder.ID + " lo menciona en " + m.Field + ": «" + m.Excerpt + "»",
		Link:   &link,
	}
}

func hasLink(connections []Connection, linkType string) bool {
	for _, c := range connections {
		if c.LinkType == linkType {
			return true
		}
	}
	return false
}

// FollowUpProposals is followUpProposals: the follow-up record an open, severe alert or demand
// lacks.
func FollowUpProposals(subject Summary, connections []Connection, today string) []Proposal {
	title := short(subject.Title)
	if subject.Slug == "alertas" && IsOpen(subject) && severe.MatchString(subject.Field("Nivel_Preliminar")) &&
		!hasLink(connections, "atiende") {
		return []Proposal{{
			Fingerprint: "record:acciones:" + refText(subject.Ref()),
			Kind:        "record",
			Title:       "Crear una acción de prevención para la alerta " + subject.ID,
			Reason:      "La alerta sigue abierta con nivel " + subject.Field("Nivel_Preliminar") + " y ninguna acción la atiende.",
			Record: &ProposedRecord{Slug: "acciones", Payload: []Field{
				{"Accion", "Atender alerta " + subject.ID + ": " + title},
				{"Alerta_Asociada", subject.ID},
				{"Estado", "Pendiente"},
				{"Plazo", addDays(today, 7)},
			}},
		}}
	}
	if subject.Slug == "demandas" && IsOpen(subject) && severe.MatchString(subject.Field("Prioridad")) &&
		!hasLink(connections, "responde_a") {
		return []Proposal{{
			Fingerprint: "record:compromisos:" + refText(subject.Ref()),
			Kind:        "record",
			Title:       "Registrar un compromiso de respuesta a la demanda " + subject.ID,
			Reason:      "La demanda tiene prioridad " + subject.Field("Prioridad") + ", sigue abierta y nada responde a ella.",
			Record: &ProposedRecord{Slug: "compromisos", Payload: []Field{
				{"Descripcion", "Responder a la demanda " + subject.ID + ": " + title},
				{"Demanda_Asociada", subject.ID},
				{"Estado", "Pendiente"},
				{"Plazo", addDays(today, 15)},
			}},
		}}
	}
	return []Proposal{}
}

const maxDecisionDetail = 500

// DecisionDetail is the audit text of a decided proposal, cut as slice(0, 500) cuts it.
func DecisionDetail(approved bool, title string, result *string) string {
	detail := "Descartada: " + title
	if approved {
		detail = "Aprobada: " + title
	}
	if result != nil {
		detail += " → " + *result
	}
	return slice16(detail, 0, maxDecisionDetail)
}
