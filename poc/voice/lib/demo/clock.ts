/** Official §4 phase boundaries, scaled only for the explicitly accelerated demo. */
export function vivaPhase(elapsedMs: number, durationMs: number) {
 const seconds = Math.max(0, elapsedMs) / durationMs * 900;
 return seconds < 60 ? 'Warm-up' : seconds < 300 ? 'Fundamentals' : seconds < 600 ? 'Depth' : seconds < 780 ? 'Applied problem' : seconds < 870 ? 'Wrap-up' : seconds < 900 ? 'Scoring' : 'Finished';
}
export type DemoClock = { now: () => number };
