import { useCallback, useState } from 'react';

/**
 * Deep-merges a stored plain object over the defaults so that settings saved by
 * an older version of PRAHA still gain any newly added fields (for example the
 * `player` block). Arrays and primitives are taken from storage as-is.
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

export function usePersistentState<T>(key: string, initialValue: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = window.localStorage.getItem(key);
      return stored ? revive(JSON.parse(stored) as unknown, initialValue) : initialValue;
    } catch {
      return initialValue;
    }
  });

  const setStoredValue = useCallback((next: T | ((current: T) => T)) => {
    setValue((current) => {
      const resolved = next instanceof Function ? next(current) : next;
      try {
        window.localStorage.setItem(key, JSON.stringify(resolved));
      } catch (error) {
        console.error(`Unable to persist ${key}`, error);
      }
      return resolved;
    });
  }, [key]);

  return [value, setStoredValue] as const;
}
