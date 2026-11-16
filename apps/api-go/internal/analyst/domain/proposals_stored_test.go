package domain

import (
	"strings"
	"testing"
)

func TestRecordDraftRefusesWhatTheModelMayNotPropose(t *testing.T) {
	t.Parallel()
	fields := func(n int) []Field {
		out := make([]Field, n)
		for i := range out {
			out[i] = Field{Key: "Campo_" + string(rune('A'+i%26)) + strings.Repeat("x", i/26), Value: "v"}
		}
		return out
	}
	ok := []Field{{"Accion", "Visitar la comunidad"}, {"Estado", "Pendiente"}}
	cases := map[string]struct {
		record ProposedRecord
		reason string
		want   string
	}{
		"no reason":          {ProposedRecord{"acciones", ok}, "  ", RefusedNoReason},
		"unknown module":     {ProposedRecord{"usuarios", ok}, "r", RefusedModule},
		"no fields":          {ProposedRecord{"acciones", nil}, "r", RefusedFields},
		"too many fields":    {ProposedRecord{"acciones", fields(MaxProposedFields + 1)}, "r", RefusedFields},
		"non-text value":     {ProposedRecord{"acciones", []Field{{"Accion", 3.0}}}, "r", RefusedFields},
		"long value":         {ProposedRecord{"acciones", []Field{{"Accion", strings.Repeat("a", MaxProposedValue+1)}}}, "r", RefusedFields},
		"long key":           {ProposedRecord{"acciones", []Field{{strings.Repeat("k", MaxProposedKey+1), "v"}}}, "r", RefusedFields},
		"control in key":     {ProposedRecord{"acciones", []Field{{"Acc\nion", "v"}}}, "r", RefusedFields},
		"repeated key":       {ProposedRecord{"acciones", []Field{{"Accion", "a"}, {"Accion", "b"}}}, "r", RefusedFields},
		"blank key":          {ProposedRecord{"acciones", []Field{{" ", "v"}}}, "r", RefusedFields},
		"valid is accepted":  {ProposedRecord{"acciones", ok}, "La alerta sigue abierta", ""},
		"html stays as text": {ProposedRecord{"acciones", []Field{{"Accion", "<b>x</b>"}}}, "r", ""},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			p, refusal := RecordDraft(tc.record, tc.reason)
			if refusal != tc.want {
				t.Fatalf("refusal = %q, want %q", refusal, tc.want)
			}
			if tc.want == "" && (p.Kind != "record" || p.Record == nil || p.Title == "" || p.Reason == "") {
				t.Fatalf("draft = %+v", p)
			}
		})
	}
}

func TestRecordDraftNamesTheRecordAndBoundsTheReason(t *testing.T) {
	t.Parallel()
	p, refusal := RecordDraft(ProposedRecord{"acciones", []Field{{"Accion", "Visitar la comunidad"}}}, strings.Repeat("r", 2000))
	if refusal != "" || p.Title != "Crear Acción: «Visitar la comunidad»" {
		t.Fatalf("title = %q, refusal %q", p.Title, refusal)
	}
	if n := len([]rune(p.Reason)); n > MaxProposalReason {
		t.Fatalf("reason has %d characters", n)
	}
}

func TestLinkDraftFollowsTheOntologyRules(t *testing.T) {
	t.Parallel()
	actor, event := Ref{"actores", "A-1"}, Ref{"eventos", "E-1"}
	cases := map[string]struct {
		link ProposedLink
		want string
	}{
		"allowed":       {ProposedLink{"participa_en", actor, event}, ""},
		"wrong way":     {ProposedLink{"participa_en", event, actor}, RefusedLinkType},
		"unknown type":  {ProposedLink{"odia_a", actor, event}, RefusedLinkType},
		"self link":     {ProposedLink{"relacionado_con", actor, actor}, RefusedLinkType},
		"unknown end":   {ProposedLink{"relacionado_con", actor, Ref{"usuarios", "u"}}, RefusedLinkEnds},
		"empty id":      {ProposedLink{"relacionado_con", actor, Ref{"eventos", ""}}, RefusedLinkEnds},
		"overlong id":   {ProposedLink{"relacionado_con", actor, Ref{"eventos", strings.Repeat("e", MaxProposedID+1)}}, RefusedLinkEnds},
		"control in id": {ProposedLink{"relacionado_con", actor, Ref{"eventos", "E\x00"}}, RefusedLinkEnds},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			p, refusal := LinkDraft(tc.link, "porque sí")
			if refusal != tc.want {
				t.Fatalf("refusal = %q, want %q", refusal, tc.want)
			}
			if tc.want == "" && (p.Kind != "link" || p.Link == nil || p.Title != "Vincular: Actor A-1 participa en Evento E-1") {
				t.Fatalf("draft = %+v", p)
			}
		})
	}
	if _, refusal := LinkDraft(ProposedLink{"participa_en", actor, event}, ""); refusal != RefusedNoReason {
		t.Fatalf("no reason: %q", refusal)
	}
}
