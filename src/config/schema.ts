import { z } from 'zod';

const enabled = z.object({ enabled: z.boolean().default(false) });

const skillProvider = z.enum(['auto', 'codex', 'claude']);
const skillEffect = z.enum(['read', 'draft', 'feishu_write', 'workspace_write']);

const strategyAlignment = z
  .object({
    enabled: z.boolean().default(true),
    primary_source_hint: z.string().default('Primary weekly planning source'),
    primary_labels: z.array(z.string()).default(['weekly priorities', '每周要务']),
    primary_markers: z.array(z.string()).default([]),
    reference_labels: z.array(z.string()).default([]),
    reference_markers: z.array(z.string()).default([]),
    alignment_heading: z.string().default('策略对齐'),
    reference_sources: z.array(z.string()).default(['linear', 'vault', 'feishu', 'calendar', 'github']),
  })
  .default({
    enabled: true,
    primary_source_hint: 'Primary weekly planning source',
    primary_labels: ['weekly priorities', '每周要务'],
    primary_markers: [],
    reference_labels: [],
    reference_markers: [],
    alignment_heading: '策略对齐',
    reference_sources: ['linear', 'vault', 'feishu', 'calendar', 'github'],
  });

// "HH:mm" 24h. The macOS Today timeline decodes these to lay items out across the
// real work day, so the shape is a contract, not free text.
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const DEFAULT_WORKING_HOURS = { start: '09:30', end: '18:30' };
const DEFAULT_MEAL_BLOCKS = [{ label: '午餐', start: '12:00', end: '13:00' }];

// A bad "HH:mm" falls back to the default field rather than throwing the whole
// config load — same tolerance `normalizeRestDays` gives a stray weekday code.
const workingHours = z
  .object({
    start: z.string().regex(HHMM).catch(DEFAULT_WORKING_HOURS.start),
    end: z.string().regex(HHMM).catch(DEFAULT_WORKING_HOURS.end),
  })
  .catch({ ...DEFAULT_WORKING_HOURS })
  .default({ ...DEFAULT_WORKING_HOURS });

const mealBlock = z.object({
  label: z.string(),
  start: z.string().regex(HHMM),
  end: z.string().regex(HHMM),
});

// An entry with a malformed time is dropped, not thrown — one typo in one meal
// block must not take the morning plan down. `safeParse` per entry is what makes
// "drop, don't throw" per-item rather than all-or-nothing.
const mealBlocks = z
  .array(z.unknown())
  .transform((entries) =>
    entries.flatMap((entry) => {
      const parsed = mealBlock.safeParse(entry);
      return parsed.success ? [parsed.data] : [];
    }),
  )
  .catch(DEFAULT_MEAL_BLOCKS.map((block) => ({ ...block })))
  .default(DEFAULT_MEAL_BLOCKS.map((block) => ({ ...block })));

/**
 * The user's weekly rhythm. See `src/user/rhythm.ts` for why this is split into a
 * structured half (here) and a prose half (`rhythm.md` in the memory vault).
 *
 * Defaults to enabled with the conventional Sat/Sun weekend: before this existed
 * every day was planned as a work day, so shipping it off would leave the
 * complaint that motivated it unfixed for everyone who never opens Settings. A
 * user who works weekends sets `rest_days: []` or flips `enabled: false`.
 */
const userRhythm = z
  .object({
    enabled: z.boolean().default(true),
    /** Rhythm notes file, relative to the memory repository. */
    file: z.string().default('rhythm.md'),
    /** Three-letter weekday codes, e.g. `['SAT', 'SUN']`. Unknown entries are ignored. */
    rest_days: z.array(z.string()).default(['SAT', 'SUN']),
    /**
     * How many work-sourced tasks may still appear on a rest day. 1, not 0:
     * an overdue delivery on a Saturday is exactly the thing a user does want to
     * be told about, and a hard zero would hide it.
     */
    work_task_cap_on_rest_days: z.number().int().min(0).max(20).default(1),
    /** The work day the timeline lays items out across. "HH:mm" 24h. */
    working_hours: workingHours,
    /** Blocks to keep tasks out of (meals). Invalid entries are dropped. */
    meal_blocks: mealBlocks,
  })
  .default({
    enabled: true,
    file: 'rhythm.md',
    rest_days: ['SAT', 'SUN'],
    work_task_cap_on_rest_days: 1,
    working_hours: { ...DEFAULT_WORKING_HOURS },
    meal_blocks: DEFAULT_MEAL_BLOCKS.map((block) => ({ ...block })),
  });

const feishuProfile = enabled.extend({
  id: z.string().default('default'),
  label: z.string().default('Default'),
  identity: z.enum(['bot', 'user']).default('user'),
  calendar: enabled.extend({ days: z.number().int().positive().default(1) }),
  tasks: enabled.extend({
    include_completed: z.boolean().default(false),
    page_limit: z.number().int().positive().default(5),
  }),
  docs: enabled.extend({
    documents: z.array(z.object({ name: z.string(), token: z.string() })).default([]),
  }),
  im_history: enabled.extend({
    chat_id_env: z.string().default('FEISHU_CHAT_ID'),
    limit: z.number().int().positive().default(80),
  }),
});

export const AppConfigSchema = z.object({
  assistant: z.object({
    name: z.string().default('daily-os-feishu'),
    language: z.string().default('zh-CN'),
    tone: z.string().default('calm, direct, practical'),
  }),
  user: z.object({
    display_name: z.string().default('User'),
    timezone: z.string().default('UTC'),
    rhythm: userRhythm,
  }),
  llm: z.object({
    provider: z.enum(['codex', 'openai', 'claude', 'anthropic']).default('codex'),
    model: z.string().default('default'),
    // Upper bound on a single agent *attempt* (not the whole run). Fail fast:
    // a `claude` CLI under launchd is bimodal — it answers within a minute or two
    // or hangs forever (#199) — so a short cap plus a retry (see max_attempts)
    // catches a hang early and re-rolls, instead of burning ten minutes before
    // failing. Set 0 to disable the cap. A hit throws a message naming the
    // provider/model/prompt size; `runAgent` retries it up to max_attempts.
    timeout_ms: z.number().int().nonnegative().default(180000),
    // How many attempts before giving up. 2 = one retry. The retry only fires on
    // a per-attempt timeout (a hang), not on real errors. Set 1 to disable.
    max_attempts: z.number().int().min(1).max(5).default(2),
  }),
  billing: z
    .object({
      per_task_usd: z.number().nonnegative().default(2),
      daily_usd: z.number().nonnegative().default(10),
      monthly_usd: z.number().nonnegative().default(100),
      price_overrides: z
        .record(z.object({ input: z.number().nonnegative(), output: z.number().nonnegative() }))
        .optional(),
    })
    .default({ per_task_usd: 2, daily_usd: 10, monthly_usd: 100 }),
  workflows: z.object({
    daily_plan: z.object({ enabled: z.boolean().default(true), time: z.string().default('08:00') }),
    daily_review: z.object({
      enabled: z.boolean().default(true),
      time: z.string().default('21:30'),
      skip_on_weekly_review_day: z.boolean().default(true),
    }),
    weekly_review: z.object({
      enabled: z.boolean().default(true),
      weekday: z.string().default('SUN'),
      time: z.string().default('20:00'),
    }),
  }),
  planning: z
    .object({
      strategy_alignment: strategyAlignment,
    })
    .default({
      strategy_alignment: {
        enabled: true,
        primary_source_hint: 'Primary weekly planning source',
        primary_labels: ['weekly priorities', '每周要务'],
        primary_markers: [],
        reference_labels: [],
        reference_markers: [],
        alignment_heading: '策略对齐',
        reference_sources: ['linear', 'vault', 'feishu', 'calendar', 'github'],
      },
    }),
  calendar: z
    .object({
      enabled: z.boolean().default(false),
      engine: z
        .object({
          mode: z.enum(['auto', 'external', 'builtin']).default('auto'),
          command: z.string().default('node'),
          cli_path: z.string().default('bin/calendar-planning-os.mjs'),
          workdir: z.string().default('../calendar-planning-os'),
          policy_file: z.string().default(''),
          routines_file: z.string().default(''),
          timeout_ms: z.number().int().positive().default(120000),
          input_path: z.string().default('./data/runtime/calendar-draft-input.json'),
        })
        .default({
          mode: 'auto',
          command: 'node',
          cli_path: 'bin/calendar-planning-os.mjs',
          workdir: '../calendar-planning-os',
          policy_file: '',
          routines_file: '',
          timeout_ms: 120000,
          input_path: './data/runtime/calendar-draft-input.json',
        }),
      draft: z
        .object({
          week_days: z.number().int().positive().max(14).default(5),
          max_tasks: z.number().int().positive().max(20).default(8),
        })
        .default({
          week_days: 5,
          max_tasks: 8,
        }),
      writeback: z
        .object({
          enabled: z.boolean().default(false),
          identity: z.enum(['user', 'bot']).default('user'),
          calendar_id: z.string().default('primary'),
          conflict_policy: z.enum(['warn', 'block', 'ignore']).default('warn'),
          dry_run: z.boolean().default(false),
        })
        .default({
          enabled: false,
          identity: 'user',
          calendar_id: 'primary',
          conflict_policy: 'warn',
          dry_run: false,
        }),
    })
    .default({
      enabled: false,
      engine: {
        mode: 'auto',
        command: 'node',
        cli_path: 'bin/calendar-planning-os.mjs',
        workdir: '../calendar-planning-os',
        policy_file: '',
        routines_file: '',
        timeout_ms: 120000,
        input_path: './data/runtime/calendar-draft-input.json',
      },
      draft: {
        week_days: 5,
        max_tasks: 8,
      },
      writeback: {
        enabled: false,
        identity: 'user',
        calendar_id: 'primary',
        conflict_policy: 'warn',
        dry_run: false,
      },
    }),
  service: z
    .object({
      prevent_sleep: enabled.default({ enabled: false }),
    })
    .default({
      prevent_sleep: { enabled: false },
    }),
  scheduler: z
    .object({
      // auto: pick launchd on a macOS host outside a container, otherwise the
      // in-process loop. Env var DAILY_OS_SCHEDULER overrides this field.
      driver: z.enum(['auto', 'launchd', 'loop']).default('auto'),
    })
    .default({
      driver: 'auto',
    }),
  output: z.object({
    feishu: z.object({
      enabled: z.boolean().default(true),
      provider: z.enum(['auto', 'sdk', 'lark_cli']).default('auto'),
      identity: z.enum(['bot', 'user']).default('bot'),
      chat_id_env: z.string().default('FEISHU_CHAT_ID'),
      send_mode: z.enum(['markdown', 'text']).default('markdown'),
      summary_style: z.enum(['style1', 'style2']).default('style1'),
    }),
  }),
  feedback: z
    .object({
      feishu: enabled.extend({
        chat_id_env: z.string().default('FEISHU_CHAT_ID'),
        identity: z.enum(['bot', 'user']).default('bot'),
        command_prefix: z.string().default('daily-os'),
        poll_limit: z.number().int().positive().max(100).default(20),
        state_path: z.string().default('./data/memory/feishu-feedback-state.json'),
        log_path: z.string().default('./data/memory/feishu-feedback.md'),
      }),
    })
    .default({
      feishu: {
        enabled: false,
        chat_id_env: 'FEISHU_CHAT_ID',
        identity: 'bot',
        command_prefix: 'daily-os',
        poll_limit: 20,
        state_path: './data/memory/feishu-feedback-state.json',
        log_path: './data/memory/feishu-feedback.md',
      },
    }),
  interaction: z
    .object({
      feishu: enabled.extend({
        command_prefix: z.string().default('daily-os'),
        require_mention_in_groups: z.boolean().default(true),
        debounce_ms: z.number().int().nonnegative().default(600),
        reply_mode: z.enum(['markdown', 'text']).default('markdown'),
        session_catalog_path: z.string().default('./data/memory/feishu-session-catalog.json'),
        agent_mode: z
          .object({
            enabled: z.boolean().default(false),
            workdir: z.string().default(''),
            sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).default('read-only'),
            include_memory: z.boolean().default(true),
            include_evidence: z.boolean().default(false),
            context_pack: z
              .object({
                enabled: z.boolean().default(true),
                include_latest_workflow: z.boolean().default(true),
                include_progress_ledger: z.boolean().default(true),
                include_decision_policy: z.boolean().default(true),
                include_evidence_summary: z.boolean().default(true),
                max_sources: z.number().int().positive().max(30).default(12),
                max_items_per_source: z.number().int().positive().max(20).default(4),
                max_chars_per_item: z.number().int().positive().max(4000).default(900),
              })
              .default({
                enabled: true,
                include_latest_workflow: true,
                include_progress_ledger: true,
                include_decision_policy: true,
                include_evidence_summary: true,
                max_sources: 12,
                max_items_per_source: 4,
                max_chars_per_item: 900,
              }),
            timeout_ms: z.number().int().positive().default(300000),
          })
          .default({
            enabled: false,
            workdir: '',
            sandbox: 'read-only',
            include_memory: true,
            include_evidence: false,
            context_pack: {
              enabled: true,
              include_latest_workflow: true,
              include_progress_ledger: true,
              include_decision_policy: true,
              include_evidence_summary: true,
              max_sources: 12,
              max_items_per_source: 4,
              max_chars_per_item: 900,
            },
            timeout_ms: 300000,
          }),
        security: z
          .object({
            owner_open_id_env: z.string().default('FEISHU_OWNER_OPEN_ID'),
            admin_open_ids: z.array(z.string()).default([]),
            allowed_user_open_ids: z.array(z.string()).default([]),
            allowed_chat_ids: z.array(z.string()).default([]),
            access_level: z.enum(['read_only', 'workspace', 'full']).default('read_only'),
            allowed_workspaces: z.array(z.string()).default([]),
          })
          .default({
            owner_open_id_env: 'FEISHU_OWNER_OPEN_ID',
            admin_open_ids: [],
            allowed_user_open_ids: [],
            allowed_chat_ids: [],
            access_level: 'read_only',
            allowed_workspaces: [],
          }),
        // Self-origin echo guard (LEO-202 / H3): identify the bot's own open_id so
        // inbound events from the bot itself are skipped instead of re-processed.
        // These are optional overrides — the bot identity is otherwise resolved
        // from the Feishu SDK (`/open-apis/bot/v3/info`) at startup.
        self: z
          .object({
            bot_open_id_env: z.string().default('FEISHU_BOT_OPEN_ID'),
            bot_open_ids: z.array(z.string()).default([]),
          })
          .default({
            bot_open_id_env: 'FEISHU_BOT_OPEN_ID',
            bot_open_ids: [],
          }),
      }),
    })
    .default({
      feishu: {
        enabled: false,
        command_prefix: 'daily-os',
        require_mention_in_groups: true,
        debounce_ms: 600,
        reply_mode: 'markdown',
        session_catalog_path: './data/memory/feishu-session-catalog.json',
        agent_mode: {
          enabled: false,
          workdir: '',
          sandbox: 'read-only',
          include_memory: true,
          include_evidence: false,
          context_pack: {
            enabled: true,
            include_latest_workflow: true,
            include_progress_ledger: true,
            include_decision_policy: true,
            include_evidence_summary: true,
            max_sources: 12,
            max_items_per_source: 4,
            max_chars_per_item: 900,
          },
          timeout_ms: 300000,
        },
        security: {
          owner_open_id_env: 'FEISHU_OWNER_OPEN_ID',
          admin_open_ids: [],
          allowed_user_open_ids: [],
          allowed_chat_ids: [],
          access_level: 'read_only',
          allowed_workspaces: [],
        },
        self: {
          bot_open_id_env: 'FEISHU_BOT_OPEN_ID',
          bot_open_ids: [],
        },
      },
    }),
  decision: z
    .object({
      enabled: z.boolean().default(true),
      policy_file: z.string().default('decision-policy.yaml'),
      policy_notes_file: z.string().default('decision-policy.md'),
      candidates_path: z.string().default('./data/memory/decision-policy-candidates.md'),
      onboarding: z
        .object({
          enabled: z.boolean().default(true),
          chat_name: z.string().default('Daily OS - 决策校准'),
          chat_id_env: z.string().default('DAILY_OS_DECISION_CHAT_ID'),
          owner_open_id_env: z.string().default('FEISHU_OWNER_OPEN_ID'),
          state_path: z.string().default('./data/memory/decision-onboarding.json'),
          auto_create_on_setup: z.boolean().default(false),
        })
        .default({
          enabled: true,
          chat_name: 'Daily OS - 决策校准',
          chat_id_env: 'DAILY_OS_DECISION_CHAT_ID',
          owner_open_id_env: 'FEISHU_OWNER_OPEN_ID',
          state_path: './data/memory/decision-onboarding.json',
          auto_create_on_setup: false,
        }),
    })
    .default({
      enabled: true,
      policy_file: 'decision-policy.yaml',
      policy_notes_file: 'decision-policy.md',
      candidates_path: './data/memory/decision-policy-candidates.md',
      onboarding: {
        enabled: true,
        chat_name: 'Daily OS - 决策校准',
        chat_id_env: 'DAILY_OS_DECISION_CHAT_ID',
        owner_open_id_env: 'FEISHU_OWNER_OPEN_ID',
        state_path: './data/memory/decision-onboarding.json',
        auto_create_on_setup: false,
      },
    }),
  progress: z
    .object({
      enabled: z.boolean().default(true),
      ledger_dir: z.string().default('./data/memory/progress'),
      no_progress_reminder_time: z.string().default('16:30'),
      max_candidates: z.number().int().positive().default(12),
    })
    .default({
      enabled: true,
      ledger_dir: './data/memory/progress',
      no_progress_reminder_time: '16:30',
      max_candidates: 12,
    }),
  // LEO-120: optional daily-review check for "progress made today but not yet
  // synced to GitHub/Linear". Off by default (conservative); when off the daily
  // review produces zero trace. Reuses the existing sources.github/sources.linear
  // configuration — this flag never introduces a new source config flow and never
  // writes to GitHub or Linear.
  progress_sync_check: z
    .object({
      enabled: z.boolean().default(false),
    })
    .default({ enabled: false }),
  todo_inbox: z
    .object({
      enabled: z.boolean().default(true),
      ledger_path: z.string().default('./data/memory/todo-inbox.jsonl'),
      vault_path: z.string().default(''),
      vault_relative_path: z.string().default('99_Meta/daily-os-todo.md'),
    })
    .default({
      enabled: true,
      ledger_path: './data/memory/todo-inbox.jsonl',
      vault_path: '',
      vault_relative_path: '99_Meta/daily-os-todo.md',
    }),
  chat_analysis: z
    .object({
      enabled: z.boolean().default(true),
      default_mode: z.enum(['manual', 'todo', 'review']).default('manual'),
      max_messages: z.number().int().positive().default(80),
      max_suggestions: z.number().int().positive().default(8),
      lookback_messages: z.number().int().positive().optional(),
    })
    .default({
      enabled: true,
      default_mode: 'manual',
      max_messages: 80,
      max_suggestions: 8,
    }),
  background_suggestions: z
    .object({
      enabled: z.boolean().default(false),
      mode: z.enum(['manual', 'todo', 'review']).default('review'),
      interval_minutes: z.number().int().positive().default(120),
      min_confidence: z.enum(['low', 'medium', 'high']).default('medium'),
      send_to_feishu: z.boolean().default(true),
      send_on_change_only: z.boolean().default(true),
      state_path: z.string().default('./data/memory/background-suggestions-state.json'),
      pending_path: z.string().default('./data/memory/background-suggestions-pending.json'),
      pending_ttl_hours: z.number().int().positive().default(24),
    })
    .default({
      enabled: false,
      mode: 'review',
      interval_minutes: 120,
      min_confidence: 'medium',
      send_to_feishu: true,
      send_on_change_only: true,
      state_path: './data/memory/background-suggestions-state.json',
      pending_path: './data/memory/background-suggestions-pending.json',
      pending_ttl_hours: 24,
    }),
  sources: z.object({
    vault: enabled.extend({
      provider: z.enum(['remote', 'local']).default('remote'),
      local_path: z.string().default('/path/to/Private-Vault'),
      remote: z.object({
        base_url_env: z.string().default('VAULT_GATE_URL'),
        token_env: z.string().default('VAULT_GATE_TOKEN'),
        scan: z.object({
          enabled: z.boolean().default(true),
          statuses: z.array(z.string()).default(['active', 'watching', 'considering']),
          due_within_days: z.number().int().nonnegative().default(7),
          limit: z.number().int().positive().default(12),
        }),
        read_paths: z.object({
          okr: z.string().default('10_OKR/current-okr.md'),
          todos: z.string().default('99_Meta/todos.md'),
          routing: z.string().default('99_Meta/routing.md'),
          watch_list: z.string().default('99_Meta/watch-list.md'),
        }),
      }),
    }),
    chrome_snapshot: enabled.extend({
      tabs_path: z.string().default('./data/snapshots/chrome/current-tabs.txt'),
      status_path: z.string().default('./data/snapshots/chrome/status.json'),
      tabs_json_path: z.string().default('./data/snapshots/chrome/tabs.json'),
      capture: z
        .object({
          enabled: z.boolean().default(true),
          method: z.enum(['osascript']).default('osascript'),
          refresh_on_collect: z.boolean().default(true),
          background_interval_minutes: z.number().int().positive().default(15),
          timeout_ms: z.number().int().positive().default(5000),
          max_tabs: z.number().int().positive().default(80),
          include_url_query: z.boolean().default(false),
          allowlist: z.array(z.string()).default([]),
          blocklist: z.array(z.string()).default([]),
        })
        .default({
          enabled: true,
          method: 'osascript',
          refresh_on_collect: true,
          background_interval_minutes: 15,
          timeout_ms: 5000,
          max_tabs: 80,
          include_url_query: false,
          allowlist: [],
          blocklist: [],
        }),
    }),
    apple_calendar_snapshot: enabled.extend({
      path: z.string().default('./data/snapshots/calendar/apple-today.json'),
    }),
    feishu: enabled.extend({
      profiles: z.array(feishuProfile).default([]),
      calendar: enabled.extend({ days: z.number().int().positive().default(1) }),
      tasks: enabled.extend({
        include_completed: z.boolean().default(false),
        page_limit: z.number().int().positive().default(5),
      }),
      docs: enabled.extend({
        documents: z.array(z.object({ name: z.string(), token: z.string() })).default([]),
      }),
      im_history: enabled.extend({
        chat_id_env: z.string().default('FEISHU_CHAT_ID'),
        limit: z.number().int().positive().default(80),
      }),
    }),
    github: enabled.extend({
      repositories: z.array(z.string()).default([]),
      per_repo_limit: z.number().int().positive().max(100).default(20),
    }),
    linear: enabled.extend({
      // Workspace slug for building https://linear.app/<workspace>/issue/<id>
      // links in the console; empty disables linkification.
      workspace: z.string().default(''),
      // Whose issues to collect: 'me' (API-key owner), an email, a display
      // name, or '' to take the whole team/project (previous behavior when an
      // allowlist was set). Applied to every filter, allowlisted or not.
      assignee: z.string().default('me'),
      // Only issues in the currently active cycle (sprint) when true.
      active_cycle_only: z.boolean().default(false),
      query: z.string().default("assignee = me and state.type != 'completed'"),
      projects_allowlist: z.array(z.string()).default([]),
      projects_blocklist: z.array(z.string()).default([]),
      teams_allowlist: z.array(z.string()).default([]),
      teams_blocklist: z.array(z.string()).default([]),
    }),
    local_files: enabled.extend({
      files: z.array(z.object({ name: z.string(), path: z.string() })).default([]),
    }),
  }),
  // LEO-282/283: the Supabase project two laptops share so they can read each
  // other's cycles. Both fields empty means "no team", and every team feature
  // stays dark — local markdown is the source of truth either way.
  // The anon key belongs here; service_role must never appear (it bypasses RLS,
  // see supabase/README.md).
  team: z
    .object({
      supabase_url: z.string().default(''),
      supabase_anon_key: z.string().default(''),
    })
    .default({ supabase_url: '', supabase_anon_key: '' }),
  memory: z.object({
    repository_path: z.string().default(''),
    long_term_path: z.string().default('./data/memory/long-term.md'),
    daily_dir: z.string().default('./data/memory/daily'),
    workflow_runs_dir: z.string().default('./data/memory/workflow-runs'),
  }),
  skills: z
    .object({
      enabled: z.boolean().default(false),
      inputs_dir: z.string().default('./data/memory/skill-inputs'),
      // Whether the weekly-review skill may write back into the Feishu weekly
      // report table (要务 columns + retro review). Default off: the cycle is
      // written to local 20_CYCLES markdown regardless (LEO-278), and the Feishu
      // table is a shared document a local-first setup should not touch unless
      // explicitly asked. Set true to restore the Feishu write-back.
      feishu_writeback: z.boolean().default(false),
      registry: z
        .array(
          z.object({
            id: z.string().min(1),
            provider: skillProvider.default('auto'),
            path: z.string().min(1),
            workdir: z.string().optional().default(''),
            default_mode: z.string().optional().default(''),
            effects: z.array(skillEffect).default(['read', 'draft']),
            require_confirmation_for: z.array(skillEffect).default(['feishu_write', 'workspace_write']),
          }),
        )
        .default([]),
    })
    .default({
      enabled: false,
      inputs_dir: './data/memory/skill-inputs',
      feishu_writeback: false,
      registry: [],
    }),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

export type WorkflowName = 'daily_plan' | 'daily_review' | 'weekly_review';
