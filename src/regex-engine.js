import { RE2JS } from 're2js';

/**
 * Regular-expression compilation, split by who wrote the pattern.
 *
 * Policy packs accept user-supplied regexes (`match.path`, `afterMatches`,
 * `afterAnyMatches`), and on an untrusted pull request the pack file is
 * attacker-controlled: a committed `policies/evil.json` plus a `.flectorc`
 * selecting it is all it takes. JavaScript's own engine backtracks, so
 * `^(a+)+$` against a 45-character string is not slow but effectively
 * non-terminating -- measured here at **97 seconds** where RE2 answers in 3ms.
 * A CI job that never finishes is a denial of service against the merge gate
 * itself, and no timeout inside the process helps, because the backtracking
 * happens inside a single uninterruptible call into the engine.
 *
 * So patterns are compiled by provenance:
 *
 * - **Trusted** -- the packs Flecto ships in `src/packs/`. These are reviewed,
 *   change only in a release, and are not reachable by a pull request. They
 *   keep the native engine, which costs nothing and leaves their existing
 *   syntax (including the negative lookahead in `github-actions.json`) working.
 * - **Untrusted** -- anything loaded from a repository's `policies/` directory
 *   or added by `flecto policies add`. These compile with RE2, whose matching
 *   is linear in the length of the input by construction.
 *
 * The split is provenance, not content: a local pack that *overrides* a
 * built-in id is still local, and still untrusted.
 *
 * RE2 deliberately omits lookaround and backreferences, because neither is a
 * regular operation and both are what make backtracking unbounded. A pack
 * using them now fails to *load*, with a message naming the rule, rather than
 * hanging at match time. That is the breaking part of this change, and it is
 * why it ships in a major version.
 */

/**
 * A compiled pattern, with the only operation the policy engine performs.
 * @typedef {{ test: (value: string) => boolean, source: string, engine: 'native' | 're2' }} CompiledPattern
 */

/**
 * Translate JavaScript regex flags into RE2 flags.
 *
 * `g` and `y` are accepted and dropped: both only mean anything to a stateful
 * `lastIndex`, which `test()`-style matching does not use, and RE2's matcher
 * searches the whole input anyway. `u` and `v` are accepted and dropped
 * because RE2 is Unicode-aware natively. Anything else is refused rather than
 * silently ignored, so a pack asking for behaviour it will not get finds out.
 * @param {string} flags
 * @returns {number}
 */
function re2Flags(flags) {
  let out = 0;
  for (const flag of flags) {
    if (flag === 'i') out |= RE2JS.CASE_INSENSITIVE;
    else if (flag === 'm') out |= RE2JS.MULTILINE;
    else if (flag === 's') out |= RE2JS.DOTALL;
    else if (flag === 'g' || flag === 'y' || flag === 'u' || flag === 'v') continue;
    else throw new Error(`unsupported regular expression flag "${flag}"`);
  }
  return out;
}

/**
 * Compile a pattern written by whoever controls the pack file.
 *
 * @param {string} pattern
 * @param {string} [flags]
 * @param {{ trusted?: boolean }} [options] `trusted` only for packs Flecto ships
 * @returns {CompiledPattern}
 * @throws {Error} when the pattern does not compile on the chosen engine
 */
export function compilePattern(pattern, flags = '', options = {}) {
  if (options.trusted) {
    const re = new RegExp(pattern, flags);
    // A `g`/`y` pattern carries a mutable lastIndex, and .test() advances it,
    // so the same regex reused across values would skip matches. Reset per
    // call rather than per pack: packs are cached and shared between files.
    return {
      source: pattern,
      engine: 'native',
      test: (value) => {
        re.lastIndex = 0;
        return re.test(value);
      },
    };
  }
  const compiled = RE2JS.compile(pattern, re2Flags(flags));
  return {
    source: pattern,
    engine: 're2',
    test: (value) => compiled.matcher(value).find(),
  };
}

/**
 * Whether a pattern compiles, without throwing.
 *
 * Used by pack validation so a bad pattern is reported with its rule location
 * rather than as a bare engine error.
 * @param {string} pattern
 * @param {string} [flags]
 * @param {{ trusted?: boolean }} [options]
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function checkPattern(pattern, flags = '', options = {}) {
  try {
    compilePattern(pattern, flags, options);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error?.message ?? String(error) };
  }
}

/**
 * The advice appended when an untrusted pack uses syntax RE2 does not support.
 *
 * Worth being specific: "invalid regular expression" sends someone hunting for
 * a typo in a pattern that is perfectly valid JavaScript.
 * @param {string} reason
 * @returns {string}
 */
export function explainPatternFailure(reason) {
  // Order matters: an escape failure also contains "invalid escape sequence",
  // and telling someone to remove lookahead from a pattern that has none is
  // worse than saying nothing.
  if (/invalid escape sequence: `\\[ucC]/.test(reason)) {
    return `${reason}. RE2 spells a unicode escape \`\\x{41}\`, not \`\\u0041\`, and has no`
      + ' control-character escape. Policy packs outside src/packs/ are matched with RE2.';
  }
  if (/Perl syntax|invalid escape sequence|lookbehind|invalid named capture/i.test(reason)) {
    return `${reason}. Policy packs outside src/packs/ are matched with RE2, which does not`
      + ' support lookahead, lookbehind, or backreferences -- they are what make backtracking'
      + ' unbounded, and a pack is attacker-controlled on an untrusted pull request. Rewrite the'
      + ' pattern without them.';
  }
  return reason;
}
