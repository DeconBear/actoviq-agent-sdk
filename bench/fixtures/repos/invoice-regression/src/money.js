export function parseCurrency(value) {
  return Number(String(value ?? 0).replace('$', ''));
}

export function formatCurrency(amount) {
  return `$${amount.toFixed(2)}`;
}
