# yt-toggl-mcp

A small, self-hosted [MCP](https://modelcontextprotocol.io) server for **Toggl Track (API v9)**.
It runs over stdio and exposes time tracking, projects/clients, and reporting to any MCP client.

No telemetry. The only network egress is to `api.track.toggl.com`.

## Tools

| Tool | What it does |
| --- | --- |
| `toggl_check_auth` | Verify the token; returns the (masked) user and accessible workspaces. |
| `toggl_get_quota` | Remaining API requests and reset time per organization. |
| `toggl_list_workspaces` | List accessible workspaces. |
| `toggl_list_projects` | List projects in a workspace. |
| `toggl_list_clients` | List clients in a workspace. |
| `toggl_list_tags` | List tags in a workspace. |
| `toggl_get_current_entry` | Return the running timer with elapsed seconds. |
| `toggl_get_time_entry` | Load a single entry by id. |
| `toggl_get_time_entries` | List entries for a `period`, an inclusive `start_date`/`end_date` range, or `since`/`before`. |
| `toggl_create_time_entry` | Create a completed entry (`start` + `stop`/`duration`) or a running one. |
| `toggl_update_time_entry` | Edit an existing entry; only the fields you pass are changed. |
| `toggl_delete_time_entry` | Permanently delete an entry. |
| `toggl_start_timer` | Start a running timer with optional description, project, tags. |
| `toggl_stop_timer` | Stop the running timer (or a specific `entry_id`). |
| `toggl_report` | Total time for a range, grouped by project, sorted by hours. |

`period` accepts `today`, `yesterday`, `week`, `lastWeek`, `month`, `lastMonth`. Ranges are
interpreted in local time and `end_date` is inclusive at the tool boundary. `since` takes unix
seconds and, per Toggl, also returns entries deleted since that time.

Toggl enforces a sliding-window request quota per user per organization; on `402` the error
result carries `quota_remaining` and `quota_resets_in_seconds`.

## Configuration

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `TOGGL_API_KEY` | yes | — | Toggl Track API token ([track.toggl.com/profile](https://track.toggl.com/profile)). |
| `TOGGL_DEFAULT_WORKSPACE_ID` | no | auto if a single workspace | Default workspace for workspace-scoped tools. |
| `TOGGL_CACHE_TTL` | no | `3600000` | Metadata cache TTL in ms. |

## Install

### opencode

Prerequisites: Node.js `>=20.19.0` and a Toggl Track API token from
[track.toggl.com/profile](https://track.toggl.com/profile) (scroll to the bottom → "Click to reveal").

**1. Build the server**

```bash
git clone https://github.com/yentsun/toggl-mcp.git
cd toggl-mcp
npm ci
npm run build
```

**2. Put the token in the environment**

The config below reads it via `{env:TOGGL_API_KEY}`, so the token never lives in the config file.

Windows (persists for new processes — restart your terminal afterwards):

```powershell
[Environment]::SetEnvironmentVariable('TOGGL_API_KEY', '<your token>', 'User')
[Environment]::SetEnvironmentVariable('TOGGL_DEFAULT_WORKSPACE_ID', '<workspace id>', 'User')
```

macOS / Linux (`~/.zshrc`, `~/.bashrc`, …):

```bash
export TOGGL_API_KEY='<your token>'
export TOGGL_DEFAULT_WORKSPACE_ID='<workspace id>'
```

**3. Register the server**

Add this to `~/.config/opencode/opencode.jsonc` (Windows:
`C:\Users\<you>\.config\opencode\opencode.jsonc`) under the existing `mcp` key, pointing `command` at
the built entry point:

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

On Windows the path looks like `F:/Projects/personal/toggl-mcp/dist/index.js` (forward slashes are
fine). `TOGGL_DEFAULT_WORKSPACE_ID` is optional — omit it if you only have one workspace.

**4. Restart opencode**

Config is read once at startup and is not hot-reloaded, so the server only loads after a restart.

**5. Verify**

Ask opencode to call `toggl_check_auth`. It should return your (masked) account and workspace list.
A quick win after that: ask "what am I currently tracking?".

## Development

```bash
npm install
npm run build
npm run lint
npm test
```

`npm test` runs the Vitest suite with HTTP mocked, so no token or live calls are needed.

## License

MIT © yentsun — see [LICENSE](LICENSE).
