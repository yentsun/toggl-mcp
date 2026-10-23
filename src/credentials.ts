import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseId } from './workspace.js';

export const CREDENTIALS_DIRNAME = '.yt-toggl-mcp';
export const CREDENTIALS_FILENAME = 'credentials.json';

/**
 * The project-scoped defaults file. The name is fixed on purpose: the server
 * reads it from its working directory, which is the project root, so a project
 * either has its own Toggl defaults or has none. There is no flag, no path
 * argument, and no fallback to user-wide defaults.
 */
export const PROJECT_SETTINGS_FILENAME = '.yt-toggl-mcp.json';

/** User-scoped credentials: the token only. */
export interface Credentials {
  apiToken: string;
}

/** Project-scoped defaults from the fixed settings file. */
export interface ProjectSettings {
  workspaceId?: number;
  projectId?: number;
  /**
   * Billable flag for entries this project creates when the caller does not
   * pass one. A Toggl project's own billable setting does not propagate to
   * entries, so the default lives here instead.
   */
  billable?: boolean;
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

export function projectSettingsPath(cwd: string = process.cwd()): string {
  return resolve(cwd, PROJECT_SETTINGS_FILENAME);
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
 * Read a JSON object, or `missing` when the file does not exist. Every caller
 * decides for itself whether absence is normal (the credentials file) or a
 * startup error (the project settings file); other read failures always throw.
 */
function readJsonObject<T>(
  filePath: string,
  label: string,
  missing: T
): Record<string, unknown> | T {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new CredentialsError(`Could not read ${filePath}: ${(error as Error).message}`);
    }
    return missing;
  }

  return parseJsonObject(filePath, raw, label) as Record<string, unknown> | T;
}

function textValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * A settings id is authoritative, so reject one that cannot be an id instead of
 * ignoring it: a typo would otherwise silently change which project is tracked.
 * parseId is the same check the server applies later, so anything accepted here
 * is used rather than dropped. Null counts as unset.
 */
function settingsId(value: unknown, key: string, filePath: string): number | undefined {
  if (value === undefined || value === null) return undefined;

  const id = parseId(value);
  if (id === undefined) {
    throw new CredentialsError(`Invalid ${key} in ${filePath}: expected a positive integer id.`);
  }
  return id;
}

/**
 * An optional boolean flag. Like an id, a value of the wrong type is a typo
 * that would silently change how entries are tracked, so it is rejected rather
 * than ignored. Null counts as unset.
 */
function settingsFlag(value: unknown, key: string, filePath: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    throw new CredentialsError(`Invalid ${key} in ${filePath}: expected true or false.`);
  }
  return value;
}

function projectSettingsWarning(filePath: string): string {
  return (
    `Project settings file not found: ${filePath}\n` +
    'yt-toggl-mcp runs in project scope: create that file in the project root with ' +
    `{"workspaceId": <id>, "projectId": <id>, "billable": true} (use toggl_list_workspaces and ` +
    'toggl_list_projects to pick ids) and keep it out of version control. ' +
    'Writes that need a project default will fail until it exists.'
  );
}

/**
 * The project settings file for a launch directory. Clients do not reliably set
 * a working directory (npx and global bins often start in a temp or install
 * directory), so walk up to the nearest ancestor that has the file, stopping at
 * the git root that bounds the repository. Without this, a correct file in the
 * repository is invisible to the server.
 */
function findProjectSettings(cwd: string): string | undefined {
  let directory = resolve(cwd);

  for (;;) {
    const candidate = join(directory, PROJECT_SETTINGS_FILENAME);
    if (existsSync(candidate)) return candidate;

    // A repository root is the last directory that can own the file.
    if (existsSync(join(directory, '.git'))) return undefined;

    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/**
 * Read the project defaults from `.yt-toggl-mcp.json` in `cwd`.
 *
 * The token never lives here: a project file can be committed by mistake, so an
 * `apiToken` key is rejected rather than ignored.
 *
 * A missing file is not fatal. The server still starts, so read-only tools and
 * explicit ids keep working, and every write that relies on a configured
 * project fails with PROJECT_SETTINGS_MISSING. A malformed file, an invalid id,
 * or a stray `apiToken` is a real mistake and still stops startup.
 */
export function loadProjectSettings(
  cwd: string = process.cwd(),
  warn: (message: string) => void = console.warn
): ProjectSettings {
  const filePath = findProjectSettings(cwd);
  if (filePath === undefined) {
    warn(`yt-toggl-mcp: ${projectSettingsWarning(projectSettingsPath(cwd))}`);
    return {};
  }

  const settings = readJsonObject(filePath, 'project settings file', undefined);
  if (settings === undefined) {
    warn(`yt-toggl-mcp: ${projectSettingsWarning(filePath)}`);
    return {};
  }

  if (settings.apiToken !== undefined) {
    throw new CredentialsError(
      `Invalid apiToken in ${filePath}: the Toggl token is user-scoped. ` +
        `Set it in ${credentialsPath()} or TOGGL_API_KEY instead.`
    );
  }

  return {
    workspaceId: settingsId(settings.workspaceId, 'workspaceId', filePath),
    projectId: settingsId(settings.projectId, 'projectId', filePath),
    billable: settingsFlag(settings.billable, 'billable', filePath),
  };
}

/**
 * Resolve the token the same way the other yt-* MCP servers do: a per-tool file
 * under the user's home directory, or TOGGL_API_KEY so the server still works
 * in CI or in a container without a config file.
 *
 * Defaults are not read here. Workspace and project defaults are project-scoped
 * and come from loadProjectSettings, so a repository without its own settings
 * file can never inherit someone else's project.
 */
export function loadCredentials(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = homedir()
): Credentials {
  const filePath = credentialsPath(homeDir);
  const file = readJsonObject(filePath, 'credentials file', {} as Record<string, unknown>);

  const apiToken = textValue(env.TOGGL_API_KEY) ?? textValue(file.apiToken);
  if (!apiToken) {
    throw new CredentialsError(
      `No Toggl API token found. Create ${filePath} containing {"apiToken": "<token>"} ` +
        'or set the TOGGL_API_KEY environment variable.'
    );
  }

  return { apiToken };
}
