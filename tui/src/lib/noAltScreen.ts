/**
 * stdout wrapper that strips Ink's alternate screen escape codes,
 * forcing rendering into the main terminal buffer for native scrollback.
 */
const ALTS = [
  '\x1b[?1049h', '\x1b[?1049l',  // DEC 1049 (most terminals)
  '\x1b[?47h', '\x1b[?47l',      // DEC 47 (older)
  '\x1b[?1047h', '\x1b[?1047l',  // DEC 1047
];

export function createNoAltScreenStdout(real: NodeJS.WriteStream): NodeJS.WriteStream {
  const write = real.write.bind(real);

  // We return a modified copy of the real stream, intercepting write()
  const proxy = Object.create(real) as NodeJS.WriteStream;
  proxy.write = function (data: any, encoding?: any, cb?: any): boolean {
    let str = typeof data === 'string' ? data : Buffer.from(data).toString(encoding ?? 'utf-8');
    for (const seq of ALTS) str = str.replaceAll(seq, '');
    return write(str, cb);
  };

  return proxy;
}
