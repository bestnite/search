import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * The typography scale and the floating feedback layer, checked against the stylesheets this package
 * ships. These are properties of the delivered CSS rather than of a source token: a new rule that
 * guesses its own pixel size, a banner that would be clipped, or an overlay that lands under the
 * settings modal fails here.
 */

async function sheets(): Promise<Array<{ name: string; css: string }>> {
  const names = ['client.css', 'client.overrides.css'];
  return Promise.all(names.map(async name => ({
    name,
    css: (await readFile(new URL(`../src/${name}`, import.meta.url), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, ''),
  })));
}

interface Rule { selectors: string[]; body: string }

function parse(css: string): Rule[] {
  const rules: Rule[] = [];
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    rules.push({ selectors: match[1]!.split(',').map(part => part.trim()), body: match[2]! });
  }
  return rules;
}

/** Every size in the page comes from one place: the scale declared for the page and the overlay. */
test('every font size is a token from one scale, and no rule resets type with the shorthand', async () => {
  const declared = new Set<string>();
  for (const sheet of await sheets()) {
    for (const rule of parse(sheet.css)) {
      for (const declaration of rule.body.matchAll(/(?:^|;)\s*font-size\s*:\s*([^;]+)/g)) {
        const value = declaration[1]!.trim();
        // `inherit` is the one deliberate exception: an inline link carries the size of the sentence
        // it sits in, so it cannot disagree with the copy around it.
        if (/^var\(--ns-text-(micro|help|body|lead|section|title)\)$/.test(value) || value === 'inherit') continue;
        assert.fail(`${sheet.name}: font-size ${value} in "${rule.selectors.join(', ')}" is outside the shared scale`);
      }
      assert.equal(/(?:^|;)\s*font\s*:\s*inherit/.test(rule.body), false, `${sheet.name}: "font: inherit" resets the scale in "${rule.selectors.join(', ')}"`);
      for (const token of rule.body.matchAll(/--ns-text-([a-z]+)\s*:\s*([0-9.]+)px/g)) declared.add(`${token[1]}:${token[2]}`);
    }
  }
  assert.deepEqual([...declared].sort(), ['body:13', 'help:12', 'lead:14', 'micro:11', 'section:15', 'title:20'], 'one scale, six steps');
});

test('the scale reaches the floating layer as well as the page', async () => {
  const [base] = await sheets();
  const owners = parse(base!.css).filter(rule => /--ns-text-body\s*:/.test(rule.body));
  assert.equal(owners.length, 1, 'the scale is declared once');
  assert.ok(owners[0]!.selectors.includes('.ns-page'), 'the page reads the scale');
  assert.ok(owners[0]!.selectors.includes('.ns-feedback-layer'), 'the portalled layer reads the same scale');
});

/** The overlay contract: fixed above the settings modal, click-through layer, three distinct cards. */
test('the feedback layer floats above the settings modal and never clips its card', async () => {
  const all = (await sheets()).flatMap(sheet => parse(sheet.css));
  const layer = all.filter(rule => rule.selectors.includes('.ns-feedback-layer'));
  assert.ok(layer.length, 'the layer has styles');
  const layerBody = layer.map(rule => rule.body).join(';');
  assert.match(layerBody, /position:\s*fixed/, 'a fixed layer is independent of any scroll container');
  const zIndex = Number(/z-index:\s*(-?[0-9]+)/.exec(layerBody)?.[1]);
  assert.ok(zIndex > 1000, `the layer (z-index ${zIndex}) must sit above the settings modal (z-index 1000)`);
  assert.match(layerBody, /pointer-events:\s*none/, 'the layer itself is click-through');
  assert.equal(/overflow:\s*hidden/.test(layerBody), false, 'the layer must not clip the card');
  assert.match(layerBody, /inset-inline-end:\s*24px/, 'the card is anchored inside the viewport');

  const card = all.filter(rule => rule.selectors.includes('.ns-feedback')).map(rule => rule.body).join(';');
  assert.match(card, /pointer-events:\s*auto/, 'the card itself receives pointer events');
  for (const state of ['success', 'error', 'pending']) {
    assert.ok(all.some(rule => rule.selectors.includes(`.ns-feedback--${state}`)), `the ${state} card has its own style`);
  }
  // The card lives outside the page element, so it must carry its own control anatomy.
  const cardButtons = all.filter(rule => rule.selectors.some(selector => /^\.ns-feedback (?:.ns-actions )?button/.test(selector)));
  assert.ok(cardButtons.length >= 3, 'the card styles its buttons, their pressed state and their focus ring');
  assert.ok(cardButtons.some(rule => /font-size:\s*var\(--ns-text-body\)/.test(rule.body)), 'card buttons read the shared scale');
  assert.ok(cardButtons.some(rule => rule.selectors.some(selector => selector.includes(':focus-visible'))), 'card buttons show a focus ring');
  const error = all.filter(rule => rule.selectors.includes('.ns-feedback--error')).map(rule => rule.body).join(';');
  assert.match(error, /max-height/, 'a long refusal stays inside the viewport');
  assert.match(error, /overflow:\s*auto/, 'and scrolls instead of growing past it');
});

/** No in-page copy of the save result is left: the floating card is the only surface. */
test('the retired in-page save banners are gone', async () => {
  const css = (await sheets()).map(sheet => sheet.css).join('\n');
  assert.equal(/\.ns-status\s*\{/.test(css), false, 'the top status bar is gone');
  assert.equal(/\.ns-save-error\s*\{/.test(css), false, 'the top save-error banner is gone');
});
