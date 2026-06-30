// Headless Electron capture: launch the Actoviq GUI and screenshot each region.
// Usage: node tmp/playwright-debug.mjs [--build] [--regions=project,team,chat]
//
// Notes:
//   - Without --build, runs against the built JS in dist/src/gui (so Electron
//     can load it without tsx). The Electron binary lives in
//     node_modules/electron/dist/electron.exe.
//   - With --build, runs against dist_electron/win-unpacked/Actoviq.exe (production).
//   - All screenshots land in tmp/screens/<region>.png.
import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ARGS = new Set(process.argv.slice(2));
const BUILD = ARGS.has('--build');
const REGIONS = (process.argv.find(a => a.startsWith('--regions='))?.slice('--regions='.length).split(',').filter(Boolean)) || [
  'project', 'team', 'automation', 'plugins', 'conversation',
];

const OUT = path.join(__dirname, 'screens');
fs.mkdirSync(OUT, { recursive: true });

let exe, scriptArgs;
if (BUILD) {
  exe = path.join(ROOT, 'dist_electron/win-unpacked/Actoviq.exe');
  scriptArgs = [path.join(ROOT)];
} else {
  exe = path.join(ROOT, 'node_modules/electron/dist/electron.exe');
  scriptArgs = [path.join(ROOT, 'dist/src/gui/electronMain.js'), path.join(ROOT)];
}

if (!fs.existsSync(exe)) {
  console.error(`electron exe not found: ${exe}`);
  process.exit(2);
}

console.log(`launching ${exe} build=${BUILD} regions=${REGIONS.join(',')}`);
const app = await electron.launch({
  executablePath: exe,
  args: scriptArgs,
  cwd: ROOT,
  env: {
    ...process.env,
    NODE_ENV: BUILD ? 'production' : 'development',
    ELECTRON_DISABLE_SANDBOX: '1',
  },
});

const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
await win.waitForSelector('.sidebar', { timeout: 15000 });
await win.waitForTimeout(800); // CSS settle + RunRegistry warmup

// Enable dev tools (terminal/monitor) for full layout screenshots.
await win.evaluate(() => document.body.setAttribute('data-dev-tools', 'true'));
await win.evaluate(() => document.body.setAttribute('data-terminal-capable', 'true'));

async function snap(name, beforeClick) {
  if (beforeClick) {
    try { await win.click(beforeClick, { timeout: 3000 }); } catch (e) { console.warn(`[${name}] click failed:`, e.message); }
    await win.waitForTimeout(450);
  }
  const out = path.join(OUT, `${name}.png`);
  await win.screenshot({ path: out, fullPage: false });
  console.log(`saved ${out}`);
}

for (const region of REGIONS) {
  switch (region) {
    case 'project':      await snap('project',      '#navProject'); break;
    case 'team':         await snap('team',         '#navTeam'); break;
    case 'automation':   await snap('automation',   '#navAutomation'); break;
    case 'plugins':      await snap('plugins',      '#navPlugins'); break;
    case 'conversation': await snap('conversation', '#navProject'); break;
    default: console.warn(`unknown region ${region}`);
  }
}

await app.close();
console.log('done');