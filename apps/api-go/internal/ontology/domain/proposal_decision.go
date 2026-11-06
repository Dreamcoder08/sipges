package domain

// ProposalDecisionInput is ProposalDecisionIn of packages/contracts/src/ontology.ts.
type ProposalDecisionInput struct {
	Module, ID, Fingerprint, Decision string
}

func proposalDecisionIn(v any) (ProposalDecisionInput, payload) {
	var (
		p   payload
		out ProposalDecisionInput
	)
	m, ok := object(v, &p)
	if !ok {
		return out, p
	}
	var child payload
	out.Module, child = zodString(field(m, "module"), 1, 40, false)
	p.merge("module", child)
	out.ID, child = zodString(field(m, "id"), 1, 200, false)
	p.merge("id", child)
	out.Fingerprint, child = zodString(field(m, "fingerprint"), 1, 500, false)
	p.merge("fingerprint", child)
	decision, _ := field(m, "decision").(string)
	if decision != "approve" && decision != "reject" {
		p.add("invalid_value", `Invalid option: expected one of "approve"|"reject"`, flowUnset, "decision")
	}
	out.Decision = decision
	return out, p
}

// ParseProposalDecisionIn validates a POST /system/briefing/proposals body.
func ParseProposalDecisionIn(body []byte) (ProposalDecisionInput, []Issue) {
	return validate(body, proposalDecisionIn)
}
