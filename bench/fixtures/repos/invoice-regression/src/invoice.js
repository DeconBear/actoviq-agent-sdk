import { formatCurrency, parseCurrency } from './money.js';

export function invoiceTotal(invoice) {
  const subtotal = invoice.items.reduce((sum, item) => sum + parseCurrency(item.amount), 0);
  return subtotal + parseCurrency(invoice.discount ?? '$0');
}

export function invoiceSummary(invoice) {
  return {
    id: invoice.id,
    itemCount: invoice.items.length,
    total: formatCurrency(invoiceTotal(invoice)),
  };
}
