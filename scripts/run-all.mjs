#!/usr/bin/env node
/**
 * Run one package script across every workspace package, without depending on the
 * package manager being on PATH.
 *
 * WHY THIS EXISTS
 * `turbo run <task>` is the canonical runner and what CI uses. It shells out to the
 * package manager by name, which fails on a machine where `corepack enable` was
 * refused (Windows without admin rights is the common case) and pnpm is only
 * reachable as `corepack pnpm`. Rather than telling a developer their environment is
 * wrong, this script re-invokes whatever binary actually launched it, via
 * `npm_execpath`, so `node scripts/run-all.mjs typecheck` works everywhere.
 *
 * It is deliberately dumb: sequential, no caching, no dependency graph. Turbo does
 * all of that properly. This is the escape hatch, not the road.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const task = process.argv[2];

if (!task) {
  process.stderr.write('usage: node scripts/run-all.mjs <script-name>\n');
  process.exit(2);
}

/** Every workspace package that actually defines the requested script. */
function workspacePackages() {
  const found = [];
  for (const group of ['packages', 'apps']) {
    const groupDir = join(repoRoot, group);
    if (!existsSync(groupDir)) continue;
    for (const name of readdirSync(groupDir)) {
      const manifestPath = join(groupDir, name, 'package.json');
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (manifest.scripts?.[task]) {
        found.push({ dir: join(groupDir, name), name: manifest.name ?? `${group}/${name}` });
      }
    }
  }
  return found;
}

const execPath = process.env.npm_execpath;
const packages = workspacePackages();

if (packages.length === 0) {
  process.stdout.write(`No workspace package defines a "${task}" script.\n`);
  process.exit(0);
}

let failures = 0;

for (const pkg of packages) {
  process.stdout.write(`\n[1m→ ${pkg.name}: ${task}[0m\n`);

  // Re-invoke the same package manager that launched this process. When that is
  // unavailable, fall back to `npm`, which is always present alongside Node.
  const result = execPath
    ? spawnSync(process.execPath, [execPath, 'run', task], {
        cwd: pkg.dir,
        stdio: 'inherit',
        env: process.env,
      })
    : spawnSync('npm', ['run', task], { cwd: pkg.dir, stdio: 'inherit', shell: true });

  if (result.status !== 0) {
    failures += 1;
    process.stderr.write(`[31m✗ ${pkg.name} failed ${task}[0m\n`);
  }
}

if (failures > 0) {
  process.stderr.write(`\n${String(failures)} package(s) failed "${task}".\n`);
  process.exit(1);
}

process.stdout.write(`\n[32m✓ ${task} passed in ${String(packages.length)} package(s).[0m\n`);
