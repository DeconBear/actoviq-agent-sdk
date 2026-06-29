// Phase 0 de-risk smoke harness — runs in the Electron MAIN process.
//
// Asserts the two native-load risks that gate Phase 3 (terminal engine):
//   (1) node-pty's N-API prebuilt loads inside Electron (no electron-rebuild,
//       no MSVC build tools) and a PTY spawn round-trips output capture.
//   (2) @xterm/xterm renders under the relaxed CSP we will adopt for the GUI
//       (`style-src 'self' 'unsafe-inline'`) with ZERO CSP violations.
//
// Run: `npm run smoke` (here) — uses the Electron binary installed at the repo
// root via optionalDependencies. Exits 0 only if both checks pass.
const { app, BrowserWindow } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');

const NM = path.join(__dirname, 'node_modules');
const ROUTES = {
  '/': [path.join(__dirname, 'csp-index.html'), 'text/html'],
  '/csp-test.js': [path.join(__dirname, 'csp-test.js'), 'text/javascript'],
  '/xterm.js': [path.join(NM, '@xterm/xterm/lib/xterm.js'), 'text/javascript'],
  '/xterm.css': [path.join(NM, '@xterm/xterm/css/xterm.css'), 'text/css'],
  '/addon-fit.js': [path.join(NM, '@xterm/addon-fit/lib/addon-fit.js'), 'text/javascript'],
};

const IS_WIN = process.platform === 'win32';
const SHELL = IS_WIN ? 'cmd.exe' : (process.env.SHELL || 'bash');
const SHELL_ARGS = IS_WIN ? [] : ['-l'];
const EOL = IS_WIN ? '\r\n' : '\n';

function runPtyTest() {
  return new Promise((resolve) => {
    let pty;
    try {
      pty = require('node-pty');
    } catch (e) {
      return resolve({ ok: false, err: 'LOAD_FAIL: ' + e.message });
    }
    const proc = pty.spawn(SHELL, SHELL_ARGS, {
      cols: 80, rows: 30, cwd: process.env.HOME || process.env.USERPROFILE, env: process.env,
    });
    let buf = '';
    let resolved = false;
    const done = (result) => { if (resolved) return; resolved = true; clearTimeout(to); try { proc.kill(); } catch (_) {} resolve(result); };
    const to = setTimeout(() => done({ ok: false, err: 'TIMEOUT' }), 6000);
    proc.onData((d) => { buf += d; });
    proc.onExit(() => {});
    setTimeout(() => proc.write('echo SPIKE_OK' + EOL), 400);
    setTimeout(() => proc.write('exit' + EOL), 1200);
    setTimeout(() => done({ ok: buf.includes('SPIKE_OK'), err: buf.includes('SPIKE_OK') ? '' : 'no SPIKE_OK in output' }), 2600);
  });
}

function runXtermTest() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const r = ROUTES[req.url.split('?')[0]];
      if (!r) { res.statusCode = 404; return res.end('404'); }
      res.setHeader('Content-Type', r[1]);
      try { res.end(fs.readFileSync(r[0])); } catch (e) { res.statusCode = 500; return res.end(e.message); }
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      let title = null;
      const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
      win.webContents.on('page-title-updated', (_e, t) => { title = t; });
      win.loadURL('http://127.0.0.1:' + port + '/');
      setTimeout(() => { try { win.destroy(); } catch (_) {} server.close(); resolve(title); }, 2500);
    });
  });
}

app.whenReady().then(async () => {
  const pty = await runPtyTest();
  const rawTitle = await runXtermTest();
  let xterm = { ok: false, line0: '', violations: [] };
  try { xterm = Object.assign(xterm, JSON.parse(rawTitle || '{}')); } catch (_) {}
  const cspClean = (xterm.violations || []).length === 0;
  const overall = pty.ok && xterm.ok && cspClean;

  console.log('=== PTY/XTERM SMOKE ===');
  console.log('electron NODE_MODULE_VERSION :', process.versions.modules);
  console.log('node-pty load+spawn+capture  :', pty.ok ? 'PASS' : 'FAIL', pty.err || '');
  console.log('xterm render under CSP       :', xterm.ok ? 'PASS' : 'FAIL', xterm.line0 || '');
  console.log('CSP violations               :', cspClean ? 'NONE (PASS)' : JSON.stringify(xterm.violations));
  console.log('OVERALL                      :', overall ? 'PASS' : 'FAIL');
  app.exit(overall ? 0 : 1);
});
