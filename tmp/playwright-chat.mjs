// Capture the conversation view: directly drill into a chat row by showing the
// rich sidebar first, then click.
import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'screens');
fs.mkdirSync(OUT, { recursive: true });

const exe = path.join(ROOT, 'node_modules/electron/dist/electron.exe');
const args = [path.join(ROOT, 'dist/src/gui/electronMain.js'), path.join(ROOT)];

console.log('launching', exe);
const app = await electron.launch({ executablePath: exe, args, cwd: ROOT, env: { ...process.env, NODE_ENV: 'development' } });
const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
await win.waitForSelector('.sidebar', { timeout: 15000 });
await win.evaluate(() => document.body.setAttribute('data-dev-tools', 'true'));
await win.evaluate(() => document.body.setAttribute('data-terminal-capable', 'true'));
// Force rich sidebar so chat rows are reachable.
await win.evaluate(() => { document.body.dataset.sidebarMode = 'full'; });
await win.waitForTimeout(1200);

// Click the first chat row in the rich sidebar.
const row = win.locator('.project-chat-row').first();
const exists = await row.count();
console.log('chat rows:', exists);
if (exists > 0) {
  await row.scrollIntoViewIfNeeded();
  await row.click({ force: true });
}
await win.waitForTimeout(900);
await win.screenshot({ path: path.join(OUT, 'conversation.png') });
console.log('saved conversation.png');

await app.close();
console.log('done');