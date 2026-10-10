import { describe, it, expect } from 'vitest';
import { openSaves, countSaves } from '../src/reader/save.js';
import { createBudget } from '../src/reader/budget.js';

// countSaves (page.draw's fast q/Q count) must give what openSaves (the full parse) gives, errors included
const run = (f, b) => {
  try {
    return f(b, createBudget());
  } catch (e) {
    return `ERR ${e.code}`;
  }
};
describe('countSaves', () => {
  it('matches openSaves on token soup and on the edge cases', () => {
    const toks = [
      'q',
      'Q',
      'BT',
      'ET',
      '[',
      ']',
      '<<',
      '>>',
      '<',
      '>',
      '(',
      ')',
      '(q)',
      '(\\)q',
      '<71>',
      '/q',
      '1',
      '0',
      'R',
      'true',
      'null',
      'false',
      '%q\n',
      '{',
      '}',
      '\\',
      '\n',
      '\r',
      'BI',
      'ID',
      'EI',
      'qq',
      '+q',
      '/a#71',
      '\0',
      'cm',
    ];
    let seed = 1;
    const rnd = (n) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let t = 0; t < 30000; t++) {
      let s = '';
      for (let k = 1 + rnd(40); k > 0; k--) s += toks[rnd(toks.length)] + (rnd(10) < 6 ? ' ' : '');
      const b = Buffer.from(s, 'latin1');
      expect(run(countSaves, b), s).toBe(run(openSaves, b));
    }
    for (const s of [
      '['.repeat(300) + ' q',
      '[ true '.repeat(300) + ' q',
      'q '.repeat(500),
      '<<'.repeat(255) + 'q',
      '] q q',
      'q BI /W 1 ID xQ EI q',
      '[1 0 R q',
    ])
      expect(run(countSaves, Buffer.from(s)), s).toBe(run(openSaves, Buffer.from(s)));
  });
});
