export interface DenialTracker {
  consecutiveDenials: number;
  totalDenials: number;
  recordDenial(): void;
  recordAllow(): void;
  isExceeded(limit: number): boolean;
  reset(): void;
}

export function createDenialTracker(): DenialTracker {
  let consecutiveDenials = 0;
  let totalDenials = 0;

  return {
    get consecutiveDenials() {
      return consecutiveDenials;
    },
    get totalDenials() {
      return totalDenials;
    },
    recordDenial() {
      consecutiveDenials += 1;
      totalDenials += 1;
    },
    recordAllow() {
      consecutiveDenials = 0;
    },
    isExceeded(limit: number) {
      return consecutiveDenials >= limit;
    },
    reset() {
      consecutiveDenials = 0;
      totalDenials = 0;
    },
  };
}
