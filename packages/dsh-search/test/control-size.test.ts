import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('text input styling excludes both selection control types', () => {
  const css = readFileSync(new URL('../src/client.css', import.meta.url), 'utf8');
  const selector = css.split('{').findLast(part => part.includes('.ns-page input:not('));
  assert.ok(selector?.includes(':not([type=checkbox]):not([type=radio])'));
});

test('checkboxes and radios share a fixed non-growing control size', () => {
  const css = readFileSync(new URL('../src/client.css', import.meta.url), 'utf8');
  const rule = css.match(/\.ns-page input:is\(\[type=checkbox\],\[type=radio\]\)\{([^}]+)\}/)?.[1];
  assert.ok(rule);
  for (const declaration of ['flex:0 0 18px', 'width:18px', 'height:18px', 'min-width:18px', 'min-height:18px', 'max-width:18px', 'max-height:18px', 'padding:0']) {
    assert.ok(rule.includes(declaration), declaration);
  }
});
