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

/** Where a project id came from, so a stale one can point at the right fix. */
export type ProjectIdSource = 'argument' | 'configuration';

export class ProjectValidationError extends Error {
  readonly code = 'INVALID_PROJECT_ID';

  constructor(
    readonly projectId: number,
    readonly workspaceId: number,
    readonly availableProjects: PublicProject[],
    readonly source: ProjectIdSource = 'argument'
  ) {
    super(
      source === 'configuration'
        ? `The projectId ${projectId} configured in the credentials file does not belong to ` +
            `workspace ${workspaceId}. Use toggl_list_projects for that workspace to pick a valid ` +
            'id, or remove the projectId key.'
        : `project_id ${projectId} does not belong to workspace ${workspaceId}. ` +
            'Use toggl_list_projects for that workspace and pass one of its project ids.'
    );
    this.name = 'ProjectValidationError';
  }
}

/** Accept a positive integer id as a number or a numeric string; reject anything else. */
export function parseId(value: unknown): number | undefined {
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
  projectId?: number,
  source: ProjectIdSource = 'argument'
): Promise<number | undefined> {
  if (projectId === undefined) return undefined;

  // Include archived projects so a valid project is not rejected just because
  // the API's default project list omits it.
  const cached = api.getCachedProjects(workspaceId, { includeArchived: true });
  if (cached?.some((project) => project.id === projectId)) return projectId;

  // A warm cache that misses may be stale, so refresh it; a cold cache is
  // authoritative on its own. Either way this is a single request.
  const projects = await api.getProjects(workspaceId, {
    includeArchived: true,
    refresh: cached !== undefined,
  });
  if (!projects.some((project) => project.id === projectId)) {
    throw new ProjectValidationError(projectId, workspaceId, publicProjects(projects), source);
  }
  return projectId;
}

/**
 * Resolve the workspace for an existing entry: verify an explicit id, otherwise
 * load the entry and use (and verify) the workspace that owns it.
 */
export async function resolveWorkspaceForEntry(
  api: TogglAPI,
  timeEntryId: number,
  explicitWorkspaceId?: number
): Promise<number> {
  if (explicitWorkspaceId !== undefined) {
    return resolveWorkspaceId(api, explicitWorkspaceId);
  }
  const entry = await api.getTimeEntry(timeEntryId);
  return resolveWorkspaceId(api, entry.workspace_id);
}

export interface EntryScopeInput {
  workspace_id?: number;
  project_id?: number;
}

/** Configured fallbacks, used when the matching input above is omitted. */
export interface EntryScopeDefaults {
  workspaceId?: number;
  projectId?: number;
}

export interface EntryScope {
  workspaceId: number;
  projectId?: number;
  /**
   * True when the configured projectId did not fit the resolved workspace, so
   * the entry is created without a project.
   */
  defaultProjectSkipped?: boolean;
}

/**
 * The configured project to fall back on. A configured project belongs to the
 * configured workspace, so it is offered only for an entry that lands there.
 * Without a configured workspace it is offered to whatever workspace was
 * resolved, and the membership check decides whether it fits.
 */
function configuredProjectIdFor(
  workspaceId: number,
  defaults: EntryScopeDefaults
): number | undefined {
  if (defaults.projectId === undefined) return undefined;
  if (defaults.workspaceId === undefined) return defaults.projectId;
  return workspaceId === defaults.workspaceId ? defaults.projectId : undefined;
}

/**
 * Resolve and verify the workspace/project pair before creating a time entry.
 * project_id always wins; otherwise the configured project applies only where
 * it belongs, so an entry in another workspace never inherits it.
 */
export async function resolveEntryScope(
  api: TogglAPI,
  input: EntryScopeInput,
  defaults: EntryScopeDefaults = {}
): Promise<EntryScope> {
  const workspaceId = await resolveWorkspaceId(api, input.workspace_id, defaults.workspaceId);

  if (input.project_id !== undefined) {
    return { workspaceId, projectId: await resolveProjectId(api, workspaceId, input.project_id) };
  }

  const configuredProjectId = configuredProjectIdFor(workspaceId, defaults);
  if (configuredProjectId === undefined) return { workspaceId, projectId: undefined };

  try {
    return {
      workspaceId,
      projectId: await resolveProjectId(api, workspaceId, configuredProjectId, 'configuration'),
    };
  } catch (error) {
    // Without a configured workspace the project is only a hint, so one that
    // does not fit where the entry landed is ignored rather than fatal. With a
    // configured workspace the id is authoritative and a mismatch means stale
    // configuration that must be surfaced.
    if (defaults.workspaceId !== undefined || !(error instanceof ProjectValidationError)) {
      throw error;
    }
    return { workspaceId, projectId: undefined, defaultProjectSkipped: true };
  }
}
