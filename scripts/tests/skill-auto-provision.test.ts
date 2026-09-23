/**
 * Startup self-provisioning policy for the weekly-review skill.
 *
 * `decideSkillProvisioning` is the guard layer: it decides whether startup clones,
 * fast-forwards, or leaves the checkout alone. These tests pin the two things that
 * matter — a consumer machine stays current automatically, and a developer's
 * checkout (feature branch or local edits) is never touched.
 *
 * Run: tsx scripts/tests/skill-auto-provision.test.ts
 */
import assert from 'node:assert/strict';

import { decideSkillProvisioning, type SkillRepoState } from '../../src/skills/update.js';

function state(overrides: Partial<SkillRepoState>): SkillRepoState {
  return {
    skillId: 'weekly-review',
    workdir: '/home/u/.daily-os/skills/life-review-os',
    installs: [],
    installPath: '',
    installTarget: '',
    available: true,
    isGitRepo: true,
    branch: 'main',
    commit: 'abc1234',
    subject: '',
    committedAt: '',
    dirty: [],
    behind: 0,
    blocked: '',
    ...overrides,
  };
}

// auto_update off → do nothing, whatever the state.
assert.equal(decideSkillProvisioning(state({}), false).action, 'disabled');

// No checkout at all → install (clone).
assert.equal(decideSkillProvisioning(state({ available: false, workdir: '' }), true).action, 'install');
// Configured but the directory is gone → install (re-clone).
assert.equal(decideSkillProvisioning(state({ available: false, workdir: '/gone' }), true).action, 'install');

// Present but not a git repo → skip (can't fast-forward a plain copy).
assert.equal(decideSkillProvisioning(state({ isGitRepo: false }), true).action, 'skip');

// A developer's checkout must be left alone:
assert.equal(decideSkillProvisioning(state({ dirty: ['bin/life-review-os.mjs'] }), true).action, 'skip', 'dirty tree is left alone');
assert.equal(decideSkillProvisioning(state({ branch: 'feat/x' }), true).action, 'skip', 'feature branch is left alone');
assert.equal(decideSkillProvisioning(state({ branch: 'HEAD' }), true).action, 'skip', 'detached HEAD is left alone');

// A clean checkout on the default branch fast-forwards (a no-op if already current).
assert.equal(decideSkillProvisioning(state({ branch: 'main' }), true).action, 'update');
assert.equal(decideSkillProvisioning(state({ branch: 'master' }), true).action, 'update');
// behind is not consulted — the update path fetches first, so a stale local count
// must not gate it.
assert.equal(decideSkillProvisioning(state({ branch: 'main', behind: -1 }), true).action, 'update');

console.log('skill-auto-provision.test.ts: all tests passed');
