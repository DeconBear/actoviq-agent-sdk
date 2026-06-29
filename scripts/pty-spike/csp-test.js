// Renderer-side check: load xterm under the relaxed CSP, write a marker,
// read it back from the terminal buffer, and report any CSP violations.
// addon-fit's UMD exposes its constructor as `FitAddon.FitAddon` (the whole
// exports object is attached to the global), not `FitAddon` directly.
(function () {
  var violations = [];
  document.addEventListener('securitypolicyviolation', function (e) {
    violations.push(e.violatedDirective + ' <= ' + e.blockedURI);
  });
  function report(ok, line0) {
    document.title = JSON.stringify({ ok: ok, line0: line0, violations: violations });
  }
  try {
    var term = new Terminal({ convertEol: true, cols: 80, rows: 24 });
    term.open(document.getElementById('term'));
    var fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    fit.fit();
    term.write('SPIKE_XTERM_OK\r\n');
    setTimeout(function () {
      var line0 = term.buffer.active.getLine(0).translateToString(true);
      report(line0.indexOf('SPIKE_XTERM_OK') !== -1, line0.slice(0, 30));
    }, 300);
  } catch (err) {
    report(false, 'THREW:' + err.message);
  }
})();
