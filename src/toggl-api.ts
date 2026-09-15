import { TtlCache } from './cache.js';
import type {
  Client,
  CreateTimeEntryInput,
  Project,
  QuotaBucket,
  Tag,
  TimeEntry,
  TimeEntryQuery,
  TimeEntryWriteInput,
  TogglUser,
  UpdateTimeEntryInput,
  Workspace,
} from './types.js';

export const API_BASE_URL = 'https://api.track.toggl.com/api/v9';
const USER_AGENT = 'yt-toggl-mcp/0.3.0';
const DEFAULT_CACHE_TTL_MS = 3_600_000;

export class TogglAPIError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number,
    readonly quotaRemaining?: number,
    readonly quotaResetsIn?: number
  ) {
    super(message);
    this.name = 'TogglAPIError';
  }
}

interface RequestOptions {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  body?: unknown;
}

function optionalNumber(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export class TogglAPI {
  private readonly headers: Record<string, string>;
  private readonly cache: TtlCache;

  constructor(apiKey: string, cacheTtlMs: number = DEFAULT_CACHE_TTL_MS) {
    const token = apiKey.trim();
    if (!token) throw new Error('TogglAPI requires a non-empty API token');

    // HTTP Basic: API token as username, literal "api_token" as password.
    const auth = Buffer.from(`${token}:api_token`).toString('base64');
    this.headers = {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    };
    this.cache = new TtlCache(cacheTtlMs);
  }

  private async request<T>({ method, path, body }: RequestOptions): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${API_BASE_URL}${path}`, {
        method,
        headers: this.headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new TogglAPIError(0, 'NETWORK_ERROR', `Failed to reach the Toggl API: ${reason}`);
    }

    if (!response.ok) {
      const retryAfter = optionalNumber(response.headers.get('retry-after'));
      const quotaRemaining = optionalNumber(response.headers.get('x-toggl-quota-remaining'));
      const quotaResetsIn = optionalNumber(response.headers.get('x-toggl-quota-resets-in'));
      const detail = await response.text().catch(() => '');
      throw new TogglAPIError(
        response.status,
        codeForStatus(response.status),
        `Toggl API ${response.status} ${response.statusText}${detail ? `: ${detail.slice(0, 300)}` : ''}`,
        retryAfter,
        quotaRemaining,
        quotaResetsIn
      );
    }

    if (response.status === 204) return undefined as T;

    const text = await response.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  async getMe(): Promise<TogglUser> {
    return this.request<TogglUser>({ method: 'GET', path: '/me' });
  }

  async getQuota(): Promise<QuotaBucket[]> {
    return this.request<QuotaBucket[]>({ method: 'GET', path: '/me/quota' });
  }

  async getWorkspaces(): Promise<Workspace[]> {
    const cached = this.cache.get<Workspace[]>('workspaces');
    if (cached) return cached;

    const workspaces = await this.request<Workspace[]>({ method: 'GET', path: '/workspaces' });
    this.cache.set('workspaces', workspaces);
    return workspaces;
  }

  async getCurrentTimeEntry(): Promise<TimeEntry | null> {
    return this.request<TimeEntry | null>({ method: 'GET', path: '/me/time_entries/current' });
  }

  async getTimeEntry(entryId: number): Promise<TimeEntry> {
    return this.request<TimeEntry>({ method: 'GET', path: `/me/time_entries/${entryId}` });
  }

  async getTimeEntries(query: TimeEntryQuery = {}): Promise<TimeEntry[]> {
    const params = new URLSearchParams();
    if (query.start) params.set('start_date', query.start.toISOString());
    if (query.end) params.set('end_date', query.end.toISOString());
    if (query.since !== undefined) params.set('since', String(query.since));
    if (query.before !== undefined) params.set('before', query.before);
    if (query.meta !== undefined) params.set('meta', String(query.meta));
    const search = params.toString();

    return this.request<TimeEntry[]>({
      method: 'GET',
      path: `/me/time_entries${search ? `?${search}` : ''}`,
    });
  }

  private timeEntryBody(
    input: TimeEntryWriteInput,
    workspaceId: number,
    mode: 'create' | 'update'
  ): Record<string, unknown> {
    // Toggl requires `start` on creation. Default it before deriving duration so a
    // completed create like { duration: 3600 } does not go out without a start time.
    const start = input.start ?? (mode === 'create' ? new Date().toISOString() : undefined);

    const body: Record<string, unknown> = {
      created_with: 'yt-toggl-mcp',
      workspace_id: workspaceId,
    };

    if (start !== undefined) body.start = start;
    if (input.start_date !== undefined) body.start_date = input.start_date;
    if (input.description !== undefined) body.description = input.description;
    if (input.project_id !== undefined) body.project_id = input.project_id;
    if (input.task_id !== undefined) body.task_id = input.task_id;
    if (input.tags !== undefined) body.tags = input.tags;
    if (input.billable !== undefined) body.billable = input.billable;
    if (input.stop !== undefined) body.stop = input.stop;

    if (input.duration !== undefined) {
      body.duration = input.duration;
    } else if (typeof input.stop === 'string' && start !== undefined) {
      const duration = Math.round((Date.parse(input.stop) - Date.parse(start)) / 1000);
      if (Number.isFinite(duration)) body.duration = duration;
    } else if (input.stop === undefined && mode === 'create') {
      // A new entry with no stop is a running timer: Toggl uses a negative timestamp.
      body.duration = -1 * Math.floor(Date.now() / 1000);
    }

    return body;
  }

  async createTimeEntry(
    workspaceId: number,
    input: CreateTimeEntryInput = {}
  ): Promise<TimeEntry> {
    return this.request<TimeEntry>({
      method: 'POST',
      path: `/workspaces/${workspaceId}/time_entries`,
      body: this.timeEntryBody(input, workspaceId, 'create'),
    });
  }

  async updateTimeEntry(
    workspaceId: number,
    entryId: number,
    input: UpdateTimeEntryInput
  ): Promise<TimeEntry> {
    return this.request<TimeEntry>({
      method: 'PUT',
      path: `/workspaces/${workspaceId}/time_entries/${entryId}`,
      body: this.timeEntryBody(input, workspaceId, 'update'),
    });
  }

  async deleteTimeEntry(workspaceId: number, entryId: number): Promise<void> {
    await this.request<void>({
      method: 'DELETE',
      path: `/workspaces/${workspaceId}/time_entries/${entryId}`,
    });
  }

  async startTimeEntry(workspaceId: number, input: CreateTimeEntryInput = {}): Promise<TimeEntry> {
    return this.createTimeEntry(workspaceId, input);
  }

  async stopTimeEntry(workspaceId: number, entryId: number): Promise<TimeEntry> {
    return this.request<TimeEntry>({
      method: 'PATCH',
      path: `/workspaces/${workspaceId}/time_entries/${entryId}/stop`,
    });
  }

  async getProjects(workspaceId: number): Promise<Project[]> {
    const key = `projects:${workspaceId}`;
    const cached = this.cache.get<Project[]>(key);
    if (cached) return cached;

    const projects = await this.request<Project[]>({
      method: 'GET',
      path: `/workspaces/${workspaceId}/projects`,
    });
    this.cache.set(key, projects);
    return projects;
  }

  async getClients(workspaceId: number): Promise<Client[]> {
    const key = `clients:${workspaceId}`;
    const cached = this.cache.get<Client[]>(key);
    if (cached) return cached;

    const clients = await this.request<Client[]>({
      method: 'GET',
      path: `/workspaces/${workspaceId}/clients`,
    });
    this.cache.set(key, clients);
    return clients;
  }

  async getTags(workspaceId: number): Promise<Tag[]> {
    const key = `tags:${workspaceId}`;
    const cached = this.cache.get<Tag[]>(key);
    if (cached) return cached;

    const tags = await this.request<Tag[]>({
      method: 'GET',
      path: `/workspaces/${workspaceId}/tags`,
    });
    this.cache.set(key, tags);
    return tags;
  }

  get cacheSize(): number {
    return this.cache.size;
  }
}

function codeForStatus(status: number): string {
  switch (status) {
    case 401:
      return 'UNAUTHORIZED';
    case 402:
      return 'QUOTA_EXCEEDED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 410:
      return 'GONE';
    case 429:
      return 'RATE_LIMITED';
    default:
      return status >= 500 ? 'SERVER_ERROR' : 'REQUEST_FAILED';
  }
}
