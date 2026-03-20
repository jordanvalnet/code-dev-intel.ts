export function getDisplayValue(fullName: string, town: string): string {
  const normalizedFullName = fullName.trim();
  const normalizedTown = town.trim();
  const parts = [normalizedFullName, normalizedTown];
  const separator = ' / ';
  const mergedValue = parts.join(separator);
  const textValue = `${normalizedFullName} / ${normalizedTown}`;
  return `${mergedValue}:${textValue}`.toUpperCase();
}
