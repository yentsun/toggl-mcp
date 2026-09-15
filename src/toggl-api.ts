import { TtlCache } from './cache.js';
import type {
  Client,
  CreateTimeEntryInput,
  Project,
  TimeEntry,
  TogglUser,
  Workspace,
} from './types.js';

export const API_BASE_URL = 'https://api.track.toggl.com/api/v9';
const USER_AGENT = 'yt-toggl-mcp/0.1.0';
const DEFAULT_CACHE_TTL_MS = 3_600_000;

export class TogglAPIError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number
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
      const retryAfter = Number(response.headers.get('retry-after'));
      const detail = await response.text().catch(() => '');
      throw new TogglAPIError(
        response.status,
        codeForStatus(response.status),
        `Toggl API ${response.status} ${response.statusText}${detail ? `: ${detail.slice(0, 300)}` : ''}`,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined
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

  async getTimeEntries(start?: Date, end?: Date): Promise<TimeEntry[]> {
    const params = new URLSearchParams();
    if (start) params.set('start_date', start.toISOString());
    if (end) params.set('end_date', end.toISOString());
    const query = params.toString();

    return this.request<TimeEntry[]>({
      method: 'GET',
      path: `/me/time_entries${query ? `?${query}` : ''}`,
    });
  }

  async startTimeEntry(workspaceId: number, input: CreateTimeEntryInput = {}): Promise<TimeEntry> {
    const startedAt = new Date();

    return this.request<TimeEntry>({
      method: 'POST',
      path: `/workspaces/${workspaceId}/time_entries`,
      body: {
        created_with: 'yt-toggl-mcp',
        description: input.description ?? '',
        start: startedAt.toISOString(),
        // Toggl represents a running entry with a negative unix timestamp.
        duration: -1 * Math.floor(startedAt.getTime() / 1000),
        workspace_id: workspaceId,
        ...(input.project_id !== undefined ? { project_id: input.project_id } : {}),
        ...(input.tags ? { tags: input.tags } : {}),
        ...(input.billable !== undefined ? { billable: input.billable } : {}),
      },
    });
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
    case 429:
      return 'RATE_LIMITED';
    default:
      return status >= 500 ? 'SERVER_ERROR' : 'REQUEST_FAILED';
  }
}
