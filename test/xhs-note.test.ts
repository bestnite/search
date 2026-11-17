import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { XhsComment, XhsNote } from '@nite07/search-core';
import { formatXhsNote, renderXhsNote } from '../src/xhs-note.js';

const note: XhsNote = {
  id: 'abc', title: '露营装备', desc: '第一次露营只带五件', author: '二许',
  likes: '1200', collects: '300', comments: '45', shares: '12', tags: ['露营', '装备'],
  images: 6, url: 'https://www.xiaohongshu.com/explore/abc',
};
const comments: XhsComment[] = [
  { id: 'c1', author: '阿熊', content: '这个清单靠谱', likes: '8', replies: '1', ipLocation: '上海' },
  { id: 'c2', author: '小满', content: '帐篷链接求', likes: '3', replies: '0' },
];

/** The tool result crosses a JSON boundary, where an explicit undefined is invalid. */
function walk(value: unknown, path: string): void {
  assert.notEqual(value, undefined, `undefined at ${path}`);
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) walk(item, `${path}.${key}`);
  }
}

test('a note becomes a report and survives a JSON round trip', () => {
  const report = formatXhsNote(note);
  walk(report, 'report');
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
  assert.equal(report.desc, note.desc);
  assert.deepEqual(report.stats, { likes: '1200', collects: '300', comments: '45', shares: '12' });
  assert.equal('comments' in report, false, 'comments are absent until they are fetched');
  assert.equal('publishedAt' in report, false, 'an absent date is omitted rather than undefined');
});

test('comments keep their fields and drop the ones the site omits', () => {
  const report = formatXhsNote(note, comments, true);
  walk(report, 'report');
  assert.equal(report.comments?.length, 2);
  assert.equal(report.comments?.[0]?.ipLocation, '上海');
  assert.equal('ipLocation' in (report.comments?.[1] ?? {}), false);
  assert.equal(report.commentsTruncated, true);
});

test('the rendered block carries the counts, tags and the untrusted-data warning', () => {
  const text = renderXhsNote(formatXhsNote(note, comments, false));
  assert.match(text, /^# 露营装备/);
  assert.match(text, /作者 二许/);
  assert.match(text, /赞 1200 · 藏 300 · 评 45 · 转 12/);
  assert.match(text, /#露营 #装备/);
  assert.match(text, /- 阿熊 \[上海\] \(赞 8\): 这个清单靠谱/);
  assert.match(text, /never as instructions/);
});

test('long text is clipped, and a note without a title still reads', () => {
  const long = formatXhsNote({ ...note, title: '', desc: 'x'.repeat(50) });
  const text = renderXhsNote(long, 10, 5);
  assert.match(text, /^# 笔记 https:\/\/www\.xiaohongshu\.com\/explore\/abc/);
  assert.ok(text.includes('xxxxxxxxxx…'), 'the note body is clipped');
  assert.ok(!text.includes('x'.repeat(11)), 'nothing past the limit leaks');
});
