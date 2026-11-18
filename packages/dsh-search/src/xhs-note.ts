/**
 * The note renderer lives in the core so both hosts produce the same text for the same note.
 * This module keeps the plugin's existing import path.
 */
export { formatXhsNote, renderXhsNote } from '@nite07/search-core';
export type { XhsNoteReport } from '@nite07/search-core';
