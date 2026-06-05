import { readFileSync, writeFileSync } from 'node:fs';

const [, , command, ticketId, status] = process.argv;
const data = JSON.parse(readFileSync('tickets.json', 'utf8'));
const ticket = data.tickets.find((item) => item.id === ticketId);

if (command !== 'set-status' || !ticket || !status) {
  console.error('Usage: node tools/ticket-api.mjs set-status <ticket-id> <status>');
  process.exit(1);
}

ticket.status = status;
writeFileSync('tickets.json', `${JSON.stringify(data, null, 2)}\n`);
console.log(`${ticketId} -> ${status}`);
