// @ts-check
/**
 * JPEG decoder (DCTDecode): baseline and extended (SOF0/1) and progressive (SOF2) Huffman, 8-bit, 1–4 components,
 * any sampling factors (upsampled by repetition, as pdf.js does), restart intervals, Adobe APP14 colour transforms
 * (YCbCr → RGB, YCCK → CMYK). Output: the samples as a DCTDecode filter gives them, `comps` per pixel, row by row.
 * 12-bit, arithmetic-coded, lossless and hierarchical JPEGs throw "not supported".
 *
 * The data is HOSTILE. Before anything is allocated: the size is at most maxPixels, components 1–4, sampling factors
 * 1–4 with at most 10 blocks per MCU, the coefficient count is charged to the caller's budget (tick). Huffman tables
 * are checked (at most 256 codes, no code longer than its length allows), quantisation tables must exist, scans are at
 * most 64 with valid spectral ranges. Every loop runs over blocks the frame declares; truncated data reads as zeros
 * (at most 64 bits past the end, then it stops), so a short or broken file never loops.
 */

/** the most scans one image may have (a progressive JPEG has about 10) */
export const MAX_SCANS = 64;

const ZIGZAG = new Int32Array([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47,
  55, 62, 63,
]);
// cos table for the separable inverse DCT: C[x * 8 + u] = c(u) cos((2x + 1) u π / 16) / 2
const C = new Float64Array(64);
for (let x = 0; x < 8; x++)
  for (let u = 0; u < 8; u++) C[x * 8 + u] = ((u ? 1 : Math.SQRT1_2) * Math.cos(((2 * x + 1) * u * Math.PI) / 16)) / 2;

const END = {}; // thrown when a scan's data runs out
const bad = (/** @type {string} */ m) => new TypeError(`JPEG: ${m}`);

/** a Huffman table → { look: code → value via maxcode per length } @param {Uint8Array} counts @param {Uint8Array} vals */
function huffman(counts, vals) {
  const maxcode = new Int32Array(18).fill(-1),
    valptr = new Int32Array(17),
    mincode = new Int32Array(17);
  let code = 0,
    k = 0;
  for (let l = 1; l <= 16; l++) {
    valptr[l] = k;
    mincode[l] = code;
    code += counts[l - 1];
    k += counts[l - 1];
    if (code > 1 << l) throw bad('a Huffman table has more codes than its lengths allow');
    maxcode[l] = counts[l - 1] ? code - 1 : -1;
    code <<= 1;
  }
  maxcode[17] = 0x7fffffff;
  return { maxcode, valptr, mincode, vals };
}

/**
 * @param {Uint8Array} b @param {{ maxPixels: number, tick: (n: number) => void, transform?: 0 | 1 }} o
 * transform: the PDF's /ColorTransform, over the file's own (Adobe APP14, JFIF, component ids)
 * @returns {{ w: number, h: number, comps: number, data: Uint8ClampedArray }}
 */
export function decodeJpeg(b, o) {
  const { maxPixels, tick } = o;
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) throw bad('no JPEG signature (FF D8)');
  /** @type {(Uint16Array | null)[]} */ const qt = [null, null, null, null];
  /** @type {any[]} */ const dcT = [null, null, null, null],
    acT = [null, null, null, null];
  /** @type {any} */ let frame = null;
  let adobe = -1, // the APP14 transform (-1: no Adobe segment)
    jfif = false,
    restart = 0,
    scans = 0,
    pos = 2;
  const u16 = (/** @type {number} */ p) => {
    if (p + 1 >= b.length) throw bad('truncated');
    return (b[p] << 8) | b[p + 1];
  };
  for (;;) {
    // next marker (fill bytes FF FF … allowed); data where a marker belongs is skipped byte by byte
    while (pos < b.length && b[pos] !== 0xff) pos++;
    while (pos < b.length && b[pos] === 0xff) pos++;
    if (pos >= b.length) break; // no EOI: what was decoded stands
    const m = b[pos++];
    if (m === 0xd9) break; // EOI
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) continue;
    const len = u16(pos),
      end = pos + len;
    if (len < 2 || end > b.length) throw bad('a segment runs past the end of the data');
    const s = pos + 2;
    if (m === 0xdb) {
      for (let p = s; p < end;) {
        const pq = b[p] >> 4,
          tq = b[p] & 15;
        if (tq > 3 || pq > 1 || p + 1 + 64 * (pq + 1) > end) throw bad('a bad quantisation table');
        const t = new Uint16Array(64);
        for (let i = 0; i < 64; i++) t[ZIGZAG[i]] = pq ? u16(p + 1 + 2 * i) : b[p + 1 + i];
        qt[tq] = t;
        p += 1 + 64 * (pq + 1);
      }
    } else if (m === 0xc4) {
      for (let p = s; p < end;) {
        const tc = b[p] >> 4,
          th = b[p] & 15;
        if (tc > 1 || th > 3 || p + 17 > end) throw bad('a bad Huffman table');
        const counts = b.subarray(p + 1, p + 17);
        const n = counts.reduce((a, c) => a + c, 0);
        if (n > 256 || p + 17 + n > end) throw bad('a Huffman table has too many codes');
        (tc ? acT : dcT)[th] = huffman(counts, b.slice(p + 17, p + 17 + n));
        p += 17 + n;
      }
    } else if (m === 0xc0 || m === 0xc1 || m === 0xc2) {
      if (frame) throw bad('more than one frame');
      if (len < 8 || b[s] !== 8) throw bad(`${b[s]}-bit samples are not supported`);
      const h = u16(s + 1),
        w = u16(s + 3),
        nc = b[s + 5];
      if (!w || !h) throw bad('no size (a DNL height is not supported)');
      if (w * h > maxPixels) throw bad(`${w} × ${h} is more than ${maxPixels.toLocaleString('en')} pixels`);
      if (nc < 1 || nc > 4 || len !== 8 + 3 * nc) throw bad('1 to 4 components');
      const cs = [];
      let hmax = 1,
        vmax = 1,
        blocks = 0;
      for (let i = 0; i < nc; i++) {
        const p = s + 6 + 3 * i;
        const ch = b[p + 1] >> 4,
          cv = b[p + 1] & 15;
        if (ch < 1 || ch > 4 || cv < 1 || cv > 4 || b[p + 2] > 3) throw bad('a bad component');
        cs.push({ id: b[p], h: ch, v: cv, tq: b[p + 2], pred: 0 });
        hmax = Math.max(hmax, ch);
        vmax = Math.max(vmax, cv);
        blocks += ch * cv;
      }
      if (blocks > 10) throw bad('more than 10 blocks per MCU');
      const mcusX = Math.ceil(w / (8 * hmax)),
        mcusY = Math.ceil(h / (8 * vmax));
      let coeffs = 0;
      for (const c of cs) coeffs += mcusX * c.h * mcusY * c.v * 64;
      tick(1 + (coeffs >> 6)); // a step per block, charged before the buffers exist
      for (const c of cs) {
        c.bpl = Math.ceil(Math.ceil((w * c.h) / hmax) / 8); // blocks a line holds (non-interleaved scans)
        c.bpc = Math.ceil(Math.ceil((h * c.v) / vmax) / 8);
        c.stride = mcusX * c.h; // blocks in the buffer, MCU-padded
        c.rows = mcusY * c.v;
        c.co = new Int16Array(c.stride * c.rows * 64);
      }
      frame = { w, h, cs, hmax, vmax, mcusX, mcusY, progressive: m === 0xc2 };
    } else if (m >= 0xc3 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      throw bad(m >= 0xc9 ? 'arithmetic coding is not supported' : 'lossless and hierarchical JPEGs are not supported');
    } else if (m === 0xdd) restart = u16(s);
    else if (m === 0xee && len >= 14 && String.fromCharCode(...b.subarray(s, s + 5)) === 'Adobe') adobe = b[s + 11];
    else if (m === 0xe0 && len >= 7 && String.fromCharCode(...b.subarray(s, s + 4)) === 'JFIF') jfif = true;
    else if (m === 0xda) {
      if (!frame) throw bad('a scan before the frame');
      if (++scans > MAX_SCANS) throw bad(`more than ${MAX_SCANS} scans`);
      const ns = b[s];
      if (ns < 1 || ns > 4 || len !== 6 + 2 * ns) throw bad('a bad scan header');
      const comps = [];
      for (let i = 0; i < ns; i++) {
        const c = frame.cs.find((/** @type {any} */ c) => c.id === b[s + 1 + 2 * i]);
        if (!c) throw bad('a scan names an unknown component');
        c.dc = dcT[b[s + 2 + 2 * i] >> 4];
        c.ac = acT[b[s + 2 + 2 * i] & 15];
        comps.push(c);
      }
      const p = s + 1 + 2 * ns;
      const ss = b[p],
        se = b[p + 1],
        ah = b[p + 2] >> 4,
        al = b[p + 2] & 15;
      if (
        frame.progressive ? ss > 63 || se > 63 || se < ss || (ss === 0 && se !== 0) || al > 13 : ss !== 0 || se !== 63
      )
        throw bad('a bad spectral selection');
      pos = scan(b, end, frame, comps, restart, ss, se, ah, al, tick);
      continue;
    }
    pos = end;
  }
  if (!frame) throw bad('no frame (SOF)');
  return output(
    frame,
    qt,
    o.transform === undefined ? adobe : o.transform ? 1 : 0,
    jfif,
    tick,
    o.transform !== undefined,
  );
}

/** one scan's entropy-coded data, from p; returns where it stopped (at a marker) */
function scan(
  /** @type {Uint8Array} */ b,
  /** @type {number} */ p,
  /** @type {any} */ f,
  /** @type {any[]} */ comps,
  /** @type {number} */ restart,
  /** @type {number} */ ss,
  /** @type {number} */ se,
  /** @type {number} */ ah,
  /** @type {number} */ al,
  /** @type {(n: number) => void} */ tick,
) {
  let buf = 0,
    bits = 0,
    past = 0,
    eobrun = 0;
  const bit = () => {
    if (!bits) {
      let v = 0;
      if (p >= b.length || (b[p] === 0xff && b[p + 1] !== 0)) {
        // the end, or a marker: zeros, then the scan stops (what is decoded stands)
        if (++past > 8) throw END;
      } else if ((v = b[p++]) === 0xff) p++; // FF 00
      buf = v;
      bits = 8;
    }
    return (buf >> --bits) & 1;
  };
  const get = (/** @type {number} */ n) => {
    let v = 0;
    while (n--) v = (v << 1) | bit();
    return v;
  };
  const extend = (/** @type {number} */ v, /** @type {number} */ n) =>
    n === 0 ? 0 : v < 1 << (n - 1) ? v - (1 << n) + 1 : v;
  const sym = (/** @type {any} */ t) => {
    if (!t) throw bad('a scan uses a Huffman table that was not defined');
    let code = bit(),
      l = 1;
    while (code > t.maxcode[l]) {
      code = (code << 1) | bit();
      if (++l > 16) throw bad('a bad Huffman code');
    }
    const i = t.valptr[l] + code - t.mincode[l];
    if (i >= t.vals.length) throw bad('a bad Huffman code');
    return t.vals[i];
  };

  /** @param {any} c @param {number} o the block's first coefficient */
  const block = (c, o) => {
    const z = c.co;
    if (!f.progressive) {
      const t = sym(c.dc);
      if (t > 16) throw bad('a bad DC difference');
      c.pred += extend(get(t), t);
      z[o] = c.pred;
      for (let k = 1; k < 64;) {
        const rs = sym(c.ac),
          r = rs >> 4,
          s = rs & 15;
        if (!s) {
          if (r !== 15) break;
          k += 16;
          continue;
        }
        k += r;
        if (k > 63) break;
        z[o + ZIGZAG[k++]] = extend(get(s), s);
      }
    } else if (ss === 0) {
      if (ah === 0) {
        const t = sym(c.dc);
        if (t > 16) throw bad('a bad DC difference');
        c.pred += extend(get(t), t);
        z[o] = c.pred * (1 << al);
      } else if (bit()) z[o] |= 1 << al;
    } else if (ah === 0) {
      if (eobrun > 0) return void eobrun--;
      for (let k = ss; k <= se;) {
        const rs = sym(c.ac),
          r = rs >> 4,
          s = rs & 15;
        if (!s) {
          if (r < 15) {
            eobrun = (1 << r) - 1 + (r ? get(r) : 0);
            break;
          }
          k += 16;
          continue;
        }
        k += r;
        if (k > se) break;
        z[o + ZIGZAG[k++]] = extend(get(s), s) * (1 << al);
      }
    } else {
      // AC refinement (as libjpeg's decode_mcu_AC_refine)
      const p1 = 1 << al,
        m1 = -1 << al;
      let k = ss;
      if (eobrun <= 0) {
        for (; k <= se; k++) {
          const rs = sym(c.ac);
          let r = rs >> 4;
          const s = rs & 15;
          let v = 0;
          if (s) {
            if (s !== 1) throw bad('a bad refinement');
            v = bit() ? p1 : m1;
          } else if (r !== 15) {
            eobrun = (1 << r) + (r ? get(r) : 0);
            break;
          }
          while (k <= se) {
            const zi = o + ZIGZAG[k];
            if (z[zi] !== 0) {
              if (bit() && (z[zi] & p1) === 0) z[zi] += z[zi] >= 0 ? p1 : m1;
            } else if (--r < 0) break;
            k++;
          }
          if (v && k <= se) z[o + ZIGZAG[k]] = v;
        }
      }
      if (eobrun > 0) {
        for (; k <= se; k++) {
          const zi = o + ZIGZAG[k];
          if (z[zi] !== 0 && bit() && (z[zi] & p1) === 0) z[zi] += z[zi] >= 0 ? p1 : m1;
        }
        eobrun--;
      }
    }
  };

  const single = comps.length === 1;
  const total = single ? comps[0].bpl * comps[0].bpc : f.mcusX * f.mcusY;
  const reset = () => {
    for (const c of f.cs) c.pred = 0;
    eobrun = 0;
    bits = 0;
    past = 0;
    // to the RSTn marker (or whatever marker comes)
    while (p + 1 < b.length && !(b[p] === 0xff && b[p + 1] >= 0xd0 && b[p + 1] <= 0xd7)) {
      if (b[p] === 0xff && b[p + 1] !== 0 && b[p + 1] !== 0xff) return;
      p++;
    }
    if (p + 1 < b.length) p += 2;
  };
  try {
    for (let n = 0; n < total; n++) {
      step(n);
    }
  } catch (e) {
    if (e !== END) throw e;
  }
  function step(/** @type {number} */ n) {
    if (restart && n && n % restart === 0) reset();
    if ((n & 255) === 0) tick(1 + (comps.length << 4));
    if (single) {
      const c = comps[0];
      block(c, (((n / c.bpl) | 0) * c.stride + (n % c.bpl)) * 64);
    } else {
      const my = (n / f.mcusX) | 0,
        mx = n % f.mcusX;
      for (const c of comps)
        for (let v = 0; v < c.v; v++)
          for (let h = 0; h < c.h; h++) block(c, ((my * c.v + v) * c.stride + mx * c.h + h) * 64);
    }
  }
  // to the next marker
  while (p + 1 < b.length && !(b[p] === 0xff && b[p + 1] !== 0 && !(b[p + 1] >= 0xd0 && b[p + 1] <= 0xd7))) p++;
  return p;
}

/** dequantise, inverse DCT, upsample, colour-convert */
function output(
  /** @type {any} */ f,
  /** @type {(Uint16Array | null)[]} */ qt,
  /** @type {number} */ adobe,
  /** @type {boolean} */ jfif,
  /** @type {(n: number) => void} */ tick,
) {
  const { w, h, cs, hmax, vmax } = f;
  const tmp = new Float64Array(64),
    row = new Float64Array(8);
  const planes = cs.map((/** @type {any} */ c) => {
    const q = qt[c.tq];
    if (!q) throw bad('a component uses a quantisation table that was not defined');
    const pw = c.stride * 8,
      plane = new Uint8Array(pw * c.rows * 8);
    for (let by = 0; by < c.rows; by++) {
      tick(1 + c.stride);
      for (let bx = 0; bx < c.stride; bx++) {
        const o = (by * c.stride + bx) * 64,
          z = c.co;
        // rows: tmp[y*8+u] = Σv F(u,v) C(y,v)
        let last = -1; // the last frequency row with a coefficient (most rows of most blocks are zero)
        for (let v = 0; v < 8; v++) {
          let nz = -1;
          for (let u = 0; u < 8; u++) {
            const c = z[o + v * 8 + u];
            row[u] = c * q[v * 8 + u];
            if (c) nz = u;
          }
          if (nz < 0) continue;
          tmp.fill(0, (last + 1) * 8, v * 8); // zero rows since the last one with a coefficient
          last = v;
          for (let x = 0; x < 8; x++) {
            let s = 0;
            for (let u = 0; u <= nz; u++) s += row[u] * C[x * 8 + u];
            tmp[v * 8 + x] = s;
          }
        }
        for (let x = 0; x < 8; x++)
          for (let y = 0; y < 8; y++) {
            let s = 0;
            for (let v = 0; v <= last; v++) s += tmp[v * 8 + x] * C[y * 8 + v];
            const px = Math.round(s + 128);
            plane[(by * 8 + y) * pw + bx * 8 + x] = px < 0 ? 0 : px > 255 ? 255 : px;
          }
      }
    }
    c.co = null;
    return { plane, pw, sx: c.h / hmax, sy: c.v / vmax };
  });
  const n = cs.length,
    data = new Uint8ClampedArray(w * h * n);
  const ids = cs.map((/** @type {any} */ c) => c.id);
  const transform =
    n === 3
      ? adobe >= 0
        ? adobe !== 0
        : jfif || !(ids[0] === 82 && ids[1] === 71 && ids[2] === 66)
      : n === 4
        ? adobe === 2
        : false;
  for (let y = 0; y < h; y++) {
    if ((y & 63) === 0) tick(1 + ((w * 64 * n) >> 4));
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * n;
      for (let k = 0; k < n; k++) {
        const P = planes[k];
        data[o + k] = P.plane[((y * P.sy) | 0) * P.pw + ((x * P.sx) | 0)];
      }
      if (transform) {
        const Y = data[o],
          cb = data[o + 1] - 128,
          cr = data[o + 2] - 128;
        let r = Y + 1.402 * cr,
          g = Y - 0.344136 * cb - 0.714136 * cr,
          bb = Y + 1.772 * cb;
        if (n === 4) ((r = 255 - r), (g = 255 - g), (bb = 255 - bb)); // YCCK → CMY (K stays)
        data[o] = r;
        data[o + 1] = g;
        data[o + 2] = bb;
      }
    }
  }
  return { w, h, comps: n, data };
}
