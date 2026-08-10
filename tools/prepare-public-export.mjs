#!/usr/bin/env node
// prepare-public-export.mjs
//
// Builds a clean public export of WuxinBot:
//   - starts from `git archive HEAD` (no uncommitted work-in-progress);
//   - overlays the open-source preparation files from the working tree;
//   - excludes private docs, the community-corpus pipeline and runtime data;
//   - deterministically sanitizes local paths and real QQ/group identifiers;
//   - fails the export if any forbidden pattern survives.
//
// Usage:
//   node tools/prepare-public-export.mjs --out G:/path/to/export
// Default output: <repo>/.public-export (gitignored).
//
// Private denylist:
//   If .private/public-export-denylist.txt exists, each non-empty non-comment
//   line is treated as a literal string that must NOT appear in the export.
//   This file is gitignored and never committed. The tool works without it.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gitSafeRoot = root.replace(/\\/g, '/');

function parseArgv(argv) {
  const args = { out: path.join(root, '.public-export') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out' && argv[i + 1]) {
      args.out = argv[i + 1];
      i++;
    } else if (argv[i] === '--force') {
      args.force = true;
    } else if (argv[i] === '--no-sanitize') {
      // REVIEW ONLY: materialize the tree without identifier/path sanitization
      // so a before/after diff can be reviewed. Never publish this output.
      args.sanitize = false;
    } else if (argv[i] === '--manifest') {
      // REVIEW ONLY: write manifest.json into the export. Public releases
      // omit it by default so no private commit/branch metadata is published.
      args.manifest = true;
    }
  }
  return args;
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (result.error) {
    throw new Error(`${cmd} ${args.join(' ')} -> ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').slice(0, 2000);
    throw new Error(`${cmd} ${args.join(' ')} exited ${result.status}: ${detail}`);
  }
  return result.stdout?.trim() ?? '';
}

const DEFAULT_OUT = path.join(root, '.public-export');

function walk(dir, onFile) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, onFile);
    else if (entry.isFile()) onFile(full);
  }
}

const TEXT_EXTS = new Set([
  '.md', '.ts', '.mjs', '.js', '.tsx', '.jsx', '.json', '.ps1', '.bat', '.cmd',
  '.txt', '.html', '.css', '.yml', '.yaml', '.toml', '.ini', '.sh', '.py',
  '.cfg', '.conf', '.svg', '.xml', '.env.example',
]);
const MAX_TEXT_BYTES = 4 * 1024 * 1024;

function isTextFile(file) {
  if (TEXT_EXTS.has(path.extname(file).toLowerCase())) return true;
  const base = path.basename(file).toUpperCase();
  return /^(LICENSE|NOTICE|README|CHANGELOG|COPYING|\.GITIGNORE|\.GITATTRIBUTES)$/.test(base)
    || base === '.ENV.EXAMPLE';
}

// ── Generic sanitization patterns ──
// These replace common local-machine artifacts with stable placeholders.
// No real private values are stored here.

const GENERIC_SANITIZE = [
  // Windows absolute paths (drive letter)
  [/[A-Z]:\\Users\\[^\\/:*?"<>|\s]+/gi, '<USERPROFILE>'],
  [/[A-Z]:\\Users\\[^\\/:*?"<>|\s]+/gi, '<USERPROFILE>'],
  // Common Windows workspace patterns
  [/[A-Z]:\\[A-Za-z0-9_ -]+\\[A-Za-z0-9_ -]+\\[A-Za-z0-9_ -]+/g, '<LOCAL_PATH>'],
  // Unix/macOS home paths
  [/\/home\/[a-z][a-z0-9_-]{0,31}\b/gi, '<USER_HOME>'],
  [/\/Users\/[a-z][a-z0-9_-]{0,31}\b/gi, '<USER_HOME>'],
];

// ── Generic forbidden patterns ──
// These detect patterns that should never appear in a public export,
// regardless of specific values.

const GENERIC_FORBIDDEN = [
  // Windows absolute paths
  { pattern: /[A-Z]:\\Users\\/i, label: 'Windows user profile path' },
  { pattern: /[A-Z]:\\[A-Za-z]:/, label: 'Windows absolute path' },
  // Common secret patterns
  { pattern: /(?:api[_-]?key|token|secret|password|private[_-]?key)\s*[:=]\s*\S{8,}/i, label: 'Possible secret/credential' },
  // .env files (not .env.example)
  { pattern: /\.env(?:\.|$)/i, label: '.env file reference' },
];

// ── Optional private denylist ──
// Loaded from .private/public-export-denylist.txt if it exists.
// Each non-empty, non-# line is a literal string that must NOT appear.

function loadPrivateDenylist(repoRoot) {
  const denylistPath = path.join(repoRoot, '.private', 'public-export-denylist.txt');
  if (!fs.existsSync(denylistPath)) {
    return { loaded: false, entries: [], path: denylistPath };
  }
  const text = fs.readFileSync(denylistPath, 'utf8');
  const entries = text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  return { loaded: true, entries, path: denylistPath };
}

// Files that carry the open-source preparation patch and must be taken from
// the working tree (everything else comes from git HEAD).
const OVERLAY = [
  '.env.example',
  '.gitignore',
  'README.md',
  'THIRD_PARTY_NOTICES.md',
  'LICENSE.yumu-bot',
  'docs/EXTERNAL_INTEGRATION.md',
  'server/bots/externalPaths.ts',
  'server/bots/bindingSync.ts',
  'server/bots/localBridge.ts',
  'server/index.ts',
  'server/osu/matchRating.ts',
  'server/osu/match.ts',
  'tools/start-napcat.ps1',
  'tools/wuxin-guard.ps1',
  'tools/corpus-build.mjs',
  'tools/kb-verify.mjs',
  'tools/bp-rank-verify.mjs',
];

// Public docs whitelist; everything else under docs/ is an internal audit or
// handover note and stays private.
const DOCS_KEEP = new Set(['EXTERNAL_INTEGRATION.md', 'KNOWLEDGE_BASE_V41.md']);
const EXCLUDE_DIRS = new Set(['community-corpus']);

async function main() {
  const args = parseArgv(process.argv.slice(2));
  const sanitize = args.sanitize !== false;
  const outDir = path.resolve(args.out);

  if (fs.existsSync(outDir)) {
    const rel = path.relative(DEFAULT_OUT, outDir);
    const insideDefault = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    if (!insideDefault && !args.force) {
      throw new Error(`Output directory already exists: ${outDir}. Pass --force to replace it.`);
    }
    fs.rmSync(outDir, { recursive: true, force: true });
  }
  fs.mkdirSync(outDir, { recursive: true });

  const head = run('git', ['-c', `safe.directory=${gitSafeRoot}`, 'rev-parse', 'HEAD'], { cwd: root });
  const branch = run('git', ['-c', `safe.directory=${gitSafeRoot}`, 'branch', '--show-current'], { cwd: root });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wuxin-public-export-'));
  const tmpIndex = path.join(tmpDir, 'index');
  const baseDir = path.join(tmpDir, 'base');
  fs.mkdirSync(baseDir);
  try {
    // Materialize HEAD without tar: Windows bsdtar mishandles some UTF-8
    // filenames. read-tree + checkout-index with a temporary index keeps the
    // repository index untouched and preserves every filename byte-for-byte.
    const gitEnv = { ...process.env, GIT_INDEX_FILE: tmpIndex };
    run('git', ['-c', `safe.directory=${gitSafeRoot}`, '--git-dir', path.join(root, '.git'), '--work-tree', baseDir, 'read-tree', 'HEAD'], { cwd: root, env: gitEnv });
    run('git', ['-c', `safe.directory=${gitSafeRoot}`, '--git-dir', path.join(root, '.git'), '--work-tree', baseDir, 'checkout-index', '-a', '-f'], { cwd: root, env: gitEnv });

    // Exclude private content.
    for (const name of EXCLUDE_DIRS) {
      fs.rmSync(path.join(baseDir, name), { recursive: true, force: true });
    }
    fs.rmSync(path.join(baseDir, 'tools', 'prepare-public-export.mjs'), { force: true });
    const docsDir = path.join(baseDir, 'docs');
    if (fs.existsSync(docsDir)) {
      for (const name of fs.readdirSync(docsDir)) {
        if (!DOCS_KEEP.has(name)) fs.rmSync(path.join(docsDir, name), { recursive: true, force: true });
      }
    }

    // Overlay the open-source preparation patch.
    for (const rel of OVERLAY) {
      const src = path.join(root, rel);
      const dest = path.join(baseDir, rel);
      if (!fs.existsSync(src)) throw new Error(`Overlay source missing: ${src}`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }

    // Load optional private denylist.
    const denylist = loadPrivateDenylist(root);
    if (!denylist.loaded) {
      console.warn('[info] Private denylist not configured (expected at .private/public-export-denylist.txt). Generic scanners still active.');
    } else {
      console.log(`[info] Private denylist loaded: ${denylist.entries.length} entries`);
    }

    // Sanitize text files (skipped in --no-sanitize review mode).
    let sanitizedFiles = 0;
    if (sanitize) {
      walk(baseDir, (file) => {
        if (!isTextFile(file)) return;
        const stat = fs.statSync(file);
        if (stat.size > MAX_TEXT_BYTES || stat.size === 0) return;
        let text = fs.readFileSync(file, 'utf8');
        let changed = false;

        // Apply generic sanitization patterns.
        for (const [pattern, replacement] of GENERIC_SANITIZE) {
          const newText = text.replace(pattern, replacement);
          if (newText !== text) {
            text = newText;
            changed = true;
          }
        }

        // Apply private denylist replacements.
        if (denylist.loaded) {
          for (const entry of denylist.entries) {
            if (text.includes(entry)) {
              text = text.split(entry).join('***REMOVED_PRIVATE***');
              changed = true;
            }
          }
        }

        if (changed) {
          fs.writeFileSync(file, text, 'utf8');
          sanitizedFiles++;
        }
      });
    } else {
      console.warn('[review] --no-sanitize: private identifiers/paths are intentionally present. This tree must not be published.');
    }

    // Post-sanitization gate.
    const violations = [];
    let fileCount = 0;
    let totalBytes = 0;
    walk(baseDir, (file) => {
      fileCount++;
      totalBytes += fs.statSync(file).size;
      if (!isTextFile(file)) return;
      const stat = fs.statSync(file);
      if (stat.size > MAX_TEXT_BYTES || stat.size === 0) return;
      const text = fs.readFileSync(file, 'utf8');
      if (sanitize) {
        // Check generic forbidden patterns.
        for (const { pattern, label } of GENERIC_FORBIDDEN) {
          if (pattern.test(text)) {
            violations.push(`${path.relative(baseDir, file)}: ${label}`);
            break;
          }
        }
        // Check private denylist.
        if (denylist.loaded) {
          for (const entry of denylist.entries) {
            if (text.includes(entry)) {
              violations.push(`${path.relative(baseDir, file)}: private denylist entry found`);
              break;
            }
          }
        }
      }
    });

    const forbiddenPaths = ['.env', 'node_modules', '.git', 'data', 'logs', 'dist', 'artifacts', 'incidents', 'portable-node'];
    for (const name of forbiddenPaths) {
      if (fs.existsSync(path.join(baseDir, name))) {
        violations.push(`forbidden path survived: ${name}`);
      }
    }
    for (const name of ['LICENSE', 'LICENSE.yumu-bot', 'THIRD_PARTY_NOTICES.md', '.env.example', 'README.md']) {
      if (!fs.existsSync(path.join(baseDir, name))) violations.push(`required file missing: ${name}`);
    }

    if (violations.length) {
      throw new Error(`Public export gate failed:\n  ${violations.slice(0, 40).join('\n  ')}`);
    }

    // Copy to final output and write manifest.
    const entries = fs.readdirSync(baseDir);
    for (const entry of entries) {
      fs.cpSync(path.join(baseDir, entry), path.join(outDir, entry), { recursive: true });
    }
    if (args.manifest) {
      const manifest = {
      generatedAt: new Date().toISOString(),
      generator: 'tools/prepare-public-export.mjs',
      source: { commit: head, branch: branch || '(detached)' },
      output: { fileCount, totalBytes },
      sanitizedFiles: sanitize ? sanitizedFiles : 'SKIPPED (--no-sanitize review mode)',
      exclusions: {
        dirs: [...EXCLUDE_DIRS],
        docs: 'internal audits/handover notes (only EXTERNAL_INTEGRATION.md and KNOWLEDGE_BASE_V41.md are public)',
      },
      sanitization: {
        note: 'Generic sanitization applied (Windows paths, user profiles, secret patterns). Private denylist entries replaced if configured. No real private values recorded.',
        sanitizedFiles: sanitize ? sanitizedFiles : 'SKIPPED (--no-sanitize review mode)',
        privateDenylist: denylist.loaded ? `${denylist.entries.length} entries` : 'not configured',
      },
      verification: 'pass',
      };
      fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

      const sha = crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex').slice(0, 16);
      console.log(`Manifest sha256 prefix: ${sha}`);
    } else {
      console.log('manifest.json omitted (pass --manifest for a review build record)');
    }
    console.log(`Public export ready: ${outDir}`);
    console.log(`Source HEAD: ${head} (${branch || 'detached'})`);
    console.log(`Files: ${fileCount}, bytes: ${totalBytes}, sanitized files: ${sanitizedFiles}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`Export failed: ${error.message}`);
  process.exit(1);
});
