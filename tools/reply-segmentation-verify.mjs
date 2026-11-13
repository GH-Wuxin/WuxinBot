import assert from 'node:assert/strict';
import { splitReplySegments } from '../server/bot/reply.ts';

const squash = (value) => String(value || '').replace(/\s+/g, '');
const hasIntact = (segments, needle) => segments.some((segment) => segment.includes(needle));

const short = '!s 1234567';
assert.deepEqual(splitReplySegments(short), [short]);

const commandReply = '常用指令：`!s <BID>` 查指定谱面，`!pp` 看 PP+，链接 https://osu.ppy.sh/community/forums/topics/1?start=2';
const commandSegments = splitReplySegments(commandReply);
assert.ok(commandSegments.length <= 3, 'command reply stays within three segments');
assert.ok(hasIntact(commandSegments, '`!s <BID>`'), 'inline !s command must stay intact');
assert.ok(hasIntact(commandSegments, '`!pp`'), 'inline !pp command must stay intact');
assert.ok(hasIntact(commandSegments, 'https://osu.ppy.sh/community/forums/topics/1?start=2'), 'URL must stay intact');
assert.equal(squash(commandSegments.join('')), squash(commandReply), 'segmentation must not drop content');

const urlOnly = '看看这张图 https://osu.ppy.sh/b/1234567?m=0';
assert.deepEqual(splitReplySegments(urlOnly), [urlOnly]);

const code = '```js\nconsole.log(1)\nconsole.log(2)\n```';
assert.deepEqual(splitReplySegments(code), [code], 'fenced code block must stay one segment');

const long = '这是一段很长的普通回复，里面有命令 !s 123 和链接 https://example.com/a?x=1&y=2，还有代码 `npm run test`。';
const longSegments = splitReplySegments(long);
assert.ok(longSegments.length <= 3, 'long reply stays within three segments');
assert.ok(hasIntact(longSegments, '!s 123'), 'plain !s command must stay intact');
assert.ok(hasIntact(longSegments, 'https://example.com/a?x=1&y=2'), 'URL with query string must stay intact');
assert.ok(hasIntact(longSegments, '`npm run test`'), 'inline code must stay intact');
assert.equal(squash(longSegments.join('')), squash(long), 'segmentation must not drop content');

const normal = '第一句。第二句！第三句？第四句。第五句。第六句。';
const normalSegments = splitReplySegments(normal);
assert.ok(normalSegments.length >= 1 && normalSegments.length <= 3);
assert.equal(squash(normalSegments.join('')), squash(normal));

console.log('reply segmentation: commands, URLs and code stay intact; content is not dropped; max three segments PASS');
