import { useRef, useEffect } from 'react';
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
  onScrollUp?: () => void;
  onScrollDown?: () => void;
  context?: KeyContext;
  enabled?: boolean;
}

export interface KeyboardOutput {
  /** Call this in InputArea onChange to filter out leaked chars from Ctrl combos
   *  and overlay-mode typing. */
  suppressChar: (value: string) => string;
}

export function useKeyboard(bindings: KeyboardBindings): KeyboardOutput {
  const {
    onSubmit, onAbort, onClear, onCyclePermissionMode,
    onNavigateUp, onNavigateDown,
    onToggleOverlay, onPermissionYes, onPermissionNo,
    onOverlayUp, onOverlayDown, onOverlayComplete, onOverlayDismiss,
    onScrollUp, onScrollDown,
    context = 'default', enabled = true,
  } = bindings;

  // Store the last character that should be suppressed from TextInput.
  // Used for Ctrl+P and overlay-mode typing where useInput fires before
  // TextInput's onChange.
  const suppressedCharRef = useRef<string | null>(null);
  const prevContextRef = useRef(context);

  // Clear suppressed char when context changes to avoid deleting unrelated input
  useEffect(() => {
    if (context !== prevContextRef.current) {
      suppressedCharRef.current = null;
      prevContextRef.current = context;
    }
  }, [context]);

  useInput((input, key) => {
    // ── Esc — always first, highest priority ────────────────────
    if (key.escape || input === '\x1b') {
      if (context === 'overlay' && onOverlayDismiss) {
        onOverlayDismiss();
      } else if (context === 'streaming') {
        onAbort();
      } else if (context === 'permission' && onPermissionNo) {
        onPermissionNo();
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

    // Overlay mode: intercept navigation keys, suppress all other typing
    // so characters don't leak into the hidden TextInput behind the overlay.
    if (context === 'overlay') {
      if (key.upArrow) { onOverlayUp?.(); return; }
      if (key.downArrow) { onOverlayDown?.(); return; }
      if (!key.ctrl && !key.meta && !key.tab && !key.return && !key.escape && input) {
        suppressedCharRef.current = input;
        return;
      }
      return;
    }

    // Permission mode: y/n/Enter keys only, block everything else
    if (context === 'permission') {
      if (input === 'y' || input === 'Y') {
        onPermissionYes?.();
        return;
      }
      if (input === 'n' || input === 'N' || key.return) {
        onPermissionNo?.();
        return;
      }
      // Suppress all other characters during permission dialogs
      if (input && !key.ctrl && !key.meta && !key.tab && !key.return && !key.escape) {
        suppressedCharRef.current = input;
      }
      return;
    }

    // Streaming mode: only abort/Esc work (handled above)
    if (context === 'streaming') {
      // Suppress any typing during streaming
      if (input && !key.ctrl && !key.meta && !key.tab && !key.return && !key.escape) {
        suppressedCharRef.current = input;
      }
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

    if (key.pageUp) {
      onScrollUp?.();
      return;
    }
    if (key.pageDown) {
      onScrollDown?.();
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
      if (ch) {
        const idx = value.indexOf(ch);
        if (idx !== -1) {
          suppressedCharRef.current = null;
          return value.slice(0, idx) + value.slice(idx + ch.length);
        }
      }
      suppressedCharRef.current = null;
      return value;
    },
  };
}
