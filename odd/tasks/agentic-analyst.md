# Agentic analyst in Inicio

Turn the Inicio box into an analyst that answers with citations by calling SIPGES's own MCP tools,
renders existing components in its answers, and writes only through human-approved proposals.
Builds on odd/tasks/model-agnostic-analyst.md (provider-neutral narrator).

## Specs

- S1 — Owner question: «tengo una duda y si sipges se hace todo desde el chat de ia asi como lo hace claude , chat gpt , deepseek harnes , gentle-shell y mas softwarts agenticos de vanguardia de esta semana , mes año , 2026 ??». Accepted proposal: chat as the entry layer, screens remain the source of truth; owner: «perfect te autorizo todo y avanza mi objetivo es estar en la vanguardia».
- S2 — Layer 2, answers: the Inicio box sends the question to the analyst, which runs a bounded tool loop (at most 6 tool calls, 30 s) over the read tools the MCP server already exposes (`search_records`, `get_record`, `get_links`, `get_timeline`, `get_briefing`, `list_object_types`), through the same use cases, session, role and RLS as the screens (no new data path, no logic of its own). Every factual sentence cites a record `[n]` that the answer lists with a link to its screen; markers that do not resolve to a record returned by a tool are rejected. Tool results pass the egress guard before reaching an external model. Without a configured provider the box stays a search box and says so.
- S3 — Layer 3, generative UI: the answer may include typed blocks rendered by existing components (record card, alert card, map focus on a record, timeline excerpt); the model never emits HTML. Unknown block types are dropped.
- S4 — Layer 4, writes as proposals: the analyst can propose `create_record` and `link_records`; proposals appear in Bandeja using the existing analyst proposal store and decision flow (`analyst/domain/proposals.ts`), and nothing is written until a person with the right role approves. Decisions are audited as today.
- S5 — Conversation memory: none in this feature (each question is independent). A stored conversation history would be a separate, owner-approved feature (privacy: questions may contain personal data).

## Tasks

- T1 — S2: tool-loop port in the analyst context, adapters for Anthropic tool use and OpenAI-compatible tool calls, citation check, Inicio wiring; TS first, Go parity after. Route: worker after model-agnostic-analyst merges. Commit: pending.
- T2 — S3: typed answer blocks and their renderers. Route: worker. Commit: pending.
- T3 — S4: proposals from the analyst into Bandeja. Route: worker. Commit: pending.
- T4 — S1–S5: independent verification (Risk items 2 and 3: egress, permissions, writes). Route: gentle-ai-verify. Commit: n/a.

## Log

- L1 — Owner question and approval quoted in S1 (2026-11-07). The parent's analysis: SIPGES already exposes an MCP server with 8 tools (6 read, `create_record`, `link_records`), so external harnesses (Claude, ChatGPT, Codex, Gentle Shell) can already operate it with an MCP key; this feature brings the same capability into Inicio.
