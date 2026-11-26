# VozPilot — Phase 3 · Autonomous Multi-Agent AI Workforce

**VozLook Studios · multi-agent AI workforce platform**

VozPilot puts an autonomous workforce of eight specialized AI agents behind a central orchestrator, **VozCore**.
- **Phase 1** delivered the full-stack application foundation (React 19 + TypeScript + Tailwind v4, Express 5 API, PostgreSQL with Row Level Security, cookie-based JWT auth, and honest zero-fabrication telemetry).
- **Phase 2** added the **VozCore** orchestration engine (Python + FastAPI + 12-node LangGraph workflow with parallel waves, sequential dependencies, retries, checkpoints, and real OpenAI structured outputs).
- **Phase 3** implements all **eight specialized AI agents** as modular, database-backed backend components implementing a unified **Common Agent Interface**, paired with centralized inter-agent messaging, encrypted OAuth 2.0 integrations, an isolated code-execution sandbox, human-in-the-loop approval gates, global emergency workforce pause controls, and live agent testing.

---

## Phase 3 Specialized Agents

| Agent | Core Capabilities & Safety Boundaries |
| --- | --- |
| **Research Agent** (`research`) | Queries configured web search providers (`TAVILY_API_KEY`, `SERPER_API_KEY`, `BRAVE_SEARCH_API_KEY`, or `SEARCH_API_URL`), fetches public pages with SSRF & `<untrusted_external_data>` fencing, separates verified facts from assumptions, flags conflicting claims, strips unverified URLs, and stores cited reports in `research_reports`. |
| **Inbox Agent** (`inbox`) | Connects to Gmail REST API v1 via OAuth 2.0 (`AES-256-GCM` encrypted tokens), reads/searches authorized messages, wraps email bodies against prompt injection, categorizes threads, flags urgent messages, drafts replies/follow-ups, and **holds all outbound sends behind explicit Approval Center authorization**. |
| **Project Agent** (`project`) | Creates and updates projects in `projects` and assigned subtasks in `tasks`, sets priorities/deadlines, tracks milestones, detects overdue/delayed tasks, and produces database-backed progress reports. |
| **Content Agent** (`content`) | Crafts social posts, captions, marketing strategies, content calendars, articles, product copy, ads, and design briefs aligned to **VozLook Studios** or custom brands; persists editable drafts in `content_drafts`; **requires human approval before external publication**. |
| **Finance Agent** (`finance`) | Records user-authorized income/expenses (`financial_transactions`) and category/project budgets (`financial_budgets`) with exact `Decimal` math, detects statistical outliers/duplicate charges/budget overruns, and **strictly refuses to execute real payments, wires, purchases, or investments**. |
| **Schedule Agent** (`schedule`) | Connects to Google Calendar REST API v3 via OAuth 2.0, respects user time zones (`IANA`), detects overlapping event conflicts, computes open focus slots, creates workspace reminders, and **gates external calendar creations/modifications/cancellations behind approval**. |
| **Developer Agent** (`developer`) | Generates and reviews code, debugs issues, writes unit tests and docs, executes Python snippets in a POSIX `RLIMIT_*` + AST-isolated sandbox (no host env secrets, no network/shell modules, strict wall-time & CPU caps), inspects workspace/authorized GitHub repos, and **requires approval before remote pushes**. |
| **Memory Agent** (`memory`) | Stores categorized knowledge in `memories`, deduplicates entries, rejects secrets/API keys automatically, retrieves context via semantic/keyword similarity (`pgvector` when available + JSON embedding fallback), searches past executions, and shares authorized context packets via VozCore. |

---

## Architecture

```
vozpilot/
├── client/          React 19 + TypeScript + Tailwind v4 + Vite (SPA)
│   └── src/
│       ├── layout/Topbar.tsx               Global Pause All / Resume All control + live pulse
│       ├── pages/AgentHubPage.tsx          Workforce telemetry + 9 operational agent cards
│       ├── pages/AgentDetailPage.tsx       6-tab Agent Workspace + Live Test Agent + Draft Studio
│       ├── pages/IntegrationsPage.tsx      Real OAuth 2.0 PKCE flow + scope & encryption status
│       ├── pages/ApprovalCenterPage.tsx    Human-in-the-loop gates for Gmail/Calendar/Content/Repo
│       └── components/execution/           ExecutionPanel (waves · bus messages · artifacts · citations)
├── server/          Express 5 + TypeScript (tsx runtime)
│   └── src/
│       ├── lib/tokenCrypto.ts              Interoperable AES-256-GCM OAuth token encryption
│       ├── modules/                        auth · agents · tasks · approvals · workflows · memories
│       │                                   conversations · integrations (OAuth 2.0 PKCE) · activity
│       │                                   analytics · settings · search · vozcore (reverse proxy)
│       └── db/migrations/                  001_initial_schema · 002_vozcore · 003_phase3_agents
├── vozcore/         Python 3.11 + FastAPI + LangGraph engine
│   ├── vozcore/
│   │   ├── agents/                         base.py + 8 modular specialist agents + registry.py
│   │   ├── security.py                     AES-256-GCM crypto, SSRF guard, prompt-injection fencing
│   │   ├── sandbox.py                      AST + POSIX RLIMIT isolated Python runner & path jail
│   │   ├── external_providers.py           Search, Gmail, Google Calendar & GitHub clients
│   │   ├── communication.py                Centralized agent_messages, logs & usage persistence
│   │   ├── pricing.py                      Per-model token cost calculator
│   │   └── graph/{state,nodes,build}.py    12-node LangGraph workflow + atomic task claim guard
│   └── tests/                              39 automated pytest tests (Phase 2 + Phase 3)
└── scripts/         smoke-test.mjs (129-assertion full-stack acceptance suite)
```

---

## Getting Started

```bash
npm install
npm run vozcore:install     # create vozcore/.venv + install Python deps
cp .env.example .env        # server also provisions a secure local .env if absent

npm run build               # typecheck server + client and build SPA bundle
npm start                   # Node API + built React SPA on http://0.0.0.0:4000
npm run vozcore             # Python VozCore engine on http://127.0.0.1:8001
```

## Verification & Test Suites

```bash
npm run typecheck           # TypeScript strict check across server & client
npm run build               # Full production build
npm run test:smoke          # 129-assertion end-to-end smoke suite (Phase 1 + 2 + 3)
npm run vozcore:test        # 39-test pytest suite (all 8 agents, sandbox, permissions, RLS, bus)
```
