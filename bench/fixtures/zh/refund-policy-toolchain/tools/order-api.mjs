import { readFileSync, writeFileSync } from 'node:fs';

const [, , command, orderId, status] = process.argv;
const data = JSON.parse(readFileSync('orders.json', 'utf8'));
const order = data.orders.find((item) => item.id === orderId);

if (command !== 'set-status' || !order || !status) {
  console.error('Usage: node tools/order-api.mjs set-status <order-id> <status>');
  process.exit(1);
}

order.status = status;
writeFileSync('orders.json', `${JSON.stringify(data, null, 2)}\n`);
console.log(`${orderId} -> ${status}`);
