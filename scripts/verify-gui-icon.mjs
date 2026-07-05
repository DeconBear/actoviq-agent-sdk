import { app, nativeImage } from 'electron';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function resolveIconPathFromMainDir(mainDir, cwd) {
  const icos = [
    path.join(mainDir, '../../../assets/actoviq-icon.ico'),
    path.join(cwd, 'assets', 'actoviq-icon.ico'),
  ];
  if (process.env.ACTOVIQ_GUI_ROOT) {
    icos.unshift(path.join(process.env.ACTOVIQ_GUI_ROOT, 'assets', 'actoviq-icon.ico'));
  }
  return icos.find((c) => existsSync(c));
}

const mainDir = path.dirname(fileURLToPath(new URL('../dist/src/gui/electronMain.js', import.meta.url)));

app.whenReady().then(() => {
  const iconPath = resolveIconPathFromMainDir(mainDir, process.cwd());
  console.log('ACTOVIQ_GUI_ROOT', process.env.ACTOVIQ_GUI_ROOT || '(unset)');
  console.log('cwd', process.cwd());
  console.log('iconPath', iconPath || '(not found)');
  if (iconPath) {
    const img = nativeImage.createFromPath(iconPath);
    console.log('ico nativeImage empty', img.isEmpty(), 'size', JSON.stringify(img.getSize()));
  }
  const pngPath = path.join(process.cwd(), 'assets', 'actoviq-icon.png');
  if (existsSync(pngPath)) {
    const png = nativeImage.createFromPath(pngPath);
    console.log('png nativeImage empty', png.isEmpty(), 'size', JSON.stringify(png.getSize()));
  }
  app.quit();
});
