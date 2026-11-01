# Workspace architecture: five destinations and one Integrations page

SIPGES exposes 26 screens over a small set of concepts (most are views of `module_records`). Rebuild the
information architecture around five destinations plus one extensions page, and move analysis that is
procedure, not data integrity, from hand-built screens to skills over the existing MCP server.

## Specs

- S1 — «hay algo que no entiendo [screenshot of Claude's Customize page: Skills, Connectors, Plugins] me encatan el diseño ui & Ux mas que todo la experiencia de usuario buena y limpia , ordenada moderna de claude , mi objetivo es eliminar la redundancia y si algo se puede automatizar hagamoslo skill , connector , olugin y mas para no estar escribiendo modulos y mas modulos , cuestiona con informacion actualizada de esta semana , mes de octubre 2026 y compara con la competencia , y los mejores del mundo»
- S2 — «perfecto te autorizo y haslo quiero estar en la vanguardia», in reply to the proposal recorded in L2.
- S3 — Five destinations replace the 26 screens in navigation: **Inicio** (Dashboard, Centro gerencial, briefing), **Registros** (Eventos, Actores, Directorio territorial, Demandas, Narrativas, Fuentes, Buzón as one list filtered by type), **Territorio** (Mapa territorial, Ubicación geoespacial, Cronología as views), **Bandeja** (Alertas, Validación, Calidad de datos, Situaciones: everything awaiting a decision), **Análisis** (IRSA-SIPGES, Análisis situacional, Inteligencia estratégica, Lecciones). Every current capability stays reachable; no data or permission changes.
- S4 — One **Integraciones** page (not three tabs) with filters: Conectores (inbound sources: media RSS, Defensoría, GEOCATMIN; outbound: MCP for Claude, webhooks, push), Skills (analysis recipes run over records), Programadas (existing automations). Cards show type and a Verified/Custom-style trust label.
- S5 — «Preguntale a SIPGES»: natural-language questions over the active project's records, answered with citations to records, built on the existing `get_briefing`/analyst pieces.
- S6 — Integrity rules stay in the core, never in a skill: tenant isolation, audit, four-eyes approval, A–E verification.
- S7 — Before real AMSAC data is sent to an external model (MCP connector or skills), the owner records a data-processing decision under Peru's Ley 29733 (consent, scope, anonymisation). Synthetic data only until then.

## Tasks

- T1 — S1–S5: design `design/workspace-architecture/` (directions for Inicio, the unified Registros list, Bandeja, and the Integraciones page), owner picks. Route: delegated design worker. Commit: pending.
- T2 — S3: navigation and routes for the five destinations, old routes redirect. Route: after T1 choice. Commit: pending.
- T3 — S3: unified Registros list (type filter, same record forms). Commit: pending.
- T4 — S3: Bandeja (one decision inbox). Commit: pending.
- T5 — S3: Territorio and Análisis as tabbed views. Commit: pending.
- T6 — S4: Integraciones page over existing sources, MCP keys, webhooks and automations. Commit: pending.
- T7 — S5, S6: Preguntale a SIPGES with citations, synthetic data only. Commit: pending.
- T8 — S7: data-processing decision for real data with external models. Route: owner decision (blocked). Commit: n/a.

## Log

- L1 — S1 verbatim. Research (2026-11-01): Anthropic began merging Skills, Connectors and Plugins into one «Plugins» page on 2026-10-29 (GA 2026-11-09; Enterprise 2026-11-30), source superpowerdaily.com 2026-10-28; connector = access (MCP), skill = procedure, plugin = distribution (HubSpot 2026-10-14). Claude's sidebar: five destinations plus Pinned and Recents. Competitors Borealis, Darzin, Simply Stakeholders (CPO Club 2026-10-22): few sections, AI on top (Borealis «Ask AI» with cited answers, AI report drafts, Power BI API; Darzin/Simply Outlook and Gmail plugins, sentiment). SIPGES already ships an MCP server (`/mcp`: create_record, get_briefing, get_links, get_record, get_timeline, link_records, list_object_types, search_records), ingest webhooks, automations, RSS/Defensoría sources and an analyst.
- L2 — Proposal accepted with S2: five destinations (S3), one Integraciones page (S4), Preguntale a SIPGES (S5), with the pushback that integrity stays in the core (S6), privacy before real data (S7), and SIPGES must work fully without Claude. The compact sidebar (odd/tasks/compact-sidebar.md) is the first step and stays.
- L3 — T1 design written to `design/workspace-architecture/` (manifest `design.json`, `feature` linked): artboards `01-inicio-composer.html` (Inicio with «Preguntale a SIPGES» composer, cited answer state, briefing), `03-registros-unificado.html` (one list with type chips, saved views, A–E and validation filters, record sheet with links and audit trail, former modules shown as filters), `04-bandeja.html` (one decision inbox, J/K/Enter/A/R, four-eyes state and approver rule) and `05-integraciones.html` (one page with Todos/Conectores/Skills/Programadas chips, Tuyos/Descubrir, trust labels, status, detail state, S7 synthetic-data warning on Claude vía MCP). All use the sidebar from `compact-sidebar/01-collapsible-focus.html` extended per S3 (five destinations, Integraciones, Fijados/Recientes, project switcher, Ctrl K, notifications and account in the sidebar; top bar only title and page actions). Scope cut at the owner's request: the alternative home `02-inicio-triage` (Linear-style Bandeja-first) was not drawn, so Inicio has one direction only and the owner's pick for Inicio is between 01 and a later 02 if wanted. Owner picks next; T2–T7 stay pending.
