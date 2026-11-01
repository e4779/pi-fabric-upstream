export function removeStaleBuilds(root: string): void;
export function swapIntoPlace(root: string, stage: string, options?: { attempts?: number; delayMs?: number; rename?: (from: string, to: string) => void }): void;
export function buildDist(options: {
  root: string;
  steps: (outdir: string) => string[][];
  stage?: string;
}): void;
