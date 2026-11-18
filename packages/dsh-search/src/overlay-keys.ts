/**
 * Keyboard handling for the floating save-feedback card.
 *
 * The card is portalled to `document.body`, outside the settings modal's focus trap. Two host
 * behaviours make that matter: the modal keeps focus inside itself by watching `Tab` on the document
 * and pulling focus back when the default was not prevented, and its own `Escape` handler closes the
 * whole settings panel — which would take the draft with it.
 *
 * So the card handles both keys itself: it prevents the default (the host's trap returns on that) and
 * stops its own propagation, wraps `Tab`/`Shift+Tab` inside the card's controls, and turns `Escape`
 * into "close this card" instead of "close the settings panel". This is not a keyboard trap: `Escape`
 * closes the card, its own buttons are reachable, a success disappears on its own, and focus returns
 * to the save button when the card held it.
 */
export interface OverlayKeyEvent {
  key: string;
  shiftKey?: boolean;
}

export interface OverlayKeyContext {
  /** The element that currently holds focus, usually `document.activeElement`. */
  active: unknown;
  /** Focusable descendants of the card, in document order. */
  focusables: readonly unknown[];
  /** The card container itself, focusable through `tabIndex={-1}`. */
  card: unknown;
}

export interface OverlayKeyDecision {
  preventDefault: boolean;
  stopPropagation: boolean;
  /** Close the card instead of forwarding the key. */
  dismiss?: boolean;
  /** The element that must take focus as a result of this key. */
  focus?: unknown;
}

/**
 * Decide what a key pressed inside the card means. `undefined` means "this key is not ours": the
 * host modal keeps handling it, which is what a transient toast wants for `Tab`.
 */
export function decideOverlayKey(event: OverlayKeyEvent, context: OverlayKeyContext): OverlayKeyDecision | undefined {
  if (event.key === 'Escape') {
    // Closes the card, never the settings panel the card is floating over.
    return { preventDefault: true, stopPropagation: true, dismiss: true };
  }
  // A key that is not ours (anything but Escape or Tab) keeps its ordinary behaviour.
  if (event.key !== 'Tab') return undefined;
  const count = context.focusables.length;
  if (!count) return { preventDefault: true, stopPropagation: true, focus: context.card };
  const index = context.focusables.indexOf(context.active);
  // Focus that is not inside the card yet enters at the matching end, so the cycle has no dead gap.
  const target = index < 0
    ? (event.shiftKey ? context.focusables[count - 1] : context.focusables[0])
    : context.focusables[(index + (event.shiftKey ? -1 : 1) + count) % count];
  return { preventDefault: true, stopPropagation: true, focus: target };
}
