import type { TogglAPI } from './toggl-api.js';
import type { Workspace } from './types.js';

export class WorkspaceResolutionError extends Error {
  readonly code = 'WORKSPACE_REQUIRED';

  constructor(readonly availableWorkspaces: Workspace[]) {
    super(
      'No workspace_id was provided, TOGGL_DEFAULT_WORKSPACE_ID is not set, and more than one workspace is accessible.'
    );
    this.name = 'WorkspaceResolutionError';
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

/**
 * Resolve a workspace id in precedence order:
 * explicit argument -> configured default -> the sole accessible workspace.
 */
export async function resolveWorkspaceId(
  api: TogglAPI,
  explicit?: number,
  fallback?: number
): Promise<number> {
  if (explicit) return explicit;
  if (fallback) return fallback;

  const workspaces = await api.getWorkspaces();
  if (workspaces.length === 1) return workspaces[0]!.id;

  throw new WorkspaceResolutionError(workspaces);
}
