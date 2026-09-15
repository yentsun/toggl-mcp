import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_BASE_URL, TogglAPI, TogglAPIError } from '../src/toggl-api.js';

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {}
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TogglAPI', () => {
  it('rejects an empty token', () => {
    expect(() => new TogglAPI('   ')).toThrow(/non-empty/);
  });

  it('sends Basic auth with the token and the literal api_token password', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 1, email: 'a@b.co', fullname: 'A' }));
    const api = new TogglAPI('secret');

    await api.getMe();

    const [url, init] = fetchMock.mock.calls[0]!;
    const expected = Buffer.from('secret:api_token').toString('base64');
    expect(url).toBe(`${API_BASE_URL}/me`);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${expected}`);
    expect((init.headers as Record<string, string>)['User-Agent']).toMatch(/^yt-toggl-mcp\//);
  });

  it('caches workspaces across calls', async () => {
    fetchMock.mockResolvedValue(jsonResponse([{ id: 5, name: 'ws' }]));
    const api = new TogglAPI('secret');

    await api.getWorkspaces();
    await api.getWorkspaces();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(api.cacheSize).toBe(1);
  });

  it('adds start/end date query params to time entry requests', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    const api = new TogglAPI('secret');

    await api.getTimeEntries({
      start: new Date('2026-09-01T00:00:00.000Z'),
      end: new Date('2026-09-08T00:00:00.000Z'),
    });

    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      `${API_BASE_URL}/me/time_entries?start_date=2026-09-01T00%3A00%3A00.000Z&end_date=2026-09-08T00%3A00%3A00.000Z`
    );
  });

  it('supports since/before/meta filters', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    const api = new TogglAPI('secret');

    await api.getTimeEntries({ since: 1700000000, before: '2026-09-08', meta: true });

    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      `${API_BASE_URL}/me/time_entries?since=1700000000&before=2026-09-08&meta=true`
    );
  });

  it('loads a single time entry by id', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 42 }));
    const api = new TogglAPI('secret');

    await api.getTimeEntry(42);

    expect(fetchMock.mock.calls[0]![0]).toBe(`${API_BASE_URL}/me/time_entries/42`);
  });

  it('derives duration from start/stop for a completed entry', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 1 }));
    const api = new TogglAPI('secret');

    await api.createTimeEntry(5, {
      description: 'done',
      start: '2026-09-15T09:00:00.000Z',
      stop: '2026-09-15T10:30:00.000Z',
    });

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.duration).toBe(5400);
    expect(body.stop).toBe('2026-09-15T10:30:00.000Z');
  });

  it('updates an entry with PUT and omits an absent start', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 7 }));
    const api = new TogglAPI('secret');

    await api.updateTimeEntry(5, 7, { description: 'renamed', project_id: 3 });

    const [url, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(init.body as string);
    expect(url).toBe(`${API_BASE_URL}/workspaces/5/time_entries/7`);
    expect(init.method).toBe('PUT');
    expect(body).toMatchObject({ workspace_id: 5, description: 'renamed', project_id: 3 });
    expect(body).not.toHaveProperty('start');
    expect(body).not.toHaveProperty('duration');
  });

  it('deletes an entry with DELETE', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const api = new TogglAPI('secret');

    await api.deleteTimeEntry(5, 7);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${API_BASE_URL}/workspaces/5/time_entries/7`);
    expect(init.method).toBe('DELETE');
  });

  it('caches tags per workspace', async () => {
    fetchMock.mockResolvedValue(jsonResponse([{ id: 1, workspace_id: 5, name: 'a' }]));
    const api = new TogglAPI('secret');

    await api.getTags(5);
    await api.getTags(5);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(`${API_BASE_URL}/workspaces/5/tags`);
  });

  it('loads the API quota', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse([{ organization_id: 1, remaining: 10, total: 30, resets_in_secs: 60 }])
    );
    const api = new TogglAPI('secret');

    expect(await api.getQuota()).toHaveLength(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(`${API_BASE_URL}/me/quota`);
  });

  it('surfaces quota headers on 402 responses', async () => {
    fetchMock.mockResolvedValue(
      new Response('quota', {
        status: 402,
        headers: { 'x-toggl-quota-remaining': '0', 'x-toggl-quota-resets-in': '120' },
      })
    );
    const api = new TogglAPI('secret');

    const error = await api.getQuota().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TogglAPIError);
    expect(error).toMatchObject({
      status: 402,
      code: 'QUOTA_EXCEEDED',
      quotaRemaining: 0,
      quotaResetsIn: 120,
    });
  });

  it('creates a running time entry with a negative duration', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 99 }));
    const api = new TogglAPI('secret');

    await api.startTimeEntry(5, { description: 'work', project_id: 3, tags: ['a'] });

    const [url, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(init.body as string);
    expect(url).toBe(`${API_BASE_URL}/workspaces/5/time_entries`);
    expect(body).toMatchObject({
      workspace_id: 5,
      description: 'work',
      project_id: 3,
      tags: ['a'],
      created_with: 'yt-toggl-mcp',
    });
    expect(body.duration).toBeLessThan(0);
  });

  it('stops an entry via the workspace stop endpoint', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 7 }));
    const api = new TogglAPI('secret');

    await api.stopTimeEntry(5, 7);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${API_BASE_URL}/workspaces/5/time_entries/7/stop`);
    expect(init.method).toBe('PATCH');
  });

  it('maps HTTP errors to typed errors with a code', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 401 }));
    const api = new TogglAPI('secret');

    await expect(api.getMe()).rejects.toMatchObject({
      name: 'TogglAPIError',
      status: 401,
      code: 'UNAUTHORIZED',
    });
  });

  it('exposes Retry-After seconds on rate limits', async () => {
    fetchMock.mockResolvedValue(
      new Response('slow down', { status: 429, headers: { 'retry-after': '30' } })
    );
    const api = new TogglAPI('secret');

    const error = await api.getMe().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TogglAPIError);
    expect(error).toMatchObject({ status: 429, code: 'RATE_LIMITED', retryAfterSeconds: 30 });
  });
});
