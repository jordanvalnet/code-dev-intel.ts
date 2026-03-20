export function computeMonthlyPrice(basePrice: number, fees: number): number {
  const subtotal = basePrice + fees;
  const vat = subtotal * 0.15;
  const total = subtotal + vat;
  return Math.round(total);
}
