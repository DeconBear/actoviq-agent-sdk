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

export function useKeyboard(bindings: KeyboardBindings) {
  const {
    onSubmit, onAbort, onClear, onCyclePermissionMode,
    onNavigateUp, onNavigateDown,
    onToggleOverlay, onPermissionYes, onPermissionNo,
    onOverlayUp, onOverlayDown, onOverlayComplete, onOverlayDismiss,
    context = 'default', enabled = true,
  } = bindings;

  useInput((input, key) => {
    if (!enabled) return;

    // Tab → overlay complete or pass through
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

    // Escape → dismiss overlay first, else abort
    if (key.escape) {
      if (context === 'overlay' && onOverlayDismiss) {
        onOverlayDismiss();
      } else {
        onAbort();
      }
      return;
    }

    // Overlay mode: intercept navigation keys, let typing through
    if (context === 'overlay') {
      if (key.upArrow) { onOverlayUp?.(); return; }
      if (key.downArrow) { onOverlayDown?.(); return; }
      // Tab / Enter handled above; Esc handled above; Ctrl+C handled above
      // Regular character input passes through to TextInput for filtering
      if (!key.ctrl && !key.meta && !key.tab && !key.return && !key.escape) {
        return; // don't process, let TextInput handle it
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

    // Streaming mode: only abort works
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
}
