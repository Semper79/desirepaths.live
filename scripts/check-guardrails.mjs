#!/usr/bin/env node
/**
 * Mechanical enforcement of the non-negotiable guardrails in CLAUDE.md (section 0 of
 * the specification).
 *
 * WHY A SCRIPT AND NOT A POLICY DOCUMENT
 * "We agreed not to do that" survives exactly as long as the person who remembers the
 * agreement. A grep in CI survives a handover, a contractor, and a 3am incident where
 * somebody reasons that rotating proxies is fine "just to unblock the crawler". The
 * point is not that the check is clever - it is that removing it requires deleting a
 * file, which is visible in review, rather than quietly not doing the right thing.
 *
 * Deliberately conservative about false positives: a comment explaining why MORPH does
 * NOT do something must not fail the build, so any line carrying the marker
 * `guardrail-ok` is exempt, and matches inside documentation are reported as warnings
 * rather than failures.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.turbo',
  'dist',
  '.next',
  'coverage',
  'playwright-report',
]);

const CODE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.yml',
  '.yaml',
  '.sql',
]);

/**
 * Each rule names the forbidden capability, not merely a forbidden word. The patterns
 * target the shape of an implementation - a dependency, a config key, an API call -
 * rather than the topic, so that writing *about* the rule stays possible.
 */
const RULES = [
  {
    id: 'no-proxy-rotation',
    description: 'Proxy or IP rotation aimed at evading platform enforcement.',
    patterns: [
      /\b(?:rotating|residential|datacenter)[-_ ]?prox(?:y|ies)\b/i,
      /\bproxy[-_]?(?:pool|rotator|rotation)\b/i,
      /\bhttps?-proxy-agent\b/,
      /\bluminati|brightdata|smartproxy|oxylabs\b/i,
    ],
  },
  {
    id: 'no-captcha-solving',
    description: 'CAPTCHA-solving services.',
    patterns: [/\b2captcha|anti-?captcha|capmonster|deathbycaptcha\b/i, /\bsolveCaptcha\b/],
  },
  {
    id: 'no-fingerprint-spoofing',
    description: 'Browser fingerprint spoofing and automation-detection evasion.',
    patterns: [
      /\bpuppeteer-extra-plugin-stealth\b/,
      /\bplaywright-stealth\b/,
      /\bnavigator\.webdriver\s*=/,
      /\bspoofFingerprint|fingerprint[-_ ]?spoof/i,
      /\bundetected[-_]?chromedriver\b/i,
    ],
  },
  {
    id: 'no-credential-storage',
    description: 'Storing a social platform password. OAuth tokens only, encrypted.',
    patterns: [
      /\b(?:instagram|tiktok|twitter|reddit|discord|youtube|meta)[-_ ]?password\b/i,
      /\bplatformPassword\b/,
    ],
  },
  {
    id: 'no-engagement-automation',
    description: 'Follow/unfollow churn, mass DMs, engagement pods, comment spraying.',
    patterns: [
      /\b(?:auto|mass)[-_ ]?(?:follow|unfollow|dm|like|comment)\b/i,
      /\bfollow[-_ ]?unfollow\b/i,
      /\bengagement[-_ ]?pod\b/i,
      /\bhashtag[-_ ]?stuff/i,
    ],
  },
  {
    id: 'no-account-creation',
    description: 'Automated creation of social media accounts.',
    patterns: [
      /\bcreate(?:Social)?Account\s*\(/i,
      /\bregisterPlatformAccount\b/i,
      /\baccount[-_ ]?generator\b/i,
    ],
  },
  {
    id: 'no-robots-bypass',
    description: 'Ignoring robots.txt.',
    patterns: [
      /\bignore[-_ ]?robots\b/i,
      /\brobots\s*[:=]\s*false\b/i,
      /\bskipRobots\b/i,
      /\bobeyRobots\s*[:=]\s*false/i,
    ],
  },
  {
    id: 'no-humanisation-jitter',
    description: 'Timing jitter whose purpose is to look non-automated.',
    patterns: [/\bhumanize[-_ ]?(?:delay|jitter|timing)\b/i, /\bhuman[-_ ]?like[-_ ]?delay\b/i],
  },
];

const EXEMPT_MARKER = 'guardrail-ok';

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      yield* walk(full);
    } else {
      yield full;
    }
  }
}

const failures = [];
const warnings = [];

for (const file of walk(repoRoot)) {
  const relPath = relative(repoRoot, file).split(sep).join('/');

  // The checker itself names every forbidden capability by definition.
  if (relPath === 'scripts/check-guardrails.mjs') continue;

  const ext = extname(file);
  const isDoc = ext === '.md' || relPath.startsWith('docs/');
  if (!CODE_EXTENSIONS.has(ext) && !isDoc) continue;

  const lines = readFileSync(file, 'utf8').split('\n');

  lines.forEach((line, index) => {
    if (line.includes(EXEMPT_MARKER)) return;

    for (const rule of RULES) {
      for (const pattern of rule.patterns) {
        if (!pattern.test(line)) continue;
        const finding = {
          rule: rule.id,
          description: rule.description,
          file: relPath,
          line: index + 1,
          text: line.trim().slice(0, 160),
        };
        if (isDoc) warnings.push(finding);
        else failures.push(finding);
        return;
      }
    }
  });
}

const c = { reset: '[0m', bold: '[1m', red: '[31m', yellow: '[33m', green: '[32m', dim: '[2m' };

for (const w of warnings) {
  process.stdout.write(
    `${c.yellow}note${c.reset} ${w.file}:${String(w.line)} mentions ${w.rule} in prose. ` +
      `${c.dim}Expected in documentation that explains the rule.${c.reset}\n`,
  );
}

if (failures.length > 0) {
  process.stderr.write(`\n${c.red}${c.bold}Forbidden capability found in source.${c.reset}\n\n`);
  for (const f of failures) {
    process.stderr.write(
      `  ${c.bold}${f.rule}${c.reset} — ${f.description}\n` +
        `    ${f.file}:${String(f.line)}\n` +
        `    ${c.dim}${f.text}${c.reset}\n\n`,
    );
  }
  process.stderr.write(
    `${c.dim}These are hard constraints from CLAUDE.md. If a match is a genuine false\n` +
      `positive, add the marker "${EXEMPT_MARKER}" to the line with a comment explaining\n` +
      `why - and expect that comment to be read carefully in review.${c.reset}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `${c.green}✓${c.reset} No forbidden capabilities found across ${String(RULES.length)} rules.\n`,
);
