// Group E forms: every field type read back by pdf-lib's form API (type, full name, value, options, flags), the
// dictionaries (/DA with auto size, /Q, /MaxLen, /MK, /AP states, /Lock, the reset action, the hierarchy, the AcroForm),
// pdftoppm pixels (a filled value, a ticked box, a selected radio, a combo's value, a pressed state's existence), a
// flattened form read by pdftotext with no AcroForm, and veraPDF UA-1 and A-2b on a tagged PDF/A form.
import { describe, it, expect } from 'vitest';
import { PDFName, PDFDict, PDFRawStream, PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFOptionList, PDFButton, PDFSignature, TextAlignment } from 'pdf-lib';
import { toBytes } from '../src/index.js';
import { INTER, HAS, verapdf, pdftotext, gray, latin } from './tools.js';
import { load, annots, get } from './nav-tools.js';
import { png } from './image-fixtures.js';

const DATE = new Date('2026-01-01');
/** a 4 × 4 opaque red PNG */
const ICON = png({ w: 4, h: 4, type: 2, depth: 8, px: () => [220, 30, 30] });

/** one page with every field type; options: pdfa (no action), tagged */
async function every(pdf, { pdfa = false, values = true } = {}) {
  const f = await pdf.embedFont(INTER);
  const p = pdf.addPage({ width: 600, height: 800 });
  const F = pdf.form, v = (x) => (values ? x : undefined);
  F.textField('name', { page: p, x: 40, y: 40, width: 200, height: 22, font: f, size: 12, value: v('Ada Lovelace'), defaultValue: 'Anonymous', tooltip: 'Full name', required: true, doNotSpellCheck: true });
  const addr = F.group('address');
  addr.textField('city', { page: p, x: 40, y: 80, width: 200, height: 22, font: f, value: v('Paris'), tooltip: 'City', align: 'center' });
  addr.group('geo').textField('zip', { page: p, x: 260, y: 80, width: 80, height: 22, font: f, value: v('75001'), tooltip: 'Postcode', align: 'right', readOnly: true, doNotScroll: true });
  F.textField('notes', { page: p, x: 40, y: 120, width: 200, height: 60, font: f, multiline: true, value: v('Line one\nLine two is longer than the field width'), tooltip: 'Notes' });
  F.textField('pin', { page: p, x: 40, y: 200, width: 100, height: 22, font: f, comb: true, maxLen: 4, value: v('1234'), tooltip: 'PIN' });
  F.textField('secret', { page: p, x: 160, y: 200, width: 100, height: 22, font: f, password: true, tooltip: 'Password' });
  F.checkbox('agree', { page: p, x: 40, y: 240, width: 16, height: 16, checked: values, value: 'Agreed', tooltip: 'I agree' });
  F.checkbox('cross', { page: p, x: 70, y: 240, width: 16, height: 16, checked: values, style: 'cross', tooltip: 'Crossed' });
  F.radioGroup('size', { value: v('M'), tooltip: 'Size', buttons: ['S', 'M', 'L'].map((s, i) => ({ page: p, x: 40 + i * 30, y: 270, width: 16, height: 16, value: s })) });
  F.radioGroup('unison', { radiosInUnison: true, noToggleToOff: false, tooltip: 'Unison', style: 'check', buttons: [{ page: p, x: 160, y: 270, width: 16, height: 16, value: 'A' }, { page: p, x: 190, y: 270, width: 16, height: 16, value: 'A' }] });
  F.comboBox('country', { page: p, x: 40, y: 300, width: 150, height: 22, font: f, options: [['FR', 'France'], ['DE', 'Germany']], value: v('DE'), tooltip: 'Country' });
  F.comboBox('city2', { page: p, x: 200, y: 300, width: 150, height: 22, font: f, options: ['Rome'], value: v('Lyon'), editable: true, tooltip: 'Other city' });
  F.listBox('langs', { page: p, x: 40, y: 330, width: 150, height: 60, font: f, options: ['English', 'French', 'German'], value: v(['French', 'German']), multiSelect: true, tooltip: 'Languages' });
  F.button('reset', { page: p, x: 40, y: 400, width: 80, height: 24, font: f, label: 'Reset', tooltip: 'Reset the form', ...(pdfa ? {} : { action: { reset: ['name', 'address.city'] } }) });
  const img = await pdf.embedImage(ICON);
  F.button('logo', { page: p, x: 140, y: 400, width: 40, height: 40, icon: img, tooltip: 'Logo', ...(pdfa ? {} : { action: { named: 'NextPage' } }) });
  F.signature('sig', { page: p, x: 40, y: 450, width: 200, height: 40, tooltip: 'Sign here', lock: { action: 'Include', fields: ['name'] } });
  return p;
}

describe('forms', () => {
  it("pdf-lib's form API reads every field: type, full name, value, options and flags", async () => {
    const doc = await load(await toBytes((pdf) => every(pdf), { creationDate: DATE }));
    const form = doc.getForm();
    const byName = Object.fromEntries(form.getFields().map((x) => [x.getName(), x]));
    expect(Object.keys(byName).sort()).toEqual(['address.city', 'address.geo.zip', 'agree', 'city2', 'country', 'cross', 'langs', 'logo', 'name', 'notes', 'pin', 'reset', 'secret', 'sig', 'size', 'unison'].sort());
    const T = (n) => { expect(byName[n]).toBeInstanceOf(PDFTextField); return byName[n]; };
    expect(T('name').getText()).toBe('Ada Lovelace');
    expect(T('name').isRequired()).toBe(true);
    expect(T('name').isSpellChecked()).toBe(false);
    expect(T('address.city').getText()).toBe('Paris');
    expect(T('address.city').getAlignment()).toBe(TextAlignment.Center);
    expect(T('address.geo.zip').getAlignment()).toBe(TextAlignment.Right);
    expect(T('address.geo.zip').isReadOnly()).toBe(true);
    expect(T('address.geo.zip').isScrollable()).toBe(false);
    expect(T('notes').isMultiline()).toBe(true);
    expect(T('notes').getText()).toBe('Line one\nLine two is longer than the field width');
    expect(T('pin').isCombed()).toBe(true);
    expect(T('pin').getMaxLength()).toBe(4);
    expect(T('secret').isPassword()).toBe(true);
    expect(T('secret').getText()).toBeUndefined();
    expect(byName.agree).toBeInstanceOf(PDFCheckBox);
    expect(byName.agree.isChecked()).toBe(true);
    expect(byName.size).toBeInstanceOf(PDFRadioGroup);
    expect(byName.size.getOptions()).toEqual(['S', 'M', 'L']);
    expect(byName.size.getSelected()).toBe('M');
    expect(byName.size.isOffToggleable()).toBe(false);
    expect(byName.size.isMutuallyExclusive()).toBe(true);
    expect(byName.unison.isOffToggleable()).toBe(true);
    expect(byName.unison.isMutuallyExclusive()).toBe(false);
    expect(byName.country).toBeInstanceOf(PDFDropdown);
    expect(byName.country.getOptions()).toEqual(['France', 'Germany']);
    expect(byName.country.getSelected()).toEqual(['DE']);
    expect(byName.country.isEditable()).toBe(false);
    expect(byName.country.isSorted()).toBe(false);
    expect(byName.city2.isEditable()).toBe(true);
    expect(byName.city2.getSelected()).toEqual(['Lyon']);
    expect(byName.langs).toBeInstanceOf(PDFOptionList);
    expect(byName.langs.isMultiselect()).toBe(true);
    expect(byName.langs.getSelected()).toEqual(['French', 'German']);
    expect(byName.reset).toBeInstanceOf(PDFButton);
    expect(byName.logo).toBeInstanceOf(PDFButton);
    expect(byName.sig).toBeInstanceOf(PDFSignature);
  });

  it('writes the dictionaries: /DA, /TU, /Q, /MK, appearance states, the reset action, the lock and the hierarchy', async () => {
    const doc = await load(await toBytes((pdf) => every(pdf), { creationDate: DATE }));
    const af = doc.catalog.lookup(PDFName.of('AcroForm'), PDFDict);
    expect(get(af, 'NeedAppearances')).toBe(false);
    expect(get(af, 'DR', 0)).toMatch(/ R$/); // the shared Resources, which hold the fonts
    const fields = get(af, 'Fields', 1, doc);
    expect(fields.map((x) => x.T)).toEqual(['name', 'address', 'notes', 'pin', 'secret', 'agree', 'cross', 'size', 'unison', 'country', 'city2', 'langs', 'reset', 'logo', 'sig']);
    const address = fields[1];
    expect(address.Kids).toHaveLength(2);
    const list = annots(doc);
    expect(list.every((a) => get(a, 'Subtype') === '/Widget' && get(a, 'F') === 4)).toBe(true);
    const named = (t) => list.find((a) => get(a, 'T') === t);
    const name = named('name');
    expect(get(name, 'DA')).toMatch(/^\/F\d+ 12 Tf 0 g$/);
    expect(get(name, 'TU')).toBe('Full name');
    expect(get(name, 'DV')).toBe('Anonymous');
    expect(get(name, 'MK')).toEqual({ BC: [0] });
    expect(get(named('city'), 'Parent', 1, doc).T).toBe('address');
    expect(get(named('city'), 'DA')).toMatch(/ 0 Tf 0 g$/); // auto size
    expect(get(named('city'), 'Q')).toBe(1);
    const agree = named('agree');
    expect(Object.keys(get(agree, 'AP', 1, doc).N).sort()).toEqual(['Agreed', 'Off']);
    expect(get(agree, 'V')).toBe('/Agreed');
    expect(get(agree, 'AS')).toBe('/Agreed');
    expect(get(agree, 'MK').CA).toBe('4');
    expect(get(named('cross'), 'MK').CA).toBe('8');
    const kids = list.filter((a) => a.has(PDFName.of('Parent')) && !a.has(PDFName.of('T')));
    const radios = kids.filter((a) => get(a, 'Parent', 1, doc).T === 'size');
    expect(radios.map((a) => get(a, 'AS'))).toEqual(['/Off', '/M', '/Off']);
    expect(radios.map((a) => Object.keys(get(a, 'AP', 1, doc).N).sort())).toEqual([['Off', 'S'], ['M', 'Off'], ['L', 'Off']]);
    const reset = named('reset');
    expect(get(reset, 'A')).toEqual({ Type: '/Action', S: '/ResetForm', Fields: ['name', 'address.city'] });
    const ap = reset.lookup(PDFName.of('AP'), PDFDict);
    expect(ap.lookup(PDFName.of('N'))).toBeInstanceOf(PDFRawStream);
    expect(ap.lookup(PDFName.of('D'))).toBeInstanceOf(PDFRawStream); // pressed
    expect(get(reset, 'MK').CA).toBe('Reset');
    expect(get(named('logo'), 'A')).toEqual({ Type: '/Action', S: '/Named', N: '/NextPage' });
    expect(get(named('logo'), 'MK', 2, doc).TP).toBe(1);
    expect(get(named('sig'), 'Lock', 1, doc)).toEqual({ Type: '/SigFieldLock', Action: '/Include', Fields: ['name'] });
    expect(get(named('sig'), 'FT')).toBe('/Sig');
    expect(get(named('langs'), 'I')).toEqual([1, 2]);
    expect(get(named('country'), 'Opt')).toEqual([['FR', 'France'], ['DE', 'Germany']]);
  });

  it('appearances render: a filled value, a ticked box, a selected radio, a combo value, list rows (pdftoppm)', async () => {
    if (!HAS.poppler) return;
    const filled = gray(await toBytes((pdf) => every(pdf), { creationDate: DATE }));
    const empty = gray(await toBytes((pdf) => every(pdf, { values: false }), { creationDate: DATE }));
    const inside = (g, x, y, w, h) => g.ink(x + 2, y + 2, x + w - 2, y + h - 2); // ink inside a field's border
    expect(inside(filled, 40, 40, 200, 22)).toBeGreaterThan(40); // "Ada Lovelace"
    expect(inside(empty, 40, 40, 200, 22)).toBe(0);
    expect(inside(filled, 40, 240, 16, 16)).toBeGreaterThan(5); // the tick
    expect(inside(empty, 40, 240, 16, 16)).toBe(0);
    expect(inside(filled, 70, 240, 16, 16)).toBeGreaterThan(5); // the cross
    expect(inside(filled, 70, 270, 16, 16)).toBeGreaterThan(inside(filled, 40, 270, 16, 16) + 5); // M's dot, not S's
    expect(inside(filled, 40, 300, 150, 22)).toBeGreaterThan(30); // "Germany"
    expect(inside(empty, 40, 300, 150, 22)).toBe(0);
    expect(inside(filled, 200, 300, 150, 22)).toBeGreaterThan(10); // "Lyon" in the editable combo
    expect(inside(filled, 140, 400, 40, 40)).toBeGreaterThan(400); // the red icon (dark in gray)
    expect(filled.px(80, 412)).toBeLessThan(220); // the button's gray face
  });

  it('a check box draws each style differently', async () => {
    if (!HAS.poppler) return;
    const styles = ['check', 'cross', 'circle', 'square', 'diamond', 'star'];
    const g = gray(await toBytes((pdf) => {
      const p = pdf.addPage({ width: 300, height: 60 });
      styles.forEach((s, i) => pdf.form.checkbox(`c${i}`, { page: p, x: 10 + i * 40, y: 10, width: 30, height: 30, checked: true, style: s, border: false }));
    }, { creationDate: DATE }));
    const ink = styles.map((_, i) => g.ink(10 + i * 40, 10, 40 + i * 40, 40));
    expect(ink.every((n) => n > 20)).toBe(true);
    expect(new Set(ink).size).toBe(styles.length);
  });

  it('auto size (0) fits the value; a value the font cannot draw throws, or uses a fallback font', async () => {
    const out = await toBytes(async (pdf) => {
      const f = await pdf.embedFont(INTER), h = pdf.standardFont('Helvetica'), p = pdf.addPage();
      pdf.form.textField('long', { page: p, x: 10, y: 10, width: 60, height: 20, font: h, value: 'A rather long value that must shrink' });
      expect(() => pdf.form.textField('omega', { page: p, x: 10, y: 40, width: 60, height: 20, font: h, value: 'Ω' })).toThrow(/no glyph for "Ω"/);
      expect(() => pdf.form.comboBox('o2', { page: p, x: 10, y: 40, width: 60, height: 20, font: h, options: ['Ω'], value: 'Ω' })).toThrow(/no glyph/);
      pdf.form.textField('omega', { page: p, x: 10, y: 70, width: 60, height: 20, font: h, fallback: [f], value: 'Ω 1' });
    }, { creationDate: DATE, compress: false });
    const s = latin(out);
    expect(s).toMatch(/\/F\d+ [0-9.]+ Tf/);
    const doc = await load(out);
    expect(doc.getForm().getTextField('omega').getText()).toBe('Ω 1');
    if (HAS.poppler) expect(gray(out).ink(10, 10, 70, 30)).toBeGreaterThan(20);
  });

  it('flatten: true draws the values into the page and writes no AcroForm and no widgets (pdftotext reads them)', async () => {
    const out = await toBytes((pdf) => every(pdf), { creationDate: DATE, form: { flatten: true } });
    const doc = await load(out);
    expect(doc.catalog.has(PDFName.of('AcroForm'))).toBe(false);
    expect(doc.getPage(0).node.has(PDFName.of('Annots'))).toBe(false);
    if (HAS.poppler) {
      const t = pdftotext(out);
      for (const w of ['Ada Lovelace', 'Paris', '75001', 'Line one', 'Germany', 'Lyon', 'French', 'Reset']) expect(t).toContain(w);
    }
  });

  it('field names: full names unique, groups give parents', async () => {
    await toBytes(async (pdf) => {
      const f = pdf.standardFont('Helvetica'), p = pdf.addPage(), F = pdf.form;
      const a = F.group('a');
      a.textField('b', { page: p, width: 9, height: 9, font: f });
      expect(() => a.textField('b', { page: p, width: 9, height: 9, font: f })).toThrow(/"a.b" already exists/);
      expect(() => F.group('a')).toThrow(/already exists/);
      expect(() => F.textField('a.b', { page: p, width: 9, height: 9, font: f })).toThrow(/cannot contain '\.'/);
      F.textField('b', { page: p, width: 9, height: 9, font: f }); // another level: allowed
    });
  });
});

describe.skipIf(!HAS.verapdf)('veraPDF', () => {
  it('a tagged PDF/A form with every field type passes PDF/UA-1 and PDF/A-2b', async () => {
    const out = await toBytes((pdf) => every(pdf, { pdfa: true }), { creationDate: DATE, title: 'Application form', tagged: { lang: 'en' }, pdfa: true });
    const ua = verapdf(out, 'ua1'), a = verapdf(out, '2b');
    expect(ua.failed).toEqual([]);
    expect(a.failed).toEqual([]);
    expect(ua.ok && a.ok).toBe(true);
  }, 60000);

  it('the same form flattened passes both too', async () => {
    const out = await toBytes((pdf) => every(pdf, { pdfa: true }), { creationDate: DATE, title: 'Application form', tagged: { lang: 'en' }, pdfa: true, form: { flatten: true } });
    expect(verapdf(out, 'ua1').failed).toEqual([]);
    expect(verapdf(out, '2b').failed).toEqual([]);
  }, 60000);

  it('tagged PDFs need a tooltip (the accessible name); PDF/A refuses button actions', async () => {
    await toBytes(async (pdf) => {
      const f = await pdf.embedFont(INTER), p = pdf.addPage();
      expect(() => pdf.form.textField('x', { page: p, width: 9, height: 9, font: f })).toThrow(/needs a tooltip/);
      expect(() => pdf.form.button('b', { page: p, width: 9, height: 9, font: f, label: 'R', tooltip: 'R', action: { reset: true } })).toThrow(/PDF\/A-2 allows no action/);
    }, { title: 'T', tagged: true, pdfa: true });
  });
});
