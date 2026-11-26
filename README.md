# VozPilot — Phase 1

**VozLook Studios · multi-agent AI workforce platform foundation**

VozPilot puts a workforce of specialised AI agents behind a single manager, **VozCore**.
Phase 1 delivers the complete application foundation — a production-oriented full-stack
build with premium UI, real PostgreSQL persistence, secure auth and honest data —
while AI orchestration itself connects in **Phase 2**.

---

## What Phase 1 includes

| Area | Delivered |
| --- | --- |
| **Overview** | Real workspace stats (agents, tasks, approvals, honest automation rate), task/agent/activity feeds, quick-command entry — all DB-backed with truthful empty states |
| **AI Command Center** | Conversational UI that persists conversations + messages in PostgreSQL. **No simulated AI replies** — VozCore is explicitly "Phase 2 pending" |
| **Agent Hub** | Nine seeded agent profiles (VozCore + Research, Inbox, Project, Content, Finance, Schedule, Developer, Memory) with icon, status, responsibilities, task counts and config — profiles only, no fake execution |
| **Task Manager** | Full CRUD over PostgreSQL with statuses: Pending, In Progress, Waiting for Approval, Completed, Failed; priority, agent assignment, filters, search |
| **Workflow Manager** | Workflow definitions + ordered steps with honest status — no synthetic run history |
| **Memory Center** | Per-workspace knowledge entries (CRUD + search) |
| **Activity Center** | Append-only log of real events (every row maps to something that actually happened) |
| **Approval Center** | Human-in-the-loop gates: approve/reject pending task requests, full decision history |
| **Integrations** | Gmail, Google Calendar, GitHub, Google Drive, Notion — always honest: rows stay `not_connected` until a real OAuth flow succeeds; credentials live only on the server |
| **Analytics** | Completion rate, throughput, agent workload, distribution — computed from real data, never simulated; empty ranges render honestly |
| **Settings** | Profile, appearance (accent + density), notification preferences, security (password change), agent configuration |

**Engineering:** collapsible sidebar + top navigation (global search, notifications,
agent-activity indicator, profile menu), protected/public routes, loading & empty states
everywhere, responsive down to mobile, API error envelopes, Zod input validation,
cookie-based sessions with hashed passwords, no secrets in the frontend.

---

## Architecture

```
vozpilot/
├── client/          React 19 + TypeScript + Tailwind v4 + Vite (SPA)
│   └── src/         pages · components · context · hooks · layout · lib
├── server/          Express 5 + TypeScript (tsx runtime)
│   └── src/
│       ├── modules/ auth · agents · tasks · approvals · workflows · memories
│       │            conversations · integrations · activity · analytics ·
│       │            settings · search
│       ├── db/      pool · embedded-postgres · migrations · seeders
│       └── middleware/  auth (JWT cookies) · errorHandler
├── scripts/         smoke-test.mjs (98-check acceptance suite)
│                    visual-qa.mjs (headless-Chromium screenshot harness)
└── .env             local secrets (git-ignored) — see .env.example
```

- **Database:** PostgreSQL (embedded zero-config by default; `DATABASE_URL` for an
  external instance). Eleven tables with user-level isolation via **Row Level Security**,
  applied inside each request transaction (`app.user_id`). Migrations are idempotent SQL
  files under `server/src/db/migrations/`, applied automatically at boot.
- **Auth:** register/login/logout + refresh-token rotation; access token 15 min (httpOnly
  cookie, SameSite=Lax), refresh token 7 days (scoped cookie); bcrypt (12 rounds);
  Helmet with a strict CSP; `/api/auth/*` endpoints.
- **API contract:** JSON envelopes `{ data }` / `{ error: { code, message, details } }`,
  Zod validation → 422, constraint violations → 409, unknown → generic 500 (details in
  server log only).

## Getting started

```bash
npm install
cp .env.example .env        # then edit secrets (server/start.ts bootstraps a .env if missing)
npm run dev                 # API :4000 + Vite :5173 (proxies /api)
```

Production preview (single port, serves built client + API):

```bash
npm run build
npm start                   # http://localhost:4000
```

Environment (see `.env.example`): `PORT`, `NODE_ENV`, `JWT_SECRET`,
`REFRESH_TOKEN_SECRET`, `DATABASE_URL` (optional — embedded PostgreSQL is used
otherwise), `EMBEDDED_PG_DIR`, and optional `GOOGLE_CLIENT_ID` / `GITHUB_CLIENT_ID` /
`NOTION_CLIENT_ID` + secrets for future OAuth wiring. **Never commit `.env`.**

## Tests

```bash
npm run typecheck           # client + server (tsc --noEmit)
npm test                    # 98-assertion acceptance suite (needs server running on :4000)
node scripts/visual-qa.mjs  # headless Chromium screenshots into screenshots/
```

The acceptance suite creates its own throwaway account and exercises: registration →
login → deep-link SPA fallback, protected routes, agent seeds + profile updates, task
CRUD + status transitions, the waiting-approval → approve/reject → history loop,
workflows, memories, conversation persistence (**asserts no assistant messages are
fabricated**), honest activity log, integrations honesty, global search, settings +
password change, refresh-token rotation, logout and cross-tenant isolation.

## Phase 2 (not in this build)

VozCore orchestration (real agent execution), workflow run engine, OAuth connection
flows for the five integrations, and AI responses in the Command Center. Every surface
in Phase 1 is designed to light up against these backends without rework — and none of
them pretends to work today.
