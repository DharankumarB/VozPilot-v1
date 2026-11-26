# VozPilot — Phase 2 · VozCore orchestration

**VozLook Studios · multi-agent AI workforce platform**

VozPilot puts a workforce of specialised AI agents behind a single manager, **VozCore**.
Phase 1 delivered the complete application foundation (full-stack build, premium UI,
PostgreSQL persistence, secure auth, honest data). Phase 2 adds the **VozCore AI brain**:
a real LangGraph orchestration engine that turns natural-language commands into plans,
delegates them to the eight specialist agents, tracks every step, and returns a
consolidated report — with real OpenAI calls only, never simulated intelligence.

---

## What Phase 2 includes

| Area | Delivered |
| --- | --- |
| **AI Command Center (live)** | Real command submission → VozCore engine: intent analysis (objectives, constraints, deadlines, clarification questions), memory retrieval, structured plan preview, agent selection, dispatch, evaluation, consolidated final response. Conversation history, plan preview, selected agents, live status, activity timeline, task dependency visualization, agent outputs, error surfacing, cancel control — the assistant reply is written by a real execution |
| **VozCore engine** | Python + FastAPI + LangGraph service with **exactly 12 nodes** (`receive_command → understand_intent → retrieve_memory → create_plan → select_agents → dispatch_tasks → execute_agents → collect_results → evaluate_results → retry_or_reassign → generate_final_response → save_execution_memory`), conditional routing, parallel waves for independent tasks, dependency-ordered sequential tasks, bounded retries (2 attempts) and timeouts (90 s/task, 420 s/execution), persisted execution state, safe resume of interrupted runs |
| **Agent delegation** | The eight specialists (research, inbox, project, content, finance, schedule, developer, memory) execute only their own task with minimal context; VozCore coordinates, evaluates, retries or reassigns — never does their work. Structured agent↔manager messages (status, result summary, detailed output, errors, timestamps) stored per task/attempt |
| **Safety** | Server-side API keys only, authenticated endpoints, per-user isolation (RLS), approval checkpoints for sensitive external actions (a task can hold at `waiting` until approved), user cancellation at safe points, detailed activity/event logs, task limits — no external action without authorization |
| **Memory integration** | Prior project context retrieved into planning prompts; durable results saved to the Memory Center only for successful, non-sensitive executions (user-isolated, categorized, tagged) |
| **Honesty** | Missing credentials → clear `vozcore_not_configured` configuration error (never a fake plan or reply); model failures → failed execution with the real error; test transport (`VOZCORE_TEST_FAKE_LLM`) is refused when `NODE_ENV=production` and loudly labelled everywhere |

Phase 1 surfaces (Overview, Agent Hub, Task Manager, Workflow Manager, Memory Center,
Activity Center, Approval Center, Integrations, Analytics, Settings) remain unchanged and
continue to run on the Node API.

---

## Architecture

```
vozpilot/
├── client/          React 19 + TypeScript + Tailwind v4 + Vite (SPA)
│   └── src/
│       ├── lib/vozcore.ts                  VozCore client (types + endpoints)
│       └── components/execution/           ExecutionPanel (plan · waves · timeline · results)
├── server/          Express 5 + TypeScript (tsx runtime)
│   └── src/
│       ├── modules/ auth · agents · tasks · approvals · workflows · memories
│       │            conversations · integrations · activity · analytics ·
│       │            settings · search
│       │            vozcore/  → authenticated reverse proxy to the engine
│       ├── db/      pool · embedded-postgres · migrations (001, 002) · seeders
│       └── middleware/  auth (JWT cookies) · errorHandler
├── vozcore/         Python engine (Phase 2)
│   ├── vozcore/     config · auth · llm · planning · store · service · api
│   │                graph/{state,nodes,build}.py   the 12-node LangGraph workflow
│   │                agents_registry.py · schemas.py · errors.py · db.py
│   └── tests/       22-test orchestration suite (pytest) + live OpenAI test
├── scripts/         smoke-test.mjs (110-check acceptance suite)
│                    visual-qa.mjs · visual-qa-vozcore.mjs (screenshot harnesses)
└── .env             local secrets (git-ignored) — see .env.example
```

- **Database:** PostgreSQL (embedded zero-config by default; `DATABASE_URL` for an
  external instance). Phase 2 adds `executions`, `execution_steps`, `agent_tasks`,
  `agent_results`, `execution_events`, `model_usage` (+ `messages.execution_id`), all
  with user-level **Row Level Security**. Migrations are idempotent SQL files applied at
  boot; the app role receives table **and sequence** grants on every start.
- **Auth contract:** the Node proxy authenticates the request and forwards the session
  to the engine (`Cookie` + `x-vozpilot-user`); the engine verifies the same JWT secret.
- **API contract:** all success bodies are `{ data }`, errors `{ error: { code, message,
  details } }` — the VozCore endpoints follow the same envelope.
- **LLM:** OpenAI API key read **only** from server-side env (`OPENAI_API_KEY`,
  `OPENAI_MODEL`, optional `OPENAI_BASE_URL`); structured outputs for intent/plan/agent
  results/evaluation/final response via `chat.completions.parse`; usage recorded in
  `model_usage`; rate-limit/error handling with bounded retries.

### VozCore endpoints (authenticated, proxied at `/api/vozcore/*`)

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/vozcore/command` | Accept a command → start a real execution (returns `{ execution }`) |
| POST | `/api/vozcore/plan` | Plan preview only — no execution persisted |
| GET | `/api/vozcore/executions` | List the user's executions (optional `?conversationId=`) |
| GET | `/api/vozcore/executions/{id}` | Full detail: execution, steps, tasks, results, events (`?sinceEventId=` for polling) |
| POST | `/api/vozcore/executions/{id}/cancel` | Request cancellation (idempotent) |
| GET | `/api/vozcore/agents` | Coordinator + 8 specialists with capabilities and honest operational state |
| GET | `/api/vozcore/health` | Engine status, LLM mode, 12-node graph, limits |

## Getting started

```bash
npm install
npm run vozcore:install     # create vozcore/.venv + install Python deps
cp .env.example .env        # then edit secrets (server bootstraps a .env if missing)
# set OPENAI_API_KEY=... in .env — the engine refuses to fake results without it

npm run dev                 # API :4000 + Vite :5173 (proxies /api)
npm run vozcore             # start the VozCore engine on :8001 (separate terminal)
```

Production preview (single port, serves built client + API; start the engine alongside):

```bash
npm run build
npm start                   # http://localhost:4000
npm run vozcore             # engine :8001 — without a key it reports
                            # vozcore_not_configured instead of pretending
```

Environment (see `.env.example`): `PORT`, `NODE_ENV`, `JWT_SECRET`,
`REFRESH_TOKEN_SECRET`, `DATABASE_URL` (optional — embedded PostgreSQL otherwise),
`VOZCORE_PORT`, `OPENAI_API_KEY`, `OPENAI_MODEL`, optional `OPENAI_BASE_URL` and
`VOZCORE_MAX_TASKS` / `VOZCORE_MAX_TASK_ATTEMPTS` / `VOZCORE_TASK_TIMEOUT` /
`VOZCORE_EXECUTION_TIMEOUT`. **Never commit `.env`**; keys never reach the browser.

## Tests

```bash
npm run typecheck           # client + server (tsc --noEmit)
npm test                    # 110-assertion acceptance suite (server + engine running)
npm run vozcore:test        # 22-test orchestration suite (pytest, real schema + graph)
npm run vozcore:test:live   # live OpenAI round-trip (requires OPENAI_API_KEY)
node scripts/visual-qa.mjs           # Phase 1 screenshots
node scripts/visual-qa-vozcore.mjs   # end-to-end execution screenshots (test transport)
```

The acceptance suite covers registration/login/deep links, agent seeds, task CRUD +
approval loop, workflows, memories, conversation persistence (**asserts no assistant
messages are fabricated without an engine run**), activity log, integrations honesty,
search, settings, refresh rotation, logout, cross-tenant isolation — plus the VozCore
surface: health envelope, 12-node graph, auth (401), the8-agent catalogue, honest
503 `vozcore_not_configured` without credentials, 422 validation, execution listing.

The pytest suite covers: single-agent, multi-agent parallel, sequential dependencies,
clarification, plan preview (no side effects), approval checkpoints, missing
credentials, model-failure honesty, retry then success, retry exhaustion, cancellation
mid-flight, unauthorized access, user isolation, memory retrieval/save/sensitive-skip.
`test_live_openai.py` verifies real OpenAI connectivity when a key is present
(`-m live`); in environments without outbound access to `api.openai.com` it is skipped
and the configuration/error paths are what's verified.

## Phase 3 (not in this build)

Workflow run engine, OAuth connection flows for the five integrations, and any
functionality beyond this phase's scope. Surfaces that depend on them say so honestly
and light up against these backends without rework.
