/**
 * This documentation block mentions targetSymbol on purpose so the
 * naive `indexOf(symbol)` resolver would land here (in a comment) and
 * fail to anchor on the actual declaration below.
 */

// Another mention of targetSymbol in a single-line comment.
const stringContainingSymbol = 'this string mentions targetSymbol but is not it';

export function targetSymbol(input: string): string {
  return `target: ${input} (${stringContainingSymbol.length})`;
}

export function callsTargetSymbol(): string {
  return targetSymbol('local-call');
}
