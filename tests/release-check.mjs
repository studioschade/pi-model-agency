#!/usr/bin/env node
// Preflight only; never authenticates or publishes. CI runs this before npm publish.
import { existsSync, readFileSync } from 'node:fs';
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const tag = process.env.RELEASE_TAG;
const fail = (message) => { console.error(`FAIL release:check — ${message}`); process.exit(1); };
if (!tag || !/^v\d+\.\d+\.\d+$/.test(tag)) fail('expected an exact stable vMAJOR.MINOR.PATCH RELEASE_TAG');
if (tag !== `v${pkg.version}`) fail(`tag ${tag} does not equal package version v${pkg.version}`);
if (pkg.private !== false) fail('package is private; publishing is disabled');
if (pkg.license !== 'GPL-3.0-only') fail('license must be GPL-3.0-only');
const licensePath = new URL('../LICENSE', import.meta.url);
if (!existsSync(licensePath) || !readFileSync(licensePath, 'utf8').trim()) fail('LICENSE missing or empty');
if (pkg.name !== 'pi-model-agency') fail('package name differs from the approved release plan; review workflow and OIDC binding');
console.log(`PASS release:check — ${pkg.name}@${pkg.version} / ${tag} / ${pkg.license}`);
