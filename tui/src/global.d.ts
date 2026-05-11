declare module 'react/compiler-runtime' { export function c(size: number): any[]; }
declare module 'bidi-js' { export function getEmbeddingLevels(text: string, levels: number[]): void; }
declare module 'usehooks-ts' { export function useEventCallback(fn: Function): Function; export function useIsomorphicLayoutEffect(fn: Function, deps?: any[]): void; }
declare module 'supports-hyperlinks' { const v: { stdout: boolean }; export default v; }
declare module 'semver' { export function gte(a: string, b: string): boolean; export function coerce(v: string): any; }
declare module 'diff' {}
declare module 'highlight.js' {}
declare module '@alcalzone/ansi-tokenize' {
  export type AnsiCode = any;
  export function ansiCodesToString(codes: AnsiCode[]): string;
  export function diffAnsiCodes(a: AnsiCode[], b: AnsiCode[]): AnsiCode[];
  export function tokenizeAnsi(text: string): any[];
}

declare namespace JSX {
  interface IntrinsicElements {
    'ink-box': Record<string, unknown> & { children?: any; ref?: any; style?: any; tabIndex?: number; autoFocus?: boolean; onClick?: any; onFocus?: any; onFocusCapture?: any; onBlur?: any; onBlurCapture?: any; onMouseEnter?: any; onMouseLeave?: any; onKeyDown?: any; onKeyDownCapture?: any; stickyScroll?: boolean };
    'ink-text': Record<string, unknown> & { children?: any; ref?: any; style?: any };
    'ink-raw-ansi': Record<string, unknown>;
    'ink-link': Record<string, unknown> & { children?: any };
    'ink-virtual-text': Record<string, unknown>;
  }
}
