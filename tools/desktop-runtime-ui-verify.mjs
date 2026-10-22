import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function openRuntimePage(t) {
  const browserPath = [process.env.WUXIN_TEST_BROWSER,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe', chromium.executablePath(),
  ].find((candidate) => candidate && fs.existsSync(candidate));
  assert.ok(browserPath, 'Set WUXIN_TEST_BROWSER to a Chromium executable for this headless UI test');
  const bundle = await build({
    stdin: { resolveDir: projectRoot, loader: 'jsx', contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { RuntimePage } from './src/pages/Runtime/index.jsx';
      import './src/styles/tokens.css';
      import './src/styles/globals.css';
      import './src/styles/components.css';
      import './src/styles/runtime.css';
      import './src/styles/prototype.css';
      import './src/styles/overrides.css';
      createRoot(document.getElementById('root')).render(<React.StrictMode><RuntimePage standalone /></React.StrictMode>);
    ` },
    bundle: true, write: false, outdir: 'out', define: { 'process.env.NODE_ENV': '"development"' },
  });
  const files = new Map(bundle.outputFiles.map((file) => [path.basename(file.path), file.contents]));
  const server = http.createServer((request, response) => {
    const name = request.url.slice(1);
    if (files.has(name)) {
      response.setHeader('Content-Type', name.endsWith('.css') ? 'text/css' : 'text/javascript');
      response.end(files.get(name));
    } else {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end('<!doctype html><html lang="zh-CN"><link rel="stylesheet" href="/stdin.css"><div id="root"></div><script src="/stdin.js"></script></html>');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const browser = await chromium.launch({ executablePath: browserPath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
  const browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.setDefaultTimeout(10_000);
  t.after(() => assert.deepEqual(browserErrors, []));
  return { page, browserErrors, url: `http://127.0.0.1:${server.address().port}` };
}

test('startup page detects existing services, refreshes status and preserves inspection errors', async (t) => {
  const { page, browserErrors, url } = await openRuntimePage(t);
  await page.addInitScript(() => {
    window.runtimeTest = { calls: 0, active: 0, peak: 0, starts: 0, fail: false, gone: false, failStart: false, initial: true };
    const base = { group: '测试组件', enabled: true, autoStart: true, available: true, args: [], port: 12345 };
    window.desktop = { isDesktop: true, runtime: {
      getState: async () => {
        const state = window.runtimeTest;
        state.calls++;
        state.active++;
        state.peak = Math.max(state.peak, state.active);
        try {
          if (state.initial) await new Promise((resolve) => { state.release = resolve; });
          if (state.fail) throw new Error('系统进程检测暂不可用');
          return { settings: {}, updatedAt: new Date().toISOString(), processes: [
            { ...base, id: 'external', label: '已存在的服务', status: state.gone ? 'stopped' : 'running', source: state.gone ? null : 'external', managed: false, ready: !state.gone, pids: state.gone ? [] : [1234] },
            { ...base, id: 'managed', label: '本窗口的服务', status: 'running', source: 'managed', managed: true, ready: true, pids: [5678] },
            { ...base, id: 'foreign', label: '端口冲突的服务', enabled: false, status: 'conflict', managed: false, portProcesses: [{ pid: 9999, name: 'other.exe', kind: 'foreign' }], lastError: '端口被 other.exe 占用' },
          ] };
        } finally { state.active--; }
      },
      getAutoLaunch: async () => false,
      onLog: () => () => {},
      startAll: async () => {
        window.runtimeTest.starts++;
        if (window.runtimeTest.failStart) throw new Error('测试启动失败');
        return [{ id: 'external', ok: true, result: { alreadyRunning: true } }];
      },
    } };
  });
  await page.goto(url);
  await page.getByRole('status').waitFor();
  assert.equal(await page.getByRole('button', { name: '一键启动', exact: true }).isDisabled(), true);
  assert.equal(await page.locator('.stat-value').first().innerText(), '—');
  await page.waitForFunction(() => Boolean(window.runtimeTest.release));
  await page.evaluate(() => { window.runtimeTest.initial = false; window.runtimeTest.release(); });

  const external = page.locator('.proc').filter({ hasText: '已存在的服务' });
  await external.getByText('已在运行', { exact: true }).waitFor();
  assert.match(await external.locator('.proc-meta').innerText(), /检测到已有进程 · PID 1234/);
  for (const name of ['启动', '停止', '重启']) assert.equal(await external.getByRole('button', { name, exact: true }).isDisabled(), true);
  assert.equal(await page.locator('.proc').filter({ hasText: '本窗口的服务' }).getByRole('button', { name: '停止', exact: true }).isEnabled(), true);
  assert.equal(await page.locator('.proc').filter({ hasText: '端口冲突的服务' }).getByText('端口占用', { exact: true }).count(), 1);
  await page.getByRole('button', { name: '一键启动', exact: true }).click();
  await page.getByText('已在运行，已跳过', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.runtimeTest.starts), 1);

  await page.evaluate(() => { window.runtimeTest.fail = true; });
  await page.getByRole('button', { name: '重新检测', exact: true }).click();
  await page.getByRole('alert').waitFor();
  assert.match(await page.getByRole('alert').innerText(), /上次检测结果/);
  assert.equal(await external.getByText('已在运行', { exact: true }).count(), 1);
  assert.equal(await page.getByRole('button', { name: '一键启动', exact: true }).isDisabled(), true);

  await page.evaluate(() => { window.runtimeTest.fail = false; window.runtimeTest.gone = true; });
  // The normal polling cycle also notices externally stopped services.
  await external.getByText('已停止', { exact: true }).waitFor();
  assert.equal(await page.getByRole('alert').count(), 0);
  assert.equal(await external.getByRole('button', { name: '启动', exact: true }).isEnabled(), true);
  await page.evaluate(() => { window.runtimeTest.gone = false; window.runtimeTest.failStart = true; });
  await page.getByRole('button', { name: '一键启动', exact: true }).click();
  await page.getByText('测试启动失败', { exact: true }).waitFor();
  await page.getByRole('button', { name: '重新检测', exact: true }).click();
  assert.equal(await page.getByText('测试启动失败', { exact: true }).count(), 1, 'refresh must not erase an action failure');
  assert.equal(await page.evaluate(() => window.runtimeTest.peak), 1);
  assert.deepEqual(browserErrors, []);
  for (const width of [1440, 1080]) {
    await page.setViewportSize({ width, height: 920 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `no overflow at ${width}px`);
  }
});

test('startup remains cancellable without allowing duplicate starts or stopping external services', async (t) => {
  const { page, url } = await openRuntimePage(t);
  await page.addInitScript(() => {
    const base = { group: '测试', enabled: true, args: [], port: null, available: true };
    const state = window.runtimeTest = { phase: 'stopped', starts: 0, stops: [], pending: false };
    const begin = () => {
      state.starts++;
      state.phase = 'starting';
      state.pending = true;
      return new Promise((resolve) => { state.finishStart = () => { state.pending = false; resolve([
        { id: 'external', ok: true, result: { alreadyRunning: true } },
        { id: 'managed', ok: false, cancelled: true, error: '启动已取消' },
      ]); }; });
    };
    const stop = (id) => {
      state.stops.push(id);
      return new Promise((resolve) => { state.finishStop = () => { state.phase = 'stopped'; resolve([]); }; });
    };
    window.desktop = { isDesktop: true, runtime: {
      getState: async () => ({ settings: {}, processes: [
        { ...base, id: 'external', label: '外部服务', status: 'running', ready: true, source: 'external', managed: false, pids: [1234] },
        { ...base, id: 'managed', label: '待启动服务', status: state.phase, ready: false, source: null, managed: false, startPending: state.pending, pids: [] },
      ] }),
      getAutoLaunch: async () => false, onLog: () => () => {},
      startAll: begin, start: begin, stopAll: () => stop('all'), stop,
    } };
  });
  await page.goto(url);
  const managed = page.locator('.proc').filter({ hasText: '待启动服务' });
  const external = page.locator('.proc').filter({ hasText: '外部服务' });
  const panel = page.getByLabel('一键启动进度');
  const stopAll = page.getByRole('button', { name: '停止本窗口进程', exact: true });
  const startAll = page.getByRole('button', { name: '一键启动', exact: true });
  await startAll.click();
  await page.getByRole('button', { name: '重新检测', exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.proc')].find((el) => el.textContent.includes('待启动服务'))?.querySelectorAll('.proc-actions button')[1].disabled === false);
  assert.equal(await stopAll.isEnabled(), true);
  assert.equal(await external.getByRole('button', { name: '停止', exact: true }).isDisabled(), true);
  await stopAll.click();
  await page.waitForFunction(() => Boolean(window.runtimeTest.finishStop));
  assert.equal(await page.getByRole('button', { name: '停止中…', exact: true }).isDisabled(), true);
  await page.evaluate(() => window.runtimeTest.finishStop());
  await stopAll.waitFor();
  assert.equal(await page.getByRole('button', { name: '启动中…', exact: true }).isDisabled(), true, 'stop completion cannot unlock an unresolved start');
  await page.evaluate(() => window.runtimeTest.finishStart());
  await panel.getByText('已取消', { exact: true }).waitFor();
  assert.equal(await panel.getByText('启动完成', { exact: true }).count(), 0);
  assert.equal(await panel.getByText('已在运行，已跳过', { exact: true }).count(), 1);
  assert.deepEqual(await page.evaluate(() => window.runtimeTest.stops), ['all']);

  // A new run must survive the old run's 3.2-second dismissal deadline.
  await startAll.click();
  await page.getByRole('button', { name: '重新检测', exact: true }).click();
  await page.waitForTimeout(3400);
  assert.equal(await panel.isVisible(), true);
  await managed.getByRole('button', { name: '停止', exact: true }).click();
  await page.waitForFunction(() => window.runtimeTest.stops.length === 2);
  await page.evaluate(() => window.runtimeTest.finishStop());
  await managed.getByRole('button', { name: '停止', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '启动中…', exact: true }).isDisabled(), true);
  await page.evaluate(() => window.runtimeTest.finishStart());
  await panel.getByText('已取消', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.runtimeTest.stops), ['all', 'managed']);

  await managed.getByRole('button', { name: '启动', exact: true }).click();
  assert.equal(await managed.getByRole('button', { name: '停止', exact: true }).isEnabled(), true, 'single start can be cancelled before it owns a PID');
  await managed.getByRole('button', { name: '停止', exact: true }).click();
  await page.waitForFunction(() => window.runtimeTest.stops.length === 3);
  await page.evaluate(() => { window.runtimeTest.finishStop(); window.runtimeTest.finishStart(); });
  await startAll.waitFor();
  assert.equal(await page.evaluate(() => window.runtimeTest.starts), 3);
});

test('startup summary reports timeout, partial failure, global error and empty selection truthfully', async (t) => {
  const { page, url } = await openRuntimePage(t);
  await page.addInitScript(() => {
    const state = window.runtimeTest = { mode: 'timeout', status: 'stopped' };
    const base = { group: '测试', enabled: true, args: [], available: true, port: 12345 };
    window.desktop = { isDesktop: true, runtime: {
      getState: async () => ({ settings: {}, processes: [
        { ...base, id: 'managed', label: '测试服务', enabled: state.mode !== 'empty', status: state.status, ready: state.status === 'running', managed: state.status !== 'stopped', source: 'managed', pids: state.status === 'stopped' ? [] : [5678] },
        { ...base, id: 'external', label: '已就绪服务', enabled: state.mode === 'partial', status: 'running', ready: true, managed: false, source: 'external', pids: [1234] },
      ] }),
      getAutoLaunch: async () => false, onLog: () => () => {},
      startAll: async () => {
        if (state.mode === 'empty') return [];
        state.status = state.mode === 'global' || state.mode === 'result-error' ? 'running' : 'unready';
        if (state.mode === 'global') throw new Error('启动调用失败');
        return [{ id: 'managed', ok: false, error: '等待端口超时' }, ...(state.mode === 'partial' ? [{ id: 'external', ok: true }] : [])];
      },
    } };
  });
  await page.goto(url);
  const panel = page.getByLabel('一键启动进度');
  const start = page.getByRole('button', { name: '一键启动', exact: true });
  for (const [mode, expected] of [['timeout', '启动失败'], ['partial', '部分失败'], ['result-error', '启动失败'], ['global', '部分失败'], ['empty', '没有待启动组件']]) {
    await page.evaluate((next) => { window.runtimeTest.mode = next; }, mode);
    await page.getByRole('button', { name: '重新检测', exact: true }).click();
    await page.waitForFunction(() => ![...document.querySelectorAll('button')].some((el) => el.textContent === '检测中…'));
    await start.click();
    await panel.getByText(expected, { exact: true }).waitFor();
    assert.equal(await panel.getByText('启动完成', { exact: true }).count(), 0, mode);
    assert.equal(await panel.locator('.chip--mint').count(), 0, mode);
    assert.equal(await panel.getByText('未启动', { exact: true }).count(), 0, mode);
    if (mode === 'timeout') {
      assert.equal(await panel.getByText('未就绪', { exact: true }).count(), 1);
      assert.equal(await panel.getByText('等待端口超时', { exact: true }).count(), 1);
      assert.match(await page.locator('.proc').filter({ hasText: '测试服务' }).innerText(), /PID 5678/);
    }
  }
});
