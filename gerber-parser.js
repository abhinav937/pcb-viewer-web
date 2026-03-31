/**
 * gerber-parser.js — RS-274X (Extended Gerber) and Excellon drill parser.
 * Pure browser JS — no external deps.
 *
 * Supports KiCad 7/8 and Altium Gerber exports.
 */

// ── Layer detection ────────────────────────────────────────────────────────────
//
// Primary:  read TF.FileFunction attribute embedded in the Gerber file (X2 format).
//           This is 100% reliable and works for both KiCad and Altium.
// Fallback: filename pattern matching for older files without X2 attributes.

/**
 * Map TF.FileFunction field values → our internal layer type.
 * Matches on the start of the function string (after splitting by comma).
 */
const FILE_FUNCTION_MAP = [
  // Pattern fn(funcTokens, polarity) → type | null
  { test: t => t[0] === 'Copper'     && /top/i.test(t[2] ?? ''),  type: 'front_copper'     },
  { test: t => t[0] === 'Copper'     && /bot/i.test(t[2] ?? ''),  type: 'back_copper'      },
  { test: t => t[0] === 'Pads'       && /top/i.test(t[1] ?? ''),  type: 'front_copper'     }, // Altium pads = extra copper
  { test: t => t[0] === 'Pads'       && /bot/i.test(t[1] ?? ''),  type: 'back_copper'      },
  { test: t => t[0] === 'Soldermask' && /top/i.test(t[1] ?? ''),  type: 'front_mask'       },
  { test: t => t[0] === 'Soldermask' && /bot/i.test(t[1] ?? ''),  type: 'back_mask'        },
  { test: t => t[0] === 'Legend'     && /top/i.test(t[1] ?? ''),  type: 'front_silkscreen' },
  { test: t => t[0] === 'Legend'     && /bot/i.test(t[1] ?? ''),  type: 'back_silkscreen'  },
  { test: t => t[0] === 'Paste'      && /top/i.test(t[1] ?? ''),  type: 'front_paste'      },
  { test: t => t[0] === 'Paste'      && /bot/i.test(t[1] ?? ''),  type: 'back_paste'       },
  { test: t => t[0] === 'Profile',                                 type: 'board_outline'    },
  { test: t => /PTH/i.test(t.join(',')),                           type: 'drill_pth'        },
  { test: t => /NPTH/i.test(t.join(',')),                          type: 'drill_npth'       },
];

// Filename-only fallback (no X2 attributes)
const FILENAME_MAP = [
  { type: 'drill_npth',       tests: [/-npth/i, /npth\.drl/i, /npth.*drill/i] },
  { type: 'drill_pth',        tests: [/\.drl$/i, /\.xln$/i, /\.exc$/i, /\.ncd$/i, /\bpth\b.*drill/i, /drill.*pth\b/i] },
  { type: 'front_copper',     tests: [/\.gtl$/i, /[_-]f[_\.]cu\b/i, /f_copper/i, /copper.*top/i, /signal.*top/i] },
  { type: 'back_copper',      tests: [/\.gbl$/i, /[_-]b[_\.]cu\b/i,             /copper.*bot/i, /signal.*bot/i] },
  { type: 'front_mask',       tests: [/\.gts$/i, /[_-]f[_\.]mask/i, /soldermask.*top/i, /mask.*top/i] },
  { type: 'back_mask',        tests: [/\.gbs$/i, /[_-]b[_\.]mask/i, /soldermask.*bot/i, /mask.*bot/i] },
  { type: 'front_silkscreen', tests: [/\.gto$/i, /[_-]f[_\.]silk/i, /f[_\.]silkscreen/i, /legend.*top/i, /overlay.*top/i] },
  { type: 'back_silkscreen',  tests: [/\.gbo$/i, /[_-]b[_\.]silk/i, /b[_\.]silkscreen/i, /legend.*bot/i, /overlay.*bot/i] },
  { type: 'front_paste',      tests: [/\.gtp$/i, /[_-]f[_\.]paste/i, /paste.*top/i] },
  { type: 'back_paste',       tests: [/\.gbp$/i, /[_-]b[_\.]paste/i, /paste.*bot/i] },
  { type: 'board_outline',    tests: [/\.gko$/i, /\.gm1$/i, /edge[_\.]cuts/i, /board[_\.]outline/i, /_profile\b/i, /profile.*np/i] },
];

/**
 * Detect layer type from filename, optionally using the first ~600 chars of the file.
 * @param {string} filename
 * @param {string} [contentHead]  First few hundred characters of the file
 * @returns {string}  layer type key or 'unknown'
 */
export function detectLayer(filename, contentHead = '') {
  // ── Primary: TF.FileFunction (X2 Gerber attribute) ───────────────────────
  if (contentHead) {
    const funcMatch = contentHead.match(/TF\.FileFunction,([^\*]+)\*/);
    const polMatch  = contentHead.match(/TF\.FilePolarity,([^\*]+)\*/);
    if (funcMatch) {
      const tokens   = funcMatch[1].trim().split(',').map(s => s.trim());
      const polarity = polMatch ? polMatch[1].trim().toLowerCase() : 'positive';
      for (const { test, type } of FILE_FUNCTION_MAP) {
        if (test(tokens, polarity)) return type;
      }
    }
  }

  // ── Fallback: filename patterns ───────────────────────────────────────────
  const n = filename.toLowerCase();
  for (const { type, tests } of FILENAME_MAP) {
    if (tests.some(re => re.test(n))) return type;
  }
  return 'unknown';
}

// ── Gerber RS-274X parser ──────────────────────────────────────────────────────

/**
 * Parse a single Gerber file.
 * @param {string} text  Raw file contents.
 * @returns {{ apertures: Map, objects: object[], bounds: object, units: string }}
 */
export function parseGerber(text) {
  // ── state ──
  let units   = 'mm';
  let fmtDecX = 6, fmtDecY = 6; // decimal digits in coordinate strings
  let fmtAbs  = true;            // absolute vs incremental (incremental is deprecated)

  const apertures = new Map(); // id → { type, ...params }
  const objects   = [];        // flashes, draws, regions

  let x = 0, y = 0;         // current position (mm)
  let curAp = null;          // current aperture id
  let mode  = 'linear';      // 'linear' | 'cw_arc' | 'ccw_arc'
  let polarity = 'dark';

  let inRegion  = false;
  let regionSegs = [];
  let regionPol  = 'dark';

  // ── helpers ──
  function parseCoord(raw, dec) {
    if (raw == null) return null;
    // Integer with implicit decimal: "123456" at dec=6 → 0.123456
    return parseInt(raw, 10) / Math.pow(10, dec);
  }
  function toMM(v) { return v == null ? null : (units === 'in' ? v * 25.4 : v); }
  function cx(raw) { return toMM(parseCoord(raw, fmtDecX)); }
  function cy(raw) { return toMM(parseCoord(raw, fmtDecY)); }

  // Aperture macro definitions: macroName → body string (with primitives)
  const macroDefs = new Map();
  // Altium AMPARAMS comments: aperture id → { w, h } from G04:AMPARAMS lines
  const macroSizes = new Map();

  // ── split file into param blocks and command streams ──
  const normalized = text.replace(/\r\n?/g, '\n');
  const parts = normalized.split('%');
  let cmdStream = '';

  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      cmdStream += parts[i];        // command data between param blocks
    } else {
      processParam(parts[i]);       // keep whitespace for multi-line AM blocks
    }
  }

  // ── pre-scan command stream for Altium AMPARAMS comments ──
  // These appear before %ADD...% aperture defs in the file but are in the command stream,
  // so we scan first to populate macroSizes before parseAperture is called again below.
  for (const raw of cmdStream.split('*')) {
    const cmd = raw.replace(/\s/g, '');
    if (/^G0?4/.test(cmd)) {
      const ampMatch = cmd.match(/AMPARAMS\|DCode=(\d+)\|XSize=([\d.]+)mm\|YSize=([\d.]+)mm/i);
      if (ampMatch) {
        const id = +ampMatch[1], w = parseFloat(ampMatch[2]), h = parseFloat(ampMatch[3]);
        if (isFinite(w) && isFinite(h)) macroSizes.set(id, { w, h });
      }
    }
  }

  // ── re-process param blocks now that macroSizes is populated ──
  // (re-parse only ADD lines that reference macros, they will now find the right size)
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 !== 0) {
      const p = parts[i];
      if (p.startsWith('ADD')) parseAperture(p);
    }
  }

  // ── process commands (delimited by *) ──
  const cmds = cmdStream.split('*').map(c => c.replace(/\s/g, '')).filter(Boolean);
  for (const cmd of cmds) processCmd(cmd);

  // ── bounding box ──
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  function expand(px, py, r = 0) {
    minX = Math.min(minX, px - r); maxX = Math.max(maxX, px + r);
    minY = Math.min(minY, py - r); maxY = Math.max(maxY, py + r);
  }
  for (const o of objects) {
    const ap  = apertures.get(o.apertureId);
    const r   = ap ? apRadius(ap) : 0;
    if (o.type === 'flash') {
      expand(o.x, o.y, r);
    } else if (o.type === 'draw') {
      expand(o.x1, o.y1, r); expand(o.x2, o.y2, r);
    } else if (o.type === 'region') {
      for (const s of o.segments) { expand(s.x1, s.y1); expand(s.x2, s.y2); }
    }
  }
  const safe = v => (isFinite(v) ? v : 0);
  const bounds = {
    minX: safe(minX), maxX: safe(maxX),
    minY: safe(minY), maxY: safe(maxY),
    get width()  { return this.maxX - this.minX; },
    get height() { return this.maxY - this.minY; },
  };

  return { apertures, objects, bounds, units };

  // ── param block handler ──
  function processParam(p) {
    if (p.startsWith('FS')) {
      // e.g. FSLAX46Y46 or FSTIX33Y33
      fmtAbs = p.includes('A');
      const m = p.match(/X(\d)(\d)Y(\d)(\d)/);
      if (m) { fmtDecX = +m[2]; fmtDecY = +m[4]; }
    } else if (p.startsWith('MOMM')) {
      units = 'mm';
    } else if (p.startsWith('MOIN')) {
      units = 'in';
    } else if (p.startsWith('ADD')) {
      parseAperture(p);
    } else if (p.startsWith('LP')) {
      polarity = p[2] === 'C' ? 'clear' : 'dark';
    }
    else if (p.startsWith('AM')) {
      // Aperture macro: AMname*\nprimitive1*\n...
      // Name is everything up to first * or newline
      const firstStar = p.indexOf('*');
      const name = p.slice(2, firstStar > 2 ? firstStar : p.length).trim();
      if (!name) return;
      const body = firstStar > 0 ? p.slice(firstStar + 1) : '';
      macroDefs.set(name, body);
      // Compute bounding box from known primitive types
      let mw = 0, mh = 0;
      for (const rawLine of body.split(/[\n*]+/)) {
        const ln = rawLine.trim();
        if (!ln) continue;
        const parts = ln.split(',');
        const ptype = parseFloat(parts[0]);
        if (ptype === 21) {
          // Center line: 21,exposure,W,H,cx,cy,rot
          const w = parseFloat(parts[2]), h = parseFloat(parts[3]);
          if (isFinite(w)) mw = Math.max(mw, Math.abs(w));
          if (isFinite(h)) mh = Math.max(mh, Math.abs(h));
        } else if (ptype === 1) {
          // Circle: 1,exposure,diameter,cx,cy
          const d = parseFloat(parts[2]);
          if (isFinite(d)) { mw = Math.max(mw, d); mh = Math.max(mh, d); }
        } else if (ptype === 20) {
          // Vector line: 20,exposure,W,...
          const w = parseFloat(parts[2]);
          if (isFinite(w)) { mw = Math.max(mw, w); mh = Math.max(mh, w); }
        }
      }
      if (mw > 0 || mh > 0) {
        macroDefs.set(name + '__size', { w: mw || mh || 0.1, h: mh || mw || 0.1 });
      }
    }
    // TF/TA/TD (attributes), SR (step-repeat) → ignore
  }

  function parseAperture(p) {
    // ADD10C,0.5  or  ADD11R,1.0X0.5  or  ADD12O,1.0X0.5  or  ADD13P,0.8X6X0
    const m = p.match(/^ADD(\d+)([A-Z]+),?(.*)?$/);
    if (!m) return;
    const id     = +m[1];
    const type   = m[2];
    const params = (m[3] || '').split('X').map(Number).filter(v => !isNaN(v));

    switch (type) {
      case 'C': apertures.set(id, { type: 'C', d: params[0] || 0.1 });               break;
      case 'R': apertures.set(id, { type: 'R', w: params[0] || 0.1, h: params[1] ?? params[0] ?? 0.1 }); break;
      case 'O': apertures.set(id, { type: 'O', w: params[0] || 0.1, h: params[1] ?? params[0] ?? 0.1 }); break;
      case 'P': apertures.set(id, { type: 'P', od: params[0] || 0.1, n: params[1] || 3, rot: params[2] || 0 }); break;
      default: {
        // Aperture macro: check AMPARAMS comment first (Altium), then parsed macro primitives
        const fromComment = macroSizes.get(id);
        const fromMacro   = macroDefs.get(type + '__size');
        const sz = fromComment || fromMacro;
        if (sz) {
          apertures.set(id, { type: 'R', w: sz.w, h: sz.h });
        } else {
          apertures.set(id, { type: 'C', d: 0.1 }); // last-resort fallback
        }
      }
    }
  }

  function processCmd(cmd) {
    // G-codes that stand alone
    if (cmd === 'G01' || cmd === 'G1')  { mode = 'linear';  return; }
    if (cmd === 'G02' || cmd === 'G2')  { mode = 'cw_arc';  return; }
    if (cmd === 'G03' || cmd === 'G3')  { mode = 'ccw_arc'; return; }
    if (cmd === 'G36') { inRegion = true;  regionSegs = []; regionPol = polarity; return; }
    if (cmd === 'G37') {
      if (regionSegs.length > 0) objects.push({ type: 'region', segments: regionSegs, polarity: regionPol });
      inRegion = false; regionSegs = [];
      return;
    }
    if (/^G0?4/.test(cmd)) {
      // Altium AMPARAMS comment: G04:AMPARAMS|DCode=82|XSize=1.45mm|YSize=0.91mm|...
      const ampMatch = cmd.match(/AMPARAMS\|DCode=(\d+)\|XSize=([\d.]+)mm\|YSize=([\d.]+)mm/i);
      if (ampMatch) {
        const id = +ampMatch[1];
        const w = parseFloat(ampMatch[2]);
        const h = parseFloat(ampMatch[3]);
        if (isFinite(w) && isFinite(h)) macroSizes.set(id, { w, h });
      }
      return;
    }
    if (/^M0?[02]/.test(cmd)) return; // EOF
    if (cmd === 'G74' || cmd === 'G75') return; // quadrant mode

    // Strip leading G-code if combined
    let rest = cmd.replace(/^G0?([123])/, (_, g) => { mode = g==='1'?'linear':g==='2'?'cw_arc':'ccw_arc'; return ''; });

    // Aperture select: D10 and above (without XY)
    if (/^D(\d{2,})$/.test(rest)) {
      const id = +rest.slice(1);
      if (id >= 10) curAp = id;
      return;
    }

    // Coordinate command: [X...][Y...][I...][J...]D0?[123]
    const m = rest.match(/^(?:X([+-]?\d+))?(?:Y([+-]?\d+))?(?:I([+-]?\d+))?(?:J([+-]?\d+))?D0?([123])$/);
    if (!m) return;

    const newX = m[1] != null ? cx(m[1]) : x;
    const newY = m[2] != null ? cy(m[2]) : y;
    const iOff = m[3] != null ? cx(m[3]) : 0;
    const jOff = m[4] != null ? cy(m[4]) : 0;
    const d    = +m[5];

    if (d === 2) {
      x = newX; y = newY; // move
    } else if (d === 3) {
      x = newX; y = newY;
      objects.push({ type: 'flash', x, y, apertureId: curAp, polarity });
    } else if (d === 1) {
      const seg = { type: 'draw', x1: x, y1: y, x2: newX, y2: newY, apertureId: curAp, mode, i: iOff, j: jOff, polarity };
      if (inRegion) regionSegs.push(seg);
      else          objects.push(seg);
      x = newX; y = newY;
    }
  }
}

// ── Excellon drill parser ──────────────────────────────────────────────────────

/**
 * @param {string} text
 * @returns {{ holes: Array<{x,y,diameter}> }}
 */
export function parseExcellon(text) {
  const holes = [];
  const tools = new Map(); // id → diameter mm
  let curTool  = null;
  let units    = 'mm';
  let dec      = 3; // decimal places in coord ints

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';')) continue;

    if (/^METRIC/i.test(line))      { units = 'mm'; dec = 3; }
    else if (/^INCH/i.test(line))   { units = 'in'; dec = 4; }
    else if (line === 'M48')        continue; // header start
    else if (line === '%' || /^M(95|30|00)/.test(line)) continue;

    // Tool definition: T01C0.800
    const td = line.match(/^T(\d+)C([\d.]+)/i);
    if (td) {
      let d = parseFloat(td[2]);
      if (units === 'in') d *= 25.4;
      tools.set(+td[1], d);
      continue;
    }

    // Tool select: T01
    if (/^T\d+$/.test(line)) { curTool = +line.slice(1); continue; }

    // Coordinate: X...Y...
    const cd = line.match(/^X([+-]?\d+)Y([+-]?\d+)/);
    if (cd && curTool != null) {
      const scale = Math.pow(10, dec);
      let hx = parseInt(cd[1]) / scale;
      let hy = parseInt(cd[2]) / scale;
      if (units === 'in') { hx *= 25.4; hy *= 25.4; }
      holes.push({ x: hx, y: hy, diameter: tools.get(curTool) ?? 0.8 });
    }
  }

  return { holes };
}

// ── Utilities ──────────────────────────────────────────────────────────────────

function apRadius(ap) {
  if (!ap) return 0.05;
  switch (ap.type) {
    case 'C': return ap.d / 2;
    case 'R': case 'O': return Math.max(ap.w, ap.h) / 2;
    case 'P': return ap.od / 2;
    default: return 0.05;
  }
}
