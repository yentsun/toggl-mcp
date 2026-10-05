import { describe, expect, it, vi } from 'vitest';
import {
  ProjectValidationError,
  WorkspaceResolutionError,
  WorkspaceValidationError,
  parseWorkspaceId,
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
    getTimeEntry: vi.fn().mockResolvedValue(entry),
  } as unknown as TogglAPI;
}

const workspace: Workspace = { id: 7, name: 'seven' };
const projects: Project[] = [
  { id: 300, workspace_id: 7, client_id: null, name: 'alpha', active: true },
];

describe('parseWorkspaceId', () => {
  it('accepts positive integers as number or numeric string', () => {
    expect(parseWorkspaceId(42)).toBe(42);
    expect(parseWorkspaceId('42')).toBe(42);
    expect(parseWorkspaceId(' 42 ')).toBe(42);
  });

  it('rejects invalid values', () => {
    expect(parseWorkspaceId(0)).toBeUndefined();
    expect(parseWorkspaceId(-1)).toBeUndefined();
    expect(parseWorkspaceId('abc')).toBeUndefined();
    expect(parseWorkspaceId('')).toBeUndefined();
    expect(parseWorkspaceId(undefined)).toBeUndefined();
    expect(parseWorkspaceId(1.5)).toBeUndefined();
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
    expect(api.getProjects).toHaveBeenCalledWith(7);
  });

  it('returns undefined without listing projects when no project is selected', async () => {
    const api = fakeApi([workspace], projects);

    await expect(resolveProjectId(api, 7, undefined)).resolves.toBeUndefined();
    expect(api.getProjects).not.toHaveBeenCalled();
  });

  it('rejects a project that does not belong to the workspace', async () => {
    const api = fakeApi([workspace], projects);

    const error = await resolveProjectId(api, 7, 301).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProjectValidationError);
    expect(error).toMatchObject({
      code: 'INVALID_PROJECT_ID',
      projectId: 301,
      workspaceId: 7,
      availableProjects: [{ id: 300, name: 'alpha' }],
    });
  });

  it('refreshes the project list once when the cached list misses the project', async () => {
    const getProjects = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce(projects);
    const api = {
      getWorkspaces: vi.fn().mockResolvedValue([workspace]),
      getProjects,
    } as unknown as TogglAPI;

    await expect(resolveProjectId(api, 7, 300)).resolves.toBe(300);
    expect(getProjects).toHaveBeenNthCalledWith(1, 7);
    expect(getProjects).toHaveBeenNthCalledWith(2, 7, { refresh: true });
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
});
