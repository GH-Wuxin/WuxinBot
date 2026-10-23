// Frontend-only fixtures: never start a bot, log in, or touch the live database.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { quotaWindows, shortNumber, usageSummary } from '../src/pages/Dashboard/usageView.js';
import { buildRequestEntries, filterLogEntries, traceMetrics } from '../src/pages/Logs/explorer.js';
import { correlateChatRecords } from '../src/pages/Logs/correlation.js';
import { createDemoTraces } from '../src/pages/Logs/traceFixture.js';
import { DashboardPage } from '../src/pages/Dashboard/index.jsx';
import { ModelsPage } from '../src/pages/Models/index.jsx';
import { LogsPage } from '../src/pages/Logs/index.jsx';
import { AppShell } from '../src/components/layout/AppShell.jsx';
import { SegmentedControl, SettingRow, Select, Switch } from '../src/components/ui/index.jsx';

const point = { start: '2026-09-07T00:00:00Z', label: '08:00', promptTokens: 1000, completionTokens: 20, totalTokens: 1020, cachedTokens: 75, cacheMeasuredPromptTokens: 100, requests: 2 };
const stats = { hourly24: [point], daily7: [point, { ...point, promptTokens: 100, totalTokens: 120 }], cacheMeasuredAll: { promptTokens: 1000, cachedTokens: 500, cacheWriteTokens: 10 } };
const usage = { promptTokens: 99000, completionTokens: 1000, totalTokens: 100000, requests: 50 };
const before = JSON.stringify({ stats, usage });
assert.equal(usageSummary(stats, usage).totals.totalTokens, 1020);
assert.equal(usageSummary(stats, usage, 'daily7').totals.totalTokens, 1140);
assert.equal(usageSummary(stats, usage, 'all').totals.totalTokens, 100000);
assert.equal(usageSummary(stats, usage).cacheRate, 75, 'unknown cache coverage must not dilute the denominator');
assert.equal(usageSummary(stats, usage, 'all').cacheRate, 50);
assert.equal(usageSummary(stats, usage, 'all').cacheWrite, 10);
assert.equal(usageSummary({ hourly24: [{ totalTokens: 200, promptTokens: 200 }] }).cacheRate, null);
assert.equal(usageSummary({ hourly24: [{ promptTokens: 200, cacheMeasuredPromptTokens: 200, cachedTokens: 0 }] }).cacheRate, 0);
assert.deepEqual(usageSummary().points, []);
assert.equal(usageSummary(null, null, 'all').cacheRate, null);
assert.equal(JSON.stringify({ stats, usage }), before, 'presentation must not mutate stored statistics');
assert.equal(shortNumber(49674119).unit, '万');
assert.equal(shortNumber(100000000).unit, '亿');
assert.equal(shortNumber(0).value, '0');
console.log('PASS period totals, partial cache coverage, known zero, empty state and large-number units');

const windows = quotaWindows({ rateLimits: { primary: { usedPercent: 99 } }, rateLimitsByLimitId: { codex: { primary: { windowDurationMins: 10080, usedPercent: 25 }, secondary: { windowDurationMins: 300, usedPercent: null } } } });
assert.equal(windows.length, 2, 'prefer per-bucket limits without duplicating legacy data');
assert.equal(windows[0].label, '周额度窗口');
assert.equal(windows[1].label, '5 小时窗口');
assert.equal(windows[1].used, null);
assert.equal(quotaWindows({ rateLimits: { primary: { usedPercent: 130 } } })[0].used, 100);
assert.equal(quotaWindows({ rateLimits: { primary: { usedPercent: -1 } } })[0].used, 0);
assert.equal(quotaWindows({ rateLimits: { secondary: { usedPercent: 'unknown', windowDurationMins: 90 } } })[0].used, null);
assert.equal(quotaWindows({ rateLimits: { secondary: { windowDurationMins: 90 } } })[0].label, '90 分钟窗口');
assert.deepEqual(quotaWindows(null), []);
console.log('PASS swapped quota windows, legacy fallback, unknown values and clamping');

const startedAt = '2026-09-07T00:00:00Z';
const event = value => ({ name: 'model_call_completed', data: { response: { usage: { totalTokens: value } } } });
const trace = { id: 'request-1', status: 'completed', startedAt, finishedAt: '2026-09-07T00:00:30Z', events: [event(25000), event(25000), event('[TRUNCATED]'), { ...event(100000), name: 'model_call_streaming' }] };
assert.deepEqual(traceMetrics(trace), { tokens: 50000, duration: 30000 });
assert.deepEqual(traceMetrics({ events: [event('[TRUNCATED]')] }), { tokens: null, duration: null });
assert.equal(traceMetrics({ ...trace, startedAt: 'bad date' }).duration, null);
assert.equal(traceMetrics({ events: [event(0)] }).tokens, 0, 'known zero differs from missing usage');
const messages = [{ id: 'm1', requestId: 'request-1', nickname: 'Example', groupId: 'fixture', content: 'hello', createdAt: startedAt }, { id: 'm2', nickname: 'Example', content: 'same time is not the same request', createdAt: startedAt }];
const decisions = [{ id: 'd1', requestId: 'request-1', shouldReply: true, createdAt: startedAt }];
const rows = correlateChatRecords(messages, decisions);
const entries = buildRequestEntries(rows, [trace, { id: 'active', status: 'active', startedAt }]);
assert.equal(entries.length, 3);
assert.equal(entries[0].status, 'active');
assert.equal(entries.find(item => item.row?.message?.id === 'm1').trace.id, trace.id);
assert.equal(entries.find(item => item.row?.message?.id === 'm2').trace, null);
assert.equal(filterLogEntries(entries, 'costly').length, 1);
assert.equal(filterLogEntries(entries, 'slow').length, 1);
assert.equal(filterLogEntries(entries, 'active').length, 1);
assert.equal(filterLogEntries(entries, 'all', 'HELLO').length, 1);
assert.equal(filterLogEntries(entries, 'all', 'not-present').length, 0);
assert.equal(filterLogEntries([{ status: 'denied' }, { status: 'error' }, { status: 'invalid' }, { status: 'failed' }, { status: 'completed' }], 'failed').length, 4);
assert.equal(buildRequestEntries([{ kind: 'decision', decision: { id: 'd', shouldReply: false }, requestId: 'failed' }], [{ id: 'failed', status: 'failed' }])[0].status, 'failed', 'failure must not be hidden behind silent decision');
assert.equal(filterLogEntries([{ status: 'silent' }], 'silent').length, 1);
console.log('PASS stable request correlation, recorded usage only, replay ordering and all filters');

for (const live of [false, true]) {
  const demos = createDemoTraces(live);
  assert.ok(demos.length > 0);
  for (const demo of demos) {
    assert.equal(demo.eventCount, demo.events.length);
    assert.equal(demo.status, live ? 'active' : 'completed');
    assert.equal(Boolean(demo.finishedAt), !live);
    assert.ok(demo.events.every((item, index) => Date.parse(item.at) >= Date.parse(index ? demo.events[index - 1].at : demo.startedAt)));
  }
}
assert.equal(traceMetrics(createDemoTraces()[0]).tokens, 140);
assert.equal(traceMetrics(createDemoTraces(true)[0]).tokens, null);
console.log('PASS synthetic trace previews retain ordered events, live state and completed usage');

// Today and rolling 24-hour data deliberately differ so a period mix-up is visible.
const today = { ...point, requests: 7, totalTokens: 50000, promptTokens: 49000, completionTokens: 1000, cachedTokens: 75, cacheMeasuredPromptTokens: 100 };
const db = { settings: { llmProvider: 'deepseek', model: 'fixture', effectiveModel: 'actual-model', temperature: 0.8, maxTokens: 500, contextLimit: 20 }, usageStats: { ...stats, today }, usage, groups: [], messages, decisions, experience: {}, commandLogs: [] };
const noop = () => {};
const render = (Component, props) => renderToStaticMarkup(React.createElement(Component, props));
const overview = render(DashboardPage, { db, oneBot: {}, saveSettings: noop, refreshState: noop, onNavigate: noop });
assert.match(overview, /actual-model/);
assert.match(overview, /75\.0%/);
assert.match(overview, /今日 Token<\/span><b>5\.0 万/);
assert.match(overview, /今天已经回了 <em>7<\/em>/);
assert.match(overview, /Token 用量 · 24 小时/);
assert.match(overview, /data-tokens="1020"/);
assert.match(overview, /0\.1<span/);
const renderToday = (value) => render(DashboardPage, { db: { ...db, usageStats: { ...db.usageStats, today: value } }, oneBot: {}, refreshState: noop, onNavigate: noop });
assert.match(renderToday({}), /缓存命中 —/);
assert.match(renderToday({ cacheMeasuredPromptTokens: 100, cachedTokens: 0 }), /缓存命中 0\.0%/);
assert.match(render(ModelsPage, { db, saveSettings: noop }), /当前运行模型/);
const codexModels = render(ModelsPage, { db: { ...db, settings: { ...db.settings, llmProvider: 'codex-app-server' } }, saveSettings: noop });
assert.match(codexModels, /Codex 可执行文件/);
assert.match(codexModels, /aria-label="自动降级"/);
const logs = render(LogsPage, { db: { ...db, messages: [messages[0]] } });
assert.match(logs, /hello/);
assert.match(logs, /为何回复/);
assert.match(render(LogsPage, { db: { ...db, messages: [], decisions: [] } }), /没有匹配的记录/);
assert.match(render(SegmentedControl, { value: 'a', onChange: noop, options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }), /aria-pressed="true"/);
assert.match(render(SettingRow, { title: '接口供应商', control: React.createElement(Select, { options: [] }) }), /aria-label="接口供应商"/);
assert.match(render(SettingRow, { title: '自动降级', control: React.createElement(Switch, { checked: true, onChange: noop }) }), /aria-label="自动降级"/);
console.log('PASS real React page rendering, preserved model sections, empty logs and accessible controls');

const shell = render(AppShell, { page: 'overview', db, oneBot: {}, onNavigate: noop, onPauseToggle: noop, onStopAll: noop });
assert.doesNotMatch(shell, /always in rhythm|CONTROL ROOM|made for the community|osu-shell-footer/);
assert.match(shell, /id="pauseBtn"[^>]*>暂停<\/button>/);
assert.match(render(AppShell, { page: 'overview', db: { ...db, settings: { ...db.settings, globalPaused: true } }, oneBot: {}, onNavigate: noop, onPauseToggle: noop }), /id="pauseBtn"[^>]*>恢复<\/button>/);
assert.match(shell, /运行控制/);
assert.match(overview, /Token 用量/);
assert.match(overview, /API 通道计费与本地 Token 是两个口径/);
assert.doesNotMatch(overview, /osu-dashboard__intro|掌握每一拍|一眼看清|迹可循|选择这一拍|什么时候加入聊天/);
for (const page of ['Agent', 'Dashboard', 'Groups', 'Integrations', 'Logs', 'Maintenance', 'Members', 'Memory', 'Models', 'Osu', 'Permissions', 'Persona', 'ProfileLogs', 'Relationships']) {
  const source = readFileSync(new URL(`../src/pages/${page}/index.jsx`, import.meta.url), 'utf8');
  assert.doesNotMatch(source, /eyebrow="|YOUR BOT, IN RHYTHM|找到合适的聊天节奏|回看每一次判断|每一次对话，都有迹可循|一眼看清|REQUEST DETAIL/, `${page}: no decorative copy`);
}
assert.match(readFileSync(new URL('../src/pages/Groups/index.jsx', import.meta.url), 'utf8'), /清空上下文会删除该群的聊天上下文和决策日志/);
assert.match(readFileSync(new URL('../src/pages/Models/index.jsx', import.meta.url), 'utf8'), /需要多模态模型/);
console.log('PASS decorative copy removed across 14 pages; functional controls and warnings retained');
