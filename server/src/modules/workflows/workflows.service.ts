import { z } from 'zod';
import { withUser } from '../../db/pool';
import { logActivity } from '../../lib/activity';
import { NotFoundError } from '../../lib/errors';

export const workflowStatusSchema = z.enum(['draft', 'active', 'paused']);

export interface WorkflowStepDto {
  id: string;
  name: string;
  description: string;
  position: number;
  config: Record<string, unknown>;
}

export interface WorkflowDto {
  id: string;
  name: string;
  description: string;
  status: 'draft' | 'active' | 'paused';
  steps: WorkflowStepDto[];
  createdAt: string;
  updatedAt: string;
  /**
   * Workflow execution history. Always empty in Phase 1: the execution engine
   * arrives in Phase 2, and no synthetic run records are ever stored.
   */
  executions: [];
}

interface WorkflowRow {
  id: string;
  name: string;
  description: string;
  status: 'draft' | 'active' | 'paused';
  created_at: Date;
  updated_at: Date;
}

interface StepRow {
  id: string;
  workflow_id: string;
  name: string;
  description: string;
  position: number;
  config: Record<string, unknown> | null;
}

function mapWorkflow(row: WorkflowRow, steps: StepRow[]): WorkflowDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    steps: steps
      .sort((a, b) => a.position - b.position)
      .map((step) => ({
        id: step.id,
        name: step.name,
        description: step.description,
        position: step.position,
        config: step.config ?? {},
      })),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    executions: [],
  };
}

const stepSchema = z.object({
  name: z.string().trim().min(1, 'Step name is required').max(160),
  description: z.string().trim().max(600).default(''),
});

export const createWorkflowSchema = z.object({
  name: z.string().trim().min(1, 'Workflow name is required').max(160),
  description: z.string().trim().max(2000).default(''),
  status: workflowStatusSchema.default('draft'),
  steps: z.array(stepSchema).max(30).default([]),
});

export const updateWorkflowSchema = createWorkflowSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  { message: 'Provide at least one field to update' },
);

export type CreateWorkflowInput = z.infer<typeof createWorkflowSchema>;
export type UpdateWorkflowInput = z.infer<typeof updateWorkflowSchema>;

export async function listWorkflows(userId: string): Promise<WorkflowDto[]> {
  return withUser(userId, async (client) => {
    const result = await client.query<WorkflowRow>(
      'SELECT * FROM workflows WHERE user_id = $1 ORDER BY created_at DESC',
      [userId],
    );
    if (result.rows.length === 0) return [];

    const steps = await client.query<StepRow>(
      'SELECT * FROM workflow_steps WHERE user_id = $1 ORDER BY workflow_id, position',
      [userId],
    );
    const byWorkflow = new Map<string, StepRow[]>();
    for (const step of steps.rows) {
      const list = byWorkflow.get(step.workflow_id) ?? [];
      list.push(step);
      byWorkflow.set(step.workflow_id, list);
    }
    return result.rows.map((row) => mapWorkflow(row, byWorkflow.get(row.id) ?? []));
  });
}

async function replaceSteps(
  client: { query: <R = Record<string, unknown>>(text: string, values?: unknown[]) => Promise<{ rows: R[]; rowCount: number | null }> },
  workflowId: string,
  userId: string,
  steps: { name: string; description: string }[],
): Promise<void> {
  await client.query('DELETE FROM workflow_steps WHERE workflow_id = $1 AND user_id = $2', [
    workflowId,
    userId,
  ]);
  for (const [index, step] of steps.entries()) {
    await client.query(
      `INSERT INTO workflow_steps (workflow_id, user_id, name, description, position)
       VALUES ($1, $2, $3, $4, $5)`,
      [workflowId, userId, step.name, step.description, index],
    );
  }
}

export async function createWorkflow(userId: string, input: CreateWorkflowInput): Promise<WorkflowDto> {
  return withUser(userId, async (client) => {
    const inserted = await client.query<WorkflowRow>(
      `INSERT INTO workflows (user_id, name, description, status)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [userId, input.name, input.description, input.status],
    );
    const workflow = inserted.rows[0];
    await replaceSteps(client, workflow.id, userId, input.steps);

    await logActivity(client, {
      userId,
      type: 'workflow_created',
      category: 'workflow',
      title: `Workflow created: ${workflow.name}`,
      detail: `${input.steps.length} step${input.steps.length === 1 ? '' : 's'} · ${input.status}`,
    });

    const steps = await client.query<StepRow>(
      'SELECT * FROM workflow_steps WHERE workflow_id = $1 ORDER BY position',
      [workflow.id],
    );
    return mapWorkflow(workflow, steps.rows);
  });
}

export async function updateWorkflow(
  userId: string,
  workflowId: string,
  input: UpdateWorkflowInput,
): Promise<WorkflowDto> {
  return withUser(userId, async (client) => {
    const existing = await client.query<WorkflowRow>(
      'SELECT * FROM workflows WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [workflowId, userId],
    );
    const workflow = existing.rows[0];
    if (!workflow) throw new NotFoundError('Workflow not found.');

    const changes: string[] = [];
    const sets: string[] = [];
    const values: unknown[] = [workflowId, userId];
    const push = (column: string, value: unknown) => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };

    if (input.name !== undefined && input.name !== workflow.name) {
      changes.push(`Name: ${workflow.name} → ${input.name}`);
      push('name', input.name);
    }
    if (input.description !== undefined && input.description !== workflow.description) {
      changes.push('Description updated');
      push('description', input.description);
    }
    if (input.status !== undefined && input.status !== workflow.status) {
      changes.push(`Status: ${workflow.status} → ${input.status}`);
      push('status', input.status);
    }

    if (sets.length > 0) {
      await client.query(
        `UPDATE workflows SET ${sets.join(', ')} WHERE id = $1 AND user_id = $2`,
        values as never[],
      );
    }
    if (input.steps !== undefined) {
      await replaceSteps(client, workflowId, userId, input.steps);
      changes.push(`Steps updated (${input.steps.length})`);
    }

    if (changes.length > 0) {
      await logActivity(client, {
        userId,
        type: 'workflow_updated',
        category: 'workflow',
        title: `Workflow updated: ${input.name ?? workflow.name}`,
        detail: changes.join(' · '),
      });
    }

    const updated = await client.query<WorkflowRow>(
      'SELECT * FROM workflows WHERE id = $1 AND user_id = $2',
      [workflowId, userId],
    );
    const row = updated.rows[0];
    if (!row) throw new NotFoundError('Workflow not found.');
    const steps = await client.query<StepRow>(
      'SELECT * FROM workflow_steps WHERE workflow_id = $1 ORDER BY position',
      [workflowId],
    );
    return mapWorkflow(row, steps.rows);
  });
}

export async function deleteWorkflow(userId: string, workflowId: string): Promise<void> {
  await withUser(userId, async (client) => {
    const existing = await client.query<{ name: string }>(
      'SELECT name FROM workflows WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [workflowId, userId],
    );
    const workflow = existing.rows[0];
    if (!workflow) throw new NotFoundError('Workflow not found.');

    await client.query('DELETE FROM workflows WHERE id = $1 AND user_id = $2', [workflowId, userId]);
    await logActivity(client, {
      userId,
      type: 'workflow_deleted',
      category: 'workflow',
      title: `Workflow deleted: ${workflow.name}`,
      detail: 'Removed from the workspace',
    });
  });
}
