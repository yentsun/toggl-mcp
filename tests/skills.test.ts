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
  // OpenCode accepts `.opencode/skills/<id>/SKILL.md` at any depth and
  // `.opencode/skills/<id>.md` at the source root, so collect both forms.
  const files = readdirSync(SKILLS_DIR, { recursive: true, encoding: 'utf8' }).filter((file) =>
    file.endsWith('.md')
  );

  return files
    .filter((file) => {
      const depth = file.split(sep).length;
      return file.split(sep).pop() === 'SKILL.md' || depth === 1;
    })
    .map((file) => join(SKILLS_DIR, file));
}

/**
 * Directory-based skills are `.opencode/skills/<id>/SKILL.md`. OpenCode also
 * accepts a flat `.opencode/skills/<id>.md`, so cover both when deriving the id.
 */
function skillId(file: string): string {
  const [first, ...rest] = file.slice(SKILLS_DIR.length + 1).split(sep);

  // A flat `<id>.md` has no second segment; a directory skill keeps its name.
  return rest.length === 0 ? first!.replace(/\.md$/, '') : first!;
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
      // `.opencode/skills/<id>/SKILL.md` or `.opencode/skills/<id>.md`; the file
      // name or directory name is the id, used verbatim and case-sensitively.
      const id = skillId(file);

      expect(id, file).toMatch(ID_PATTERN);
      expect(id.length, file).toBeLessThanOrEqual(64);
    }
  });
});
