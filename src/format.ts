import type { Workspace } from './types.js';

export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  return `${local.slice(0, 1)}***@${domain}`;
}

/**
 * Toggl's /workspaces payload carries a workspace-level `api_token` plus a lot of
 * noise. Project it down to the fields a client actually needs, never credentials.
 */
export function publicWorkspaces(workspaces: Workspace[]): { id: number; name: string }[] {
  return workspaces.map((workspace) => ({ id: workspace.id, name: workspace.name }));
}
