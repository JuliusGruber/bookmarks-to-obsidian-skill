import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const rootPackage = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
);
const skillPackage = JSON.parse(
  await readFile(new URL('../bookmarks-to-obsidian/package.json', import.meta.url), 'utf8'),
);

describe('root test harness dependencies', () => {
  it('does not duplicate skill runtime dependencies', () => {
    const rootDependencies = {
      ...rootPackage.dependencies,
      ...rootPackage.devDependencies,
      ...rootPackage.optionalDependencies,
    };
    const duplicated = Object.keys(skillPackage.dependencies ?? {})
      .filter((name) => name in rootDependencies);

    expect(duplicated).toEqual([]);
  });
});
