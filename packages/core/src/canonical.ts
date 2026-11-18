/**
 * Order-independent serialization of a configuration value.
 *
 * A saved configuration reaches the process through several shapes: the YAML row a user wrote, the
 * schema-resolved object a plugin receives, and the normalized object `parseConfig()` returns. Those
 * shapes may carry the same values under a different key insertion order, so comparing their JSON
 * text reports a difference that does not exist. This serializer sorts object keys, keeps array
 * order (a route list is meaningful), and follows JSON's own treatment of absent values: an
 * `undefined` object property is omitted, an `undefined` array element becomes `null`.
 *
 * Anything JSON could not carry — a function, a symbol, a bigint, a cycle — throws instead of
 * degrading into a hash of something else, so a caller never compares two values it cannot represent.
 */
export function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  const walk = (input: unknown): string => {
    if (input === null) return 'null';
    switch (typeof input) {
      case 'string':
        return JSON.stringify(input);
      case 'number':
        if (!Number.isFinite(input)) throw new TypeError('A configuration value contains a non-finite number.');
        return JSON.stringify(input);
      case 'boolean':
        return input ? 'true' : 'false';
      case 'undefined':
        return 'null';
      case 'bigint':
        throw new TypeError('A configuration value contains a bigint.');
      case 'function':
      case 'symbol':
        throw new TypeError(`A configuration value contains a ${typeof input}.`);
      case 'object': {
        if (seen.has(input as object)) throw new TypeError('A configuration value contains a cycle.');
        seen.add(input as object);
        try {
          if (Array.isArray(input)) return `[${input.map(item => walk(item)).join(',')}]`;
          const record = input as Record<string, unknown>;
          const parts: string[] = [];
          for (const key of Object.keys(record).sort()) {
            const item = record[key];
            if (item === undefined) continue;
            parts.push(`${JSON.stringify(key)}:${walk(item)}`);
          }
          return `{${parts.join(',')}}`;
        } finally {
          seen.delete(input as object);
        }
      }
      /* v8 ignore next 2 -- the switch above covers every typeof result. */
      default:
        throw new TypeError('A configuration value is not JSON-shaped.');
    }
  };
  return walk(value);
}

/** Whether two configurations carry the same values, regardless of key order. */
export function sameConfig(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

/**
 * Rebuild a value in the key order of its exemplar, appending keys the exemplar does not know.
 * `parseConfig()` runs this so a configuration filled from an older save serializes, hashes and
 * displays in one stable order, matching a configuration that already carried every key.
 */
export function orderLike(exemplar: unknown, value: unknown): unknown {
  if (Array.isArray(value)) {
    const item = Array.isArray(exemplar) ? exemplar[0] : undefined;
    return value.map(entry => orderLike(item, entry));
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const shape = exemplar && typeof exemplar === 'object' && !Array.isArray(exemplar) ? exemplar as Record<string, unknown> : undefined;
  const out: Record<string, unknown> = {};
  if (shape) for (const key of Object.keys(shape)) if (Object.hasOwn(record, key)) out[key] = orderLike(shape[key], record[key]);
  for (const key of Object.keys(record)) if (!Object.hasOwn(out, key)) out[key] = orderLike(undefined, record[key]);
  return out;
}
