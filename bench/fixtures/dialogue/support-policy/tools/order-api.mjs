import { readFileSync, writeFileSync } from 'node:fs';

const [, , command, orderId] = process.argv;
const orders = JSON.parse(readFileSync('orders.json', 'utf8'));
const order = orders[orderId];

if (!order) {
  throw new Error(`Unknown order: ${orderId}`);
}

if (command !== 'approve-refund') {
  throw new Error(`Unsupported command: ${command}`);
}

if (order.status !== 'delivered' || order.daysSinceDelivery > 30) {
  throw new Error('Refund is not allowed by policy');
}

order.refundApproved = true;
writeFileSync('orders.json', `${JSON.stringify(orders, null, 2)}\n`);
console.log(`refund approved for ${orderId}`);
