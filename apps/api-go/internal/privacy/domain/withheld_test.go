package domain

import "testing"

func TestWithheldFindsWhatTheGuardPutInPlaceOfPersonalData(t *testing.T) {
	t.Parallel()
	cases := map[string]bool{
		"Escribir a [correo]":                 true,
		"Llamar al [teléfono]":                true,
		"DNI [DNI], RUC [RUC]":                true,
		"Reunirse con Persona-3FA9C1":         true,
		"Actor-00B2E4 y Org-ABCDEF":           true,
		"Reunión con la comunidad de Sechura": false,
		"Persona-3FA9C":                       false,
		"Persona-3fa9c1":                      false,
		"[correo electrónico]":                false,
	}
	for text, want := range cases {
		if got := Withheld(text); got != want {
			t.Errorf("Withheld(%q) = %v, want %v", text, got, want)
		}
	}
}
