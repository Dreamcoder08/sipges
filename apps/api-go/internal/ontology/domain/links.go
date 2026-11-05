package domain

import "slices"

// LinkProblem is LinkProblem of catalog.ts: why the catalog refuses a proposed link.
type LinkProblem string

// The problems checkLink reports; empty means the link is allowed.
const (
	UnknownType   LinkProblem = "unknown_type"
	UnknownObject LinkProblem = "unknown_object"
	SelfLink      LinkProblem = "self_link"
	NotAllowed    LinkProblem = "not_allowed"
)

func accepts(allowed []string, slug string) bool {
	return allowed == nil || slices.Contains(allowed, slug)
}

// CheckLink is checkLink: a proposed link (by slugs) against the catalog; symmetric types
// accept either order.
func CheckLink(linkTypeID string, source, target Ref) LinkProblem {
	linkType, ok := LinkTypeByID(linkTypeID)
	if !ok {
		return UnknownType
	}
	_, sourceKnown := ObjectTypeForSlug(source.Module)
	_, targetKnown := ObjectTypeForSlug(target.Module)
	if !sourceKnown || !targetKnown {
		return UnknownObject
	}
	if source.Module == target.Module && source.ID == target.ID {
		return SelfLink
	}
	forward := accepts(linkType.Sources, source.Module) && accepts(linkType.Targets, target.Module)
	backward := linkType.Symmetric && accepts(linkType.Sources, target.Module) && accepts(linkType.Targets, source.Module)
	if forward || backward {
		return ""
	}
	return NotAllowed
}
