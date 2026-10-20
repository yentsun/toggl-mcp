import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The published server must reach the handshake without a project settings
 * file. A startup exit here would take every Toggl tool away from a client
 * that has not configured the file yet, which is what 0.7.0 regressed.
 */
const ENTRY = join(process.cwd(), 'dist', 'index.js');
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function runFrom(cwd: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ENTRY], {
      cwd,
      env: { ...process.env, TOGGL_API_KEY: 'test-token' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      // The server announces itself once stdio is up; stop it there.
      if (stderr.includes('running on stdio')) child.kill();
    });
    child.on('close', (code) => resolve({ code, stderr }));
    // Give it a moment, then close stdin so a misbehaving server cannot hang.
    setTimeout(() => child.kill(), 10_000).unref();
  });
}

describe('server startup without a project settings file', () => {
  it('warns and reaches the handshake instead of exiting', async () => {
    const project = mkdtempSync(join(tmpdir(), 'yt-toggl-mcp-startup-'));
    tempDirs.push(project);

    const { code, stderr } = await runFrom(project);

    expect(stderr).toContain('Project settings file not found');
    expect(stderr).toContain('running on stdio');
    expect(code).not.toBe(1);
  });
});
