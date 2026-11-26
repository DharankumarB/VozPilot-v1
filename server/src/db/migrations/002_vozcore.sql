-- ---------------------------------------------------------------------------
-- Phase 2 — VozCore orchestration state
--
-- conversations / messages already exist (Phase 1) and stay the conversation
-- record; this migration adds the execution lifecycle tables only. Every table
-- carries user_id + RLS so executions are isolated exactly like Phase 1 data.
-- ---------------------------------------------------------------------------

-- executions — one row per VozCore command run
CREATE TABLE IF NOT EXISTS executions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id   uuid REFERENCES conversations(id) ON DELETE SET NULL,
  source_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  command           text NOT NULL,
  status            text NOT NULL DEFAULT 'planning'
                      CHECK (status IN ('planning', 'running', 'waiting', 'completed', 'failed', 'cancelled')),
  intent            jsonb,
  plan              jsonb,
  clarification     text,
  final_response    text,
  error             text,
  cancel_requested  boolean NOT NULL DEFAULT false,
  event_seq         integer NOT NULL DEFAULT 0,
  state_checkpoint  jsonb,
  started_at        timestamptz,
  finished_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS executions_user_created_idx ON executions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS executions_user_status_idx ON executions (user_id, status);
CREATE INDEX IF NOT EXISTS executions_conversation_idx ON executions (conversation_id, created_at);
DROP TRIGGER IF EXISTS executions_set_updated_at ON executions;
CREATE TRIGGER executions_set_updated_at BEFORE UPDATE ON executions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- execution_steps — LangGraph node invocations (the12 workflow nodes)
CREATE TABLE IF NOT EXISTS execution_steps (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id uuid NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  step_key     text NOT NULL,
  seq          integer NOT NULL,
  status       text NOT NULL DEFAULT 'running'
                 CHECK (status IN ('running', 'completed', 'failed', 'skipped')),
  input        jsonb,
  output       jsonb,
  error        text,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (execution_id, step_key, seq)
);
CREATE INDEX IF NOT EXISTS execution_steps_execution_idx ON execution_steps (execution_id, seq);
CREATE INDEX IF NOT EXISTS execution_steps_user_idx ON execution_steps (user_id);

-- agent_tasks — planned subtasks delegated by VozCore to specialist agents
CREATE TABLE IF NOT EXISTS agent_tasks (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id      uuid NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_key          text NOT NULL,
  agent_key         text NOT NULL,
  agent_id          uuid REFERENCES agents(id) ON DELETE SET NULL,
  title             text NOT NULL,
  description       text NOT NULL DEFAULT '',
  context           jsonb NOT NULL DEFAULT '{}'::jsonb,
  depends_on        jsonb NOT NULL DEFAULT '[]'::jsonb,
  wave              integer NOT NULL DEFAULT 0,
  priority          integer NOT NULL DEFAULT 5,
  approval_required boolean NOT NULL DEFAULT false,
  status            text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'running', 'waiting', 'completed', 'failed', 'cancelled')),
  attempts          integer NOT NULL DEFAULT 0,
  max_attempts      integer NOT NULL DEFAULT 2,
  error             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  started_at        timestamptz,
  finished_at       timestamptz,
  UNIQUE (execution_id, task_key)
);
CREATE INDEX IF NOT EXISTS agent_tasks_execution_idx ON agent_tasks (execution_id, wave, priority);
CREATE INDEX IF NOT EXISTS agent_tasks_user_idx ON agent_tasks (user_id, status);
DROP TRIGGER IF EXISTS agent_tasks_set_updated_at ON agent_tasks;
CREATE TRIGGER agent_tasks_set_updated_at BEFORE UPDATE ON agent_tasks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- agent_results — structured agent → manager responses (attempt history kept)
CREATE TABLE IF NOT EXISTS agent_results (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id       uuid NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_task_id      uuid NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  attempt            integer NOT NULL DEFAULT 1,
  agent_key          text NOT NULL,
  status             text NOT NULL CHECK (status IN ('completed', 'failed')),
  result_summary     text NOT NULL DEFAULT '',
  detailed_output    text NOT NULL DEFAULT '',
  missing_information jsonb NOT NULL DEFAULT '[]'::jsonb,
  errors             jsonb NOT NULL DEFAULT '[]'::jsonb,
  model              text,
  prompt_tokens      integer NOT NULL DEFAULT 0,
  completion_tokens  integer NOT NULL DEFAULT 0,
  started_at         timestamptz NOT NULL DEFAULT now(),
  finished_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_results_task_idx ON agent_results (agent_task_id, attempt);
CREATE INDEX IF NOT EXISTS agent_results_execution_idx ON agent_results (execution_id, created_at);
CREATE INDEX IF NOT EXISTS agent_results_user_idx ON agent_results (user_id);

-- execution_events — live timeline feed (polled by the Command Center)
CREATE TABLE IF NOT EXISTS execution_events (
  id            bigserial PRIMARY KEY,
  execution_id  uuid NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type          text NOT NULL,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS execution_events_execution_idx ON execution_events (execution_id, id);
CREATE INDEX IF NOT EXISTS execution_events_user_idx ON execution_events (user_id);

-- model_usage — token/cost accounting for every VozCore model call
CREATE TABLE IF NOT EXISTS model_usage (
  id                bigserial PRIMARY KEY,
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  execution_id      uuid REFERENCES executions(id) ON DELETE SET NULL,
  purpose           text NOT NULL,
  model             text NOT NULL,
  prompt_tokens     integer NOT NULL DEFAULT 0,
  completion_tokens integer NOT NULL DEFAULT 0,
  total_tokens      integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS model_usage_user_created_idx ON model_usage (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS model_usage_execution_idx ON model_usage (execution_id);

-- Link assistant messages back to the execution that produced them
ALTER TABLE messages ADD COLUMN IF NOT EXISTS execution_id uuid REFERENCES executions(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS messages_execution_idx ON messages (execution_id) WHERE execution_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Row level security — same pattern as Phase 1
-- ---------------------------------------------------------------------------
ALTER TABLE executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE execution_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE execution_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_usage ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS executions_own ON executions;
CREATE POLICY executions_own ON executions FOR ALL TO PUBLIC
  USING (user_id = current_user_id()) WITH CHECK (user_id = current_user_id());

DROP POLICY IF EXISTS execution_steps_own ON execution_steps;
CREATE POLICY execution_steps_own ON execution_steps FOR ALL TO PUBLIC
  USING (user_id = current_user_id()) WITH CHECK (user_id = current_user_id());

DROP POLICY IF EXISTS agent_tasks_own ON agent_tasks;
CREATE POLICY agent_tasks_own ON agent_tasks FOR ALL TO PUBLIC
  USING (user_id = current_user_id()) WITH CHECK (user_id = current_user_id());

DROP POLICY IF EXISTS agent_results_own ON agent_results;
CREATE POLICY agent_results_own ON agent_results FOR ALL TO PUBLIC
  USING (user_id = current_user_id()) WITH CHECK (user_id = current_user_id());

DROP POLICY IF EXISTS execution_events_own ON execution_events;
CREATE POLICY execution_events_own ON execution_events FOR ALL TO PUBLIC
  USING (user_id = current_user_id()) WITH CHECK (user_id = current_user_id());

DROP POLICY IF EXISTS model_usage_own ON model_usage;
CREATE POLICY model_usage_own ON model_usage FOR ALL TO PUBLIC
  USING (user_id = current_user_id()) WITH CHECK (user_id = current_user_id());
