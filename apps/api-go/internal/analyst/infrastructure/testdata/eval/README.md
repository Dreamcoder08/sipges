# Analyst eval set (offline)

Each JSON file is one case for the Inicio analyst's tool loop. `TestEvalSet` in
`../../eval_test.go` replays the case's recorded Claude answers through the real loop
(`application.Ask` over the `Claude` adapter) against a fake HTTP server, then grades the outcome.
It never calls a model, in tests or in CI.

## What it measures

The pipeline, not the model. The answers are written by hand, so the set checks how SIPGES handles
them:

- **Citation integrity.** An answer may cite only records the tools returned. A marker naming
  another number is rejected, and so is an answer that read records but cites none.
- **Reply handling.** Refusals, `max_tokens` cuts, paused turns, blank answers, text written next
  to tool calls, malformed tool input, unknown tools and blocks sections each end in a fixed error
  or a safe answer.
- **The conversation sent back.** Every earlier assistant turn goes back unchanged, thinking blocks
  included. Each tool call gets its tool result, and the system prompt and the end of the
  conversation carry cache breakpoints.
- **Token accounting.** One report per question, with the usage of every recorded answer summed.

It does not measure answer quality, tone or whether the model would choose these tools.

## A case

```json
{
  "description": "What the case shows, in one sentence.",
  "records": [{ "module": "conflictos", "id": "CF-0101", "title": "…", "text": "…" }],
  "question": "¿…?",
  "turns": [{ "…": "one Messages API response per model call, in order" }],
  "expect": { "cited": ["conflictos/CF-0101"] }
}
```

- `records` is the synthetic project. `search_records` finds the records whose title or text
  contains `query` (case-insensitive). `get_record` reads one by `module` and `id`. Any other
  tool is refused as unknown.
- `turns` are full response bodies as the API returns them, with `id`, `model`, `content`
  (`thinking`, `redacted_thinking`, `text`, `tool_use`), `stop_reason` and `usage`. The loop must
  make exactly one request per turn.
- `expect` holds either `cited` or `error`:
  - `cited` lists the records the answer must cite (`module/id`, in marker order). An empty list
    means an answer that cites nothing.
  - `error` is `unresolved_citation`, `uncited`, `too_many_tool_calls` or `model`. For `model`,
    `cause` is a substring of the adapter's fixed text: `declined`, `truncated`, `paused` or
    `empty answer`.
  - Optional: `tools_run` counts the calls that reached the tools (a malformed call never does),
    and `blocks` counts the blocks kept from a blocks section.

## Adding a case

1. Copy the closest file and rename it after the behaviour it shows (`snake_case.json`).
2. Use synthetic records only, never real names, places or data.
3. Write each turn as the API would answer. Use `tool_use` ids unique within the case, and
   `usage` with all four counts.
4. Run `go test ./internal/analyst/infrastructure -run TestEvalSet` from `apps/api-go`.
