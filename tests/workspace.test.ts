import { describe, expect, it, vi } from 'vitest';
import {
  WorkspaceResolutionError,
  parseWorkspaceId,
  resolveWorkspaceId,
} from '../src/workspace.js';
import type { TogglAPI } from '../src/toggl-api.js';
import type { Workspace } from '../src/types.js';

function fakeApi(workspaces: Workspace[]): TogglAPI {
  return { getWorkspaces: vi.fn().mockResolvedValue(workspaces) } as unknown as TogglAPI;
}

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
  it('prefers the explicit id without calling the API', async () => {
    const api = fakeApi([]);
    await expect(resolveWorkspaceId(api, 7, 9)).resolves.toBe(7);
    expect(api.getWorkspaces).not.toHaveBeenCalled();
  });

  it('uses the configured fallback', async () => {
    const api = fakeApi([]);
    await expect(resolveWorkspaceId(api, undefined, 9)).resolves.toBe(9);
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
