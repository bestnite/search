import type { ConfigIssue } from '@nite07/search-core/static';
import type { SaveOutcome } from './presenter.js';

/**
 * What the floating save feedback says.
 *
 * The model lives here, apart from the React component, so the wording, the transience and the
 * distinction between a refusal, a real conflict and an unconfirmed write can be exercised by tests
 * without a DOM. The component only renders this value: a success is transient and never takes
 * focus, an error stays until the user dismisses it.
 */
export const SUCCESS_FEEDBACK_MS = 6000;

export interface SaveFeedback {
  kind: 'success' | 'error';
  /** The headline of an error card. A success carries its whole message in `text`. */
  title?: string;
  text?: string;
  /** A server sentence, kept beside the localized wording instead of replacing it. */
  detail?: string;
  /** Every issue the refusal named, so the card can link to each field. */
  issues: ConfigIssue[];
}

/** The translator shape the client already binds; injected so tests can supply the real locale. */
export interface FeedbackText {
  known(key: string): boolean;
  t(key: string): string;
  tr(key: string, vars: Record<string, string | number>): string;
}

/** The headline of a refused save: the localized cause, or the generic rejection. */
export function saveErrorTitle(code: string, text: FeedbackText): string {
  const key = `saveError.${code}`;
  return text.known(key) ? text.t(key) : text.t('saveRejected');
}

/**
 * Turn a classified save outcome into the card to show, or `undefined` when there is nothing to say.
 *
 * Nothing here invents a state: a 400 lists the cause and links to it, a 409 says the saved state is
 * not the draft, a 5xx whose read-back disagrees says the write failed with its own reason, and the
 * two unconfirmed kinds stay apart because "reload before saving again" means something different
 * from "the write was refused".
 */
export function feedbackForSave(
  outcome: SaveOutcome,
  text: FeedbackText,
  options: { verified?: boolean; serverMessage?: string } = {},
): SaveFeedback | undefined {
  switch (outcome.kind) {
    case 'saved':
      return { kind: 'success', text: text.t(options.verified ? 'savedVerified' : 'saved'), issues: [] };
    case 'rejected': {
      const serverMessage = options.serverMessage ?? '';
      return {
        kind: 'error',
        title: saveErrorTitle(outcome.code, text),
        // The list below carries the causes, so the card does not repeat them as a sentence.
        ...(outcome.issues.length ? {} : { text: serverMessage ? text.tr('saveServerDetail', { message: serverMessage }) : text.t('saveRejected') }),
        issues: outcome.issues,
      };
    }
    case 'conflict':
      return { kind: 'error', title: text.t('conflictTitle'), text: text.t('conflict'), issues: [] };
    case 'write-failed':
      return { kind: 'error', title: text.t('saveFailed'), detail: outcome.message, issues: [] };
    case 'unconfirmed':
      return { kind: 'error', title: text.t('saveUnconfirmedTitle'), text: text.t('saveUnconfirmed'), issues: [] };
    case 'state-unknown':
      return { kind: 'error', title: text.t('saveStateUnknownTitle'), text: text.t('saveStateUnknown'), issues: [] };
  }
}

/**
 * Whether opening this card moves focus into it.
 *
 * A refusal has to be announced and its field links have to be reachable, so it takes focus. A
 * success must not: the save already finished, and pulling the keyboard away from the next edit is
 * the opposite of helpful.
 */
export function feedbackTakesFocus(feedback: SaveFeedback): boolean {
  return feedback.kind === 'error';
}

/** How long the card may stay: a success dismisses itself, an error waits for the user. */
export function feedbackAutoDismissMs(feedback: SaveFeedback): number | undefined {
  return feedback.kind === 'success' ? SUCCESS_FEEDBACK_MS : undefined;
}
