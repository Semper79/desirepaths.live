#!/usr/bin/env node
/**
 * `make bootstrap` / `pnpm bootstrap`
 *
 * Section 7 of the specification: "Provide a `make bootstrap` that brings the whole
 * stack up locally with seeded data in one command."
 *
 * This is that command. It is written in Node rather than in the Makefile because
 * the operator develops on Windows, where `make` is not present, and a bootstrap
 * that only works on one of the two machines the project is built on is not a
 * bootstrap. The Makefile targets are thin wrappers around this file, so the two
 * cannot drift.
 *
 * Every step is idempotent. Running it twice on a healthy stack does nothing and
 * says so.
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const composeFile = join(repoRoot, 'infra', 'docker-compose.yml');

const c = {
  reset: '[0m',
  bold: '[1m',
  dim: '[2m',
  red: '[31m',
  green: '[32m',
  yellow: '[33m',
  blue: '[34m',
};

let stepNumber = 0;
const step = (title) => {
  stepNumber += 1;
  process.stdout.write(`\n${c.bold}${c.blue}[${stepNumber}] ${title}${c.reset}\n`);
};
const ok = (message) => process.stdout.write(`    ${c.green}✓${c.reset} ${message}\n`);
const warn = (message) => process.stdout.write(`    ${c.yellow}!${c.reset} ${message}\n`);
const info = (message) => process.stdout.write(`    ${c.dim}${message}${c.reset}\n`);

function fail(message, remedy) {
  process.stderr.write(`\n${c.red}${c.bold}Bootstrap stopped:${c.reset} ${message}\n`);
  if (remedy) process.stderr.write(`${c.dim}${remedy}${c.reset}\n`);
  process.exit(1);
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: repoRoot,
    stdio: options.quiet ? 'pipe' : 'inherit',
    encoding: 'utf8',
    shell: process.platform === 'win32',
    ...options,
  });
}

function have(command, args = ['--version']) {
  const result = run(command, args, { quiet: true });
  return result.status === 0;
}

// -----------------------------------------------------------------------------
step('Checking prerequisites');
// -----------------------------------------------------------------------------

const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
if (nodeMajor < 22) {
  fail(
    `Node ${process.versions.node} is too old; MORPH needs 22 or newer.`,
    'Install it with `nvm install` (the version is pinned in .nvmrc).',
  );
}
ok(`Node ${process.versions.node}`);

if (!have('docker')) {
  fail(
    'Docker is not available on PATH.',
    'Install Docker Desktop (macOS/Windows) or the Docker Engine (Linux), then re-run.\n' +
      'Everything except the data plane still works without it: `pnpm test` covers\n' +
      '@morph/core, @morph/adaptive and @morph/telegram, which are pure.',
  );
}
ok('Docker');

const composeProbe = run('docker', ['compose', 'version'], { quiet: true });
if (composeProbe.status !== 0) {
  fail(
    '`docker compose` is not available.',
    'Docker Compose v2 ships with Docker Desktop and recent Docker Engine builds.',
  );
}
ok('Docker Compose v2');

// -----------------------------------------------------------------------------
step('Preparing the environment file');
// -----------------------------------------------------------------------------

const envPath = join(repoRoot, '.env');
const examplePath = join(repoRoot, '.env.example');

if (!existsSync(envPath)) {
  copyFileSync(examplePath, envPath);
  ok('Created .env from .env.example');
} else {
  ok('.env already exists; leaving it alone');
}

// A placeholder pepper in a local stack is fine; a placeholder pepper in anything
// reachable is a privacy incident. Generate a real one on first run so nobody has
// to remember to, and so the placeholder never becomes the production value.
const envText = readFileSync(envPath, 'utf8');
if (envText.includes('ANON_ID_PEPPER=replace-with-openssl-rand-hex-32')) {
  const { writeFileSync } = await import('node:fs');
  const pepper = randomBytes(32).toString('hex');
  writeFileSync(envPath, envText.replace('replace-with-openssl-rand-hex-32', pepper));
  ok('Generated a unique ANON_ID_PEPPER');
} else {
  info('ANON_ID_PEPPER already set');
}

// Report anything still holding a placeholder, without printing the values.
const placeholders = readFileSync(envPath, 'utf8')
  .split('\n')
  .filter((line) => /^[A-Z0-9_]+=(replace-me|change-me|sk-ant-replace-me)\s*$/.test(line))
  .map((line) => line.split('=')[0]);

if (placeholders.length > 0) {
  warn(
    `Still placeholders (fine for local, not for anything reachable): ${placeholders.join(', ')}`,
  );
}

// -----------------------------------------------------------------------------
step('Installing workspace dependencies');
// -----------------------------------------------------------------------------

const execPath = process.env.npm_execpath;
const install = execPath
  ? run(process.execPath, [execPath, 'install', '--frozen-lockfile'])
  : run('pnpm', ['install', '--frozen-lockfile']);

if (install.status !== 0) fail('Dependency installation failed.');
ok('Dependencies installed');

// -----------------------------------------------------------------------------
step('Starting the data plane');
// -----------------------------------------------------------------------------

// Only the stateful services. The application containers are started separately so
// a failing app build does not leave the developer without a database.
const dataServices = ['postgres', 'clickhouse', 'redis', 'redpanda'];
const up = run('docker', ['compose', '-f', composeFile, 'up', '-d', '--wait', ...dataServices]);
if (up.status !== 0) {
  fail(
    'The data plane did not come up healthy.',
    `Inspect it with:  docker compose -f ${composeFile} logs --tail=100`,
  );
}
ok('Postgres, ClickHouse, Redis and Redpanda are healthy');

// -----------------------------------------------------------------------------
step('Applying migrations');
// -----------------------------------------------------------------------------

const migrate = execPath
  ? run(process.execPath, [execPath, '--filter', '@morph/core', 'run', 'db:migrate'])
  : run('pnpm', ['--filter', '@morph/core', 'run', 'db:migrate']);

if (migrate.status !== 0) {
  fail(
    'Postgres migrations failed.',
    'The ClickHouse schema is applied by its own init scripts on first boot.',
  );
}
ok('Postgres schema up to date');

// -----------------------------------------------------------------------------
step('Seeding');
// -----------------------------------------------------------------------------

// The seed loads the hand-authored surface registry into the `variant` table and
// generates a fortnight of synthetic behaviour, so the adaptive engine and the
// hourly report have something to be about on a fresh machine.
const seed = execPath
  ? run(process.execPath, [execPath, '--filter', '@morph/worker', 'run', 'seed'])
  : run('pnpm', ['--filter', '@morph/worker', 'run', 'seed']);

if (seed.status !== 0) {
  warn('Seeding failed or is not implemented yet; the stack is up but empty.');
} else {
  ok('Seeded surfaces, variants and two weeks of synthetic behaviour');
}

// -----------------------------------------------------------------------------
process.stdout.write(
  [
    '',
    `${c.green}${c.bold}MORPH is up.${c.reset}`,
    '',
    `  site        ${c.bold}http://localhost:3000${c.reset}`,
    `  admin       ${c.bold}http://localhost:3002${c.reset}`,
    `  grafana     ${c.bold}http://localhost:3009${c.reset}  ${c.dim}(admin / see GRAFANA_ADMIN_PASSWORD)${c.reset}`,
    `  clickhouse  ${c.dim}http://localhost:8123${c.reset}`,
    '',
    `  ${c.dim}pnpm dev            start the apps with hot reload${c.reset}`,
    `  ${c.dim}pnpm sim            run the bandit convergence harness${c.reset}`,
    `  ${c.dim}pnpm report:sample  print a worked hourly report${c.reset}`,
    `  ${c.dim}make down           stop everything (data volumes are kept)${c.reset}`,
    '',
  ].join('\n'),
);
