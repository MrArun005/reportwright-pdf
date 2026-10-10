// Hostile attachment names (core/filename.js): names that display or save as something else (bidi, zero-width, NTFS
// streams, dot look-alikes), Windows device names, types outside the passive allowlist, double extensions, a MIME type that contradicts the extension, a huge name. Each throws a clear error in under 1 s;
// a valid Unicode name round-trips in /UF with an ASCII /F.
import { describe, it, expect } from 'vitest';
import { PDFName, PDFDict } from 'pdf-lib';
import { createPdf, toBytes } from '../src/index.js';
import { HAS, run, save } from './tools.js';
import { load, annots, get, bytesOf } from './nav-tools.js';

const FILE = new TextEncoder().encode('%PDF-1.7 not really\n');
const page = () => createPdf({ write() {} }).addPage();
const refused = (name, o, re) => {
  const t = performance.now();
  expect(() => page().attachFile(FILE, { name, ...o })).toThrow(re);
  expect(performance.now() - t).toBeLessThan(1000);
};

describe('hostile attachment names', () => {
  it('bidi, zero-width, format and C1 characters and lone surrogates are refused', () => {
    refused('invoice‮fdp.exe', {}, /control, format, bidi or Windows-invalid character \(U\+202E\)/);
    refused('invoice⁧fdp.pdf', {}, /U\+2067/);
    refused('repo​rt.pdf', {}, /U\+200B/);
    refused('﻿report.pdf', {}, /U\+FEFF/);
    refused('re­port.pdf', {}, /U\+00AD/);
    refused('re\u0085port.pdf', {}, /U\+0085/);
    refused('re port.pdf', {}, /U\+2028/);
    refused('re\uD800port.pdf', {}, /U\+D800/);
    refused('a؜b.pdf', {}, /U\+061C/);
  });

  it('trailing dots and spaces are trimmed (and an empty result refused); device names are refused', async () => {
    refused(' . . ', {}, /file name is empty/);
    refused('CON.txt', {}, /Windows device name/);
    refused('nul', {}, /Windows device name/);
    refused('lpt9.tar.gz', {}, /Windows device name/);
    refused('Com1 .pdf', {}, /Windows device name/);
    const out = await toBytes((pdf) => { pdf.addPage().attachFile(FILE, { name: 'report.pdf .', mimeType: 'application/pdf' }); }, { creationDate: new Date(0) });
    const fs = annots(await load(out))[0].lookup(PDFName.of('FS'), PDFDict);
    expect(get(fs, 'UF')).toBe('report.pdf');
  });

  it('only passive types are allowed by default; others need allowTypes; inner extensions must be allowed too', async () => {
    refused('setup.exe', {}, /\.exe is not an allowed type.*allowTypes: \['exe'\]/);
    refused('notes.docm', {}, /\.docm is not an allowed type/);
    refused('x.scpt', {}, /\.scpt is not an allowed type/);
    refused('archive.zip', {}, /\.zip is not an allowed type.*zip with allowArchives/);
    refused('report', {}, /a name without an extension is not an allowed type/);
    refused('invoice.pdf.scr', {}, /\.scr is not an allowed type/);
    refused('invoice.scr.pdf', {}, /inner extension \.scr/);
    refused('report.docx.js', {}, /\.js is not an allowed type/);
    refused('a.exe', { allowTypes: ['.exe'] }, /is not an extension/);
    const ok = async (name, o = {}) => get(annots(await load(await toBytes((pdf) => { pdf.addPage().attachFile(FILE, { name, ...o }); }, { creationDate: new Date(0) })))[0].lookup(PDFName.of('FS'), PDFDict), 'UF');
    expect(await ok('tool.exe', { allowTypes: ['exe'] })).toBe('tool.exe');
    expect(await ok('photo.JPG')).toBe('photo.JPG');
    expect(await ok('data.csv', { mimeType: 'text/csv' })).toBe('data.csv');
    expect(await ok('Q3 report 2026.10.pdf')).toBe('Q3 report 2026.10.pdf'); // numeric and spaced parts are not extensions
    expect(await ok('bundle.zip', { allowArchives: true })).toBe('bundle.zip');
  });

  it('NTFS streams, Windows-invalid characters, dot look-alikes, hidden files and byte length are refused', () => {
    refused('x.exe::$DATA', {}, /Windows-invalid character \(U\+003A\)/);
    refused('report.pdf:evil.exe', {}, /U\+003A/);
    for (const c of '<>"|?*') refused(`a${c}b.pdf`, {}, /Windows-invalid/);
    refused('invoice\uFF0Eexe', {}, /looks like a dot \(U\+FF0E\)/);
    refused('a\u2024exe', {}, /looks like a dot \(U\+2024\)/);
    refused('a\u3002exe.pdf', {}, /U\+3002/);
    refused('a\uFE52exe.pdf', {}, /U\+FE52/);
    refused('a\u0701exe.pdf', {}, /U\+0701/);
    refused('.bashrc', {}, /starts with a dot/);
    refused('.pdf', {}, /starts with a dot/);
    refused(`${'ä'.repeat(126)}.pdf`, {}, /at most 255 bytes/); // 256 UTF-8 bytes
    refused('report.ex\u00e9', { allowTypes: ['exe'] }, /not an allowed type/); // its ASCII /F form would read report.ex_
  });

  it('a MIME type must agree with the extension; a 1 MB name is refused', () => {
    refused('photo.png', { mimeType: 'application/pdf' }, /MIME type application\/pdf does not match the extension \.png/);
    refused('notes.pdf', { mimeType: 'text/plain' }, /does not match/);
    refused('logo.jpg', { mimeType: 'image/png' }, /does not match/);
    refused('data', { mimeType: 'text/csv', allowTypes: ['bin'] }, /without an extension/);
    refused('a'.repeat(1 << 20), {}, /at most 255 bytes/);
    refused('a'.repeat(300) + '.pdf', {}, /at most 255 bytes/);
  });

  it('a valid Unicode name round-trips in /UF; /F is ASCII with "_" for the rest', async () => {
    const out = await toBytes((pdf) => { pdf.addPage().attachFile(FILE, { name: 'Rechnung März.pdf', mimeType: 'application/pdf', description: 'Desc (with) <delims> /JS' }); }, { creationDate: new Date(0), compress: false });
    const fs = annots(await load(out))[0].lookup(PDFName.of('FS'), PDFDict);
    expect(get(fs, 'UF')).toBe('Rechnung März.pdf'); // NFC: one ä
    expect(bytesOf(fs.get(PDFName.of('F'))).toString('latin1')).toBe('Rechnung M_rz.pdf');
    expect(get(fs, 'Desc')).toBe('Desc (with) <delims> /JS');
    expect(Buffer.from(out).toString('latin1')).not.toMatch(/\/JS\b|\/JavaScript/);
    if (HAS.poppler) expect(run('pdfdetach', ['-list', save(out)])).toMatch(/1: Rechnung März\.pdf/);
  });
});

describe('hostile attachment names (review 3)', () => {
  it('slash look-alikes, Unicode spaces and padding', () => {
    refused('docs／..／x.pdf', {}, /looks like a slash \(U\+FF0F\)/);
    refused('a∕b.pdf', {}, /looks like a slash \(U\+2215\)/);
    refused('a⁄b.pdf', {}, /U\+2044/);
    refused('a＼b.pdf', {}, /U\+FF3C/);
    refused('a∖b.pdf', {}, /U\+2216/);
    refused(`report.pdf${' '.repeat(60)}.txt`, {}, /3 spaces in a row/);
    refused('a　b.pdf', {}, /a space other than U\+0020 \(U\+3000\)/);
    refused('a b.pdf', {}, /U\+00A0/);
    refused('a b.pdf', {}, /U\+2009/);
    expect(() => page().attachFile(FILE, { name: 'a b.pdf' })).not.toThrow();
    expect(() => page().attachFile(FILE, { name: 'a  b.pdf' })).not.toThrow(); // two are fine
  });

  it('every passive extension has its MIME types; a contradicting one is refused; allowTypes takes any', () => {
    refused('invoice.pdf', { mimeType: 'application/x-msdownload' }, /MIME type application\/x-msdownload does not match the extension \.pdf/);
    refused('sheet.xlsx', { mimeType: 'application/vnd.ms-excel.sheet.macroEnabled.12' }, /does not match/);
    refused('data.json', { mimeType: 'text/javascript' }, /does not match/);
    expect(() => page().attachFile(FILE, { name: 'sheet.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })).not.toThrow();
    expect(() => page().attachFile(FILE, { name: 'photo.JPG', mimeType: 'image/jpeg' })).not.toThrow();
    expect(() => page().attachFile(FILE, { name: 'tool.exe', mimeType: 'application/x-msdownload', allowTypes: ['exe'] })).not.toThrow();
  });

  it('random hostile names: every accepted one is safe, has an allowed extension and re-checks clean', async () => {
    const { checkFileName, PASSIVE } = await import('../src/core/filename.js');
    const ALPHA = ['a', 'b', 'x', ' ', ' ', '.', '.', ':', '/', '\\', '‮', '⁦', '​', '﻿', '­', '．', '․', '。', '／', '∕', '＼', '　', ' ', '\u0085', 'C', 'O', 'N', 'ä', 'ä'];
    let seed = 42;
    const rnd = (n) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 8) % n; };
    let accepted = 0;
    const t = performance.now();
    for (let i = 0; i < 2000; i++) {
      let s = '';
      for (let k = 1 + rnd(12); k > 0; k--) s += ALPHA[rnd(ALPHA.length)];
      s += `.${PASSIVE[rnd(PASSIVE.length)]}`;
      if (rnd(4) === 0) s += ALPHA[rnd(ALPHA.length)] + (rnd(2) ? '.exe' : '');
      let r;
      try { r = checkFileName(s, {}, 'test'); } catch (e) { expect(e).toBeInstanceOf(Error); continue; }
      accepted++;
      expect(r.name.slice(0, r.name.lastIndexOf('.')), JSON.stringify(s)).toMatch(/^[abxCONä .]+$/u); // only safe characters (ä as NFC)
      expect(r.name.normalize('NFC')).toBe(r.name);
      expect(r.name).not.toMatch(/ {3}|^\.|[. ]$/);
      expect(PASSIVE).toContain(r.name.split('.').pop().toLowerCase());
      expect(checkFileName(r.name, {}, 'test').name).toBe(r.name);
    }
    expect(accepted).toBeGreaterThan(50);
    expect(performance.now() - t).toBeLessThan(1000);
  });
});

describe('allowTypes keeps the checks of passive types; every reserved device name', () => {
  it('a passive type in allowTypes keeps its MIME check; a risky one takes any MIME', async () => {
    const { checkFileName } = await import('../src/core/filename.js');
    expect(() => checkFileName('invoice.pdf', { mimeType: 'application/x-msdownload', allowTypes: ['pdf'] }, 't')).toThrow(/MIME type application\/x-msdownload does not match/);
    expect(() => checkFileName('scan.png', { mimeType: 'application/pdf', allowTypes: ['png', 'pdf'] }, 't')).toThrow(/does not match/);
    expect(() => checkFileName('a.zip', { mimeType: 'application/x-msdownload', allowArchives: true, allowTypes: ['zip'] }, 't')).toThrow(/does not match/);
    expect(checkFileName('invoice.pdf', { mimeType: 'application/pdf', allowTypes: ['pdf'] }, 't').name).toBe('invoice.pdf');
    expect(checkFileName('tool.exe', { mimeType: 'application/octet-stream', allowTypes: ['exe'] }, 't').name).toBe('tool.exe');
  });
  it('CONIN$, CONOUT$, CLOCK$, COM0 and LPT0 are device names', async () => {
    const { checkFileName } = await import('../src/core/filename.js');
    for (const n of ['CONIN$.txt', 'conout$.pdf', 'CLOCK$.csv', 'COM0.txt', 'lpt0.pdf']) expect(() => checkFileName(n, {}, 't'), n).toThrow(/device name/);
    expect(checkFileName('console.txt', {}, 't').name).toBe('console.txt');
  });
});
