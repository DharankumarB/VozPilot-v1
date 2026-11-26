-- ===========================================================================
-- Phase 3 — Autonomous Multi-Agent AI Workforce
--
-- Extends existing tables (users, agents, tasks, memories, integrations,
-- approvals, agent_tasks, agent_results) and creates the Phase 3 agent
-- metadata, communication, telemetry, OAuth state and domain tables.
-- Every tenant table enforces user-level Row Level Security via app.user_id.
-- ===========================================================================

-- Optional pgvector probe: succeeds quietly when the extension is installed on
-- the host (e.g. Supabase / managed PostgreSQL), no-ops cleanly otherwise.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS vector;
EXCEPTION WHEN OTHERS THEN
  NULL;
END
$$;

-- ---------------------------------------------------------------------------
-- 1. Extend users (global Pause All Agents + user timezone)
-- ---------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS agents_paused boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'UTC';

-- ---------------------------------------------------------------------------
-- 2. Extend agents (enable/disable, instructions, live current task, limits)
-- ---------------------------------------------------------------------------
ALTER TABLE agents ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS system_instructions text;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS current_task_id uuid REFERENCES agent_tasks(id) ON DELETE SET NULL;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS timeout_seconds integer NOT NULL DEFAULT 90
  CHECK (timeout_seconds BETWEEN 5 AND 600);
ALTER TABLE agents ADD COLUMN IF NOT EXISTS max_retries integer NOT NULL DEFAULT 2
  CHECK (max_retries BETWEEN 0 AND 5);

-- ---------------------------------------------------------------------------
-- 3. agent_capabilities — explicit per-agent capability catalogue
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_capabilities (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id       uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  agent_key      text NOT NULL,
  capability_key text NOT NULL,
  name           text NOT NULL,
  description    text NOT NULL DEFAULT '',
  enabled        boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_capabilities_unique UNIQUE (agent_id, capability_key)
);
CREATE INDEX IF NOT EXISTS agent_capabilities_user_agent_idx ON agent_capabilities (user_id, agent_id);
DROP TRIGGER IF EXISTS agent_capabilities_set_updated_at ON agent_capabilities;
CREATE TRIGGER agent_capabilities_set_updated_at BEFORE UPDATE ON agent_capabilities
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- 4. agent_tools — modular tools registered per agent
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_tools (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id             uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  agent_key            text NOT NULL,
  tool_key             text NOT NULL,
  name                 text NOT NULL,
  description          text NOT NULL DEFAULT '',
  category             text NOT NULL DEFAULT 'domain',
  requires_approval    boolean NOT NULL DEFAULT false,
  required_integration text,
  enabled              boolean NOT NULL DEFAULT true,
  config               jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_tools_unique UNIQUE (agent_id, tool_key)
);
CREATE INDEX IF NOT EXISTS agent_tools_user_agent_idx ON agent_tools (user_id, agent_id);
DROP TRIGGER IF EXISTS agent_tools_set_updated_at ON agent_tools;
CREATE TRIGGER agent_tools_set_updated_at BEFORE UPDATE ON agent_tools
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- 5. agent_permissions — granular permissions, approvals & rate limits
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_permissions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id            uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  agent_key           text NOT NULL,
  permission_key      text NOT NULL,
  scope               text NOT NULL DEFAULT 'workspace',
  description         text NOT NULL DEFAULT '',
  allowed             boolean NOT NULL DEFAULT true,
  requires_approval   boolean NOT NULL DEFAULT false,
  rate_limit_per_hour integer NOT NULL DEFAULT 60 CHECK (rate_limit_per_hour BETWEEN 1 AND 10000),
  max_tasks_per_run   integer NOT NULL DEFAULT 8 CHECK (max_tasks_per_run BETWEEN 1 AND 50),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_permissions_unique UNIQUE (agent_id, permission_key)
);
CREATE INDEX IF NOT EXISTS agent_permissions_user_agent_idx ON agent_permissions (user_id, agent_id);
DROP TRIGGER IF EXISTS agent_permissions_set_updated_at ON agent_permissions;
CREATE TRIGGER agent_permissions_set_updated_at BEFORE UPDATE ON agent_permissions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- 6. Extend agent_tasks & agent_results for common structured interface
-- ---------------------------------------------------------------------------
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS idempotency_key text;
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS input_payload jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS timeout_seconds integer NOT NULL DEFAULT 90;

CREATE UNIQUE INDEX IF NOT EXISTS agent_tasks_idempotency_idx
  ON agent_tasks (execution_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS agent_tasks_agent_status_idx ON agent_tasks (agent_id, status, created_at DESC);

ALTER TABLE agent_results DROP CONSTRAINT IF EXISTS agent_results_status_check;
ALTER TABLE agent_results ADD CONSTRAINT agent_results_status_check
  CHECK (status IN ('completed', 'failed', 'waiting_approval', 'cancelled'));

ALTER TABLE agent_results ADD COLUMN IF NOT EXISTS artifacts jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE agent_results ADD COLUMN IF NOT EXISTS source_references jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE agent_results ADD COLUMN IF NOT EXISTS error_details jsonb;
ALTER TABLE agent_results ADD COLUMN IF NOT EXISTS duration_ms integer;
ALTER TABLE agent_results ADD COLUMN IF NOT EXISTS estimated_cost_usd numeric(12, 6);

-- ---------------------------------------------------------------------------
-- 7. agent_messages — centralized traceable VozCore <-> agent bus
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_messages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  execution_id  uuid NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  task_id       uuid REFERENCES agent_tasks(id) ON DELETE SET NULL,
  sender_key    text NOT NULL,
  recipient_key text NOT NULL,
  message_type  text NOT NULL
                  CHECK (message_type IN (
                    'task_assignment',
                    'context_share',
                    'tool_call',
                    'tool_result',
                    'result_report',
                    'approval_request',
                    'retry_notice',
                    'cancellation',
                    'error'
                  )),
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  authorized    boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_messages_execution_idx ON agent_messages (execution_id, created_at);
CREATE INDEX IF NOT EXISTS agent_messages_user_agent_idx ON agent_messages (user_id, sender_key, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_messages_recipient_idx ON agent_messages (user_id, recipient_key, created_at DESC);

-- ---------------------------------------------------------------------------
-- 8. agent_execution_logs — operational & security audit logs per agent
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_execution_logs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  execution_id  uuid REFERENCES executions(id) ON DELETE CASCADE,
  agent_task_id uuid REFERENCES agent_tasks(id) ON DELETE SET NULL,
  agent_id      uuid REFERENCES agents(id) ON DELETE SET NULL,
  agent_key     text NOT NULL,
  level         text NOT NULL DEFAULT 'info'
                  CHECK (level IN ('info', 'warn', 'error', 'security')),
  event         text NOT NULL,
  message       text NOT NULL,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  status        text,
  duration_ms   integer,
  retry_attempt integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_exec_logs_user_agent_idx
  ON agent_execution_logs (user_id, agent_key, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_exec_logs_execution_idx
  ON agent_execution_logs (execution_id, created_at);

-- ---------------------------------------------------------------------------
-- 9. agent_usage — per-agent token usage, duration & estimated model cost
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_usage (
  id                 bigserial PRIMARY KEY,
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  execution_id       uuid REFERENCES executions(id) ON DELETE SET NULL,
  agent_task_id      uuid REFERENCES agent_tasks(id) ON DELETE SET NULL,
  agent_id           uuid REFERENCES agents(id) ON DELETE SET NULL,
  agent_key          text NOT NULL,
  model              text NOT NULL,
  prompt_tokens      integer NOT NULL DEFAULT 0,
  completion_tokens  integer NOT NULL DEFAULT 0,
  total_tokens       integer NOT NULL DEFAULT 0,
  duration_ms        integer NOT NULL DEFAULT 0,
  estimated_cost_usd numeric(12, 6),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_usage_user_agent_idx ON agent_usage (user_id, agent_key, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_usage_execution_idx ON agent_usage (execution_id);

-- ---------------------------------------------------------------------------
-- 10. Extend integrations + oauth_states + approvals
-- ---------------------------------------------------------------------------
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS encrypted_access_token text;
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS encrypted_refresh_token text;
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS token_expires_at timestamptz;
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS provider_metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS oauth_states (
  state         text PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider      text NOT NULL,
  redirect_uri  text NOT NULL,
  scopes        jsonb NOT NULL DEFAULT '[]'::jsonb,
  code_verifier text,
  expires_at    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS oauth_states_user_idx ON oauth_states (user_id, expires_at);

ALTER TABLE approvals ADD COLUMN IF NOT EXISTS execution_id uuid REFERENCES executions(id) ON DELETE SET NULL;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS agent_task_id uuid REFERENCES agent_tasks(id) ON DELETE SET NULL;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS action_type text;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS action_payload jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS executed_at timestamptz;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS execution_result jsonb;

-- ---------------------------------------------------------------------------
-- 11. Domain persistence tables for the specialized agents
-- ---------------------------------------------------------------------------

-- Research Agent: stored structured research reports with preserved citations
CREATE TABLE IF NOT EXISTS research_reports (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  execution_id     uuid REFERENCES executions(id) ON DELETE SET NULL,
  agent_task_id    uuid REFERENCES agent_tasks(id) ON DELETE SET NULL,
  query            text NOT NULL,
  title            text NOT NULL,
  summary          text NOT NULL DEFAULT '',
  key_findings     jsonb NOT NULL DEFAULT '[]'::jsonb,
  facts            jsonb NOT NULL DEFAULT '[]'::jsonb,
  assumptions      jsonb NOT NULL DEFAULT '[]'::jsonb,
  sources          jsonb NOT NULL DEFAULT '[]'::jsonb,
  conflicts        jsonb NOT NULL DEFAULT '[]'::jsonb,
  unverified_items jsonb NOT NULL DEFAULT '[]'::jsonb,
  report_markdown  text NOT NULL DEFAULT '',
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS research_reports_user_idx ON research_reports (user_id, created_at DESC);

-- Project Agent: projects + milestones linked to existing `tasks`
CREATE TABLE IF NOT EXISTS projects (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  status      text NOT NULL DEFAULT 'active'
                CHECK (status IN ('planning', 'active', 'on_hold', 'completed', 'archived')),
  priority    text NOT NULL DEFAULT 'medium'
                CHECK (priority IN ('low', 'medium', 'high', 'critical')),
  due_date    date,
  milestones  jsonb NOT NULL DEFAULT '[]'::jsonb,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS projects_user_idx ON projects (user_id, created_at DESC);
DROP TRIGGER IF EXISTS projects_set_updated_at ON projects;
CREATE TRIGGER projects_set_updated_at BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES projects(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS tasks_project_idx ON tasks (project_id) WHERE project_id IS NOT NULL;

-- Content Agent: editable content drafts (never published without approval)
CREATE TABLE IF NOT EXISTS content_drafts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  execution_id   uuid REFERENCES executions(id) ON DELETE SET NULL,
  agent_task_id  uuid REFERENCES agent_tasks(id) ON DELETE SET NULL,
  content_type   text NOT NULL DEFAULT 'article',
  brand_identity text NOT NULL DEFAULT 'VozLook Studios',
  channel        text NOT NULL DEFAULT 'general',
  title          text NOT NULL,
  body           text NOT NULL DEFAULT '',
  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,
  status         text NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft', 'in_review', 'approved', 'published')),
  approval_id    uuid REFERENCES approvals(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS content_drafts_user_idx ON content_drafts (user_id, updated_at DESC);
DROP TRIGGER IF EXISTS content_drafts_set_updated_at ON content_drafts;
CREATE TRIGGER content_drafts_set_updated_at BEFORE UPDATE ON content_drafts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Finance Agent: authorized ledger entries & budgets (never fabricated)
CREATE TABLE IF NOT EXISTS financial_transactions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id   uuid REFERENCES projects(id) ON DELETE SET NULL,
  entry_type   text NOT NULL CHECK (entry_type IN ('income', 'expense')),
  amount       numeric(14, 2) NOT NULL CHECK (amount >= 0),
  currency     text NOT NULL DEFAULT 'USD',
  category     text NOT NULL DEFAULT 'general',
  counterparty text NOT NULL DEFAULT '',
  description  text NOT NULL DEFAULT '',
  occurred_on  date NOT NULL DEFAULT CURRENT_DATE,
  source       text NOT NULL DEFAULT 'authorized_manual',
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fin_tx_user_date_idx ON financial_transactions (user_id, occurred_on DESC);
CREATE INDEX IF NOT EXISTS fin_tx_user_cat_idx ON financial_transactions (user_id, category);

CREATE TABLE IF NOT EXISTS financial_budgets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id   uuid REFERENCES projects(id) ON DELETE SET NULL,
  name         text NOT NULL,
  category     text NOT NULL DEFAULT 'general',
  period       text NOT NULL DEFAULT 'monthly' CHECK (period IN ('weekly', 'monthly', 'quarterly', 'annual', 'project')),
  limit_amount numeric(14, 2) NOT NULL CHECK (limit_amount >= 0),
  currency     text NOT NULL DEFAULT 'USD',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fin_budgets_user_idx ON financial_budgets (user_id, category);
DROP TRIGGER IF EXISTS fin_budgets_set_updated_at ON financial_budgets;
CREATE TRIGGER fin_budgets_set_updated_at BEFORE UPDATE ON financial_budgets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Memory Agent: project scoping + semantic embedding vector storage
ALTER TABLE memories ADD COLUMN IF NOT EXISTS project_name text;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS source_execution_id uuid REFERENCES executions(id) ON DELETE SET NULL;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding_json jsonb;
CREATE INDEX IF NOT EXISTS memories_project_idx ON memories (user_id, project_name) WHERE project_name IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Row Level Security — enforce user_id = current_user_id() on every new table
-- ---------------------------------------------------------------------------
ALTER TABLE agent_capabilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_tools ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_execution_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE research_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_budgets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_capabilities_own ON agent_capabilities;
CREATE POLICY agent_capabilities_own ON agent_capabilities FOR ALL TO PUBLIC
  USING (user_id = current_user_id()) WITH CHECK (user_id = current_user_id());

DROP POLICY IF EXISTS agent_tools_own ON agent_tools;
CREATE POLICY agent_tools_own ON agent_tools FOR ALL TO PUBLIC
  USING (user_id = current_user_id()) WITH CHECK (user_id = current_user_id());

DROP POLICY IF EXISTS agent_permissions_own ON agent_permissions;
CREATE POLICY agent_permissions_own ON agent_permissions FOR ALL TO PUBLIC
  USING (user_id = current_user_id()) WITH CHECK (user_id = current_user_id());

DROP POLICY IF EXISTS agent_messages_own ON agent_messages;
CREATE POLICY agent_messages_own ON agent_messages FOR ALL TO PUBLIC
  USING (user_id = current_user_id()) WITH CHECK (user_id = current_user_id());

DROP POLICY IF EXISTS agent_execution_logs_own ON agent_execution_logs;
CREATE POLICY agent_execution_logs_own ON agent_execution_logs FOR ALL TO PUBLIC
  USING (user_id = current_user_id()) WITH CHECK (user_id = current_user_id());

DROP POLICY IF EXISTS agent_usage_own ON agent_usage;
CREATE POLICY agent_usage_own ON agent_usage FOR ALL TO PUBLIC
  USING (user_id = current_user_id()) WITH CHECK (user_id = current_user_id());

DROP POLICY IF EXISTS oauth_states_own ON oauth_states;
CREATE POLICY oauth_states_own ON oauth_states FOR ALL TO PUBLIC
  USING (user_id = current_user_id()) WITH CHECK (user_id = current_user_id());

DROP POLICY IF EXISTS research_reports_own ON research_reports;
CREATE POLICY research_reports_own ON research_reports FOR ALL TO PUBLIC
  USING (user_id = current_user_id()) WITH CHECK (user_id = current_user_id());

DROP POLICY IF EXISTS projects_own ON projects;
CREATE POLICY projects_own ON projects FOR ALL TO PUBLIC
  USING (user_id = current_user_id()) WITH CHECK (user_id = current_user_id());

DROP POLICY IF EXISTS content_drafts_own ON content_drafts;
CREATE POLICY content_drafts_own ON content_drafts FOR ALL TO PUBLIC
  USING (user_id = current_user_id()) WITH CHECK (user_id = current_user_id());

DROP POLICY IF EXISTS financial_transactions_own ON financial_transactions;
CREATE POLICY financial_transactions_own ON financial_transactions FOR ALL TO PUBLIC
  USING (user_id = current_user_id()) WITH CHECK (user_id = current_user_id());

DROP POLICY IF EXISTS financial_budgets_own ON financial_budgets;
CREATE POLICY financial_budgets_own ON financial_budgets FOR ALL TO PUBLIC
  USING (user_id = current_user_id()) WITH CHECK (user_id = current_user_id());
