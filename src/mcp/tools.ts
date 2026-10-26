import { z } from 'zod';
import { readUiRuntime, type UiRuntime } from '../ui/ui-runtime.js';

/**
 * LEO-345 Phase 1 — the v1 tool set and the loopback caller, kept free of the
 * MCP SDK so the chat launcher can import the names/metadata without pulling
 * the SDK into the service hot path. The SDK glue lives in `daily-os-mcp.ts`.
 *
 * Each tool maps to a `/api/*` endpoint the console already uses, so every
 * write goes through the real handler — same validation, side effects (e.g.
 * schedule regeneration, OKR normalisation), confirmation gating and access
 * policy. The engine stays the user's subscription CLI; no API key.
 */

export const MCP_SERVER_NAME = 'daily-os';

/** Resolve the running server's URL + token, from the env the launcher passes */
/** or the runtime file it wrote. */
export function resolveRuntime(): UiRuntime {
  const url = process.env.DAILY_OS_API_URL;
  const token = process.env.DAILY_OS_API_TOKEN;
  if (url && token) return { url, token };
  const fromFile = readUiRuntime();
  if (!fromFile) throw new Error('Daily OS service is not running (no URL/token available).');
  return fromFile;
}

export type ApiCall = (method: 'GET' | 'POST', apiPath: string, body?: unknown) => Promise<unknown>;

/** A loopback caller bound to one runtime. Throws with the server's own error */
/** text so the model sees why a write was rejected. */
export function apiCaller(runtime: UiRuntime, fetchImpl: typeof fetch = fetch): ApiCall {
  const base = runtime.url.replace(/\/+$/, '');
  return async (method, apiPath, body) => {
    const response = await fetchImpl(`${base}${apiPath}`, {
      method,
      headers: {
        authorization: `Bearer ${runtime.token}`,
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
      },
      ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
    });
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      /* leave as text */
    }
    if (!response.ok) {
      const detail = isRecord(parsed) && typeof parsed.error === 'string' ? parsed.error : text.slice(0, 500);
      throw new Error(`${apiPath} failed (${response.status}): ${detail}`);
    }
    return parsed;
  };
}

const CYCLE_SECTIONS = ['要务', 'retro', 'review'] as const;
const OKR_LEVELS = ['north-star', 'annual', 'current'] as const;
const TODO_TYPES = ['todo', 'reminder', 'time_boundary', 'note'] as const;
const TODO_STATUSES = ['open', 'done', 'deferred', 'deleted'] as const;

export interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodRawShape;
  /** Turn validated args into a concrete request. */
  request: (args: Record<string, unknown>) => { method: 'GET' | 'POST'; path: string; body?: unknown };
}

/** The v1 tool set. Data so the launcher derives the allow-list and tests can */
/** exercise the arg→request mapping without a live model. */
export const TOOLS: ToolDef[] = [
  {
    name: 'get_state',
    description: '读取 Daily OS 当前完整状态（作息、待办、周期、OKR、服务状态等）。改之前先用它看现状。',
    schema: {},
    request: () => ({ method: 'GET', path: '/api/state' }),
  },
  {
    name: 'get_today_plan',
    description: '读取今天的计划（通告单）。',
    schema: {},
    request: () => ({ method: 'GET', path: '/api/today/plan' }),
  },
  {
    name: 'capture_todo',
    description: '记一条待办到 Todo Inbox（等同「随手记」）。',
    schema: {
      text: z.string().min(1).describe('待办内容，原文照记'),
      type: z.enum(TODO_TYPES).optional().describe('类型，默认 todo'),
    },
    request: (a) => ({ method: 'POST', path: '/api/capture', body: a }),
  },
  {
    name: 'update_todo_inbox',
    description: '按 id 更新一条已有待办：改状态（完成/搁置/删除/恢复 open）、改文字、改类型或备注。先用 get_state 找到 id。',
    schema: {
      id: z.string().min(1).describe('待办 id'),
      status: z.enum(TODO_STATUSES).optional(),
      text: z.string().optional(),
      type: z.enum(TODO_TYPES).optional(),
      note: z.string().optional(),
    },
    request: (a) => ({ method: 'POST', path: '/api/todo-inbox', body: a }),
  },
  {
    name: 'save_okr',
    description: '整文件写入某一层 OKR 的 Markdown（覆盖写）。先 get_state 看现有内容，改完整份再传回。',
    schema: {
      level: z.enum(OKR_LEVELS).describe('north-star=5年 / annual=年度 / current=本季'),
      markdown: z.string().describe('该层 OKR 文件的完整 Markdown'),
    },
    request: (a) => ({ method: 'POST', path: '/api/okr', body: a }),
  },
  {
    name: 'save_routines',
    description:
      '写入作息的时间块（periods 整个数组，覆盖写）。先用 get_state 读到当前 routines 的 periods，改完把完整 periods 传回；保留每个块的 id，同一 mode 里按 start 排序。dayModes / dayOverrides 不受影响。',
    schema: {
      periods: z.array(z.any()).describe('完整的 routines.periods 数组'),
    },
    request: (a) => ({ method: 'POST', path: '/api/routines', body: a }),
  },
  {
    // 2026-10-26: the chat had no way to put an event on one day — save_routines
    // leaves dayOverrides alone — so 「下周一 AG1 feedback session」 went into the
    // file by hand, on the wrong day, in a shape nothing read.
    name: 'set_day_event',
    description:
      '给某一天加（或改）一个固定日程，比如会议、retreat、活动：只改这一天，作息模板不动；那段时间里原来的作息块会让开，排计划时也会绕开它。date 必须先在 <now>.calendar 里查到（不要自己推算星期）。同一个 id 再调一次就是改时间；回复里把日期和星期一起告诉用户。',
    schema: {
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('那一天，YYYY-MM-DD，从 <now>.calendar 查'),
      start: z.string().regex(/^\d{2}:\d{2}$/).describe('开始 HH:mm'),
      end: z.string().regex(/^\d{2}:\d{2}$/).describe('结束 HH:mm，晚于开始'),
      title: z.string().min(1).describe('显示在时间轴上的名字'),
      id: z.string().regex(/^[a-z0-9-]+$/).optional().describe('小写字母数字和 -；改已有的那条时传它的 id，新加的可不传'),
    },
    request: (a) => ({
      method: 'POST',
      path: '/api/routines/day-override',
      body: {
        date: a.date,
        change: { type: 'edit', block: { id: (a.id as string | undefined) || eventId(String(a.title), String(a.start)), start: a.start, end: a.end, title: a.title, kind: 'fixed' } },
      },
    }),
  },
  {
    name: 'remove_day_event',
    description: '删掉 set_day_event 给某一天加的日程（按 id），或把那天改过的作息块恢复成模板。',
    schema: {
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('那一天，YYYY-MM-DD'),
      id: z.string().min(1).describe('日程或作息块的 id'),
    },
    request: (a) => ({ method: 'POST', path: '/api/routines/day-override', body: { date: a.date, change: { type: 'reset', blockId: a.id } } }),
  },
  {
    name: 'cycle_section',
    description: '写入某个周期文件的一个段落：要务 / retro / review（覆盖写该段）。id 是周期 id（形如 2026-09-21_...），用 get_state 找。',
    schema: {
      id: z.string().min(1).describe('周期 id'),
      section: z.enum(CYCLE_SECTIONS).describe('要务 / retro / review'),
      content: z.string().describe('该段落的完整新内容'),
    },
    request: (a) => ({ method: 'POST', path: '/api/cycles/section', body: a }),
  },
];

/** `mcp__daily-os__<tool>` names, for the CLI `--tools` allow-list. */
export const TOOL_ALLOW_NAMES: string[] = TOOLS.map((tool) => `mcp__${MCP_SERVER_NAME}__${tool.name}`);

/** A stable id for an event added without one: `evt-` + a short hash of what it is and when. */
function eventId(title: string, start: string): string {
  let hash = 0;
  for (const char of `${title}@${start}`) hash = (Math.imul(hash, 31) + char.codePointAt(0)!) >>> 0;
  return `evt-${hash.toString(36)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
