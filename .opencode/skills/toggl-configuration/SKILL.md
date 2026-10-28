---
name: Toggl Configuration
description: Use before tracking time through `yt-toggl-mcp` — before passing `workspace_id`, `project_id`, or `billable`, when a Toggl call fails with `CONFIGURED_WORKSPACE_MISMATCH`, `INVALID_WORKSPACE_ID`, `INVALID_PROJECT_ID`, or `PROJECT_SETTINGS_MISSING`, when verifying effective defaults, or when switching tasks in a configured project.
---

# Toggl Configuration

`yt-toggl-mcp` binds timer operations to the workspace and project configured for this repository.
This skill keeps those bindings intact: it reads the effective configuration, verifies it against
Toggl, and passes only ids that came from a verified source.

Run it before the first timer in a session. For creating the settings file from scratch, use the
`toggl-setup` skill; this one assumes the file is the subject of the conversation.

## Read the effective configuration

Call `toggl_get_configuration`. It is read-only and never returns credentials. Each value carries a
`source`:

| `source` | Meaning | What to pass |
| --- | --- | --- |
| `configuration` | Set in `.yt-toggl-mcp.json`. | Nothing, unless overriding deliberately. |
| `derived` | A server fallback: the sole accessible workspace, or `billable: false`. | Nothing. It serves reads; a derived workspace does not make timer writes possible. |
| `unset` | No value and no fallback. | Reads may take a verified `workspace_id`; starting a timer needs a verified `project_id`. Never invent ids. |

`project_configured` is the field to check before starting a timer. When it is `false`, no project
is configured, so `toggl_start_timer` and `toggl_create_time_entry` fail with
`PROJECT_SETTINGS_MISSING` unless you pass a verified `project_id` from `toggl_list_projects` —
however usable the workspace looks, including when `workspace` is `derived`. Stopping, updating, or
deleting an entry does not need a project.

Timer operations (`toggl_start_timer`, `toggl_create_time_entry`, `toggl_update_time_entry`,
`toggl_delete_time_entry`) are **bound** when `workspace.source` is `configuration`: passing that
same `workspace_id` is redundant, and passing a different one fails with
`CONFIGURED_WORKSPACE_MISMATCH`. Omit `workspace_id` rather than repeating it.

### When `project_configured` is `false`

No project is configured, so starting or creating a timer fails with `PROJECT_SETTINGS_MISSING`
unless you pass a verified `project_id`. Do not work around it with a `project_id` you did not get
from a list:

- `settings_loaded: true` with `project: unset` — the file exists but has no `projectId`. Tell the
  user that, and run `toggl-setup` only if they ask to finish configuring.
- `settings_loaded: false` — no file. Say the repository is unconfigured and wait for the user to ask.

## Verify before writing

1. Confirm the token works: `toggl_check_auth`.
2. When `workspace.source` is `configuration`, confirm the id appears in that workspace list.
3. When `project.source` is `configuration`, confirm it appears in
   `toggl_list_projects` for the configured workspace. A mismatch is stale configuration, not a
   reason to pass a different project: report it and let the user fix the file.
4. Report what you verified and which values will be applied. Do not report the token.

## Billing

`billable: true` means billable work. Omitting `billable` uses the effective default from
`toggl_get_configuration` — `false` when nothing is configured, because a Toggl project's own
billable setting does not propagate to its entries.

The default applies only to entries in the configured project. An explicitly passed `project_id`
never inherits it, so pass `billable` yourself when you name a project. Never pass
`billable: false` to "be safe": it overrides a configured `true` and loses billable time.

## Switching tasks

To move to another task in the configured project:

1. Call `toggl_start_timer` with a description (and `tags`, if any). Leave `workspace_id` and
   `project_id` out so the configured project applies.
2. Do not stop the running entry first; starting a new timer replaces it.
3. Call `toggl_stop_timer` only when the user asked to stop tracking.

Pass `project_id` only for a project you just listed for the configured workspace, and only when
the user chose it. Never construct, increment, or recall an id from memory or another repository.

## Failures

| Code | Cause | Next step |
| --- | --- | --- |
| `CONFIGURED_WORKSPACE_MISMATCH` | A `workspace_id` contradicts the configured workspace. | Drop the argument and retry. Do not change the settings file unless the user asks. |
| `INVALID_WORKSPACE_ID` | The id is not accessible to this token. | Re-list workspaces; do not retry the same id. |
| `INVALID_PROJECT_ID` | The project is not in the resolved workspace. | Re-list projects. With `source: configuration`, report stale configuration. |
| `PROJECT_SETTINGS_MISSING` | No configured project and no `project_id` was passed. Nothing was recorded. | Read the message: it distinguishes a missing file from a file without `projectId` from a configured id that did not fit. Report that, and wait for the user to ask for setup. |
| `category: authentication` | The token is missing, expired, or revoked. | Guide the user to fix the token; retrying will not help. |

An `invalid_argument` error means the call was wrong, not the setup: retry with corrected
arguments. Do not re-authorize or edit the settings file to work around it.
