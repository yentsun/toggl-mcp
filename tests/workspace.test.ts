import { describe, expect, it, vi } from 'vitest';
import {
  ProjectValidationError,
  WorkspaceResolutionError,
  WorkspaceValidationError,
  parseId,
  resolveEntryScope,
  resolveProjectId,
  resolveWorkspaceForEntry,
  resolveWorkspaceId,
} from '../src/workspace.js';
import type { TogglAPI } from '../src/toggl-api.js';
import type { Project, TimeEntry, Workspace } from '../src/types.js';

function fakeApi(
  workspaces: Workspace[],
  projects: Project[] = [],
  entry: Partial<TimeEntry> = {}
): TogglAPI {
  return {
    getWorkspaces: vi.fn().mockResolvedValue(workspaces),
    getProjects: vi.fn().mockResolvedValue(projects),
    getCachedProjects: vi.fn().mockReturnValue(undefined),
    getTimeEntry: vi.fn().mockResolvedValue(entry),
  } as unknown as TogglAPI;
}

const workspace: Workspace = { id: 7, name: 'seven' };
const projects: Project[] = [
  { id: 300, workspace_id: 7, client_id: null, name: 'alpha', active: true },
];

describe('parseId', () => {
  it('accepts positive integers as number or numeric string', () => {
    expect(parseId(42)).toBe(42);
    expect(parseId('42')).toBe(42);
    expect(parseId(' 42 ')).toBe(42);
  });

  it('rejects invalid values', () => {
    expect(parseId(0)).toBeUndefined();
    expect(parseId(-1)).toBeUndefined();
    expect(parseId('abc')).toBeUndefined();
    expect(parseId('')).toBeUndefined();
    expect(parseId(undefined)).toBeUndefined();
    expect(parseId(1.5)).toBeUndefined();
  });
});

describe('resolveWorkspaceId', () => {
  it('returns an explicit id only after verifying it is accessible', async () => {
    const api = fakeApi([workspace, { id: 9, name: 'nine' }]);

    await expect(resolveWorkspaceId(api, 7, 9)).resolves.toBe(7);
    expect(api.getWorkspaces).toHaveBeenCalledTimes(1);
  });

  it('verifies the configured fallback', async () => {
    const api = fakeApi([workspace]);

    await expect(resolveWorkspaceId(api, undefined, 7)).resolves.toBe(7);
    expect(api.getWorkspaces).toHaveBeenCalledTimes(1);
  });

  it('rejects an inaccessible explicit id without listing projects', async () => {
    const api = fakeApi([workspace], projects);

    const error = await resolveWorkspaceId(api, 4242).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WorkspaceValidationError);
    expect(error).toMatchObject({
      code: 'INVALID_WORKSPACE_ID',
      workspaceId: 4242,
      availableWorkspaces: [{ id: 7, name: 'seven' }],
    });
    expect(api.getProjects).not.toHaveBeenCalled();
  });

  it('rejects an inaccessible configured fallback', async () => {
    const api = fakeApi([workspace]);

    await expect(resolveWorkspaceId(api, undefined, 4242)).rejects.toBeInstanceOf(
      WorkspaceValidationError
    );
  });

  it('uses the sole workspace when unambiguous', async () => {
    const api = fakeApi([{ id: 5, name: 'only' }]);
    await expect(resolveWorkspaceId(api)).resolves.toBe(5);
  });

  it('never exposes workspace credentials in the resolution error', async () => {
    const leaked = [
      { id: 1, name: 'a', api_token: 'secret-a' },
      { id: 2, name: 'b', api_token: 'secret-b' },
    ] as unknown as Workspace[];
    const api = fakeApi(leaked);

    const error = await resolveWorkspaceId(api).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WorkspaceResolutionError);
    expect((error as WorkspaceResolutionError).availableWorkspaces).toEqual([
      { id: 1, name: 'a' },
      { id: 2, name: 'b' },
    ]);
  });

  it('throws with available workspaces when ambiguous', async () => {
    const workspaces = [
      { id: 1, name: 'a' },
      { id: 2, name: 'b' },
    ];
    const api = fakeApi(workspaces);

    await expect(resolveWorkspaceId(api)).rejects.toBeInstanceOf(WorkspaceResolutionError);
    await expect(resolveWorkspaceId(api)).rejects.toMatchObject({
      code: 'WORKSPACE_REQUIRED',
      availableWorkspaces: workspaces,
    });
  });
});

describe('resolveProjectId', () => {
  it('accepts a project that belongs to the workspace', async () => {
    const api = fakeApi([workspace], projects);

    await expect(resolveProjectId(api, 7, 300)).resolves.toBe(300);
    expect(api.getProjects).toHaveBeenCalledWith(7, { includeArchived: true, refresh: false });
  });

  it('returns undefined without listing projects when no project is selected', async () => {
    const api = fakeApi([workspace], projects);

    await expect(resolveProjectId(api, 7, undefined)).resolves.toBeUndefined();
    expect(api.getProjects).not.toHaveBeenCalled();
  });

  it('rejects a project that does not belong to the workspace with a single request', async () => {
    const api = fakeApi([workspace], projects);

    const error = await resolveProjectId(api, 7, 301).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProjectValidationError);
    expect(error).toMatchObject({
      code: 'INVALID_PROJECT_ID',
      projectId: 301,
      workspaceId: 7,
      source: 'argument',
      availableProjects: [{ id: 300, name: 'alpha' }],
    });
    expect(api.getProjects).toHaveBeenCalledTimes(1);
  });

  it('refreshes a stale cached list once before rejecting', async () => {
    const getProjects = vi.fn().mockResolvedValueOnce(projects);
    const api = {
      getWorkspaces: vi.fn().mockResolvedValue([workspace]),
      getCachedProjects: vi.fn().mockReturnValue([]),
      getProjects,
    } as unknown as TogglAPI;

    await expect(resolveProjectId(api, 7, 300)).resolves.toBe(300);
    expect(getProjects).toHaveBeenCalledTimes(1);
    expect(getProjects).toHaveBeenCalledWith(7, { includeArchived: true, refresh: true });
  });

  it('makes a single authoritative request when the list was not cached', async () => {
    const getProjects = vi.fn().mockResolvedValue(projects);
    const api = {
      getWorkspaces: vi.fn().mockResolvedValue([workspace]),
      getCachedProjects: vi.fn().mockReturnValue(undefined),
      getProjects,
    } as unknown as TogglAPI;

    await expect(resolveProjectId(api, 7, 300)).resolves.toBe(300);
    expect(getProjects).toHaveBeenCalledTimes(1);
    expect(getProjects).toHaveBeenCalledWith(7, { includeArchived: true, refresh: false });
  });
});

describe('resolveWorkspaceForEntry', () => {
  it('verifies an explicit workspace id without loading the entry', async () => {
    const api = fakeApi([workspace], [], { id: 42, workspace_id: 9 });

    await expect(resolveWorkspaceForEntry(api, 42, 7)).resolves.toBe(7);
    expect(api.getTimeEntry).not.toHaveBeenCalled();
  });

  it('loads the entry and verifies its workspace when no id is given', async () => {
    const api = fakeApi([workspace], [], { id: 42, workspace_id: 7 });

    await expect(resolveWorkspaceForEntry(api, 42)).resolves.toBe(7);
    expect(api.getTimeEntry).toHaveBeenCalledWith(42);
  });

  it('rejects an inaccessible explicit id without loading the entry', async () => {
    const api = fakeApi([workspace], [], { id: 42, workspace_id: 7 });

    await expect(resolveWorkspaceForEntry(api, 42, 4242)).rejects.toBeInstanceOf(
      WorkspaceValidationError
    );
    expect(api.getTimeEntry).not.toHaveBeenCalled();
  });
});

describe('resolveEntryScope', () => {
  it('returns a verified workspace/project pair', async () => {
    const api = fakeApi([workspace], projects);

    await expect(resolveEntryScope(api, { workspace_id: 7, project_id: 300 })).resolves.toEqual({
      workspaceId: 7,
      projectId: 300,
    });
  });

  it('fails on a project id supplied as workspace_id before any project lookup', async () => {
    const api = fakeApi([workspace], projects);

    await expect(
      resolveEntryScope(api, { workspace_id: 4242, project_id: 300 })
    ).rejects.toBeInstanceOf(WorkspaceValidationError);
    expect(api.getProjects).not.toHaveBeenCalled();
  });

  it('uses the configured project when project_id is omitted', async () => {
    const api = fakeApi([workspace], projects);

    await expect(resolveEntryScope(api, {}, { workspaceId: 7, projectId: 300 })).resolves.toEqual({
      workspaceId: 7,
      projectId: 300,
    });
  });

  it('uses the configured project when the caller repeats the configured workspace', async () => {
    const api = fakeApi([workspace], projects);

    await expect(
      resolveEntryScope(api, { workspace_id: 7 }, { workspaceId: 7, projectId: 300 })
    ).resolves.toEqual({ workspaceId: 7, projectId: 300 });
  });

  it('prefers an explicit project over the configured one', async () => {
    const api = fakeApi([workspace], projects);

    await expect(
      resolveEntryScope(api, { project_id: 300 }, { workspaceId: 7, projectId: 999 })
    ).resolves.toEqual({ workspaceId: 7, projectId: 300 });
  });

  it('rejects a stale configured project with advice naming the credentials file', async () => {
    const api = fakeApi([workspace], projects);

    const error = await resolveEntryScope(api, {}, { workspaceId: 7, projectId: 301 }).catch(
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(ProjectValidationError);
    expect(error).toMatchObject({ code: 'INVALID_PROJECT_ID', source: 'configuration' });
    expect((error as Error).message).toMatch(/configuration file/);
  });

  it('does not apply the configured project in another workspace', async () => {
    const other: Workspace = { id: 9, name: 'nine' };
    const api = {
      getWorkspaces: vi.fn().mockResolvedValue([workspace, other]),
      getCachedProjects: vi.fn().mockReturnValue(undefined),
      getProjects: vi.fn().mockResolvedValue([]),
    } as unknown as TogglAPI;

    await expect(
      resolveEntryScope(api, { workspace_id: 9 }, { workspaceId: 7, projectId: 300 })
    ).resolves.toStrictEqual({ workspaceId: 9, projectId: undefined });
    expect(api.getProjects).not.toHaveBeenCalled();
  });

  it('applies a project-only default in the workspace that owns it', async () => {
    const api = fakeApi([workspace], projects);

    await expect(resolveEntryScope(api, { workspace_id: 7 }, { projectId: 300 })).resolves.toEqual({
      workspaceId: 7,
      projectId: 300,
    });
  });

  it('flags a project-only default that does not fit the resolved workspace', async () => {
    const other: Workspace = { id: 9, name: 'nine' };
    const api = {
      getWorkspaces: vi.fn().mockResolvedValue([workspace, other]),
      getCachedProjects: vi.fn().mockReturnValue(undefined),
      getProjects: vi.fn().mockResolvedValue([]),
    } as unknown as TogglAPI;

    await expect(
      resolveEntryScope(api, { workspace_id: 9 }, { projectId: 300 })
    ).resolves.toStrictEqual({ workspaceId: 9, projectId: undefined, defaultProjectSkipped: true });
    expect(api.getProjects).toHaveBeenCalledTimes(1);
  });

  it('does not swallow a project lookup failure when the default is only a hint', async () => {
    const api = {
      getWorkspaces: vi.fn().mockResolvedValue([workspace]),
      getCachedProjects: vi.fn().mockReturnValue(undefined),
      getProjects: vi.fn().mockRejectedValue(new Error('projects unavailable')),
    } as unknown as TogglAPI;

    await expect(resolveEntryScope(api, {}, { projectId: 300 })).rejects.toThrow(
      'projects unavailable'
    );
  });

  it('still resolves no project when none is configured', async () => {
    const api = fakeApi([workspace], projects);

    await expect(resolveEntryScope(api, {})).resolves.toStrictEqual({
      workspaceId: 7,
      projectId: undefined,
    });
    expect(api.getProjects).not.toHaveBeenCalled();
  });
});
