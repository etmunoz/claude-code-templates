#!/usr/bin/env node
/**
 * Local security gate — the developer-facing mirror of the CI check in
 * .github/workflows/component-security-validation.yml (CCT-06).
 *
 * It audits ONLY the component files you've changed (against origin/main, plus
 * your uncommitted + untracked work), using the same scoped
 * `security-audit.js --files=` mode CI uses. Run it before you push:
 *
 *     npm run security:check
 *
 * Exit 0 = clean (or nothing to check); exit 1 = a changed component failed the
 * audit. No network, no new dependencies — just git + the existing auditor.
 */
'use strict';

const { execFileSync, spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const AUDIT = path.join(ROOT, 'cli-tool', 'src', 'security-audit.js');
const COMPONENT_GLOB = /^cli-tool\/components\/.+\.md$/;

function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function refExists(ref) {
  const r = spawnSync('git', ['rev-parse', '--verify', '--quiet', ref], { cwd: ROOT });
  return r.status === 0;
}

// Pick the best available base to diff against.
function baseRef() {
  for (const ref of ['origin/main', 'main', 'HEAD~1']) {
    if (refExists(ref)) return ref;
  }
  return null;
}

function main() {
  const base = baseRef();
  const changed = new Set();

  // Committed changes since the base branch (what a push would introduce).
  if (base) {
    for (const f of git(['diff', '--name-only', '--diff-filter=ACMR', `${base}...HEAD`]).split('\n')) {
      if (f) changed.add(f);
    }
  }
  // Uncommitted work (staged + unstaged) and untracked files, so issues are
  // caught before they're even committed.
  for (const f of git(['diff', '--name-only', '--diff-filter=ACMR', 'HEAD']).split('\n')) {
    if (f) changed.add(f);
  }
  for (const f of git(['ls-files', '--others', '--exclude-standard']).split('\n')) {
    if (f) changed.add(f);
  }

  const components = [...changed].filter((f) => COMPONENT_GLOB.test(f));

  if (components.length === 0) {
    console.log('🔒 security:check — no changed component files to audit. ✅');
    process.exit(0);
  }

  console.log(`🔒 security:check — auditing ${components.length} changed component file(s):`);
  for (const f of components) console.log(`   • ${f}`);
  console.log('');

  // Run the SAME scoped audit the CI gate runs.
  const res = spawnSync('node', [AUDIT, '--ci', `--files=${components.join(',')}`], {
    cwd: ROOT,
    stdio: 'inherit',
  });

  if (res.status !== 0) {
    console.error('\n❌ security:check failed — fix the errors above before pushing.');
    console.error('   (If a finding is a false positive, raise it with a maintainer.)');
    process.exit(1);
  }
  console.log('\n✅ security:check passed.');
  process.exit(0);
}

main();
