// Hostile form input: field names with '.', bidi, control and delimiter characters; 100,000 fields; 1,000,000 options;
// a 10 MB value; option, export and tooltip text that injects delimiters; a value not among a choice field's options;
// script and submit options in every spelling; forged handles; deep groups. Each is refused clearly or escaped, no
// /JavaScript, /JS, /AA or /SubmitForm appears in the (uncompressed) output, and each runs in under 1 s.
import { describe, it, expect } from 'vitest';
import { createPdf, toBytes } from '../src/index.js';
import { latin, INTER } from './tools.js';
import { load } from './nav-tools.js';

const fast = async (fn) => { const t = performance.now(); const r = await fn(); expect(performance.now() - t).toBeLessThan(1000); return r; };
const ACTIVE = /\/JavaScript|\/JS\b|\/AA[\s<]|\/SubmitForm|\/ImportData|\/Launch|\/URI/;
const fresh = () => { const pdf = createPdf({ write() {} }); return { pdf, p: pdf.addPage(), f: pdf.standardFont('Helvetica') }; };
const box = (p, f, i = 0) => ({ page: p, x: 10, y: 10 + (i % 50) * 10, width: 50, height: 9, ...(f ? { font: f } : {}) });
const INJECT = [') >> /JS (app.alert(1)) /AA << /O << /S /JavaScript >> >> (', '<</S/SubmitForm/F(http://evil)>>', '\\) /AA', '% comment\n/AA', '#2F#4A#53'];

describe('hostile field names', () => {
  it("'.', control, format, bidi and separator characters are refused; so are empty and over-long names", () => fast(() => {
    const { pdf, p, f } = fresh();
    for (const n of ['a.b', '.', 'a.', 'x‮exe.pdf', 'a⁦b', 'a​b', 'a‎b', 'a؜b', 'a\0b', 'a\nb', 'a\x7fb', 'a﻿b', 'a b', 'a\uD800b']) {
      expect(() => pdf.form.textField(n, box(p, f)), JSON.stringify(n)).toThrow(/cannot contain/);
      expect(() => pdf.form.group(n), JSON.stringify(n)).toThrow(/cannot contain/);
    }
    for (const n of ['', null, 7, {}]) expect(() => pdf.form.textField(n, box(p, f))).toThrow(/non-empty string/);
    expect(() => pdf.form.textField('x'.repeat(257), box(p, f))).toThrow(/at most 256 characters/);
  }));

  it('delimiters in names, tooltips, values and options are escaped as hex text strings and read back exactly', async () => {
    const out = await fast(() => toBytes(async (pdf) => {
      const f = await pdf.embedFont(INTER), p = pdf.addPage(); // an embedded font: drawn text is glyph IDs, not ASCII
      INJECT.forEach((s, i) => {
        const g = pdf.form.group(`g${i}`);
        g.textField(s.replace(/[.\n]/g, '_'), { ...box(p, f, i * 3), value: s.replace(/\n/g, ' '), tooltip: s, defaultValue: s.replace(/\n/g, ' ') });
        g.comboBox('c', { ...box(p, f, i * 3 + 1), options: [[s, s.replace(/\n/g, ' ')], 'x'], value: s, tooltip: s });
        g.checkbox('k', { ...box(p, undefined, i * 3 + 2), value: s.replace(/\n/g, ' '), checked: true, tooltip: s });
      });
      pdf.form.radioGroup('r', { value: INJECT[0], buttons: INJECT.map((s, i) => ({ page: p, x: 300, y: 10 + i * 20, width: 10, height: 10, value: s.replace(/\n/g, ' ') })) });
      pdf.form.button('b', { ...box(p, f, 40), label: INJECT[0], action: { reset: [INJECT[2].replace(/\./g, '_')].map((n) => `g2.${n}`) } });
    }, { compress: false, creationDate: new Date(0) }));
    expect(latin(out)).not.toMatch(ACTIVE);
    const form = (await load(out)).getForm();
    const t = form.getTextField(`g0.${INJECT[0].replace(/[.\n]/g, '_')}`);
    expect(t.getText()).toBe(INJECT[0]);
    expect(form.getDropdown('g0.c').getSelected()).toEqual([INJECT[0]]);
    expect(form.getCheckBox('g1.k').isChecked()).toBe(true);
    expect(form.getRadioGroup('r').getSelected()).toBe(INJECT[0]);
  });
});

describe('hostile sizes', () => {
  it('100,000 fields: refused at the 10,001st, in under 1 s', () => fast(() => {
    const { pdf, p } = fresh();
    let n = 0;
    expect(() => { for (; n < 100_000; n++) pdf.form.checkbox(`c${n}`, { page: p, x: 0, y: 0, width: 5, height: 5 }); }).toThrow(/at most 10000 fields/);
    expect(n).toBe(10_000);
  }));

  it('radio buttons: at most 1,000 a group and 50,000 a document', () => fast(() => {
    const { pdf, p } = fresh();
    const buttons = Array.from({ length: 1000 }, (_, i) => ({ page: p, width: 1, height: 1, value: `v${i}` }));
    let n = 0;
    expect(() => { for (; n < 100; n++) pdf.form.radioGroup(`r${n}`, { buttons }); }).toThrow(/at most 50000 radio buttons/);
    expect(n).toBe(50);
  }), 20000);

  it('1,000,000 options, 1,000,000 characters of options, 10,000 values: refused before any work', () => fast(() => {
    const { pdf, p, f } = fresh();
    const million = new Array(1_000_000).fill('x');
    expect(() => pdf.form.comboBox('c', { ...box(p, f), options: million })).toThrow(/at most 10000 options/);
    expect(() => pdf.form.listBox('l', { ...box(p, f), options: million, multiSelect: true })).toThrow(/at most 10000 options/);
    expect(() => pdf.form.comboBox('c', { ...box(p, f), options: Array.from({ length: 300 }, (_, i) => `${i}`.padEnd(4000, 'y')) })).toThrow(/1000000 characters/);
    expect(() => pdf.form.listBox('l', { ...box(p, f), options: ['a'], multiSelect: true, value: million })).toThrow(/at most 10000 values/);
    expect(() => pdf.form.radioGroup('r', { buttons: new Array(1_000_000).fill({ page: p, width: 1, height: 1, value: 'a' }) })).toThrow(/1–1000/);
  }));

  it('a 10 MB value, tooltip, option or label is refused', () => fast(() => {
    const { pdf, p, f } = fresh();
    const big = 'x'.repeat(10 << 20);
    expect(() => pdf.form.textField('t', { ...box(p, f), value: big })).toThrow(/value is at most 100000 characters/);
    expect(() => pdf.form.textField('t', { ...box(p, f), multiline: true, defaultValue: big })).toThrow(/at most 100000/);
    expect(() => pdf.form.textField('t', { ...box(p, f), tooltip: big })).toThrow(/tooltip is at most 4096/);
    expect(() => pdf.form.comboBox('c', { ...box(p, f), options: [big] })).toThrow(/at most 4096/);
    expect(() => pdf.form.comboBox('c', { ...box(p, f), options: ['a'], editable: true, value: big })).toThrow(/at most 100000/);
    expect(() => pdf.form.button('b', { ...box(p, f), label: big })).toThrow(/at most 4096/);
    expect(() => pdf.form.textField('t', { ...box(p, f), maxLen: 3, value: 'abcd' })).toThrow(/longer than maxLen/);
    expect(() => pdf.form.textField('t', { ...box(p, f), comb: true, maxLen: 5000 })).toThrow(/comb needs maxLen/);
    // the largest value allowed (100,000 characters, multiline, auto size) still draws fast
    pdf.form.textField('ok', { ...box(p, f), multiline: true, height: 200, value: 'word '.repeat(20_000) });
  }));

  it('groups nest at most 32 deep', () => fast(() => {
    const { pdf } = fresh();
    let g = pdf.form;
    for (let i = 0; i < 32; i++) g = g.group(`g${i}`);
    expect(() => g.group('deeper')).toThrow(/at most 32 levels/);
  }));
});

describe('hostile values and options', () => {
  it("a value not among a choice field's or a radio group's options is refused (an editable combo box takes any)", () => fast(() => {
    const { pdf, p, f } = fresh();
    const options = [['FR', 'France'], ['DE', 'Germany']];
    expect(() => pdf.form.comboBox('c', { ...box(p, f), options, value: 'France' })).toThrow(/not one of the options' export values/);
    expect(() => pdf.form.listBox('l', { ...box(p, f), options, value: ['FR', 'XX'], multiSelect: true })).toThrow(/"XX" is not one of/);
    expect(() => pdf.form.listBox('l', { ...box(p, f), options, value: ['FR', 'DE'] })).toThrow(/several only with multiSelect/);
    expect(() => pdf.form.listBox('l', { ...box(p, f), options, value: ['FR', 'FR'], multiSelect: true })).toThrow(/selected twice/);
    expect(() => pdf.form.comboBox('c', { ...box(p, f), options: ['a', ['a', 'b']] })).toThrow(/two options have the export value "a"/);
    expect(() => pdf.form.comboBox('c', { ...box(p, f), options: [['a', 'b', 'c']] })).toThrow(/string or \[export, display\]/);
    expect(() => pdf.form.comboBox('c', { ...box(p, f), options: [{ toString: () => 'x' }] })).toThrow(/is a string/);
    const r = (value, vals) => pdf.form.radioGroup('r', { value, buttons: vals.map((v) => ({ page: p, width: 5, height: 5, value: v })) });
    expect(() => r('Z', ['A', 'B'])).toThrow(/not one of the buttons' values/);
    expect(() => r(null, ['A', 'A'])).toThrow(/two buttons have the export value/);
    expect(() => r(null, ['Off'])).toThrow(/"Off" is the off state/);
    expect(() => pdf.form.checkbox('k', { page: p, width: 5, height: 5, value: 'Off' })).toThrow(/off state/);
    expect(() => pdf.form.checkbox('k', { page: p, width: 5, height: 5, value: 'a‮b' })).toThrow(/cannot contain/);
    pdf.form.comboBox('ok', { ...box(p, f), options, value: 'anything', editable: true });
  }));

  it('script, additional-action and submit options are refused in any spelling; only ResetForm and named page actions', () => fast(() => {
    const { pdf, p, f } = fresh();
    for (const k of ['format', 'keystroke', 'validate', 'calculate', 'javascript', 'JS', 'AA', 'additionalActions', 'actions', 'onClick', 'submit', 'SubmitForm', 'importData', 'url', 'launch']) {
      expect(() => pdf.form.textField('t', { ...box(p, f), [k]: 'app.alert(1)' }), k).toThrow(/never carry JavaScript/);
      expect(() => pdf.form.checkbox('k', { page: p, width: 5, height: 5, [k]: 'x' }), k).toThrow(/never carry JavaScript/);
      expect(() => pdf.form.button('b', { ...box(p, f), label: 'B', action: { [k]: 'x' } }), k).toThrow(/never carry JavaScript/);
    }
    expect(() => pdf.form.textField('t', { ...box(p, f), action: { reset: true } })).toThrow(/never carry JavaScript/); // only buttons act
    expect(() => pdf.form.textField('t', { ...box(p, f), colour: 1 })).toThrow(/unknown option "colour"/);
    expect(() => pdf.form.button('b', { ...box(p, f), label: 'B', action: { named: 'Print' } })).toThrow(/named: NextPage/);
    expect(() => pdf.form.button('b', { ...box(p, f), label: 'B', action: { named: 'NextPage', reset: true } })).toThrow(/named: NextPage/);
    expect(() => pdf.form.button('b', { ...box(p, f), label: 'B', action: {} })).toThrow(/nothing else/);
    expect(() => pdf.form.button('b', { ...box(p, f), label: 'B', action: { reset: [') /JS (x'] } })).not.toThrow(); // a name, checked at the end
  }));

  it('a reset or lock naming no field fails pdf.end() clearly', async () => {
    const { pdf, p, f } = fresh();
    pdf.form.button('b', { ...box(p, f), label: 'B', action: { reset: ['nobody'] } });
    await expect(pdf.end()).rejects.toThrow(/"nobody" is not a field of this form/);
  });

  it('forged or foreign handles are refused (page, font, image, field)', async () => {
    const { pdf, p, f } = fresh();
    const other = fresh();
    expect(() => pdf.form.textField('t', { ...box(p, f), page: { ref: 1, height: 9, annotate() {} } })).toThrow(/Not a page made by this library/);
    expect(() => pdf.form.textField('t', { ...box(other.p, f) })).toThrow(/belongs to another PDF/);
    expect(() => pdf.form.textField('t', { ...box(p, f), font: { ...f, encode: () => '', name: 'F1 /JS' } })).toThrow(/Not a font made by this library/);
    expect(() => pdf.form.button('b', { ...box(p, f), icon: { type: 'image', width: 1, height: 1 } })).toThrow(/Not an image \(pdf.embedImage\) made by this library/);
    const t = other.pdf.form.textField('t', box(other.p, other.f));
    expect(() => pdf.form.button('b', { ...box(p, f), label: 'x', action: { reset: [t] } })).toThrow(/belongs to another PDF/);
    expect(() => pdf.form.button('b', { ...box(p, f), label: 'x', action: { reset: [{ type: 'field', name: 'x' }] } })).toThrow(/full name/);
  });
});
