/**
 * The trust boundary every page-fetch route that resolves the target outside this process must
 * disclose.
 *
 * The HTTP route resolves the name inside its own socket lookup, so the public-only policy can prove
 * where it connected. A remote browser and a provider resolve the name somewhere else, so the local
 * check proves nothing about the actual destination. One sentence in one form for both, so a route
 * cannot quietly drop the disclosure or drift into different wording.
 */
export function delegatedNote(actor: 'browser' | 'provider'): string {
  const who = actor === 'browser' ? 'The browser' : 'The provider';
  return `${who} resolved the target outside this process: the local public-only check cannot prove its destination.`;
}
