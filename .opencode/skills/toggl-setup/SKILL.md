---
name: Toggl Project Setup
description: Use when `yt-toggl-mcp` reports "Project settings file not found" or a write fails with `PROJECT_SETTINGS_MISSING`, when a repository needs its own Toggl workspace/project defaults, or when asked to configure Toggl for this project.
---

# Toggl Project Setup

`yt-toggl-mcp` associates one Toggl project with each repository through
`.yt-toggl-mcp.json` in the repository root. Until that file exists the server still answers, but
writes that need a project default fail with `PROJECT_SETTINGS_MISSING`.

Run this flow once per repository. It is also what the server's own instructions ask the agent to do
on first use, so follow it before any other Toggl work when the file is missing.

## Steps

1. **Authorize.** Call `toggl_check_auth`.

   - Success: continue.
   - Token error: guide the user through authorization — create
     `~/.yt-toggl-mcp/credentials.json` containing `{"apiToken": "<token>"}` (from
     [track.toggl.com/profile](https://track.toggl.com/profile)), or set `TOGGL_API_KEY`. Restart the
     MCP server afterwards, since the token is read once at startup, then repeat this step.

2. **Resolve the workspace.** Call `toggl_list_workspaces`, then:

   - one workspace: use it;
   - several: ask which one this repository tracks in;
   - none: report the failure and stop.

3. **Pick the project.** Call `toggl_list_projects` with that `workspace_id`, show the candidates as
   an id/name table, and ask which project this repository should be associated with.

4. **Write the file.** Create `.yt-toggl-mcp.json` in the repository root:

   ```json
   {
     "workspaceId": 1234567,
     "projectId": 7654321
   }
   ```

   Never add an `apiToken` key: the token is user-scoped and the server rejects one here.

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
