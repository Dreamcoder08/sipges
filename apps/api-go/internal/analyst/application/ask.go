package application

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/domain"
	privacy "github.com/Dreamcoder08/sipges/apps/api-go/internal/privacy/application"
)

// Ask is the analyst behind the Inicio box (odd/tasks/agentic-analyst.md S2): a bounded loop in
// which a model calls SIPGES's own read tools and then answers, citing only records those tools
// returned. It holds no data logic: the tools are the MCP read tools, run with the person's
// project and clearance, and their results reach the model only as the egress guard sealed them.

// MaxToolCalls bounds the tool calls of one question.
const MaxToolCalls = 6

// AskTimeout bounds one question, model and tools included.
const AskTimeout = 30 * time.Second

var (
	// ErrTooManyToolCalls is a model that kept calling tools past MaxToolCalls.
	ErrTooManyToolCalls = errors.New("analyst: too many tool calls for one question")
	// ErrModel is a model that failed to answer; the adapter's own error stays out of it.
	ErrModel = errors.New("analyst: the model did not answer")
)

// ToolSpec describes a tool to the model.
type ToolSpec struct {
	Name        string
	Description string
	InputSchema json.RawMessage
}

// ToolCall is one call the model asked for.
type ToolCall struct {
	ID    string
	Name  string
	Input json.RawMessage
}

// ToolOutput is a tool's answer: sealed data and the records found in it, or a fixed refusal.
type ToolOutput struct {
	OK      bool
	Data    privacy.Sanitised[any]
	Records []domain.RecordRef
	Refusal string
}

// ToolTurn is a tool's answer as the model sees it, with the numbers of its records.
type ToolTurn struct {
	Call    ToolCall
	Output  ToolOutput
	Sources []domain.Cited
}

// Turn is one entry of the conversation of a question: the question, the model's calls, or a
// tool's answer. Exactly one field is set.
type Turn struct {
	Question string
	Calls    []ToolCall
	Result   *ToolTurn
}

// Step is the model's next move: tool calls, or (with no calls) its final answer.
type Step struct {
	Text  string
	Calls []ToolCall
}

// ToolModel is an external model able to call tools.
type ToolModel interface {
	Next(ctx context.Context, tools []ToolSpec, turns []Turn) (Step, error)
}

// ToolRunner runs the read tools for the person asking.
type ToolRunner interface {
	Specs() []ToolSpec
	Run(ctx context.Context, name string, input json.RawMessage) (ToolOutput, error)
}

// Ask answers one question; Timeout zero means AskTimeout.
type Ask struct {
	Model   ToolModel
	Tools   ToolRunner
	Timeout time.Duration
}

// Answer runs the loop for question and checks the citations of the final answer.
func (a Ask) Answer(ctx context.Context, question string) (domain.CitedAnswer, error) {
	timeout := a.Timeout
	if timeout <= 0 {
		timeout = AskTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	specs := a.Tools.Specs()
	turns := []Turn{{Question: question}}
	var sources domain.Sources
	calls := 0
	for {
		step, err := a.Model.Next(ctx, specs, turns)
		if err != nil {
			if ctx.Err() != nil {
				return domain.CitedAnswer{}, ctx.Err()
			}
			return domain.CitedAnswer{}, ErrModel
		}
		if len(step.Calls) == 0 {
			return domain.Cite(step.Text, &sources)
		}
		turns = append(turns, Turn{Calls: step.Calls})
		for _, c := range step.Calls {
			if calls == MaxToolCalls {
				return domain.CitedAnswer{}, ErrTooManyToolCalls
			}
			calls++
			out, err := a.Tools.Run(ctx, c.Name, c.Input)
			if err != nil {
				return domain.CitedAnswer{}, err
			}
			numbered := make([]domain.Cited, 0, len(out.Records))
			for _, ref := range out.Records {
				numbered = append(numbered, domain.Cited{N: sources.Add(ref), RecordRef: ref})
			}
			turns = append(turns, Turn{Result: &ToolTurn{Call: c, Output: out, Sources: numbered}})
		}
	}
}
