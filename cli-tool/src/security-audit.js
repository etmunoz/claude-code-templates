#!/usr/bin/env node

/**
 * Security Audit CLI - Validates component security
 *
 * Usage:
 *   node src/security-audit.js [options]
 *   npm run security-audit
 */

const ValidationOrchestrator = require('./validation/ValidationOrchestrator');
const fs = require('fs-extra');
const path = require('path');
const chalk = require('chalk');

/**
 * Scan directory for component files
 */
async function scanComponents(directory) {
  const components = [];
  const componentTypes = ['agents', 'commands', 'mcps', 'settings', 'hooks'];

  for (const type of componentTypes) {
    const typeDir = path.join(directory, type);

    if (!await fs.pathExists(typeDir)) {
      continue;
    }

    // Recursively find all .md files
    const files = await findMarkdownFiles(typeDir);

    for (const file of files) {
      const content = await fs.readFile(file, 'utf8');
      const relativePath = path.relative(process.cwd(), file);

      components.push({
        content,
        path: relativePath,
        type: type.slice(0, -1) // Remove 's' (agents -> agent)
      });
    }
  }

  return components;
}

/**
 * Recursively find all markdown files
 */
async function findMarkdownFiles(dir) {
  const files = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      const subFiles = await findMarkdownFiles(fullPath);
      files.push(...subFiles);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * Load specific component files (CCT-06 PR-scoped gate). Infers the component
 * type from the path segment and silently skips paths that are not component
 * markdown files or no longer exist (e.g. deleted in the PR).
 */
async function loadComponentsFromFiles(fileList) {
  const componentTypes = ['agents', 'commands', 'mcps', 'settings', 'hooks'];
  const components = [];

  for (const rel of fileList) {
    if (!rel.endsWith('.md')) continue;
    const parts = rel.split('/');
    const idx = parts.findIndex(p => componentTypes.includes(p));
    if (idx === -1) continue; // not under a known component type dir
    const type = parts[idx].slice(0, -1); // agents -> agent

    const abs = path.isAbsolute(rel) ? rel : path.join(process.cwd(), rel);
    if (!await fs.pathExists(abs)) continue; // deleted/renamed file

    const content = await fs.readFile(abs, 'utf8');
    components.push({ content, path: rel, type });
  }

  return components;
}

/**
 * Main execution
 */
async function main() {
  const args = process.argv.slice(2);
  const ciMode = args.includes('--ci');
  const verbose = args.includes('--verbose') || args.includes('-v');
  const jsonOutput = args.includes('--json');
  const outputFile = args.find(arg => arg.startsWith('--output='))?.split('=')[1];
  // CCT-06: `--files=a.md,b.md` audits ONLY the given component files (used by CI
  // to gate a PR on the components it actually changes, without being blocked by
  // pre-existing findings in unchanged catalog files).
  const filesArg = args.find(arg => arg.startsWith('--files='))?.split('=')[1];
  const fileList = filesArg
    ? filesArg.split(',').map(f => f.trim()).filter(Boolean)
    : null;

  console.log(chalk.blue('\n🔒 Claude Code Templates - Security Audit\n'));
  console.log(chalk.gray('━'.repeat(60)));

  // Determine components directory
  // Check if we're running from the cli-tool directory or the root
  let componentsDir = path.join(process.cwd(), 'components');
  if (!await fs.pathExists(componentsDir)) {
    componentsDir = path.join(process.cwd(), 'cli-tool', 'components');
  }

  if (!await fs.pathExists(componentsDir)) {
    console.error(chalk.red('❌ Components directory not found:', componentsDir));
    console.error(chalk.gray('   Tried:', path.join(process.cwd(), 'components')));
    console.error(chalk.gray('   Tried:', path.join(process.cwd(), 'cli-tool', 'components')));
    process.exit(1);
  }

  let components;
  if (fileList) {
    console.log(chalk.blue('📁 Auditing changed component files only...'));
    components = await loadComponentsFromFiles(fileList);
    console.log(chalk.gray(`   ${components.length} changed component file(s) to audit\n`));
    if (components.length === 0) {
      console.log(chalk.green('✅ No changed component files to audit — nothing to gate.\n'));
      process.exit(0);
    }
  } else {
    console.log(chalk.blue('📁 Scanning components directory...'));
    components = await scanComponents(componentsDir);
    console.log(chalk.gray(`   Found ${components.length} components\n`));
  }

  // Validate all components
  const orchestrator = new ValidationOrchestrator();

  console.log(chalk.blue('🔍 Running security validation...\n'));
  const results = await orchestrator.validateComponents(components, {
    strict: ciMode,
    updateRegistry: false
  });

  // Generate report
  if (jsonOutput) {
    const report = orchestrator.generateJsonReport(results);

    if (outputFile) {
      await fs.writeFile(outputFile, report);
      console.log(chalk.green(`✅ JSON report saved to: ${outputFile}`));
    } else {
      console.log(report);
    }
  } else {
    const report = orchestrator.generateReport(results, {
      verbose,
      colors: !ciMode
    });
    console.log(report);
  }

  // Summary
  console.log(chalk.bold('\n📊 Validation Summary:'));
  console.log(chalk.gray('━'.repeat(60)));
  console.log(`   Total components: ${results.summary.total}`);
  console.log(`   ${chalk.green('✅ Passed')}: ${results.summary.passed}`);
  console.log(`   ${chalk.red('❌ Failed')}: ${results.summary.failed}`);
  console.log(`   ${chalk.yellow('⚠️  Warnings')}: ${results.summary.warnings}`);
  console.log(chalk.gray('━'.repeat(60)));

  // Exit with appropriate code
  if (ciMode && results.summary.failed > 0) {
    console.error(chalk.red('\n❌ Security audit failed in CI mode\n'));
    process.exit(1);
  }

  if (results.summary.failed > 0) {
    console.log(chalk.yellow('\n⚠️  Some components failed validation\n'));
    process.exit(0); // Don't fail in non-CI mode
  }

  console.log(chalk.green('\n✅ All components passed security validation\n'));
  process.exit(0);
}

// Error handling
process.on('unhandledRejection', (error) => {
  console.error(chalk.red('\n❌ Unhandled error:'), error);
  process.exit(1);
});

// Run
main().catch((error) => {
  console.error(chalk.red('\n❌ Security audit failed:'), error.message);
  if (process.argv.includes('--verbose')) {
    console.error(error);
  }
  process.exit(1);
});
