package domain_test

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/ontology/domain"
)

func TestParseProposalDecisionInReadsAValidBody(t *testing.T) {
	t.Parallel()
	got, issues := domain.ParseProposalDecisionIn([]byte(`{"module":"alertas","id":"AL-1","fingerprint":"f","decision":"approve","extra":1}`))
	want := domain.ProposalDecisionInput{Module: "alertas", ID: "AL-1", Fingerprint: "f", Decision: "approve"}
	if issues != nil || got != want {
		t.Fatalf("%+v %v", got, issues)
	}
}

func TestParseProposalDecisionInRefusesAsZod(t *testing.T) {
	t.Parallel()
	cases := map[string]struct{ body, want string }{
		"bad decision": {
			`{"module":"a","id":"b","fingerprint":"c","decision":"maybe"}`,
			`[{"type":"invalid_value","loc":["body","decision"],"msg":"Invalid option: expected one of \"approve\"|\"reject\""}]`,
		},
		"too long": {
			`{"module":"` + strings.Repeat("m", 41) + `","id":"b","fingerprint":"c","decision":"reject"}`,
			`[{"type":"too_big","loc":["body","module"],"msg":"Too big: expected string to have <=40 characters"}]`,
		},
		"too short": {
			`{"module":"a","id":"","fingerprint":"c","decision":"reject"}`,
			`[{"type":"too_small","loc":["body","id"],"msg":"Too small: expected string to have >=1 characters"}]`,
		},
	}
	for name, c := range cases {
		_, issues := domain.ParseProposalDecisionIn([]byte(c.body))
		var got strings.Builder
		encoder := json.NewEncoder(&got)
		encoder.SetEscapeHTML(false)
		if err := encoder.Encode(issues); err != nil {
			t.Fatal(err)
		}
		if strings.TrimSpace(got.String()) != c.want {
			t.Errorf("%s: %s", name, got.String())
		}
	}
}
