# yt-toggl-mcp

A small, self-hosted [MCP](https://modelcontextprotocol.io) server for **Toggl Track (API v9)**.
It runs over stdio and exposes time tracking, projects/clients, and reporting to any MCP client.

No telemetry. The only network egress is to `api.track.toggl.com`.

## Tools

| Tool | What it does |
| --- | --- |
| `toggl_check_auth` | Verify the token; returns the (masked) user and accessible workspaces. |
| `toggl_list_workspaces` | List accessible workspaces. |
| `toggl_get_current_entry` | Return the running timer with elapsed seconds. |
| `toggl_get_time_entries` | List entries for a `period` or an inclusive `start_date`/`end_date` range. |
| `toggl_start_timer` | Start a timer with optional description, project, tags. |
| `toggl_stop_timer` | Stop the running timer (or a specific `entry_id`). |
| `toggl_list_projects` | List projects in a workspace. |
| `toggl_list_clients` | List clients in a workspace. |
| `toggl_report` | Total time for a range, grouped by project, sorted by hours. |

`period` accepts `today`, `yesterday`, `week`, `lastWeek`, `month`, `lastMonth`. Ranges are
interpreted in local time and `end_date` is inclusive at the tool boundary.

## Configuration

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `TOGGL_API_KEY` | yes | — | Toggl Track API token ([track.toggl.com/profile](https://track.toggl.com/profile)). |
| `TOGGL_DEFAULT_WORKSPACE_ID` | no | auto if a single workspace | Default workspace for workspace-scoped tools. |
| `TOGGL_CACHE_TTL` | no | `3600000` | Metadata cache TTL in ms. |

### opencode

```jsonc
{
  "mcp": {
    "toggl": {
      "type": "local",
      "command": ["node", "/abs/path/to/toggl-mcp/dist/index.js"],
      "environment": {
        "TOGGL_API_KEY": "{env:TOGGL_API_KEY}",
        "TOGGL_DEFAULT_WORKSPACE_ID": "{env:TOGGL_DEFAULT_WORKSPACE_ID}"
      }
    }
  }
}
```

## Development

```bash
npm install
npm run build
npm run lint
npm test
```

`npm test` runs the Vitest suite with HTTP mocked, so no token or live calls are needed.

## License

MIT.
