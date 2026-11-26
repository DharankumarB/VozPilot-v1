import { z } from 'zod';
import { withUser } from '../../db/pool';
import { iso } from '../../lib/serialize';
import { agentOrderBy } from '../../db/seedDefaults';

/**
 * Overview + analytics read-only projections over real workspace data.
 * Automation success rate is null while no task has finished — the UI must
 * show an empty state instead of a fabricated percentage.
 */

export interface OverviewStats {
  totalAgents: number;
  activeAgents: number;
  tasksCompleted: number;
  tasksPending: number;
  tasksInProgress: number;
  tasksWaitingApproval: number;
  tasksFailed: number;
  tasksTotal: number;
  pendingApprovals: number;
  /** completed / (completed + failed) — null until any task has finished. */
  automationSuccessRate: number | null;
}

export interface SeriesPoint {
  date: string;
  count: number;
}

export interface AgentPerformancePoint {
  agentId: string;
  name: string;
  icon: string;
  status: string;
  completed: number;
  open: number;
  total: number;
}

export interface OverviewPayload {
  stats: OverviewStats;
  completionSeries: SeriesPoint[];
  agentPerformance: AgentPerformancePoint[];
  agents: { id: string; name: string; icon: string; status: string; lastActiveAt: string | null }[];
  recentActivity: {
    id: string;
    type: string;
    category: string;
    title: string;
    detail: string;
    createdAt: string;
  }[];
  recentTasks: {
    id: string;
    title: string;
    status: string;
    priority: string;
    agentName: string | null;
    updatedAt: string;
  }[];
  upcoming: {
    id: string;
    title: string;
    status: string;
    priority: string;
    dueDate: string;
    agentName: string | null;
  }[];
}

export async function getOverview(userId: string): Promise<OverviewPayload> {
  return withUser(userId, async (client) => {
    const agents = await client.query<{
        id: string;
        name: string;
        icon: string;
        status: string;
        last_active_at: Date | null;
        total: string;
        completed: string;
        open: string;
      }>(
        `SELECT a.id, a.name, a.icon, a.status, a.last_active_at,
                COUNT(t.id)::text AS total,
                COUNT(t.id) FILTER (WHERE t.status = 'completed')::text AS completed,
                COUNT(t.id) FILTER (WHERE t.status IN ('pending', 'in_progress', 'waiting_approval'))::text AS open
         FROM agents a
         LEFT JOIN tasks t ON t.agent_id = a.id
         WHERE a.user_id = $1
         GROUP BY a.id
         ${agentOrderBy('a.key')}`,
        [userId],
      );
const tasks = await client.query<{ status: string; count: string }>(
        'SELECT status, COUNT(*)::text AS count FROM tasks WHERE user_id = $1 GROUP BY status',
        [userId],
      );
const approvals = await client.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM approvals WHERE user_id = $1 AND status = 'pending'",
        [userId],
      );
const completion = await client.query<{ day: string; count: string }>(
        `SELECT to_char(completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, COUNT(*)::text AS count
         FROM tasks
         WHERE user_id = $1 AND completed_at >= now() - interval '14 days'
         GROUP BY 1 ORDER BY 1`,
        [userId],
      );
const activity = await client.query<{
        id: string;
        type: string;
        category: string;
        title: string;
        detail: string;
        created_at: Date;
      }>(
        `SELECT id, type, category, title, detail, created_at
         FROM activity_logs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10`,
        [userId],
      );
const recentTasks = await client.query<{
        id: string;
        title: string;
        status: string;
        priority: string;
        agent_name: string | null;
        updated_at: Date;
      }>(
        `SELECT t.id, t.title, t.status, t.priority, t.updated_at, a.name AS agent_name
         FROM tasks t
         LEFT JOIN agents a ON a.id = t.agent_id AND a.user_id = t.user_id
         WHERE t.user_id = $1
         ORDER BY t.updated_at DESC
         LIMIT 8`,
        [userId],
      );
const upcoming = await client.query<{
        id: string;
        title: string;
        status: string;
        priority: string;
        due_date: string;
        agent_name: string | null;
      }>(
        `SELECT t.id, t.title, t.status, t.priority, t.due_date, a.name AS agent_name
         FROM tasks t
         LEFT JOIN agents a ON a.id = t.agent_id AND a.user_id = t.user_id
         WHERE t.user_id = $1
           AND t.due_date IS NOT NULL
           AND t.due_date >= CURRENT_DATE
           AND t.status IN ('pending', 'in_progress', 'waiting_approval')
         ORDER BY t.due_date ASC
         LIMIT 8`,
        [userId],
      );

    const counts: Record<string, number> = {};
    for (const row of tasks.rows) counts[row.status] = Number(row.count);

    const completed = counts['completed'] ?? 0;
    const failed = counts['failed'] ?? 0;
    const finished = completed + failed;

    const stats: OverviewStats = {
      totalAgents: agents.rows.length,
      activeAgents: agents.rows.filter((row) => row.status === 'active').length,
      tasksCompleted: completed,
      tasksPending: counts['pending'] ?? 0,
      tasksInProgress: counts['in_progress'] ?? 0,
      tasksWaitingApproval: counts['waiting_approval'] ?? 0,
      tasksFailed: failed,
      tasksTotal: Object.values(counts).reduce((sum, value) => sum + value, 0),
      pendingApprovals: Number(approvals.rows[0]?.count ?? 0),
      automationSuccessRate: finished > 0 ? Math.round((completed / finished) * 100) : null,
    };

    // Fill the last 14 days so the chart is continuous (real zeros, not fakes).
    const completionSeries: SeriesPoint[] = [];
    const countsByDay = new Map(completion.rows.map((row) => [row.day, Number(row.count)]));
    for (let daysAgo = 13; daysAgo >= 0; daysAgo -= 1) {
      const date = new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
      completionSeries.push({ date, count: countsByDay.get(date) ?? 0 });
    }

    return {
      stats,
      completionSeries,
      agentPerformance: agents.rows.map((row) => ({
        agentId: row.id,
        name: row.name,
        icon: row.icon,
        status: row.status,
        completed: Number(row.completed),
        open: Number(row.open),
        total: Number(row.total),
      })),
      agents: agents.rows.map((row) => ({
        id: row.id,
        name: row.name,
        icon: row.icon,
        status: row.status,
        lastActiveAt: iso(row.last_active_at),
      })),
      recentActivity: activity.rows.map((row) => ({
        id: row.id,
        type: row.type,
        category: row.category,
        title: row.title,
        detail: row.detail,
        createdAt: row.created_at.toISOString(),
      })),
      recentTasks: recentTasks.rows.map((row) => ({
        id: row.id,
        title: row.title,
        status: row.status,
        priority: row.priority,
        agentName: row.agent_name,
        updatedAt: row.updated_at.toISOString(),
      })),
      upcoming: upcoming.rows.map((row) => ({
        id: row.id,
        title: row.title,
        status: row.status,
        priority: row.priority,
        dueDate: row.due_date,
        agentName: row.agent_name,
      })),
    };
  });
}

export const analyticsQuerySchema = z.object({
  range: z.coerce.number().int().min(7).max(90).default(30),
});

export interface AnalyticsPayload {
  range: number;
  completionTrend: SeriesPoint[];
  statusDistribution: { status: string; count: number }[];
  priorityDistribution: { priority: string; count: number }[];
  agentActivity: {
    agentId: string;
    name: string;
    icon: string;
    assigned: number;
    completed: number;
    events: number;
  }[];
  workflowStats: { total: number; active: number; draft: number; paused: number };
  totals: {
    tasks: number;
    completionRate: number | null;
    memories: number;
    conversations: number;
    approvalsResolved: number;
    activityEvents: number;
    avgTasksPerDay: number | null;
  };
}

export async function getAnalytics(userId: string, range: number): Promise<AnalyticsPayload> {
  return withUser(userId, async (client) => {
    const trend = await // Continuous daily series of real completed-task counts over the range.
        client.query<{ day: string; count: string }>(
          `SELECT to_char(s.day, 'YYYY-MM-DD') AS day, COUNT(t.id)::text AS count
           FROM generate_series(
             (CURRENT_DATE - ($2::int - 1))::date,
             CURRENT_DATE::date,
             interval '1 day'
           ) AS s(day)
           LEFT JOIN tasks t
             ON t.user_id = $1
             AND t.completed_at IS NOT NULL
             AND (t.completed_at AT TIME ZONE 'UTC')::date = s.day::date
           GROUP BY s.day
           ORDER BY s.day`,
          [userId, range],
        );
const statusRows = await client.query<{ status: string; count: string }>(
          'SELECT status, COUNT(*)::text AS count FROM tasks WHERE user_id = $1 GROUP BY status',
          [userId],
        );
const priorityRows = await client.query<{ priority: string; count: string }>(
          'SELECT priority, COUNT(*)::text AS count FROM tasks WHERE user_id = $1 GROUP BY priority',
          [userId],
        );
const agentRows = await client.query<{ id: string; name: string; icon: string; assigned: string; completed: string }>(
          `SELECT a.id, a.name, a.icon,
                  COUNT(t.id)::text AS assigned,
                  COUNT(t.id) FILTER (WHERE t.status = 'completed')::text AS completed
           FROM agents a
           LEFT JOIN tasks t ON t.agent_id = a.id
           WHERE a.user_id = $1
           GROUP BY a.id
           ${agentOrderBy('a.key')}`,
          [userId],
        );
const eventRows = await client.query<{ agent_id: string; events: string }>(
          `SELECT agent_id, COUNT(*)::text AS events
           FROM activity_logs
           WHERE user_id = $1
             AND agent_id IS NOT NULL
             AND created_at >= now() - make_interval(days => $2::int)
           GROUP BY agent_id`,
          [userId, range],
        );
const workflowRows = await client.query<{ status: string; count: string }>(
          'SELECT status, COUNT(*)::text AS count FROM workflows WHERE user_id = $1 GROUP BY status',
          [userId],
        );
const totals = await client.query<{
          tasks: string;
          completed: string;
          failed: string;
          memories: string;
          conversations: string;
          approvals_resolved: string;
          activity_events: string;
        }>(
          `SELECT
             (SELECT COUNT(*) FROM tasks WHERE user_id = $1)::text AS tasks,
             (SELECT COUNT(*) FROM tasks WHERE user_id = $1 AND status = 'completed')::text AS completed,
             (SELECT COUNT(*) FROM tasks WHERE user_id = $1 AND status = 'failed')::text AS failed,
             (SELECT COUNT(*) FROM memories WHERE user_id = $1)::text AS memories,
             (SELECT COUNT(*) FROM conversations WHERE user_id = $1)::text AS conversations,
             (SELECT COUNT(*) FROM approvals WHERE user_id = $1 AND status IN ('approved', 'rejected'))::text AS approvals_resolved,
             (SELECT COUNT(*) FROM activity_logs WHERE user_id = $1)::text AS activity_events`,
          [userId],
        );

    const totalRow = totals.rows[0];
    const completed = Number(totalRow?.completed ?? 0);
    const failed = Number(totalRow?.failed ?? 0);
    const finished = completed + failed;

    const eventsByAgent = new Map(eventRows.rows.map((row) => [row.agent_id, Number(row.events)]));

    const workflowStats = { total: 0, active: 0, draft: 0, paused: 0 };
    for (const row of workflowRows.rows) {
      const count = Number(row.count);
      workflowStats.total += count;
      if (row.status === 'active') workflowStats.active = count;
      if (row.status === 'draft') workflowStats.draft = count;
      if (row.status === 'paused') workflowStats.paused = count;
    }

    const totalTasks = Number(totalRow?.tasks ?? 0);

    return {
      range,
      completionTrend: trend.rows.map((row) => ({ date: row.day, count: Number(row.count) })),
      statusDistribution: statusRows.rows.map((row) => ({
        status: row.status,
        count: Number(row.count),
      })),
      priorityDistribution: priorityRows.rows.map((row) => ({
        priority: row.priority,
        count: Number(row.count),
      })),
      agentActivity: agentRows.rows.map((row) => ({
        agentId: row.id,
        name: row.name,
        icon: row.icon,
        assigned: Number(row.assigned),
        completed: Number(row.completed),
        events: eventsByAgent.get(row.id) ?? 0,
      })),
      workflowStats,
      totals: {
        tasks: totalTasks,
        completionRate: finished > 0 ? Math.round((completed / finished) * 100) : null,
        memories: Number(totalRow?.memories ?? 0),
        conversations: Number(totalRow?.conversations ?? 0),
        approvalsResolved: Number(totalRow?.approvals_resolved ?? 0),
        activityEvents: Number(totalRow?.activity_events ?? 0),
        avgTasksPerDay: totalTasks > 0 ? Math.round((totalTasks / range) * 10) / 10 : null,
      },
    };
  });
}
