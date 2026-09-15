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

    await api.getTimeEntries(new Date('2026-09-01T00:00:00.000Z'), new Date('2026-09-08T00:00:00.000Z'));

    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      `${API_BASE_URL}/me/time_entries?start_date=2026-09-01T00%3A00%3A00.000Z&end_date=2026-09-08T00%3A00%3A00.000Z`
    );
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
