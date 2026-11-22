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

// Ask is the analyst behind the Inicio box (odd/archive/agentic-analyst.md S2): a bounded loop in
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
	// Proposal is the id of a proposal the call filed, pending a person's decision in Bandeja.
	Proposal string
}

// PendingProposalsError is a question that failed after it filed proposals: they stay pending in
// Bandeja (a person approves or rejects them as always), and the person asking must be told so.
type PendingProposalsError struct {
	Count int
	Err   error
}

func (e *PendingProposalsError) Error() string {
	return fmt.Sprintf("%v (after filing %d proposals)", e.Err, e.Count)
}

func (e *PendingProposalsError) Unwrap() error { return e.Err }

// ToolTurn is a tool's answer as the model sees it, with the numbers of its records.
type ToolTurn struct {
	Call    ToolCall
	Output  ToolOutput
	Sources []domain.Cited
}

// Turn is one entry of the conversation of a question: an earlier question and answer, the
// question, the model's calls, or a tool's answer. Exactly one is set; the question is the person's text as the egress guard
// released it, so an adapter cannot receive it raw.
type Turn struct {
	Question privacy.Sanitised[string]
	Earlier  *EarlierTurn
	Calls    []ToolCall
	Result   *ToolTurn
}

// Step is the model's next move: tool calls, or (with no calls) its final answer. Model and Usage
// say which model answered and what the call cost; an adapter returns them with its error too,
// since a refused or cut answer is billed as well.
type Step struct {
	Text  string
	Calls []ToolCall
	Model string
	Usage Usage
}

// Usage counts the tokens of model calls, as Claude reports them: Input is what was read
// uncached, CacheCreation what was written to the prompt cache, CacheRead what was read from it.
type Usage struct {
	Input         int
	Output        int
	CacheCreation int
	CacheRead     int
}

// Plus is u and o added up.
func (u Usage) Plus(o Usage) Usage {
	return Usage{
		Input: u.Input + o.Input, Output: u.Output + o.Output,
		CacheCreation: u.CacheCreation + o.CacheCreation, CacheRead: u.CacheRead + o.CacheRead,
	}
}

// AskReport is what one question cost, for the operator: counts only, never its texts.
type AskReport struct {
	// Model is the model that answered the last call, empty when no call answered.
	Model string
	// Turns counts the model calls, ToolCalls the tool calls of the loop.
	Turns     int
	ToolCalls int
	Usage     Usage
	Duration  time.Duration
	// OK says the question ended in a cited answer.
	OK bool
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

// Seal releases the person's texts through the egress guard in one release: scrubbed of known
// names and contact data, and logged once. texts[0] is the question, then each earlier question
// and answer in order; the result has one sealed text per text, in the same order.
type Seal func(ctx context.Context, texts []string) ([]privacy.Sanitised[string], error)

// Ask answers one question; Timeout zero means AskTimeout. Without Seal nothing leaves.
type Ask struct {
	Model   ToolModel
	Tools   ToolRunner
	Seal    Seal
	Timeout time.Duration
	// Report hears once what each question that reached the model cost; nil reports nothing.
	Report func(ctx context.Context, report AskReport)
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

// Progress hears the loop as it works (odd/tasks/chat-first-ui.md T10): ToolStep runs once per
// tool call, before the tool, with the call's fixed label (domain.ToolStepLabel). It never gets the
// call's input or the tool's result, which may name people.
type Progress interface {
	ToolStep(label string)
}

// Answer runs the loop for question and checks the citations of the final answer.
func (a Ask) Answer(ctx context.Context, question string) (domain.CitedAnswer, error) {
	return a.AnswerWithProgress(ctx, question, nil)
}

// AnswerWithProgress is Answer that reports each tool call to progress; nil reports nothing. The
// loop stops as soon as ctx ends: no model or tool call starts after a cancel.
func (a Ask) AnswerWithProgress(ctx context.Context, question string, progress Progress) (domain.CitedAnswer, error) {
	return a.AnswerFollowUp(ctx, question, nil, progress)
}

// AnswerFollowUp is AnswerWithProgress after the earlier turns of history, which the model sees
// before the question. They are context only: citations still number only this question's tool
// results, so a record named in the history must be fetched again to be cited.
func (a Ask) AnswerFollowUp(ctx context.Context, question string, history []Exchange, progress Progress) (domain.CitedAnswer, error) {
	filed := 0
	answer, err := a.answer(ctx, question, history, progress, &filed)
	if err != nil && filed > 0 {
		return domain.CitedAnswer{}, &PendingProposalsError{Count: filed, Err: err}
	}
	return answer, err
}

func (a Ask) answer(ctx context.Context, question string, history []Exchange, progress Progress, filed *int) (domain.CitedAnswer, error) {
	if err := CheckHistory(history); err != nil {
		return domain.CitedAnswer{}, err
	}
	timeout := a.Timeout
	if timeout <= 0 {
		timeout = AskTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	if a.Seal == nil {
		return domain.CitedAnswer{}, privacy.ErrDisabled
	}
	sealed, err := a.Seal(ctx, historyTexts(question, history))
	if err != nil {
		return domain.CitedAnswer{}, err
	}
	if len(sealed) != 1+2*len(history) {
		return domain.CitedAnswer{}, fmt.Errorf("analyst: seal returned %d texts for %d", len(sealed), 1+2*len(history))
	}
	report := AskReport{}
	if a.Report != nil {
		start := time.Now()
		defer func() {
			report.Duration = time.Since(start)
			a.Report(context.WithoutCancel(ctx), report)
		}()
	}
	answer, err := a.loop(ctx, sealed, history, progress, filed, &report)
	report.OK = err == nil
	return answer, err
}

// loop runs the model and the tools until a final answer, counting what it spends in report.
func (a Ask) loop(ctx context.Context, sealed []privacy.Sanitised[string], history []Exchange, progress Progress, filed *int, report *AskReport) (domain.CitedAnswer, error) {
	specs := a.Tools.Specs()
	turns := make([]Turn, 0, len(history)+1)
	for i := range history {
		turns = append(turns, Turn{Earlier: &EarlierTurn{Question: sealed[1+2*i], Answer: sealed[2+2*i]}})
	}
	turns = append(turns, Turn{Question: sealed[0]})
	var sources domain.Sources
	calls := 0
	for {
		if err := ctx.Err(); err != nil {
			return domain.CitedAnswer{}, err
		}
		step, err := a.Model.Next(ctx, specs, turns)
		report.Turns++
		report.Usage = report.Usage.Plus(step.Usage)
		if step.Model != "" {
			report.Model = step.Model
		}
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
			if err := ctx.Err(); err != nil {
				return domain.CitedAnswer{}, err
			}
			calls++
			report.ToolCalls = calls
			if progress != nil {
				progress.ToolStep(domain.ToolStepLabel(c.Name))
			}
			out, err := a.Tools.Run(ctx, c.Name, c.Input)
			if err != nil {
				// A driver may answer a cancelled read with its own error: the budget explains it.
				if ctx.Err() != nil {
					return domain.CitedAnswer{}, ctx.Err()
				}
				return domain.CitedAnswer{}, err
			}
			if out.Proposal != "" {
				*filed++
			}
			numbered := make([]domain.Cited, 0, len(out.Records))
			for _, ref := range out.Records {
				numbered = append(numbered, domain.Cited{N: sources.Add(ref), RecordRef: ref})
			}
			turns = append(turns, Turn{Result: &ToolTurn{Call: c, Output: out, Sources: numbered}})
		}
	}
}
