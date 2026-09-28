import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { extractFile, getRawHeader } from '@electron/asar';
import { Pickle } from '@electron/asar/lib/pickle.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktopFiles = ['main.mjs', 'process-manager.mjs', 'process-inspection.mjs'];

function digest(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function hashRange(filename, start, end) {
  const hash = crypto.createHash('sha256');
  if (end >= start) {
    for await (const chunk of fs.createReadStream(filename, { start, end })) hash.update(chunk);
  }
  return hash.digest('hex');
}

export async function patchDesktopArchive({ sourceArchive, targetArchive, sourceRoot = repoRoot }) {
  assert.notEqual(path.resolve(sourceArchive), path.resolve(targetArchive));
  const before = getRawHeader(sourceArchive);
  const header = structuredClone(before.header);
  assert.ok(header.files.desktop?.files && header.files['package.json']);
  const originalOffset = 8 + before.headerSize;
  const stat = await fsp.stat(sourceArchive);
  const originalPayloadSize = stat.size - originalOffset;
  assert.ok(originalPayloadSize > 0);
  let appendedSize = 0;
  const sources = [];
  for (const filename of desktopFiles) {
    const source = await fsp.readFile(path.join(sourceRoot, 'desktop', filename));
    const hash = digest(source);
    header.files.desktop.files[filename] = {
      size: source.length, offset: String(originalPayloadSize + appendedSize),
      integrity: { algorithm: 'SHA256', hash, blockSize: 4 * 1024 * 1024, blocks: [hash] },
    };
    sources.push({ filename, source, hash });
    appendedSize += source.length;
  }
  const headerPickle = Pickle.createEmpty();
  headerPickle.writeString(JSON.stringify(header));
  const headerBuffer = headerPickle.toBuffer();
  const sizePickle = Pickle.createEmpty();
  sizePickle.writeUInt32(headerBuffer.length);
  const originalHash = crypto.createHash('sha256');
  async function* content() {
    yield sizePickle.toBuffer();
    yield headerBuffer;
    for await (const chunk of fs.createReadStream(sourceArchive, { start: originalOffset })) {
      originalHash.update(chunk);
      yield chunk;
    }
    for (const item of sources) yield item.source;
  }
  await pipeline(Readable.from(content()), fs.createWriteStream(targetArchive, { flags: 'wx' }));
  const after = getRawHeader(targetArchive);
  const unchangedHeader = structuredClone(after.header);
  unchangedHeader.files.desktop = structuredClone(before.header.files.desktop);
  assert.deepEqual(unchangedHeader, before.header, 'unrelated archive metadata must remain identical');
  const payloadHash = originalHash.digest('hex');
  const newOffset = 8 + after.headerSize;
  assert.equal(await hashRange(targetArchive, newOffset, newOffset + originalPayloadSize - 1), payloadHash, 'original archive payload must remain byte-exact');
  for (const { filename, source } of sources) assert.deepEqual(extractFile(targetArchive, path.join('desktop', filename)), source);
  return { originalHeaderHash: digest(Buffer.from(before.headerString)), payloadHash, originalPayloadSize, appendedSize, files: sources.map(({ filename, hash }) => ({ filename, sha256: hash })) };
}

export async function activatePreparedFix(result) {
  const resources = await fsp.realpath(result.resources);
  const archive = path.join(resources, 'app.asar');
  const installedRenderer = path.join(resources, 'app.asar.unpacked', 'dist');
  for (const target of [result.stagedArchive, result.stagedRenderer, result.backup, installedRenderer]) {
    const resolved = await fsp.realpath(target);
    const relative = path.relative(resources, resolved);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'patch targets must stay within the installed resources directory');
  }
  const current = getRawHeader(archive);
  assert.equal(digest(Buffer.from(current.headerString)), result.originalHeaderHash, 'the installed archive changed after this patch was prepared');
  const archiveStat = await fsp.stat(archive);
  assert.equal(archiveStat.size - 8 - current.headerSize, result.originalPayloadSize);
  assert.equal(await hashRange(archive, 8 + current.headerSize, archiveStat.size - 1), result.payloadHash);
  for (const { filename, sha256 } of result.files) {
    assert.ok(desktopFiles.includes(filename));
    assert.equal(digest(extractFile(result.stagedArchive, path.join('desktop', filename))), sha256);
  }
  let archiveReplaced = false;
  let rendererMoved = false;
  try {
    await fsp.rename(result.stagedArchive, archive);
    archiveReplaced = true;
    await fsp.rename(installedRenderer, path.join(result.backup, 'dist'));
    rendererMoved = true;
    await fsp.rename(result.stagedRenderer, installedRenderer);
  } catch (error) {
    if (archiveReplaced) await fsp.copyFile(path.join(result.backup, 'app.asar'), archive);
    if (rendererMoved) await fsp.rename(path.join(result.backup, 'dist'), installedRenderer);
    throw error;
  }
  result.applied = true;
  result.pending = false;
}

async function main() {
  const args = process.argv.slice(2);
  const value = (flag) => args[args.indexOf(flag) + 1];
  if (args.includes('--prepared')) {
    const manifest = path.resolve(value('--prepared'));
    const result = JSON.parse(await fsp.readFile(manifest, 'utf8'));
    if (!result.applied) await activatePreparedFix(result);
    await fsp.writeFile(manifest, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  assert.ok(args.includes('--resources') && args.includes('--renderer'), 'Usage: node tools/apply-desktop-runtime-fix.mjs --resources <installed resources dir> --renderer <built renderer dir> [--apply]');
  const resources = await fsp.realpath(value('--resources'));
  const renderer = await fsp.realpath(value('--renderer'));
  const archive = path.join(resources, 'app.asar');
  const installedRenderer = path.join(resources, 'app.asar.unpacked', 'dist');
  await fsp.access(archive);
  await fsp.access(path.join(renderer, 'index.html'));
  await fsp.access(path.join(installedRenderer, 'index.html'));
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
  const backup = path.join(resources, `desktop-runtime-backup-${stamp}`);
  await fsp.mkdir(backup);
  const stagedArchive = path.join(resources, `app.asar.runtime-fix-${stamp}`);
  const stagedRenderer = path.join(resources, `desktop-renderer-runtime-fix-${stamp}`);
  const report = await patchDesktopArchive({ sourceArchive: archive, targetArchive: stagedArchive });
  await fsp.cp(renderer, stagedRenderer, { recursive: true, force: false });
  await fsp.copyFile(archive, path.join(backup, 'app.asar'), fs.constants.COPYFILE_EXCL);
  const result = { applied: false, pending: true, resources, backup, stagedArchive, stagedRenderer, ...report };
  const manifest = path.join(backup, 'verification.json');
  await fsp.writeFile(manifest, JSON.stringify(result, null, 2));
  if (args.includes('--apply')) await activatePreparedFix(result);
  await fsp.writeFile(manifest, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
