package app

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	analyst "github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/application"
	identity "github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/domain"
	identityhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/http"
)

// memoryProposals keeps what the proposal tools store; it is the only thing they can reach.
type memoryProposals struct{ added []analyst.StoredProposal }

func (m *memoryProposals) Add(_ context.Context, _ string, p analyst.StoredProposal, _ int) (bool, error) {
	m.added = append(m.added, p)
	return true, nil
}
func (m *memoryProposals) Pending(context.Context, string) ([]analyst.StoredProposal, error) {
	return m.added, nil
}
func (m *memoryProposals) Find(context.Context, string, string) (analyst.StoredProposal, bool, error) {
	return analyst.StoredProposal{}, false, nil
}

func proposalTools(store *memoryProposals) askTools {
	return askTools{tenantID: "ACME/NORTE", propose: analyst.Proposing{Store: store, Rules: proposalRules{}}}
}

func as(role identity.Role) context.Context {
	return identityhttp.WithPrincipal(context.Background(), &identity.Principal{Username: "solo", Role: role})
}

func TestAskToolsOfferTheTwoProposalTools(t *testing.T) {
	t.Parallel()
	names := map[string]string{}
	for _, s := range (askTools{}).Specs() {
		names[s.Name] = s.Description
		if !json.Valid(s.InputSchema) {
			t.Fatalf("%s: schema %s", s.Name, s.InputSchema)
		}
	}
	for _, want := range []string{"propose_record", "propose_link"} {
		if !strings.Contains(names[want], "Bandeja") {
			t.Fatalf("%s: description %q", want, names[want])
		}
	}
}

func TestAProposalToolStoresAPendingProposalAndNothingElse(t *testing.T) {
	t.Parallel()
	store := &memoryProposals{}
	out, err := proposalTools(store).Run(as(identity.RoleAnalyst), "propose_record",
		json.RawMessage(`{"module":"acciones","fields":{"Accion":"Visitar la comunidad","Estado":"Pendiente"},"reason":"La alerta sigue abierta"}`))
	if err != nil || !out.OK || len(out.Records) != 0 {
		t.Fatalf("out = %+v, err = %v", out, err)
	}
	if len(store.added) != 1 || store.added[0].ProposedBy != "solo" || store.added[0].Proposal.Record.Payload[0].Key != "Accion" {
		t.Fatalf("stored %+v", store.added)
	}
	ack, _ := json.Marshal(out.Data)
	if !strings.Contains(string(ack), store.added[0].ID) || !strings.Contains(string(ack), "pendiente") {
		t.Fatalf("ack %s", ack)
	}
	link, err := proposalTools(store).Run(as(identity.RoleAnalyst), "propose_link",
		json.RawMessage(`{"link_type":"participa_en","source":{"module":"actores","id":"A-1"},"target":{"module":"eventos","id":"north"},"reason":"Lo cita el acta"}`))
	if err != nil || !link.OK || len(store.added) != 2 || store.added[1].Proposal.Link == nil {
		t.Fatalf("link = %+v, err = %v, stored %d", link, err, len(store.added))
	}
}

func TestProposalToolsRefuseInvalidProposalsAndRolesThatMayNotWrite(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name, tool, input string
		role              identity.Role
	}{
		{"read-only role", "propose_record", `{"module":"acciones","fields":{"Accion":"x"},"reason":"r"}`, identity.RoleReadOnly},
		{"coordinator outside prevention", "propose_record", `{"module":"acciones","fields":{"Accion":"x"},"reason":"r"}`, identity.RoleCoordinator},
		{"admin-only module", "propose_record", `{"module":"usuarios","fields":{"Nombre":"x"},"reason":"r"}`, identity.RoleAnalyst},
		{"no reason", "propose_record", `{"module":"acciones","fields":{"Accion":"x"}}`, identity.RoleAnalyst},
		{"non-text field", "propose_record", `{"module":"acciones","fields":{"Accion":1},"reason":"r"}`, identity.RoleAnalyst},
		{"another project", "propose_record", `{"module":"eventos","fields":{"Descripcion_Hecho":"x","Proyecto_ID":"PRJ-SECHURA"},"reason":"r"}`, identity.RoleAnalyst},
		{"link the ontology refuses", "propose_link", `{"link_type":"participa_en","source":{"module":"eventos","id":"E"},"target":{"module":"actores","id":"A"},"reason":"r"}`, identity.RoleAnalyst},
		{"malformed", "propose_link", `{"link_type":3}`, identity.RoleAnalyst},
		{"redacted e-mail in a field", "propose_record", `{"module":"acciones","fields":{"Accion":"Escribir a [correo]"},"reason":"r"}`, identity.RoleAnalyst},
		{"pseudonym in a field", "propose_record", `{"module":"acciones","fields":{"Accion":"Visitar a Persona-3FA9C1"},"reason":"r"}`, identity.RoleAnalyst},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			store := &memoryProposals{}
			out, err := proposalTools(store).Run(as(tc.role), tc.tool, json.RawMessage(tc.input))
			if err != nil || out.OK || out.Refusal == "" || len(store.added) != 0 {
				t.Fatalf("out = %+v, err = %v, stored %v", out, err, store.added)
			}
		})
	}
	store := &memoryProposals{}
	if out, _ := proposalTools(store).Run(context.Background(), "propose_record", json.RawMessage(`{"module":"acciones","fields":{"Accion":"x"},"reason":"r"}`)); out.OK || len(store.added) != 0 {
		t.Fatalf("without a person: %+v", out)
	}
}
