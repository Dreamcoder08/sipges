# ADR 0013 — Cited analyst briefings

- Status: Accepted
- Date: 2026-10-14
- Task: `odd/archive/ontology-intelligence-platform.md` T9

## Context

Analysts open a record's 360° view and need, in seconds, what the record is, who and what it is
connected to, what happened when, and what needs attention. Vendor platforms answer with an
"AI assistant", but a free-form model can invent actors, dates or sources, and sending
territorial data to an external service is a decision for the data owner, not a default.

## Decision

1. **Extractive first.** `GET /system/briefing?module=&id=` builds a deterministic briefing from
   the record and its visible neighbours (explicit and inferred links, ADR 0011): summary fields,
   link counts by type, the most relevant neighbours, a dated timeline and attention signals
   (open high-level alerts, overdue open commitments, high-priority open demands, opposed actors,
   recorded conflicts, links to restricted records). Every sentence carries numbered citations
   to the records it comes from; the same data yields the same text.
2. **Row-level security still decides.** The briefing reads through the Ontology service inside
   the tenant transaction, so a `consulta` user never sees, counts or cites restricted records
   (ADR 0012).
3. **Optional narration behind a port.** A `Narrator` may rewrite the extractive text as prose.
   The Claude adapter is enabled only with `SIPGES_ANALYST_PROVIDER=anthropic` and
   `ANTHROPIC_API_KEY` (read by the SDK from the environment; never stored or logged); the model
   defaults to `claude-opus-5-5` (`SIPGES_ANALYST_MODEL`) at low effort with server-side refusal
   fallbacks.
4. **What the model sees.** Only the briefing text, rebuilt without restricted neighbours; a
   restricted subject is never narrated. The prompt marks the text as material, not
   instructions.
5. **Citations are checked.** A narrative must cite at least one source and only sources that
   exist; its markers are renumbered onto the reader's briefing. Errors, refusals, truncation,
   a 20 s timeout or invalid citations fall back to the extractive briefing with a notice.
6. **On demand.** The web panel generates the briefing only when asked and labels narrated text
   as model-assisted.

## Consequences

- Without configuration SIPGES makes no external calls and still provides a useful briefing.
- Enabling narration sends non-restricted record text to Anthropic; deployment docs flag it as
  needing the data owner's approval.
- Signals are heuristics over free-form fields (`Estado`, `Nivel_Preliminar`, `Plazo`, …); they
  point to records for review and never change data.

## Addendum — provider choice (model-agnostic narrator)

Task: `odd/tasks/model-agnostic-analyst.md`. The owner asked for the Inicio analyst to work with
models other than Claude (Codex, DeepSeek and more), so the `Narrator` port gets a second
adapter, `SIPGES_ANALYST_PROVIDER=openai-compatible`. It speaks the OpenAI Chat Completions
protocol (`POST {base}/v1/chat/completions`, or `/chat/completions` when the base URL already
ends in `/v1`), which OpenAI, DeepSeek, Ollama, OpenRouter, Groq and vLLM share.

- **Variables.** `SIPGES_ANALYST_BASE_URL` (required; `https`, or `http` on a loopback host),
  `SIPGES_ANALYST_API_KEY` (required unless the host is loopback; sent as a bearer token) and
  `SIPGES_ANALYST_MODEL` (required; no default, ids of 1–128 characters from
  `A-Z a-z 0-9 . _ : / -`).
- **Same behaviour.** The same system prompt (one shared module), the same `<informe>` wrapping,
  `max_tokens` 4000, one retry and the 20 s budget. `finish_reason` `length` fails as truncated,
  `content_filter` as declined, and empty text fails; the citation check of decision 5 runs on
  its output unchanged.
- **Same egress rules.** The adapter only receives what the guard of ADR 0030 cleared and only
  contacts the configured base URL: redirects fail the call. Errors are fixed texts, so the key,
  the URL and the briefing never reach a log.
- **Why one adapter and no SDK.** One small `fetch` call covers every provider that matters
  here. A general SDK such as the Vercel AI SDK or LangChain would add a dependency tree, its
  own retry, telemetry and redirect behaviour on a path that carries territorial data, and a
  release cadence to track, for a single non-streaming request. Providers that do not speak
  this protocol can still get their own adapter behind the same port.
- **Data.** Pointing this at a real provider sends non-restricted briefing text outside the
  platform; that stays the data owner's decision
  (`odd/tasks/functional-closure.md` T5), exactly as with Anthropic.

## Addendum — proposals from the Inicio analyst (agentic analyst S4)

Task: `odd/tasks/agentic-analyst.md` T3. The Inicio analyst may now propose writes, never make
them. Decision 8 kept open proposals computed, not stored; a proposal a model made cannot be
recomputed, so these are the one exception.

- **Two tools, no writes.** The tool loop offers `propose_record` and `propose_link` beside the
  read tools; their descriptions are all the model learns about them. Calling one checks the
  proposal with the rules of the real write (record id and project rules of records, link rules
  of the ontology) and the role gate of that write for the person asking, then stores it as
  pending and answers only its id. The tools hold no path to the record or link stores.
- **Storage.** `analyst_proposals` (migration 0033) is insert-only, per tenant, under forced
  row-level security. A proposal is pending while `proposal_decisions` has no row with the
  fingerprint `stored:<id>`; deciding it is the existing decision flow: the same actions, the
  same decision row and the same `REVIEW` audit entry, so a proposal is decided at most once.
- **Who decides.** `GET /system/analyst/proposals` lists the project's pending proposals (Bandeja,
  `sipgesctl analyst proposals`); `POST /system/analyst/proposals` approves or discards one
  (`sipgesctl analyst decide`). Only a role that passes the role gate of the proposal's own write
  (`POST /api/<module>` or `POST /system/links`) may decide; others get 403 and nothing is written.
- **Untrusted text.** Everything in a proposal came from a model: keys, values, ids and the reason
  are bounded in the domain and again by column checks, values are text only, and the screens
  render them as plain text.
- **Concurrent decisions.** Within one API process the decisions of one stored proposal run one at
  a time and each re-reads the proposal first, so two simultaneous approvals write once. Across
  several API processes the limit of computed proposals remains: both may run the action before
  one decision row wins, and the second is told the proposal was already decided.
