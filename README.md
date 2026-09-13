# Daily OS Feishu

<p align="center">
  <img src="docs/assets/daily-os-feishu-logo-banner.png" alt="Daily OS Feishu" width="700">
</p>

Daily OS Feishu is a Mac-first, Feishu-only personal workflow agent. It collects configurable local and remote signals, asks your local Codex CLI or OpenAI API to prepare a daily/weekly message, and sends the result to Feishu through the official Feishu SDK or the legacy `lark-cli` path.

This repository is intentionally generic. It does not include personal tokens, private vault content, browser data, personal memory, or Feishu identifiers. It ships only a generic memory vault template. All private values live in `.env`, `config/config.yaml`, and ignored `data/` files.

## Start here

- **[Architecture](docs/architecture.md)** — the system, why the service runs on
  your own machine, and the five components with an honest note on where this is
  weak.
- **[Five-minute demo](docs/demo-script.md)** — a walkthrough script.
- **[Where your data lives](docs/data-storage.md)** — the SQLite tables and files,
  why the account is a login door (not a data partition), and what to back up.
- **[ADR 0001](docs/adr/0001-ssr-console-scope-and-ui-freeze.md)** — why the
  server-rendered console is frozen for UI polish.

Native clients live in their own repositories:
[macOS](https://github.com/alexli-77/daily-os-macos) ·
[iOS](https://github.com/alexli-77/daily-os-ios).

## First Version Scope

- Runs on macOS as a CLI or a `launchd` background service.
- Includes a local browser UI for setup, source toggles, checks, and manual triggers.
- Sends workflow output to Feishu through the official Feishu SDK when `LARK_APP_ID` and `LARK_APP_SECRET` are configured, with `lark-cli` as a compatibility fallback.
- Optional Feishu websocket interaction layer for direct chat commands and action cards.
- Uses local Codex CLI by default, with OpenAI API as an optional fallback.
- Supports configurable sources:
  - Vault knowledge base through local files. Remote vault-gate can be enabled later.
  - Chrome snapshots from exported local files.
  - Apple Calendar snapshots from exported local JSON.
  - Feishu calendar, tasks, docs, and IM history through `lark-cli`.
  - GitHub assigned issues through `GITHUB_TOKEN`.
  - Linear assigned work through `LINEAR_API_KEY`, or Codex Linear fallback when the key is empty.

## Requirements

- macOS
- Node.js 22+
- Codex CLI signed in locally, or `OPENAI_API_KEY`
- `LARK_APP_ID` and `LARK_APP_SECRET` when using SDK output or the Feishu interaction layer
- `lark-cli` installed and authenticated when collecting Feishu calendar/tasks/docs/IM history or using lark-cli output fallback
- A Feishu chat ID configured in `.env` when sending output, polling feedback, or collecting IM history

## Quick Start

```bash
npm ci
npm run alpha:smoke:ci
npm run setup
npm run ui
```

For project management and PR/release conventions, see
[`docs/task-workflow.md`](docs/task-workflow.md).

Edit:

- `.env`
- `config/config.yaml`

You can also edit the common fields in the local UI. It writes only to ignored
local files.

After configuration, the all-in-one foreground entry is:

```bash
npm run start
```

This opens the local UI, starts the scheduler for plan/review/weekly, and starts
the Feishu websocket interaction layer when `interaction.feishu.enabled` is
true. Keep the terminal window running. If the Mac sleeps, the local process and
Feishu websocket pause too; after wake, the scheduler catches up missed runs on
the same local day. A missed daily plan can still run until the daily review
time; failed runs are retried later instead of being marked as completed.

Source, workflow, security, agent mode, and prompt-related settings saved in the
UI are reloaded on the next scheduler tick or the next Feishu message/card
callback. In practice, newly saved sources affect the next plan, review, progress
confirmation, background suggestion run, and Feishu command without restarting.
Startup-level switches still require a restart, such as turning the Feishu
interaction websocket on after it was disabled, toggling the prevent-sleep
service, or changing service lifecycle settings.

Then check the installation:

```bash
npm run doctor
npm run collect
```

Run workflows manually. Use `--no-send` for the first generated result:

```bash
npm run plan -- --no-send
npm run chat
npm run progress
npm run review
npm run weekly
npm run feedback:poll
```

## Feishu Chat Context Suggestions

Daily OS can inspect recent Feishu IM history and suggest updates to todo,
calendar, documents, Linear, memory, or the daily plan. This is intentionally a
suggestion layer: it does not write to external systems automatically.

Use:

```bash
npm run chat
npm run chat -- todo
npm run chat -- review
```

In Feishu interaction mode, send:

```text
daily-os chat
daily-os chat todo
daily-os chat review
```

The result highlights new tasks, reschedules, completion signals, blockers,
owner changes, calendar/document update hints, and possible conflicts with
existing evidence.

The scan window is mode-based:

- `manual`: latest configured IM history messages.
- `todo`: yesterday 00:00 through today's `daily_plan.time`.
- `review`: today's `daily_plan.time` through now, capped by `daily_review.time`.

Configure `chat_analysis.default_mode`, `chat_analysis.max_messages`, and
`chat_analysis.max_suggestions`. The Feishu source profile `im_history.limit`
should be at least as large as `chat_analysis.max_messages`.

### Automatic Background Suggestions

Enable `background_suggestions.enabled=true` to let the scheduler periodically
run chat context analysis without opening the UI. It can send a compact Feishu
summary when new suggestions are found, or only update local run status.

When `interaction.feishu.agent_mode.enabled=true`, users can reply to the
background suggestion message in natural language, such as "write item 2 into
today's progress", "ignore the third one", or "move that to tomorrow morning".
Daily OS passes the recent pending suggestions into the Feishu agent context so
the agent can resolve references like "item 2" without requiring a fixed command.

The UI Service panel shows the last run time, next run time, recent error,
inspected message count, and suggestion count. The state file stores only run
metadata, counts, errors, and a hashed suggestion signature; it does not store
suggestion bodies, evidence, source messages, response bodies, or secrets.
Pending suggestions are stored separately for a short TTL so natural-language
follow-ups can refer to them; that file contains the generated suggestion
summary fields, not raw evidence.

Workflow outputs sent to Feishu are compact by default. Daily OS stores the full
latest plan/review/weekly output locally; send `daily-os details` to expand the
latest full message on demand.

## Daily Progress Capture

Daily OS can collect confirmable progress candidates before the evening review.
It does not treat inferred evidence as fact until the user confirms it.

Use:

```bash
npm run progress
npm run progress:confirm
```

In Feishu interaction mode, send:

```text
daily-os progress
```

Daily OS replies with a confirmation card. **Confirm all** writes the selected
candidates to `progress.ledger_dir` as a date-based progress ledger. Review and
weekly workflows receive that ledger as the `progress_ledger` evidence source.
If the scheduler reaches `progress.no_progress_reminder_time` and sees no
candidate progress, it sends a lightweight reminder instead of waiting until the
nightly review.

Install the full macOS background service:

```bash
npm run build
npm run service:install
```

The background service runs the compiled output in `dist/`. After changing any
source code, run `npm run build` again so the production path picks up the new
code; `npm run dev`/`start` run from source via `tsx` and do not need a rebuild.

Remove it:

```bash
npm run service:uninstall
```

## Configuration Model

Copy `config/config.example.yaml` to `config/config.yaml`. The checked-in example shows every supported source and output option.

Secrets are read from `.env`; use `.env.example` as the template.

The local UI starts with:

```bash
npm run ui
```

It can save common config fields, save `.env` values, run `doctor`, send a
Feishu test message, trigger plan/review/weekly workflows, poll Feishu feedback,
and install or uninstall the local `launchd` service. Secret fields are stored
locally and are not echoed back in the UI.

For day-to-day use, prefer `npm run start`. Use `npm run ui` only when you want
the dashboard without starting the foreground scheduler or Feishu interaction
service.

When the background service is installed, the UI is available at the stable
local address `http://127.0.0.1:14573` by default. If that port is already in
use, Daily OS falls back to another local port and writes the actual URL to
`data/runtime/ui.json`. Run `npm run ui:open` to open the currently running UI
from that saved runtime URL.

The Setup tab includes Codex configuration:

- `Find Codex CLI`: searches the customer's local PATH and common install
  locations, then saves `CODEX_BIN`.
- `Choose CLI`: lets the user select the `codex` executable manually when PATH
  discovery fails.
- `Codex home`: optional. Use it when the customer keeps Codex credentials in a
  non-default directory instead of `~/.codex`.
- `Test Codex login`: runs `codex --version` and `codex login status` with the
  configured values.

If Codex is not authenticated, run `codex login` in Terminal for that same
binary/home, then rerun Checks. The app does not store Codex credentials; it only
points to the customer's local Codex installation.

In the Sources tab, Feishu starts with **Auto configure from lark-cli**. Use
that first. The app reads the local `lark-cli` app ID, user open_id, available
identities, and granted scopes, then saves only safe local values to `.env`.
Anything it cannot know reliably is reported as a remaining manual step.

Feishu values are now required only when the enabled feature needs them:

- `lark-cli` authentication: required for Feishu collection and lark-cli-based send/poll commands. Run `lark-cli config init` and `lark-cli auth login` if auto configure cannot find it.
- `FEISHU_CHAT_ID`: required only for Feishu output, feedback polling, or any profile with IM history enabled.
- Docs URLs/tokens: required only for profiles with Docs enabled. Add one per line in the profile as `Name | document URL or token`. Docs collection uses `lark-cli docs +fetch --api-version v2 --as user` by default, so it follows the locally authenticated user's document access. A chat ID is not used for document reads.
- `LARK_APP_ID` and `LARK_APP_SECRET`: required only for the optional Feishu websocket interaction layer. App ID is usually discovered from lark-cli; App Secret cannot be read back from lark-cli/keychain, so paste it only when enabling interaction.
- Profile `identity`: choose `user` for user-authorized calendar/tasks/docs/IM access, or `bot` when the bot is installed in the target chat and has the needed scopes.

Each Feishu profile has its own local display name, `identity`,
calendar/tasks/docs/IM switches, document list, and IM chat env name. Profiles
are collapsed by default to keep setup readable.

Feishu source profile fields are local Daily OS settings, not Feishu Developer
Platform credentials:

- `Display name`: local display name in the UI.
- `Access identity`: `user` or `bot`, matching the `lark-cli --as` identity used for this source.
- `Calendar`, `Tasks`, `Docs`, `IM history`: source switches. `Calendar` and `Tasks` use the selected `Access identity`; `IM history` also needs the Chat ID env value.
- Advanced local settings: `Local source key` controls evidence names, and `Chat ID env var` names the `.env` variable containing a Feishu `Chat ID`. Most users can keep both defaults.

### Feishu Account and Permission Model

Daily OS supports both personal Feishu workspaces and enterprise Feishu
tenants. The local configuration model is the same in both cases: Daily OS keeps
account secrets in `.env`, stores source settings in `config/config.yaml`, and
uses the identity you select on each Feishu source profile.

For a personal workspace, the simplest setup is usually:

- use `Auto configure from lark-cli` after `lark-cli auth login`;
- set profile `identity` to `user` for calendar, tasks, docs, and IM history;
- add `FEISHU_CHAT_ID` only when sending output, polling feedback, or collecting
  IM history from a specific chat;
- keep `LARK_APP_ID` and `LARK_APP_SECRET` empty unless SDK output or the
  websocket interaction layer is enabled.

For an enterprise tenant, an admin may need to approve app scopes before the
same setup works. The app can still use a user login through `lark-cli`, but the
tenant controls whether the user token can read calendar, tasks, docs, or
messages. If the bot identity is used, the bot must be installed in the target
chat and the Feishu app must have the matching bot or app scopes.

Use this matrix when deciding which permission path to configure:

| Capability | Recommended identity | Required local value | Feishu permission notes |
| --- | --- | --- | --- |
| Workflow output through SDK | `bot` | `LARK_APP_ID`, `LARK_APP_SECRET`, `FEISHU_CHAT_ID` | Bot must be able to send messages to the target chat. |
| Workflow output through lark-cli fallback | `user` or `bot` | `FEISHU_CHAT_ID`, authenticated `lark-cli` | Uses the locally logged-in `lark-cli` identity. |
| Calendar source | `user` | authenticated `lark-cli` | User token needs calendar read scope approved by the tenant. |
| Task source | `user` | authenticated `lark-cli` | User token needs task/tasklist read scope approved by the tenant. |
| Docs source | `user` | docs URLs/tokens in the profile | User must have document access; a chat ID is not used for document reads. |
| IM history source | `user` for personal/private use; `bot` only when the bot is installed and scoped | chat ID env value such as `FEISHU_CHAT_ID` | Tenant must approve message read scopes. Use narrow chat allowlists where possible. |
| Websocket interaction layer | `bot` receives events, user/admin allowlists gate actions | `LARK_APP_ID`, `LARK_APP_SECRET`, owner/admin open IDs | Configure user/chat allowlists before enabling remote commands. |
| Decision calibration group creation | `bot` | `LARK_APP_ID`, `LARK_APP_SECRET`, owner open ID | Feishu app needs `im:chat` and message-send permission. |

When a capability fails in an enterprise tenant, first check `lark-cli auth
status` and the UI **Run Checks** output. If the local login is present but a
source still fails, the missing piece is usually a tenant-approved scope or the
bot not being installed in the target chat. Daily OS treats those as local setup
issues; it does not broaden scopes automatically.

Recommended diagnostics:

```bash
lark-cli auth status
lark-cli config show
lark-cli im +chat-list --as user --types group,p2p --format json
```

Use `lark-cli auth status` to confirm which identities are available and which
scopes were granted. Use `lark-cli config show` to confirm the local App ID.
Use the chat-list command only when a feature needs a chat ID, then copy the
target `oc_xxx` value into the configured chat ID env var.

Doctor checks should distinguish these cases in user-facing copy:

- Missing `lark-cli`: "Install and log in to lark-cli, or disable Feishu source
  collection and lark-cli fallback."
- Missing user login: "Run `lark-cli auth login` for user-authorized calendar,
  tasks, docs, or IM history."
- Missing bot credentials: "Set `LARK_APP_ID` and `LARK_APP_SECRET` before using
  SDK output, websocket interaction, or decision chat creation."
- Missing chat ID: "Set `FEISHU_CHAT_ID` only for output, feedback polling, or
  IM history sources that read a specific chat."
- Missing tenant scope: "Ask the Feishu tenant admin to approve the required
  scope, then re-authenticate lark-cli."
- Bot not installed in chat: "Install the bot in the target chat or switch the
  profile identity to `user` when reading user-accessible sources."
- Cross-tenant access failure: "Use a Feishu app and lark-cli login from the
  same tenant as the target chat or document."

Multiple Feishu source profiles share the same `App ID` and `App Secret` in this
version. If you need different Feishu apps or tenants, run a separate local app
config for now.

To find a chat ID manually, use a known chat from Feishu or inspect chats with
`lark-cli im +chat-list --as user --types group,p2p --format json` outside the
UI, then copy the desired `oc_xxx` value into `.env`.

The Other sources section has separate local discovery buttons for GitHub and
Linear credentials: GitHub uses `.env`, process env, or `gh auth token`; Linear
uses `.env`, process env, or available local `linear`/`linear-cli` auth commands.
Found values are saved locally without printing the secret. Secret fields show
`********` by default; use the eye button next to the field to reveal the local
value.

For Linear, `LINEAR_API_KEY` is preferred because it gives deterministic direct
API collection. If Linear is enabled and the key is empty, the app will ask the
local Codex CLI to use the Codex account's connected Linear app as a fallback.
That fallback is non-blocking: missing API key shows as a warning in Checks, not
a failure.

Use Linear project filters to keep unrelated work out of the plan. `Allowed
projects` is an exact project-name allowlist; when it is empty, all projects are
allowed unless they appear in `Blocked projects`. These filters are applied after
both direct Linear API collection and the Codex Linear fallback.

If your Linear work is organized by team rather than project, use `Allowed teams`
or `Blocked teams` instead. Team filters accept either the team name or the team
key, and matching ignores case, spaces, hyphens, and underscores.

When no Linear allowlist is configured, the app collects open issues assigned to
you. When `Allowed projects` or `Allowed teams` is configured, the app collects
open issues in those scopes even if they are unassigned, then applies local
allow/block filters.

The Service buttons only manage the macOS background service. `Install` creates the
`launchd` job that runs the local UI, scheduler, and Feishu realtime connection;
`Uninstall` removes only that job. They do not install or remove the project
itself. The launchd service uses the stable local UI port `14573` by default;
if the port is occupied, the UI falls back to a random local port and records it
in `data/runtime/ui.json`.

`service.prevent_sleep.enabled=true` starts `caffeinate -i` while Daily OS is
running. This prevents idle sleep, but macOS can still force sleep when a
MacBook lid is closed, especially on battery. For reliable always-on behavior,
keep the Mac awake on power or run Daily OS on an always-on machine.

Vault local mode has a `Choose folder` button that opens the macOS folder
picker and writes the selected path into the local config. The top status shows
local setup checks, for example `Checks 4/4 OK`; `Run Checks` reruns those local
dependency and required-config checks.

There are two separate vault-like concepts:

- `sources.vault.local_path` is the user's existing knowledge-base vault used as
  an evidence source.
- `memory.repository_path` is Daily OS working memory. It stores durable goals,
  projects, commitments, review notes, and proposed memory updates.

The Memory repository section controls durable Daily OS memory. Leave
`memory.repository_path` empty to use the generic built-in memory vault at
`memory-vault/default`. For real use, choose or enter a private memory
repository folder. Daily run logs and manual `remember` entries still default to
ignored `data/memory` paths.

Decision calibration also lives in the memory repository. The built-in template
includes `decision-policy.example.yaml`, `decision-policy.example.md`, and
`policy-skill/SKILL.md`. Runtime `decision-policy.yaml` and
`decision-policy.md` files are local user memory, are generated when missing,
and must not be committed. Users should refine these through conversation
rather than editing weights on day one.

The `Rhythm` page decides which days are planned as rest days. The structured
half lives in `config.yaml` under `user.rhythm`: `rest_days` defaults to
`["SAT", "SUN"]` and `work_task_cap_on_rest_days` to 1. On a rest day,
candidates from Linear and weekly priorities are damped
(`breakdown.restDayDamping`) — but anything **overdue or due today is exempt**,
and the user's own hand-captured todos are never damped. Rules that do not fit a
config field go in `rhythm.md` in the memory repository (template
`rhythm.example.md`; the runtime file is likewise git-ignored). The model reads
it verbatim and it outranks the built-in defaults. Someone who works weekends
sets `rest_days: []` or `enabled: false`. The top of the `Rhythm` page shows the
*resolved* verdict for today — the same one the planner uses, not a read-back of
the settings.

The `Logs` tab shows local UI/API request status and action lifecycle events.
Logs are stored in `data/logs/ui-network.jsonl`, do not include request bodies,
response bodies, or secrets, and are automatically pruned to the last 7 days.

For the full first-install checklist, see
[`docs/first-install-checklist.md`](docs/first-install-checklist.md).

The default LLM provider is:

```yaml
llm:
  provider: "codex"
  model: "default"
```

This calls your local Codex CLI and lets Codex choose the model supported by the account already configured on the Mac.

## Vault Integration

The first version does not require vault-gate. By default, knowledge-base vault collection is disabled. To use a local knowledge vault, enable `sources.vault`, set `provider: "local"`, and set `sources.vault.local_path`.

Remote vault mode is optional for later versions. When enabled, it expects a vault-gate service:

- `GET /scan`
- `GET /read?path=...`

Local vault mode reads configured markdown files directly from `sources.vault.local_path`.
It also scans Markdown notes under the configured Vault, skipping hidden/system
folders such as `.obsidian`, `.git`, templates, logs, archived, done, and
abandoned paths. The local scan produces a `vault_scan` evidence source with
ranked candidates:

- frontmatter fields such as `status`, `priority`, `due`, `deadline`,
  `next_review`, and `trigger_condition`
- open Markdown todos
- notes modified recently
- configured meta files such as todos, routing, and watch-list
- matches against confirmed decision policy terms from the Daily OS memory
  repository

This means Vault evidence is not selected by recency alone. The collector
prefers items that match explicit deadlines, priorities, active/watching status,
open todos, or the user's confirmed decision policy. Workflow prompts still
decide whether a candidate enters the main plan, follow-up, or background.

The agent treats missing vault data as missing evidence. It does not write directly to your vault.

## Memory Repository

Daily OS reads long-term working memory from a Markdown repository before each
workflow run. The checked-in default lives at `memory-vault/default` and only
contains generic starter files for identity, preferences, OKRs, projects,
commitments, reviews, and memory candidates.

Configure a real user's private memory repository with:

```yaml
memory:
  repository_path: "/path/to/private-daily-os-memory"
```

If `repository_path` is empty, the app uses the built-in template. The template
is safe to publish; private memory should live outside the repo.

## Decision Calibration

Daily OS supports a first-run decision calibration flow. It creates or reuses a
private Feishu group where the user and the bot can discuss how priorities
should be decided. Confirmed rules become durable policy; exploratory comments
stay as calibration notes or pending candidates.

Start it from the UI with **Start decision onboarding**, or from the CLI:

```bash
npm run dev -- onboarding start
```

The command:

- ensures the decision policy files exist in the memory repository,
- creates a private Feishu group named by `decision.onboarding.chat_name`,
- invites the owner `open_id`,
- saves the group id in `DAILY_OS_DECISION_CHAT_ID` and
  `decision.onboarding.state_path`,
- sends the first calibration prompt to that group.

This uses the same Feishu group creation pattern as
`lark-coding-agent-bridge`: the bot creates a private group with the user's
`open_id`. The Feishu app needs `im:chat` and bot message-send permissions.

In Feishu interaction mode, the user can also send:

- `daily-os policy` to inspect the current policy files.
- `daily-os calibrate` to create or reuse the calibration group and continue the
  policy conversation there.

After the decision calibration group exists, users can chat naturally in that
group without the `daily-os` prefix or @mention. Daily OS uses the current local
`decision-policy.yaml`, `decision-policy.md`, and pending candidate log as
context, replies in Chinese, and appends each calibration turn to
`decision.candidates_path`. The first version records candidates and dialogue
only; it does not silently rewrite durable policy.

Keep `decision.onboarding.auto_create_on_setup: false` for first installs unless
the user explicitly wants startup to create the group automatically.

## Feishu Integration

Workflow output can use the official Feishu SDK, matching the interaction-layer pattern used by `lark-coding-agent-bridge`. Configure the target chat with:

```env
FEISHU_CHAT_ID=
LARK_APP_ID=
LARK_APP_SECRET=
```

Then choose the output provider in `config/config.yaml` or the UI:

```yaml
output:
  feishu:
    enabled: true
    provider: "auto" # auto | sdk | lark_cli
    chat_id_env: "FEISHU_CHAT_ID"
    send_mode: "markdown"
```

`auto` is the recommended default: Daily OS sends through the official SDK when
`LARK_APP_ID` and `LARK_APP_SECRET` are present, and falls back to `lark-cli`
otherwise. Use `sdk` to require bot SDK output, or `lark_cli` to force the old
CLI path.

When SDK output is used with `send_mode: "markdown"`, workflow summaries are
sent as interactive Feishu cards with buttons for details, progress, review, and
rerun actions. Button callbacks require the Feishu interaction layer to be
running and the card callback event to be enabled in the Feishu app. If Feishu
shows "card callback is not configured", open the Feishu Developer Console for
the same app ID, enable the interactive card callback/event delivery, then keep
`npm run start` running locally. The card also includes a text fallback:
`daily-os details`.

Feishu source collection still uses `lark-cli` in this version for calendar,
tasks, docs, and IM history. This keeps the first SDK migration focused on the
message interaction layer and avoids asking customers for every Feishu scope at
once.

## Feishu Interaction Layer

The interaction layer is optional and separate from the scheduled workflows. It
keeps a local websocket connection to Feishu, receives chat events, batches
messages per chat/topic scope, and routes supported commands into the existing
Daily OS workflow core.

Enable it with:

```yaml
interaction:
  feishu:
    enabled: true
    command_prefix: "daily-os"
    require_mention_in_groups: true
    debounce_ms: 600
    reply_mode: "markdown"
    session_catalog_path: "./data/memory/feishu-session-catalog.json"
    agent_mode:
      enabled: false
      workdir: ""
      sandbox: "read-only"
      include_memory: true
      include_evidence: false
      context_pack:
        enabled: true
        include_latest_workflow: true
        include_progress_ledger: true
        include_decision_policy: true
        include_evidence_summary: true
        max_sources: 12
        max_items_per_source: 4
        max_chars_per_item: 900
      timeout_ms: 300000
    security:
      owner_open_id_env: "FEISHU_OWNER_OPEN_ID"
      admin_open_ids: []
      allowed_user_open_ids: []
      allowed_chat_ids: []
      access_level: "read_only"
      allowed_workspaces: []
```

Then run:

```bash
npm run interaction:feishu
```

Supported messages are the same as feedback polling:

- `daily-os status` returns an action card with Plan, Review, and Weekly buttons.
- `/new` or `daily-os new` clears the current Feishu chat/topic session.
- `daily-os details` expands the latest full plan/review/weekly output.
- `daily-os chat [todo|review]` analyzes Feishu chat context and suggests todo,
  calendar, document, and plan updates.
- `daily-os skill list` lists configured local skills.
- `daily-os skill run <id>: <text>` runs a configured local skill in draft-only
  mode with a Daily OS input pack.
- `daily-os weekly deep` is a convenience alias for the `weekly-review` skill.
- `daily-os remember <text>` appends to long-term memory.
- `daily-os feedback <text>` appends to the local feedback log.
- `daily-os policy` shows the current decision policy and policy-skill paths.
- `daily-os calibrate` creates or reuses the decision calibration group.
- `daily-os plan`, `daily-os review`, and `daily-os weekly` run workflows and
  reply in the same chat.

When `interaction.feishu.agent_mode.enabled` is true, messages that are not
recognized Daily OS commands are routed to Codex as free-form agent input. The
prompt includes structured bridge context such as chat id, sender id, thread id,
message ids, scope id, active session metadata, Daily OS memory, and a compact
context pack. The context pack includes the latest workflow summary, today's
progress ledger, confirmed decision policy, pending policy candidates, source
health, and short evidence samples. Raw evidence stays off by default unless
`agent_mode.include_evidence=true`. The local session catalog stores the Codex `thread_id`
so later messages in the same Feishu scope can resume the conversation.

This is the piece that lets Feishu agent mode answer like an assistant instead
of a stateless chat bot: it can refer to the current plan/review, separate
confirmed, paused, and new items, and suggest what Codex can do versus what the
user must decide personally.

Agent mode replies with an updating Feishu run card instead of a one-shot
message. The card shows the running state, recent Codex progress events, final
success/failure/timeout state, and a **Stop** button while the run is active.

Skill runs first execute in draft mode. Daily OS writes a local input pack under
`skills.inputs_dir`, passes it to the configured skill, and does not expose the
skill's private `config.yaml` to the LLM prompt. The `weekly-review` skill has a
separate Feishu write-back confirmation flow: the first card is a draft preview,
**Prepare write-back** creates a second confirmation card with the target week
column and items, and **Confirm write-back** is the only action that can modify
the Feishu Weekly doc. The write-back code reads the skill's local ignored
`config.yaml` only inside the local process to get the document token and table
block id; it stops if the target table marker cannot be verified or if the
target column already has content.
Final cards can send structured follow-up callbacks back into the same Feishu
scope so Codex can continue the conversation.

Agent mode controls:

- `daily-os status`: show the standard action card.
- `/new` or `daily-os new`: archive the current Feishu scope session and start a
  fresh one on the next free-form message.
- `/stop` or `daily-os stop`: stop the active Codex run for the current scope.

This layer does not replace the knowledge vault or memory repository. It is only
the Feishu-facing interaction surface.

Each Feishu DM, group, or topic thread maps to a stable local session scope.
The catalog at `interaction.feishu.session_catalog_path` stores metadata only:
scope ids, chat/thread ids, optional Codex session id, workdir, policy signature,
and timestamps. It does not store message bodies. If the workdir or remote-control
policy changes, the previous scope session is archived and a fresh active record
is created.

### Interaction Access Policy

The interaction layer is deny-by-default. When enabled, it will not process
remote Feishu messages until at least one of these is configured:

- `FEISHU_OWNER_OPEN_ID` in `.env`
- `interaction.feishu.security.allowed_user_open_ids`
- `interaction.feishu.security.allowed_chat_ids`

Access checks run before message batching, workflow triggers, and card button
callbacks. In groups, keep `require_mention_in_groups: true` unless you are
testing in a private bot-only group.

Role rules:

- `owner` / `admin`: can run interaction admin actions and confirm durable
  decision-policy changes.
- `allowed_user`: can run normal read/workflow commands and write feedback or
  memory notes, but cannot confirm durable policy changes.
- `allowed_chat`: can run read/workflow commands only. This keeps an allowed
  group useful without letting every member mutate memory or policy.

Access levels:

- `read_only`: safest default. Allows Daily OS workflow triggers and internal
  memory/feedback writes, but blocks arbitrary workspace writes.
- `workspace`: future agent mode may write only inside configured
  `allowed_workspaces`; Doctor warns if no workspace is configured.
- `full`: trusted private deployments only. Full-control actions still require
  owner/admin and explicit confirmation. Doctor reports this as a warning.

Workspace paths are normalized before checks. A requested workspace must be the
configured allowed path or a child of it; sibling/path-escape writes are denied.

Use Feishu/Lark `open_id` values for users/admins and `chat_id` values for
allowed chats.

## Feishu Feedback Commands

The alpha can poll a configured Feishu chat for lightweight commands. Enable:

```yaml
feedback:
  feishu:
    enabled: true
    command_prefix: "daily-os"
```

Then run:

```bash
npm run feedback:poll
```

Supported messages:

- `daily-os status`
- `daily-os remember <text>`
- `daily-os feedback <text>`
- `daily-os skill list`
- `daily-os skill run <id>: <text>`
- `daily-os plan`
- `daily-os review`
- `daily-os weekly`

`remember` appends to long-term memory. `feedback` appends to the local feedback
log. Both files live under ignored `data/` paths by default.

## Privacy

Run the local privacy gate before opening a PR or publishing:

```bash
npm run privacy:scan
```

Do not commit:

- `.env`
- `config/config.yaml`
- `data/`
- `logs/`
- `dist/`

These paths are ignored by default.

## Design Notes

The alpha is intentionally local-first: source connectors, personal memory,
tokens, chat IDs, and vault paths stay in user-owned config files or private
folders that are not committed to the repository.

## License

MIT. See [LICENSE](LICENSE).

This repository had declared `"license": "MIT"` in `package.json` without
carrying the licence text, which is not the same thing: a public repository
with no LICENSE file is all rights reserved, so nobody could legally use it or
contribute to it. The file settles that.

The native clients are separate, also MIT:
[daily-os-macos](https://github.com/alexli-77/daily-os-macos) and
[daily-os-ios](https://github.com/alexli-77/daily-os-ios).
