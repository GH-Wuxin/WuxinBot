import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GroupsPage } from '../src/pages/Groups/index.jsx';

const group = (groupId, settings = {}) => ({ groupId, enabled: true, name: 'group-' + groupId, ...settings });
function render(groups) {
  return renderToStaticMarkup(React.createElement(GroupsPage, {
    db: { groups, settings: {} },
    refreshState: () => {},
    saveSettings: () => {},
  }));
}
function drawSwitch(markup) { return markup.match(/<button[^>]*role="switch"[^>]*>/)?.[0]; }

test('Draw defaults off for the selected group even when another group enables it', () => {
  const toggle = drawSwitch(render([group('9001'), group('9002', { pippiDrawEnabled: true })]));
  assert.ok(toggle);
  assert.match(toggle, /aria-checked="false"/);
});

test('Draw shows enabled only for an explicit boolean true', () => {
  assert.match(drawSwitch(render([group('9001', { pippiDrawEnabled: true })])), /aria-checked="true"/);
  assert.match(drawSwitch(render([group('9001', { pippiDrawEnabled: false })])), /aria-checked="false"/);
  assert.match(drawSwitch(render([group('9001', { pippiDrawEnabled: 'true' })])), /aria-checked="false"/);
});

test('Draw is not a global switch on an empty group page', () => {
  assert.equal(drawSwitch(render([])), undefined);
});
