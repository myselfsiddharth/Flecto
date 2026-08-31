/**
 * Seeded pseudo-random generator for the fuzz harness.
 *
 * Deterministic by construction: a case is identified by `(target, seed, index)`
 * and nothing else, so `--case N` regenerates byte-for-byte the input that
 * failed without replaying the N-1 cases before it. That is the whole reason
 * this is hand-written rather than a library — a fuzz finding nobody can
 * reproduce is noise, and reproduction has to be one command.
 *
 * mulberry32 is used because it is eleven lines, has no state beyond a uint32,
 * and is more than uniform enough to shuffle structured generators. This is not
 * a source of randomness for anything but test inputs; do not reach for it
 * anywhere in `src/`.
 */

/**
 * FNV-1a over a string, as a uint32. Used to fold a target id into the seed so
 * two targets never walk the same sequence of inputs.
 * @param {string} text
 * @returns {number}
 */
export function hashString(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * The uint32 seed for one case. Mixing the index in (rather than advancing a
 * shared stream) is what makes a single case independently replayable.
 * @param {number} seed
 * @param {string} target
 * @param {number} index
 * @returns {number}
 */
export function caseSeed(seed, target, index) {
  let mixed = (seed >>> 0) ^ hashString(target);
  mixed = Math.imul(mixed ^ (index >>> 0), 0x9e3779b1);
  mixed ^= mixed >>> 16;
  return mixed >>> 0;
}

/**
 * @typedef {{
 *   next: () => number,
 *   int: (maxExclusive: number) => number,
 *   between: (min: number, maxInclusive: number) => number,
 *   bool: (probability?: number) => boolean,
 *   pick: <T>(items: readonly T[]) => T,
 *   weighted: <T>(entries: ReadonlyArray<readonly [number, T]>) => T,
 *   shuffle: <T>(items: T[]) => T[],
 *   chars: (alphabet: string, length: number) => string
 * }} Rng
 */

/**
 * @param {number} seed
 * @returns {Rng}
 */
export function makeRng(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const int = (maxExclusive) => (maxExclusive <= 0 ? 0 : Math.floor(next() * maxExclusive));

  const rng = {
    next,
    int,
    between: (min, maxInclusive) => min + int(maxInclusive - min + 1),
    bool: (probability = 0.5) => next() < probability,
    pick: (items) => items[int(items.length)],
    /**
     * Pick from `[weight, value]` pairs. Weights let a generator spend most of
     * its cases on the shapes that actually reach the parser and still visit
     * the rare pathological ones.
     */
    weighted: (entries) => {
      const total = entries.reduce((sum, [weight]) => sum + weight, 0);
      let roll = next() * total;
      for (const [weight, value] of entries) {
        roll -= weight;
        if (roll <= 0) return value;
      }
      return entries[entries.length - 1][1];
    },
    shuffle: (items) => {
      for (let i = items.length - 1; i > 0; i -= 1) {
        const j = int(i + 1);
        [items[i], items[j]] = [items[j], items[i]];
      }
      return items;
    },
    chars: (alphabet, length) => {
      let out = '';
      for (let i = 0; i < length; i += 1) out += alphabet[int(alphabet.length)];
      return out;
    },
  };
  return rng;
}
