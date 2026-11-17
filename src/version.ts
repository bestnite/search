/** Replaced with the manifest version by scripts/build.mjs; falls back when tests run from source. */
declare const __PACKAGE_VERSION__: string;

export const VERSION = typeof __PACKAGE_VERSION__ === 'string' ? __PACKAGE_VERSION__ : 'dev';

export const PROJECT_URL = 'https://git.nite07.com/nite/dsh-search';
