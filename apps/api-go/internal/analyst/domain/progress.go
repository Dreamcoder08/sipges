package domain

// The steps of a question as the person sees them while it runs (odd/tasks/chat-first-ui.md T10):
// a fixed label per read tool, naming the work, never «Procesando…» (L5) and never the call's
// input or result.

// unknownToolStep labels a call to a name that is not a read tool: the name is the model's
// output, so it is never echoed.
const unknownToolStep = "Consultando una herramienta…"

var toolSteps = map[string]string{
	"search_records":    "Buscando registros…",
	"get_record":        "Leyendo el registro…",
	"get_links":         "Revisando vínculos…",
	"get_timeline":      "Leyendo la línea de tiempo…",
	"get_briefing":      "Leyendo el resumen del proyecto…",
	"list_object_types": "Revisando los tipos de registro…",
}

// ToolStepLabel is the label of a call to the tool named name.
func ToolStepLabel(name string) string {
	if label, ok := toolSteps[name]; ok {
		return label
	}
	return unknownToolStep
}
