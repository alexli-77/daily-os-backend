import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import type { AppConfig } from '../config/schema.js';
import { writeFileAtomic } from '../utils/atomic-write.js';

/**
 * Cycle files: the single source of truth for one weekly/biweekly cycle (LEO-276).
 *
 * One markdown file per cycle under `<memory repo>/20_CYCLES`, sitting next to
 * `10_OKR` and resolved the same way as the OKR editor (okr/editor.ts): the
 * vault repository when it is reachable, else the bundled default vault.
 *
 * A cycle has exactly three sections, and their value comes from the fact that
 * they have *different owners*:
 *
 *   要务   planner-generated priorities
 *   retro  written by hand by the user
 *   review AI-generated
 *
 * So ownership has to live in the data, not in a convention: the frontmatter
 * records `source` and `updated_at` per section. LEO-279 needs exactly this to
 * decide whether the planner may overwrite a section — a planner re-run must
 * never silently eat a hand-written retro. Section-level timestamps also make
 * "is the review older than the retro it reviews?" answerable, which a single
 * file-level `updated_at` cannot.
 *
 * Writes go through `writeSection` / `writeCycle`, which merge into the file on
 * disk rather than replacing it, and land atomically (temp file + rename), so a
 * crash mid-write never leaves half a cycle behind.
 *
 * Parsing is deliberately forgiving: these files are meant to be hand-edited in
 * the user's vault. Missing sections, missing frontmatter and broken YAML all
 * degrade to a readable document instead of throwing, and any heading the
 * parser does not know about is carried through untouched.
 */

export const CYCLE_SECTIONS = ['要务', 'retro', 'review'] as const;
export type CycleSection = (typeof CYCLE_SECTIONS)[number];

/** Who last wrote a section. `unknown` = the file never said. */
export const CYCLE_SECTION_SOURCES = ['planner', 'user', 'ai', 'unknown'] as const;
export type CycleSectionSource = (typeof CYCLE_SECTION_SOURCES)[number];

/** Modes we generate. Unrecognised modes in a file are preserved verbatim. */
export const CYCLE_MODES = ['weekly', 'biweekly'] as const;
export const DEFAULT_CYCLE_MODE = 'biweekly';

/** A regenerated version of a section, staged for the user to compare and merge. */
export interface CycleSectionDraft {
  content: string;
  source: CycleSectionSource;
  /** ISO-8601 of when the draft was staged. */
  updatedAt: string;
}

export interface CycleSectionState {
  content: string;
  source: CycleSectionSource;
  /** ISO-8601, or '' when the file never recorded one. */
  updatedAt: string;
  /**
   * A newer, un-merged version of this section. Set when a planner re-run
   * produced content for a section the user had hand-edited: the body is left
   * alone and the new content waits here for an explicit accept/discard, so a
   * regeneration never silently eats a hand edit.
   */
  pendingDraft?: CycleSectionDraft;
}

/** A body block in file order. `heading` is '' for text before the first `## `. */
export interface CycleBlock {
  heading: string;
  content: string;
}

export interface CycleDoc {
  /** `<YYYY-MM-DD>_<cycle-label>`, i.e. the file name without `.md`. */
  id: string;
  /** Cycle start date, `YYYY-MM-DD`. */
  startDate: string;
  /** Cycle label as used by the planner and Feishu, e.g. `8.24-9.6`. */
  cycle: string;
  mode: string;
  runId: string;
  /** ISO-8601 of the last write to the file, or '' when never recorded. */
  updatedAt: string;
  /** Only sections actually present in the body. */
  sections: Partial<Record<CycleSection, CycleSectionState>>;
  /**
   * The whole body in file order, including headings this module does not know
   * about. Serialization reads this, not `sections` — treat both as read-only
   * and go through `writeCycle` / `writeSection` to change a document.
   */
  blocks: CycleBlock[];
  /**
   * Frontmatter keys this module does not know about, carried through untouched.
   * Symmetrical with unknown `##` headings: the file is hand-edited, so dropping
   * keys we did not expect would be silent data loss.
   */
  extra?: Record<string, unknown>;
  /** Set when the frontmatter existed but could not be parsed. */
  frontmatterError?: string;
}

export interface CyclePatch {
  cycle?: string;
  mode?: string;
  runId?: string;
  /**
   * Per section, one of:
   * - `{ content, source }` — write the body (and clear any pending draft).
   * - `{ pendingDraft: { content, source } }` — stage a draft, leave the body.
   * - `{ pendingDraft: null }` — clear the pending draft (discard).
   */
  sections?: Partial<
    Record<
      CycleSection,
      {
        content?: string;
        source?: CycleSectionSource;
        pendingDraft?: { content: string; source: CycleSectionSource } | null;
      }
    >
  >;
}

export interface CycleWriteOptions {
  /** ISO-8601 timestamp to stamp the write with. Defaults to now. */
  now?: string;
}

const CYCLE_ID_PATTERN = /^(\d{4}-\d{2}-\d{2})_([^\s/\\]+)$/;

/** Build the file id (and therefore file name) for a cycle. */
export function buildCycleId(startDate: string, cycle: string): string {
  const id = `${(startDate || '').trim()}_${(cycle || '').trim()}`;
  if (!CYCLE_ID_PATTERN.test(id)) {
    throw new Error(`Invalid cycle id: ${id} (expected <YYYY-MM-DD>_<cycle-label>)`);
  }
  return id;
}

/** Inverse of `buildCycleId`. Returns null for anything that is not a cycle id. */
export function parseCycleId(id: string): { startDate: string; cycle: string } | null {
  const match = CYCLE_ID_PATTERN.exec((id || '').trim());
  if (!match) return null;
  if (match[2] === '.' || match[2] === '..') return null;
  return { startDate: match[1], cycle: match[2] };
}

/**
 * `<repo>/20_CYCLES` when the vault repository is reachable, else the bundled
 * default vault. Mirrors okr/editor.ts, except that the cycles directory itself
 * is created on demand, so its absence must not push us to the fallback.
 */
export function cyclesDir(config: AppConfig): string {
  const trimmed = (config.memory?.repository_path || '').trim();
  if (trimmed) {
    const candidate = path.resolve(trimmed, '20_CYCLES');
    if (fs.existsSync(candidate) || fs.existsSync(path.resolve(trimmed))) return candidate;
  }
  return path.resolve('memory-vault', 'default', '20_CYCLES');
}

export function cycleFilePath(config: AppConfig, id: string): string {
  const parsed = parseCycleId(id);
  if (!parsed) throw new Error(`Invalid cycle id: ${id}`);
  return path.join(cyclesDir(config), `${id}.md`);
}

/** Every cycle on disk, newest start date first. Never throws on a bad file. */
export function listCycles(config: AppConfig): CycleDoc[] {
  const dir = cyclesDir(config);
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const docs: CycleDoc[] = [];
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    const id = name.slice(0, -3);
    if (!parseCycleId(id)) continue;
    const doc = readCycle(config, id);
    if (doc) docs.push(doc);
  }
  return docs.sort((left, right) => (left.id < right.id ? 1 : left.id > right.id ? -1 : 0));
}

/** Read one cycle. Returns null when the file does not exist or is unreadable. */
export function readCycle(config: AppConfig, id: string): CycleDoc | null {
  const parsed = parseCycleId(id);
  if (!parsed) return null;
  let markdown: string;
  try {
    markdown = fs.readFileSync(path.join(cyclesDir(config), `${id}.md`), 'utf8');
  } catch {
    return null;
  }
  return parseCycleMarkdown(markdown, id);
}

/**
 * Merge `patch` into the cycle on disk (creating it when missing) and write it
 * atomically. Fields the patch omits keep their stored value; sections the
 * patch omits keep their content, source and timestamp.
 */
export function writeCycle(config: AppConfig, id: string, patch: CyclePatch, options: CycleWriteOptions = {}): CycleDoc {
  if (!parseCycleId(id)) throw new Error(`Invalid cycle id: ${id}`);
  const now = options.now || new Date().toISOString();
  const current = readCycle(config, id) || emptyCycleDoc(id);

  // Refuse rather than overwrite what we could not read. Serializing a document
  // whose frontmatter failed to parse would drop every key it held, and these
  // files are not recoverable: the vault directory holding them is untracked in
  // git, so there is no version history to fall back on. The caller is expected
  // to surface `frontmatterError` and let the user repair the file directly.
  if (current.frontmatterError) {
    throw new Error(
      `Refusing to write ${id}: its frontmatter could not be parsed (${current.frontmatterError}). ` +
        'Fix the frontmatter in the file first — writing now would discard it.',
    );
  }

  const next: CycleDoc = {
    ...current,
    cycle: patch.cycle?.trim() || current.cycle,
    mode: patch.mode?.trim() || current.mode,
    runId: patch.runId?.trim() ?? current.runId,
    updatedAt: now,
    blocks: current.blocks.map((block) => ({ ...block })),
    sections: { ...current.sections },
    extra: { ...(current.extra || {}) },
  };

  for (const section of CYCLE_SECTIONS) {
    const update = patch.sections?.[section];
    if (!update) continue;
    const prior = next.sections[section];
    let content = prior?.content ?? '';
    let source: CycleSectionSource = prior?.source ?? 'unknown';
    let updatedAt = prior?.updatedAt ?? '';
    let pendingDraft = prior?.pendingDraft;

    if (update.content !== undefined) {
      // A real body write. Clears any pending draft — the body is now settled.
      content = normalizeContent(update.content);
      source = update.source ?? source;
      updatedAt = now;
      pendingDraft = undefined;
      upsertBlock(next.blocks, section, content);
    }
    if (update.pendingDraft !== undefined) {
      pendingDraft =
        update.pendingDraft === null
          ? undefined
          : { content: normalizeContent(update.pendingDraft.content), source: update.pendingDraft.source, updatedAt: now };
    }
    next.sections[section] = { content, source, updatedAt, ...(pendingDraft ? { pendingDraft } : {}) };
  }

  const filePath = path.join(cyclesDir(config), `${id}.md`);
  writeFileAtomic(filePath, serializeCycleMarkdown(next));
  return next;
}

/**
 * Write a single section. The other two sections are read from disk and written
 * back untouched — including their `source` and `updated_at` — so a planner run
 * can never quietly restamp a hand-written retro as its own.
 */
export function writeSection(
  config: AppConfig,
  id: string,
  section: CycleSection,
  content: string,
  source: CycleSectionSource,
  options: CycleWriteOptions = {},
): CycleDoc {
  if (!CYCLE_SECTIONS.includes(section)) throw new Error(`Unknown cycle section: ${section}`);
  return writeCycle(config, id, { sections: { [section]: { content, source } } }, options);
}

/** Delete a cycle file. Returns false when there was nothing to delete. */
export function deleteCycle(config: AppConfig, id: string): boolean {
  if (!parseCycleId(id)) throw new Error(`Invalid cycle id: ${id}`);
  const filePath = path.join(cyclesDir(config), `${id}.md`);
  if (!fs.existsSync(filePath)) return false;
  fs.rmSync(filePath, { force: true });
  return true;
}

// --- markdown <-> object -----------------------------------------------------

/** Parse a cycle file. Total: any input yields a document, never an exception. */
export function parseCycleMarkdown(markdown: string, id: string): CycleDoc {
  const parsedId = parseCycleId(id);
  const text = (markdown || '').replace(/\r\n/g, '\n');
  const { frontmatter, body, error } = splitFrontmatter(text);

  const meta = (frontmatter && typeof frontmatter === 'object' ? (frontmatter as Record<string, unknown>) : {}) as Record<string, unknown>;
  const sectionMeta = readSectionMeta(meta.sections);
  const blocks = parseBlocks(body);

  const sections: Partial<Record<CycleSection, CycleSectionState>> = {};
  for (const block of blocks) {
    const section = CYCLE_SECTIONS.find((candidate) => candidate === block.heading);
    if (!section) continue;
    const stored = sectionMeta[section];
    sections[section] = {
      content: block.content,
      source: stored?.source || 'unknown',
      updatedAt: stored?.updatedAt || '',
      ...(stored?.pendingDraft ? { pendingDraft: stored.pendingDraft } : {}),
    };
  }

  const doc: CycleDoc = {
    id,
    startDate: parsedId?.startDate || '',
    cycle: asString(meta.cycle) || parsedId?.cycle || '',
    mode: asString(meta.mode) || DEFAULT_CYCLE_MODE,
    runId: asString(meta.run_id),
    updatedAt: asString(meta.updated_at),
    sections,
    blocks,
    extra: pickExtraFrontmatter(meta),
  };
  if (error) doc.frontmatterError = error;
  return doc;
}

/** Serialize a document back to markdown. Inverse of `parseCycleMarkdown`. */
export function serializeCycleMarkdown(doc: CycleDoc): string {
  const sections: Record<string, Record<string, unknown>> = {};
  for (const block of doc.blocks) {
    const section = CYCLE_SECTIONS.find((candidate) => candidate === block.heading);
    if (!section) continue;
    const state = doc.sections[section];
    const entry: Record<string, unknown> = { source: state?.source || 'unknown' };
    if (state?.updatedAt) entry.updated_at = state.updatedAt;
    if (state?.pendingDraft) {
      entry.pending_draft = {
        source: state.pendingDraft.source,
        ...(state.pendingDraft.updatedAt ? { updated_at: state.pendingDraft.updatedAt } : {}),
        content: state.pendingDraft.content,
      };
    }
    sections[section] = entry;
  }

  const meta: Record<string, unknown> = {
    cycle: doc.cycle,
    mode: doc.mode || DEFAULT_CYCLE_MODE,
  };
  if (doc.runId) meta.run_id = doc.runId;
  if (doc.updatedAt) meta.updated_at = doc.updatedAt;
  meta.sections = sections;
  // Same reason unknown headings are carried through: the file is meant to be
  // hand-edited, and a parser that preserves the body while quietly dropping
  // frontmatter keys is forgiving in one half and destructive in the other.
  for (const [key, value] of Object.entries(doc.extra || {})) {
    if (!(key in meta)) meta[key] = value;
  }

  // flowLevel 2 keeps each section's metadata on one line, so a human reading
  // the file sees ownership at a glance instead of a 9-line nested map.
  const frontmatter = yaml.dump(meta, { flowLevel: 2, lineWidth: -1, noRefs: true, quotingType: "'" });

  const body = doc.blocks
    .map((block) => (block.heading ? `## ${block.heading}\n${block.content}` : block.content))
    .filter((chunk) => chunk.trim().length > 0)
    .join('\n\n');

  return body ? `---\n${frontmatter}---\n\n${body}\n` : `---\n${frontmatter}---\n`;
}

// --- internals ---------------------------------------------------------------

const KNOWN_FRONTMATTER_KEYS = new Set(['cycle', 'mode', 'run_id', 'updated_at', 'sections']);

/** Everything in the frontmatter that is not one of ours. */
function pickExtraFrontmatter(meta: Record<string, unknown>): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (!KNOWN_FRONTMATTER_KEYS.has(key)) extra[key] = value;
  }
  return extra;
}

function emptyCycleDoc(id: string): CycleDoc {
  const parsed = parseCycleId(id);
  return {
    id,
    startDate: parsed?.startDate || '',
    cycle: parsed?.cycle || '',
    mode: DEFAULT_CYCLE_MODE,
    runId: '',
    updatedAt: '',
    sections: {},
    blocks: [],
    extra: {},
  };
}

function splitFrontmatter(text: string): { frontmatter: unknown; body: string; error?: string } {
  const lines = text.split('\n');
  if (lines[0].trim() !== '---') return { frontmatter: null, body: text };
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  // An unterminated block is a broken file, not a document with a 200-line
  // frontmatter: keep the text as body rather than swallowing all of it.
  if (end < 0) return { frontmatter: null, body: text, error: 'Unterminated frontmatter block.' };
  const raw = lines.slice(1, end).join('\n');
  const body = lines.slice(end + 1).join('\n');
  try {
    return { frontmatter: yaml.load(raw), body };
  } catch (error) {
    // A hand-edited file with broken YAML still has a readable body; surface the
    // problem instead of failing the whole read.
    return { frontmatter: null, body, error: error instanceof Error ? error.message : String(error) };
  }
}

type SectionMeta = { source: CycleSectionSource; updatedAt: string; pendingDraft?: CycleSectionDraft };

function normalizeSource(value: unknown): CycleSectionSource {
  const source = asString(value);
  return (CYCLE_SECTION_SOURCES as readonly string[]).includes(source) ? (source as CycleSectionSource) : 'unknown';
}

function readSectionMeta(raw: unknown): Partial<Record<CycleSection, SectionMeta>> {
  const result: Partial<Record<CycleSection, SectionMeta>> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result;
  for (const section of CYCLE_SECTIONS) {
    const entry = (raw as Record<string, unknown>)[section];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const meta: SectionMeta = { source: normalizeSource(record.source), updatedAt: asString(record.updated_at) };
    const draftRaw = record.pending_draft;
    if (draftRaw && typeof draftRaw === 'object' && !Array.isArray(draftRaw)) {
      const dr = draftRaw as Record<string, unknown>;
      const content = asString(dr.content);
      if (content) meta.pendingDraft = { content, source: normalizeSource(dr.source), updatedAt: asString(dr.updated_at) };
    }
    result[section] = meta;
  }
  return result;
}

/**
 * Split the body on `## ` headings. Fenced code blocks are skipped so a `##`
 * inside a snippet in the retro cannot split the document.
 */
function parseBlocks(body: string): CycleBlock[] {
  const blocks: CycleBlock[] = [];
  let heading = '';
  let buffer: string[] = [];
  let fence = '';

  const flush = (): void => {
    const content = normalizeContent(buffer.join('\n'));
    if (heading || content) blocks.push({ heading, content });
    buffer = [];
  };

  for (const line of body.split('\n')) {
    const fenceMatch = /^\s*(```+|~~~+)/.exec(line);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1][0];
      else if (line.trimStart().startsWith(fence)) fence = '';
    }
    const headingMatch = fence ? null : /^##[ \t]+(.+?)[ \t]*$/.exec(line);
    if (headingMatch) {
      flush();
      heading = headingMatch[1];
      continue;
    }
    buffer.push(line);
  }
  flush();
  return blocks;
}

/**
 * Replace a section in place, or insert it so the three known sections stay in
 * 要务 / retro / review order regardless of the order they were written in.
 */
function upsertBlock(blocks: CycleBlock[], section: CycleSection, content: string): void {
  const index = blocks.findIndex((block) => block.heading === section);
  if (index >= 0) {
    blocks[index] = { heading: section, content };
    return;
  }
  const rank = CYCLE_SECTIONS.indexOf(section);
  const before = blocks.findIndex((block) => {
    const other = CYCLE_SECTIONS.indexOf(block.heading as CycleSection);
    return other >= 0 && other > rank;
  });
  if (before >= 0) blocks.splice(before, 0, { heading: section, content });
  else blocks.push({ heading: section, content });
}

/** Trim surrounding blank lines and trailing spaces; keep everything else. */
function normalizeContent(value: string): string {
  return (value || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}

/** YAML resolves bare timestamps to Date and `9.6` to a number; re-flatten. */
function asString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}
