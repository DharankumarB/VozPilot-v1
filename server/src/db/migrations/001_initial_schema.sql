-- ===========================================================================
-- VozPilot — initial schema (Phase 1)
-- All tenant tables carry `user_id` and row-level security policies so data
-- is isolated per user at the database layer (defense in depth on top of the
-- user-id filters every query already applies).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Shared helper: current tenant from the transaction-local `app.user_id`
-- setting (set by the application via set_config(..., true)).
-- Fails closed: NULL when unset → policies deny access.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION current_user_id() RETURNS uuid
LANGUAGE sql STABLE
AS $$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  password_hash text NOT NULL,
  name          text NOT NULL,
  role          text NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'admin', 'member')),
  preferences   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (lower(email));
DROP TRIGGER IF EXISTS users_set_updated_at ON users;
CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- agents — profile records for the AI workforce (no execution history yet)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key             text NOT NULL,
  name            text NOT NULL,
  description     text NOT NULL DEFAULT '',
  icon            text NOT NULL DEFAULT 'bot',
  status          text NOT NULL DEFAULT 'idle' CHECK (status IN ('active', 'idle', 'paused', 'error')),
  responsibilities jsonb NOT NULL DEFAULT '[]'::jsonb,
  config          jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_active_at  timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agents_user_key_unique UNIQUE (user_id, key)
);
CREATE INDEX IF NOT EXISTS agents_user_idx ON agents (user_id);
DROP TRIGGER IF EXISTS agents_set_updated_at ON agents;
CREATE TRIGGER agents_set_updated_at BEFORE UPDATE ON agents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- tasks
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tasks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id     uuid REFERENCES agents(id) ON DELETE SET NULL,
  title        text NOT NULL,
  description  text NOT NULL DEFAULT '',
  status       text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'in_progress', 'waiting_approval', 'completed', 'failed')),
  priority     text NOT NULL DEFAULT 'medium'
                 CHECK (priority IN ('low', 'medium', 'high', 'critical')),
  due_date     date,
  completed_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tasks_user_created_idx ON tasks (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS tasks_user_status_idx ON tasks (user_id, status);
CREATE INDEX IF NOT EXISTS tasks_user_due_idx ON tasks (user_id, due_date);
CREATE INDEX IF NOT EXISTS tasks_user_agent_idx ON tasks (user_id, agent_id);
DROP TRIGGER IF EXISTS tasks_set_updated_at ON tasks;
CREATE TRIGGER tasks_set_updated_at BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- workflows + workflow_steps
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workflows (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workflows_user_idx ON workflows (user_id, created_at DESC);
DROP TRIGGER IF EXISTS workflows_set_updated_at ON workflows;
CREATE TRIGGER workflows_set_updated_at BEFORE UPDATE ON workflows
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS workflow_steps (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  position    integer NOT NULL DEFAULT 0,
  config      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workflow_steps_order_idx ON workflow_steps (workflow_id, position);
CREATE INDEX IF NOT EXISTS workflow_steps_user_idx ON workflow_steps (user_id);
DROP TRIGGER IF EXISTS workflow_steps_set_updated_at ON workflow_steps;
CREATE TRIGGER workflow_steps_set_updated_at BEFORE UPDATE ON workflow_steps
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- memories — searchable long-term knowledge
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memories (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category   text NOT NULL DEFAULT 'general',
  title      text NOT NULL,
  content    text NOT NULL DEFAULT '',
  tags       jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS memories_user_idx ON memories (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS memories_user_category_idx ON memories (user_id, category);
DROP TRIGGER IF EXISTS memories_set_updated_at ON memories;
CREATE TRIGGER memories_set_updated_at BEFORE UPDATE ON memories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- conversations + messages (AI Command Center)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      text NOT NULL DEFAULT 'New conversation',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conversations_user_idx ON conversations (user_id, updated_at DESC);
DROP TRIGGER IF EXISTS conversations_set_updated_at ON conversations;
CREATE TRIGGER conversations_set_updated_at BEFORE UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content         text NOT NULL,
  attachments     jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS messages_user_idx ON messages (user_id);

-- ---------------------------------------------------------------------------
-- approvals — human-in-the-loop gates linked to tasks
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS approvals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id         uuid REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id        uuid REFERENCES agents(id) ON DELETE SET NULL,
  title           text NOT NULL,
  description     text NOT NULL DEFAULT '',
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'approved', 'rejected', 'dismissed')),
  resolution_note text,
  requested_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS approvals_user_status_idx ON approvals (user_id, status);
CREATE INDEX IF NOT EXISTS approvals_user_requested_idx ON approvals (user_id, requested_at DESC);
DROP TRIGGER IF EXISTS approvals_set_updated_at ON approvals;
CREATE TRIGGER approvals_set_updated_at BEFORE UPDATE ON approvals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- integrations — honest OAuth connection state per provider
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS integrations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider      text NOT NULL CHECK (provider IN ('gmail', 'google_calendar', 'github', 'google_drive', 'notion')),
  status        text NOT NULL DEFAULT 'not_connected'
                  CHECK (status IN ('not_connected', 'connected', 'error')),
  account_email text,
  scopes        jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_error    text,
  connected_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT integrations_user_provider_unique UNIQUE (user_id, provider)
);
CREATE INDEX IF NOT EXISTS integrations_user_idx ON integrations (user_id);
DROP TRIGGER IF EXISTS integrations_set_updated_at ON integrations;
CREATE TRIGGER integrations_set_updated_at BEFORE UPDATE ON integrations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- activity_logs — append-only record of real system events only
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS activity_logs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id   uuid REFERENCES agents(id) ON DELETE SET NULL,
  task_id    uuid REFERENCES tasks(id) ON DELETE SET NULL,
  type       text NOT NULL,
  category   text NOT NULL DEFAULT 'system'
               CHECK (category IN ('task', 'agent', 'workflow', 'memory', 'approval', 'integration', 'conversation', 'auth', 'settings', 'system')),
  title      text NOT NULL,
  detail     text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS activity_user_created_idx ON activity_logs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS activity_user_category_idx ON activity_logs (user_id, category, created_at DESC);
CREATE INDEX IF NOT EXISTS activity_user_agent_idx ON activity_logs (user_id, agent_id);

-- ---------------------------------------------------------------------------
-- Row-level security — one policy per tenant table.
-- The application sets `app.user_id` per transaction; when it is absent the
-- policies deny all access (fail closed). The app connects as a non-owner
-- role in embedded mode, so PostgreSQL enforces these policies itself.
-- ---------------------------------------------------------------------------
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS users_own ON users;
CREATE POLICY users_own ON users FOR ALL TO PUBLIC
  USING (id = current_user_id()) WITH CHECK (id = current_user_id());

DROP POLICY IF EXISTS agents_own ON agents;
CREATE POLICY agents_own ON agents FOR ALL TO PUBLIC
  USING (user_id = current_user_id()) WITH CHECK (user_id = current_user_id());

DROP POLICY IF EXISTS tasks_own ON tasks;
CREATE POLICY tasks_own ON tasks FOR ALL TO PUBLIC
  USING (user_id = current_user_id()) WITH CHECK (user_id = current_user_id());

DROP POLICY IF EXISTS workflows_own ON workflows;
CREATE POLICY workflows_own ON workflows FOR ALL TO PUBLIC
  USING (user_id = current_user_id()) WITH CHECK (user_id = current_user_id());

DROP POLICY IF EXISTS workflow_steps_own ON workflow_steps;
CREATE POLICY workflow_steps_own ON workflow_steps FOR ALL TO PUBLIC
  USING (user_id = current_user_id()) WITH CHECK (user_id = current_user_id());

DROP POLICY IF EXISTS memories_own ON memories;
CREATE POLICY memories_own ON memories FOR ALL TO PUBLIC
  USING (user_id = current_user_id()) WITH CHECK (user_id = current_user_id());

DROP POLICY IF EXISTS conversations_own ON conversations;
CREATE POLICY conversations_own ON conversations FOR ALL TO PUBLIC
  USING (user_id = current_user_id()) WITH CHECK (user_id = current_user_id());

DROP POLICY IF EXISTS messages_own ON messages;
CREATE POLICY messages_own ON messages FOR ALL TO PUBLIC
  USING (user_id = current_user_id()) WITH CHECK (user_id = current_user_id());

DROP POLICY IF EXISTS approvals_own ON approvals;
CREATE POLICY approvals_own ON approvals FOR ALL TO PUBLIC
  USING (user_id = current_user_id()) WITH CHECK (user_id = current_user_id());

DROP POLICY IF EXISTS integrations_own ON integrations;
CREATE POLICY integrations_own ON integrations FOR ALL TO PUBLIC
  USING (user_id = current_user_id()) WITH CHECK (user_id = current_user_id());

DROP POLICY IF EXISTS activity_logs_own ON activity_logs;
CREATE POLICY activity_logs_own ON activity_logs FOR ALL TO PUBLIC
  USING (user_id = current_user_id()) WITH CHECK (user_id = current_user_id());
