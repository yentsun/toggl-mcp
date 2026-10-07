import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseId } from './workspace.js';

export const CREDENTIALS_DIRNAME = '.yt-toggl-mcp';
export const CREDENTIALS_FILENAME = 'credentials.json';

export interface Credentials {
  apiToken: string;
  defaultWorkspaceId?: string | number;
  defaultProjectId?: string | number;
}

/** Workspace/project defaults from a project-local settings file. */
interface SettingsDefaults {
  workspaceId?: number;
  projectId?: number;
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

/**
 * Select the project-local settings file from the process arguments. Accepts
 * `--settings <file>` and `--settings=<file>`; a flag without a path is a
 * configuration error rather than a silently ignored argument.
 */
export function settingsPathFromArgv(argv: string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--settings') {
      const value = argv[index + 1]?.trim();
      if (!value) throw new CredentialsError('--settings requires a file path.');
      return value;
    }
    if (arg.startsWith('--settings=')) {
      const value = arg.slice('--settings='.length).trim();
      if (!value) throw new CredentialsError('--settings requires a file path.');
      return value;
    }
  }
  return undefined;
}

function parseJsonObject(filePath: string, raw: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    // Tolerate a UTF-8 BOM: Windows editors and PowerShell add one by default.
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new CredentialsError(`Invalid JSON in ${filePath}: ${(error as Error).message}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CredentialsError(`Invalid ${label} at ${filePath}: expected a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Read a JSON object. A missing credentials file is a normal state and yields
 * an empty object; a missing settings file was asked for explicitly, so it is
 * an error.
 */
function readJsonObject(
  filePath: string,
  label: string,
  onMissing: 'ignore' | 'error'
): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      if (onMissing === 'ignore') return {};
      throw new CredentialsError(`Settings file not found: ${filePath}`);
    }
    throw new CredentialsError(`Could not read ${filePath}: ${(error as Error).message}`);
  }

  return parseJsonObject(filePath, raw, label);
}

function textValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function idValue(value: unknown): string | number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  return textValue(value);
}

/**
 * A settings id is authoritative, so reject one that cannot be an id instead of
 * ignoring it: a typo would otherwise silently change which project is tracked.
 * parseId is the same check the server applies later, so anything accepted here
 * is used rather than dropped. Null counts as unset, like the credentials file.
 */
function settingsId(value: unknown, key: string, filePath: string): number | undefined {
  if (value === undefined || value === null) return undefined;

  const id = parseId(value);
  if (id === undefined) {
    throw new CredentialsError(`Invalid ${key} in ${filePath}: expected a positive integer id.`);
  }
  return id;
}

function loadSettings(filePath: string): SettingsDefaults {
  const settings = readJsonObject(filePath, 'settings file', 'error');
  return {
    workspaceId: settingsId(settings.workspaceId, 'workspaceId', filePath),
    projectId: settingsId(settings.projectId, 'projectId', filePath),
  };
}

/**
 * Resolve credentials the same way the other yt-* MCP servers do: a per-tool
 * file under the user's home directory. The token may also come from
 * TOGGL_API_KEY so the server still works in CI or in a container without a
 * config file.
 *
 * Workspace and project defaults come from the project-local settings file
 * selected with `--settings` when one is given, and otherwise from the user
 * credentials file; the settings file never supplies the token. Each key falls
 * back on its own, so a settings file with only `projectId` keeps the user
 * file's `workspaceId`. A `null` value counts as unset.
 */
export function loadCredentials(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = homedir(),
  settingsPath?: string
): Credentials {
  const filePath = credentialsPath(homeDir);
  const file = readJsonObject(filePath, 'credentials file', 'ignore');
  const settings = settingsPath === undefined ? undefined : loadSettings(settingsPath);

  const apiToken = textValue(env.TOGGL_API_KEY) ?? textValue(file.apiToken);
  if (!apiToken) {
    throw new CredentialsError(
      `No Toggl API token found. Create ${filePath} containing {"apiToken": "<token>"} ` +
        'or set the TOGGL_API_KEY environment variable.'
    );
  }

  return {
    apiToken,
    defaultWorkspaceId: settings?.workspaceId ?? idValue(file.workspaceId),
    defaultProjectId: settings?.projectId ?? idValue(file.projectId),
  };
}
