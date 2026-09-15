export interface TogglUser {
  id: number;
  email: string;
  fullname: string;
  default_workspace_id?: number | null;
}

export interface Workspace {
  id: number;
  name: string;
}

export interface Project {
  id: number;
  workspace_id: number;
  client_id: number | null;
  name: string;
  active: boolean;
}

export interface Client {
  id: number;
  workspace_id: number;
  name: string;
}

export interface Tag {
  id: number;
  workspace_id: number;
  name: string;
}

export interface TimeEntry {
  id: number;
  workspace_id: number;
  project_id: number | null;
  task_id: number | null;
  billable: boolean;
  start: string;
  stop: string | null;
  duration: number;
  description: string;
  tags: string[] | null;
  at: string;
  uid?: number;
}

/** Fields accepted when creating or updating a time entry. */
export interface TimeEntryWriteInput {
  description?: string;
  project_id?: number;
  task_id?: number;
  tags?: string[];
  billable?: boolean;
  /** ISO 8601 start time. Defaults to now when omitted on create. */
  start?: string;
  /** ISO 8601 stop time. Omit to keep the entry running. */
  stop?: string | null;
  /** Duration in seconds; negative for a running entry. Derived from start/stop when omitted. */
  duration?: number;
  /** YYYY-MM-DD; takes precedence over the date part of `start`. */
  start_date?: string;
}

export type CreateTimeEntryInput = TimeEntryWriteInput;
export type UpdateTimeEntryInput = TimeEntryWriteInput;

export interface TimeEntryQuery {
  start?: Date;
  end?: Date;
  /** Unix seconds; returns entries modified since then, including deleted ones. */
  since?: number;
  /** YYYY-MM-DD or RFC3339; entries starting before this. */
  before?: string;
  /** Include meta entities (projects/clients) in the response. */
  meta?: boolean;
}

export interface QuotaBucket {
  organization_id: number | null;
  remaining: number;
  total: number;
  resets_in_secs: number;
}

export interface DateRange {
  start: Date;
  end: Date;
}
