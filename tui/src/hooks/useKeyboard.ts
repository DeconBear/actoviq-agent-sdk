import { useRef } from 'react';
import { useInput } from 'ink';

export type KeyContext = 'default' | 'streaming' | 'permission' | 'overlay';

export interface KeyboardBindings {
  onSubmit: () => void;
  onAbort: () => void;
  onClear: () => void;
  onCyclePermissionMode: () => void;
  onNavigateUp: () => void;
  onNavigateDown: () => void;
  onToggleOverlay?: () => void;
  onPermissionYes?: () => void;
  onPermissionNo?: () => void;
  onOverlayUp?: () => void;
  onOverlayDown?: () => void;
  onOverlayComplete?: () => void;
  onOverlayDismiss?: () => void;
  context?: KeyContext;
  enabled?: boolean;
}

export interface KeyboardOutput {
  /** Call this in InputArea onChange to filter out leaked chars from Ctrl combos. */
  suppressChar: (value: string) => string;
}

export function useKeyboard(bindings: KeyboardBindings): KeyboardOutput {
  const {
    onSubmit, onAbort, onClear, onCyclePermissionMode,
    onNavigateUp, onNavigateDown,
    onToggleOverlay, onPermissionYes, onPermissionNo,
    onOverlayUp, onOverlayDown, onOverlayComplete, onOverlayDismiss,
    context = 'default', enabled = true,
  } = bindings;

  // useRef so suppressed chars survive React re-renders triggered
  // by Ctrl+P → onCyclePermissionMode before TextInput's onChange fires.
  const suppressedCharRef = useRef<string | null>(null);

  useInput((input, key) => {
    // ── Esc — always first, highest priority ────────────────────
    if (key.escape || input === '\x1b') {
      if (context === 'overlay' && onOverlayDismiss) {
        onOverlayDismiss();
      } else {
        onAbort();
      }
      return;
    }

    if (!enabled) return;

    // Tab → overlay complete
    if (key.tab && context === 'overlay') {
      onOverlayComplete?.();
      return;
    }

    // Enter: in overlay mode, complete the current selection
    if (key.return && context === 'overlay') {
      onOverlayComplete?.();
      return;
    }

    // Ctrl+C → always abort
    if (key.ctrl && input === 'c') {
      onAbort();
      return;
    }

    // Overlay mode: intercept navigation keys, let typing through
    if (context === 'overlay') {
      if (key.upArrow) { onOverlayUp?.(); return; }
      if (key.downArrow) { onOverlayDown?.(); return; }
      if (!key.ctrl && !key.meta && !key.tab && !key.return && !key.escape) {
        return;
      }
      return;
    }

    // Permission mode: y/n keys only, block everything else
    if (context === 'permission') {
      if (input === 'y' || input === 'Y') {
        onPermissionYes?.();
        return;
      }
      if (input === 'n' || input === 'N') {
        onPermissionNo?.();
        return;
      }
      return;
    }

    // Streaming mode: only abort/Esc work (handled above)
    if (context === 'streaming') {
      return;
    }

    // Default mode keys
    if (key.ctrl && key.return) {
      onSubmit();
      return;
    }

    if (key.ctrl && input === 'l') {
      onClear();
      return;
    }

    if (key.ctrl && input === 'p') {
      suppressedCharRef.current = 'p';
      onCyclePermissionMode();
      return;
    }

    if (key.ctrl && input === 'o') {
      onToggleOverlay?.();
      return;
    }

    if (key.upArrow) {
      onNavigateUp();
      return;
    }
    if (key.downArrow) {
      onNavigateDown();
      return;
    }
  });

  return {
    suppressChar: (value: string) => {
      const ch = suppressedCharRef.current;
      if (ch && value.endsWith(ch)) {
        suppressedCharRef.current = null;
        return value.slice(0, -1);
      }
      suppressedCharRef.current = null;
      return value;
    },
  };
}
