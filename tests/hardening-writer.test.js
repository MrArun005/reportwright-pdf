// Writer hardening: options read once (a getter cannot pass the check with one value and be written with another),
// constant tables looked up by own key only, options that widen what is allowed read as own properties only, the
// passive attachment types, the CFF and kerning work bounds, tiling pattern geometry.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { toBytes } from '../src/index.js';
import { HAS, run, save, latin } from './tools.js';
import { EN16931 } from './standards-fixture.js';
import { checkFileName } from '../src/core/filename.js';
import { link } from '../src/nav/links.js';
import { attachFile } from '../src/annotations/attach.js';

const DATE = new Date('2026-01-01');
const ACTIVE = /\/JavaScript|\/JS\b|\/Launch|\/GoToR|\/GoToE|\/SubmitForm|\/ImportData|\/AA\b/;
const FILE = new Uint8Array([1, 2, 3]);

/** the file as qpdf rewrites it (uncompressed, no object streams); qpdf must read it */
function qdf(bytes) {
  const f = save(bytes),
    out = `${f}.qdf.pdf`;
  run('qpdf', ['--qdf', '--object-streams=disable', f, out]);
  return fs.readFileSync(out).toString('latin1');
}
/** every action type the file writes */
const actionTypes = (s) => [...s.matchAll(/\/Type \/Action\s+\/S \/(\w+)/g)].map((m) => m[1]);

/**
 * An object whose `key` returns `good` for its first n reads and `bad` after (a getter, like a hostile Proxy).
 * @param {object} base @param {string} key
 */
function flip(base, key, good, bad, n) {
  let reads = 0;
  return Object.defineProperty(base, key, {
    enumerable: true,
    configurable: true,
    get: () => (reads++ < n ? good : bad),
  });
}

/** for n = 1…6 reads of the good value: build, and the file holds only the good value and only allowed actions */
async function readOnce(build, { good, allowed = [], tagged = false }) {
  for (let n = 1; n <= 6; n++) {
    const out = await toBytes((pdf) => build(pdf, n), {
      compress: false,
      creationDate: DATE,
      ...(tagged ? { tagged: true, title: 't' } : {}),
    });
    const s = HAS.qpdf ? qdf(out) : latin(out);
    expect(s, `n = ${n}`).not.toMatch(ACTIVE);
    expect(s, `n = ${n}`).toContain(good);
    for (const t of actionTypes(s)) expect(allowed, `n = ${n}: action /${t}`).toContain(t);
  }
}

describe('options are read once', () => {
  const EVIL = 'NextPage /S /JavaScript /JS (app.alert(1))';

  it('link: target.named', () =>
    readOnce(
      (pdf, n) => {
        pdf.addPage().link(0, 0, 9, 9, flip({}, 'named', 'NextPage', EVIL, n));
      },
      { good: '/N /NextPage', allowed: ['Named'] },
    ));

  it('link: highlight (and the other link options)', () =>
    readOnce(
      (pdf, n) => {
        pdf
          .addPage()
          .link(0, 0, 9, 9, { url: 'https://example.com/' }, flip({}, 'highlight', 'push', 'constructor', n));
      },
      { good: '/H /P', allowed: ['URI'] },
    ));

  it('form button: action.named', () =>
    readOnce(
      (pdf, n) => {
        const p = pdf.addPage();
        pdf.form.button('b', {
          page: p,
          width: 40,
          height: 20,
          font: pdf.standardFont('Helvetica'),
          label: 'Go',
          action: flip({}, 'named', 'NextPage', EVIL, n),
        });
      },
      { good: '/N /NextPage', allowed: ['Named'] },
    ));

  it('form widget: the page is brand-checked and its object number comes from the registry, never from the handle', async () => {
    await readOnce(
      (pdf, n) => {
        const p = pdf.addPage();
        const forged = Object.create(p, {
          ref: { value: '1 0 R /AA << /O << /S /JavaScript /JS (app.alert(1)) >> >> /X 1' },
        });
        pdf.form.checkbox('c', flip({ width: 12, height: 12 }, 'page', p, forged, n));
      },
      { good: '/FT /Btn' },
    );
    // the page's own ref changed after it was made: the widget's /P and the page object are still the real ones
    const out = await toBytes(
      (pdf) => {
        const p = pdf.addPage();
        pdf.form.checkbox('c', { page: p, width: 12, height: 12 });
        p.ref = '1 0 R /AA << /O << /S /JavaScript /JS (app.alert(1)) >> >> /X 1';
      },
      { compress: false, creationDate: DATE },
    );
    expect(HAS.qpdf ? qdf(out) : latin(out)).not.toMatch(ACTIVE);
  });

  it('pdf.pageLabels: style', () =>
    readOnce(
      (pdf, n) => {
        pdf.addPage();
        pdf.pageLabels([flip({ start: 0 }, 'style', 'r', 'r /JS (app.alert(1))', n)]);
      },
      { good: '/S /r' },
    ));

  it('page.markup: lineEndings entries', () =>
    readOnce(
      (pdf, n) => {
        const ends = flip(
          ['Butt', 'None'],
          '0',
          'Butt',
          'None] /A << /Type /Action /S /JavaScript /JS (app.alert(1)) >> /X [/None',
          n,
        );
        pdf.addPage().markup('Line', { x1: 10, y1: 10, x2: 90, y2: 40 }, { lineEndings: ends });
      },
      { good: '/Butt' },
    ));

  it('page.tag: rowSpan and colSpan', () =>
    readOnce(
      (pdf, n) => {
        const p = pdf.addPage();
        p.tag('Table', () =>
          p.tag('TR', () => p.tag('TD', () => {}, flip({}, 'rowSpan', 2, '2 /JS (app.alert(1))', n))),
        );
      },
      { good: '/RowSpan 2', tagged: true },
    ));

  it('a Proxy and shared parts: each property is read once, cycles and shared objects are kept', async () => {
    const reads = new Map();
    const o = new Proxy(
      { url: 'https://example.com/' },
      {
        get: (t, k, r) => {
          reads.set(k, (reads.get(k) ?? 0) + 1);
          return Reflect.get(t, k, r);
        },
      },
    );
    await toBytes(
      (pdf) => {
        pdf.addPage().link(0, 0, 9, 9, o);
      },
      { creationDate: DATE },
    );
    expect(reads.get('url')).toBe(1);
    const cyclic = { title: 'A', page: 1 };
    cyclic.self = cyclic;
    expect(() =>
      toBytes((pdf) => {
        pdf.addPage();
        pdf.outline(cyclic);
      }),
    ).not.toThrow();
  });
});

describe('constant tables are looked up by own key only', () => {
  for (const k of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf']) {
    it(`pdf.viewer({ ${k}: … }) is refused and the file opens`, async () => {
      let err;
      const out = await toBytes(
        (pdf) => {
          try {
            pdf.viewer(JSON.parse(`{ "${k}": true }`));
          } catch (e) {
            err = e;
          }
          try {
            pdf.viewer(JSON.parse(`{ "${k}": "L2R" }`));
          } catch (e) {
            err ??= e;
          }
          pdf.viewer({ fitWindow: true });
        },
        { compress: false, creationDate: DATE },
      );
      expect(err?.message).toMatch(/unknown option/);
      if (HAS.qpdf) expect(qdf(out)).toContain('/FitWindow true');
      expect(latin(out)).not.toContain('[object');
    });
  }
  it('pdf.standardFont and pdf.facturX refuse inherited names with a clear error', async () => {
    await toBytes((pdf) => {
      for (const n of ['constructor', 'toString', '__proto__'])
        expect(() => pdf.standardFont(n), n).toThrow(/Not a standard font/);
    });
    await toBytes(
      async (pdf) => {
        pdf.addPage();
        for (const n of ['constructor', 'toString'])
          await expect(pdf.facturX(EN16931, { profile: n }), n).rejects.toThrow(/profile is one of/);
      },
      { pdfa: { part: 3, conformance: 'b' }, creationDate: DATE },
    );
  });
});

describe('options that widen what is allowed are own properties only', () => {
  const inherited = (proto, own) => Object.assign(Object.create(proto), own);
  it('allowTypes and allowArchives on the prototype do not allow a type', async () => {
    await toBytes(async (pdf) => {
      const p = pdf.addPage();
      expect(() => p.attachFile(FILE, inherited({ allowTypes: ['exe'] }, { name: 'tool.exe' }))).toThrow(
        /not an allowed type/,
      );
      expect(() => p.attachFile(FILE, inherited({ allowArchives: true }, { name: 'a.zip' }))).toThrow(
        /not an allowed type/,
      );
      await expect(pdf.attach(FILE, inherited({ allowTypes: ['exe'] }, { name: 'tool.exe' }))).rejects.toThrow(
        /not an allowed type/,
      );
      expect(() => p.attachFile(FILE, { name: 'tool.exe', allowTypes: ['exe'] })).not.toThrow(); // own: allowed
    });
  });
  it('also where no snapshot is in front of the check (the modules as other modules call them)', async () => {
    const who = 'test';
    expect(() => checkFileName('tool.exe', inherited({ allowTypes: ['exe'] }, {}), who)).toThrow(/not an allowed type/);
    expect(() => checkFileName('a.zip', inherited({ allowArchives: true }, {}), who)).toThrow(/not an allowed type/);
    expect(checkFileName('tool.exe', { allowTypes: ['exe'] }, who).name).toBe('tool.exe');
    await toBytes((pdf) => {
      const p = pdf.addPage();
      expect(() => link.call(p, 0, 0, 9, 9, { url: 'ftp://x/' }, inherited({ allowSchemes: ['ftp'] }, {}))).toThrow(
        /ftp: URLs are not allowed/,
      );
      expect(() => attachFile.call(p, FILE, inherited({ allowTypes: ['exe'] }, { name: 'tool.exe' }))).toThrow(
        /not an allowed type/,
      );
    });
  });
  it('allowSchemes on the prototype does not allow a scheme', async () => {
    await toBytes((pdf) => {
      const p = pdf.addPage();
      expect(() => p.link(0, 0, 9, 9, { url: 'ftp://x/' }, inherited({ allowSchemes: ['ftp'] }, {}))).toThrow(
        /ftp: URLs are not allowed/,
      );
      expect(() => p.link(0, 0, 9, 9, { url: 'ftp://x/' }, { allowSchemes: ['ftp'] })).not.toThrow();
    });
  });
});

describe('passive attachment types', () => {
  it('rtf, msg and xml need allowTypes; Factur-X still embeds its XML', async () => {
    await toBytes((pdf) => {
      const p = pdf.addPage();
      for (const ext of ['rtf', 'msg', 'xml']) {
        expect(() => p.attachFile(FILE, { name: `a.${ext}` }), ext).toThrow(/not an allowed type/);
        expect(() => p.attachFile(FILE, { name: `b.${ext}`, allowTypes: [ext] }), ext).not.toThrow();
      }
    });
    const out = await toBytes(
      async (pdf) => {
        pdf.addPage();
        await pdf.facturX(EN16931, { profile: 'EN 16931' });
      },
      { pdfa: { part: 3, conformance: 'b' }, compress: false, creationDate: DATE },
    );
    expect(latin(out)).toContain('/Subtype /text#2Fxml');
  });
});

// A CFF font whose every glyph walks close to the per-glyph limit: the repo's CID-keyed fixture with its largest global
// subroutine turned into pushes and rmovetos, and every glyph calling it ~13,500 times (~990,000 bytes walked a glyph).
import { sfntTables, parseFont } from '../src/fonts/truetype.js';
import { buildSfnt } from '../src/fonts/subset.js';
import { parseCff } from '../src/fonts/cff.js';
import { ROOT } from './tools.js';

function slowCff(stepsPerGlyph = 990_000) {
  const SC = fs.readFileSync(`${ROOT}/tests/fixtures/fonts/NotoSansSC-Subset.otf`);
  const t = sfntTables(SC),
    F = parseFont(SC),
    cff = new Uint8Array(t.get('CFF ')),
    c = parseCff(cff, F.numGlyphs);
  let gi = 0,
    L = 0;
  for (let i = 0; i < c.gsubrs.count; i++) {
    const [s, e] = c.gsubrs.at(i);
    if (e - s > L) {
      L = e - s;
      gi = i;
    }
  }
  const [gs] = c.gsubrs.at(gi);
  cff.fill(139, gs, gs + L - 1);
  for (let k = 0; k + 3 <= L - 1; k += 3) cff.set([139, 139, 21], gs + k); // 0 0 rmoveto…
  cff[gs + L - 1] = 11; // return
  const calls = Math.floor(stepsPerGlyph / (L + 2)),
    body = new Uint8Array(calls * 2 + 1);
  for (let k = 0; k < calls; k++) body.set([gi - 107 + 139, 29], k * 2); // callgsubr gi (bias 107)
  body[calls * 2] = 14;
  const n = c.cs.count,
    parts = Array.from({ length: n }, (_, g) => (g ? body : cff.subarray(...c.cs.at(g))));
  const size = parts.reduce((s, x) => s + x.length, 0),
    ix = new Uint8Array(3 + (n + 1) * 4 + size),
    dv = new DataView(ix.buffer);
  dv.setUint16(0, n);
  ix[2] = 4;
  let off = 1,
    at = 3 + (n + 1) * 4;
  parts.forEach((x, g) => {
    dv.setUint32(3 + g * 4, off);
    ix.set(x, at);
    at += x.length;
    off += x.length;
  });
  dv.setUint32(3 + n * 4, off);
  const out = new Uint8Array(cff.length + ix.length);
  out.set(cff);
  out.set(ix, cff.length);
  const odv = new DataView(out.buffer),
    op = out.findIndex((v, i) => v === 29 && odv.getInt32(i + 1) === c.cs.p && out[i + 5] === 17);
  odv.setInt32(op + 1, cff.length); // the Top DICT's CharStrings offset: the new INDEX
  t.set('CFF ', out);
  const chars = [];
  for (let cp = 0x20; cp < 0x30000 && chars.length < 100; cp++)
    if (F.glyphFor(cp)) chars.push(String.fromCodePoint(cp));
  return { bytes: buildSfnt(t, [0x4f, 0x54, 0x54, 0x4f]), chars, steps: calls * (L + 2) };
}

describe('CFF work budget', () => {
  it('one budget for the whole font: a font whose every glyph walks ~1M bytes fails at the text that uses it, quickly, with E_FONT_BUDGET', async () => {
    const { bytes, chars, steps } = slowCff();
    expect(steps).toBeGreaterThan(900_000);
    expect(chars.length * steps).toBeGreaterThan(90_000_000); // ~0.6 s of walking at end() before; now refused at the text
    const t = performance.now();
    let err;
    await toBytes(async (pdf) => {
      const f = await pdf.embedFont(bytes);
      const p = pdf.addPage();
      p.text(chars[0], { x: 10, y: 10, font: f }); // one glyph is fine
      try {
        p.text(chars.join(''), { x: 10, y: 30, font: f });
      } catch (e) {
        err = e;
      }
    });
    expect(err?.code).toBe('E_FONT_BUDGET');
    expect(err).toBeInstanceOf(RangeError);
    expect(performance.now() - t).toBeLessThan(3000);
  });
});

import { INTER } from './tools.js';
/** Inter with a GPOS whose 'kern' lookup lists n pair-adjustment subtables (all one subtable that kerns nothing) */
function manySubtables(n) {
  const g = new Uint8Array(50 + 2 * n),
    dv = new DataView(g.buffer);
  dv.setUint16(0, 1);
  dv.setUint16(4, 10);
  dv.setUint16(6, 12);
  dv.setUint16(8, 26); // version 1.0; ScriptList, FeatureList, LookupList
  // ScriptList at 10: no scripts. FeatureList at 12: one feature 'kern', its table at 20 (8 from the list): lookup 0
  dv.setUint16(12, 1);
  g.set([107, 101, 114, 110], 14);
  dv.setUint16(18, 8);
  dv.setUint16(22, 1);
  dv.setUint16(24, 0);
  // LookupList at 26: one lookup, at 30
  dv.setUint16(26, 1);
  dv.setUint16(28, 4);
  const L = 30;
  dv.setUint16(L, 2);
  dv.setUint16(L + 2, 0);
  dv.setUint16(L + 4, n);
  const sub = 6 + 2 * n; // from the lookup
  for (let k = 0; k < n; k++) dv.setUint16(L + 6 + 2 * k, sub);
  const s = L + sub;
  dv.setUint16(s, 1);
  dv.setUint16(s + 2, 10);
  dv.setUint16(s + 4, 4);
  dv.setUint16(s + 6, 0);
  dv.setUint16(s + 8, 0);
  dv.setUint16(s + 10, 1);
  dv.setUint16(s + 12, 0); // coverage format 1, no glyphs
  const t = sfntTables(INTER);
  t.set('GPOS', g);
  t.delete('kern');
  return buildSfnt(t);
}

describe('kerning work bound', () => {
  // 40,000 characters in pseudo-random order from ~360 Inter has: mostly distinct pairs, so the pair cache misses and
  // every lookup walks every subtable (none kerns, so each is tried)
  const cps = [];
  for (const [a, z] of [
    [0x41, 0x5a],
    [0x61, 0x7a],
    [0xc0, 0x17f],
    [0x391, 0x3a1],
    [0x3a3, 0x3a9],
    [0x3b1, 0x3c9],
    [0x410, 0x44f],
  ])
    for (let c = a; c <= z; c++) cps.push(c);
  let seed = 1;
  const text = Array.from({ length: 40_000 }, () =>
    String.fromCodePoint(cps[(seed = (seed * 1103515245 + 12345) % 2 ** 31) % cps.length]),
  ).join('');
  const timed = async (bytes) => {
    let warnings = [];
    const t = performance.now();
    await toBytes(async (pdf) => {
      const f = await pdf.embedFont(bytes);
      pdf.addPage().text(text, { x: 10, y: 10, font: f, size: 6 });
      const end = pdf.end;
      pdf.end = async () => {
        const r = await end();
        warnings = r.warnings;
        return r;
      };
    });
    return { ms: performance.now() - t, warnings };
  };
  it('a font listing more than 64 kerning subtables has its kerning turned off with a warning; 64 still kern', async () => {
    const many = await timed(manySubtables(4096));
    expect(many.warnings.join('\n')).toMatch(/more than 64 subtables: GPOS kerning is off/);
    const ok = await timed(manySubtables(64));
    expect(ok.warnings.join('\n')).not.toMatch(/kerning is off/);
    console.log(
      `kerning, 40,000 characters: 4,096 subtables ${Math.round(many.ms)} ms, 64 subtables ${Math.round(ok.ms)} ms`,
    );
  });
});

describe('tiling pattern geometry', () => {
  it('a cell with no spacing has a /BBox 0.001 pt larger than /XStep × /YStep (PDFium otherwise tiles it a device pixel apart); with spacing the /BBox is the cell', async () => {
    const out = latin(
      await toBytes(
        (pdf) => {
          const p = pdf.addPage();
          const checks = p.tilingPattern({ width: 20, height: 20 }, (c) =>
            c.fill(c.path().rect(0, 0, 10, 10), { fill: '#1f4e79' }),
          );
          const dots = p.tilingPattern({ width: 10, height: 10, spacing: 4 }, (c) =>
            c.fill(c.path().rect(0, 0, 5, 5), { fill: '#c00000' }),
          );
          p.fill(p.path().rect(0, 0, 200, 200), { fill: checks });
          p.fill(p.path().rect(300, 0, 200, 200), { fill: dots });
        },
        { compress: false, creationDate: DATE },
      ),
    );
    const pats = [...out.matchAll(/\/BBox \[0 0 ([\d.]+) ([\d.]+)\] \/XStep ([\d.]+) \/YStep ([\d.]+)/g)].map((m) =>
      m.slice(1).map(Number),
    );
    expect(pats).toContainEqual([20.001, 20.001, 20, 20]);
    expect(pats).toContainEqual([10, 10, 14, 14]);
  });
  it.skipIf(!HAS.poppler)('poppler still tiles a 20 pt cell every 20 pt', async () => {
    const out = await toBytes(
      (pdf) => {
        const p = pdf.addPage({ width: 200, height: 40 });
        p.fill(p.path().rect(0, 0, 200, 40), {
          fill: p.tilingPattern({ width: 20, height: 20 }, (c) =>
            c.fill(c.path().rect(0, 0, 10, 10), { fill: '#0000ff' }),
          ),
        });
      },
      { creationDate: DATE },
    );
    const f = save(out);
    run('pdftoppm', ['-r', '72', '-singlefile', f, f]);
    const ppm = fs.readFileSync(`${f}.ppm`),
      w = 200,
      at = ppm.length - w * 40 * 3,
      y = 5;
    const blue = (x) => ppm[at + (y * w + x) * 3 + 2] > 200 && ppm[at + (y * w + x) * 3] < 50;
    const starts = Array.from({ length: w }, (_, x) => x).filter((x) => blue(x) && (x === 0 || !blue(x - 1)));
    expect(starts.slice(1).map((x, i) => x - starts[i])).toEqual(Array(starts.length - 1).fill(20));
  });
});
