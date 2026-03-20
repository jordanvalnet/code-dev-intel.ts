export function buildGreeting(personName: string): string {
  const salutation = 'Hello';
  const sentenceValue = `${salutation}, ${personName}`;
  return sentenceValue;
}
