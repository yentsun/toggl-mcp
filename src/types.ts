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

export interface CreateTimeEntryInput {
  description?: string;
  project_id?: number;
  tags?: string[];
  billable?: boolean;
}

export interface DateRange {
  start: Date;
  end: Date;
}
