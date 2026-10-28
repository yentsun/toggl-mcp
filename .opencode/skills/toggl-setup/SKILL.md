---
name: Toggl Project Setup
description: Use only when the user explicitly asks to set up, configure, or re-configure Toggl for a repository, or when a timer write failed with `PROJECT_SETTINGS_MISSING` and the user asked for it to be fixed. Never run it on first use or on your own initiative.
---

# Toggl Project Setup

`yt-toggl-mcp` associates one Toggl project with each repository through
`.yt-toggl-mcp.json` in the repository root. Until that file exists the server still answers reads,
but timer writes fail with `PROJECT_SETTINGS_MISSING` and record nothing.

Run this flow **only when the user asks to configure Toggl for this repository**. The server never
configures itself: do not run it on the first message, and do not offer it while doing unrelated
work. If the user has not asked, say the repository is unconfigured and wait.

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
     "projectId": 7654321,
     "billable": true
   }
   ```

   Never add an `apiToken` key: the token is user-scoped and the server rejects one here.

   `billable` decides whether this repository's entries show as billable, because a Toggl project's
   own billable setting does not propagate to its entries. Ask the user whether this project's work
   is billable and write the answer; omitting the key tracks every entry as unbilled.

5. **Keep it out of version control.** Confirm `.yt-toggl-mcp.json` is ignored — check
   `.gitignore`, and add the line if it is absent. Do not commit the file.

   ```
   .yt-toggl-mcp.json
   ```

6. **Confirm.** Restart the MCP server so it re-reads the file, then call
   `toggl_get_configuration` and check that `project_configured` is `true` and that `workspace`,
   `project`, and `billable` all report `source: "configuration"` with the values you wrote. Only if
   the user wants a live check, start a throwaway timer with `toggl_start_timer` using a
   recognisable description, verify the running entry's `project_id`, then delete the entry with
   `toggl_delete_time_entry`. Never leave the probe entry running.

## Rules

- One file, one project: never copy another repository's ids or guess them from project names.
- A stale id fails writes with `INVALID_PROJECT_ID`; fix it by re-listing projects, not by removing
  the file.
- Report the path written and the project chosen; do not report the token or its contents.
- Once configured, timer operations are bound to the configured workspace; see the
  `toggl-configuration` skill for reading and verifying the effective defaults.
