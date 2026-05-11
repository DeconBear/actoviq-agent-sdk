// Color mapping: npm ink theme names → custom Ink raw ANSI colors
const MAP: Record<string, string> = {
  cyan: 'ansi:cyan',
  yellow: 'ansi:yellow',
  green: 'ansi:green',
  red: 'ansi:red',
  blue: 'ansi:blue',
  magenta: 'ansi:magenta',
  white: 'ansi:white',
  gray: 'ansi:blackBright',
  yellowBright: 'ansi:yellowBright',
  greenBright: 'ansi:greenBright',
  redBright: 'ansi:redBright',
  blueBright: 'ansi:blueBright',
  magentaBright: 'ansi:magentaBright',
  cyanBright: 'ansi:cyanBright',
  whiteBright: 'ansi:whiteBright',
  black: 'ansi:black',
  blackBright: 'ansi:blackBright',
};

export function themeColor(name?: string): string | undefined {
  if (!name) return undefined;
  return MAP[name] ?? name;
}
