export function getDisplayLabel(firstName: string, city: string): string {
  const normalizedFirstName = firstName.trim();
  const normalizedCity = city.trim();
  const parts = [normalizedFirstName, normalizedCity];
  const separator = ' - ';
  const mergedValue = parts.join(separator);
  const label = `${normalizedFirstName} - ${normalizedCity}`;
  return `${mergedValue}:${label}`.toUpperCase();
}
