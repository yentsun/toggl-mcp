import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The published server must reach the handshake without a project settings
 * file, and the handshake must carry the setup instructions that start the
 * guided flow. A startup exit here would take every Toggl tool away from a
 * client that has not configured the file yet, which is what 0.7.0 regressed.
 */
const ENTRY = join(process.cwd(), 'dist', 'index.js');
const tempDirs: string[] = [];

const initialize = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'probe', version: '1' },
  },
});

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function handshake(cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ENTRY], {
      cwd,
      env: { ...process.env, TOGGL_API_KEY: 'test-token' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.includes('\n')) child.kill();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    setTimeout(() => child.kill(), 10_000).unref();

    child.stdin.write(`${initialize}\n`);
  });
}

describe('server startup without a project settings file', () => {
  it('warns, completes the handshake, and asks for the setup flow', async () => {
    const project = mkdtempSync(join(tmpdir(), 'yt-toggl-mcp-startup-'));
    tempDirs.push(project);

    const { code, stdout, stderr } = await handshake(project);
    const response = JSON.parse(stdout.trim().split('\n')[0]!);

    expect(stderr).toContain('Project settings file not found');
    expect(response.result.instructions).toContain('toggl-setup');
    expect(response.result.instructions).toContain('toggl_check_auth');
    expect(code).not.toBe(1);
  });
});
