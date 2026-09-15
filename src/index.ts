#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { config } from 'dotenv';
import { z } from 'zod';
import { maskEmail, publicWorkspaces } from './format.js';
import { TogglAPI, TogglAPIError } from './toggl-api.js';
import { WorkspaceResolutionError, parseWorkspaceId, resolveWorkspaceId } from './workspace.js';
import {
  PERIODS,
  filterEntriesByWorkspace,
  rangeFromInput,
  roundHours,
  summarizeByProject,
} from './utils.js';

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
    if (error.retryAfterSeconds !== undefined) payload.retry_after_seconds = error.retryAfterSeconds;
    if (error.quotaRemaining !== undefined) payload.quota_remaining = error.quotaRemaining;
    if (error.quotaResetsIn !== undefined) payload.quota_resets_in_seconds = error.quotaResetsIn;
  }
  if (error instanceof WorkspaceResolutionError) {
    payload.code = error.code;
    // Belt-and-braces: workspace payloads carry a workspace api_token.
    payload.available_workspaces = publicWorkspaces(error.availableWorkspaces);
  }

  return { isError: true, ...ok(payload) };
}

const periodSchema = z.enum(PERIODS as unknown as [string, ...string[]]);
const workspaceIdSchema = z.number().int().positive().optional();
const timeEntryIdSchema = z.number().int().positive();

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
  'toggl_get_quota',
  {
    title: 'Get API quota',
    description:
      'Remaining Toggl API requests and reset time per organization (slugging-window quota).',
    inputSchema: {},
  },
  async () => {
    try {
      return ok(await api.getQuota());
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
      const elapsed = Math.max(
        0,
        Math.round((Date.now() - new Date(entry.start).getTime()) / 1000)
      );
      return ok({ running: true, entry, elapsed_seconds: elapsed });
    } catch (error) {
      return fail(error);
    }
  }
);

server.registerTool(
  'toggl_get_time_entry',
  {
    title: 'Get a time entry',
    description: 'Load a single time entry by id.',
    inputSchema: { time_entry_id: timeEntryIdSchema },
  },
  async ({ time_entry_id }) => {
    try {
      return ok(await api.getTimeEntry(time_entry_id));
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
      'List time entries for a named period, an inclusive start_date/end_date range, or with since (unix seconds) / before (YYYY-MM-DD or RFC3339).',
    inputSchema: {
      period: periodSchema.optional(),
      start_date: z.string().optional(),
      end_date: z.string().optional(),
      since: z.number().int().optional(),
      before: z.string().optional(),
      meta: z.boolean().optional(),
    },
  },
  async ({ period, start_date, end_date, since, before, meta }) => {
    try {
      if (since !== undefined || before !== undefined) {
        const entries = await api.getTimeEntries({ since, before, meta });
        return ok({ count: entries.length, entries });
      }

      const range = rangeFromInput({
        period: period as (typeof PERIODS)[number] | undefined,
        start_date,
        end_date,
      });
      const entries = await api.getTimeEntries({ start: range.start, end: range.end, meta });
      const completedSeconds = entries.reduce(
        (sum, entry) => sum + (entry.duration >= 0 ? entry.duration : 0),
        0
      );
      return ok({
        start: range.start.toISOString(),
        end: range.end.toISOString(),
        count: entries.length,
        completed_seconds: completedSeconds,
        entries,
      });
    } catch (error) {
      return fail(error);
    }
  }
);

server.registerTool(
  'toggl_create_time_entry',
  {
    title: 'Create a time entry',
    description:
      'Create a completed or running time entry. Provide stop (or duration) for a completed entry; omit both to start a running timer.',
    inputSchema: {
      description: z.string().optional(),
      project_id: z.number().int().positive().optional(),
      task_id: z.number().int().positive().optional(),
      workspace_id: workspaceIdSchema,
      tags: z.array(z.string()).optional(),
      billable: z.boolean().optional(),
      start: z.string().optional(),
      stop: z.string().optional(),
      duration: z.number().int().optional(),
    },
  },
  async ({ description, project_id, task_id, workspace_id, tags, billable, start, stop, duration }) => {
    try {
      const resolved = await resolveWorkspaceId(api, workspace_id, DEFAULT_WORKSPACE_ID);
      const entry = await api.createTimeEntry(resolved, {
        description,
        project_id,
        task_id,
        tags,
        billable,
        start,
        stop,
        duration,
      });
      return ok({ created: true, entry });
    } catch (error) {
      return fail(error);
    }
  }
);

server.registerTool(
  'toggl_update_time_entry',
  {
    title: 'Update a time entry',
    description:
      'Edit an existing time entry (description, project, task, tags, billable, start, stop or duration). Only the fields you pass are changed.',
    inputSchema: {
      time_entry_id: timeEntryIdSchema,
      workspace_id: workspaceIdSchema,
      description: z.string().optional(),
      project_id: z.number().int().positive().optional(),
      task_id: z.number().int().positive().optional(),
      tags: z.array(z.string()).optional(),
      billable: z.boolean().optional(),
      start: z.string().optional(),
      stop: z.string().optional(),
      duration: z.number().int().optional(),
    },
  },
  async ({
    time_entry_id,
    workspace_id,
    description,
    project_id,
    task_id,
    tags,
    billable,
    start,
    stop,
    duration,
  }) => {
    try {
      const resolved =
        workspace_id ?? (await api.getTimeEntry(time_entry_id)).workspace_id;
      const entry = await api.updateTimeEntry(resolved, time_entry_id, {
        description,
        project_id,
        task_id,
        tags,
        billable,
        start,
        stop,
        duration,
      });
      return ok({ updated: true, entry });
    } catch (error) {
      return fail(error);
    }
  }
);

server.registerTool(
  'toggl_delete_time_entry',
  {
    title: 'Delete a time entry',
    description: 'Permanently delete a time entry by id.',
    inputSchema: {
      time_entry_id: timeEntryIdSchema,
      workspace_id: workspaceIdSchema,
    },
  },
  async ({ time_entry_id, workspace_id }) => {
    try {
      const resolved = workspace_id ?? (await api.getTimeEntry(time_entry_id)).workspace_id;
      await api.deleteTimeEntry(resolved, time_entry_id);
      return ok({ deleted: true, time_entry_id });
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
      workspace_id: workspaceIdSchema,
      tags: z.array(z.string()).optional(),
      billable: z.boolean().optional(),
    },
  },
  async ({ description, project_id, workspace_id, tags, billable }) => {
    try {
      const resolved = await resolveWorkspaceId(api, workspace_id, DEFAULT_WORKSPACE_ID);
      const entry = await api.startTimeEntry(resolved, { description, project_id, tags, billable });
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
      workspace_id: workspaceIdSchema,
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
      } else if (targetWorkspace === undefined) {
        // Resolve the workspace that actually owns the entry, not the default.
        targetWorkspace = (await api.getTimeEntry(targetId)).workspace_id;
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
    inputSchema: { workspace_id: workspaceIdSchema },
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
    inputSchema: { workspace_id: workspaceIdSchema },
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
  'toggl_list_tags',
  {
    title: 'List tags',
    description: 'List tags in a workspace (defaults to TOGGL_DEFAULT_WORKSPACE_ID).',
    inputSchema: { workspace_id: workspaceIdSchema },
  },
  async ({ workspace_id }) => {
    try {
      const resolved = await resolveWorkspaceId(api, workspace_id, DEFAULT_WORKSPACE_ID);
      return ok(await api.getTags(resolved));
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
      workspace_id: workspaceIdSchema,
    },
  },
  async ({ period, start_date, end_date, workspace_id }) => {
    try {
      const range = rangeFromInput({
        period: period as (typeof PERIODS)[number] | undefined,
        start_date,
        end_date,
      });
      const allEntries = await api.getTimeEntries({ start: range.start, end: range.end });

      const resolvedWorkspace = workspace_id ?? DEFAULT_WORKSPACE_ID;
      // The report is workspace-scoped; /me/time_entries returns every workspace.
      const entries = filterEntriesByWorkspace(allEntries, resolvedWorkspace);
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
