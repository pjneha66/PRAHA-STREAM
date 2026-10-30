import { useCallback, useState } from 'react';

export function usePersistentState<T>(key: string, initialValue: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = window.localStorage.getItem(key);
      return stored ? (JSON.parse(stored) as T) : initialValue;
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
