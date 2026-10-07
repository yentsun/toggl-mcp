import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CREDENTIALS_DIRNAME,
  CREDENTIALS_FILENAME,
  CredentialsError,
  credentialsPath,
  loadCredentials,
  settingsPathFromArgv,
} from '../src/credentials.js';

const tempDirs: string[] = [];

function makeHome(contents?: string): string {
  const home = mkdtempSync(join(tmpdir(), 'yt-toggl-mcp-creds-'));
  tempDirs.push(home);
  if (contents !== undefined) {
    mkdirSync(join(home, CREDENTIALS_DIRNAME), { recursive: true });
    writeFileSync(join(home, CREDENTIALS_DIRNAME, CREDENTIALS_FILENAME), contents, 'utf8');
  }
  return home;
}

function makeSettings(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'yt-toggl-mcp-settings-'));
  tempDirs.push(dir);
  const file = join(dir, 'settings.json');
  writeFileSync(file, contents, 'utf8');
  return file;
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('settingsPathFromArgv', () => {
  it('returns undefined when no settings file is selected', () => {
    expect(settingsPathFromArgv([])).toBeUndefined();
    expect(settingsPathFromArgv(['--version', '--help'])).toBeUndefined();
  });

  it('reads the path after --settings', () => {
    expect(settingsPathFromArgv(['--settings', '.yt-toggl.json'])).toBe('.yt-toggl.json');
    expect(settingsPathFromArgv(['--settings', '  spaced.json  ', 'extra'])).toBe('spaced.json');
  });

  it('reads the path from --settings=<path>', () => {
    expect(settingsPathFromArgv(['--settings=project.json'])).toBe('project.json');
  });

  it('rejects --settings without a path', () => {
    expect(() => settingsPathFromArgv(['--settings'])).toThrow(/requires a file path/);
    expect(() => settingsPathFromArgv(['--settings='])).toThrow(/requires a file path/);
    expect(() => settingsPathFromArgv(['--settings', '   '])).toThrow(/requires a file path/);
  });
});

describe('credentialsPath', () => {
  it('points at a per-tool directory in the home folder', () => {
    expect(credentialsPath(join('home', 'user'))).toBe(
      join('home', 'user', '.yt-toggl-mcp', 'credentials.json')
    );
  });
});

describe('loadCredentials', () => {
  it('reads the token, workspace id and project id from the credentials file', () => {
    const home = makeHome(
      JSON.stringify({ apiToken: 'file-token', workspaceId: 1835443, projectId: 216478744 })
    );

    expect(loadCredentials({}, home)).toEqual({
      apiToken: 'file-token',
      defaultWorkspaceId: 1835443,
      defaultProjectId: 216478744,
    });
  });

  it('trims a padded token and accepts ids stored as strings', () => {
    const home = makeHome(
      JSON.stringify({ apiToken: '  file-token  ', workspaceId: '12345', projectId: '67890' })
    );

    expect(loadCredentials({}, home)).toEqual({
      apiToken: 'file-token',
      defaultWorkspaceId: '12345',
      defaultProjectId: '67890',
    });
  });

  it('lets the environment token override the file token, keeping the file defaults', () => {
    const home = makeHome(JSON.stringify({ apiToken: 'file-token', workspaceId: 111 }));

    expect(loadCredentials({ TOGGL_API_KEY: 'env-token' }, home)).toStrictEqual({
      apiToken: 'env-token',
      defaultWorkspaceId: 111,
      defaultProjectId: undefined,
    });
  });

  it('ignores a blank environment token', () => {
    const home = makeHome(JSON.stringify({ apiToken: 'file-token', workspaceId: 111 }));

    expect(loadCredentials({ TOGGL_API_KEY: '   ' }, home)).toStrictEqual({
      apiToken: 'file-token',
      defaultWorkspaceId: 111,
      defaultProjectId: undefined,
    });
  });

  it('returns no defaults when none are configured', () => {
    const home = makeHome(JSON.stringify({ apiToken: 'file-token' }));

    expect(loadCredentials({}, home)).toStrictEqual({
      apiToken: 'file-token',
      defaultWorkspaceId: undefined,
      defaultProjectId: undefined,
    });
  });

  it('ignores default ids that are neither numbers nor strings', () => {
    const home = makeHome(
      JSON.stringify({ apiToken: 'file-token', workspaceId: {}, projectId: true })
    );

    expect(loadCredentials({}, home)).toStrictEqual({
      apiToken: 'file-token',
      defaultWorkspaceId: undefined,
      defaultProjectId: undefined,
    });
  });

  it('ignores a blank project id', () => {
    const home = makeHome(JSON.stringify({ apiToken: 'file-token', projectId: '   ' }));

    expect(loadCredentials({}, home).defaultProjectId).toBeUndefined();
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

  it('behaves exactly as before when no settings file is selected', () => {
    const home = makeHome(JSON.stringify({ apiToken: 'file-token', workspaceId: 111 }));

    expect(loadCredentials({}, home, undefined)).toStrictEqual(loadCredentials({}, home));
  });
});

describe('loadCredentials with a project settings file', () => {
  it('shares the user token while the settings file overrides both defaults', () => {
    const home = makeHome(
      JSON.stringify({ apiToken: 'file-token', workspaceId: 111, projectId: 222 })
    );
    const settings = makeSettings(JSON.stringify({ workspaceId: 333, projectId: 444 }));

    expect(loadCredentials({}, home, settings)).toEqual({
      apiToken: 'file-token',
      defaultWorkspaceId: 333,
      defaultProjectId: 444,
    });
  });

  it('keeps the user defaults for keys the settings file omits', () => {
    const home = makeHome(
      JSON.stringify({ apiToken: 'file-token', workspaceId: 111, projectId: 222 })
    );
    const settings = makeSettings(JSON.stringify({ projectId: 999 }));

    expect(loadCredentials({}, home, settings)).toEqual({
      apiToken: 'file-token',
      defaultWorkspaceId: 111,
      defaultProjectId: 999,
    });
  });

  it('keeps the user defaults when the settings file is empty', () => {
    const home = makeHome(
      JSON.stringify({ apiToken: 'file-token', workspaceId: 111, projectId: 222 })
    );
    const settings = makeSettings('{}');

    expect(loadCredentials({}, home, settings)).toEqual({
      apiToken: 'file-token',
      defaultWorkspaceId: 111,
      defaultProjectId: 222,
    });
  });

  it('accepts settings ids stored as numeric strings', () => {
    const home = makeHome(JSON.stringify({ apiToken: 'file-token', workspaceId: 111 }));
    const settings = makeSettings(JSON.stringify({ workspaceId: '333', projectId: '444' }));

    expect(loadCredentials({}, home, settings)).toEqual({
      apiToken: 'file-token',
      defaultWorkspaceId: '333',
      defaultProjectId: '444',
    });
  });

  it('ignores an apiToken in the settings file', () => {
    const home = makeHome(JSON.stringify({ apiToken: 'file-token' }));
    const settings = makeSettings(JSON.stringify({ apiToken: 'settings-token', workspaceId: 5 }));

    expect(loadCredentials({}, home, settings).apiToken).toBe('file-token');
  });

  it('still requires the token in the user file or the environment', () => {
    const home = makeHome();
    const settings = makeSettings(JSON.stringify({ apiToken: 'settings-token' }));

    expect(() => loadCredentials({}, home, settings)).toThrow(credentialsPath(home));
  });

  it('lets the environment token win while keeping the settings defaults', () => {
    const home = makeHome(JSON.stringify({ apiToken: 'file-token', workspaceId: 111 }));
    const settings = makeSettings(JSON.stringify({ workspaceId: 333 }));

    expect(loadCredentials({ TOGGL_API_KEY: 'env-token' }, home, settings)).toStrictEqual({
      apiToken: 'env-token',
      defaultWorkspaceId: 333,
      defaultProjectId: undefined,
    });
  });

  it('fails when the selected settings file is missing', () => {
    const home = makeHome(JSON.stringify({ apiToken: 'file-token' }));
    const missing = join(home, 'nope.json');

    expect(() => loadCredentials({}, home, missing)).toThrow(/Settings file not found/);
    expect(() => loadCredentials({}, home, missing)).toThrow('nope.json');
  });

  it('rejects malformed JSON in the settings file', () => {
    const home = makeHome(JSON.stringify({ apiToken: 'file-token' }));
    const settings = makeSettings('{ not json');

    expect(() => loadCredentials({}, home, settings)).toThrow(/Invalid JSON in .*settings\.json/);
  });

  it('rejects a settings document that is not an object', () => {
    const home = makeHome(JSON.stringify({ apiToken: 'file-token' }));
    const settings = makeSettings('["workspaceId"]');

    expect(() => loadCredentials({}, home, settings)).toThrow(/expected a JSON object/);
  });

  it('rejects a settings id that is not a positive integer', () => {
    const home = makeHome(JSON.stringify({ apiToken: 'file-token' }));
    const badWorkspace = makeSettings(JSON.stringify({ workspaceId: 'abc' }));
    const badProject = makeSettings(JSON.stringify({ projectId: -1 }));
    const emptyProject = makeSettings(JSON.stringify({ projectId: {} }));

    expect(() => loadCredentials({}, home, badWorkspace)).toThrow(/Invalid workspaceId/);
    expect(() => loadCredentials({}, home, badProject)).toThrow(/Invalid projectId/);
    expect(() => loadCredentials({}, home, emptyProject)).toThrow(/Invalid projectId/);
  });
});
