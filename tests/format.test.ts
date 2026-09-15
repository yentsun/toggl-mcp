import { describe, expect, it } from 'vitest';
import { maskEmail, publicWorkspaces } from '../src/format.js';
import type { Workspace } from '../src/types.js';

describe('maskEmail', () => {
  it('keeps the first local character and the domain', () => {
    expect(maskEmail('maksim@gmail.com')).toBe('m***@gmail.com');
  });

  it('handles strings without a domain', () => {
    expect(maskEmail('nope')).toBe('***');
  });
});

describe('publicWorkspaces', () => {
  it('drops credential and noise fields from Toggl workspace payloads', () => {
    const leaked = {
      id: 7,
      name: 'ws',
      api_token: 'super-secret',
      ical_url: '/ical/secret',
      default_hourly_rate: 35,
    } as unknown as Workspace;

    expect(publicWorkspaces([leaked])).toEqual([{ id: 7, name: 'ws' }]);
  });
});
