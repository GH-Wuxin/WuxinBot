import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveCodexExecutable } from '../server/codexExecutable.ts';
import { getCodexAccountStatus, shutdownCodexAppServer } from '../server/codexAppServer.ts';
import { codexLoginView } from '../src/pages/Models/codexStatus.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wuxin-codex-path-'));
try {
  const root = path.join(temp, 'OpenAI', 'Codex', 'bin');
  const env = { LOCALAPPDATA: temp };
  const resolve = command => resolveCodexExecutable(command, env, 'win32');
  const old = path.join(root, 'aaaa1111', 'codex.exe');
  assert.equal(resolve(old), old, 'missing install retains actionable failed path');
  assert.equal(resolve('codex'), 'codex', 'no desktop install preserves PATH fallback');
  for (const dir of ['bbbb2222', 'cccc3333', 'not-a-version']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, dir, 'codex.exe'), 'fixture, never executed');
  }
  const first = path.join(root, 'bbbb2222', 'codex.exe');
  const latest = path.join(root, 'cccc3333', 'codex.exe');
  fs.utimesSync(first, 100, 100); fs.utimesSync(latest, 200, 200);
  assert.equal(resolve(old), latest);
  assert.equal(resolve('codex'), latest);
  assert.equal(resolve(first), first, 'existing explicit path remains pinned');
  const custom = path.join(temp, 'custom', 'codex.exe');
  assert.equal(resolve(custom), custom, 'never replace a missing custom installation');
  assert.equal(resolve('custom-codex'), 'custom-codex');
  assert.equal(resolveCodexExecutable(old, env, 'linux'), old);
  fs.unlinkSync(latest);
  assert.equal(resolve(old), first, 'each call observes removal during an update');
  assert.equal(codexLoginView(null).canLogin, false);
  assert.equal(codexLoginView({ authenticated: false, error: 'ENOENT' }).canLogin, false);
  assert.equal(codexLoginView({ authenticated: false, authStatus: 'unknown', running: true }).canLogin, false);
  assert.equal(codexLoginView({ authenticated: false, running: true }).canLogin, true);
  assert.equal(codexLoginView({ authenticated: true }).canLogin, false);
  const status = await getCodexAccountStatus({ codexExecutable: custom });
  assert.equal(status.authStatus, 'unknown');
  assert.equal(status.authenticated, false);
  assert.ok(status.error);
  console.log('PASS Codex discovery: stale path, version removal, pin/custom preservation, PATH and platform fallback; real spawn failure and UI auth states');
} finally {
  shutdownCodexAppServer();
  fs.rmSync(temp, { recursive: true, force: true });
}
