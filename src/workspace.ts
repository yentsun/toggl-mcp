import { publicProjects, publicWorkspaces, type PublicProject } from './format.js';
import type { TogglAPI } from './toggl-api.js';
import type { Workspace } from './types.js';

export class WorkspaceResolutionError extends Error {
  readonly code = 'WORKSPACE_REQUIRED';

  constructor(readonly availableWorkspaces: Workspace[]) {
    super(
      'No workspace_id was provided, no default workspace is configured, and more than one workspace is accessible.'
    );
    this.name = 'WorkspaceResolutionError';
  }
}

export class WorkspaceValidationError extends Error {
  readonly code = 'INVALID_WORKSPACE_ID';

  constructor(
    readonly workspaceId: number,
    readonly availableWorkspaces: Workspace[]
  ) {
    super(
      `workspace_id ${workspaceId} is not an accessible Toggl workspace. ` +
        'Use toggl_list_workspaces and pass a workspace id, not a project id.'
    );
    this.name = 'WorkspaceValidationError';
  }
}

export class ProjectValidationError extends Error {
  readonly code = 'INVALID_PROJECT_ID';

  constructor(
    readonly projectId: number,
    readonly workspaceId: number,
    readonly availableProjects: PublicProject[]
  ) {
    super(
      `project_id ${projectId} does not belong to workspace ${workspaceId}. ` +
        'Use toggl_list_projects for that workspace and pass one of its project ids.'
    );
    this.name = 'ProjectValidationError';
  }
}

export function parseWorkspaceId(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? value : undefined;
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

/** Fail locally when an id is not one of the workspaces the token can access. */
async function assertAccessibleWorkspace(api: TogglAPI, workspaceId: number): Promise<void> {
  const workspaces = await api.getWorkspaces();
  if (!workspaces.some((workspace) => workspace.id === workspaceId)) {
    throw new WorkspaceValidationError(workspaceId, publicWorkspaces(workspaces));
  }
}

/**
 * Resolve a workspace id in precedence order:
 * explicit argument -> configured default -> the sole accessible workspace.
 * Any supplied id is verified against the accessible workspaces first, so a
 * project id can never be used where a workspace id is required.
 */
export async function resolveWorkspaceId(
  api: TogglAPI,
  explicit?: number,
  fallback?: number
): Promise<number> {
  const candidate = explicit ?? fallback;
  if (candidate !== undefined) {
    await assertAccessibleWorkspace(api, candidate);
    return candidate;
  }

  const workspaces = await api.getWorkspaces();
  if (workspaces.length === 1) return workspaces[0]!.id;

  // Never carry raw payloads: /workspaces responses include a workspace api_token.
  throw new WorkspaceResolutionError(publicWorkspaces(workspaces));
}

/**
 * Verify that a project belongs to the resolved workspace before any write.
 * Returns undefined when no project was selected.
 */
export async function resolveProjectId(
  api: TogglAPI,
  workspaceId: number,
  projectId?: number
): Promise<number | undefined> {
  if (projectId === undefined) return undefined;

  const projects = await api.getProjects(workspaceId);
  if (!projects.some((project) => project.id === projectId)) {
    throw new ProjectValidationError(projectId, workspaceId, publicProjects(projects));
  }
  return projectId;
}

export interface EntryScopeInput {
  workspace_id?: number;
  project_id?: number;
}

export interface EntryScope {
  workspaceId: number;
  projectId?: number;
}

/** Resolve and verify the workspace/project pair before creating a time entry. */
export async function resolveEntryScope(
  api: TogglAPI,
  input: EntryScopeInput,
  fallbackWorkspaceId?: number
): Promise<EntryScope> {
  const workspaceId = await resolveWorkspaceId(api, input.workspace_id, fallbackWorkspaceId);
  const projectId = await resolveProjectId(api, workspaceId, input.project_id);
  return { workspaceId, projectId };
}
