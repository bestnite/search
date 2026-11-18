import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideOverlayKey } from '../src/overlay-keys.js';
import { feedbackForSave, feedbackTakesFocus } from '../src/feedback.js';
import type { FeedbackText } from '../src/feedback.js';

/**
 * The floating card lives outside the settings modal's focus trap, so it has to handle `Escape` and
 * `Tab` itself. These tests drive that decision directly: what the card prevents, where it moves focus
 * and which keys it leaves alone.
 */

interface Node { name: string; focused: boolean; focus(): void }
const node = (name: string): Node => ({ name, focused: false, focus() { this.focused = true; } });

const text: FeedbackText = { known: () => true, t: (key) => key, tr: (key) => key };

test('Escape closes the card and stops the host modal from closing with it', () => {
  const decision = decideOverlayKey({ key: 'Escape' }, { active: node('x'), focusables: [node('dismiss')], card: node('card') });
  assert.equal(decision?.preventDefault, true, 'the host trap returns on a prevented default, so the modal stays open');
  assert.equal(decision?.stopPropagation, true, 'and the key does not bubble to the document listener');
  assert.equal(decision?.dismiss, true, 'the card closes, the settings panel stays open');
  assert.equal(decision?.focus, undefined, 'closing moves focus only through the page, never into limbo here');
});

test('keys the card does not own keep their ordinary behaviour', () => {
  assert.equal(decideOverlayKey({ key: 'Enter' }, { active: node('x'), focusables: [node('button')], card: node('card') }), undefined);
  assert.equal(decideOverlayKey({ key: 'a' }, { active: node('x'), focusables: [], card: node('card') }), undefined);
});

test('Tab wraps inside the card at both ends', () => {
  const first = node('first'); const middle = node('middle'); const last = node('last');
  const focusables = [first, middle, last];
  const card = node('card');

  const atLast = decideOverlayKey({ key: 'Tab' }, { active: last, focusables, card });
  assert.equal(atLast?.preventDefault, true);
  assert.equal(atLast?.stopPropagation, true);
  assert.equal(atLast?.focus, first, 'Tab on the last control wraps to the first');

  const atFirstBack = decideOverlayKey({ key: 'Tab', shiftKey: true }, { active: first, focusables, card });
  assert.equal(atFirstBack?.focus, last, 'Shift+Tab on the first control wraps to the last');

  const forward = decideOverlayKey({ key: 'Tab' }, { active: middle, focusables, card });
  assert.equal(forward?.focus, last, 'in the middle, Tab moves to the next control');
  const backward = decideOverlayKey({ key: 'Tab', shiftKey: true }, { active: middle, focusables, card });
  assert.equal(backward?.focus, first, 'and Shift+Tab to the previous one');
});

test('focus that is not inside the card enters at the matching end', () => {
  const first = node('first'); const last = node('last');
  const focusables = [first, last];
  const card = node('card');
  const container = decideOverlayKey({ key: 'Tab' }, { active: card, focusables, card });
  assert.equal(container?.focus, first, 'the focused container steps into the first control');
  const containerBack = decideOverlayKey({ key: 'Tab', shiftKey: true }, { active: card, focusables, card });
  assert.equal(containerBack?.focus, last, 'and backwards to the last');
  const outside = decideOverlayKey({ key: 'Tab' }, { active: node('page'), focusables, card });
  assert.equal(outside?.focus, first, 'focus elsewhere on the page cannot skip the card');
});

test('a card without controls keeps focus on itself instead of leaking out', () => {
  const card = node('card');
  const decision = decideOverlayKey({ key: 'Tab' }, { active: node('page'), focusables: [], card });
  assert.equal(decision?.preventDefault, true);
  assert.equal(decision?.focus, card);
});

test('only an error card takes focus', () => {
  const success = feedbackForSave({ kind: 'saved' }, text)!;
  const error = feedbackForSave({ kind: 'conflict' }, text)!;
  assert.equal(feedbackTakesFocus(success), false, 'a save that succeeded never pulls the keyboard away');
  assert.equal(feedbackTakesFocus(error), true, 'a refusal announces itself and keeps focus where its links are');
});
