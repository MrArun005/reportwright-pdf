// @ts-check
/**
 * pdf.viewer(options): how the viewer opens the document. Viewer preferences (/ViewerPreferences), the page mode and
 * layout (/PageMode, /PageLayout) and the open action, which is a destination only (/OpenAction [page /Fit]: a GoTo):
 * there is no way to give a JavaScript, Launch or any other action. Every value is checked against the names PDF
 * defines; an unknown option throws. Written at the end, after the outline (whose /UseOutlines it may override) and
 * the structure tree (PDF/UA needs DisplayDocTitle true, so false throws when tagged).
 */
import { pageIndex, fitOf, destArray } from './dest.js';

const BOOLS = { hideToolbar: 'HideToolbar', hideMenubar: 'HideMenubar', hideWindowUI: 'HideWindowUI', fitWindow: 'FitWindow', centerWindow: 'CenterWindow', displayDocTitle: 'DisplayDocTitle', pickTrayByPDFSize: 'PickTrayByPDFSize' };
/** @type {Record<string, string[]>} */
const NAMES = {
  direction: ['L2R', 'R2L'], printScaling: ['None', 'AppDefault'], duplex: ['Simplex', 'DuplexFlipShortEdge', 'DuplexFlipLongEdge'],
  pageMode: ['UseNone', 'UseOutlines', 'UseThumbs', 'FullScreen', 'UseOC', 'UseAttachments'],
  pageLayout: ['SinglePage', 'OneColumn', 'TwoColumnLeft', 'TwoColumnRight', 'TwoPageLeft', 'TwoPageRight'],
};
const PREF = { direction: 'Direction', printScaling: 'PrintScaling', duplex: 'Duplex' };

/** @param {import('../document.js').Doc} doc */
export function createViewer(doc) {
  /** @type {Map<string, any>} */
  const set = new Map();
  let registered = false;
  const finish = () => {
    const prefs = [];
    for (const [k, v] of set) {
      if (k in BOOLS) prefs.push(`/${/** @type {any} */ (BOOLS)[k]} ${v}`);
      else if (k in PREF) prefs.push(`/${/** @type {any} */ (PREF)[k]} /${v}`);
      else if (k === 'numCopies') prefs.push(`/NumCopies ${v}`);
    }
    if (doc.tagged && !set.has('displayDocTitle')) prefs.push('/DisplayDocTitle true'); // PDF/UA
    if (prefs.length) doc.catalog('ViewerPreferences', `<< ${prefs.join(' ')} >>`);
    if (set.has('pageMode')) doc.catalog('PageMode', `/${set.get('pageMode')}`);
    if (set.has('pageLayout')) doc.catalog('PageLayout', `/${set.get('pageLayout')}`);
    const open = set.get('openAt');
    if (open) {
      const a = destArray(doc, open.i, open.d);
      if (a) doc.catalog('OpenAction', a);
      else doc.warn(`viewer openAt points to page ${open.i + 1}, but the PDF has ${doc.pageCount} pages`);
    }
  };
  /** @param {Record<string, any>} o */
  return (o) => {
    const who = 'pdf.viewer';
    if (!o || typeof o !== 'object') throw new TypeError(`${who}(options): an object`);
    /** @type {[string, any][]} */
    const add = [];
    for (const [k, v] of Object.entries(o)) {
      if (k in BOOLS) {
        if (typeof v !== 'boolean') throw new TypeError(`${who}: ${k} is true or false`);
        if (k === 'displayDocTitle' && !v && doc.tagged) throw new TypeError(`${who}: a tagged PDF (PDF/UA) shows its title: displayDocTitle cannot be false`);
        add.push([k, v]);
      } else if (k in NAMES) {
        if (!NAMES[k].includes(v)) throw new TypeError(`${who}: ${k} is one of ${NAMES[k].join(', ')}, not ${JSON.stringify(v)}`);
        add.push([k, v]);
      } else if (k === 'numCopies') {
        if (!(Number.isInteger(v) && v >= 1 && v <= 5)) throw new RangeError(`${who}: numCopies is 1–5, not ${v}`);
        add.push([k, v]);
      } else if (k === 'openAt') {
        if (!v || typeof v !== 'object' || v.page == null) throw new TypeError(`${who}: openAt is { page, fit?, left?, top?, zoom? } (a destination: the only open action written)`);
        add.push([k, { i: pageIndex(doc, v.page, `${who} openAt`), d: fitOf(v, `${who} openAt`) }]);
      } else throw new TypeError(`${who}: unknown option ${JSON.stringify(k)} (the open action is openAt, a page destination; JavaScript and other actions are never written)`);
    }
    for (const [k, v] of add) set.set(k, v);
    if (!registered) { registered = true; doc.onFinish(finish); }
  };
}
