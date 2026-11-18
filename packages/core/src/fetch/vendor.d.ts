/**
 * Ambient declarations for two small dependencies that ship no usable typings for this build.
 * Both are converted-mainstream packages: turndown and its GFM rules.
 */
declare module '@mixmark-io/domino' {
  export function createDocument(html?: string, force?: boolean): Document;
  export function createDOMImplementation(): DOMImplementation;
  export function createWindow(html?: string, address?: string): Window;
  const domino: {
    createDocument: typeof createDocument;
    createDOMImplementation: typeof createDOMImplementation;
    createWindow: typeof createWindow;
  };
  export default domino;
}

declare module 'turndown-plugin-gfm' {
  import type TurndownService from 'turndown';
  export function gfm(service: TurndownService): void;
  export function tables(service: TurndownService): void;
  export function strikethrough(service: TurndownService): void;
  export function taskListItems(service: TurndownService): void;
}
