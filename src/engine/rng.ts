/**
 * Seedable pseudo-random number generator (mulberry32).
 *
 * Deterministic and dependency-free: the same seed always produces the same
 * sequence, which is what makes the simulation engine testable (seeded
 * golden-path tests) and reproducible (a reviewer can re-run a scenario and
 * get the same distribution).
 */
export type RNG = () => number;

export function createRng(seed: number): RNG {
  let a = seed >>> 0;
  return function rng(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
