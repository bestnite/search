import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Version of this package, read from its own manifest so it cannot drift. */
export const VERSION: string = (() => {
  try {
    const manifest = require('../package.json') as { version?: unknown };
    return typeof manifest.version === 'string' ? manifest.version : 'dev';
  } catch {
    return 'dev';
  }
})();

export const PROJECT_URL = 'https://git.nite07.com/nite/search';
