import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { classifySaveOutcome } from '../src/presenter.js';
import { SUCCESS_FEEDBACK_MS, feedbackAutoDismissMs, feedbackForSave, saveErrorTitle } from '../src/feedback.js';
import type { FeedbackText } from '../src/feedback.js';

/**
 * The save-result card the floating layer renders.
 *
 * The translator is built from the real locale files and throws on an unknown key, so a card can
 * never show `saveError.something` instead of a sentence: a missing or renamed key fails the test
 * rather than the user's screen. The outcomes themselves come from the real classifier, not from
 * hand-built literals.
 */

async function translator(lang: 'en' | 'zh'): Promise<FeedbackText> {
  const table: Record<string, string> = JSON.parse(await readFile(new URL(`../locale/${lang}.json`, import.meta.url), 'utf8'));
  return {
    known: (key: string) => typeof table[key] === 'string' && table[key]!.trim() !== '',
    t: (key: string) => {
      const value = table[key];
      if (typeof value !== 'string') throw new Error(`${lang} has no text for ${key}`);
      return value;
    },
    tr: (key: string, vars: Record<string, string | number>) => {
      const value = table[key];
      if (typeof value !== 'string') throw new Error(`${lang} has no text for ${key}`);
      return value.replace(/\{\{(\w+)\}\}/g, (_all, name: string) => String(vars[name] ?? ''));
    },
  };
}

const issue = { path: 'pageFetch.routes.1.enabled', message: 'refused', code: 'browser.endpoint.missing', action: { target: 'browser.endpoint' } };

for (const lang of ['en', 'zh'] as const) {
  test(`[${lang}] every save outcome renders sentences, transience and distinct causes`, async () => {
    const text = await translator(lang);

    const saved = feedbackForSave(classifySaveOutcome({ response: { status: 200, payload: { saved: true } }, readback: { ok: true, matches: true } }), text);
    assert.equal(saved?.kind, 'success');
    assert.equal(saved?.text, text.t('saved'));
    assert.deepEqual(saved?.issues, []);
    assert.equal(feedbackAutoDismissMs(saved!), SUCCESS_FEEDBACK_MS, 'a success dismisses itself');
    assert.equal(feedbackForSave(classifySaveOutcome({ response: { status: 200, payload: { saved: true, verified: 1 } }, readback: { ok: true, matches: true } }), text, { verified: true })?.text, text.t('savedVerified'));

    // A refusal lists its causes and links to them; the list replaces the repeated sentence.
    const rejected = feedbackForSave(classifySaveOutcome({ response: { status: 400, payload: { error: { code: 'browser-verification-failed', message: 'boom', issues: [issue] } } } }), text);
    assert.equal(rejected?.kind, 'error');
    assert.equal(rejected?.title, text.t('saveError.browser-verification-failed'));
    assert.equal(rejected?.text, undefined, 'the causes are the list, not a repeated sentence');
    assert.deepEqual(rejected?.issues, [issue], 'the field links survive classification');
    assert.equal(feedbackAutoDismissMs(rejected!), undefined, 'an error waits for the user');

    // A refusal without structured issues keeps the server's sentence as its explanation.
    const unsorted = feedbackForSave(classifySaveOutcome({ response: { status: 400, payload: { error: { code: 'validation-failed', message: 'Configuration was rejected' } } } }), text, { serverMessage: 'Configuration was rejected' });
    assert.equal(unsorted?.kind, 'error');
    assert.match(String(unsorted?.text), /Configuration was rejected/);

    const conflict = feedbackForSave(classifySaveOutcome({ response: { status: 409, payload: { error: { code: 'revision-conflict', message: 'stale' } } } }), text);
    assert.equal(conflict?.title, text.t('conflictTitle'));
    assert.equal(conflict?.text, text.t('conflict'));

    const writeFailed = feedbackForSave(classifySaveOutcome({ response: { status: 500, payload: { error: { code: 'save-failed', message: 'disk full' } } }, readback: { ok: true, matches: false } }), text);
    assert.equal(writeFailed?.title, text.t('saveFailed'));
    assert.equal(writeFailed?.detail, 'disk full', 'the server reason is kept beside the wording');
    assert.equal(writeFailed?.code, 'save-failed');

    const unconfirmed = feedbackForSave(classifySaveOutcome({ transportError: true, readback: { ok: true, matches: false } }), text);
    assert.equal(unconfirmed?.text, text.t('saveUnconfirmed'));
    const unknown = feedbackForSave(classifySaveOutcome({ transportError: true, readback: { ok: false } }), text);
    assert.equal(unknown?.text, text.t('saveStateUnknown'));

    // The four error causes stay distinct: one message must not stand in for another.
    const titles = [rejected, conflict, writeFailed, unconfirmed, unknown].map(card => `${card?.title}|${card?.text}|${card?.detail}`);
    assert.equal(new Set(titles).size, titles.length, 'each failure keeps its own cause');
    assert.ok(unknown?.title !== unconfirmed?.title, 'an unreadable read-back is not an unconfirmed write');
  });
}

test('an outcome the host can emit always has a localized headline, never a raw key', async () => {
  for (const lang of ['en', 'zh'] as const) {
    const text = await translator(lang);
    for (const code of ['validation-failed', 'browser-verification-failed', 'browser-credential-unavailable', 'save-cancelled', 'operation-failed', 'an-unmapped-code']) {
      const title = saveErrorTitle(code, text);
      assert.ok(title.trim(), `${lang} names ${code}`);
      assert.notEqual(title, `saveError.${code}`, `${lang} never shows the key ${code}`);
      assert.ok(!title.includes('saveError.'), `${lang} shows words, not a key`);
    }
  }
});
