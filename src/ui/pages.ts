import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config/schema.js';
import type { Role } from './auth.js';
import { listRecentWorkflowRuns, type WorkflowRunRecord } from '../workflows/run-ledger.js';
import {
  listTodoInboxHistory,
  openTodoInboxItems,
  purgeExpiredTodoInboxHistory,
  TODO_HISTORY_RETENTION_DAYS,
  type TodoInboxItem,
} from '../todo/inbox.js';
import { readLatestWorkflowOutput } from '../storage/memory.js';
import { extractDailyPlanTodos } from '../workflows/summary.js';
import { todayInTimezone } from '../utils/date.js';
import { listTodoFeedback } from '../todo/feedback.js';
import { readOkrSnapshot, type OkrFile, type OkrObjective } from './okr-lite.js';
import { RETRO_TEMPLATE } from '../cycles/retro-template.js';
import { pixelAvatarSvg } from './avatar.js';
import { readArtifactsIndex, findArtifactById, isPreviewableType, type ArtifactRecord } from '../storage/artifacts.js';
import { runManager } from '../service/run-manager.js';
import { linearIssueUrl } from '../utils/linear-link.js';

/**
 * Server-rendered pages for the LEO-210 web console. These are plain HTML
 * strings (no front-end framework, no npm deps) that share the existing
 * server.ts rendering style. Data is read from disk at request time and always
 * degrades gracefully when a file is missing.
 */

export interface PageContext {
  config: AppConfig;
  role: Role;
  username: string;
  email: string;
  /** Drives the topbar avatar. '' falls back to the username. */
  avatarSeed: string;
  url: URL;
}

export const PLATFORM_PAGES = new Set(['/dashboard', '/today', '/cycles', '/okr', '/chat', '/schedules', '/runs', '/artifacts', '/profile']);

const NAV: Array<{ href: string; label: string }> = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/today', label: 'Today' },
  { href: '/cycles', label: 'Cycles' },
  { href: '/okr', label: 'OKR' },
  { href: '/chat', label: 'Chat' },
  { href: '/schedules', label: 'Schedules' },
  { href: '/runs', label: 'Runs' },
  { href: '/artifacts', label: 'Artifacts' },
  // Config (/console) moved out of the top bar into the avatar dropdown ("设置").
];

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderPlatformPage(pathname: string, ctx: PageContext): string {
  switch (pathname) {
    case '/dashboard':
      return layout('/dashboard', ctx, renderDashboard(ctx));
    case '/today':
      return layout('/today', ctx, renderToday(ctx));
    case '/cycles':
      return layout('/cycles', ctx, renderCyclesPage(ctx));
    case '/okr':
      return layout('/okr', ctx, renderOkrPage(ctx));
    case '/chat':
      return layout('/chat', ctx, renderChat(ctx));
    case '/schedules':
      return layout('/schedules', ctx, renderSchedules(ctx));
    case '/runs':
      return layout('/runs', ctx, renderRuns(ctx));
    case '/artifacts':
      return layout('/artifacts', ctx, renderArtifacts(ctx));
    case '/profile':
      return layout('/profile', ctx, renderProfile(ctx));
    default:
      return layout('/dashboard', ctx, '<p>Unknown page.</p>');
  }
}

// --- layout -----------------------------------------------------------------

function layout(active: string, ctx: PageContext, body: string): string {
  const nav = NAV.map(
    (item) => `<a class="nav-link${item.href === active ? ' active' : ''}" href="${item.href}">${escapeHtml(item.label)}</a>`,
  ).join('');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Daily OS Console</title>
  <style>${CONSOLE_CSS}</style>
  <script>${FONT_PREF_JS}</script>
</head>
<body>
  <header class="topbar">
    <div class="brand">Daily OS · Console</div>
    <nav class="nav">${nav}</nav>
    <div class="session usermenu" data-usermenu>
      <button type="button" class="usermenu-trigger" data-usermenu-toggle aria-haspopup="menu" aria-expanded="false" title="打开用户导航栏">
        ${pixelAvatarSvg(ctx.avatarSeed || ctx.username)}
        <span class="who">${escapeHtml(ctx.username)}</span>
        <span class="usermenu-caret" aria-hidden="true">▾</span>
      </button>
      <div class="usermenu-panel" role="menu" hidden>
        <a role="menuitem" href="/profile">个人信息</a>
        <a role="menuitem" href="/console">设置</a>
        <button type="button" role="menuitem" data-logout>退出</button>
      </div>
    </div>
  </header>
  <main class="page">${body}</main>
  <div class="toast" id="toast" hidden></div>
  <script>${CONSOLE_JS}</script>
</body>
</html>`;
}

/**
 * The signed-out landing page.
 *
 * Before this, `/` bounced to `/dashboard` and on to `/login`, so the first and
 * only thing a visitor saw was a password form with nothing to go back to. Now
 * the root explains what this is and offers a sign-up; once you are signed in
 * the root redirects to the dashboard, so the welcome page is only ever the
 * signed-out view and never something you have to dismiss.
 *
 * Deliberately small. The real product page is its own piece of work — this is
 * the page that keeps the door from being a dead end.
 */
export function renderWelcomePage(): string {
  const features = ([
    ['双周复盘', '把计划和执行放在一起对比，生成下一期要务，复盘写在本地 markdown 里。'],
    ['本地优先', '你的周期、OKR、复盘都是你机器上的文件。远端只做同步，不做真相源。'],
    ['和你的工具连起来', 'Linear、飞书、日历、Obsidian vault —— 证据从它们来，结论回到你的文件里。'],
    ['团队只读视图', '把自己的周期同步给家人或搭档看，各自的文件仍然在各自机器上。'],
  ] as Array<[string, string]>)
    .map(([title, body]) => `<li><h3>${escapeHtml(title)}</h3><p>${escapeHtml(body)}</p></li>`)
    .join('');

  return `<!doctype html>
<html lang="zh">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Daily OS</title>
  <style>${CONSOLE_CSS}</style>
</head>
<body class="welcome-body">
  <header class="topbar">
    <div class="brand">Daily OS</div>
    <nav class="nav"></nav>
    <div class="session">
      <button type="button" id="auth-open">注册 / 登录</button>
    </div>
  </header>
  <main class="page welcome">
    <section class="welcome-hero">
      <h1>把计划、执行和复盘放在同一个地方</h1>
      <p class="muted">Daily OS 每两周帮你对一次账：这一期计划了什么、实际做了什么、下一期该做什么。所有内容都写进你自己的 markdown 文件。</p>
      <div class="welcome-actions">
        <button type="button" data-auth-open="register">创建账号</button>
        <button type="button" class="secondary" data-auth-open="login">已有账号，登录</button>
      </div>
      <p class="muted small">只在本机运行（127.0.0.1）。配置、密钥和 vault 都留在这台电脑上。</p>
    </section>
    <ul class="welcome-features">${features}</ul>
  </main>
  ${AUTH_MODAL}
  <script>${AUTH_JS}</script>
</body>
</html>`;
}

/**
 * One dialog, two modes. Registering is the default: signing in is the case for
 * someone who already has an account, and this page exists for people who do
 * not.
 *
 * Errors render under the field they belong to, in red, rather than as an alert
 * — a popup for "密码短了两位" makes you dismiss something before you can fix it.
 */
const AUTH_MODAL = `
<div class="auth-modal" id="auth-modal" role="dialog" aria-modal="true" aria-labelledby="auth-title" hidden>
  <form class="auth-card" id="auth-form" autocomplete="on">
    <div class="card-head">
      <h2 id="auth-title">创建账号</h2>
      <button type="button" class="secondary compact" id="auth-close" aria-label="关闭">关闭</button>
    </div>
    <label><span id="auth-username-label">用户名</span>
      <input id="auth-username" name="username" autocomplete="username" />
      <span class="field-error" id="auth-error-username" hidden></span>
    </label>
    <p class="muted small" id="auth-existing" hidden></p>
    <label id="auth-email-row">邮箱
      <input id="auth-email" name="email" type="email" autocomplete="email" />
      <span class="field-error" id="auth-error-email" hidden></span>
    </label>
    <label>密码
      <input id="auth-password" name="password" type="password" autocomplete="new-password" />
      <span class="field-hint muted small" id="auth-password-hint">8-20 个字符</span>
      <span class="field-error" id="auth-error-password" hidden></span>
    </label>
    <p class="field-error" id="auth-error-form" hidden></p>
    <p class="muted small" id="auth-local-note">这个账号只建在本机服务上，不会出现在 Supabase / 团队成员里。</p>
    <button type="submit" id="auth-submit">创建账号并登录</button>
    <p class="muted small auth-switch">
      <span id="auth-switch-text">已经有账号了？</span>
      <a href="#" id="auth-switch">去登录</a>
    </p>
    <p class="muted small auth-switch" id="auth-forgot-row" hidden>
      <a href="#" id="auth-forgot">忘记密码？在本机重置</a>
    </p>
  </form>
</div>`;

const AUTH_JS = String.raw`
var authMode = 'register';

function authEl(id) { return document.getElementById(id); }
function authSetError(field, message) {
  var el = authEl('auth-error-' + field);
  if (!el) return;
  el.textContent = message || '';
  el.hidden = !message;
}
function authClearErrors() {
  ['username', 'email', 'password', 'form'].forEach(function (field) { authSetError(field, ''); });
}
function authHideExisting() {
  var el = authEl('auth-existing');
  if (el) { el.hidden = true; el.textContent = ''; }
}

function authSetMode(mode) {
  authMode = mode === 'login' ? 'login' : mode === 'reset' ? 'reset' : 'register';
  var register = authMode === 'register';
  var reset = authMode === 'reset';
  authClearErrors();
  authHideExisting();
  authEl('auth-title').textContent = register ? '创建账号' : reset ? '重置密码' : '登录';
  authEl('auth-submit').textContent = register ? '创建账号并登录' : reset ? '重置密码' : '登录';
  // Email is only collected on sign-up; asking for it elsewhere would be a
  // second thing to get wrong for no benefit.
  authEl('auth-email-row').hidden = !register;
  authEl('auth-password-hint').hidden = !register && !reset;
  authEl('auth-password-hint').textContent = reset ? '新密码 8-20 个字符' : '8-20 个字符';
  authEl('auth-password').setAttribute('autocomplete', register || reset ? 'new-password' : 'current-password');
  authEl('auth-switch-text').textContent = register ? '已经有账号了？' : reset ? '' : '还没有账号？';
  authEl('auth-switch').textContent = register ? '去登录' : reset ? '返回登录' : '去注册';
  // Signing in accepts either identifier, so the label says so; the format rule
  // below only applies to picking a new name.
  authEl('auth-username-label').textContent = register ? '用户名' : reset ? '要重置的用户名' : '用户名或邮箱';
  var localNote = authEl('auth-local-note'); if (localNote) localNote.hidden = !register;
  var forgotRow = authEl('auth-forgot-row'); if (forgotRow) forgotRow.hidden = authMode !== 'login';
}

function authOpen(mode) {
  var modal = authEl('auth-modal');
  if (!modal) return;
  authSetMode(mode);
  modal.hidden = false;
  var first = authEl('auth-username');
  if (first && first.focus) first.focus();
}

function authClose() {
  var modal = authEl('auth-modal');
  if (modal) modal.hidden = true;
}

/**
 * The same rules the server enforces, so the form can answer immediately. The
 * server checks again regardless — this decides what the form looks like, not
 * what gets stored.
 */
function authValidate(values) {
  var errors = {};
  if (authMode === 'reset') {
    if (!values.username) errors.username = '请选择要重置的账号';
    if (!values.password) errors.password = '请填写新密码';
    else if (values.password.length < 8 || values.password.length > 20) errors.password = '密码需要 8-20 个字符';
    return errors;
  }
  if (!values.username) errors.username = authMode === 'register' ? '请填写用户名' : '请填写用户名或邮箱';
  // The character rule is about choosing a name. An existing account is looked
  // up by whatever was typed, so signing in must not reject an email here.
  else if (authMode === 'register' && !/^[A-Za-z0-9_.-]{2,64}$/.test(values.username)) {
    errors.username = '用户名只能用字母、数字、_ . -，2-64 个字符';
  }
  if (authMode === 'register') {
    if (!values.email) errors.email = '请填写邮箱';
    else if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(values.email)) errors.email = '邮箱格式不对';
  }
  if (!values.password) errors.password = '请填写密码';
  else if (authMode === 'register' && (values.password.length < 8 || values.password.length > 20)) {
    errors.password = '密码需要 8-20 个字符';
  }
  return errors;
}

async function authSubmit(event) {
  if (event && event.preventDefault) event.preventDefault();
  authClearErrors();
  var values = {
    username: (authEl('auth-username').value || '').trim(),
    email: (authEl('auth-email').value || '').trim(),
    password: authEl('auth-password').value || '',
  };
  var errors = authValidate(values);
  var fields = Object.keys(errors);
  if (fields.length > 0) {
    fields.forEach(function (field) { authSetError(field, errors[field]); });
    return;
  }

  var button = authEl('auth-submit');
  var label = button.textContent;
  button.disabled = true;
  button.textContent = '处理中…';
  try {
    var endpoint = authMode === 'register' ? '/api/register' : authMode === 'reset' ? '/api/reset-password' : '/api/login';
    var payload = authMode === 'register'
      ? { username: values.username, email: values.email, password: values.password }
      : { username: values.username, password: values.password };
    var response = await fetch(endpoint, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    var data = await response.json();
    if (data && data.ok) {
      if (authMode === 'reset') {
        // Reset does not sign you in; drop back to login with the name prefilled.
        var name = values.username;
        authSetMode('login');
        authEl('auth-username').value = name;
        authSetError('form', '密码已重置，请用新密码登录。');
        return;
      }
      // Registering signs you in, so both paths land in the same place.
      window.location.href = '/dashboard';
      return;
    }
    // GH #192: on a taken username the server returns the machine's usernames so
    // the operator can see which local account to sign into.
    if (data && data.existingUsers && data.existingUsers.length) {
      var existing = authEl('auth-existing');
      if (existing) {
        existing.textContent = '这台机器上已有账号：' + data.existingUsers.join('、') + ' —— 点下面「去登录」用它登录。';
        existing.hidden = false;
      }
    }
    if (data && data.errors) {
      Object.keys(data.errors).forEach(function (field) { authSetError(field, data.errors[field]); });
    } else {
      authSetError('form', (data && data.error) || '请求失败，请重试');
    }
  } catch (error) {
    authSetError('form', '请求失败：' + error);
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

if (authEl('auth-open')) authEl('auth-open').addEventListener('click', function () { authOpen('register'); });
// Redirected here from a page that needed a session: open straight into the
// sign-in form, since whoever was sent back almost certainly has an account.
if (/[?&]signin=1(&|$)/.test(window.location.search)) authOpen('login');
if (authEl('auth-close')) authEl('auth-close').addEventListener('click', authClose);
if (authEl('auth-form')) authEl('auth-form').addEventListener('submit', authSubmit);
if (authEl('auth-switch')) authEl('auth-switch').addEventListener('click', function (event) {
  if (event && event.preventDefault) event.preventDefault();
  authSetMode(authMode === 'register' ? 'login' : authMode === 'reset' ? 'login' : 'register');
});
if (authEl('auth-forgot')) authEl('auth-forgot').addEventListener('click', function (event) {
  if (event && event.preventDefault) event.preventDefault();
  var name = (authEl('auth-username').value || '').trim();
  authSetMode('reset');
  if (name) authEl('auth-username').value = name;
});
if (authEl('auth-modal')) authEl('auth-modal').addEventListener('click', function (event) {
  if (event.target === authEl('auth-modal')) authClose();
});
document.addEventListener('click', function (event) {
  var opener = event.target.closest ? event.target.closest('[data-auth-open]') : null;
  if (opener) authOpen(opener.dataset.authOpen);
});
document.addEventListener('keydown', function (event) {
  var modal = authEl('auth-modal');
  if (event.key === 'Escape' && modal && !modal.hidden) authClose();
});
`;

// --- dashboard --------------------------------------------------------------

function renderProfile(ctx: PageContext): string {
  const roleLabel = ctx.role === 'admin' ? '管理员' : '成员';
  return `
  <section class="card profile-card">
    <div class="profile-head">
      ${pixelAvatarSvg(ctx.avatarSeed || ctx.username)}
      <div>
        <h2>${escapeHtml(ctx.username)}</h2>
        <p class="muted small">${escapeHtml(roleLabel)}${ctx.email ? ' · ' + escapeHtml(ctx.email) : ''}</p>
      </div>
    </div>
    <table class="grid">
      <tbody>
        <tr><th>用户名</th><td>${escapeHtml(ctx.username)}</td></tr>
        <tr><th>角色</th><td>${escapeHtml(roleLabel)}</td></tr>
        <tr><th>邮箱</th><td>${ctx.email ? escapeHtml(ctx.email) : '<span class="muted">未设置</span>'}</td></tr>
      </tbody>
    </table>
    <p class="muted small">账号设置与界面偏好（含字体大小）在 <a href="/console">设置</a> 里调整。</p>
  </section>`;
}

function renderDashboard(ctx: PageContext): string {
  const { config } = ctx;
  const schedule = workflowSchedule(config);
  const fired = readFiredKeys();
  const today = utcDay();
  const scheduleRows = schedule
    .map((item) => {
      const key = `${today}:${item.workflow}:${item.time}`;
      const status = !item.enabled ? 'disabled' : fired.has(key) ? 'fired today' : 'waiting';
      return `<tr><td>${escapeHtml(item.label)}</td><td>${escapeHtml(item.time)}</td><td>${escapeHtml(item.enabled ? 'on' : 'off')}</td><td>${escapeHtml(status)}</td></tr>`;
    })
    .join('');

  const runs = safe(() => listRecentWorkflowRuns(config, 8), []);
  const runsHtml = runs.length
    ? `<table class="grid"><thead><tr><th>Workflow</th><th>Trigger</th><th>Status</th><th>Started</th></tr></thead><tbody>${runs
        .map(
          (run) =>
            `<tr><td>${escapeHtml(run.workflow)}</td><td>${escapeHtml(run.trigger)}</td><td>${statusPill(run.status)}</td><td>${escapeHtml(shortTime(run.started_at))}</td></tr>`,
        )
        .join('')}</tbody></table>`
    : '<p class="muted">No workflow runs recorded yet.</p>';

  const usage = readUsageSummary();
  const usageHtml = usage.enabled
    ? `<div class="stat-row">
        <div class="stat"><span class="stat-num">${usage.todayCalls}</span><span class="stat-label">calls today</span></div>
        <div class="stat"><span class="stat-num">${formatTokens(usage.todayTokens)}</span><span class="stat-label">tokens today</span></div>
        <div class="stat"><span class="stat-num">$${usage.todayCost.toFixed(4)}</span><span class="stat-label">est. cost today</span></div>
        <div class="stat"><span class="stat-num">$${usage.monthCost.toFixed(2)}</span><span class="stat-label">est. cost (${escapeHtml(usage.month)})</span></div>
      </div><p class="muted small">Source: data/runtime/usage-ledger.jsonl (UTC).</p>`
    : '<p class="muted">Token usage ledger not enabled. Nothing recorded at data/runtime/usage-ledger.jsonl yet.</p>';

  return `
  <section class="card">
    <h2>Today's workflows</h2>
    <table class="grid"><thead><tr><th>Workflow</th><th>Time</th><th>Enabled</th><th>Status</th></tr></thead><tbody>${scheduleRows}</tbody></table>
  </section>
  <section class="card">
    <h2>Recent runs</h2>
    ${runsHtml}
  </section>
  <section class="card">
    <h2>Token usage</h2>
    ${usageHtml}
  </section>
  ${ctx.role === 'admin' ? renderAdminUsers() : ''}
  `;
}

function renderAdminUsers(): string {
  return `
  <section class="card">
    <h2>Users <span class="tag">admin only</span></h2>
    <form class="inline-form" data-post="/api/admin/users">
      <input name="username" placeholder="username" required />
      <input name="password" type="password" placeholder="password (min 8)" required />
      <select name="role"><option value="member">member</option><option value="admin">admin</option></select>
      <input type="hidden" name="action" value="add" />
      <button type="submit">Add user</button>
    </form>
    <p class="muted small">Members are read-only in the console except for whitelisted Today actions.</p>
  </section>`;
}

// --- today ------------------------------------------------------------------

function renderToday(ctx: PageContext): string {
  const planCol = renderPlanColumn(ctx);
  const myTodoCol = renderMyTodoColumn(ctx);

  return `
  <div class="two-col">
    <section class="card col"><h2>Today's plan</h2>${planCol}</section>
    <section class="card col"><h2>My todos</h2>${myTodoCol}</section>
  </div>
  <section class="card" id="team-today"><h2>团队今天</h2><p class="muted" id="team-today-status">读取中…</p><div id="team-today-members"></div></section>
  <script>window.__LINEAR_WS__=${JSON.stringify(ctx.config.sources.linear.workspace)};</script>
  <script>${TEAM_TODAY_JS}</script>`;
}

/**
 * Teammates' today lists. Fetched after load rather than server-rendered: the
 * team view reader is async (it resolves the session module lazily) and the
 * Today page renderer is not, and one round trip to the local cache is cheaper
 * than making every page render async for a panel most installs leave empty.
 */
const TEAM_TODAY_JS = String.raw`
(function () {
  var status = document.getElementById('team-today-status');
  var box = document.getElementById('team-today-members');
  if (!status || !box) return;
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }
  function tag(candidateId) {
    if (!candidateId) return '';
    if (candidateId.indexOf('linear:') === 0) {
      var id = candidateId.slice(7);
      var ws = window.__LINEAR_WS__ || '';
      var href = ws ? 'https://linear.app/' + encodeURIComponent(ws) + '/issue/' + encodeURIComponent(id) : 'https://linear.app/issue/' + encodeURIComponent(id);
      return '<a class="tag tag-link" href="' + esc(href) + '" target="_blank" rel="noopener">' + esc(id) + '</a>';
    }
    return '<span class="tag">' + esc(candidateId) + '</span>';
  }
  function renderMember(member) {
    var head = '<h3>' + esc(member.label) + '</h3>';
    if (!member.plan) return '<div class="team-today-member">' + head + '<p class="muted">还没有收到 TA 的今日计划。</p></div>';
    var payload = member.plan.payload || {};
    var todos = payload.todos || [];
    var feedback = payload.feedback || {};
    var note = member.stale ? '<p class="muted small">来自 ' + esc(member.plan.date) + ' 的 plan（TA 今天还没跑）。</p>' : '';
    if (!todos.length) return '<div class="team-today-member">' + head + note + '<p class="muted">这份 plan 没有待办条目。</p></div>';
    var rows = todos.map(function (todo) {
      var state = todo.candidateId ? feedback[todo.candidateId] : '';
      var label = state === 'complete' ? 'done' : state === 'defer' ? 'deferred' : state === 'update' ? 'updated' : '';
      return '<li class="todo-item' + (state === 'complete' ? ' state-checked' : '') + '">' +
        '<div class="todo-text"><span class="plan-rank">' + esc(todo.rank) + '</span> ' + esc(todo.text) + '</div>' +
        '<div class="todo-meta">' + tag(todo.candidateId || '') + (label ? '<span class="muted small">' + label + '</span>' : '') + '</div>' +
        '</li>';
    }).join('');
    return '<div class="team-today-member">' + head + note + '<ul class="todo-list">' + rows + '</ul></div>';
  }
  fetch('/api/team/today', { credentials: 'same-origin' })
    .then(function (response) { return response.json(); })
    .then(function (data) {
      if (!data || !data.ok) { status.textContent = '读取失败。'; return; }
      if (data.status !== 'ready') { status.textContent = data.reason || '团队同步未启用。'; return; }
      if (!data.members.length) { status.textContent = '团队里还没有其他成员。'; return; }
      status.textContent = data.syncedAt ? '只读 · 最近同步 ' + new Date(data.syncedAt).toLocaleString() : '只读';
      box.innerHTML = data.members.map(renderMember).join('');
    })
    .catch(function () { status.textContent = '读取失败。'; });
})();
`;

/** Today's plan — the todos the daily_plan workflow generated (read-only view). */
function renderPlanColumn(ctx: PageContext): string {
  const { config } = ctx;
  const latest = safe(() => readLatestWorkflowOutput(config), null);
  if (!latest || latest.workflow !== 'daily_plan') {
    return '<p class="muted">还没有今日 plan。在 Chat 里发 <code>daily-os plan</code>，或等定时任务生成。</p>';
  }
  const todos = safe(() => extractDailyPlanTodos(latest.content), []);
  if (todos.length === 0) {
    return '<p class="muted">最近一次 plan 没有解析出待办条目。</p>';
  }
  const today = safe(() => todayInTimezone(config), '');
  const staleNote =
    latest.date && today && latest.date !== today
      ? `<p class="muted small">来自 ${escapeHtml(latest.date)} 的 plan（今天还没跑）。</p>`
      : '';
  // Latest feedback per candidateId for today, so the card reflects what the
  // user already ticked (the evening daily_review reconciles the same ledger).
  const feedbackState = new Map<string, string>();
  for (const entry of safe(() => listTodoFeedback(config), [])) {
    if (entry.date !== today) continue;
    if (entry.event === 'complete' || entry.event === 'defer' || entry.event === 'update') {
      feedbackState.set(entry.candidateId, entry.event);
    }
  }
  const workspace = config.sources.linear.workspace;
  const resendRow = `<div class="plan-toolbar"><button type="button" class="secondary compact" data-post="/api/today/resend">发飞书</button></div>`;
  const rows = todos
    .map((todo) => {
      const state = todo.candidateId ? feedbackState.get(todo.candidateId) : undefined;
      const stateLabel = state === 'complete' ? 'done' : state === 'defer' ? 'deferred' : state === 'update' ? 'updated' : '';
      const issueId = todo.candidateId.startsWith('linear:') ? todo.candidateId.slice('linear:'.length) : '';
      const tag = issueId
        ? `<a class="tag tag-link" href="${escapeHtml(linearIssueUrl(issueId, workspace))}" target="_blank" rel="noopener">${escapeHtml(issueId)}</a>`
        : todo.candidateId
          ? `<span class="tag">${escapeHtml(todo.candidateId)}</span>`
          : '';
      const actions = todo.candidateId
        ? `<div class="todo-actions plan-actions">
            <button type="button" class="secondary" data-post="/api/today/todo-feedback" data-note-prompt="记录一条更新（可留空）" data-payload='${payload({ candidateId: todo.candidateId, rank: todo.rank, event: 'update' })}'>更新</button>
            <button type="button" class="secondary" data-post="/api/today/todo-feedback" data-payload='${payload({ candidateId: todo.candidateId, rank: todo.rank, event: 'defer' })}'>延期</button>
            <button type="button" data-post="/api/today/todo-feedback" data-payload='${payload({ candidateId: todo.candidateId, rank: todo.rank, event: 'complete' })}'>完成</button>
          </div>`
        : '';
      return `<li class="todo-item${state === 'complete' ? ' state-checked' : ''}">
        <div class="todo-text"><span class="plan-rank">${todo.rank}</span> ${escapeHtml(todo.text)}</div>
        <div class="todo-meta">${tag}${stateLabel ? `<span class="muted small">${stateLabel}</span>` : ''}</div>
        ${actions}
      </li>`;
    })
    .join('');
  return `${resendRow}${staleNote}<ul class="todo-list">${rows}</ul>`;
}

/** My todos — the user's own quick captures, with add / done / defer / delete. */
function renderMyTodoColumn(ctx: PageContext): string {
  const { config } = ctx;
  // Retire anything past the retention window before reading the history lists.
  safe(() => purgeExpiredTodoInboxHistory(config), 0);
  const open = safe(() => openTodoInboxItems(config), []);
  const done = safe(() => listTodoInboxHistory(config, 'done'), []);
  const deferred = safe(() => listTodoInboxHistory(config, 'deferred'), []);
  const captureForm = `
    <form class="inline-form todo-capture" data-post="/api/capture">
      <input name="text" placeholder="记一条 todo…" autocomplete="off" required />
      <button type="submit">Add</button>
    </form>`;
  const openList =
    open.length === 0
      ? '<p class="muted">还没有记录。</p>'
      : `<ul class="todo-list">${open
          .map(
            (item) => `<li class="todo-item">
        <div class="todo-text">${escapeHtml(item.text)}</div>
        <div class="todo-meta"><span class="tag">${escapeHtml(item.type)}</span><span class="muted small">open</span></div>
        <div class="todo-actions">
          <button type="button" data-post="/api/today/todo-feedback" data-payload='${payload({ id: item.id, action: 'check' })}'>Done</button>
          <button type="button" class="secondary" data-post="/api/today/todo-feedback" data-payload='${payload({ id: item.id, action: 'defer' })}'>Defer</button>
          <button type="button" class="secondary" data-post="/api/todo-inbox" data-payload='${payload({ id: item.id, status: 'deleted' })}'>Delete</button>
        </div>
      </li>`,
          )
          .join('')}</ul>`;
  return `${captureForm}${openList}${renderTodoHistorySection('History', 'done', done)}${renderTodoHistorySection('Deferred', 'deferred', deferred)}`;
}

/**
 * A collapsed History / Deferred list: the last month of done (or deferred) todos,
 * each restorable back to open or deletable outright. Anything older than the
 * retention window has already been retired before this renders.
 */
function renderTodoHistorySection(label: string, state: 'done' | 'deferred', items: TodoInboxItem[]): string {
  const rows =
    items.length === 0
      ? `<p class="muted small">最近 ${TODO_HISTORY_RETENTION_DAYS} 天没有${state === 'done' ? '完成' : '延期'}的 todo。</p>`
      : `<ul class="todo-list">${items
          .map(
            (item) => `<li class="todo-item state-${state === 'done' ? 'checked' : 'deferred'}">
        <div class="todo-text">${escapeHtml(item.text)}</div>
        <div class="todo-meta"><span class="tag">${escapeHtml(item.type)}</span><span class="muted small">${escapeHtml(formatTodoHistoryDate(item.updated_at || item.created_at))}</span></div>
        <div class="todo-actions">
          <button type="button" data-post="/api/todo-inbox" data-payload='${payload({ id: item.id, status: 'open' })}'>Restore</button>
          <button type="button" class="secondary" data-post="/api/todo-inbox" data-payload='${payload({ id: item.id, status: 'deleted' })}'>Delete</button>
        </div>
      </li>`,
          )
          .join('')}</ul>`;
  return `<details class="todo-history"><summary>${escapeHtml(label)} <span class="muted small">${items.length} · 最近 ${TODO_HISTORY_RETENTION_DAYS} 天</span></summary>${rows}</details>`;
}

/** `2026-08-04 14:30` — enough to tell two same-day entries apart, no timezone noise. */
function formatTodoHistoryDate(value: string): string {
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) return value;
  const date = new Date(ts);
  const pad = (input: number): string => String(input).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// --- okr --------------------------------------------------------------------

/**
 * Read-only view of the two long-horizon OKR files, side by side. The files are
 * edited in Config → OKR; this page only parses and renders them, so every
 * failure mode (missing file, unparseable body, objective without KRs) has to
 * degrade into a message rather than a blank column.
 */
function renderOkrPage(ctx: PageContext): string {
  const okr = safe(() => readOkrSnapshot(ctx.config.memory.repository_path), null);
  if (!okr) {
    return `<section class="card">
      <h2>OKR</h2>
      <p class="muted">读不到 OKR 目录。检查 config 里的 <code>memory.repository_path</code>，或到 <a href="/console#okr">Config → OKR</a> 填写。</p>
    </section>`;
  }
  return `
  <div class="two-col">
    ${renderOkrPanel('5 年 North Star', 'north-star-okr.md', okr.northStar)}
    ${renderOkrPanel('年度 Annual', 'annual-okr.md', okr.annual)}
  </div>
  <p class="muted small">来源目录 <code>${escapeHtml(okr.dir)}</code> · 只读视图，编辑请到 <a href="/console#okr">Config → OKR</a>。</p>`;
}

function renderOkrPanel(label: string, fileName: string, file: OkrFile): string {
  const head = `<div class="card-head"><h2>${escapeHtml(label)}</h2><span class="tag">${escapeHtml(fileName)}</span></div>`;
  if (!file.exists) {
    return `<section class="card col">${head}
      <p class="muted">还没有 <code>${escapeHtml(fileName)}</code>。到 <a href="/console#okr">Config → OKR</a> 写入后这里会显示。</p>
    </section>`;
  }
  const meta = [
    file.frontmatter.cycle ? `周期 ${file.frontmatter.cycle}` : '',
    file.frontmatter.status ? `状态 ${file.frontmatter.status}` : '',
    file.frontmatter.updated ? `更新于 ${file.frontmatter.updated}` : '',
  ].filter(Boolean);
  const krCount = file.objectives.reduce((sum, obj) => sum + obj.keyResults.length, 0);
  const summary = `${file.objectives.length} 个 Objective · ${krCount} 个 KR`;
  const body =
    file.objectives.length === 0
      ? `<p class="muted">这个文件里没有解析出 Objective。需要 <code>## Objective &lt;id&gt;: &lt;title&gt;</code> 标题，以及 <code>KR ID | Description | Target | Current | Progress | Updated</code> 这张表。</p>`
      : file.objectives.map(renderOkrObjective).join('');
  return `<section class="card col">${head}
    <p class="muted small">${escapeHtml([summary, ...meta].join(' · '))}</p>
    ${body}
  </section>`;
}

/**
 * `Parent: none` is how the top-level files spell "nothing above this". Both
 * north-star-okr.md and annual-okr.md use it on every objective, so rendering it
 * verbatim puts a meaningless `↦ none` tag on every heading of this page.
 */
function okrParentLabel(parent: string | undefined): string {
  const value = String(parent ?? '').trim();
  return /^(none|n\/a|-|—)$/i.test(value) ? '' : value;
}

/**
 * Target/Current are blank for most KRs in the long-horizon files — the numbers
 * only get filled in on the quarterly file. Emitting the row anyway would put
 * `目标 — · 当前 —` under every single KR, so drop it when there is nothing in it.
 */
function renderKrMeta(kr: OkrObjective['keyResults'][number]): string {
  const placeholder = (value: string) => (/^(-|—|n\/a)?$/i.test(String(value ?? '').trim()) ? '' : String(value).trim());
  const parts = [
    placeholder(kr.target) && `目标 ${escapeHtml(placeholder(kr.target))}`,
    placeholder(kr.current) && `当前 ${escapeHtml(placeholder(kr.current))}`,
    placeholder(kr.updated) && escapeHtml(placeholder(kr.updated)),
  ].filter(Boolean);
  return parts.length ? `<div class="kr-meta muted small">${parts.join(' · ')}</div>` : '';
}

function renderOkrObjective(obj: OkrObjective): string {
  const parent = okrParentLabel(obj.parent);
  const krs = obj.keyResults.length
    ? obj.keyResults
        .map(
          (kr) => `<li>
            <div class="kr-head"><span class="kr-id">${escapeHtml(kr.id)}</span><span class="kr-prog">${kr.progress === null ? '—' : `${kr.progress}%`}</span></div>
            <div class="kr-desc">${escapeHtml(kr.description)}</div>
            <div class="bar"><span style="width:${kr.progress ?? 0}%"></span></div>
            ${renderKrMeta(kr)}
          </li>`,
        )
        .join('')
    : '<li class="muted">这个 Objective 下还没有 KR。</li>';
  return `<div class="objective">
    <h3>${escapeHtml(obj.id)}: ${escapeHtml(obj.title)}${parent ? ` <span class="tag">↦ ${escapeHtml(parent)}</span>` : ''}</h3>
    <ul class="kr-list">${krs}</ul>
  </div>`;
}

// --- chat (LEO-236) ---------------------------------------------------------

function renderChat(ctx: PageContext): string {
  const agentEnabled = ctx.config.interaction.feishu.agent_mode.enabled;
  const roleHint =
    ctx.role === 'admin'
      ? 'Admin: full command surface + free-form assistant.'
      : 'Member: whitelisted commands only (plan / review / weekly / progress / todo).';
  const agentHint = agentEnabled
    ? ''
    : '<p class="muted small">Free-form assistant (agent mode) is disabled in config; command shortcuts still work.</p>';
  return `
  <script>window.__LINEAR_WS__=${JSON.stringify(ctx.config.sources.linear.workspace)};</script>
  <section class="chat-wrap" data-role="${escapeHtml(ctx.role)}">
    <aside class="chat-sessions card">
      <div class="card-head"><h2>Chats</h2><button type="button" id="chat-new">New</button></div>
      <ul class="chat-session-list" id="chat-session-list"><li class="muted small">Loading…</li></ul>
    </aside>
    <div class="chat-main card">
      <div class="chat-head">
        <div><h2 id="chat-title">Console assistant</h2><p class="muted small">${escapeHtml(roleHint)}</p>
        <ul class="muted small chat-hint-list">
          <li><code>plan</code> — 生成今日安排（可追加说明：<code>plan：今天优先做X</code>）</li>
          <li><code>review</code> — 生成今日复盘 · <code>weekly</code> — 周复盘</li>
          <li><code>biweekly</code> — 双周复盘（可追加：<code>biweekly：本期上下文</code>）</li>
          <li>复盘后写回飞书周表：<code>写回预览</code> 先看内容 → <code>确认写回</code> 才写入</li>
          <li>复盘后写回本地 OKR 进度：<code>okr writeback</code> 先看增量 → <code>确认写回 okr</code> 才写入</li>
        </ul></div>
        <a class="top-link" href="/console#guide">使用指南</a>
      </div>
      ${agentHint}
      <div class="chat-stream" id="chat-stream"><p class="muted small">Start a new chat or pick one on the left.</p></div>
      <form class="chat-composer" id="chat-composer">
        <textarea id="chat-input" rows="2" placeholder="直接发关键词：plan / review / weekly / progress / status，或 daily-os 记到 todo：…" autocomplete="off"></textarea>
        <div class="chat-composer-actions">
          <button type="submit" id="chat-send">Send</button>
          <button type="button" id="chat-stop" class="danger" hidden>Stop</button>
        </div>
      </form>
    </div>
  </section>
  <script>${CHAT_JS}</script>`;
}

const CHAT_JS = String.raw`
(function(){
  var sessionId=null;
  var sending=false;
  var controller=null;
  var list=document.getElementById('chat-session-list');
  var stream=document.getElementById('chat-stream');
  var input=document.getElementById('chat-input');
  var form=document.getElementById('chat-composer');
  var sendBtn=document.getElementById('chat-send');
  var stopBtn=document.getElementById('chat-stop');
  var newBtn=document.getElementById('chat-new');
  function esc(s){var d=document.createElement('div');d.textContent=s==null?'':String(s);return d.innerHTML;}
  var LINEAR_WS=window.__LINEAR_WS__||'';
  function linkify(html){
    if(!LINEAR_WS)return html;
    return html.replace(/\b([A-Z][A-Z0-9]{1,9}-\d+)\b/g,function(m,id){
      return '<a href="https://linear.app/'+encodeURIComponent(LINEAR_WS)+'/issue/'+id+'" target="_blank" rel="noopener">'+id+'</a>';
    });
  }
  function api(url,opts){return fetch(url,Object.assign({credentials:'same-origin'},opts||{}));}
  function bubble(role,text){
    var el=document.createElement('div');
    el.className='chat-msg role-'+role;
    el.innerHTML='<span class="who">'+esc(role)+'</span><div class="body">'+linkify(esc(text))+'</div>';
    stream.appendChild(el);stream.scrollTop=stream.scrollHeight;
    return el.querySelector('.body');
  }
  function clearStream(){stream.innerHTML='';}
  function loadSessions(){
    return api('/api/chat/sessions').then(function(r){return r.json();}).then(function(d){
      var items=(d&&d.sessions)||[];
      if(!items.length){list.innerHTML='<li class="muted small">No chats yet.</li>';return;}
      list.innerHTML=items.map(function(s){
        return '<li class="chat-session'+(s.id===sessionId?' active':'')+'" data-id="'+esc(s.id)+'">'+
          '<span class="s-title">'+esc(s.title)+'</span>'+
          '<span class="muted small">'+esc(s.messages)+' msg</span>'+
          '<button type="button" class="chat-session-delete" data-del="'+esc(s.id)+'" title="Delete chat">×</button></li>';
      }).join('');
    });
  }
  function deleteSession(id){
    if(!window.confirm('删除这个会话？'))return;
    api('/api/chat/session/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({session:id})})
      .then(function(){
        if(id===sessionId){sessionId=null;stream.innerHTML='<p class="muted small">Start a new chat or pick one on the left.</p>';}
        return loadSessions();
      });
  }
  function openSession(id){
    sessionId=id;
    Array.prototype.forEach.call(list.querySelectorAll('.chat-session'),function(li){
      li.classList.toggle('active',li.getAttribute('data-id')===id);
    });
    clearStream();
    return api('/api/chat/messages?session='+encodeURIComponent(id)).then(function(r){return r.json();}).then(function(d){
      var msgs=(d&&d.messages)||[];
      if(!msgs.length){bubble('system','Empty chat. Say hello or run a command.');return;}
      msgs.forEach(function(m){bubble(m.role,m.content);});
    });
  }
  function setSending(on){
    sending=on;sendBtn.disabled=on;input.disabled=on;stopBtn.hidden=!on;
  }
  function send(text){
    bubble('user',text);
    var target=bubble('assistant','');
    var statusEl=document.createElement('div');statusEl.className='chat-status muted small';target.parentNode.appendChild(statusEl);
    var acc='';
    setSending(true);
    controller=new AbortController();
    api('/api/chat/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({session:sessionId,text:text}),signal:controller.signal})
      .then(function(res){
        var resolvedSession=res.headers.get('x-chat-session-id');
        if(resolvedSession){sessionId=resolvedSession;}
        if(res.status===403){return res.json().then(function(d){target.textContent='拒绝：'+((d&&d.error)||'permission denied');throw 'handled';});}
        if(!res.body){return res.text().then(function(t){target.textContent=t;});}
        var reader=res.body.getReader();var dec=new TextDecoder();var buf='';
        function pump(){return reader.read().then(function(res){
          if(res.done){return;}
          buf+=dec.decode(res.value,{stream:true});
          var parts=buf.split('\n\n');buf=parts.pop();
          parts.forEach(function(chunk){
            var line=chunk.split('\n').filter(function(l){return l.indexOf('data:')===0;}).map(function(l){return l.slice(5);}).join('');
            if(!line)return;var ev;try{ev=JSON.parse(line);}catch(e){return;}
            if(ev.type==='status'){statusEl.textContent=ev.message;}
            else if(ev.type==='reply'){acc+=(acc?'\n\n':'')+ev.content;target.innerHTML=linkify(esc(acc));}
            else if(ev.type==='denied'){acc=ev.message;target.textContent=ev.message;}
            else if(ev.type==='error'){acc=ev.message;target.textContent='错误：'+ev.message;}
            else if(ev.type==='stopped'){statusEl.textContent='已停止。';}
            stream.scrollTop=stream.scrollHeight;
          });
          return pump();
        });}
        return pump();
      })
      .then(function(){statusEl.remove();})
      .catch(function(e){if(e!=='handled'){if(controller&&controller.signal.aborted){statusEl.textContent='已停止。';}else{target.textContent='连接中断：'+String(e);}}})
      .then(function(){setSending(false);controller=null;loadSessions();});
  }
  form.addEventListener('submit',function(ev){ev.preventDefault();if(sending)return;var t=input.value.trim();if(!t)return;input.value='';send(t);});
  // An IME sends Enter to accept the highlighted candidate. Without the
  // composing guard that keypress submitted a half-typed message — hitting
  // anyone typing Chinese, every time they picked a candidate. isComposing is
  // the standard signal; keyCode 229 is the older browsers equivalent, and the
  // composing flag covers the gap between compositionstart and the first keydown.
  // (No backticks in here: this block lives inside a JS template literal.)
  var composing=false;
  input.addEventListener('compositionstart',function(){composing=true;});
  input.addEventListener('compositionend',function(){composing=false;});
  input.addEventListener('keydown',function(ev){
    if(ev.key!=='Enter'||ev.shiftKey)return;
    if(composing||ev.isComposing||ev.keyCode===229)return;
    ev.preventDefault();
    form.dispatchEvent(new Event('submit',{cancelable:true}));
  });
  stopBtn.addEventListener('click',function(){
    if(controller)controller.abort();
    if(sessionId)api('/api/chat/stop',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({session:sessionId})});
  });
  newBtn.addEventListener('click',function(){
    api('/api/chat/session',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})
      .then(function(r){return r.json();}).then(function(d){if(d&&d.session){return loadSessions().then(function(){return openSession(d.session.id);});}});
  });
  list.addEventListener('click',function(ev){
    var del=ev.target.closest('.chat-session-delete');
    if(del){ev.stopPropagation();deleteSession(del.getAttribute('data-del'));return;}
    var li=ev.target.closest('.chat-session');if(li)openSession(li.getAttribute('data-id'));
  });
  loadSessions().then(function(){
    var first=list.querySelector('.chat-session');
    if(first){openSession(first.getAttribute('data-id'));}
  });
})();
`;

// --- cycles (LEO-286) -------------------------------------------------------

/**
 * The Cycles page: my own cycles on the left, one selected cycle rendered as
 * three cards on the right.
 *
 * It used to be a section of the config console. It is not configuration — it is
 * the place the user reads and writes their own biweekly priorities, retro and
 * review — so it lives here, next to Today, with the same top nav as every other
 * platform page.
 *
 * The markup below is the full, static skeleton: the three cards, the read-only
 * banner, the frontmatter warning and the zoom dialog all exist in the DOM from
 * the first byte, and the client script only fills them in. That is deliberate:
 * "a teammate's card has no save control" is then an assertable property of real
 * elements (`hidden` / `disabled`) rather than of a string of generated HTML.
 */
function renderCyclesPage(ctx: PageContext): string {
  // Pulling teammates is a write against the remote and is admin-only server
  // side; offering a button that always 403s to members would be a lie.
  const syncButton =
    ctx.role === 'admin'
      ? '<button type="button" class="secondary compact" id="cycles-team-sync">同步队友</button>'
      : '';
  const cards = [
    { key: 'priorities', title: '要务', placeholder: '- **MIT** 这个周期最重要的一件事', save: '保存要务' },
    { key: 'retro', title: 'retro', placeholder: '这个周期实际发生了什么、哪里没做到', save: '保存 retro' },
    { key: 'review', title: 'review', placeholder: '对这个周期的评价与下一步建议', save: '保存 review' },
  ]
    .map(
      (card) => `
      <section class="card cycle-card" id="cycle-card-${card.key}" aria-labelledby="cycle-title-${card.key}">
        <div class="card-head">
          <div>
            <h3 id="cycle-title-${card.key}">${escapeHtml(card.title)}<span class="tag" id="cycle-template-${card.key}" hidden>模板</span></h3>
            <p class="muted small" id="cycle-meta-${card.key}"></p>
          </div>
          <div class="cycle-head-actions">
            <button type="button" class="secondary compact" data-cycle-mode="${card.key}" id="cycle-mode-${card.key}">编辑</button>
          </div>
        </div>
        <div class="cycle-read" id="cycle-read-${card.key}" hidden></div>
        <textarea id="cycle-md-${card.key}" spellcheck="false" placeholder="${escapeHtml(card.placeholder)}"></textarea>
        <div class="cycle-card-actions" id="cycle-actions-${card.key}">
          ${card.key === 'review' ? '<button type="button" class="secondary" id="cycle-generate-review">用 AI 生成 review</button>' : ''}
          <button type="button" id="cycle-save-${card.key}" data-cycle-save="${card.key}">${escapeHtml(card.save)}</button>
        </div>
        <p class="muted small" id="cycle-status-${card.key}"></p>
      </section>`,
    )
    .join('');

  return `
  <section class="cycles-wrap">
    <aside class="cycles-side">
      <section class="card">
        <div class="card-head"><h2>我的周期</h2><button type="button" class="secondary compact" id="cycles-refresh">Refresh</button></div>
        <p class="muted small mono" id="cycles-dir"></p>
        <div class="cycle-list" id="cycle-list"></div>
        <p class="muted small" id="cycles-empty" hidden>还没有任何周期文件。跑一次双周复盘（<code>npm run weekly</code>）之后，周期目录里会出现 <code>&lt;开始日期&gt;_&lt;周期标签&gt;.md</code>，例如 <code>2026-08-24_8.24-9.6.md</code>。也可以先手动建一个同名文件，再点 Refresh。</p>
      </section>
      <section class="card">
        <div class="card-head"><h2>团队成员</h2>${syncButton}</div>
        <div class="cycle-list" id="cycle-members"></div>
        <p class="muted small" id="cycle-team-status"></p>
      </section>
    </aside>
    <div class="cycles-main">
      <section class="card">
        <div class="card-head">
          <div><h2 id="cycle-heading">周期</h2><p class="muted small" id="cycle-subheading"></p></div>
        </div>
        <p class="muted small mono" id="cycle-file-path"></p>
        <div class="cycle-readonly" id="cycle-readonly" role="status" hidden></div>
        <div class="cycle-warning" id="cycle-frontmatter-error" role="alert" hidden></div>
      </section>
      <div class="cycle-cards" id="cycle-cards">${cards}</div>
      <p class="muted" id="cycle-detail-empty" hidden>左边挑一个周期，或者点一位队友看他们最新的周期。</p>
    </div>
  </section>
  <script>window.__LINEAR_WS__=${JSON.stringify(ctx.config.sources.linear.workspace)};</script>
  <script>${CYCLES_JS}</script>`;
}

/**
 * Client script for /cycles. Top-level (not an IIFE) on purpose: the regression
 * suite evaluates this exact string against a DOM stub, which is the only way to
 * prove that a teammate's card really has no reachable save control.
 * `CONSOLE_JS` keeps its own scope, so nothing here collides with it.
 */
export const CYCLES_JS = String.raw`
// Slug <-> markdown heading. '要务' is a poor element id, so the page keys
// everything by slug and maps back at the API boundary.
var CYCLE_SECTION_KEYS = [['priorities', '要务'], ['retro', 'retro'], ['review', 'review']];
// The writing prompts, kept here as well as in the markup: a teammate's empty
// section must not tell me what to write in it.
var CYCLE_PLACEHOLDERS = {
  priorities: '- **MIT** 这个周期最重要的一件事',
  retro: '这个周期实际发生了什么、哪里没做到',
  review: '对这个周期的评价与下一步建议',
};
// The Feishu retro layout, pre-filled into an empty retro so writing one here
// produces the same three sections life-review-os parses back out. Interpolated
// from RETRO_TEMPLATE rather than restated, so the scaffold and the parser
// contract have one source.
var CYCLE_RETRO_TEMPLATE = ${JSON.stringify(RETRO_TEMPLATE)};
var cyclesData = { cycles: { dir: '', items: [] }, team: null };
// Unsaved typing, keyed by cycle id + section slug. Re-filling a section someone
// is halfway through writing would eat a hand-written retro — the one thing this
// page must never do. Keying by cycle rather than by section alone extends that
// to switching cycles: click another one and come back, and the draft is still
// there. Only Refresh discards.
var cycleDrafts = new Map();
var selectedCycleId = '';
// Whose cycles the page shows: '' is me, otherwise a teammate's owner uuid.
// Uuid, never member_id — the label is renameable and the cache is not filed
// under it.
var selectedOwnerId = '';
// Selected cycle per owner, so switching to a teammate and back lands on the
// cycle you were reading — and, because drafts are keyed by cycle id, on your
// unsaved text as well.
var selectedCycleByOwner = new Map();
// Sections the user has explicitly switched, slug -> 'read' | 'edit'.
//
// Only explicit choices go in here. A section nobody has touched defaults per
// cycle: read when it has something to read, edit when it is empty. Storing the
// auto-default too would make one empty section sticky — open a cycle whose
// review is blank, and every cycle after it would show raw markdown.
var cycleModes = new Map();

function cycleModeFor(key, hasContent) {
  if (cycleModes.has(key)) return cycleModes.get(key);
  // A pre-filled retro scaffold counts as text but not as content: reading an
  // empty template is pointless, and typing into it is the only reason it is
  // there. Anything actually written opens for reading.
  if (key === 'retro' && cycleTemplatedNow) return 'edit';
  return hasContent ? 'read' : 'edit';
}

// Whether the retro currently in the textarea is the untouched scaffold. Set by
// the render pass, which is the only place that knows.
var cycleTemplatedNow = false;

function cycleEl(id) { return document.getElementById(id); }
function cycleSetText(id, text) { var el = cycleEl(id); if (el) el.textContent = text; }
function cycleSetValue(id, text) { var el = cycleEl(id); if (el) el.value = text == null ? '' : text; }
function cycleValue(id) { var el = cycleEl(id); return el ? el.value : ''; }
function cycleEscapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function cycleTime(value) {
  var date = new Date(value);
  return isNaN(date.getTime()) ? (value || '') : date.toLocaleString();
}

// --- read mode ---------------------------------------------------------------
//
// These sections are markdown in a fixed shape, not free-form documents, so a
// full markdown parser would be both overkill and a liability. What matters is
// that every input line ends up somewhere in the output: a section that fails
// to match its expected shape falls back to plain paragraphs rather than
// rendering empty. Losing a line of someone's retro to a parser is worse than
// showing it unstyled.

/** Inline: **bold**, and a bare Linear id becomes a link. */
function cycleInline(text) {
  var html = cycleEscapeHtml(text);
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  var ws = (typeof window !== 'undefined' && window.__LINEAR_WS__) || '';
  html = html.replace(/\b([A-Z][A-Z0-9]*-\d+)\b/g, function (match, id) {
    var href = ws
      ? 'https://linear.app/' + encodeURIComponent(ws) + '/issue/' + encodeURIComponent(id)
      : 'https://linear.app/issue/' + encodeURIComponent(id);
    return '<a class="tag tag-link" href="' + href + '" target="_blank" rel="noopener">' + id + '</a>';
  });
  return html;
}

function cycleParagraphs(lines) {
  var out = '';
  for (var i = 0; i < lines.length; i += 1) {
    var line = lines[i].trim();
    if (line) out += '<p>' + cycleInline(line) + '</p>';
  }
  return out;
}

/**
 * Per-item completion, stored in the line itself.
 *
 * These are the markers life-review-os already reads: it counts ✅ as done and
 * treats ⭕ / ❌ / 🚧 as still open, and the Feishu cells have used them by hand
 * for years. Inventing a fourth notation would mean the planner could no longer
 * tell what got finished, so 部分 reuses 🚧 — which is exactly what it means,
 * and which that parser already files under "not finished".
 */
var CYCLE_TASK_STATUSES = [
  { key: 'done', marker: '✅', label: '完成' },
  { key: 'partial', marker: '🚧', label: '部分' },
  { key: 'missed', marker: '❌', label: '未做' },
];
// ⭕ is accepted on read because older hand-written cells use it, but it is
// never written — one marker per state keeps round-tripping stable.
var CYCLE_STATUS_READ = { '✅': 'done', '🚧': 'partial', '❌': 'missed', '⭕': 'missed', '⭕️': 'missed' };
// The unicode flag is load-bearing: 🚧 is a surrogate pair, and without it the
// character class matches its two halves separately — so a line marked 部分
// read back as unmarked, while stripping it still happened to work.
var CYCLE_STATUS_PATTERN = /[✅🚧❌⭕️⭕]/gu;

function cycleTaskStatus(text) {
  var found = String(text).match(CYCLE_STATUS_PATTERN);
  return found ? CYCLE_STATUS_READ[found[found.length - 1]] || '' : '';
}

function cycleStripStatus(text) {
  return String(text).replace(CYCLE_STATUS_PATTERN, '').replace(/\s{2,}/g, ' ').trim();
}

/**
 * Rewrite one source line to carry the given status ('' clears it).
 *
 * The marker goes at the end, which is where the Feishu cells put it and where
 * life-review-os's own writeback appends it.
 */
function cycleSetLineStatus(line, status) {
  var indent = (line.match(/^\s*/) || [''])[0];
  var body = cycleStripStatus(line);
  if (!status) return indent + body;
  for (var i = 0; i < CYCLE_TASK_STATUSES.length; i += 1) {
    if (CYCLE_TASK_STATUSES[i].key === status) return indent + body + ' ' + CYCLE_TASK_STATUSES[i].marker;
  }
  return indent + body;
}

/** 要务: "### OKR row" groups of "- item", with **MIT** lifted into a badge. */
function cycleRenderPriorities(text) {
  var lines = String(text).split('\n');
  var groups = [];
  var current = null;
  var loose = [];
  for (var i = 0; i < lines.length; i += 1) {
    var line = lines[i].trim();
    if (!line) continue;
    var heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      current = { title: heading[1], items: [] };
      groups.push(current);
      continue;
    }
    var bullet = line.match(/^[-*+]\s+(.*)$/);
    // The source line index travels with the item: a status click has to
    // rewrite the line it came from, and matching on text would pick the wrong
    // one as soon as two items read the same.
    var item = { text: bullet ? bullet[1] : line, line: i };
    if (current) current.items.push(item);
    else loose.push(item);
  }
  if (groups.length === 0 && loose.length === 0) return '';

  var html = loose.length ? '<ul class="cy-tasks">' + cycleTaskItems(loose) + '</ul>' : '';
  for (var g = 0; g < groups.length; g += 1) {
    html += '<div class="cy-group"><h4 class="cy-group-title">' + cycleInline(groups[g].title) + '</h4>';
    html += groups[g].items.length
      ? '<ul class="cy-tasks">' + cycleTaskItems(groups[g].items) + '</ul>'
      : '<p class="muted small">这一行下没有条目。</p>';
    html += '</div>';
  }
  return html;
}

function cycleTaskItems(items) {
  var html = '';
  for (var i = 0; i < items.length; i += 1) {
    var text = items[i].text;
    var status = cycleTaskStatus(text);
    // MIT is emphasis in the file and a badge here; strip it wherever it sits
    // so it cannot show up twice. Same for the status marker, which becomes the
    // dots rather than staying in the sentence.
    var mit = /\*\*MIT\*\*|(^|\s)MIT(\s|$)/.test(text);
    var body = cycleStripStatus(text.replace(/\*\*MIT\*\*/g, '').replace(/(^|\s)MIT(?=\s|$)/g, '$1'));
    var dots = '';
    for (var d = 0; d < CYCLE_TASK_STATUSES.length; d += 1) {
      var def = CYCLE_TASK_STATUSES[d];
      var on = status === def.key;
      dots += '<button type="button" class="cy-dot cy-dot-' + def.key + (on ? ' on' : '') +
        '" data-cycle-task="' + items[i].line + '" data-cycle-status="' + (on ? '' : def.key) +
        '" aria-pressed="' + (on ? 'true' : 'false') + '" title="' + def.label + (on ? '（再点一次取消）' : '') + '">' +
        '<span class="sr-only">' + def.label + '</span></button>';
    }
    html += '<li class="cy-task cy-task-' + (status || 'none') + '"><span class="cy-dots">' + dots + '</span>' +
      (mit ? '<span class="cy-badge">MIT</span>' : '') + '<span>' + cycleInline(body) + '</span></li>';
  }
  return html;
}

// The same three headings life-review-os splits a retro on. Kept loose about the
// emoji and about 做得好 / 做的好 for exactly the reason it is: both spellings
// are in the real files.
//
// The character class has to admit more than Extended_Pictographic. The real
// files use 👍🏻 and 💪🏻, and a skin-tone modifier (U+1F3FB) is Emoji_Modifier,
// not Extended_Pictographic — so matching only the latter recognised 😄状态 and
// silently swallowed the other two sections into it.
var CYCLE_EMOJI_PREFIX = '^\\s*[\\p{Extended_Pictographic}\\p{Emoji_Modifier}\\uFE0F\\u200D]*\\s*';
var CYCLE_RETRO_HEADINGS = [
  { key: 'status', label: '状态', icon: '😄', test: new RegExp(CYCLE_EMOJI_PREFIX + '状态\\s*[:：]?\\s*$', 'u') },
  { key: 'good', label: '做的好', icon: '👍🏻', test: new RegExp(CYCLE_EMOJI_PREFIX + '做[得的]好\\s*[:：]?\\s*$', 'u') },
  { key: 'improve', label: '待改进', icon: '💪🏻', test: new RegExp(CYCLE_EMOJI_PREFIX + '待改进\\s*[:：]?\\s*$', 'u') },
];

/** retro: the Feishu column layout — three sections, with 状态 as field rows. */
function cycleRenderRetro(text) {
  var lines = String(text).split('\n');
  var sections = [];
  var current = null;
  var preamble = [];
  for (var i = 0; i < lines.length; i += 1) {
    var line = lines[i];
    var matched = null;
    for (var h = 0; h < CYCLE_RETRO_HEADINGS.length; h += 1) {
      if (CYCLE_RETRO_HEADINGS[h].test.test(line)) { matched = CYCLE_RETRO_HEADINGS[h]; break; }
    }
    if (matched) {
      current = { def: matched, lines: [] };
      sections.push(current);
      continue;
    }
    if (current) current.lines.push(line);
    else preamble.push(line);
  }
  // No recognised heading at all: this retro predates the template, or was
  // written free-form. Show it rather than showing nothing.
  if (sections.length === 0) return cycleParagraphs(lines);

  var html = cycleParagraphs(preamble);
  for (var s = 0; s < sections.length; s += 1) {
    var section = sections[s];
    html += '<div class="cy-retro-section"><h4 class="cy-group-title">' + section.def.icon + ' ' + cycleEscapeHtml(section.def.label) + '</h4>';
    html += section.def.key === 'status' ? cycleRenderStatus(section.lines) : cycleParagraphs(section.lines);
    html += '</div>';
  }
  return html;
}

/**
 * The 状态 block is "情绪：正常" style field lines plus free text. A field whose
 * value is empty is still shown: an unanswered 精力 is information.
 */
function cycleRenderStatus(lines) {
  var rows = '';
  var rest = [];
  for (var i = 0; i < lines.length; i += 1) {
    var line = lines[i].trim();
    if (!line) continue;
    var field = line.match(/^([^:：]{1,14})[:：]\s*(.*)$/);
    if (field && !/[。！？]/.test(field[1])) {
      var value = field[2].trim();
      rows += '<div class="cy-field"><dt>' + cycleEscapeHtml(field[1].trim()) + '</dt><dd>' +
        (value ? cycleInline(value) : '<span class="muted">（未填）</span>') + '</dd></div>';
      continue;
    }
    rest.push(line);
  }
  return (rows ? '<dl class="cy-fields">' + rows + '</dl>' : '') + cycleParagraphs(rest);
}

/** Render one section for reading. '' means "nothing to show". */
function cycleRenderSection(key, text) {
  var value = String(text == null ? '' : text).trim();
  if (!value) return '';
  if (key === 'priorities') return cycleRenderPriorities(value) || cycleParagraphs(value.split('\n'));
  if (key === 'retro') return cycleRenderRetro(value);
  return cycleParagraphs(value.split('\n'));
}
function cycleSectionName(key) {
  for (var i = 0; i < CYCLE_SECTION_KEYS.length; i += 1) if (CYCLE_SECTION_KEYS[i][0] === key) return CYCLE_SECTION_KEYS[i][1];
  return '';
}
function cycleToast(message) {
  var el = cycleEl('toast');
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
  setTimeout(function () { el.hidden = true; }, 2600);
}

/** Newest start date first; ties fall back to the id, which starts with it. */
function sortCycles(items) {
  return (items || []).slice().sort(function (left, right) {
    var a = (left && left.startDate) || '';
    var b = (right && right.startDate) || '';
    if (a !== b) return a < b ? 1 : -1;
    var la = (left && left.id) || '';
    var lb = (right && right.id) || '';
    return la < lb ? 1 : la > lb ? -1 : 0;
  });
}

function cycleMemberById(ownerId) {
  var members = (cyclesData.team && cyclesData.team.members) || [];
  for (var i = 0; i < members.length; i += 1) if (members[i].userId === ownerId) return members[i];
  return null;
}

function loadCycles() {
  return fetch('/api/cycles/state', { credentials: 'same-origin' })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (!d || d.ok === false) throw new Error((d && d.error) || 'failed');
      cyclesData = { cycles: d.cycles || { dir: '', items: [] }, team: d.team || null };
      renderCyclesPage();
    })
    .catch(function (error) { cycleSetText('cycle-team-status', '读取周期失败：' + String(error)); });
}

function renderCyclesPage() {
  var team = cyclesData.team;
  renderCycleMembers(team);
  renderCycleTeamStatus(team);

  // A teammate who is no longer in the state (signed out, cache cleared, team
  // changed) falls back to my own cycles instead of rendering a blank page.
  var member = selectedOwnerId ? cycleMemberById(selectedOwnerId) : null;
  if (selectedOwnerId && !member) { selectedOwnerId = ''; member = null; }
  var viewingSelf = !selectedOwnerId;

  var mine = sortCycles((cyclesData.cycles && cyclesData.cycles.items) || []);
  // A teammate view is their *latest* cycle only: it answers "what are they on
  // right now", and their older files are not mine to browse through here.
  var items = viewingSelf ? mine : sortCycles(member.cycles || []).slice(0, 1);

  var dir = cyclesData.cycles && cyclesData.cycles.dir;
  cycleSetText('cycles-dir', viewingSelf ? (dir ? '周期目录：' + dir : '') : '');
  var emptyMine = cycleEl('cycles-empty');
  if (emptyMine) emptyMine.hidden = mine.length > 0;

  var cards = cycleEl('cycle-cards');
  var detailEmpty = cycleEl('cycle-detail-empty');
  if (items.length === 0) {
    selectedCycleId = '';
    if (cards) cards.hidden = true;
    if (detailEmpty) {
      detailEmpty.hidden = false;
      detailEmpty.textContent = viewingSelf
        ? '还没有周期文件可以显示。'
        : '还没有同步到 ' + ((member && member.label) || '这位队友') + ' 的周期。'
          + (team && team.syncedAt
            ? '上次同步于 ' + cycleTime(team.syncedAt) + '，那时对方还没有写过任何周期文件。'
            : '还没有成功同步过。确认双方都已登录同一个团队，再点「同步队友」。');
    }
    cycleSetText('cycle-heading', viewingSelf ? '周期' : ((member && member.label) || '队友'));
    cycleSetText('cycle-subheading', '');
    cycleSetText('cycle-file-path', '');
    var banner = cycleEl('cycle-readonly');
    if (banner) { banner.hidden = viewingSelf; banner.textContent = viewingSelf ? '' : '只读'; }
    var warn = cycleEl('cycle-frontmatter-error');
    if (warn) warn.hidden = true;
    renderCycleList(mine, viewingSelf);
    return;
  }
  if (cards) cards.hidden = false;
  if (detailEmpty) detailEmpty.hidden = true;

  // Newest cycle by default, and keep the current pick across re-renders.
  var picked = null;
  for (var i = 0; i < items.length; i += 1) if (items[i].id === selectedCycleId) picked = items[i];
  if (!picked) { picked = items[0]; selectedCycleId = picked.id; }
  selectedCycleByOwner.set(selectedOwnerId, selectedCycleId);
  renderCycleList(mine, viewingSelf);
  renderCycleDetail(picked, member, team);
}

function renderCycleList(items, viewingSelf) {
  var list = cycleEl('cycle-list');
  if (!list) return;
  list.innerHTML = items.map(function (item) {
    var active = viewingSelf && item.id === selectedCycleId;
    var broken = item.frontmatterError ? '<span class="cycle-item-broken">frontmatter 解析失败</span>' : '';
    var updated = item.updatedAt ? '更新于 ' + cycleTime(item.updatedAt) : '未记录更新时间';
    return '<button type="button" class="cycle-item' + (active ? ' active' : '') + '"' +
      ' data-cycle-id="' + cycleEscapeHtml(item.id) + '"' + (active ? ' aria-current="true"' : '') + '>' +
      '<strong>' + cycleEscapeHtml(item.cycle || item.id) + '</strong>' +
      '<span>' + cycleEscapeHtml(item.startDate + ' · ' + (item.mode || '')) + '</span>' +
      '<span>' + cycleEscapeHtml(updated) + '</span>' + broken +
      '</button>';
  }).join('');
}

function renderCycleMembers(team) {
  var box = cycleEl('cycle-members');
  if (!box) return;
  var members = (team && team.members) || [];
  var ready = Boolean(team && team.status === 'ready' && members.length > 0);
  if (!ready) {
    selectedOwnerId = '';
    box.innerHTML = '<p class="muted small">还没有队友的周期可以看。</p>';
    return;
  }
  var selfLabel = (team.self && (team.self.displayName || team.self.memberId)) || '';
  var html = '<button type="button" class="cycle-item cycle-member' + (selectedOwnerId ? '' : ' active') + '" data-owner-id="">' +
    '<strong>' + cycleEscapeHtml(selfLabel ? '我（' + selfLabel + '）' : '我') + '</strong>' +
    '<span>本地 20_CYCLES</span></button>';
  members.forEach(function (member) {
    var cycles = member.cycles || [];
    var latest = sortCycles(cycles)[0];
    html += '<button type="button" class="cycle-item cycle-member' + (member.userId === selectedOwnerId ? ' active' : '') + '"' +
      ' data-owner-id="' + cycleEscapeHtml(member.userId) + '">' +
      '<strong>' + cycleEscapeHtml(member.label || member.userId) + '</strong>' +
      '<span>' + cycleEscapeHtml(latest ? '最新 ' + (latest.cycle || latest.id) : '还没有同步到周期') + '</span>' +
      '<span>只读</span></button>';
  });
  box.innerHTML = html;
}

function renderCycleTeamStatus(team) {
  var line = cycleEl('cycle-team-status');
  if (!line) return;
  if (!team) { line.textContent = ''; return; }
  // Not-ready is a normal state, not a failure: local editing is unaffected, so
  // say what is off rather than showing an error.
  if (team.status !== 'ready') { line.textContent = '团队同步：' + (team.reason || '未启用'); return; }
  var parts = [team.syncedAt ? '同步于 ' + cycleTime(team.syncedAt) : '还没有成功同步过'];
  if (!(team.members || []).length) parts.push('团队里还没有其他成员');
  if (team.lastError) parts.push('上次同步失败：' + team.lastError);
  line.textContent = '团队同步：' + parts.join(' · ');
}

function renderCycleDetail(item, member, team) {
  if (!item) return;
  var readOnly = Boolean(member);
  cycleSetText('cycle-heading', (item.cycle || item.id) + (readOnly ? ' · ' + ((member && member.label) || '队友') : ''));
  cycleSetText('cycle-subheading', item.startDate + ' 开始 · ' + (item.mode || '') + (item.updatedAt ? ' · 更新于 ' + cycleTime(item.updatedAt) : ''));
  // Where the bytes on screen actually came from: my vault, or the read-only
  // teammate cache. Never nothing — "whose file is this" is the question the
  // page has to keep answering.
  cycleSetText('cycle-file-path', readOnly
    ? (team && team.cacheDir ? '只读缓存：' + team.cacheDir + '/' + selectedOwnerId : '')
    : (item.path || ''));

  var banner = cycleEl('cycle-readonly');
  if (banner) {
    banner.hidden = !readOnly;
    banner.textContent = readOnly
      ? '来自 ' + ((member && member.label) || '队友') + ' · 只读 · ' +
        (team && team.syncedAt ? '同步于 ' + cycleTime(team.syncedAt) : '同步时间未知')
      : '';
  }

  // A file whose frontmatter will not parse is read-only here: the write path
  // refuses it, so letting someone type a full retro first would just lose it.
  var broken = Boolean(item.frontmatterError);
  var warning = cycleEl('cycle-frontmatter-error');
  if (warning) {
    warning.hidden = !broken;
    warning.textContent = broken
      ? 'frontmatter 无法解析（' + item.frontmatterError + '）。保存已禁用：写回会丢掉整段 frontmatter。请先用编辑器修好 ' + (item.path || '这个文件') + ' 里的 YAML，再回来点 Refresh。'
      : '';
  }

  CYCLE_SECTION_KEYS.forEach(function (pair) {
    var key = pair[0];
    var stored = item.sections ? item.sections[pair[1]] : null;
    var draftKey = item.id + '::' + key;
    // Drafts belong to my own files only, so a teammate view always shows what
    // was synced, never something I happened to have typed under the same id.
    var content = stored ? stored.content || '' : '';
    // An empty retro of my own starts from the Feishu scaffold. Only when it is
    // genuinely empty and undrafted: pre-filling over a draft or over a
    // teammate's synced text would be the one thing this page must never do.
    var templated = key === 'retro' && !readOnly && !cycleDrafts.has(draftKey) && !content.trim();
    if (!readOnly && cycleDrafts.has(draftKey)) cycleSetValue('cycle-md-' + key, cycleDrafts.get(draftKey));
    else cycleSetValue('cycle-md-' + key, templated ? CYCLE_RETRO_TEMPLATE : content);
    var templateTag = cycleEl('cycle-template-' + key);
    if (templateTag) templateTag.hidden = !templated;
    if (key === 'retro') cycleTemplatedNow = templated;
    // A missing key and an empty string mean different things: never written vs.
    // written and then cleared.
    cycleSetText('cycle-meta-' + key, stored
      ? '来源 ' + (stored.source || 'unknown') + ' · ' + (stored.updatedAt ? '更新于 ' + cycleTime(stored.updatedAt) : '未记录更新时间')
      : '这一段还没写过（文件里没有这个小节）');
    var textarea = cycleEl('cycle-md-' + key);
    // readonly rather than disabled for a teammate: the text still has to be
    // selectable and scrollable, it just cannot be changed.
    if (textarea) {
      textarea.disabled = broken;
      textarea.readOnly = readOnly;
      textarea.placeholder = readOnly ? '（这一段是空的）' : CYCLE_PLACEHOLDERS[key];
    }
    var button = cycleEl('cycle-save-' + key);
    if (button) button.disabled = broken || readOnly;
    // The whole action row goes away in a teammate view, so there is no save
    // control to click at all. The server rejects the write regardless.
    var actions = cycleEl('cycle-actions-' + key);
    if (actions) actions.hidden = readOnly;
    applyCycleMode(key);
  });
  var generate = cycleEl('cycle-generate-review');
  // Generating a review rewrites a section of a file, so it is offered only for
  // my own cycles, and only when that file can be written at all.
  if (generate) generate.disabled = broken || readOnly || !selectedCycleId;
}

/**
 * Show either the rendered view or the textarea for one section.
 *
 * The read view is built from the textarea's *current* value rather than from
 * the stored section, so switching to it mid-edit shows what would be saved,
 * not what is on disk.
 */
function applyCycleMode(key) {
  var textarea = cycleEl('cycle-md-' + key);
  var read = cycleEl('cycle-read-' + key);
  var toggle = cycleEl('cycle-mode-' + key);
  var value = textarea ? textarea.value : '';
  var rendered = cycleRenderSection(key, value);
  var mode = cycleModeFor(key, Boolean(value.trim()));
  if (mode === 'read' && !rendered) mode = 'edit';
  if (read) {
    read.hidden = mode !== 'read';
    if (mode === 'read') read.innerHTML = rendered;
  }
  if (textarea) textarea.hidden = mode === 'read';
  // The save row is hidden for a teammate, and while reading — with one
  // exception: ticking a 要务 status is an edit made from the reading view, so
  // once there is something unsaved the control has to come back or the change
  // has nowhere to go.
  var actions = cycleEl('cycle-actions-' + key);
  var readOnlyHere = textarea ? textarea.readOnly : false;
  if (actions) actions.hidden = readOnlyHere || (mode === 'read' && !cycleSectionDirty(key));
  if (toggle) {
    toggle.textContent = mode === 'read' ? '编辑' : '阅读';
    // Nothing to read yet, so the toggle would only bounce back.
    toggle.disabled = !rendered;
  }
}

/** Has this section been changed since it was last read from disk? */
function cycleSectionDirty(key) {
  if (!selectedCycleId || selectedOwnerId) return false;
  return cycleDrafts.has(selectedCycleId + '::' + key);
}

/**
 * Tick a 要务 item green / yellow / red from the reading view.
 *
 * The click rewrites the markdown line it came from — the source of truth stays
 * the file, not a parallel status store — and leaves the result as an unsaved
 * draft. Nothing is written until 保存要务, the same as any other edit.
 *
 * A saved status also stops the planner from overwriting the section: the save
 * records it as source "user", and applyCyclePlan never clobbers one of those.
 */
function setCycleTaskStatus(lineIndex, status) {
  var textarea = cycleEl('cycle-md-priorities');
  if (!textarea || textarea.readOnly || textarea.disabled) return;
  if (!selectedCycleId || selectedOwnerId) return;
  var index = Number(lineIndex);
  var lines = textarea.value.split('\n');
  if (!(index >= 0 && index < lines.length)) return;
  lines[index] = cycleSetLineStatus(lines[index], status);
  textarea.value = lines.join('\n');
  cycleDrafts.set(selectedCycleId + '::priorities', textarea.value);
  applyCycleMode('priorities');
  cycleSetText('cycle-status-priorities', '已标记，还没保存——点「保存要务」写入文件。');
}

function toggleCycleMode(key) {
  var textarea = cycleEl('cycle-md-' + key);
  var current = cycleModeFor(key, Boolean(textarea && textarea.value.trim()));
  cycleModes.set(key, current === 'read' ? 'edit' : 'read');
  applyCycleMode(key);
}

function selectCycle(id) {
  if (!id) return;
  // Clicking a cycle in "我的周期" is also the way back from a teammate view.
  if (selectedOwnerId) selectedOwnerId = '';
  else if (id === selectedCycleId) return;
  selectedCycleId = id;
  // Drafts survive the switch: they are keyed by cycle, and renderCycleDetail
  // restores this cycle's own. Only Refresh and a successful save clear them.
  clearCycleStatuses();
  renderCyclesPage();
}

function selectCycleOwner(ownerId) {
  var next = ownerId || '';
  if (next === selectedOwnerId) return;
  selectedOwnerId = next;
  selectedCycleId = selectedCycleByOwner.get(next) || '';
  clearCycleStatuses();
  renderCyclesPage();
}

function clearCycleStatuses() {
  CYCLE_SECTION_KEYS.forEach(function (pair) { cycleSetText('cycle-status-' + pair[0], ''); });
}

async function saveCycleSection(key) {
  var statusId = 'cycle-status-' + key;
  var section = cycleSectionName(key);
  if (selectedOwnerId) { cycleSetText(statusId, '队友的周期是只读的，不能在这里保存。'); return; }
  if (!selectedCycleId) { cycleSetText(statusId, '还没有选中任何周期。'); return; }
  cycleSetText(statusId, 'Saving...');
  var response = await fetch('/api/cycles/section', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: selectedCycleId, section: section, content: cycleValue('cycle-md-' + key) }),
  });
  var result = await response.json().catch(function () { return {}; });
  if (!response.ok || result.ok === false) throw new Error(result.error || ('Failed (' + response.status + ')'));
  cycleDrafts.delete(selectedCycleId + '::' + key);
  // The save endpoint answers with the full console state; take the cycles and
  // the team view out of it rather than paying for a second round trip.
  if (result.state) {
    cyclesData = {
      cycles: result.state.cycles || cyclesData.cycles,
      team: (result.state.team && result.state.team.view) || cyclesData.team,
    };
  }
  renderCyclesPage();
  cycleSetText(statusId, (result.savedAt ? cycleTime(result.savedAt) + ' · ' : '') + (result.text || 'Saved.'));
  cycleToast('已保存 ' + section);
}

async function runCycleSave(key) {
  try {
    await saveCycleSection(key);
  } catch (error) {
    var message = error && error.message ? error.message : String(error);
    cycleSetText('cycle-status-' + key, message);
    cycleToast('保存失败：' + message);
  }
}

/**
 * Ask life-review-os to draft the review for the selected cycle.
 *
 * The result lands in the textarea as an unsaved draft, never straight into the
 * file. It is a generated opinion about a cycle the user lived through — they
 * get to read it, edit it and decide, the same as any other section.
 */
async function runCycleReviewGeneration() {
  var button = cycleEl('cycle-generate-review');
  if (!selectedCycleId || selectedOwnerId) return;
  var previous = button ? button.textContent : '';
  if (button) { button.disabled = true; button.textContent = '生成中…'; }
  // #199: no fixed "约 1-2 分钟" promise and no silent deadline. Show a live
  // elapsed counter so a long generation reads as "still working", not "stuck".
  var startedAt = Date.now();
  var tickElapsed = function () {
    var s = Math.round((Date.now() - startedAt) / 1000);
    var mm = Math.floor(s / 60);
    var ss = s % 60;
    var elapsed = mm > 0 ? (mm + '分' + (ss < 10 ? '0' : '') + ss + '秒') : (ss + '秒');
    cycleSetText('cycle-status-review', '正在用 life-review-os 的复盘规则生成…已等待 ' + elapsed + '（长文本可能要几分钟，请耐心等待）');
  };
  tickElapsed();
  var elapsedTimer = window.setInterval(tickElapsed, 1000);
  try {
    const response = await fetch('/api/cycles/review', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: selectedCycleId }),
    });
    const data = await response.json();
    window.clearInterval(elapsedTimer);
    if (!data.ok) throw new Error(data.error || '生成失败');
    cycleModes.set('review', 'edit');
    cycleSetValue('cycle-md-review', data.review || '');
    cycleDrafts.set(selectedCycleId + '::review', data.review || '');
    applyCycleMode('review');
    cycleSetText('cycle-status-review', '已生成 ' + String(data.review || '').length + ' 字，还没保存——看过之后点「保存 review」。');
    cycleToast('review 草稿已生成');
  } catch (error) {
    window.clearInterval(elapsedTimer);
    var message = error && error.message ? error.message : String(error);
    cycleSetText('cycle-status-review', '生成失败：' + message);
    cycleToast('生成失败：' + message);
  } finally {
    window.clearInterval(elapsedTimer);
    if (button) { button.disabled = false; button.textContent = previous || '用 AI 生成 review'; }
  }
}

// --- wiring ------------------------------------------------------------------

if (cycleEl('cycle-list')) cycleEl('cycle-list').addEventListener('click', function (event) {
  var item = event.target.closest ? event.target.closest('[data-cycle-id]') : null;
  if (item) selectCycle(item.dataset.cycleId);
});
if (cycleEl('cycle-members')) cycleEl('cycle-members').addEventListener('click', function (event) {
  var button = event.target.closest ? event.target.closest('[data-owner-id]') : null;
  if (button) selectCycleOwner(button.dataset.ownerId || '');
});
if (cycleEl('cycle-cards')) cycleEl('cycle-cards').addEventListener('click', function (event) {
  var mode = event.target.closest ? event.target.closest('[data-cycle-mode]') : null;
  if (mode) { toggleCycleMode(mode.dataset.cycleMode); return; }
  var dot = event.target.closest ? event.target.closest('[data-cycle-task]') : null;
  if (dot) { setCycleTaskStatus(dot.dataset.cycleTask, dot.dataset.cycleStatus || ''); return; }
  var generate = event.target.closest ? event.target.closest('#cycle-generate-review') : null;
  if (generate) { void runCycleReviewGeneration(); return; }
  var save = event.target.closest ? event.target.closest('[data-cycle-save]') : null;
  if (save) void runCycleSave(save.dataset.cycleSave);
});
CYCLE_SECTION_KEYS.forEach(function (pair) {
  var textarea = cycleEl('cycle-md-' + pair[0]);
  if (!textarea) return;
  textarea.addEventListener('input', function () {
    // Teammate views are read-only, so there is nothing to draft. It also keeps
    // the draft map single-owner: a teammate's cycle id can be identical to one
    // of mine, and two people's unsaved text under one key is a way to lose a
    // retro.
    if (selectedOwnerId || !selectedCycleId) return;
    cycleDrafts.set(selectedCycleId + '::' + pair[0], textarea.value);
  });
});
if (cycleEl('cycles-refresh')) cycleEl('cycles-refresh').addEventListener('click', function () {
  // Refresh is the explicit discard: drafts survive everything else.
  cycleDrafts.clear();
  clearCycleStatuses();
  void loadCycles().then(function () { cycleToast('已重新读取周期'); });
});
if (cycleEl('cycles-team-sync')) cycleEl('cycles-team-sync').addEventListener('click', function () {
  // Drafts are untouched: this pulls teammates' files, it does not reload mine.
  var button = cycleEl('cycles-team-sync');
  button.disabled = true;
  fetch('/api/team/sync', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    .then(function (r) { return r.json(); })
    .then(function (result) {
      var sync = (result && result.sync) || {};
      if (sync.status === 'ok') cycleToast('已同步：拉取 ' + (sync.pulled || 0) + ' 个队友周期，上传 ' + (sync.pushed || 0) + ' 个');
      else cycleToast('同步未执行：' + (sync.reason || sync.status || 'unknown'));
      return loadCycles();
    })
    .catch(function (error) { cycleToast('同步失败：' + String(error)); })
    .then(function () { button.disabled = false; });
});

void loadCycles();
`;

// --- schedules --------------------------------------------------------------

function renderSchedules(ctx: PageContext): string {
  const { config, role } = ctx;
  const schedule = workflowSchedule(config);
  const fired = readFiredKeys();
  const today = utcDay();
  const runs = safe(() => listRecentWorkflowRuns(config, 40), []);
  const locks = readSchedulerLocks();

  const rows = schedule
    .map((item) => {
      const key = `${today}:${item.workflow}:${item.time}`;
      const last = runs.find((run) => run.workflow === item.workflow);
      const plan = item.weekday ? `weekly ${item.weekday} ${item.time}` : `daily ${item.time}`;
      const firedToday = fired.has(key);
      const actions = role === 'admin'
        ? `<button type="button" data-post="/api/schedules/backfill" data-payload='${payload({ workflow: item.workflow })}'>Backfill now</button>`
        : '<span class="muted small">read-only</span>';
      return `<tr>
        <td>${escapeHtml(item.label)}<div class="muted small">${escapeHtml(item.enabled ? plan : 'disabled')}</div></td>
        <td>${last ? statusPill(last.status) : '<span class="muted">—</span>'}<div class="muted small">${last ? escapeHtml(shortTime(last.started_at)) : ''}</div></td>
        <td>${firedToday ? 'fired today' : item.enabled ? 'waiting' : 'off'}</td>
        <td class="row-actions">${actions}<a class="secondary btn" href="/api/schedules/logs?name=launchd.err.log" target="_blank" rel="noopener">Logs</a></td>
      </tr>`;
    })
    .join('');

  return `
  <section class="card">
    <h2>Schedules</h2>
    <table class="grid"><thead><tr><th>Task</th><th>Last run</th><th>Today</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="muted small">Scheduler locks held: ${locks}. Next trigger follows the configured time in ${escapeHtml(config.user.timezone)}.</p>
  </section>`;
}

// --- runs -------------------------------------------------------------------

function renderRuns(ctx: PageContext): string {
  const { config, role } = ctx;
  const active = runManager.list();
  const recent = safe(() => listRecentWorkflowRuns(config, 20), []);

  const activeHtml = active.length
    ? `<table class="grid"><thead><tr><th>Run</th><th>Workflow</th><th>Age</th><th>Actions</th></tr></thead><tbody>${active
        .map(
          (run) => `<tr>
            <td class="mono">${escapeHtml(run.runId)}</td>
            <td>${escapeHtml(run.workflow || '—')}</td>
            <td>${Math.round(run.ageMs / 1000)}s</td>
            <td>${role === 'admin' ? `<button type="button" class="danger" data-post="/api/runs/cancel" data-payload='${payload({ runId: run.runId })}'>Cancel</button>` : '<span class="muted small">read-only</span>'}</td>
          </tr>`,
        )
        .join('')}</tbody></table>`
    : '<p class="muted">No runs currently in flight.</p>';

  const recentHtml = recent.length
    ? `<table class="grid"><thead><tr><th>Workflow</th><th>Trigger</th><th>Status</th><th>Started</th><th>Send</th><th>Actions</th></tr></thead><tbody>${recent
        .map((run) => {
          const send = run.send.enabled ? run.send.status : 'skipped';
          const rerun =
            role === 'admin' && run.status === 'failed' && ['daily_plan', 'daily_review', 'weekly_review'].includes(run.workflow)
              ? `<button type="button" data-post="/api/runs/rerun" data-payload='${payload({ workflow: run.workflow })}'>Rerun</button>`
              : '';
          return `<tr>
            <td>${escapeHtml(run.workflow)}</td>
            <td>${escapeHtml(run.trigger)}</td>
            <td>${statusPill(run.status)}${run.error ? `<div class="muted small">${escapeHtml(run.error.slice(0, 80))}</div>` : ''}</td>
            <td>${escapeHtml(shortTime(run.started_at))}</td>
            <td>${escapeHtml(send)}</td>
            <td>${rerun}</td>
          </tr>`;
        })
        .join('')}</tbody></table>`
    : '<p class="muted">No run history.</p>';

  return `
  <section class="card"><h2>In flight (${active.length})</h2>${activeHtml}</section>
  <section class="card"><h2>Recent runs</h2>${recentHtml}</section>`;
}

// --- artifacts --------------------------------------------------------------

function renderArtifacts(ctx: PageContext): string {
  const { url, role } = ctx;
  const all = safe(() => readArtifactsIndex(), []);
  const q = (url.searchParams.get('q') || '').trim().toLowerCase();
  const typeFilter = (url.searchParams.get('type') || '').trim();
  const dateFilter = (url.searchParams.get('date') || '').trim();
  const previewId = (url.searchParams.get('preview') || '').trim();

  let filtered = all;
  if (q) filtered = filtered.filter((a) => a.name.toLowerCase().includes(q) || a.rel_path.toLowerCase().includes(q) || a.tags.some((t) => t.toLowerCase().includes(q)));
  if (typeFilter) filtered = filtered.filter((a) => a.type === typeFilter);
  if (dateFilter) filtered = filtered.filter((a) => a.mtime.slice(0, 10) === dateFilter);

  const types = [...new Set(all.map((a) => a.type))].sort();
  const typeOptions = ['<option value="">all types</option>', ...types.map((t) => `<option value="${escapeHtml(t)}"${t === typeFilter ? ' selected' : ''}>${escapeHtml(t)}</option>`)].join('');

  const rows = filtered.length
    ? filtered
        .map(
          (a) => `<tr>
        <td><a href="?${buildQuery(url, { preview: a.id })}">${escapeHtml(a.name)}</a><div class="muted small">${escapeHtml(a.rel_path)}</div></td>
        <td><span class="tag">${escapeHtml(a.type)}</span></td>
        <td>${formatBytes(a.size)}</td>
        <td>${escapeHtml(a.mtime.slice(0, 16).replace('T', ' '))}</td>
        <td>${escapeHtml(a.source)}</td>
      </tr>`,
        )
        .join('')
    : '<tr><td colspan="5" class="muted">No artifacts match.</td></tr>';

  const preview = previewId ? renderArtifactPreview(previewId) : '';
  const reindex = role === 'admin' ? '<button type="button" data-post="/api/artifacts/reindex" data-payload="{}">Reindex</button>' : '';

  return `
  <section class="card">
    <div class="card-head"><h2>Artifacts (${all.length})</h2>${reindex}</div>
    <form class="filter-bar" method="get">
      <input name="q" placeholder="keyword" value="${escapeHtml(url.searchParams.get('q') || '')}" />
      <select name="type">${typeOptions}</select>
      <input name="date" type="date" value="${escapeHtml(dateFilter)}" />
      <button type="submit">Filter</button>
      <a class="secondary btn" href="/artifacts">Reset</a>
    </form>
    <table class="grid"><thead><tr><th>Name</th><th>Type</th><th>Size</th><th>Modified</th><th>Source</th></tr></thead><tbody>${rows}</tbody></table>
  </section>
  ${preview}`;
}

function renderArtifactPreview(id: string): string {
  const record = findArtifactById(id);
  if (!record) return '<section class="card"><h2>Preview</h2><p class="error">Artifact not found in index.</p></section>';
  if (!isPreviewableType(record.type)) {
    return `<section class="card"><h2>Preview · ${escapeHtml(record.name)}</h2><p class="muted">${escapeHtml(record.type)} is not previewable as text (${formatBytes(record.size)}).</p></section>`;
  }
  let content = '';
  try {
    const raw = fs.readFileSync(record.path, 'utf8');
    content = raw.length > 200_000 ? `${raw.slice(0, 200_000)}\n… (truncated)` : raw;
  } catch (error) {
    return `<section class="card"><h2>Preview</h2><p class="error">${escapeHtml(error instanceof Error ? error.message : String(error))}</p></section>`;
  }
  return `<section class="card"><h2>Preview · ${escapeHtml(record.name)}</h2><pre class="preview">${escapeHtml(content)}</pre></section>`;
}

// --- data readers -----------------------------------------------------------

interface ScheduleItem {
  workflow: 'daily_plan' | 'daily_review' | 'weekly_review';
  label: string;
  time: string;
  enabled: boolean;
  weekday?: string;
}

function workflowSchedule(config: AppConfig): ScheduleItem[] {
  return [
    { workflow: 'daily_plan', label: 'Daily plan', time: config.workflows.daily_plan.time, enabled: config.workflows.daily_plan.enabled },
    { workflow: 'daily_review', label: 'Daily review', time: config.workflows.daily_review.time, enabled: config.workflows.daily_review.enabled },
    {
      workflow: 'weekly_review',
      label: 'Weekly review',
      time: config.workflows.weekly_review.time,
      enabled: config.workflows.weekly_review.enabled,
      weekday: config.workflows.weekly_review.weekday,
    },
  ];
}

function readFiredKeys(): Set<string> {
  const file = path.resolve('./data/memory/scheduler-state.json');
  if (!fs.existsSync(file)) return new Set();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { fired?: unknown };
    if (!Array.isArray(parsed.fired)) return new Set();
    return new Set(parsed.fired.filter((k): k is string => typeof k === 'string'));
  } catch {
    return new Set();
  }
}

function readSchedulerLocks(): number {
  const dir = path.resolve('./data/runtime/scheduler-locks');
  if (!fs.existsSync(dir)) return 0;
  try {
    return fs.readdirSync(dir).filter((name) => name.endsWith('.lock')).length;
  } catch {
    return 0;
  }
}

interface UsageSummary {
  enabled: boolean;
  todayCalls: number;
  todayTokens: number;
  todayCost: number;
  monthCost: number;
  month: string;
}

function readUsageSummary(): UsageSummary {
  const file = path.resolve('./data/runtime/usage-ledger.jsonl');
  const today = utcDay();
  const month = today.slice(0, 7);
  const empty: UsageSummary = { enabled: false, todayCalls: 0, todayTokens: 0, todayCost: 0, monthCost: 0, month };
  if (!fs.existsSync(file)) return empty;
  let todayCalls = 0;
  let todayTokens = 0;
  let todayCost = 0;
  let monthCost = 0;
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry: { day?: string; month?: string; inputTokens?: number; outputTokens?: number; estCostUsd?: number };
      try {
        entry = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const cost = Number(entry.estCostUsd) || 0;
      if (entry.month === month || (entry.day && entry.day.slice(0, 7) === month)) monthCost += cost;
      if (entry.day === today) {
        todayCalls += 1;
        todayTokens += (Number(entry.inputTokens) || 0) + (Number(entry.outputTokens) || 0);
        todayCost += cost;
      }
    }
  } catch {
    return empty;
  }
  return { enabled: true, todayCalls, todayTokens, todayCost, monthCost, month };
}

// --- small helpers ----------------------------------------------------------

function statusPill(status: WorkflowRunRecord['status']): string {
  const cls = status === 'succeeded' ? 'ok' : status === 'failed' ? 'bad' : 'run';
  return `<span class="pill ${cls}">${escapeHtml(status)}</span>`;
}

function payload(value: unknown): string {
  return escapeHtml(JSON.stringify(value));
}

function buildQuery(url: URL, overrides: Record<string, string>): string {
  const params = new URLSearchParams(url.search);
  for (const [key, value] of Object.entries(overrides)) params.set(key, value);
  return params.toString();
}

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

function shortTime(iso: string): string {
  return typeof iso === 'string' ? iso.slice(0, 16).replace('T', ' ') : '';
}


function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatBytes(n: number): string {
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

// --- styles + client script -------------------------------------------------

const CONSOLE_CSS = `
:root{color-scheme:light;--bg:#f6f7f4;--surface:#fff;--surface-2:#eef3ee;--text:#202421;--muted:#68726b;--border:#d7ddd8;--accent:#1f6f58;--danger:#9f2d2d;--ok:#1e7a4d;--run:#0d5f8c;}
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--text);font-size:14px}
.topbar{display:flex;align-items:center;gap:20px;padding:10px 18px;background:var(--surface);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:5;flex-wrap:wrap}
.brand{font-weight:600}
.nav{display:flex;gap:6px;flex:1;flex-wrap:wrap}
.nav-link{padding:6px 12px;border-radius:8px;text-decoration:none;color:var(--muted)}
.nav-link.active,.nav-link:hover{background:var(--surface-2);color:var(--text)}
.session{display:flex;align-items:center;gap:10px}
.who{font-size:13px;color:var(--text);font-weight:500}
.avatar{border-radius:7px;display:block;flex:none}
/* Avatar dropdown menu (个人信息 / 设置 / 退出). */
.usermenu{position:relative}
.usermenu-trigger{display:flex;align-items:center;gap:10px;background:none;border:1px solid transparent;padding:3px 8px;border-radius:8px;cursor:pointer;color:var(--text)}
.usermenu-trigger:hover{background:var(--surface-2);border-color:var(--border)}
.usermenu-caret{color:var(--muted);font-size:11px}
.usermenu-panel{position:absolute;right:0;top:calc(100% + 6px);background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:6px;min-width:150px;display:flex;flex-direction:column;gap:2px;box-shadow:0 8px 24px rgba(0,0,0,.12);z-index:20}
.usermenu-panel[hidden]{display:none}
.usermenu-panel>a,.usermenu-panel>button{text-align:left;background:none;border:none;color:var(--text);padding:8px 10px;border-radius:7px;cursor:pointer;text-decoration:none;font:inherit;font-size:13px;width:100%}
.usermenu-panel>a:hover,.usermenu-panel>button:hover{background:var(--surface-2)}
.profile-card{max-width:520px}
.profile-head{display:flex;align-items:center;gap:14px;margin-bottom:14px}
.profile-head h2{margin:0}
/* UI font size preference (LEO console): small / medium / large via body zoom. */
html[data-font="small"]{--ui-zoom:0.9}
html[data-font="large"]{--ui-zoom:1.14}
body{zoom:var(--ui-zoom,1)}
.welcome-body{background:var(--bg)}
.welcome{max-width:860px}
.welcome-hero{padding:34px 0 26px}
.welcome-hero h1{margin:0 0 10px;font-size:26px;line-height:1.35}
.welcome-hero p{margin:0 0 18px;max-width:60ch;line-height:1.7}
.welcome-actions{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px}
.welcome-features{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:1fr 1fr;gap:14px}
@media(max-width:760px){.welcome-features{grid-template-columns:1fr}}
.welcome-features li{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px 16px}
.welcome-features h3{margin:0 0 6px;font-size:14px}
.welcome-features p{margin:0;font-size:13px;color:var(--muted);line-height:1.65}
.auth-modal{position:fixed;inset:0;z-index:40;background:rgba(20,24,22,.55);display:flex;align-items:center;justify-content:center;padding:24px}
.auth-modal[hidden]{display:none}
.auth-card{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:20px;width:min(400px,100%);display:flex;flex-direction:column;gap:12px}
.auth-card label{display:flex;flex-direction:column;gap:5px;font-size:13px}
/* An author-level display beats the UA sheet's [hidden]{display:none}, so the
   email row stayed visible in sign-in mode even though it was hidden. One rule
   for the whole dialog rather than one per element that turns out to need it. */
.auth-card [hidden]{display:none}
.auth-card input{font:inherit;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--surface)}
.field-error{color:var(--danger);font-size:12px}
.field-error[hidden]{display:none}
.auth-switch{margin:0;text-align:center}
.logout{border:1px solid var(--border);background:var(--surface);border-radius:8px;padding:5px 10px;cursor:pointer}
.page{max-width:1100px;margin:0 auto;padding:18px;display:flex;flex-direction:column;gap:16px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px}
.card-head{display:flex;justify-content:space-between;align-items:center}
h2{margin:0 0 12px;font-size:16px}
h3{margin:0 0 8px;font-size:14px}
.grid{width:100%;border-collapse:collapse}
.grid th,.grid td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--border);vertical-align:top}
.grid th{color:var(--muted);font-weight:500;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
.muted{color:var(--muted)}
.small{font-size:12px}
.mono,.preview{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;background:var(--surface-2)}
.pill.ok{background:#dff2e6;color:var(--ok)}
.pill.bad{background:#f7e0e0;color:var(--danger)}
.pill.run{background:#dcecf6;color:var(--run)}
.tag{display:inline-block;padding:1px 7px;border-radius:6px;background:var(--surface-2);color:var(--muted);font-size:11px}
button{font:inherit;border:1px solid var(--accent);background:var(--accent);color:#fff;border-radius:8px;padding:6px 12px;cursor:pointer}
button.secondary,.btn.secondary{background:var(--surface);color:var(--text);border-color:var(--border)}
button.danger{background:var(--danger);border-color:var(--danger)}
.btn{display:inline-block;text-decoration:none;border-radius:8px;padding:6px 12px}
.stat-row{display:flex;gap:18px;flex-wrap:wrap}
.stat{display:flex;flex-direction:column}
.stat-num{font-size:20px;font-weight:600}
.stat-label{font-size:12px;color:var(--muted)}
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.col{min-height:120px;min-width:0}
@media(max-width:900px){.two-col{grid-template-columns:1fr}}
.objective{margin-bottom:14px}
.kr-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.kr-head{display:flex;justify-content:space-between}
.kr-id{font-weight:600;font-size:12px}
.kr-prog{font-size:12px;color:var(--accent)}
.kr-desc{font-size:12px;color:var(--muted);margin:2px 0;overflow-wrap:anywhere}
.kr-meta{margin-top:4px}
.bar{height:6px;background:var(--surface-2);border-radius:6px;overflow:hidden}
.bar>span{display:block;height:100%;background:var(--accent)}
.todo-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}
.todo-item{border:1px solid var(--border);border-radius:10px;padding:10px}
.plan-rank{display:inline-block;min-width:18px;font-weight:600;color:var(--muted)}
.plan-actions{justify-content:flex-end}
.plan-toolbar{display:flex;justify-content:flex-end;margin-bottom:8px}
.chat-hint-list{margin:6px 0 0;padding-left:16px;display:flex;flex-direction:column;gap:2px}
.top-link{font-weight:600;text-decoration:none;color:var(--accent,#0a7);border:1px solid var(--border);border-radius:6px;padding:4px 10px;white-space:nowrap;font-size:13px}
.top-link:hover{background:var(--surface-2)}
.tag-link{text-decoration:none}
.tag-link:hover{text-decoration:underline}
.todo-capture{display:flex;gap:8px;margin-bottom:10px}
.todo-capture input{flex:1;min-width:0}
.todo-item.state-checked{opacity:.6}
.todo-item.state-checked .todo-text{text-decoration:line-through}
.todo-item.state-deferred{opacity:.75;border-style:dashed}
.todo-meta{display:flex;gap:8px;align-items:center;margin:6px 0}
.todo-actions{display:flex;gap:8px}
.todo-history{margin-top:12px;border-top:1px solid var(--border);padding-top:10px}
.todo-history>summary{cursor:pointer;font-weight:600;list-style:none;display:flex;gap:8px;align-items:center}
.todo-history>summary::-webkit-details-marker{display:none}
.todo-history>summary::before{content:"▸";color:var(--muted);font-weight:400}
.todo-history[open]>summary::before{content:"▾"}
.todo-history>summary:hover{color:var(--accent)}
.todo-history>*:not(summary){margin-top:10px}
.signal-block{margin-bottom:14px}
.signal-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.signal{display:flex;justify-content:space-between;padding:6px 8px;border-radius:8px;background:var(--surface-2)}
.signal.error{background:#f7e0e0}
.filter-bar{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
.filter-bar input,.filter-bar select,.inline-form input,.inline-form select{font:inherit;padding:6px 10px;border:1px solid var(--border);border-radius:8px;background:var(--surface)}
.inline-form{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.row-actions{display:flex;gap:8px;align-items:center}
.preview{background:#0f1512;color:#e6efe9;padding:14px;border-radius:10px;max-height:520px;overflow:auto;white-space:pre-wrap;word-break:break-word}
.toast{position:fixed;bottom:20px;right:20px;background:var(--text);color:#fff;padding:10px 16px;border-radius:10px;z-index:20}
.error{color:var(--danger)}
.chat-wrap{display:grid;grid-template-columns:240px 1fr;gap:16px;align-items:start}
@media(max-width:800px){.chat-wrap{grid-template-columns:1fr}}
.chat-sessions{max-height:70vh;overflow:auto}
.chat-session-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}
.chat-session{position:relative;display:flex;flex-direction:column;gap:2px;padding:8px 26px 8px 10px;border-radius:8px;cursor:pointer;border:1px solid transparent}
.chat-session:hover{background:var(--surface-2)}
.chat-session-delete{position:absolute;top:6px;right:6px;border:none;background:none;color:var(--muted);font-size:14px;line-height:1;padding:2px 4px;border-radius:4px;cursor:pointer;visibility:hidden}
.chat-session:hover .chat-session-delete{visibility:visible}
.chat-session-delete:hover{background:var(--border);color:var(--text)}
.chat-session.active{background:var(--surface-2);border-color:var(--border)}
.s-title{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chat-main{display:flex;flex-direction:column;min-height:60vh}
.chat-head{display:flex;justify-content:space-between;align-items:flex-start}
.chat-stream{flex:1;overflow:auto;display:flex;flex-direction:column;gap:12px;padding:8px 2px;max-height:60vh}
.chat-msg{display:flex;flex-direction:column;gap:2px}
.chat-msg .who{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
.chat-msg .body{white-space:pre-wrap;word-break:break-word;padding:8px 12px;border-radius:10px;background:var(--surface-2)}
.chat-msg.role-user .body{background:#dcecf6;align-self:flex-start}
.chat-msg.role-assistant .body{background:var(--surface-2)}
.chat-msg.role-system .body{background:transparent;color:var(--muted);padding:2px 0}
.chat-status{padding:2px 0}
.chat-composer{display:flex;gap:8px;align-items:flex-end;margin-top:10px;border-top:1px solid var(--border);padding-top:10px}
.chat-composer textarea{flex:1;font:inherit;padding:8px 10px;border:1px solid var(--border);border-radius:8px;resize:vertical;background:var(--surface)}
.chat-composer-actions{display:flex;flex-direction:column;gap:6px}
.cycles-wrap{display:grid;grid-template-columns:270px 1fr;gap:16px;align-items:start}
@media(max-width:900px){.cycles-wrap{grid-template-columns:1fr}}
.cycles-side{display:flex;flex-direction:column;gap:16px}
.cycles-main{display:flex;flex-direction:column;gap:16px}
.cycle-list{display:flex;flex-direction:column;gap:6px;max-height:42vh;overflow:auto}
.cycle-item{display:flex;flex-direction:column;gap:2px;text-align:left;padding:8px 10px;border:1px solid var(--border);border-radius:10px;background:var(--surface);color:var(--text);cursor:pointer}
.cycle-item:hover{background:var(--surface-2)}
.cycle-item.active{border-color:var(--accent);background:var(--surface-2)}
.cycle-item strong{font-size:13px}
.cycle-item span{font-size:11px;color:var(--muted)}
.cycle-item-broken{font-size:11px;color:var(--danger)}
.cycle-cards{display:flex;flex-direction:column;gap:16px}
.cycle-cards[hidden]{display:none}
.cycle-card textarea{width:100%;font:inherit;padding:10px;border:1px solid var(--border);border-radius:10px;background:var(--surface);resize:vertical}
.cycle-card textarea{min-height:11rem}
.cycle-head-actions{display:flex;gap:6px;align-items:center}
.cycle-read{font-size:13px;line-height:1.7}
.cycle-read p{margin:0 0 8px}
.cycle-read>:last-child{margin-bottom:0}
.cy-group,.cy-retro-section{margin:0 0 14px}
.cy-group:last-child,.cy-retro-section:last-child{margin-bottom:0}
.cy-group-title{margin:0 0 6px;font-size:13px;font-weight:600;color:var(--text)}
.cy-tasks{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.cy-task{display:flex;gap:8px;align-items:baseline;padding-left:10px;border-left:2px solid var(--border);overflow-wrap:anywhere}
.cy-task-done{border-left-color:#2e9e5b}
.cy-task-partial{border-left-color:#d8a72a}
.cy-task-missed{border-left-color:var(--danger)}
.cy-task-done>span:last-child{color:var(--muted)}
.cy-dots{flex:none;display:inline-flex;gap:3px;align-self:center}
.cy-dot{width:11px;height:11px;padding:0;border-radius:50%;cursor:pointer;background:transparent;line-height:0}
.cy-dot-done{border:1.5px solid #2e9e5b}
.cy-dot-partial{border:1.5px solid #d8a72a}
.cy-dot-missed{border:1.5px solid var(--danger)}
.cy-dot-done.on{background:#2e9e5b}
.cy-dot-partial.on{background:#d8a72a}
.cy-dot-missed.on{background:var(--danger)}
.cy-dot:hover{outline:2px solid var(--border);outline-offset:1px}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.cy-badge{flex:none;font-size:10px;font-weight:700;letter-spacing:.04em;padding:1px 6px;border-radius:6px;background:var(--danger);color:#fff}
.cy-fields{margin:0 0 8px;display:grid;grid-template-columns:auto 1fr;gap:2px 12px}
.cy-field{display:contents}
.cy-fields dt{color:var(--muted);font-size:12px}
.cy-fields dd{margin:0;overflow-wrap:anywhere}
/* Read-only is not broken, so it borrows the muted surface rather than the
   danger colours: nothing is wrong, this is just someone else's file. */
.cycle-card textarea[readonly]{background:var(--surface-2)}
.cycle-card-actions{display:flex;gap:8px;align-items:center;margin-top:8px}
.cycle-card-actions[hidden]{display:none}
.cycle-readonly{margin-top:8px;padding:8px 10px;border-radius:10px;background:var(--surface-2);color:var(--muted);font-size:12px}
.cycle-warning{margin-top:8px;padding:10px;border-radius:10px;background:#f7e0e0;color:var(--danger);font-size:12px}
button.compact{padding:4px 10px;font-size:12px}
`;

/** Applied in <head> on every authenticated page so the font choice never flashes. */
const FONT_PREF_JS = `try{var f=localStorage.getItem('daily_os_font');if(f==='small'||f==='large')document.documentElement.setAttribute('data-font',f);}catch(e){}`;

const CONSOLE_JS = `
(function(){
  function toast(msg){var t=document.getElementById('toast');if(!t)return;t.textContent=msg;t.hidden=false;setTimeout(function(){t.hidden=true},2600);}
  document.addEventListener('keydown',function(ev){if(ev.key!=='Escape')return;var m=document.querySelector('[data-usermenu].open');if(m){m.classList.remove('open');var t=m.querySelector('[data-usermenu-toggle]');if(t)t.setAttribute('aria-expanded','false');var p=m.querySelector('.usermenu-panel');if(p)p.hidden=true;}});
  function closeUserMenu(m){if(!m)return;m.classList.remove('open');var t=m.querySelector('[data-usermenu-toggle]');if(t)t.setAttribute('aria-expanded','false');var p=m.querySelector('.usermenu-panel');if(p)p.hidden=true;}
  document.addEventListener('click',function(ev){
    var umToggle=ev.target.closest('[data-usermenu-toggle]');
    if(umToggle){ev.preventDefault();var m=umToggle.closest('[data-usermenu]');var willOpen=!m.classList.contains('open');m.classList.toggle('open',willOpen);umToggle.setAttribute('aria-expanded',willOpen?'true':'false');var pnl=m.querySelector('.usermenu-panel');if(pnl)pnl.hidden=!willOpen;return;}
    var openMenu=document.querySelector('[data-usermenu].open');
    if(openMenu&&!ev.target.closest('.usermenu-panel')){closeUserMenu(openMenu);}
    var logout=ev.target.closest('[data-logout]');
    if(logout){ev.preventDefault();fetch('/api/logout',{method:'POST',credentials:'same-origin'}).then(function(){location.href='/';});return;}
    var btn=ev.target.closest('button[data-post],a[data-post]');
    if(!btn)return;
    ev.preventDefault();
    var url=btn.getAttribute('data-post');
    var payload=btn.getAttribute('data-payload');
    var body=payload?payload:'{}';
    var notePrompt=btn.getAttribute('data-note-prompt');
    if(notePrompt){
      var note=window.prompt(notePrompt,'');
      if(note===null)return;
      try{var obj=JSON.parse(body);if(note.trim())obj.note=note.trim();body=JSON.stringify(obj);}catch(e){}
    }
    btn.disabled=true;
    fetch(url,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:body})
      .then(function(r){return r.json().catch(function(){return{ok:r.ok};}).then(function(d){return{status:r.status,data:d};});})
      .then(function(res){
        if(res.status>=200&&res.status<300&&res.data&&res.data.ok!==false){toast((res.data&&res.data.text)||'Done');setTimeout(function(){location.reload();},600);}
        else{btn.disabled=false;toast((res.data&&res.data.error)||('Failed ('+res.status+')'));}
      })
      .catch(function(e){btn.disabled=false;toast(String(e));});
  });
  document.addEventListener('submit',function(ev){
    var form=ev.target.closest('form.inline-form[data-post]');
    if(!form)return;
    ev.preventDefault();
    var url=form.getAttribute('data-post');
    var obj={};new FormData(form).forEach(function(v,k){obj[k]=v;});
    fetch(url,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(obj)})
      .then(function(r){return r.json().catch(function(){return{ok:r.ok};}).then(function(d){return{status:r.status,data:d};});})
      .then(function(res){
        if(res.status>=200&&res.status<300&&res.data&&res.data.ok!==false){toast('Saved');setTimeout(function(){location.reload();},500);}
        else{toast((res.data&&res.data.error)||('Failed ('+res.status+')'));}
      })
      .catch(function(e){toast(String(e));});
  });
})();
`;

