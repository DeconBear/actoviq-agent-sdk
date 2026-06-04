import assert from 'node:assert/strict';

import { invoiceSummary, invoiceTotal } from './src/invoice.js';
import { parseCurrency } from './src/money.js';

const invoice = {
  id: 'INV-7',
  items: [
    { label: 'hosting', amount: '$1,200.50' },
    { label: 'support', amount: '$80.25' },
  ],
  discount: '$30.75',
};

assert.equal(parseCurrency('$1,200.50'), 1200.5);
assert.equal(invoiceTotal(invoice), 1250);
assert.deepEqual(invoiceSummary(invoice), {
  id: 'INV-7',
  itemCount: 2,
  total: '$1,250.00',
});
