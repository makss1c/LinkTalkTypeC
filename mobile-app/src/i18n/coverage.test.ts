import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { RU } from './ru';

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      walk(path, out);
    } else if (/\.tsx?$/.test(name) && !name.endsWith('.test.ts')) {
      out.push(path);
    }
  }
  return out;
}

describe('i18n coverage', () => {
  it('every tr() phrase in the source has a Russian translation', () => {
    const root = join(__dirname, '..');
    const missing = new Set<string>();
    for (const file of walk(root)) {
      if (file.includes(`${join('src', 'i18n')}`) && !file.endsWith('index.ts')) {
        continue;
      }
      const source = readFileSync(file, 'utf8');
      const pattern = /\btr\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(source))) {
        const key = (match[1] ?? match[2]).replace(/\\'/g, "'");
        if (!(key in RU)) {
          missing.add(key);
        }
      }
    }
    expect([...missing]).toEqual([]);
  });

  it('keeps placeholders in translations', () => {
    for (const [key, value] of Object.entries(RU)) {
      const wanted = (key.match(/\{\w+\}/g) ?? []).sort();
      const got = (value.match(/\{\w+\}/g) ?? []).sort();
      expect({ key, got }).toEqual({ key, got: wanted });
    }
  });
});
