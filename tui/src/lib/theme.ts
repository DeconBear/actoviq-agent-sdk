// ── Theme types ────────────────────────────────────────────────

export interface ThemeColors {
  primary: string;
  secondary: string;
  accent: string;
  error: string;
  warning: string;
  success: string;
  dim: string;
  border: string;
  background: string;
  text: string;
}

export interface Theme {
  name: string;
  colors: ThemeColors;
}

// ── Built-in themes ─────────────────────────────────────────────

export const themes: Record<string, Theme> = {
  dark: {
    name: 'dark',
    colors: {
      primary: 'cyan',
      secondary: 'magenta',
      accent: 'blue',
      error: 'red',
      warning: 'yellow',
      success: 'green',
      dim: 'gray',
      border: 'gray',
      background: 'black',
      text: 'white',
    },
  },
  light: {
    name: 'light',
    colors: {
      primary: 'blue',
      secondary: 'magenta',
      accent: 'cyan',
      error: 'red',
      warning: 'yellow',
      success: 'green',
      dim: 'gray',
      border: 'gray',
      background: 'white',
      text: 'black',
    },
  },
  nord: {
    name: 'nord',
    colors: {
      primary: '#81a1c1',
      secondary: '#b48ead',
      accent: '#88c0d0',
      error: '#bf616a',
      warning: '#ebcb8b',
      success: '#a3be8c',
      dim: '#4c566a',
      border: '#4c566a',
      background: '#2e3440',
      text: '#d8dee9',
    },
  },
  monokai: {
    name: 'monokai',
    colors: {
      primary: '#a6e22e',
      secondary: '#f92672',
      accent: '#66d9ef',
      error: '#f92672',
      warning: '#e6db74',
      success: '#a6e22e',
      dim: '#75715e',
      border: '#49483e',
      background: '#272822',
      text: '#f8f8f2',
    },
  },
};

export const DEFAULT_THEME = 'dark';

export function getTheme(name?: string): Theme {
  return themes[name ?? DEFAULT_THEME] ?? themes[DEFAULT_THEME]!;
}

export function resolveColor(color: string, theme: Theme): string {
  // Return hex colors as-is; named colors are already compatible with Ink
  return color;
}

// ── Theme context ───────────────────────────────────────────────

import { createContext } from 'react';

export interface ThemeContextValue {
  theme: Theme;
  setTheme: (name: string) => void;
}

export const ThemeContext = createContext<ThemeContextValue>({
  theme: themes[DEFAULT_THEME]!,
  setTheme: () => {},
});
