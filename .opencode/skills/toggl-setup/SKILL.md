---
name: Toggl Project Setup
description: Use when `yt-toggl-mcp` refuses to start with "Project settings file not found", when a repository needs its own Toggl workspace/project defaults, or when asked to configure Toggl for this project.
---

# Toggl Project Setup

`yt-toggl-mcp` runs in project scope: it reads `.yt-toggl-mcp.json` from its working directory and
exits at startup when that file is missing. This skill creates it once per repository.

The token is user-scoped and is **not** part of this setup: it comes from
`~/.yt-toggl-mcp/credentials.json` or `TOGGL_API_KEY`.

## Steps

1. **Confirm the token works.** Call `toggl_check_auth`. If it fails with a token error, stop and
   report the exact message — asking the user to create the credentials file is a separate task.

2. **Resolve the workspace.** Call `toggl_list_workspaces`, then:

   - one workspace: use it;
   - several: ask which one this project tracks in;
   - none: report the failure and stop.

3. **Pick the project.** Call `toggl_list_projects` with that `workspace_id`, show the candidates as
   an id/name table, and ask which project this repository tracks. Offer "no default project" as an
   option only if the user wants entries without one.

4. **Write the file.** Create `.yt-toggl-mcp.json` in the repository root:

   ```json
   {
     "workspaceId": 1234567,
     "projectId": 7654321
   }
   ```

   Omit `workspaceId` only when the account has a single workspace. Never add an `apiToken` key:
   the server rejects it so a committed file cannot carry a secret.

5. **Keep it out of version control.** Confirm `.yt-toggl-mcp.json` is ignored — check
   `.gitignore`, and add the line if it is absent. Do not commit the file.

   ```
   .yt-toggl-mcp.json
   ```

6. **Confirm.** Restart the MCP server so it re-reads the file, then start a throwaway timer with
   `toggl_start_timer` using a recognisable description. Verify the running entry's `project_id`
   matches the chosen project, then delete the entry with `toggl_delete_time_entry`. Never leave the
   probe entry running.

## Rules

- One file, one project: never copy another repository's ids or guess them from project names.
- A stale id fails writes with `INVALID_PROJECT_ID`; fix it by re-listing projects, not by removing
  the file.
- Report the path written and the project chosen; do not report the token or its contents.
