import { publicProjects, publicWorkspaces, type PublicProject } from './format.js';
import type { ProjectSettings } from './credentials.js';
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

/**
 * A call named a workspace while this repository has a different one
 * configured. The call is refused rather than redirected: silently tracking
 * against the configured workspace would hide the caller's mistake.
 */
export class ConfiguredWorkspaceMismatchError extends Error {
  readonly code = 'CONFIGURED_WORKSPACE_MISMATCH';

  constructor(
    readonly suppliedWorkspaceId: number,
    readonly configuredWorkspaceId: number
  ) {
    super(
      `The supplied workspace override ${suppliedWorkspaceId} is invalid; a configured workspace ` +
        `(${configuredWorkspaceId}) is available. Omit workspace_id to track in the configured ` +
        'workspace, or update workspaceId in the project settings file to track elsewhere.'
    );
    this.name = 'ConfiguredWorkspaceMismatchError';
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
        ? `The projectId ${projectId} configured in the project settings file does not belong to ` +
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
 *
 * With `boundToDefault` set, an explicit id must repeat the configured one.
 * Write paths use that: a timer belongs to the workspace this repository is
 * configured for, so an override is either redundant or a mistake.
 */
export async function resolveWorkspaceId(
  api: TogglAPI,
  explicit?: number,
  fallback?: number,
  options: { boundToDefault?: boolean } = {}
): Promise<number> {
  if (
    options.boundToDefault &&
    explicit !== undefined &&
    fallback !== undefined &&
    explicit !== fallback
  ) {
    throw new ConfiguredWorkspaceMismatchError(explicit, fallback);
  }

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
 *
 * A configured workspace binds an explicit id, because edits and deletes
 * against another workspace are the same cross-workspace mistake as a timer.
 */
export async function resolveWorkspaceForEntry(
  api: TogglAPI,
  timeEntryId: number,
  explicitWorkspaceId?: number,
  configuredWorkspaceId?: number
): Promise<number> {
  if (explicitWorkspaceId === undefined) {
    const entry = await api.getTimeEntry(timeEntryId);
    return resolveWorkspaceId(api, entry.workspace_id);
  }
  if (configuredWorkspaceId !== undefined && explicitWorkspaceId !== configuredWorkspaceId) {
    throw new ConfiguredWorkspaceMismatchError(explicitWorkspaceId, configuredWorkspaceId);
  }
  return resolveWorkspaceId(api, explicitWorkspaceId);
}

/**
 * The project-scoped defaults as the server resolved them: the settings file
 * shape, which one type describes whether read from disk or passed in.
 */
export type SettingsDefaults = ProjectSettings;

/**
 * The effective workspace for reads, or undefined when none is configured.
 * Reads can still name another workspace, so this is a default, not a bound.
 */
export interface EffectiveConfiguration {
  /** Absolute path the settings were read from, or null when there is no file. */
  settingsPath: string | null;
  settingsLoaded: boolean;
  /**
   * Whether a project is configured for this repository. Every timer write
   * needs a project, so false means the caller must pass a verified project_id
   * or run setup — a usable-looking (even derived) workspace does not change
   * that. This reflects the configured default only; it cannot know a
   * project_id the caller might pass.
   */
  projectConfigured: boolean;
  workspace: EffectiveValue<number>;
  project: EffectiveValue<number>;
  billable: EffectiveValue<boolean>;
}

/**
 * One effective setting and where it came from. `configured` is false for a
 * fallback the server derives itself, which is the difference a caller needs to
 * know before deciding whether to pass an override.
 */
export interface EffectiveValue<T> {
  value: T | null;
  source: 'configuration' | 'derived' | 'unset';
  configured: boolean;
  detail: string;
}

function fromConfiguration<T>(value: T, detail: string): EffectiveValue<T> {
  return { value, source: 'configuration', configured: true, detail };
}

function fromDerived<T>(value: T, detail: string): EffectiveValue<T> {
  return { value, source: 'derived', configured: false, detail };
}

function unset<T>(detail: string): EffectiveValue<T> {
  return { value: null, source: 'unset', configured: false, detail };
}

/**
 * Describe the effective defaults from the settings file. Only the sole-accessible
 * workspace case needs the token, and only to name that workspace; it is the one
 * resolveWorkspaceId would pick anyway, so the report matches the next write.
 */
export async function describeConfiguration(
  api: TogglAPI,
  settings: ProjectSettings,
  settingsPath: string | null,
  settingsLoaded: boolean
): Promise<EffectiveConfiguration> {
  let workspace: EffectiveValue<number>;
  if (settings.workspaceId !== undefined) {
    workspace = fromConfiguration(
      settings.workspaceId,
      'workspaceId in the project settings file; timer operations are bound to it.'
    );
  } else {
    const workspaces = await api.getWorkspaces();
    workspace =
      workspaces.length === 1
        ? fromDerived(
            workspaces[0]!.id,
            'No workspaceId configured; the sole accessible workspace is used for reads. A timer ' +
              'write still needs a project, configured or passed as project_id.'
          )
        : unset<number>(
            workspaces.length === 0
              ? 'No workspaceId configured and the token can access no workspace.'
              : 'No workspaceId configured and several workspaces are accessible; reads that need one will ask for workspace_id.'
          );
  }

  const project =
    settings.projectId === undefined
      ? unset<number>(
          'No projectId configured, so timer writes fail with PROJECT_SETTINGS_MISSING unless ' +
            'a verified project_id is passed.'
        )
      : fromConfiguration(
          settings.projectId,
          'projectId in the project settings file; applied when project_id is omitted.'
        );

  const billable =
    settings.billable === undefined
      ? fromDerived(
          false,
          'No billable default configured, so entries are created unbilled unless billable is passed.'
        )
      : fromConfiguration(
          settings.billable,
          'billable in the project settings file; applied when billable is omitted on the configured project.'
        );

  return {
    settingsPath,
    settingsLoaded,
    // Reflects the configured default only: a timer write needs a project, and
    // the report cannot know a project_id the caller might pass.
    projectConfigured: settings.projectId !== undefined,
    workspace,
    project,
    billable,
  };
}

export interface EntryScopeInput {
  workspace_id?: number;
  project_id?: number;
}

/** Configured fallbacks, used when the matching input above is omitted. */
export interface EntryScopeDefaults {
  workspaceId?: number;
  projectId?: number;
  /** Billable flag for entries the configured project creates. */
  billable?: boolean;
}

export interface EntryScope {
  workspaceId: number;
  projectId?: number;
  /** Configured billable default, applied only where the configured project applies. */
  billable?: boolean;
  /**
   * True when the configured projectId did not fit the resolved workspace, so
   * the entry is created without a project. Only possible when no workspace is
   * configured: with one, a project that does not fit is an error.
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
 * it belongs, so an entry in another workspace never inherits it. The
 * configured billable flag follows the project for the same reason.
 *
 * A configured workspace binds workspace_id to itself: repeating it is fine,
 * naming another one is refused instead of landing the entry somewhere else.
 */
export async function resolveEntryScope(
  api: TogglAPI,
  input: EntryScopeInput,
  defaults: EntryScopeDefaults = {}
): Promise<EntryScope> {
  const workspaceId = await resolveWorkspaceId(api, input.workspace_id, defaults.workspaceId, {
    boundToDefault: true,
  });

  if (input.project_id !== undefined) {
    return { workspaceId, projectId: await resolveProjectId(api, workspaceId, input.project_id) };
  }

  const configuredProjectId = configuredProjectIdFor(workspaceId, defaults);
  if (configuredProjectId === undefined) return { workspaceId, projectId: undefined };

  try {
    return {
      workspaceId,
      projectId: await resolveProjectId(api, workspaceId, configuredProjectId, 'configuration'),
      billable: defaults.billable,
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
