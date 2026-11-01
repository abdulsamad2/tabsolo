#!/usr/bin/env node
'use strict';

/**
 * GitHub release helper for auto-update publishing.
 *
 *   node scripts/release.js prepare   — creates a *draft* release v<version> if none exists
 *   node scripts/release.js finalize  — publishes that draft so installed apps pick it up
 *
 * Why: electron-builder publishes each platform/arch in parallel, and when the release doesn't
 * exist yet they race to create it (GitHub answers 422 "Published releases must have a valid
 * tag"). Pre-creating a draft avoids that, and keeping it a draft until every artefact is uploaded
 * means users never see a half-uploaded release.
 *
 * Needs GH_TOKEN (classic "repo" scope, or fine-grained "contents: write") — loaded from
 * .env.local by the npm scripts.
 */

const pkg = require('../package.json');

const publish = [].concat(pkg.build?.publish ?? []).find((p) => p.provider === 'github');
if (!publish) fail('No GitHub publish provider configured in package.json "build.publish".');
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!token) fail('GH_TOKEN is not set. Add it to .env.local (see .env.example).');

const repoUrl = `https://api.github.com/repos/${publish.owner}/${publish.repo}`;
const tag = `v${pkg.version}`;

function fail(message) {
  process.stderr.write(`release: ${message}\n`);
  process.exit(1);
}

async function api(method, path, body) {
  const response = await fetch(`${repoUrl}${path}`, {
    method,
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) fail(`${method} ${path} → ${response.status} ${data?.message ?? ''} ${JSON.stringify(data?.errors ?? '')}`);
  return data;
}

/** Drafts aren't reachable via /releases/tags/:tag, so scan the list instead. */
async function findRelease() {
  for (let page = 1; page <= 10; page++) {
    const releases = await api('GET', `/releases?per_page=100&page=${page}`);
    const match = releases.find((r) => r.tag_name === tag);
    if (match || releases.length < 100) return match ?? null;
  }
  return null;
}

/** Semver order, a prerelease before its release (0.2.0-beta.3 < 0.2.0); returns >0 when a is newer. */
function compareVersions(a, b) {
  const parse = (v) => {
    const [core, ...pre] = v.replace(/^v/, '').split('-');
    return { core: core.split('.').map(Number), pre: pre.join('-') };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const diff = (pa.core[i] || 0) - (pb.core[i] || 0);
    if (diff) return diff;
  }
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  return pa.pre.localeCompare(pb.pre, undefined, { numeric: true });
}

async function prepare() {
  const existing = await findRelease();
  if (existing) {
    if (!existing.draft) {
      fail(`${tag} is already published. Bump "version" in package.json before releasing again.`);
    }
    process.stdout.write(`release: reusing draft ${tag}\n`);
    return;
  }
  const latest = await fetch(`${repoUrl}/releases/latest`, { headers: { Authorization: `token ${token}` } })
    .then((r) => (r.ok ? r.json() : null));
  if (latest && compareVersions(tag, latest.tag_name) <= 0) {
    fail(`${tag} is not newer than the latest published release ${latest.tag_name}; installed apps would ignore it.`);
  }
  const { default_branch: branch } = await api('GET', '');
  await api('POST', '/releases', {
    tag_name: tag,
    target_commitish: branch,
    name: pkg.version,
    draft: true,
    generate_release_notes: true,
  });
  process.stdout.write(`release: created draft ${tag} on ${branch}\n`);
}

async function finalize() {
  const release = await findRelease();
  if (!release) fail(`No release found for ${tag}. Run "prepare" first.`);
  const names = release.assets.map((a) => a.name);
  // A beta version writes beta*.yml instead of latest*.yml.
  const manifests = names.filter((n) => /^(latest|beta|alpha)(-mac|-linux)?\.yml$/.test(n));
  if (manifests.length === 0) {
    fail(`${tag} has no update manifest (latest*.yml / beta*.yml) — the build/upload must have failed. Not publishing.`);
  }
  if (release.draft) {
    await api('PATCH', `/releases/${release.id}`, { draft: false, make_latest: 'true' });
  }
  process.stdout.write(`release: published ${tag} with ${names.length} assets (${manifests.join(', ')})\n`);
  process.stdout.write(`release: https://github.com/${publish.owner}/${publish.repo}/releases/tag/${tag}\n`);
}

const command = process.argv[2];
const run = { prepare, finalize }[command];
if (!run) fail('usage: node scripts/release.js <prepare|finalize>');
run().catch((error) => fail(error.stack || String(error)));
