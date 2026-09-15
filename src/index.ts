#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { config } from 'dotenv';
import { z } from 'zod';
import { maskEmail, publicWorkspaces } from './format.js';
import { TogglAPI, TogglAPIError } from './toggl-api.js';
import { WorkspaceResolutionError, parseWorkspaceId, resolveWorkspaceId } from './workspace.js';
import { PERIODS, rangeFromInput, roundHours, summarizeByProject } from './utils.js';

const VERSION = '0.1.0';

const argv = process.argv.slice(2);
if (argv.includes('--version') || argv.includes('-v')) {
  console.error(`yt-toggl-mcp ${VERSION}`);
  process.exit(0);
}
if (argv.includes('--help') || argv.includes('-h')) {
  console.error(
    `yt-toggl-mcp - Toggl Track MCP server\n\n` +
      `Usage: node dist/index.js [--help] [--version]\n\n` +
      `Environment:\n` +
      `  TOGGL_API_KEY                Required Toggl Track API token\n` +
      `  TOGGL_DEFAULT_WORKSPACE_ID   Optional default workspace id\n` +
      `  TOGGL_CACHE_TTL              Metadata cache TTL in ms (default: 3600000)\n`
  );
  process.exit(0);
}

config({ quiet: true });

const API_KEY = (process.env.TOGGL_API_KEY ?? '').trim();
if (!API_KEY) {
  console.error('Missing required environment variable: TOGGL_API_KEY');
  process.exit(1);
}

const DEFAULT_WORKSPACE_ID = parseWorkspaceId(process.env.TOGGL_DEFAULT_WORKSPACE_ID);
const parsedTtl = Number.parseInt(process.env.TOGGL_CACHE_TTL ?? '', 10);
const CACHE_TTL_MS = Number.isFinite(parsedTtl) ? parsedTtl : 3_600_000;

const api = new TogglAPI(API_KEY, CACHE_TTL_MS);
const server = new McpServer({ name: 'yt-toggl-mcp', version: VERSION });

type ToolResult = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
};

function ok(data: unknown): ToolResult {
  return {
    content: [
      { type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) },
    ],
  };
}

function fail(error: unknown): ToolResult {
  const payload: Record<string, unknown> = {
    error: true,
    message: error instanceof Error ? error.message : 'Unknown error',
  };

  if (error instanceof TogglAPIError) {
    payload.code = error.code;
    payload.status = error.status;
    if (error.retryAfterSeconds !== undefined) {
      payload.retry_after_seconds = error.retryAfterSeconds;
    }
  }
  if (error instanceof WorkspaceResolutionError) {
    payload.code = error.code;
    payload.available_workspaces = error.availableWorkspaces;
  }

  return { isError: true, ...ok(payload) };
}

const periodSchema = z.enum(PERIODS as unknown as [string, ...string[]]);

server.registerTool(
  'toggl_check_auth',
  {
    title: 'Check Toggl authentication',
    description:
      'Verify the Toggl API token and list accessible workspaces. The account email is masked.',
    inputSchema: {},
  },
  async () => {
    try {
      const [me, workspaces] = await Promise.all([api.getMe(), api.getWorkspaces()]);
      return ok({
        authenticated: true,
        user: { id: me.id, fullname: me.fullname, email: maskEmail(me.email) },
        workspaces: publicWorkspaces(workspaces),
      });
    } catch (error) {
      return fail(error);
    }
  }
);

server.registerTool(
  'toggl_list_workspaces',
  {
    title: 'List workspaces',
    description: 'List all Toggl workspaces accessible with the configured token.',
    inputSchema: {},
  },
  async () => {
    try {
      return ok(publicWorkspaces(await api.getWorkspaces()));
    } catch (error) {
      return fail(error);
    }
  }
);

server.registerTool(
  'toggl_get_current_entry',
  {
    title: 'Get running timer',
    description:
      'Return the currently running time entry (with elapsed seconds), or running:false if no timer is active.',
    inputSchema: {},
  },
  async () => {
    try {
      const entry = await api.getCurrentTimeEntry();
      if (!entry) return ok({ running: false });
      const elapsed = Math.max(0, Math.round((Date.now() - new Date(entry.start).getTime()) / 1000));
      return ok({ running: true, entry, elapsed_seconds: elapsed });
    } catch (error) {
      return fail(error);
    }
  }
);

server.registerTool(
  'toggl_get_time_entries',
  {
    title: 'Get time entries',
    description:
      'List time entries for a named period or an explicit start_date/end_date range (YYYY-MM-DD, inclusive).',
    inputSchema: {
      period: periodSchema.optional(),
      start_date: z.string().optional(),
      end_date: z.string().optional(),
    },
  },
  async ({ period, start_date, end_date }) => {
    try {
      const range = rangeFromInput({
        period: period as (typeof PERIODS)[number] | undefined,
        start_date,
        end_date,
      });
      const entries = await api.getTimeEntries(range.start, range.end);
      const totalSeconds = entries.reduce((sum, entry) => {
        const duration = entry.duration >= 0 ? entry.duration : 0;
        return sum + duration;
      }, 0);
      return ok({
        start: range.start.toISOString(),
        end: range.end.toISOString(),
        count: entries.length,
        completed_seconds: totalSeconds,
        entries,
      });
    } catch (error) {
      return fail(error);
    }
  }
);

server.registerTool(
  'toggl_start_timer',
  {
    title: 'Start timer',
    description: 'Start a new running time entry with an optional description, project, and tags.',
    inputSchema: {
      description: z.string().optional(),
      project_id: z.number().int().positive().optional(),
      workspace_id: z.number().int().positive().optional(),
      tags: z.array(z.string()).optional(),
      billable: z.boolean().optional(),
    },
  },
  async ({ description, project_id, workspace_id, tags, billable }) => {
    try {
      const resolved = await resolveWorkspaceId(api, workspace_id, DEFAULT_WORKSPACE_ID);
      const entry = await api.startTimeEntry(resolved, {
        description,
        project_id,
        tags,
        billable,
      });
      return ok({ started: true, entry });
    } catch (error) {
      return fail(error);
    }
  }
);

server.registerTool(
  'toggl_stop_timer',
  {
    title: 'Stop timer',
    description:
      'Stop the running time entry. Defaults to the currently running entry; pass entry_id to stop a specific one.',
    inputSchema: {
      entry_id: z.number().int().positive().optional(),
      workspace_id: z.number().int().positive().optional(),
    },
  },
  async ({ entry_id, workspace_id }) => {
    try {
      let targetId = entry_id;
      let targetWorkspace = workspace_id;

      if (targetId === undefined) {
        const current = await api.getCurrentTimeEntry();
        if (!current) return ok({ stopped: false, reason: 'No timer is running.' });
        targetId = current.id;
        targetWorkspace = targetWorkspace ?? current.workspace_id;
      }

      const resolved = await resolveWorkspaceId(api, targetWorkspace, DEFAULT_WORKSPACE_ID);
      const entry = await api.stopTimeEntry(resolved, targetId);
      return ok({ stopped: true, entry });
    } catch (error) {
      return fail(error);
    }
  }
);

server.registerTool(
  'toggl_list_projects',
  {
    title: 'List projects',
    description: 'List projects in a workspace (defaults to TOGGL_DEFAULT_WORKSPACE_ID).',
    inputSchema: {
      workspace_id: z.number().int().positive().optional(),
    },
  },
  async ({ workspace_id }) => {
    try {
      const resolved = await resolveWorkspaceId(api, workspace_id, DEFAULT_WORKSPACE_ID);
      return ok(await api.getProjects(resolved));
    } catch (error) {
      return fail(error);
    }
  }
);

server.registerTool(
  'toggl_list_clients',
  {
    title: 'List clients',
    description: 'List clients in a workspace (defaults to TOGGL_DEFAULT_WORKSPACE_ID).',
    inputSchema: {
      workspace_id: z.number().int().positive().optional(),
    },
  },
  async ({ workspace_id }) => {
    try {
      const resolved = await resolveWorkspaceId(api, workspace_id, DEFAULT_WORKSPACE_ID);
      return ok(await api.getClients(resolved));
    } catch (error) {
      return fail(error);
    }
  }
);

server.registerTool(
  'toggl_report',
  {
    title: 'Time report',
    description:
      'Total tracked time for a period or date range, grouped by project (sorted by hours).',
    inputSchema: {
      period: periodSchema.optional(),
      start_date: z.string().optional(),
      end_date: z.string().optional(),
      workspace_id: z.number().int().positive().optional(),
    },
  },
  async ({ period, start_date, end_date, workspace_id }) => {
    try {
      const range = rangeFromInput({
        period: period as (typeof PERIODS)[number] | undefined,
        start_date,
        end_date,
      });
      const entries = await api.getTimeEntries(range.start, range.end);

      const resolvedWorkspace = workspace_id ?? DEFAULT_WORKSPACE_ID;
      const projectNames = new Map<number, string>();
      if (resolvedWorkspace) {
        const projects = await api.getProjects(resolvedWorkspace);
        for (const project of projects) projectNames.set(project.id, project.name);
      }

      const byProject = summarizeByProject(entries, projectNames);
      const totalSeconds = byProject.reduce((sum, row) => sum + row.seconds, 0);

      return ok({
        start: range.start.toISOString(),
        end: range.end.toISOString(),
        entries: entries.length,
        total_seconds: totalSeconds,
        total_hours: roundHours(totalSeconds),
        by_project: byProject,
      });
    } catch (error) {
      return fail(error);
    }
  }
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('yt-toggl-mcp server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
