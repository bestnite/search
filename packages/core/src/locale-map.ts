/**
 * Canonical language and region codes, and each backend's own spelling of them.
 *
 * A single free-text field was wrong: the providers do not share one vocabulary.
 * Brave wants `zh-hans`/`US`, Serper wants `zh-cn`/`us`, SearXNG wants `zh-CN`,
 * You.com wants upper-case primary tags, and several backends accept neither
 * field at all. Users pick a canonical value here; adapters translate it, and a
 * value a backend cannot express is skipped with a warning instead of being
 * forwarded as an unsupported string.
 */
export const LANGUAGES = ['', 'en', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'fr', 'de', 'es', 'pt', 'ru', 'it', 'ar', 'nl', 'pl', 'tr', 'vi', 'th', 'id'] as const;
export const REGIONS = ['', 'US', 'GB', 'CN', 'HK', 'TW', 'JP', 'KR', 'SG', 'IN', 'AU', 'CA', 'DE', 'FR', 'ES', 'IT', 'NL', 'BR', 'MX', 'RU', 'TR', 'SA'] as const;
export type LanguageCode = (typeof LANGUAGES)[number];
export type RegionCode = (typeof REGIONS)[number];

const isLanguage = (value: string): value is LanguageCode => (LANGUAGES as readonly string[]).includes(value);
const isRegion = (value: string): value is RegionCode => (REGIONS as readonly string[]).includes(value);

/** Translate a canonical language code into the backend's own argument, or undefined when unsupported. */
export function languageFor(backendId: string, code: string): string | undefined {
  if (!code || !isLanguage(code)) return undefined;
  switch (backendId) {
    case 'brave': return code.toLowerCase();
    case 'serper': return code === 'zh-Hans' ? 'zh-cn' : code === 'zh-Hant' ? 'zh-tw' : code.toLowerCase();
    case 'searxng': return code === 'zh-Hans' ? 'zh-CN' : code === 'zh-Hant' ? 'zh-TW' : code;
    case 'anysearch': return code.split('-')[0]!.toLowerCase();
    case 'you': return code.split('-')[0]!.toUpperCase();
    default: return undefined;
  }
}

/** Translate a canonical region code into the backend's own argument, or undefined when unsupported. */
export function regionFor(backendId: string, code: string): string | undefined {
  if (!code || !isRegion(code)) return undefined;
  switch (backendId) {
    case 'brave': return code;
    case 'serper': return code.toLowerCase();
    case 'you': return code;
    default: return undefined;
  }
}
