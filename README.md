# yt-toggl-mcp

A small, self-hosted [MCP](https://modelcontextprotocol.io) server for **Toggl Track (API v9)**.
It runs over stdio and exposes time tracking, projects/clients, and reporting to any MCP client.

No telemetry. The only network egress is to `api.track.toggl.com`. Workspace-level tokens are
stripped from every response and user emails are masked.

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
| `toggl_update_time_entry` | Edit an existing entry; only the fields you pass are changed. A zero `duration` is ignored unless a `stop` is given. |
| `toggl_delete_time_entry` | Permanently delete an entry. |
| `toggl_start_timer` | Start a running timer with optional description, project, tags. |
| `toggl_stop_timer` | Stop the running timer (or a specific `entry_id`). |
| `toggl_report` | Total time for a range, grouped by project, sorted by hours. |

`workspace_id` defaults to the configured workspace and `project_id` defaults to the configured
project; explicit arguments always win. The default project is used only where it belongs:
tracking in another workspace never inherits it, and with no `workspaceId` configured it is
applied only if the resolved workspace owns that project.

`period` accepts `today`, `yesterday`, `week`, `lastWeek`, `month`, `lastMonth`. Ranges are
interpreted in local time and `end_date` is inclusive at the tool boundary. `since` takes unix
seconds and, per Toggl, also returns entries deleted since that time.

Toggl enforces a sliding-window request quota per user per organization; on `402` the error
result carries `quota_remaining` and `quota_resets_in_seconds`.

`toggl_report` clips every entry to the requested range, so an entry crossing a boundary is neither
double-counted nor dropped. It scans backward in 84-day windows and respects Toggl's historical
retention boundary: if it reaches that boundary it returns `incomplete: true` together with
`incomplete_reason`, rather than reporting a silently short total. Any other error is propagated.

## Configuration

Credentials live in a per-tool file under your home directory, matching the other `yt-*` MCP
servers. `TOGGL_API_KEY` may supply the token instead, so the file is optional in CI or containers.

`~/.yt-toggl-mcp/credentials.json`:

```json
{
  "apiToken": "<your token>",
  "workspaceId": 1234567,
  "projectId": 216478744
}
```

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `TOGGL_API_KEY` | no | `apiToken` from the credentials file | Toggl Track API token ([track.toggl.com/profile](https://track.toggl.com/profile)). |
| `TOGGL_CACHE_TTL` | no | `3600000` | Metadata cache TTL in ms. |

An API token must come from one of the two sources, otherwise the server exits with a message
naming the file to create. `workspaceId` and `projectId` are file-only settings and both are
optional: omit `workspaceId` if you only have one workspace, and omit `projectId` if you do not
want a default project.

`projectId` is used only where it belongs, and is verified against the workspace before any write,
so an entry never lands in the wrong project. When `workspaceId` is set, the project applies while
tracking in that workspace and a stale id fails with `INVALID_PROJECT_ID`; naming another
`workspace_id` never inherits it. Without `workspaceId`, the project is applied when the resolved
workspace owns it and ignored when it does not; that check costs an extra request per write, and
the result carries a `notice` when the project was skipped.

### Project-local defaults

Pass `--settings <file>` on the MCP command to select a project-local JSON file that overrides
`workspaceId` and `projectId` for that project only, without duplicating the API token:

```json
{
  "workspaceId": 1234567,
  "projectId": 7654321
}
```

The token always comes from `TOGGL_API_KEY` or the credentials file; an `apiToken` key in the
settings file is ignored. A relative path resolves against the server's working directory, and the
file is read once at startup. Keep the file out of version control so no Toggl ids or personal
tracking defaults appear in tracked repository files.

Precedence, highest first:

1. explicit tool arguments (`workspace_id`, `project_id`)
2. the `--settings` file
3. `~/.yt-toggl-mcp/credentials.json`

Each key falls back on its own: a settings file with only `projectId` keeps the credentials file's
`workspaceId`, and a `null` value counts as unset. Without `--settings` nothing changes. A missing
or malformed settings file, or an id that is not a positive integer, stops the server with the path
and key named.

`TOGGL_DEFAULT_WORKSPACE_ID` was removed in 0.5.0; put `workspaceId` in the credentials file
instead.

## Install

Prerequisites: Node.js `>=20.19.0` and a Toggl Track API token from
[track.toggl.com/profile](https://track.toggl.com/profile) (scroll to the bottom → "Click to reveal").

### npm

```bash
npx -y yt-toggl-mcp
```

Any MCP client that speaks stdio works. Generic client config:

```json
{
  "mcpServers": {
    "yt-toggl-mcp": {
      "command": "npx",
      "args": ["-y", "yt-toggl-mcp"]
    }
  }
}
```

`yt-toggl-mcp --help` prints the credential path, the `--settings` precedence, and the environment
variables; `--version` prints the version. Both write to stderr, since stdout carries the MCP
protocol.

### opencode

**1. Create the credentials file**

Write `~/.yt-toggl-mcp/credentials.json` (Windows: `C:\Users\<you>\.yt-toggl-mcp\credentials.json`):

```json
{
  "apiToken": "<your token>",
  "workspaceId": 1234567,
  "projectId": 216478744
}
```

`workspaceId` and `projectId` are optional. Alternatively set `TOGGL_API_KEY` in the environment
to supply only the token — the file still holds the defaults.

**2. Register the server**

Add this to `~/.config/opencode/opencode.jsonc` (Windows:
`C:\Users\<you>\.config\opencode\opencode.jsonc`) under the existing `mcp` key:

```jsonc
{
  "mcp": {
    "yt-toggl-mcp": {
      "type": "local",
      "command": ["npx", "-y", "yt-toggl-mcp"]
    }
  }
}
```

No `environment` block is needed: the server reads its own credentials file, like `yt-gmail-mcp`
and `yt-zoho-mcp`.

To give one project its own defaults without touching the user-wide file, add `--settings` pointing
at an ignored project file:

```jsonc
"command": ["npx", "-y", "yt-toggl-mcp", "--settings", ".yt-toggl.json"]
```

`.yt-toggl.json` then holds only `{"workspaceId": 1234567, "projectId": 7654321}`; the token still
comes from the credentials file.

**3. Restart opencode**

Config is read once at startup and is not hot-reloaded, so the server only loads after a restart.

**4. Verify**

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

`node dist/index.js` runs the built server locally — it reads the same credentials file described
above. `npm run dev` watches the source with `tsx` instead of building.

## License

MIT © yentsun — see [LICENSE](LICENSE).
