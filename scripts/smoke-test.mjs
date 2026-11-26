/**
 * VozPilot end-to-end smoke test (Phase 1 acceptance).
 *
 * Run with the server + built client available:
 *   npm run test:smoke            (expects http://127.0.0.1:4000)
 *   BASE_URL=http://host:port npm run test:smoke
 *
 * Covers: routes, auth lifecycle, DB connectivity, task CRUD, approval flow,
 * agent management, workflows, memories, conversations (no fake AI replies),
 * activity, overview analytics, search, settings, integrations honesty,
 * validation errors and SPA serving.
 */

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:4000';
const stamp = Date.now().toString(36);
const EMAIL = `smoke-${stamp}@vozpilot.test`;
const PASSWORD = 'SmokeTest!2026';

let passed = 0;
let failed = 0;
const failures = [];

function ok(condition, label, extra = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    failures.push(label);
    console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`);
  }
}

function section(title) {
  console.log(`\n■ ${title}`);
}

/** Minimal cookie-jar HTTP client (Node fetch stores no cookies). */
class Session {
  constructor() {
    this.cookies = new Map();
  }

  cookieHeader() {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  capture(response) {
    const setCookies =
      typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    for (const raw of setCookies) {
      const [pair] = raw.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (!value || value === 'deleted') this.cookies.delete(name);
      else this.cookies.set(name, decodeURIComponent(value));
    }
  }

  async request(method, path, body) {
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(this.cookies.size ? { cookie: this.cookieHeader() } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    this.capture(response);
    const json = await response.json().catch(() => null);
    return { status: response.status, json, headers: response.headers };
  }

  get(path) {
    return this.request('GET', path);
  }
  post(path, body = {}) {
    return this.request('POST', path, body);
  }
  patch(path, body = {}) {
    return this.request('PATCH', path, body);
  }
  del(path) {
    return this.request('DELETE', path);
  }
}

function dataOf(result) {
  return result.json?.data;
}

async function main() {
  console.log(`VozPilot smoke test → ${BASE}`);
  const anon = new Session();

  /* ------------------------------------------------------------------ health */
  section('Health & static routes');
  const health = await anon.get('/api/health');
  ok(health.status === 200 && dataOf(health)?.status === 'ok', 'GET /api/health responds ok');

  const spa = await fetch(`${BASE}/tasks`);
  const spaHtml = await spa.text();
  ok(spa.status === 200 && spaHtml.includes('<div id="root">'), 'SPA route /tasks serves index.html');

  const spaDeep = await fetch(`${BASE}/agents/anything`);
  ok((await spaDeep.text()).includes('<div id="root">'), 'Deep link /agents/:id serves index.html');

  const missingApi = await anon.get('/api/definitely-not-a-route');
  ok(missingApi.status === 404 && missingApi.json?.error?.code === 'not_found', 'Unknown API route → JSON 404');

  /* -------------------------------------------------------------------- auth */
  section('Authentication');
  const protectedNoCookie = await anon.get('/api/tasks');
  ok(protectedNoCookie.status === 401, 'Protected route without session → 401');

  const reg = await anon.post('/api/auth/register', {
    name: 'Smoke Owner',
    email: EMAIL,
    password: PASSWORD,
  });
  ok(reg.status === 201 && dataOf(reg)?.user?.email === EMAIL, 'Register creates account + session');

  const me = await anon.get('/api/auth/me');
  ok(me.status === 200 && dataOf(me)?.user?.name === 'Smoke Owner', 'GET /auth/me returns profile');

  const dup = await new Session().post('/api/auth/register', {
    name: 'Smoke Owner',
    email: EMAIL.toUpperCase(),
    password: PASSWORD,
  });
  ok(dup.status === 409, 'Duplicate email → 409');

  const badLogin = await new Session().post('/api/auth/login', { email: EMAIL, password: 'wrong-pass' });
  ok(badLogin.status === 401 && badLogin.json?.error?.code === 'invalid_credentials', 'Wrong password → 401 invalid_credentials');

  const badValidation = await new Session().post('/api/auth/register', { name: 'X', email: 'nope', password: 'short' });
  ok(badValidation.status === 422 && badValidation.json?.error?.code === 'validation_error', 'Invalid registration payload → 422 validation_error');

  /* ----------------------------------------------------------------- agents */
  section('Agent Hub');
  const agentsRes = await anon.get('/api/agents');
  const agents = dataOf(agentsRes) ?? [];
  ok(agentsRes.status === 200 && agents.length === 9, `Seeded 9 agents (got ${agents.length})`);
  ok(agents[0]?.key === 'vozcore', 'VozCore listed first');
  const agentKeys = new Set(agents.map((a) => a.key));
  ok(
    ['research', 'inbox', 'project', 'content', 'finance', 'schedule', 'developer', 'memory'].every((k) => agentKeys.has(k)),
    'All eight specialist agents present',
  );
  ok(agents.every((a) => a.responsibilities.length > 0), 'Each agent has responsibilities');

  const research = agents.find((a) => a.key === 'research');
  const agentPatch = await anon.patch(`/api/agents/${research.id}`, {
    status: 'active',
    description: 'Focused research configuration (smoke test).',
  });
  ok(agentPatch.status === 200 && dataOf(agentPatch)?.status === 'active', 'Agent status updated');
  ok(dataOf(agentPatch)?.lastActiveAt !== null, 'Activation records lastActiveAt');

  const agentReload = await anon.get(`/api/agents/${research.id}`);
  ok(dataOf(agentReload)?.description.startsWith('Focused research'), 'Agent description persisted');

  const badAgent = await anon.patch('/api/agents/00000000-0000-0000-0000-000000000000', { status: 'idle' });
  ok(badAgent.status === 404, 'Unknown agent → 404');

  /* ------------------------------------------------------------------ tasks */
  section('Task Manager');
  const task1 = await anon.post('/api/tasks', {
    title: 'Draft launch brief',
    description: 'Cover positioning and timeline.',
    priority: 'high',
    dueDate: '2026-12-05',
    agentId: research.id,
  });
  ok(task1.status === 201, 'Task created');
  const taskId = dataOf(task1)?.id;
  ok(typeof taskId === 'string', 'Task has id');
  ok(dataOf(task1)?.dueDate === '2026-12-05', `dueDate serialised as YYYY-MM-DD (got ${dataOf(task1)?.dueDate})`);
  ok(dataOf(task1)?.agentName === 'Research Agent', 'Task joined to agent name');

  const noTitle = await anon.post('/api/tasks', { description: 'missing title' });
  ok(noTitle.status === 422, 'Task without title → 422');

  const badAgentId = await anon.post('/api/tasks', {
    title: 'x',
    agentId: '00000000-0000-0000-0000-000000000000',
  });
  ok(badAgentId.status === 400, 'Task with unknown agent → 400');

  const task2 = await anon.post('/api/tasks', { title: 'Audit inbox rules', priority: 'low' });
  const task2Id = dataOf(task2)?.id;

  const listAll = await anon.get('/api/tasks');
  ok(dataOf(listAll)?.tasks?.length === 2 && dataOf(listAll)?.counts?.all === 2, 'Task list + counts correct');

  const listFiltered = await anon.get('/api/tasks?status=pending&priority=high');
  ok(dataOf(listFiltered)?.tasks?.length === 1, 'Status + priority filters work');

  const listSearch = await anon.get('/api/tasks?q=inbox');
  ok(dataOf(listSearch)?.tasks?.[0]?.id === task2Id, 'Search filter works');

  const update = await anon.patch(`/api/tasks/${taskId}`, { status: 'in_progress' });
  ok(update.status === 200 && dataOf(update)?.status === 'in_progress', 'Task status → In Progress');

  /* -------------------------------------------------------------- approvals */
  section('Approval Center');
  const toApproval = await anon.patch(`/api/tasks/${taskId}`, { status: 'waiting_approval' });
  ok(toApproval.status === 200, 'Task → Waiting for Approval');

  const pendingRes = await anon.get('/api/approvals?status=pending');
  const pending = dataOf(pendingRes) ?? [];
  ok(pending.length === 1, 'Pending approval auto-created');
  ok(pending[0]?.taskTitle === 'Draft launch brief', 'Approval linked to task');

  const notifications = await anon.get('/api/activity/notifications');
  ok(dataOf(notifications)?.unreadCount >= 1, 'Notifications include the pending approval');

  const approvalId = pending[0]?.id;
  const approve = await anon.post(`/api/approvals/${approvalId}/resolve`, {
    decision: 'approve',
    note: 'Looks good.',
  });
  ok(approve.status === 200 && dataOf(approve)?.status === 'approved', 'Approval resolved');

  const approvedTask = await anon.get(`/api/tasks?q=Draft%20launch%20brief`);
  ok(dataOf(approvedTask)?.tasks?.[0]?.status === 'in_progress', 'Approved task moved to In Progress');

  const doubleResolve = await anon.post(`/api/approvals/${approvalId}/resolve`, { decision: 'reject' });
  ok(doubleResolve.status === 409, 'Double resolution → 409');

  const history = await anon.get('/api/approvals?status=resolved');
  ok(dataOf(history)?.length === 1, 'Approval history retains the decision');

  // reject flow on task2
  await anon.patch(`/api/tasks/${task2Id}`, { status: 'waiting_approval' });
  const pending2 = dataOf(await anon.get('/api/approvals?status=pending')) ?? [];
  ok(pending2.length === 1, 'Second approval created');
  const reject = await anon.post(`/api/approvals/${pending2[0].id}/resolve`, {
    decision: 'reject',
    note: 'Not yet.',
  });
  ok(reject.status === 200 && dataOf(reject)?.status === 'rejected', 'Rejection recorded');
  const rejectedTask = dataOf(await anon.get('/api/tasks?q=Audit'))?.tasks?.[0];
  ok(rejectedTask?.status === 'pending', 'Rejected task returns to Pending');

  // completion → success rate no longer null
  const complete = await anon.patch(`/api/tasks/${taskId}`, { status: 'completed' });
  ok(complete.status === 200 && dataOf(complete)?.completedAt !== null, 'Completion stamps completedAt');

  /* -------------------------------------------------------------- workflows */
  section('Workflow Manager');
  const wf = await anon.post('/api/workflows', {
    name: 'Weekly client report',
    description: 'Collect → draft → review → send.',
    status: 'draft',
    steps: [
      { name: 'Collect metrics', description: 'Pull task and approval stats', position: 0 },
      { name: 'Draft summary', description: 'Write the narrative', position: 1 },
      { name: 'Human review', description: 'Owner reviews before sending', position: 2 },
    ],
  });
  ok(wf.status === 201 && dataOf(wf)?.steps?.length === 3, 'Workflow + 3 steps created');
  const wfId = dataOf(wf)?.id;
  ok(Array.isArray(dataOf(wf)?.executions) && dataOf(wf)?.executions.length === 0, 'Executions honestly empty');

  const wfUpdate = await anon.patch(`/api/workflows/${wfId}`, {
    status: 'active',
    steps: [
      { name: 'Collect metrics (updated)', description: '', position: 0 },
      { name: 'Draft summary', description: '', position: 1 },
    ],
  });
  ok(wfUpdate.status === 200 && dataOf(wfUpdate)?.steps?.length === 2 && dataOf(wfUpdate)?.status === 'active', 'Workflow steps replaced + status active');

  /* --------------------------------------------------------------- memories */
  section('Memory Center');
  const mem = await anon.post('/api/memories', {
    title: 'Pricing decision',
    category: 'decisions',
    content: 'We ship transparent tiered pricing at launch.',
    tags: ['pricing', 'launch'],
  });
  ok(mem.status === 201, 'Memory stored');
  const memId = dataOf(mem)?.id;

  const memSearch = await anon.get('/api/memories?q=pricing');
  ok(dataOf(memSearch)?.memories?.length === 1, 'Memory search finds content');
  ok(dataOf(memSearch)?.categories?.includes('decisions'), 'Category list derived from data');

  const memUpdate = await anon.patch(`/api/memories/${memId}`, { title: 'Pricing decision (final)' });
  ok(memUpdate.status === 200 && dataOf(memUpdate)?.title.endsWith('(final)'), 'Memory updated');

  /* ---------------------------------------------------- conversations / AI */
  section('AI Command Center (Phase 1 boundary)');
  const conv = await anon.post('/api/conversations', {});
  ok(conv.status === 201, 'Conversation created');
  const convId = dataOf(conv)?.id;

  const msg = await anon.post(`/api/conversations/${convId}/messages`, {
    content: 'Prepare a risk summary for the launch.',
    attachmentTaskIds: [task2Id],
  });
  ok(msg.status === 201 && dataOf(msg)?.message?.role === 'user', 'User message persisted');
  ok(dataOf(msg)?.message?.attachments?.length === 1, 'Task attachment stored with message');
  ok(dataOf(msg)?.conversation?.title.startsWith('Prepare a risk'), 'Conversation auto-titled from first message');

  const thread = await anon.get(`/api/conversations/${convId}`);
  const messages = dataOf(thread)?.messages ?? [];
  ok(messages.length === 1, 'Thread contains exactly one message');
  ok(messages.every((m) => m.role !== 'assistant'), 'No simulated assistant reply exists');

  /* ------------------------------------------------------------------- feed */
  section('Activity Center (real events only)');
  const activity = await anon.get('/api/activity?limit=50');
  const types = new Set((dataOf(activity)?.items ?? []).map((i) => i.type));
  ok(types.has('auth_register'), 'Registration logged');
  ok(types.has('task_created'), 'Task creation logged');
  ok(types.has('task_completed'), 'Completion logged');
  ok(types.has('approval_requested'), 'Approval request logged');
  ok(types.has('approval_approved'), 'Approval decision logged');
  ok(types.has('workflow_created'), 'Workflow creation logged');
  ok(dataOf(activity)?.total >= 8, `Activity total is real (${dataOf(activity)?.total})`);

  const approvalOnly = await anon.get('/api/activity?category=approval');
  ok((dataOf(approvalOnly)?.items ?? []).every((i) => i.category === 'approval'), 'Category filter works');

  /* -------------------------------------------------------------- analytics */
  section('Overview & analytics');
  const overview = dataOf(await anon.get('/api/analytics/overview'));
  ok(overview?.stats?.totalAgents === 9, 'Overview: 9 agents');
  ok(overview?.stats?.tasksCompleted === 1, 'Overview: 1 completed task');
  ok(overview?.stats?.pendingApprovals === 0, 'Overview: no pending approvals left');
  ok(overview?.stats?.automationSuccessRate === 100, 'Success rate computed from real data (100%)');
  ok(overview?.completionSeries?.length === 14, 'Completion series spans 14 days');
  ok(overview?.recentActivity?.length > 0, 'Recent activity feed populated');

  const analytics = dataOf(await anon.get('/api/analytics?range=14'));
  ok(analytics?.totals?.tasks === 2, 'Analytics totals match task count');
  ok(analytics?.completionTrend?.length === 14, 'Trend series length matches range');
  ok(analytics?.workflowStats?.total === 1, 'Workflow stats real');

  /* ----------------------------------------------------------------- search */
  section('Global search');
  const search = await anon.get('/api/search?q=launch');
  ok((dataOf(search)?.tasks?.length ?? 0) >= 1, 'Search finds tasks');
  const searchBad = await anon.get('/api/search?q=');
  ok(searchBad.status === 422, 'Empty search → 422');

  /* -------------------------------------------------------------- settings */
  section('Settings');
  const settings = dataOf(await anon.get('/api/settings'));
  ok(settings?.profile?.email === EMAIL, 'Settings profile loaded');
  ok(settings?.preferences !== undefined, 'Preferences object present');

  const profilePatch = await anon.patch('/api/settings/profile', { name: 'Smoke Owner Renamed', email: EMAIL });
  ok(profilePatch.status === 200 && dataOf(profilePatch)?.profile?.name === 'Smoke Owner Renamed', 'Profile updated');

  const appearance = await anon.patch('/api/settings/appearance', { accent: 'gold', density: 'compact' });
  ok(appearance.status === 200 && dataOf(appearance)?.preferences?.appearance?.accent === 'gold', 'Appearance persisted');

  const notifPatch = await anon.patch('/api/settings/notifications', {
    approvals: true,
    taskUpdates: false,
    weeklyDigest: true,
    email: false,
    desktop: true,
  });
  ok(notifPatch.status === 200 && dataOf(notifPatch)?.preferences?.notifications?.taskUpdates === false, 'Notification prefs persisted');

  const defaultsPatch = await anon.patch('/api/settings/agent-defaults', {
    defaultAgentId: research.id,
    defaultPriority: 'high',
  });
  ok(defaultsPatch.status === 200 && dataOf(defaultsPatch)?.preferences?.agentDefaults?.defaultPriority === 'high', 'Agent defaults persisted');

  const wrongPw = await anon.post('/api/auth/change-password', { currentPassword: 'nope', newPassword: 'AnotherPass123' });
  ok(wrongPw.status === 401, 'Wrong current password rejected');
  const pwChange = await anon.post('/api/auth/change-password', {
    currentPassword: PASSWORD,
    newPassword: 'AnotherPass123',
  });
  ok(pwChange.status === 200, 'Password changed');

  /* ----------------------------------------------------------- integrations */
  section('Integrations (honesty contract)');
  const integrations = dataOf(await anon.get('/api/integrations')) ?? [];
  ok(integrations.length === 5, 'Five providers listed');
  ok(
    integrations.every((i) => i.status === 'not_connected'),
    'No provider falsely reported as connected',
  );

  const connect = await anon.post('/api/integrations/gmail/connect');
  ok(connect.status === 400 && connect.json?.error?.message.includes('credentials'), 'Connect fails honestly with clear message');
  const afterAttempt = dataOf(await anon.get('/api/integrations'))?.find((i) => i.provider === 'gmail');
  ok(afterAttempt?.status === 'not_connected' && Boolean(afterAttempt?.lastError), 'Failure persisted as lastError, status still not_connected');

  const disconnectNotConnected = await anon.post('/api/integrations/github/disconnect');
  ok(disconnectNotConnected.status === 400, 'Disconnecting a non-connected provider → 400');

  /* ------------------------------------------------------------ persistence */
  section('Persistence across sessions');
  const session2 = new Session();
  const relogin = await session2.post('/api/auth/login', { email: EMAIL, password: 'AnotherPass123' });
  ok(relogin.status === 200, 'Re-login with new password works');
  const persistTasks = await session2.get('/api/tasks');
  ok(dataOf(persistTasks)?.counts?.all === 2, 'Tasks persisted after re-login');
  const persistAgent = dataOf(await session2.get(`/api/agents/${research.id}`));
  ok(persistAgent?.status === 'active', 'Agent state persisted');
  const persistWf = dataOf(await session2.get('/api/workflows'));
  ok(persistWf?.length === 1 && persistWf[0].status === 'active', 'Workflow persisted');
  const persistPrefs = dataOf(await session2.get('/api/settings'));
  ok(persistPrefs?.preferences?.appearance?.accent === 'gold', 'Preferences persisted');

  /* --------------------------------------------------------- refresh tokens */
  section('Session refresh');
  session2.cookies.delete('vp_at'); // simulate expired access token
  const refresh = await session2.post('/api/auth/refresh');
  ok(refresh.status === 200, 'Refresh cookie issues a new session');
  const afterRefresh = await session2.get('/api/auth/me');
  ok(afterRefresh.status === 200, 'New access cookie works');

  /* ------------------------------------------------------------ isolation */
  section('Multi-tenant isolation');
  const other = new Session();
  await other.post('/api/auth/register', {
    name: 'Other Tenant',
    email: `other-${stamp}@vozpilot.test`,
    password: PASSWORD,
  });
  const otherTasks = dataOf(await other.get('/api/tasks'));
  ok(otherTasks?.tasks?.length === 0, "Another workspace sees none of this user's tasks");
  const otherAgents = dataOf(await other.get('/api/agents'));
  ok(otherAgents?.length === 9, 'Other workspace has its own seeded agents');
  const crossAgent = await other.patch(`/api/agents/${research.id}`, { status: 'paused' });
  ok(crossAgent.status === 404, "Cross-workspace agent update denied (404)");
  const crossTask = await other.patch(`/api/tasks/${taskId}`, { status: 'failed' });
  ok(crossTask.status === 404, "Cross-workspace task update denied (404)");

  /* ---------------------------------------------------------------- logout */
  section('Logout');
  const logout = await anon.post('/api/auth/logout');
  ok(logout.status === 200, 'Logout succeeds');
  const meAfter = await anon.get('/api/auth/me');
  ok(meAfter.status === 401, 'Session invalidated after logout');

  /* ---------------------------------------------------------------- summary */
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Result: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('Failures:');
    for (const failure of failures) console.log(`  • ${failure}`);
    process.exitCode = 1;
  } else {
    console.log('All Phase 1 acceptance checks passed ✔');
  }
}

main().catch((error) => {
  console.error('Smoke test crashed:', error);
  process.exit(1);
});
