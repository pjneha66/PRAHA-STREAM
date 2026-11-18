import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

/** Guards the four places a PRAHA version is declared. Run with `npm run check:version`. */
const read = (relative: string) => readFileSync(resolve(process.cwd(), relative), 'utf8');

const pkg = JSON.parse(read('package.json')) as { version: string };
const lock = JSON.parse(read('package-lock.json')) as {
  version: string;
  packages?: Record<string, { version?: string }>;
};
const gradle = read('android/app/build.gradle');

describe('version consistency', () => {
  it('package.json, package-lock.json and types.ts agree', () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages?.['']?.version).toBe(pkg.version);
    expect(read('types.ts')).toContain(`export const APP_VERSION = '${pkg.version}'`);
  });

  it('Android versionName matches and versionCode is a positive integer', () => {
    expect(gradle).toContain(`versionName "${pkg.version}"`);
    const code = gradle.match(/versionCode\s+(\d+)/)?.[1];
    expect(code).toBeDefined();
    expect(Number.isInteger(Number(code))).toBe(true);
    expect(Number(code)).toBeGreaterThan(0);
  });
});
