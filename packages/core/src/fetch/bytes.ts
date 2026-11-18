/**
 * UTF-8 byte length, shared by the acquisition bounds that must not count characters.
 *
 * A configured byte budget is about the bytes that cross a boundary — a wire body or a captured
 * document — so a page of CJK or emoji costs three or four bytes per character. `TextEncoder` has the
 * same semantics in Node and inside the remote browser, which is why it is used on both sides.
 */
export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
