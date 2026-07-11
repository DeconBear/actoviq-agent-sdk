/** Stick-to-bottom scroll helpers (pure logic; DOM wiring is in clientBundle). */

export interface StickToBottomState {
  stick: boolean;
  thresholdPx: number;
}

export function createStickToBottomState(thresholdPx = 80): StickToBottomState {
  return { stick: true, thresholdPx };
}

export function updateStickFromScroll(
  state: StickToBottomState,
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
): boolean {
  const distance = scrollHeight - scrollTop - clientHeight;
  state.stick = distance < state.thresholdPx;
  return state.stick;
}

export function shouldShowJumpButton(
  state: StickToBottomState,
  scrollHeight: number,
  clientHeight: number,
): boolean {
  return !state.stick && scrollHeight > clientHeight + 40;
}
