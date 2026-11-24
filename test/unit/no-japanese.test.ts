// The repository has no Japanese text outside docs/ (which is not committed). Japanese strings
// that tests need are written with Unicode escapes.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Hiragana, Katakana and Han (kanji), plus CJK symbols and punctuation such as the ideographic
 * comma and full stop
 */
const JAPANESE = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}\u3000-\u303f]/u;

/** Files git would commit: tracked files, and untracked files that are not ignored */
function repositoryFiles(): string[] {
  const output = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--deduplicate'],
    { cwd: root, encoding: 'utf8' },
  );
  return output.split('\0').filter((path) => path !== '' && !path.startsWith('docs/'));
}

describe('no Japanese outside docs/', () => {
  it('finds no Hiragana, Katakana or Han characters in text files', () => {
    const files = repositoryFiles();
    expect(files.length).toBeGreaterThan(0);
    const hits: string[] = [];
    for (const path of files) {
      let content: Buffer;
      try {
        content = readFileSync(join(root, path));
      } catch {
        continue; // Deleted from the working tree but still in the index
      }
      if (content.includes(0)) continue; // Binary file (images and so on)
      content
        .toString('utf8')
        .split('\n')
        .forEach((line, index) => {
          if (JAPANESE.test(line)) hits.push(`${path}:${index + 1}`);
        });
    }
    expect(hits).toEqual([]);
  });
});
