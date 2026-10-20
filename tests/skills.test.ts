import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * OpenCode discovers project skills at `.opencode/skills/<id>/SKILL.md` and
 * derives the skill ID from the path, not from the `name` field. The ID is what
 * the `skill` tool takes, so a rename here silently changes how it is loaded.
 */
const SKILLS_DIR = '.opencode/skills';
const ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function skillFiles(): string[] {
  return readdirSync(SKILLS_DIR, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.split(sep).pop() === 'SKILL.md')
    .map((file) => join(SKILLS_DIR, file));
}

function frontmatter(file: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(readFileSync(file, 'utf8'));
  if (!match) return {};

  const fields: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const entry = /^([\w-]+):\s*(.+)$/.exec(line);
    if (entry) fields[entry[1]!] = entry[2]!.trim();
  }
  return fields;
}

describe('project skills', () => {
  it('has at least one skill', () => {
    expect(skillFiles().length).toBeGreaterThan(0);
  });

  it('gives every skill a description, which is what advertises it', () => {
    for (const file of skillFiles()) {
      expect(frontmatter(file).description, file).toBeTruthy();
    }
  });

  it('names every skill directory with a portable kebab-case id', () => {
    for (const file of skillFiles()) {
      // `.opencode/skills/<id>/SKILL.md`; the id is the directory, lowercased by
      // OpenCode into a case-sensitive id.
      const [, source, id] = file.split(sep);

      expect(source, file).toBe('skills');
      expect(id, file).toMatch(ID_PATTERN);
      expect(id!.length, file).toBeLessThanOrEqual(64);
    }
  });
});
