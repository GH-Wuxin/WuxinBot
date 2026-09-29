// profile-store-migration-verify.mjs — M01 contract and regression checks.
// All migration inputs are synthetic temporary files.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertNotProduction,
  cleanupTestDir,
  createTestDataDir,
} from './test-isolation.mjs';

let passed = 0;
let failed = 0;

function check(condition, message, detail = '') {
  if (condition) {
    console.log(`PASS [${message}]`);
    passed++;
  } else {
    console.error(`FAIL [${message}] ${detail}`);
    failed++;
  }
}

const dataDirA = createTestDataDir('wuxin-profile-migration-a');
const dataDirB = fs.mkdtempSync(path.join(os.tmpdir(), 'wuxin-profile-migration-b-'));
const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wuxin-profile-migration-source-'));
assertNotProduction(dataDirA);
assertNotProduction(dataDirB);
assertNotProduction(sourceDir);

const sourcePath = path.join(sourceDir, 'legacy-profiles.json');
const destinationA = path.join(dataDirA, 'osu-console-profiles.json');
const destinationB = path.join(dataDirB, 'osu-console-profiles.json');
const fixture = {
  '123456': {
    profile: { fetchedAt: '2026-09-29T00:00:00.000Z', user: { id: 123456, username: 'synthetic-player' } },
    analysis: { status: 'done', text: 'synthetic analysis' },
  },
};
fs.writeFileSync(sourcePath, JSON.stringify(fixture, null, 2) + '\n', 'utf8');
const sourceBefore = fs.readFileSync(sourcePath);

try {
  const {
    getStoredProfile,
    migrateLegacyProfiles,
  } = await import('../server/osu/profileStore.ts');

  // Ordinary reads must not import the checkout-relative legacy file.
  check(getStoredProfile(123456) === null, 'ordinary load starts empty');
  check(!fs.existsSync(destinationA), 'ordinary load does not create a migrated store');

  const migrated = migrateLegacyProfiles({ source: sourcePath, destination: destinationA });
  check(migrated.ok && migrated.status === 'migrated', 'explicit migration succeeds');
  check(fs.existsSync(destinationA), 'explicit migration creates destination');
  check(sourceBefore.equals(fs.readFileSync(sourcePath)), 'source is preserved');
  check(getStoredProfile(123456)?.user?.username === 'synthetic-player', 'migrated profile is readable');

  const destinationPayload = JSON.parse(fs.readFileSync(destinationA, 'utf8'));
  check(
    destinationPayload.__wuxin_profile_store_meta__?.migration?.sourceSha256 === migrated.sourceSha256,
    'migration source digest is recorded',
  );

  // A second DATA_DIR must not see A, and explicit migration into A is idempotent.
  process.env.DATA_DIR = dataDirB;
  check(getStoredProfile(123456) === null, 'second data root remains empty');
  check(!fs.existsSync(destinationB), 'second data root has no implicit store');
  const repeated = migrateLegacyProfiles({ source: sourcePath, destination: destinationA });
  check(repeated.ok && repeated.status === 'already_migrated', 'repeat migration is idempotent');

  // A non-empty destination is never overwritten.
  const occupied = path.join(dataDirB, 'occupied.json');
  const occupiedPayload = { '999999': { profile: { fetchedAt: '2026-01-01T00:00:00.000Z', user: { id: 999999 } } } };
  fs.writeFileSync(occupied, JSON.stringify(occupiedPayload), 'utf8');
  const occupiedBefore = fs.readFileSync(occupied);
  const refused = migrateLegacyProfiles({ source: sourcePath, destination: occupied });
  check(!refused.ok && refused.status === 'destination_not_empty', 'non-empty destination is refused');
  check(occupiedBefore.equals(fs.readFileSync(occupied)), 'refused destination is unchanged');

  // Invalid source data is rejected before any destination is created.
  const invalidSource = path.join(sourceDir, 'invalid.json');
  const invalidDestination = path.join(dataDirB, 'invalid-target.json');
  fs.writeFileSync(invalidSource, '[]', 'utf8');
  const invalid = migrateLegacyProfiles({ source: invalidSource, destination: invalidDestination });
  check(!invalid.ok && invalid.status === 'invalid_source', 'invalid source is rejected');
  check(!fs.existsSync(invalidDestination), 'invalid source leaves destination absent');

  // Existing empty destinations are safe to fill explicitly.
  const emptyDestination = path.join(dataDirB, 'empty-target.json');
  fs.writeFileSync(emptyDestination, '{}', 'utf8');
  const filled = migrateLegacyProfiles({ source: sourcePath, destination: emptyDestination });
  check(filled.ok && filled.status === 'migrated', 'empty destination can be migrated');

  const samePath = migrateLegacyProfiles({ source: sourcePath, destination: sourcePath });
  check(!samePath.ok && samePath.status === 'invalid_request', 'same source and destination are refused');
} finally {
  cleanupTestDir(dataDirA);
  cleanupTestDir(dataDirB);
  cleanupTestDir(sourceDir);
}

console.log(`\nPROFILE-STORE-MIGRATION-VERIFY: passed=${passed} failed=${failed}`);
process.exit(failed > 0 ? 1 : 0);
