import { useCallback, useRef, useState } from 'react';

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
  const initialRef = useRef(initialValue);
  // Keep the key alongside the value in a single state object. When `key`
  // changes we re-read synchronously during render, so callers never observe
  // the previous key's value for a frame (and cannot persist it to the new key).
  const [state, setState] = useState<{ key: string; value: T }>(() => ({
    key,
    value: readKey(key, initialValue),
  }));

  let value: T;
  if (state.key !== key) {
    value = readKey(key, initialRef.current);
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
