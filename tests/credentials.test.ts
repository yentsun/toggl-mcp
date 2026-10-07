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
} from '../src/credentials.js';

const homes: string[] = [];

function makeHome(contents?: string): string {
  const home = mkdtempSync(join(tmpdir(), 'yt-toggl-mcp-creds-'));
  homes.push(home);
  if (contents !== undefined) {
    mkdirSync(join(home, CREDENTIALS_DIRNAME), { recursive: true });
    writeFileSync(join(home, CREDENTIALS_DIRNAME, CREDENTIALS_FILENAME), contents, 'utf8');
  }
  return home;
}

afterEach(() => {
  while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true });
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

    expect(loadCredentials({ TOGGL_API_KEY: 'env-token' }, home)).toEqual({
      apiToken: 'env-token',
      defaultWorkspaceId: 111,
      defaultProjectId: undefined,
    });
  });

  it('ignores a blank environment token', () => {
    const home = makeHome(JSON.stringify({ apiToken: 'file-token', workspaceId: 111 }));

    expect(loadCredentials({ TOGGL_API_KEY: '   ' }, home)).toEqual({
      apiToken: 'file-token',
      defaultWorkspaceId: 111,
      defaultProjectId: undefined,
    });
  });

  it('returns no defaults when none are configured', () => {
    const home = makeHome(JSON.stringify({ apiToken: 'file-token' }));

    expect(loadCredentials({}, home)).toEqual({
      apiToken: 'file-token',
      defaultWorkspaceId: undefined,
      defaultProjectId: undefined,
    });
  });

  it('ignores default ids that are neither numbers nor strings', () => {
    const home = makeHome(
      JSON.stringify({ apiToken: 'file-token', workspaceId: {}, projectId: true })
    );

    expect(loadCredentials({}, home)).toEqual({
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
});
