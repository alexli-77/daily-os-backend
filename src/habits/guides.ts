import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig } from '../config/schema.js';

/**
 * The user's own method skills, read for a part of the day (`config.habits`).
 *
 * A skill is an Agent Skill folder (`<skills_dir>/<name>/SKILL.md`); its body,
 * without the frontmatter, is what a scheduled run is given. Bounded per skill
 * and in total, so a long skill cannot crowd out the day's own evidence. A
 * skill that is not there is skipped — the run goes on as before.
 */

const PER_SKILL = 7000;
const TOTAL = 16000;

export function skillsDir(config: AppConfig): string {
  const dir = config.habits?.skills_dir || '~/.claude/skills';
  return dir.startsWith('~/') ? path.join(os.homedir(), dir.slice(2)) : path.resolve(dir);
}

/** A skill folder under `skills_dir`: `name`, or `group/name` for one kept in a sub-folder. */
const SKILL_NAME = /^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)?$/;

export function readGuideSkill(config: AppConfig, name: string): string | null {
  if (!SKILL_NAME.test(name)) return null;
  try {
    const text = fs.readFileSync(path.join(skillsDir(config), name, 'SKILL.md'), 'utf8');
    return text.replace(/^---\n[\s\S]*?\n---\n/, '').trim().slice(0, PER_SKILL);
  } catch {
    return null;
  }
}

/** The named skills as one section, or '' when none can be read. */
export function renderGuides(config: AppConfig, names: string[]): string {
  const parts: string[] = [];
  let used = 0;
  for (const name of names) {
    const body = readGuideSkill(config, name);
    if (!body) continue;
    const piece = `## ${path.basename(name)}\n${body}`;
    if (used + piece.length > TOTAL) break;
    parts.push(piece);
    used += piece.length;
  }
  return parts.join('\n\n');
}

/** Which guides a workflow reads. */
export function guidesFor(config: AppConfig, workflow: string): string[] {
  if (workflow === 'daily_plan') return config.habits?.daily_plan ?? [];
  if (workflow === 'daily_review') return config.habits?.daily_review ?? [];
  return [];
}

/**
 * The chat's copy of the user's method skills (`config.habits.chat`), so a
 * question asked any time can be answered with them. The chat loads project
 * skills only (`--setting-sources project`), so they are copied into the
 * workdir's `.claude/skills/` — the folder's markdown files, refreshed when
 * they change. Returns the names copied and their one-line descriptions.
 */
export function syncUserChatSkills(config: AppConfig, workdir: string): Array<{ name: string; description: string }> {
  const out: Array<{ name: string; description: string }> = [];
  for (const entry of config.habits?.chat ?? []) {
    if (!SKILL_NAME.test(entry)) continue;
    // Copied flat, by its own folder name: the 7 Habits entry reads its eight
    // habits as siblings (`../<name>/SKILL.md`).
    const name = path.basename(entry);
    const from = path.join(skillsDir(config), entry);
    try {
      const files = fs.readdirSync(from, { withFileTypes: true }).filter((file) => file.isFile() && file.name.endsWith('.md'));
      if (!files.some((file) => file.name === 'SKILL.md')) continue;
      for (const file of files) {
        const text = fs.readFileSync(path.join(from, file.name), 'utf8');
        const to = path.join(workdir, '.claude', 'skills', name, file.name);
        if (!fs.existsSync(to) || fs.readFileSync(to, 'utf8') !== text) {
          fs.mkdirSync(path.dirname(to), { recursive: true });
          fs.writeFileSync(to, text, 'utf8');
        }
      }
      out.push({ name, description: skillDescription(fs.readFileSync(path.join(from, 'SKILL.md'), 'utf8')) });
    } catch {
      // Not installed: skipped.
    }
  }
  return out;
}

/** The `description:` of a SKILL.md frontmatter, one line, folded or quoted. */
export function skillDescription(text: string): string {
  const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '';
  const lines = front.split('\n');
  const at = lines.findIndex((line) => line.startsWith('description:'));
  if (at < 0) return '';
  let value = lines[at]!.slice('description:'.length).trim();
  if (value === '>' || value === '|' || value === '>-' || value === '|-' || value === '') {
    const folded: string[] = [];
    for (let index = at + 1; index < lines.length && /^\s+/.test(lines[index]!); index += 1) folded.push(lines[index]!.trim());
    value = folded.join(' ');
  }
  return value.replace(/^["']|["']$/g, '').slice(0, 240);
}
