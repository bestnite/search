import type { PageFetchResult } from './types.js';

/**
 * Text rendering of one page-fetch result for an agent or a person: what was fetched, through which
 * route, why it stopped, and the bounded attempt trail. Both hosts print this same text, so a
 * diagnostic does not depend on which entry point made the call.
 */
export function renderPageFetchReport(result: PageFetchResult): string {
  const lines: string[] = [];
  lines.push(`# ${result.finalUrl ?? result.requestedUrl}`);
  const facts = [
    `format: ${result.format}`,
    `route: ${result.contentRoute ?? 'none'}${result.contentProvider ? ` (${result.contentProvider})` : ''}`,
    `representation: ${result.representation ?? 'none'}`,
    `accepted: ${result.ok ? 'yes' : 'no'}`,
    `stopped: ${result.stopReason}`,
  ];
  if (result.statusCode !== undefined) facts.push(`target status: ${result.statusCode}`);
  if (result.truncated) facts.push('truncated');
  lines.push(facts.join(' · '));
  if (result.content) lines.push('', result.content);
  if (result.attempts.length) {
    lines.push('', '## Attempts');
    for (const attempt of result.attempts) {
      const detail = [
        `${attempt.route}${attempt.provider ? `/${attempt.provider}` : ''}`,
        `${attempt.outcome} in ${attempt.durationMs}ms`,
        ...(attempt.statusCode === undefined ? [] : [`target ${attempt.statusCode}`]),
        ...(attempt.apiStatus === undefined ? [] : [`provider API ${attempt.apiStatus}`]),
        ...(attempt.representation ? [attempt.representation] : []),
        ...(attempt.rules.length ? [`rules ${attempt.rules.join(', ')}`] : []),
        ...(attempt.error ? [`${attempt.error.kind}: ${attempt.error.message}`] : []),
      ];
      lines.push(`- ${detail.join(' · ')}`);
      if (attempt.unavailable.length) lines.push(`  unavailable: ${attempt.unavailable.join('; ')}`);
    }
  }
  if (result.notes.length) {
    lines.push('', '## Notes');
    for (const note of result.notes) lines.push(`- ${note}`);
  }
  return lines.join('\n');
}
