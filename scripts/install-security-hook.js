#!/usr/bin/env node
/**
 * Opt-in installer for a pre-push git hook that runs `npm run security:check`.
 *
 *     npm run security:install-hook     # enable
 *     npm run security:install-hook -- --uninstall   # remove
 *
 * Nothing is installed unless you run this. The hook only blocks a push when a
 * changed component fails the security audit (the CCT-06 gate), and can always
 * be bypassed for a one-off with `git push --no-verify`.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const MARKER = '# cct-security-pre-push';

function hooksDir() {
  try {
    const dir = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
    return path.isAbsolute(dir) ? dir : path.join(ROOT, dir);
  } catch {
    return path.join(ROOT, '.git', 'hooks');
  }
}

const hookPath = path.join(hooksDir(), 'pre-push');
const uninstall = process.argv.includes('--uninstall');

if (uninstall) {
  if (fs.existsSync(hookPath) && fs.readFileSync(hookPath, 'utf8').includes(MARKER)) {
    fs.rmSync(hookPath);
    console.log('✅ Removed the security pre-push hook.');
  } else {
    console.log('ℹ️  No CCT security pre-push hook to remove.');
  }
  process.exit(0);
}

if (fs.existsSync(hookPath)) {
  const existing = fs.readFileSync(hookPath, 'utf8');
  if (!existing.includes(MARKER)) {
    console.error(`❌ A pre-push hook already exists at ${hookPath} and is not managed by this tool.`);
    console.error('   Remove or merge it manually, then re-run.');
    process.exit(1);
  }
}

const script = `#!/bin/sh
${MARKER}
# Runs the local component security gate before every push.
# Bypass a single push with: git push --no-verify
npm run --silent security:check
`;

fs.mkdirSync(path.dirname(hookPath), { recursive: true });
fs.writeFileSync(hookPath, script, { mode: 0o755 });
console.log(`✅ Installed security pre-push hook at ${hookPath}`);
console.log('   It runs `npm run security:check` before each push (bypass: git push --no-verify).');
