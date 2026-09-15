import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const CREDENTIALS_DIRNAME = '.yt-toggl-mcp';
export const CREDENTIALS_FILENAME = 'credentials.json';

export interface Credentials {
  apiToken: string;
  defaultWorkspaceId?: string | number;
}

export class CredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialsError';
  }
}

export function credentialsPath(homeDir: string = homedir()): string {
  return join(homeDir, CREDENTIALS_DIRNAME, CREDENTIALS_FILENAME);
}

function readFileCredentials(filePath: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    // A missing file is a normal state: fall back to the environment.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new CredentialsError(`Could not read ${filePath}: ${(error as Error).message}`);
  }

  let parsed: unknown;
  try {
    // Tolerate a UTF-8 BOM: Windows editors and PowerShell add one by default.
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new CredentialsError(`Invalid JSON in ${filePath}: ${(error as Error).message}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CredentialsError(`Invalid credentials file at ${filePath}: expected a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function textValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function workspaceValue(value: unknown): string | number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  return textValue(value);
}

/**
 * Resolve credentials the same way the other yt-* MCP servers do: a per-tool
 * file under the user's home directory. Environment variables take precedence
 * so the server still works in CI or without a config file on disk.
 */
export function loadCredentials(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = homedir()
): Credentials {
  const filePath = credentialsPath(homeDir);
  const file = readFileCredentials(filePath);

  const apiToken = textValue(env.TOGGL_API_KEY) ?? textValue(file.apiToken);
  if (!apiToken) {
    throw new CredentialsError(
      `No Toggl API token found. Create ${filePath} containing {"apiToken": "<token>"} ` +
        'or set the TOGGL_API_KEY environment variable.'
    );
  }

  return {
    apiToken,
    defaultWorkspaceId:
      workspaceValue(env.TOGGL_DEFAULT_WORKSPACE_ID) ?? workspaceValue(file.workspaceId),
  };
}
