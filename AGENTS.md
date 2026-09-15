# AGENTS.md

Guidance for coding agents working in this repository. `CLAUDE.md` imports this file.

## What this is

`yt-toggl-mcp` is a from-scratch, self-hosted stdio MCP server for **Toggl Track (API v9)**.
It is deliberately small: an HTTP client, a tiny TTL cache, workspace resolution, date/report
helpers, and the MCP tool registration. There is no background work, no telemetry, and the only
network egress is to `api.track.toggl.com`.

## Layout

```
src/
├── index.ts      # MCP server + tool registration (the only place tools are defined)
├── toggl-api.ts  # TogglAPI HTTP client; TogglAPIError; auth + retries-free error mapping
├── workspace.ts  # parseWorkspaceId / resolveWorkspaceId; WorkspaceResolutionError
├── cache.ts      # TtlCache
├── utils.ts      # periods, date parsing, entry durations, project summarization
└── types.ts      # shared interfaces
tests/            # Vitest suites (HTTP is mocked; never call the live API)
```

## Commands

```bash
npm install
npm run build   # rm -rf dist && tsc
npm run lint    # eslint src/ tests/
npm test        # vitest run (mocked HTTP)
npm run dev     # tsx watch src/index.ts
```

## Conventions

- TypeScript ESM (`"type": "module"`); relative imports keep the `.js` extension.
- Prettier: semicolons, single quotes, 100 cols, 2-space indent.
- `no-console` is an error except `console.error`/`console.warn` — **stdout is reserved for the
  MCP stdio protocol**. Log to stderr only.
- Tool handlers must never throw across the MCP boundary: catch and return a structured
  `isError` result (see `fail()` in `src/index.ts`).
- Tool names are snake_case prefixed `toggl_`.

## Security rules

- Always use the API token as **HTTP Basic** (`token` : `api_token`); never as a bearer token.
- **Never return raw Toggl payloads that may contain credentials.** The `/workspaces` response
  includes a workspace-level `api_token`; map responses through `publicWorkspaces()` so only
  `{ id, name }` leaves the server.
- Mask user emails in tool output (`maskEmail`).
- Do not add telemetry or any egress beyond Toggl domains.

## Adding a tool

1. Add a method to `TogglAPI` in `src/toggl-api.ts` if a new request is needed.
2. Register it with `server.registerTool(...)` in `src/index.ts` (Zod `inputSchema`).
3. Add pure logic to `src/utils.ts` where possible so it can be unit tested.
4. Add tests under `tests/` with `fetch` mocked.

## Releases

None automated. Bump `version` in `package.json` and `VERSION` in `src/index.ts` by hand.
