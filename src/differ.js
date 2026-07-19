/**
 * @typedef {{ type: 'added' | 'removed' | 'changed', path: string, before?: unknown, after?: unknown, note?: string }} ChangeEvent
 */

/**
 * Checks whether a value is a plain object (not array, not null).
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Default ignore matcher:
 * - exact path match: "meta.timestamp"
 * - subtree/prefix match: "meta" ignores "meta.*" and "meta[0].*"
 * - wildcard segment match: "meta.*.timestamp"
 * - ignore by key name anywhere: "**.updated_at" or "**.timestamp"
 *
 * Array indices in paths use "[N]" segments, e.g. "servers[1].port".
 * @param {string[]} patterns
 * @returns {(path: string) => boolean}
 */
function makeIgnoreMatcher(patterns) {
  if (!patterns || patterns.length === 0) return () => false;

  const exact = new Set();
  /** @type {{ parts: string[] }[]} */
  const globs = [];
  /** @type {Set<string>} */
  const keyAnywhere = new Set();

  for (const raw of patterns) {
    const p = String(raw ?? '').trim();
    if (!p) continue;

    if (p.startsWith('**.')) {
      const key = p.slice(3).trim();
      if (key) keyAnywhere.add(key);
      continue;
    }

    if (p.includes('*')) {
      globs.push({ parts: splitPathParts(p) });
      continue;
    }

    exact.add(p);
  }

  return (path) => {
    if (exact.has(path)) return true;

    // Prefix/subtree ignore: "meta" ignores "meta.x" and "meta[0].x"
    for (const p of exact) {
      if (!p) continue;
      if (path.startsWith(p) && (path.length === p.length || path[p.length] === '.' || path[p.length] === '[')) {
        return true;
      }
    }

    if (keyAnywhere.size > 0) {
      const pathParts = splitPathParts(path);
      for (const key of keyAnywhere) {
        if (pathParts.includes(key)) return true;
      }
    }

    if (globs.length > 0) {
      const parts = splitPathParts(path);
      for (const g of globs) {
        if (matchParts(g.parts, parts)) return true;
      }
    }

    return false;
  };
}

/**
 * Split a path into comparable parts. Turns "a.b[1].c" into ["a","b","[1]","c"].
 * @param {string} path
 * @returns {string[]}
 */
function splitPathParts(path) {
  if (!path) return [];
  /** @type {string[]} */
  const parts = [];
  let buf = '';
  for (let i = 0; i < path.length; i++) {
    const ch = path[i];
    if (ch === '.') {
      if (buf) parts.push(buf);
      buf = '';
      continue;
    }
    if (ch === '[') {
      if (buf) parts.push(buf);
      buf = '';
      const end = path.indexOf(']', i);
      if (end === -1) {
        // malformed; treat as literal remainder
        buf = path.slice(i);
        break;
      }
      const bracketToken = path.slice(i, end + 1); // include brackets
      // Allow wildcard index syntax: [*]
      parts.push(bracketToken === '[*]' ? '*' : bracketToken);
      i = end;
      continue;
    }
    buf += ch;
  }
  if (buf) parts.push(buf);
  return parts;
}

/**
 * Match glob parts against actual parts. "*" matches any single part (key or index).
 * @param {string[]} patternParts
 * @param {string[]} pathParts
 * @returns {boolean}
 */
function matchParts(patternParts, pathParts) {
  if (patternParts.length !== pathParts.length) return false;
  for (let i = 0; i < patternParts.length; i++) {
    const p = patternParts[i];
    if (p === '*') continue;
    if (p !== pathParts[i]) return false;
  }
  return true;
}

/**
 * Recursively diff two values at a given key path.
 * @param {unknown} before
 * @param {unknown} after
 * @param {string} path
 * @param {ChangeEvent[]} events  accumulator
 * @param {{ arrayIdKey?: string | null, arrayIgnoreOrder?: boolean }} [options]
 */
function diffValues(before, after, path, events, options = {}) {
  const beforeIsObj = isPlainObject(before);
  const afterIsObj = isPlainObject(after);
  const beforeIsArr = Array.isArray(before);
  const afterIsArr = Array.isArray(after);

  // Both plain objects → recurse into keys
  if (beforeIsObj && afterIsObj) {
    diffObjects(before, after, path, events, options);
    return;
  }

  // Both arrays → diff by index or identity key
  if (beforeIsArr && afterIsArr) {
    diffArrays(before, after, path, events, options);
    return;
  }

  // Both nullish/undefined
  if ((before == null) && (after == null)) {
    return;
  }

  // Structural type change (e.g. object → scalar, array → object)
  if (
    (beforeIsObj || beforeIsArr) !== (afterIsObj || afterIsArr) ||
    (beforeIsObj !== afterIsObj) ||
    (beforeIsArr !== afterIsArr)
  ) {
    const beforeType = beforeIsObj ? 'object' : beforeIsArr ? 'array' : typeof before;
    const afterType = afterIsObj ? 'object' : afterIsArr ? 'array' : typeof after;
    events.push({
      type: 'changed',
      path,
      before,
      after,
      note: `type changed from ${beforeType} to ${afterType}`,
    });
    return;
  }

  // Scalar comparison — note type changes
  if (before !== after) {
    const beforeType = typeof before;
    const afterType = typeof after;
    const event = { type: 'changed', path, before, after };
    if (beforeType !== afterType) {
      event.note = `type changed from ${beforeType} to ${afterType}`;
    }
    events.push(event);
  }
}

/**
 * Diff two plain objects. Key ordering is intentionally ignored.
 * @param {Record<string, unknown>} before
 * @param {Record<string, unknown>} after
 * @param {string} basePath
 * @param {ChangeEvent[]} events
 * @param {{ arrayIdKey?: string | null, arrayIgnoreOrder?: boolean }} [options]
 */
function diffObjects(before, after, basePath, events, options = {}) {
  const beforeKeys = new Set(Object.keys(before));
  const afterKeys = new Set(Object.keys(after));

  // Keys only in "after" → added
  for (const key of afterKeys) {
    if (!beforeKeys.has(key)) {
      const childPath = basePath ? `${basePath}.${key}` : key;
      events.push({ type: 'added', path: childPath, after: after[key] });
    }
  }

  // Keys only in "before" → removed
  for (const key of beforeKeys) {
    if (!afterKeys.has(key)) {
      const childPath = basePath ? `${basePath}.${key}` : key;
      events.push({ type: 'removed', path: childPath, before: before[key] });
    }
  }

  // Keys in both → recurse
  for (const key of beforeKeys) {
    if (afterKeys.has(key)) {
      const childPath = basePath ? `${basePath}.${key}` : key;
      diffValues(before[key], after[key], childPath, events, options);
    }
  }
}

/**
 * @param {unknown} item
 * @param {string} idKey
 * @returns {string | null}
 */
function identityKey(item, idKey) {
  if (!isPlainObject(item)) return null;
  if (!Object.prototype.hasOwnProperty.call(item, idKey)) return null;
  const v = item[idKey];
  if (v == null || typeof v === 'object') return null;
  return String(v);
}

/**
 * Diff arrays by identity key when configured; otherwise by index.
 * @param {unknown[]} before
 * @param {unknown[]} after
 * @param {string} basePath
 * @param {ChangeEvent[]} events
 * @param {{ arrayIdKey?: string | null, arrayIgnoreOrder?: boolean }} [options]
 */
function diffArrays(before, after, basePath, events, options = {}) {
  const idKey = options.arrayIdKey ? String(options.arrayIdKey) : null;

  if (idKey) {
    /** @type {Map<string, { value: unknown, index: number }>} */
    const beforeMap = new Map();
    /** @type {Map<string, { value: unknown, index: number }>} */
    const afterMap = new Map();
    let canUseIdentity = true;

    for (let i = 0; i < before.length; i++) {
      const key = identityKey(before[i], idKey);
      if (key == null || beforeMap.has(key)) {
        canUseIdentity = false;
        break;
      }
      beforeMap.set(key, { value: before[i], index: i });
    }
    if (canUseIdentity) {
      for (let i = 0; i < after.length; i++) {
        const key = identityKey(after[i], idKey);
        if (key == null || afterMap.has(key)) {
          canUseIdentity = false;
          break;
        }
        afterMap.set(key, { value: after[i], index: i });
      }
    }

    if (canUseIdentity) {
      for (const [key, afterItem] of afterMap) {
        const childPath = `${basePath}[${JSON.stringify(key)}]`;
        if (!beforeMap.has(key)) {
          events.push({ type: 'added', path: childPath, after: afterItem.value });
        } else {
          diffValues(beforeMap.get(key).value, afterItem.value, childPath, events, options);
        }
      }
      for (const [key, beforeItem] of beforeMap) {
        if (!afterMap.has(key)) {
          const childPath = `${basePath}[${JSON.stringify(key)}]`;
          events.push({ type: 'removed', path: childPath, before: beforeItem.value });
        }
      }
      return;
    }
  }

  if (options.arrayIgnoreOrder) {
    // Order-insensitive without id key: multiset compare via JSON signatures
    const beforeSigs = before.map((v) => JSON.stringify(v));
    const afterSigs = after.map((v) => JSON.stringify(v));
    /** @type {Map<string, number>} */
    const counts = new Map();
    for (const s of beforeSigs) counts.set(s, (counts.get(s) ?? 0) + 1);
    for (const s of afterSigs) {
      const n = counts.get(s) ?? 0;
      if (n > 0) counts.set(s, n - 1);
      else events.push({ type: 'added', path: `${basePath}[*]`, after: JSON.parse(s) });
    }
    for (const [s, n] of counts) {
      for (let i = 0; i < n; i++) {
        events.push({ type: 'removed', path: `${basePath}[*]`, before: JSON.parse(s) });
      }
    }
    return;
  }

  const maxLen = Math.max(before.length, after.length);
  for (let i = 0; i < maxLen; i++) {
    const childPath = `${basePath}[${i}]`;
    if (i >= before.length) {
      events.push({ type: 'added', path: childPath, after: after[i] });
    } else if (i >= after.length) {
      events.push({ type: 'removed', path: childPath, before: before[i] });
    } else {
      diffValues(before[i], after[i], childPath, events, options);
    }
  }
}

/**
 * Compute the semantic difference between two parsed config trees.
 * Accepts any JSON-like values at the root (object/array/scalar/null).
 * @param {unknown} before
 * @param {unknown} after
 * @param {{ ignorePaths?: string[], arrayIdKey?: string | null, arrayIgnoreOrder?: boolean }} [options]
 * @returns {ChangeEvent[]}
 */
export function diffTrees(before, after, options = {}) {
  /** @type {ChangeEvent[]} */
  const events = [];
  const ignore = makeIgnoreMatcher(options.ignorePaths ?? []);
  const diffOpts = {
    arrayIdKey: options.arrayIdKey ?? null,
    arrayIgnoreOrder: Boolean(options.arrayIgnoreOrder),
  };

  // Root handling: avoid assuming object roots.
  if (isPlainObject(before) && isPlainObject(after)) {
    diffObjects(before, after, '', events, diffOpts);
  } else if (Array.isArray(before) && Array.isArray(after)) {
    diffArrays(before, after, '', events, diffOpts);
  } else {
    // Compare as a single root value. Use "<root>" so we can still ignore it if desired.
    diffValues(before, after, '<root>', events, diffOpts);
  }

  return events.filter(e => !ignore(e.path));
}
