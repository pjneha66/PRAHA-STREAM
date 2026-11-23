import { useCallback, useRef, useState } from 'react';

/**
 * Keys that can rewrite an object's prototype instead of adding a property.
 *
 * `merged[key] = value` on a `__proto__` key sets the prototype rather than
 * storing a field, so a stored payload containing one could change how every
 * later lookup on that object resolves — including lookups the app relies on
 * for its own settings. The value comes from localStorage, which anything
 * running in the page (or a hand-edited backup) can write, so it is untrusted
 * input. These keys carry no legitimate setting, so they are dropped.
 */
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Deep-merges a stored plain object over the defaults so that settings saved by
 * an older version of PRAHA still gain any newly added fields (for example the
 * `player`, `debrid`, and `sync` blocks). Arrays and primitives are taken as-is.
 */
function revive<T>(stored: unknown, fallback: T): T {
  if (stored === undefined || stored === null) return fallback;
  const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  if (!isPlainObject(stored) || !isPlainObject(fallback)) return stored as T;

  const merged: Record<string, unknown> = { ...fallback };
  for (const [key, value] of Object.entries(stored)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    merged[key] = value === undefined ? fallback[key] : revive(value, fallback[key]);
  }
  return merged as T;
}

function readKey<T>(key: string, fallback: T): T {
  try {
    const stored = window.localStorage.getItem(key);
    return stored ? revive(JSON.parse(stored) as unknown, fallback) : fallback;
  } catch {
    return fallback;
  }
}

export function usePersistentState<T>(key: string, initialValue: T) {
  // Keep the key alongside the value in a single state object. When `key`
  // changes we re-read synchronously during render, so callers never observe
  // the previous key's value for a frame (and cannot persist it to the new key).
  const [state, setState] = useState<{ key: string; value: T }>(() => ({
    key,
    value: readKey(key, initialValue),
  }));

  let value: T;
  if (state.key !== key) {
    // The current `initialValue`, not a ref captured at the first render: after
    // a key change the caller's fallback is the right one, and a first-render
    // ref would still hold the old key's default (which is how a profile switch
    // could resurrect another profile's settings).
    value = readKey(key, initialValue);
    setState({ key, value });
  } else {
    value = state.value;
  }

  const valueRef = useRef(value);
  valueRef.current = value;

  const setStoredValue = useCallback((next: T | ((current: T) => T)) => {
    const resolved = next instanceof Function ? next(valueRef.current) : next;
    valueRef.current = resolved;
    try {
      window.localStorage.setItem(key, JSON.stringify(resolved));
    } catch (error) {
      console.error(`Unable to persist ${key}`, error);
    }
    setState({ key, value: resolved });
  }, [key]);

  return [value, setStoredValue] as const;
}
