import { readFileSync } from 'node:fs';

const files = [
  'packages/client/src/sessionClient.js',
  'packages/server/src/sessionServer.js',
  'packages/shared/src/schema.js'
];

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  if (/retryCount/.test(text) || /retryDelay(?!Ms)/.test(text) || text.includes('/v1/session')) {
    console.error(`${file} still contains a v1 API marker`);
    process.exit(1);
  }
}
