#!/usr/bin/env node
// Asserts the npm tarball contains exactly the intended allowlist. By default
// package MUST stay private; RELEASE=1 requires approved public metadata + LICENSE.
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const release = process.env.RELEASE === '1';
const ALLOWED = new Set(['extension.ts', 'README.md', 'package.json', 'LICENSE']);
const FORBIDDEN = [/^tests\//, /^DESIGN\.md$/, /^project\.md$/, /^SESSION-HANDOFF/, /^\.git/, /^node_modules\//];

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
if (release ? (pkg.private !== false || pkg.license !== 'GPL-3.0-only' || !existsSync(new URL('../LICENSE', import.meta.url))) : pkg.private !== true) {
  console.error(`FAIL pack:check — ${release ? 'release requires private:false and GPL-3.0-only LICENSE' : 'package must stay private until release approval'}`);
  process.exit(1);
}

const r = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  cwd: new URL('../', import.meta.url), encoding: 'utf8',
});
if (r.status !== 0) {
  console.error(r.stdout, r.stderr);
  process.exit(1);
}
// npm <=11 prints an array of packs; npm 12 prints an object keyed by package name.
const packed = JSON.parse(r.stdout);
const files = (Array.isArray(packed) ? packed : Object.values(packed)).flatMap((p) => p.files.map((f) => f.path)).sort();
const disallowed = files.filter((f) => !ALLOWED.has(f));
const sensitive = files.filter((f) => FORBIDDEN.some((re) => re.test(f)));
const missing = [...ALLOWED].filter((f) => !files.includes(f));
if (disallowed.length || sensitive.length || missing.length) {
  if (missing.length) console.error('FAIL pack:check — required files missing:', missing.join(', '));
  if (sensitive.length) console.error('FAIL pack:check — sensitive files in tarball:', sensitive.join(', '));
  if (disallowed.length) console.error('FAIL pack:check — files outside allowlist:', disallowed.join(', '));
  process.exit(1);
}
console.log(`PASS pack:check — ${release ? 'release metadata' : 'private:true'}, tarball allowlist (${files.length}): ${files.join(', ')}`);
