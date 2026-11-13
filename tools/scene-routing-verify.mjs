import assert from 'node:assert/strict';
import { detectScene, buildPippiPrompt } from '../server/bot/persona.ts';
import { routeForText } from '../server/bot/kbRoute.ts';

const event = (text) => ({ text, type: 'group', userId: '10001' });

assert.equal(detectScene(event('/w osu help')), 'command', '/w command stays deterministic');
assert.equal(detectScene(event('/wuxin help')), 'command', '/wuxin command stays deterministic');
assert.equal(detectScene(event('救命，最后一颗又1miss了')), 'casual', 'in-game hyperbole is not auto-serious');
assert.equal(detectScene(event('我这两天心情特别差')), 'casual', 'ordinary chat is not keyword-classified');
assert.equal(detectScene(event('我家人住院了')), 'casual', 'ordinary chat is not keyword-classified');
assert.equal(detectScene(event('我家人住院了'), 'serious'), 'serious', 'explicit serious scene remains available');
assert.equal(detectScene(event('随便聊聊'), 'command'), 'command', 'explicit scene override remains available');

const casualPrompt = buildPippiPrompt({ scene: detectScene(event('我家人住院了')) });
assert.ok(casualPrompt.includes('当前场景：日常聊天。'));
assert.ok(!casualPrompt.includes('当前场景：需要认真对待的对话。'));
assert.ok(casualPrompt.includes('结合上下文能确认对方在认真求助'), 'casual prompt retains real-distress guidance');
const explicitSerious = buildPippiPrompt({ scene: 'serious' });
assert.ok(explicitSerious.includes('当前场景：需要认真对待的对话。'), 'explicit serious prompt still uses the saved section');

assert.deepEqual(routeForText('serious', '我家人住院了'), { kind: 'none', reason: 'serious_scene' });
assert.deepEqual(routeForText('command', '我家人住院了'), { kind: 'none', reason: 'deterministic_command' });
assert.deepEqual(routeForText('casual', '/w osu help'), { kind: 'none', reason: 'deterministic_command' });

// Documented behaviour change: without keyword auto-serious, these ordinary
// messages now use the casual KB route instead of the serious zero-inject route.
assert.equal(routeForText('casual', '我家人住院了').kind, 'community_style');
assert.equal(routeForText('casual', '救命，最后一颗又1miss了').kind, 'community_style');
assert.notEqual(routeForText('casual', '我家人住院了').reason, 'serious_scene');

console.log('scene routing: deterministic /w, no keyword serious classification, explicit serious interface and KB route impact PASS');
