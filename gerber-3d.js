/**
 * gerber-3d.js — converts parsed Gerber layer data into a Three.js 3D PCB model.
 *
 * Pipeline:
 *  1. Chain Edge.Cuts segments → THREE.Shape → ExtrudeGeometry (board body)
 *  2. Render each layer to an offscreen canvas → THREE.CanvasTexture
 *  3. Composite front/back textures and apply to the board faces
 */

import * as THREE from 'three';

// ── Constants ──────────────────────────────────────────────────────────────────
const BOARD_THICKNESS = 1.6;   // mm, standard FR4
const TEX_PX_PER_MM  = 20;     // render resolution: 20 px per mm
const MAX_TEX         = 2048;  // max texture dimension

// PCB material colours
const C = {
  mask:      '#1a5c20',   // soldermask green
  maskDark:  '#0f3a14',   // mask (under-silk zone)
  copper:    '#c8a000',   // copper under mask (trace colour)
  pad:       '#e8c000',   // exposed pad / soldermask opening
  silk:      '#f5f5e8',   // silkscreen white-cream
  fr4:       '#c8b06a',   // FR4 substrate (edge colour)
  drill:     '#111111',   // drill hole
};

// ── Main entry point ───────────────────────────────────────────────────────────

/**
 * Build a THREE.Group representing a full PCB from parsed Gerber layers.
 *
 * @param {Array<{layerType:string, data:object}>} layers  Parsed Gerber layers
 * @param {{ holes: Array<{x,y,diameter}> }} drillData     Parsed drill data
 * @returns {THREE.Group}
 */
export function buildBoard(layers, drillData) {
  const group = new THREE.Group();
  group.name  = 'Gerber_PCB';

  // ── gather layer data by type ──
  const byType = {};
  for (const l of layers) byType[l.layerType] = l.data;

  // ── compute shared bounds across all layers ──
  const bounds = globalBounds(Object.values(byType));
  if (!bounds || bounds.width < 0.01 || bounds.height < 0.01) return group;

  // ── board outline ──
  const outlineData = byType['board_outline'];
  const shape       = outlineData
    ? outlineToShape(outlineData.objects, bounds)
    : rectShape(bounds);

  if (!shape) return group;

  // ── extrude board body ──
  const geo = new THREE.ExtrudeGeometry(shape, { depth: BOARD_THICKNESS, bevelEnabled: false });
  // Rotate so board lies flat in XZ plane with Y pointing up
  geo.rotateX(-Math.PI / 2);
  // Recompute UVs from world XZ position so textures align
  remapUVsFromXZ(geo, bounds);

  // ── build textures ──
  const W = Math.min(Math.ceil(bounds.width  * TEX_PX_PER_MM), MAX_TEX);
  const H = Math.min(Math.ceil(bounds.height * TEX_PX_PER_MM), MAX_TEX);
  const scaleX = W / bounds.width;
  const scaleY = H / bounds.height;

  const frontCanvas = makeFrontTexture(byType, bounds, W, H, scaleX, scaleY);
  const backCanvas  = makeBackTexture (byType, bounds, W, H, scaleX, scaleY);

  const frontTex = new THREE.CanvasTexture(frontCanvas);
  const backTex  = new THREE.CanvasTexture(backCanvas);
  // flipY = true (default): canvas v=0 → bottom of image, v=1 → top — matches our py() flip

  // ExtrudeGeometry groups: 0 = front face (z=depth → top after rotation), 1 = back, 2 = sides
  const mats = [
    new THREE.MeshStandardMaterial({ map: frontTex, roughness: 0.55, metalness: 0.05 }),
    new THREE.MeshStandardMaterial({ map: backTex,  roughness: 0.55, metalness: 0.05 }),
    new THREE.MeshStandardMaterial({ color: new THREE.Color(C.fr4), roughness: 0.8 }),
  ];

  const board = new THREE.Mesh(geo, mats);
  board.name  = 'pcb_board';
  group.add(board);

  // ── drill holes (visualised as dark cylinders punching through) ──
  if (drillData?.holes?.length) {
    const drillGrp = buildDrillViz(drillData.holes, bounds);
    if (drillGrp) group.add(drillGrp);
  }

  return group;
}

// ── UV remapping ──────────────────────────────────────────────────────────────

/**
 * After rotateX(-PI/2) the shape vertices live in the XZ plane.
 * Remap all vertex UVs to [0,1] based on X and Z position.
 * This ensures the face texture aligns with the board footprint regardless
 * of the shape origin.
 */
function remapUVsFromXZ(geo, bounds) {
  const pos = geo.getAttribute('position');
  const uv  = new Float32Array(pos.count * 2);
  const W = bounds.width, H = bounds.height;

  for (let i = 0; i < pos.count; i++) {
    // Shape was built spanning [0,W] in X and [0,H] in Y.
    // After rotateX(-PI/2): shape_x → world_x, shape_y → world_(-z)
    //   so: world_x = shape_x ∈ [0, W]
    //       world_z = -shape_y ∈ [-H, 0]
    const wx = pos.getX(i);          //  [0, W]
    const wz = pos.getZ(i);          //  [-H, 0]

    const u = wx / W;                //  [0, 1]  left → right
    const v = -wz / H;               //  [0, 1]  PCB minY → maxY

    uv[i * 2]     = Math.max(0, Math.min(1, u));
    uv[i * 2 + 1] = Math.max(0, Math.min(1, v));
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

// ── Canvas texture builders ────────────────────────────────────────────────────

function makeFrontTexture(byType, bounds, W, H, sx, sy) {
  const c   = document.createElement('canvas');
  c.width   = W; c.height = H;
  const ctx = c.getContext('2d');

  // 1 — soldermask base
  ctx.fillStyle = C.mask;
  ctx.fillRect(0, 0, W, H);

  // 2 — front copper (subdued — under mask)
  drawLayer(ctx, byType['front_copper'], 'dark', bounds, W, H, sx, sy, C.copper, C.copper);

  // 3 — soldermask openings (front mask) → bright pad colour punched through
  //     KiCad mask is POSITIVE: drawn areas = openings (no mask)
  drawLayer(ctx, byType['front_mask'], 'dark', bounds, W, H, sx, sy, C.pad, C.pad);

  // 4 — silkscreen on top
  drawLayer(ctx, byType['front_silkscreen'], 'dark', bounds, W, H, sx, sy, C.silk, C.silk);

  return c;
}

function makeBackTexture(byType, bounds, W, H, sx, sy) {
  const c   = document.createElement('canvas');
  c.width   = W; c.height = H;
  const ctx = c.getContext('2d');

  ctx.fillStyle = C.mask;
  ctx.fillRect(0, 0, W, H);

  // Back copper — mirror horizontally so it reads correctly when flipped
  ctx.save();
  ctx.scale(-1, 1);
  ctx.translate(-W, 0);
  drawLayer(ctx, byType['back_copper'],      'dark', bounds, W, H, sx, sy, C.copper, C.copper);
  drawLayer(ctx, byType['back_mask'],        'dark', bounds, W, H, sx, sy, C.pad,    C.pad);
  drawLayer(ctx, byType['back_silkscreen'],  'dark', bounds, W, H, sx, sy, C.silk,   C.silk);
  ctx.restore();

  return c;
}

// ── Layer canvas renderer ─────────────────────────────────────────────────────

/**
 * Render all objects from a parsed Gerber layer onto a canvas context.
 */
function drawLayer(ctx, layerData, defaultPol, bounds, W, H, sx, sy, fillCol, strokeCol) {
  if (!layerData) return;
  const { objects, apertures } = layerData;

  // Coordinate → canvas pixel
  const px = x => (x - bounds.minX) * sx;
  const py = y => H - (y - bounds.minY) * sy;  // flip Y

  for (const obj of objects) {
    const pol = obj.polarity ?? defaultPol;

    if (pol === 'clear') {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle   = 'rgba(0,0,0,1)';
      ctx.strokeStyle = 'rgba(0,0,0,1)';
    } else {
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle   = fillCol;
      ctx.strokeStyle = strokeCol ?? fillCol;
    }

    if (obj.type === 'flash') {
      drawFlash(ctx, obj, apertures, px, py, sx);
    } else if (obj.type === 'draw') {
      drawDraw(ctx, obj, apertures, px, py, sx, sy);
    } else if (obj.type === 'region') {
      drawRegion(ctx, obj, px, py, sx, sy);
    }
  }
  ctx.globalCompositeOperation = 'source-over';
}

function drawFlash(ctx, obj, apertures, px, py, sx) {
  const ap = apertures.get(obj.apertureId);
  if (!ap) return;
  const cx = px(obj.x), cy = py(obj.y);

  ctx.beginPath();
  switch (ap.type) {
    case 'C':
      ctx.arc(cx, cy, ap.d / 2 * sx, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'R': {
      const w = ap.w * sx, h = ap.h * sx;
      ctx.fillRect(cx - w / 2, cy - h / 2, w, h);
      break;
    }
    case 'O': {
      const w = ap.w * sx, h = ap.h * sx;
      const r = Math.min(w, h) / 2;
      roundRect(ctx, cx - w / 2, cy - h / 2, w, h, r);
      ctx.fill();
      break;
    }
    case 'P': {
      const r = ap.od / 2 * sx;
      const n = ap.n || 4;
      const a0 = (ap.rot || 0) * Math.PI / 180;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const a = a0 + (i / n) * Math.PI * 2;
        i === 0 ? ctx.moveTo(cx + r * Math.cos(a), cy + r * Math.sin(a))
                : ctx.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a));
      }
      ctx.closePath();
      ctx.fill();
      break;
    }
  }
}

function drawDraw(ctx, obj, apertures, px, py, sx, sy) {
  const ap = apertures.get(obj.apertureId);
  if (!ap) return;

  const lw = (ap.type === 'C' ? ap.d : Math.min(ap.w ?? 0.05, ap.h ?? 0.05)) * sx;
  ctx.lineWidth   = Math.max(lw, 0.5);
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';
  ctx.strokeStyle = ctx.fillStyle;

  if (obj.mode === 'linear') {
    ctx.beginPath();
    ctx.moveTo(px(obj.x1), py(obj.y1));
    ctx.lineTo(px(obj.x2), py(obj.y2));
    ctx.stroke();
  } else {
    // Arc: centre = (x1+i, y1+j) in Gerber space
    const acx  = px(obj.x1 + obj.i);
    const acy  = py(obj.y1 + obj.j);
    const r    = Math.sqrt(obj.i * obj.i + obj.j * obj.j) * sx;
    const aStart = Math.atan2(py(obj.y1) - acy, px(obj.x1) - acx);
    const aEnd   = Math.atan2(py(obj.y2) - acy, px(obj.x2) - acx);
    // In canvas, Y is down → CW/CCW sense flips
    const ccw = obj.mode === 'cw_arc'; // inverted because canvas Y-down
    ctx.beginPath();
    ctx.arc(acx, acy, r, aStart, aEnd, ccw);
    ctx.stroke();
  }
}

function drawRegion(ctx, obj, px, py, sx, sy) {
  if (!obj.segments?.length) return;
  ctx.beginPath();
  const first = obj.segments[0];
  ctx.moveTo(px(first.x1), py(first.y1));

  for (const seg of obj.segments) {
    if (seg.mode === 'linear') {
      ctx.lineTo(px(seg.x2), py(seg.y2));
    } else {
      const acx   = px(seg.x1 + seg.i);
      const acy   = py(seg.y1 + seg.j);
      const r     = Math.sqrt(seg.i * seg.i + seg.j * seg.j) * sx;
      const aStart = Math.atan2(py(seg.y1) - acy, px(seg.x1) - acx);
      const aEnd   = Math.atan2(py(seg.y2) - acy, px(seg.x2) - acx);
      ctx.arc(acx, acy, r, aStart, aEnd, seg.mode === 'cw_arc');
    }
  }
  ctx.closePath();
  ctx.fill();
}

// ── Board outline → THREE.Shape ───────────────────────────────────────────────

function outlineToShape(objects, bounds) {
  // Collect line/arc segments from the outline layer
  const segs = objects.filter(o => o.type === 'draw' || (o.type === 'region'));
  const lineSegs = [];
  for (const o of segs) {
    if (o.type === 'draw')   lineSegs.push(o);
    if (o.type === 'region') lineSegs.push(...o.segments);
  }
  if (!lineSegs.length) return rectShape(bounds);

  // Chain into a closed polygon
  const chain = chainSegments(lineSegs);
  if (!chain?.length) return rectShape(bounds);

  return buildShapeFromChain(chain, bounds);
}

function chainSegments(segs) {
  const EPS   = 0.05; // mm gap tolerance
  const used  = new Array(segs.length).fill(false);
  const chain = [];

  // Start from seg 0
  used[0] = true;
  chain.push(segs[0]);

  let iterations = 0;
  while (chain.length < segs.length && iterations++ < segs.length * 2) {
    const last = chain[chain.length - 1];
    const ex = last.x2, ey = last.y2;
    let found = false;

    for (let i = 0; i < segs.length; i++) {
      if (used[i]) continue;
      const s = segs[i];
      const d1 = Math.hypot(s.x1 - ex, s.y1 - ey);
      const d2 = Math.hypot(s.x2 - ex, s.y2 - ey);

      if (d1 < EPS) {
        used[i] = true; chain.push(s); found = true; break;
      } else if (d2 < EPS) {
        // Reverse the segment so it connects
        used[i] = true;
        chain.push({ ...s, x1: s.x2, y1: s.y2, x2: s.x1, y2: s.y1, i: -s.i, j: -s.j, mode: s.mode === 'cw_arc' ? 'ccw_arc' : s.mode === 'ccw_arc' ? 'cw_arc' : s.mode });
        found = true; break;
      }
    }
    if (!found) break; // gap in outline — stop here
  }

  return chain;
}

function buildShapeFromChain(chain, bounds) {
  const shape  = new THREE.Shape();
  const ox     = bounds.minX;
  const oy     = bounds.minY;

  shape.moveTo(chain[0].x1 - ox, chain[0].y1 - oy);

  for (const seg of chain) {
    if (seg.mode === 'linear') {
      shape.lineTo(seg.x2 - ox, seg.y2 - oy);
    } else {
      const acx  = (seg.x1 + seg.i) - ox;
      const acy  = (seg.y1 + seg.j) - oy;
      const r    = Math.sqrt(seg.i * seg.i + seg.j * seg.j);
      const a1   = Math.atan2(seg.y1 - (seg.y1 + seg.j), seg.x1 - (seg.x1 + seg.i));
      const a2   = Math.atan2(seg.y2 - (seg.y1 + seg.j), seg.x2 - (seg.x1 + seg.i));
      shape.absarc(acx, acy, r, a1, a2, seg.mode === 'cw_arc');
    }
  }

  shape.closePath();
  return shape;
}

function rectShape(bounds) {
  const s = new THREE.Shape();
  s.moveTo(0,              0);
  s.lineTo(bounds.width,   0);
  s.lineTo(bounds.width,   bounds.height);
  s.lineTo(0,              bounds.height);
  s.closePath();
  return s;
}

// ── Drill visualisation ───────────────────────────────────────────────────────

function buildDrillViz(holes, bounds) {
  if (!holes.length) return null;
  const group = new THREE.Group();
  group.name  = 'drills';

  const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(C.drill) });

  // Group holes by diameter to reuse geometries
  const diameters = [...new Set(holes.map(h => h.diameter.toFixed(3)))];
  const geos = {};
  for (const d of diameters) {
    geos[d] = new THREE.CylinderGeometry(+d / 2, +d / 2, BOARD_THICKNESS + 0.1, 12);
    geos[d].rotateX(Math.PI / 2); // align with Y-up board
  }

  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;

  for (const h of holes) {
    const key  = h.diameter.toFixed(3);
    const mesh = new THREE.Mesh(geos[key], mat);
    mesh.position.set(h.x - cx, BOARD_THICKNESS / 2, -(h.y - cy));
    group.add(mesh);
  }

  return group;
}

// ── Bounds helpers ────────────────────────────────────────────────────────────

function globalBounds(layerDataArr) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;

  for (const d of layerDataArr) {
    if (!d?.bounds) continue;
    const b = d.bounds;
    minX = Math.min(minX, b.minX); maxX = Math.max(maxX, b.maxX);
    minY = Math.min(minY, b.minY); maxY = Math.max(maxY, b.maxY);
  }

  if (!isFinite(minX)) return null;
  return { minX, maxX, minY, maxY, get width() { return this.maxX - this.minX; }, get height() { return this.maxY - this.minY; } };
}

// ── Canvas utility ────────────────────────────────────────────────────────────

function roundRect(ctx, x, y, w, h, r) {
  if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); return; }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
