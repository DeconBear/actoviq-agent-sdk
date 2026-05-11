/**
 * Actoviq Terminal Renderer — Claude Code-aligned.
 *
 * Renders React element trees to stdout as ANSI escape sequences.
 * Works in the main terminal buffer for native scrollback.
 * No external dependencies beyond React.
 *
 * Architecture:
 *   React reconciler → layout tree → ANSI string → stdout
 *   Re-renders use cursor positioning to overwrite in-place.
 */
import React from 'react';
import type { ReactElement } from 'react';

// ── ANSI primitives ────────────────────────────────────────────────

export const CSI = '\x1b[';
export const SAVE = '\x1b[s';
export const RESTORE = '\x1b[u';
export const CLEAR_LINE = '\x1b[2K';
export const CLEAR_SCREEN = '\x1b[2J\x1b[H';
export const HIDE_CURSOR = '\x1b[?25l';
export const SHOW_CURSOR = '\x1b[?25h';
export const ALT_ENTER = '\x1b[?1049h';
export const ALT_EXIT = '\x1b[?1049l';

export function cursorTo(x: number, y: number) { return `${CSI}${y + 1};${x + 1}H`; }

export const COLORS: Record<string, string> = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  cyan: '\x1b[36m', yellow: '\x1b[33m', green: '\x1b[32m',
  red: '\x1b[31m', magenta: '\x1b[35m', blue: '\x1b[34m',
  white: '\x1b[37m', gray: '\x1b[90m',
};

// ── Box layout node ────────────────────────────────────────────────

export interface BoxNode {
  type: 'box' | 'text' | 'input';
  x: number; y: number; w: number; h: number;
  props: Record<string, any>;
  children: BoxNode[];
}

// ── Layout engine (simple flexbox subset) ──────────────────────────

export function computeLayout(
  element: ReactElement | string | number | boolean | null | undefined,
  maxW: number, maxH: number, parentX = 0, parentY = 0,
): BoxNode[] {
  if (element == null || typeof element === 'boolean') return [];
  if (typeof element === 'string' || typeof element === 'number') {
    return [{ type: 'text', x: parentX, y: parentY, w: String(element).length, h: 1, props: { children: String(element) }, children: [] }];
  }
  if (!React.isValidElement(element)) return [];

  const props = (element.props || {}) as Record<string, any>;
  const tag = typeof element.type === 'string' ? element.type : (element.type as any)?.displayName || 'unknown';

  if (tag === 'text') {
    const text = String(props.children ?? '');
    const lines = wrapText(text, props.wrap ? maxW : text.length);
    const w = Math.min(Math.max(...lines.map(l => l.length), 0), maxW);
    return [{ type: 'text', x: parentX, y: parentY, w, h: lines.length, props: { ...props, _lines: lines }, children: [] }];
  }

  if (tag === 'box') {
    const style = props;
    const dir = style.flexDirection || 'column';
    const gap = style.gap || 0;
    const padX = style.paddingX || 0;
    const padY = style.paddingY || 0;
    const borderW = style.borderStyle ? 1 : 0;
    const availW = maxW - padX * 2 - borderW * 2;
    const availH = maxH - padY * 2 - borderW * 2;

    let children = React.Children.toArray(props.children).filter(Boolean) as ReactElement[];
    const flexGrow = children.filter(c => React.isValidElement(c) && (c.props as any)?.flexGrow);

    const nodes: BoxNode[] = [];
    let cx = parentX + padX + borderW;
    let cy = parentY + padY + borderW;

    // Distribute flexGrow space
    let remainingW = availW;
    let remainingH = availH;
    const fixedChildren = children.filter(c => !React.isValidElement(c) || !(c.props as any)?.flexGrow);

    // Layout fixed-size children first
    for (const child of fixedChildren) {
      const childW = dir === 'row' ? Math.min((child.props as any)?.width || availW, remainingW) : availW;
      const childH = dir === 'column' ? 1 : availH;
      const childNodes = computeLayout(child, childW, childH, cx, cy);
      nodes.push(...childNodes);
      if (childNodes.length > 0) {
        const last = childNodes[childNodes.length - 1]!;
        if (dir === 'row') { cx = last.x + last.w + gap; remainingW -= last.w + gap; }
        else { cy = last.y + last.h + gap; remainingH -= last.h + gap; }
      }
    }

    // Layout flexGrow children with remaining space
    if (flexGrow.length > 0 && remainingW > 0) {
      const share = Math.max(1, Math.floor(remainingW / flexGrow.length));
      for (const child of flexGrow) {
        const childNodes = computeLayout(child, share, availH, cx, cy);
        nodes.push(...childNodes);
        if (childNodes.length > 0) {
          const last = childNodes[childNodes.length - 1]!;
          if (dir === 'row') { cx = last.x + last.w + gap; }
          else { cy = last.y + last.h + gap; }
        }
      }
    }

    // Compute bounding box
    if (nodes.length > 0) {
      const x1 = Math.min(...nodes.map(n => n.x));
      const y1 = Math.min(...nodes.map(n => n.y));
      const x2 = Math.max(...nodes.map(n => n.x + n.w));
      const y2 = Math.max(...nodes.map(n => n.y + n.h));
      return [{
        type: 'box', x: x1, y: y1, w: Math.min(x2 - x1 + padX * 2 + borderW * 2, maxW),
        h: Math.min(y2 - y1 + padY * 2 + borderW * 2, maxH), props, children: nodes,
      }];
    }
    return [{ type: 'box', x: parentX, y: parentY, w: padX * 2 + borderW * 2, h: padY * 2 + borderW * 2, props, children: [] }];
  }

  return [];
}

function wrapText(text: string, maxW: number): string[] {
  if (maxW <= 0) return [text];
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (paragraph.length <= maxW) { lines.push(paragraph); continue; }
    let remaining = paragraph;
    while (remaining.length > maxW) {
      lines.push(remaining.slice(0, maxW));
      remaining = remaining.slice(maxW);
    }
    if (remaining) lines.push(remaining);
  }
  return lines.length > 0 ? lines : [''];
}

// ── ANSI string generation ────────────────────────────────────────

export function emitAnsi(nodes: BoxNode[]): string {
  const parts: string[] = [];
  for (const node of nodes) emitNode(node, parts);
  return parts.join('');
}

function emitNode(node: BoxNode, out: string[]): void {
  const { x, y, w, h } = node;

  if (node.type === 'box' && node.props.borderStyle) {
    const bc = COLORS[node.props.borderColor || 'dim'] || COLORS.dim;
    const r = COLORS.reset;
    const innerW = Math.max(w - 2, 0);
    const innerH = Math.max(h - 2, 0);
    // Top border
    out.push(`${cursorTo(x, y)}${bc}┌${'─'.repeat(innerW)}┐${r}`);
    // Content rows
    for (let i = 0; i < innerH; i++) {
      out.push(`${cursorTo(x, y + 1 + i)}${bc}│${r}`);
      for (const child of node.children) {
        if (child.y === y + 1 + i) emitNode(child, out);
      }
      out.push(`${cursorTo(x + w - 1, y + 1 + i)}${bc}│${r}`);
    }
    // Bottom border
    out.push(`${cursorTo(x, y + h - 1)}${bc}└${'─'.repeat(innerW)}┘${r}`);
  } else if (node.type === 'box') {
    for (const child of node.children) emitNode(child, out);
  } else if (node.type === 'text') {
    const lines = node.props._lines || [String(node.props.children ?? '')];
    let color = '';
    if (node.props.color) color += COLORS[node.props.color] || '';
    if (node.props.bold) color += COLORS.bold;
    if (node.props.dimColor) color += COLORS.dim;
    for (let i = 0; i < lines.length; i++) {
      out.push(`${cursorTo(x, y + i)}${color}${lines[i]}${COLORS.reset}`);
    }
  }
}

// ── Component primitives ───────────────────────────────────────────

export function Box(props: Record<string, any> & { children?: any }) {
  return React.createElement('box', props, props.children);
}
export function Text(props: { children?: string; color?: string; bold?: boolean; dimColor?: boolean; wrap?: boolean }) {
  return React.createElement('text', props, props.children);
}

// ── Root render ────────────────────────────────────────────────────

export interface Root {
  render(element: ReactElement): void;
  unmount(): void;
}

export function createRoot(): Root {
  let mounted = false;
  let lastHeight = 0;

  return {
    render(element: ReactElement) {
      const W = process.stdout.columns || 80;
      const H = process.stdout.rows || 24;

      if (!mounted) {
        // First render: write the full tree
        process.stdout.write(HIDE_CURSOR);
        const nodes = computeLayout(element, W, H, 0, 0);
        const ansi = emitAnsi(nodes);
        process.stdout.write(ansi);
        // Save total rendered height for subsequent re-renders
        if (nodes.length > 0) {
          const maxY = Math.max(...nodes.map(n => n.y + n.h));
          lastHeight = maxY;
        }
        mounted = true;
      } else {
        // Re-render: only overwrite the bottom area
        const nodes = computeLayout(element, W, H, 0, 0);
        // Clear from last known position and redraw
        const ansi = emitAnsi(nodes);
        process.stdout.write(CLEAR_SCREEN + HIDE_CURSOR + ansi);
      }
    },
    unmount() {
      process.stdout.write(SHOW_CURSOR + '\n');
      mounted = false;
    },
  };
}
