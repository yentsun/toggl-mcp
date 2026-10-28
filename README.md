# yt-toggl-mcp

A small, self-hosted [MCP](https://modelcontextprotocol.io) server for **Toggl Track (API v9)**.
It runs over stdio and exposes time tracking, projects/clients, and reporting to any MCP client.

No telemetry. The only network egress is to `api.track.toggl.com`. Workspace-level tokens are
stripped from every response and user emails are masked.

## Tools

| Tool | What it does |
| --- | --- |
| `toggl_check_auth` | Verify the token; returns the (masked) user and accessible workspaces. |
| `toggl_get_configuration` | Read-only: effective workspace, project, and billable default with their source (`configuration`/`derived`/`unset`). No credentials. |
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
project from the project settings file; explicit arguments always win. Timer operations are bound to
a configured workspace: repeating that `workspace_id` is accepted, naming another one fails with
`CONFIGURED_WORKSPACE_MISMATCH` instead of tracking in the wrong place. Without `workspaceId`, the
workspace comes from the call or the sole accessible workspace, and a project-only default is
applied only if the resolved workspace owns that project.

`toggl_get_configuration` reports those effective values and where each came from, so a caller can
see the defaults instead of guessing ids: `configuration` (in the settings file), `derived` (a
server fallback such as the sole workspace or `billable: false`), or `unset`. Error results carry a
`category` — `invalid_argument`, `configuration`, `authentication`, or `upstream` — so a bad argument
is not mistaken for an expired token.

Binding applies to timer writes only. `toggl_list_projects`, `toggl_list_clients`, `toggl_list_tags`,
and `toggl_report` still accept any accessible `workspace_id`, because browsing or reporting across
workspaces is a read that changes nothing; `toggl_report` scopes its totals to the workspace it
resolved, so name one deliberately when you mean another.

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

Toggl configuration has two scopes, and each setting lives in exactly one place.

**User scope — the API token.** `TOGGL_API_KEY`, or a per-tool file under your home directory
matching the other `yt-*` MCP servers:

```
~/.yt-toggl-mcp/credentials.json
```

```json
{
  "apiToken": "<your token>"
}
```

**Project scope — the tracking defaults.** The server reads `.yt-toggl-mcp.json` from its working
directory, which is the project root the MCP client launches it in. The name is fixed: there is no
flag and no search up the tree, so a project either has its own Toggl defaults or has none.

```json
{
  "workspaceId": 1234567,
  "projectId": 216478744,
  "billable": true
}
```

**`apiToken` must come from one of the two sources, otherwise the server exits with a message naming
the file to create. `workspaceId`/`projectId` in the user file are ignored.**

| File | Scope | Where | Keys |
| --- | --- | --- | --- |
| `~/.yt-toggl-mcp/credentials.json` | user | home directory | `apiToken` |
| `.yt-toggl-mcp.json` | project | repository root | `workspaceId`, `projectId`, `billable` |

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `TOGGL_API_KEY` | no | `apiToken` from the credentials file | Toggl Track API token ([track.toggl.com/profile](https://track.toggl.com/profile)). |
| `TOGGL_CACHE_TTL` | no | `3600000` | Metadata cache TTL in ms. |

A token must come from one of the two sources, otherwise the server exits with a message naming the
file to create. The `toggl-setup` skill (`.opencode/skills/toggl-setup/SKILL.md`) walks a project
through creating the settings file, and the `toggl-configuration` skill
(`.opencode/skills/toggl-configuration/SKILL.md`) covers verifying the effective defaults and
switching tasks without overriding them. An `apiToken` key in the settings file is rejected,
because a project file may be committed by mistake while the token stays user-scoped.

A missing settings file does not stop the server: it logs a warning to stderr, the read tools keep
working, and every timer write fails with `PROJECT_SETTINGS_MISSING` — recording nothing rather
than an entry with no project — unless a verified `project_id` is passed for a one-off entry. A
malformed file or an invalid id still stops startup.

Both keys in the project file are optional: omit `workspaceId` if you only have one workspace, and
omit `projectId` if you do not want a default project.

`billable` is optional too, and it is what makes tracked time show as billable by default. A Toggl
project's own billable setting does not propagate to the entries created in it, so without this key
every new timer starts unbilled. It applies to `toggl_start_timer` and `toggl_create_time_entry`
when the caller passes no `billable`, and only where the configured project applies; an explicit
`billable` argument always wins. A value that is not `true`/`false` stops startup with the key named.

`projectId` is used only where it belongs, and is verified against the workspace before any write,
so an entry never lands in the wrong project. When `workspaceId` is set, the project applies while
tracking in that workspace and a stale id fails with `INVALID_PROJECT_ID`. Without `workspaceId`,
the project is applied when the resolved workspace owns it and ignored when it does not; that check
costs an extra request per write, and the result carries a `notice` when the project was skipped.

Keep `.yt-toggl-mcp.json` out of version control so no Toggl ids or personal tracking defaults
appear in tracked repository files, and add it to each project's `.gitignore`.

#### Where the file is found

The server looks for `.yt-toggl-mcp.json` in its working directory, then in its parent directories up
to the repository root (the nearest `.git`). A client that launches the server from anywhere inside
the repository therefore finds the file, so no extra configuration is needed. A launch outside the
repository finds nothing and the server warns.

No flag or environment variable selects another location: one repository, one
`.yt-toggl-mcp.json`. A missing file does not break the server — reads keep working and timer
writes fail with `PROJECT_SETTINGS_MISSING` without recording anything — so a repository starts
unconfigured and stays that way until someone configures it. Setup is never automatic: the agent
runs the `toggl-setup` skill only when the user explicitly asks to configure Toggl for the
repository.

Precedence, highest first:

1. explicit tool arguments (`workspace_id`, `project_id`), where a configured `workspaceId` accepts
   only its own id
2. `.yt-toggl-mcp.json` from the launch directory up to the repository root

A malformed settings file, or an id that is not a positive integer, stops the server with the path
and key named. `workspaceId` and `projectId` in the user credentials file are ignored: they belong
in the project settings file.

`TOGGL_DEFAULT_WORKSPACE_ID` was removed in 0.5.0 and `--settings` was removed in 0.7.0; put
`workspaceId` and `projectId` in the project settings file instead.

## Install

Prerequisites: Node.js `>=20.19.0` and a Toggl Track API token from
[track.toggl.com/profile](https://track.toggl.com/profile) (scroll to the bottom → "Click to reveal").

### npm

```bash
npx -y yt-toggl-mcp
```

Run it from a repository that has a `.yt-toggl-mcp.json`; without one the server still starts but warns, and writes that need a project default fail.

Any MCP client that speaks stdio works. The server reads its project settings from the working
directory, so every config must launch it from the repository root. Generic client config:

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

`yt-toggl-mcp --help` prints the credential and project settings paths, the precedence, and the
environment variables; `--version` prints the version. Both write to stderr, since stdout carries
the MCP protocol.

### opencode

**1. Create the credentials file**

Write `~/.yt-toggl-mcp/credentials.json` (Windows: `C:\Users\<you>\.yt-toggl-mcp\credentials.json`):

```json
{
  "apiToken": "<your token>"
}
```

Alternatively set `TOGGL_API_KEY` in the environment to supply the token.

**2. Register the server**

Add this to `~/.config/opencode/opencode.jsonc` (Windows:
`C:\Users\<you>\.config\opencode\opencode.jsonc`) under the existing `mcp` key. `<repo>` is the
repository whose `.yt-toggl-mcp.json` the server should read:

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

**3. Configure when you want to track**

A repository starts unconfigured: reads work, starting or creating a timer fails with
`PROJECT_SETTINGS_MISSING` and records nothing. Ask opencode to configure Toggl for this repository
when you want to track time here. It then runs the `toggl-setup` skill — checks the token, guides
authorization if needed, lists
the workspaces and projects, asks which project this repository should use, writes the file, and
adds it to `.gitignore`. It does not do this on its own, and not on the first message.

The server finds the file by walking up from its launch directory to the repository root, so one
global `yt-toggl-mcp` entry covers every repository.

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

The server runs from `src` in development (`npm run dev`, `npm test`). `dist` is only for the
published `bin`: `npm install` compiles it through the `prepare` script, and `npm run build` does
the same on demand.

`node dist/index.js` runs the built server locally — it reads the same credentials and project
settings files described above, so run it from the project root. `npm run dev` watches the source
with `tsx` instead of building.

## License

MIT © yentsun — see [LICENSE](LICENSE).
