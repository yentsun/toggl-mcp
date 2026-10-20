import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CREDENTIALS_DIRNAME,
  CREDENTIALS_FILENAME,
  CredentialsError,
  PROJECT_SETTINGS_FILENAME,
  credentialsPath,
  loadCredentials,
  loadProjectSettings,
  projectSettingsPath,
} from '../src/credentials.js';

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeHome(contents?: string): string {
  const home = tempDir('yt-toggl-mcp-creds-');
  if (contents !== undefined) {
    mkdirSync(join(home, CREDENTIALS_DIRNAME), { recursive: true });
    writeFileSync(join(home, CREDENTIALS_DIRNAME, CREDENTIALS_FILENAME), contents, 'utf8');
  }
  return home;
}

/** A project directory, optionally holding the project settings file. */
function makeProject(contents?: string): string {
  const dir = tempDir('yt-toggl-mcp-project-');
  if (contents !== undefined) {
    writeFileSync(join(dir, PROJECT_SETTINGS_FILENAME), contents, 'utf8');
  }
  return dir;
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('credentialsPath', () => {
  it('points at a per-tool directory in the home folder', () => {
    expect(credentialsPath(join('home', 'user'))).toBe(
      join('home', 'user', '.yt-toggl-mcp', 'credentials.json')
    );
  });
});

describe('projectSettingsPath', () => {
  it('resolves the fixed file name against the given directory', () => {
    expect(projectSettingsPath(join('repos', 'app'))).toBe(
      resolve('repos', 'app', PROJECT_SETTINGS_FILENAME)
    );
  });
});

describe('loadCredentials', () => {
  it('reads only the token from the credentials file', () => {
    const home = makeHome(JSON.stringify({ apiToken: 'file-token' }));

    expect(loadCredentials({}, home)).toEqual({ apiToken: 'file-token' });
  });

  it('never returns workspace or project defaults from the user file', () => {
    const home = makeHome(
      JSON.stringify({ apiToken: 'file-token', workspaceId: 1835443, projectId: 216478744 })
    );

    // Project defaults are project-scoped now: a user-wide value must not leak
    // into a project that has no settings file of its own.
    expect(loadCredentials({}, home)).toStrictEqual({ apiToken: 'file-token' });
  });

  it('trims a padded token', () => {
    const home = makeHome(JSON.stringify({ apiToken: '  file-token  ' }));

    expect(loadCredentials({}, home).apiToken).toBe('file-token');
  });

  it('lets the environment token override the file token', () => {
    const home = makeHome(JSON.stringify({ apiToken: 'file-token' }));

    expect(loadCredentials({ TOGGL_API_KEY: 'env-token' }, home).apiToken).toBe('env-token');
  });

  it('ignores a blank environment token', () => {
    const home = makeHome(JSON.stringify({ apiToken: 'file-token' }));

    expect(loadCredentials({ TOGGL_API_KEY: '   ' }, home).apiToken).toBe('file-token');
  });

  it('accepts the environment token without any credentials file', () => {
    const home = makeHome();

    expect(loadCredentials({ TOGGL_API_KEY: 'env-token' }, home)).toEqual({
      apiToken: 'env-token',
    });
  });

  it('names the file to create when no token is configured anywhere', () => {
    const home = makeHome();

    expect(() => loadCredentials({}, home)).toThrow(CredentialsError);
    expect(() => loadCredentials({}, home)).toThrow(credentialsPath(home));
  });

  it('rejects a file whose token is blank', () => {
    const home = makeHome(JSON.stringify({ apiToken: '   ' }));

    expect(() => loadCredentials({}, home)).toThrow(CredentialsError);
  });

  it('tolerates a UTF-8 BOM written by Windows editors', () => {
    const home = makeHome('\uFEFF' + JSON.stringify({ apiToken: 'file-token' }));

    expect(loadCredentials({}, home).apiToken).toBe('file-token');
  });

  it('rejects malformed JSON', () => {
    const home = makeHome('{ not json');

    expect(() => loadCredentials({}, home)).toThrow(/Invalid JSON/);
  });

  it('rejects a JSON document that is not an object', () => {
    const home = makeHome('["apiToken"]');

    expect(() => loadCredentials({}, home)).toThrow(/expected a JSON object/);
  });

  it('surfaces a read failure that is not a missing file', () => {
    const home = makeHome();
    mkdirSync(join(home, CREDENTIALS_DIRNAME, CREDENTIALS_FILENAME), { recursive: true });

    expect(() => loadCredentials({}, home)).toThrow(/Could not read/);
  });
});

describe('loadProjectSettings', () => {
  it('reads the workspace and project defaults from the fixed file', () => {
    const project = makeProject(JSON.stringify({ workspaceId: 1835443, projectId: 216478744 }));

    expect(loadProjectSettings(project)).toEqual({ workspaceId: 1835443, projectId: 216478744 });
  });

  it('allows either key to be omitted', () => {
    expect(loadProjectSettings(makeProject(JSON.stringify({ projectId: 300 })))).toEqual({
      workspaceId: undefined,
      projectId: 300,
    });
    expect(loadProjectSettings(makeProject('{}'))).toEqual({
      workspaceId: undefined,
      projectId: undefined,
    });
  });

  it('normalizes ids stored as numeric strings', () => {
    const project = makeProject(JSON.stringify({ workspaceId: '333', projectId: '444' }));

    expect(loadProjectSettings(project)).toEqual({ workspaceId: 333, projectId: 444 });
  });

  it('treats a null value as unset', () => {
    const project = makeProject(JSON.stringify({ workspaceId: null, projectId: 999 }));

    expect(loadProjectSettings(project)).toEqual({ workspaceId: undefined, projectId: 999 });
  });

  it('starts without defaults when the file is missing, warning with the expected path', () => {
    const project = makeProject();
    const warnings: string[] = [];

    expect(loadProjectSettings(project, (message) => warnings.push(message))).toEqual({
      workspaceId: undefined,
      projectId: undefined,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(join(project, PROJECT_SETTINGS_FILENAME));
    expect(warnings[0]).toMatch(/toggl_list_projects/);
  });

  it('finds the file in an ancestor repository when the launch directory differs', () => {
    const repo = tempDir('yt-toggl-mcp-repo-');
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeFileSync(
      join(repo, PROJECT_SETTINGS_FILENAME),
      JSON.stringify({ workspaceId: 111, projectId: 222 }),
      'utf8'
    );
    const nested = join(repo, 'src', 'deep');
    mkdirSync(nested, { recursive: true });

    const warnings: string[] = [];
    expect(loadProjectSettings(nested, (message) => warnings.push(message))).toEqual({
      workspaceId: 111,
      projectId: 222,
    });
    expect(warnings).toHaveLength(0);
  });

  it('does not walk past the repository root into a parent directory', () => {
    const outside = tempDir('yt-toggl-mcp-outside-');
    writeFileSync(
      join(outside, PROJECT_SETTINGS_FILENAME),
      JSON.stringify({ projectId: 999 }),
      'utf8'
    );
    const repo = join(outside, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });

    const warnings: string[] = [];
    expect(loadProjectSettings(repo, (message) => warnings.push(message))).toEqual({
      workspaceId: undefined,
      projectId: undefined,
    });
    expect(warnings[0]).toContain(join(repo, PROJECT_SETTINGS_FILENAME));
  });

  it('rejects an apiToken so a project file never holds a secret', () => {
    const project = makeProject(
      JSON.stringify({ apiToken: 'leaked-token', workspaceId: 1, projectId: 2 })
    );

    expect(() => loadProjectSettings(project)).toThrow(/Invalid apiToken/);
    expect(() => loadProjectSettings(project)).toThrow(/user-scoped/);
  });

  it('rejects ids that are not positive integers', () => {
    const badWorkspace = makeProject(JSON.stringify({ workspaceId: 'abc' }));
    const badProject = makeProject(JSON.stringify({ projectId: -1 }));
    const emptyProject = makeProject(JSON.stringify({ projectId: {} }));
    const zeroWorkspace = makeProject(JSON.stringify({ workspaceId: 0 }));
    // Accepted by Number() but not by parseId, so it must not slip through.
    const exponentWorkspace = makeProject(JSON.stringify({ workspaceId: '1e3' }));
    const decimalProject = makeProject(JSON.stringify({ projectId: '12.0' }));

    expect(() => loadProjectSettings(badWorkspace)).toThrow(/Invalid workspaceId/);
    expect(() => loadProjectSettings(badProject)).toThrow(/Invalid projectId/);
    expect(() => loadProjectSettings(emptyProject)).toThrow(/Invalid projectId/);
    expect(() => loadProjectSettings(zeroWorkspace)).toThrow(/Invalid workspaceId/);
    expect(() => loadProjectSettings(exponentWorkspace)).toThrow(/Invalid workspaceId/);
    expect(() => loadProjectSettings(decimalProject)).toThrow(/Invalid projectId/);
  });

  it('names the offending file when its JSON is malformed', () => {
    const project = makeProject('{ not json');

    expect(() => loadProjectSettings(project)).toThrow(/Invalid JSON in .*\.yt-toggl-mcp\.json/);
  });

  it('rejects a document that is not a JSON object', () => {
    const project = makeProject('["workspaceId"]');

    expect(() => loadProjectSettings(project)).toThrow(/expected a JSON object/);
  });
});
