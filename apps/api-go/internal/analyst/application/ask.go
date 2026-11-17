package application

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
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
	// ErrModelUnavailable is a model provider that could not be reached or would not serve the
	// question (local QA T6): no connection, an unknown host, its time budget spent, no credential,
	// or a 401, 403, 429 or 5xx. An adapter's error wraps it next to ErrModel; asking again later,
	// or the administrator, is what helps.
	ErrModelUnavailable = errors.New("analyst: the model provider is unavailable")
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
// tool's answer. Exactly one is set; the question is the person's text as the egress guard
// released it, so an adapter cannot receive it raw.
type Turn struct {
	Question privacy.Sanitised[string]
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

// Seal releases the person's question through the egress guard: scrubbed of known names and
// contact data, and logged.
type Seal func(ctx context.Context, question string) (privacy.Sanitised[string], error)

// Ask answers one question; Timeout zero means AskTimeout. Without Seal nothing leaves.
type Ask struct {
	Model   ToolModel
	Tools   ToolRunner
	Seal    Seal
	Timeout time.Duration
}

// finalAnswer splits the model's last text into the cited answer and its blocks (S3): the blocks
// are checked against the same numbered records, and a bad block is dropped, not an error.
func finalAnswer(text string, sources *domain.Sources) (domain.CitedAnswer, error) {
	text, raw := domain.SplitBlocks(text)
	if text == "" {
		return domain.CitedAnswer{}, fmt.Errorf("%w: empty answer", ErrModel)
	}
	answer, err := domain.Cite(text, sources)
	if err != nil {
		return domain.CitedAnswer{}, err
	}
	answer.Blocks = domain.ResolveBlocks(raw, sources)
	return answer, nil
}

// Answer runs the loop for question and checks the citations of the final answer.
func (a Ask) Answer(ctx context.Context, question string) (domain.CitedAnswer, error) {
	timeout := a.Timeout
	if timeout <= 0 {
		timeout = AskTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	if a.Seal == nil {
		return domain.CitedAnswer{}, privacy.ErrDisabled
	}
	sealed, err := a.Seal(ctx, question)
	if err != nil {
		return domain.CitedAnswer{}, err
	}
	specs := a.Tools.Specs()
	turns := []Turn{{Question: sealed}}
	var sources domain.Sources
	calls := 0
	for {
		step, err := a.Model.Next(ctx, specs, turns)
		if err != nil {
			if ctx.Err() != nil {
				return domain.CitedAnswer{}, ctx.Err()
			}
			// The adapters' errors are fixed texts, safe to log; the operator needs them.
			return domain.CitedAnswer{}, fmt.Errorf("%w: %w", ErrModel, err)
		}
		if len(step.Calls) == 0 {
			return finalAnswer(step.Text, &sources)
		}
		turns = append(turns, Turn{Calls: step.Calls})
		for _, c := range step.Calls {
			if calls == MaxToolCalls {
				return domain.CitedAnswer{}, ErrTooManyToolCalls
			}
			calls++
			out, err := a.Tools.Run(ctx, c.Name, c.Input)
			if err != nil {
				// A driver may answer a cancelled read with its own error: the budget explains it.
				if ctx.Err() != nil {
					return domain.CitedAnswer{}, ctx.Err()
				}
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
