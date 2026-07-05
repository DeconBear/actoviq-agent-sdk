// Windows dev launcher: copy electron.exe → Actoviq.exe beside Electron's dist
// resources (icudtl.dat, resources/, …) and embed assets/actoviq-icon.ico.
// Windows taskbar icons come from the executable image, not BrowserWindow.setIcon.
import { copyFileSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

if (process.platform !== 'win32') {
  process.exit(0);
}

const electronExe = require('electron');
const distDir = dirname(electronExe);
const iconIco = join(root, 'assets', 'actoviq-icon.ico');
const launcher = join(distDir, 'Actoviq.exe');

if (!existsSync(iconIco)) {
  process.stderr.write('prepare-gui-launcher: missing assets/actoviq-icon.ico — run npm run generate:icon\n');
  process.exit(1);
}

const sources = [electronExe, iconIco];
const stale = !existsSync(launcher)
  || sources.some((src) => statSync(src).mtimeMs > statSync(launcher).mtimeMs);

if (!stale) {
  process.stdout.write(`prepare-gui-launcher: up to date (${launcher})\n`);
  process.exit(0);
}

copyFileSync(electronExe, launcher);

let rcedit;
try {
  rcedit = require('rcedit');
} catch {
  process.stderr.write('prepare-gui-launcher: install rcedit (npm install -D rcedit)\n');
  process.exit(1);
}

await rcedit(launcher, {
  icon: iconIco,
  'product-version': '1.0.0',
  'version-string': {
    FileDescription: 'Actoviq',
    ProductName: 'Actoviq',
    CompanyName: 'Actoviq',
    OriginalFilename: 'Actoviq.exe',
    InternalName: 'Actoviq',
  },
});

process.stdout.write(`prepare-gui-launcher: wrote ${launcher}\n`);
