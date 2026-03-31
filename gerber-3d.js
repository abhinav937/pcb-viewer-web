/**
 * gerber-3d.js — converts parsed Gerber data into a Three.js 3D PCB model.
 *
 * Architecture:
 *  - Board body   : ExtrudeGeometry from Edge.Cuts outline (solid FR4 colour on sides,
 *                   base soldermask green on top/bottom faces)
 *  - Per-layer planes : one transparent PlaneGeometry per detected layer, stacked just
 *                   above / below the board face so each can be shown/hidden independently.
 *
 *  group.userData.layerMeshes  →  Map<gerberType, THREE.Mesh>
 */

import * as THREE from 'three';

// ── Constants ──────────────────────────────────────────────────────────────────
const BOARD_THICKNESS = 1.6;    // mm, standard FR4
const TEX_PX_PER_MM  = 20;      // texture resolution
const MAX_TEX         = 2048;   // maximum texture dimension in pixels

// PCB colours
const C = {
  maskGreen:  '#1b5e20',   // soldermask base
  copper:     '#b8860b',   // copper (under mask, darker)
  pad:        '#daa520',   // exposed pad / soldermask opening
  silk:       '#f0f0e0',   // silkscreen cream-white
  fr4:        '#c8a850',   // FR4 substrate edge colour
};

// Which Gerber layer types to materialise and at what Y offset from the face
const STACK = [
  // front face (y = BOARD_THICKNESS + offset)
  { type: 'front_copper',     face: 'front', offset: 0.010 },
  { type: 'front_mask',       face: 'front', offset: 0.020 },
  { type: 'front_silkscreen', face: 'front', offset: 0.030 },
  // back face  (y = 0 - offset, mirrored in X)
  { type: 'back_copper',      face: 'back',  offset: 0.010 },
  { type: 'back_mask',        face: 'back',  offset: 0.020 },
  { type: 'back_silkscreen',  face: 'back',  offset: 0.030 },
];

// ── Main export ────────────────────────────────────────────────────────────────

/**
 * @param {Array<{layerType:string, data:object}>} layers
 * @param {{ holes: Array<{x,y,diameter}> }}       drillData
 * @returns {THREE.Group}  – group.userData.layerMeshes: Record<type, THREE.Mesh>
 */
export function buildBoard(layers, drillData) {
  const group = new THREE.Group();
  group.name  = 'Gerber_PCB';

  const byType = {};
  for (const l of layers) byType[l.layerType] = l.data;

  // Global bounding box across all layers
  const bounds = globalBounds(Object.values(byType));
  if (!bounds || bounds.width < 0.1 || bounds.height < 0.1) return group;

  const { minX, maxX, minY, maxY } = bounds;
  const W = bounds.width, H = bounds.height;

  // Texture scale (px/mm, capped)
  const texW = Math.min(Math.ceil(W * TEX_PX_PER_MM), MAX_TEX);
  const texH = Math.min(Math.ceil(H * TEX_PX_PER_MM), MAX_TEX);
  const sx   = texW / W;
  const sy   = texH / H;

  // ── 1. Board body ────────────────────────────────────────────────────────
  const outline  = byType['board_outline'];
  const shape    = outline ? outlineToShape(outline.objects, bounds) : rectShape(W, H);

  const geo = new THREE.ExtrudeGeometry(shape, { depth: BOARD_THICKNESS, bevelEnabled: false });
  geo.rotateX(-Math.PI / 2);
  // Board XZ footprint: X ∈ [0, W], Z ∈ [-H, 0]

  const boardFaceMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(C.maskGreen), roughness: 0.7, metalness: 0.0,
  });
  const sideMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(C.fr4), roughness: 0.85,
  });

  // ExtrudeGeometry group layout: 0=front face, 1=back face, 2=sides
  const board = new THREE.Mesh(geo, [boardFaceMat, boardFaceMat, sideMat]);
  board.name  = 'board_body';
  group.add(board);

  // ── 2. Per-layer transparent planes ─────────────────────────────────────
  const layerMeshes = {};

  for (const def of STACK) {
    const data = byType[def.type];
    if (!data) continue;

    const canvas = renderLayer(def.type, data, bounds, texW, texH, sx, sy);
    if (!canvas) continue;

    const tex      = new THREE.CanvasTexture(canvas);
    tex.flipY      = true; // default – our py() already accounts for this

    const mat = new THREE.MeshBasicMaterial({
      map:          tex,
      transparent:  true,
      side:         THREE.DoubleSide,
      depthWrite:   false,
      polygonOffset: true,
      polygonOffsetFactor: def.face === 'front' ? -2 : 2,
      polygonOffsetUnits:  def.face === 'front' ? -2 : 2,
    });

    // PlaneGeometry(W, H) in XY, then lay flat into XZ
    const planeGeo = new THREE.PlaneGeometry(W, H);
    planeGeo.rotateX(-Math.PI / 2);
    // After rotation: spans X ∈ [-W/2, W/2], Z ∈ [-H/2, H/2]

    const mesh = new THREE.Mesh(planeGeo, mat);
    mesh.name  = def.type;

    // Centre the plane over the board footprint: board centre is at (W/2, *, -H/2)
    const yPos = def.face === 'front'
      ? BOARD_THICKNESS + def.offset
      : 0 - def.offset;
    mesh.position.set(W / 2, yPos, -H / 2);

    group.add(mesh);
    layerMeshes[def.type] = mesh;
  }

  // ── 3. Drill holes ───────────────────────────────────────────────────────
  if (drillData?.holes?.length) {
    const drillGrp = buildDrillViz(drillData.holes, bounds);
    if (drillGrp) group.add(drillGrp);
  }

  group.userData.layerMeshes = layerMeshes;
  return group;
}

// ── Layer canvas renderers ─────────────────────────────────────────────────────

function renderLayer(type, data, bounds, W, H, sx, sy) {
  const c   = document.createElement('canvas');
  c.width   = W; c.height = H;
  const ctx = c.getContext('2d');

  switch (type) {
    case 'front_copper':
    case 'back_copper':
      ctx.clearRect(0, 0, W, H);
      drawGerberLayer(ctx, data, bounds, W, H, sx, sy, C.copper);
      // Mirror X for back copper so it reads correctly when viewed from below
      if (type === 'back_copper') mirrorCanvasX(c);
      break;

    case 'front_mask':
    case 'back_mask':
      // Start solid green, punch out openings (positive polarity = openings)
      ctx.fillStyle = C.maskGreen;
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'destination-out';
      drawGerberLayer(ctx, data, bounds, W, H, sx, sy, 'rgba(0,0,0,1)');
      ctx.globalCompositeOperation = 'source-over';
      if (type === 'back_mask') mirrorCanvasX(c);
      break;

    case 'front_silkscreen':
    case 'back_silkscreen':
      ctx.clearRect(0, 0, W, H);
      drawGerberLayer(ctx, data, bounds, W, H, sx, sy, C.silk);
      if (type === 'back_silkscreen') mirrorCanvasX(c);
      break;

    default:
      return null;
  }

  return c;
}

/** Mirror canvas horizontally in-place (for back-face layers). */
function mirrorCanvasX(canvas) {
  const tmp = document.createElement('canvas');
  tmp.width  = canvas.width;
  tmp.height = canvas.height;
  const tctx = tmp.getContext('2d');
  tctx.translate(canvas.width, 0);
  tctx.scale(-1, 1);
  tctx.drawImage(canvas, 0, 0);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(tmp, 0, 0);
}

// ── Core Gerber canvas drawing ─────────────────────────────────────────────────

/**
 * Draw all objects from a parsed Gerber layer onto a 2D canvas context.
 */
function drawGerberLayer(ctx, layerData, bounds, W, H, sx, sy, colour) {
  const { objects, apertures } = layerData;

  // Coordinate → canvas pixel
  const px = x => (x - bounds.minX) * sx;
  const py = y => H - (y - bounds.minY) * sy; // flip Y (canvas Y goes down)

  ctx.fillStyle   = colour;
  ctx.strokeStyle = colour;

  for (const obj of objects) {
    // Handle clear polarity (removes material)
    const isClear = obj.polarity === 'clear';
    if (isClear) {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle   = 'rgba(0,0,0,1)';
      ctx.strokeStyle = 'rgba(0,0,0,1)';
    } else {
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle   = colour;
      ctx.strokeStyle = colour;
    }

    switch (obj.type) {
      case 'flash':  drawFlash(ctx, obj, apertures, px, py, sx); break;
      case 'draw':   drawDraw(ctx, obj, apertures, px, py, sx);  break;
      case 'region': drawRegion(ctx, obj, px, py, sx);           break;
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
      ctx.arc(cx, cy, Math.max(ap.d / 2 * sx, 0.5), 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'R': {
      const w = Math.max(ap.w * sx, 1), h = Math.max(ap.h * sx, 1);
      ctx.fillRect(cx - w / 2, cy - h / 2, w, h);
      break;
    }
    case 'O': {
      const w = Math.max(ap.w * sx, 1), h = Math.max(ap.h * sx, 1);
      const r = Math.min(w, h) / 2;
      roundRect(ctx, cx - w / 2, cy - h / 2, w, h, r);
      ctx.fill();
      break;
    }
    case 'P': {
      const r  = Math.max(ap.od / 2 * sx, 0.5);
      const n  = ap.n || 4;
      const a0 = ((ap.rot || 0) * Math.PI) / 180;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const a = a0 + (i / n) * Math.PI * 2;
        i === 0
          ? ctx.moveTo(cx + r * Math.cos(a), cy + r * Math.sin(a))
          : ctx.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a));
      }
      ctx.closePath();
      ctx.fill();
      break;
    }
  }
}

function drawDraw(ctx, obj, apertures, px, py, sx) {
  const ap = apertures.get(obj.apertureId);
  if (!ap) return;

  const lw =
    ap.type === 'C'   ? ap.d                        :
    ap.type === 'P'   ? ap.od                       :
    /* R / O */         Math.min(ap.w ?? 0.1, ap.h ?? 0.1);

  ctx.lineWidth   = Math.max(lw * sx, 0.5);
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';
  ctx.strokeStyle = ctx.fillStyle; // inherit current fill colour

  if (obj.mode === 'linear') {
    ctx.beginPath();
    ctx.moveTo(px(obj.x1), py(obj.y1));
    ctx.lineTo(px(obj.x2), py(obj.y2));
    ctx.stroke();
  } else {
    // Arc: Gerber arc centre = (x1+i, y1+j)
    const acx    = px(obj.x1 + obj.i);
    const acy    = py(obj.y1 + obj.j);
    const radius = Math.sqrt(obj.i * obj.i + obj.j * obj.j) * sx;
    const aStart = Math.atan2(py(obj.y1) - acy, px(obj.x1) - acx);
    const aEnd   = Math.atan2(py(obj.y2) - acy, px(obj.x2) - acx);
    // Canvas Y is inverted → CW/CCW sense flips
    const ccw = obj.mode === 'cw_arc';
    ctx.beginPath();
    ctx.arc(acx, acy, Math.max(radius, 0.5), aStart, aEnd, ccw);
    ctx.stroke();
  }
}

function drawRegion(ctx, obj, px, py, sx) {
  if (!obj.segments?.length) return;
  ctx.beginPath();
  ctx.moveTo(px(obj.segments[0].x1), py(obj.segments[0].y1));

  for (const seg of obj.segments) {
    if (seg.mode === 'linear') {
      ctx.lineTo(px(seg.x2), py(seg.y2));
    } else {
      const acx    = px(seg.x1 + seg.i);
      const acy    = py(seg.y1 + seg.j);
      const radius = Math.sqrt(seg.i * seg.i + seg.j * seg.j) * sx;
      const aStart = Math.atan2(py(seg.y1) - acy, px(seg.x1) - acx);
      const aEnd   = Math.atan2(py(seg.y2) - acy, px(seg.x2) - acx);
      ctx.arc(acx, acy, Math.max(radius, 0.5), aStart, aEnd, seg.mode === 'cw_arc');
    }
  }
  ctx.closePath();
  ctx.fill();
}

// ── Board outline → THREE.Shape ───────────────────────────────────────────────

function outlineToShape(objects, bounds) {
  const lineSegs = [];
  for (const o of objects) {
    if (o.type === 'draw')    lineSegs.push(o);
    if (o.type === 'region')  lineSegs.push(...o.segments);
  }
  if (!lineSegs.length) return rectShape(bounds.width, bounds.height);

  const chain = chainSegments(lineSegs);
  if (!chain?.length) return rectShape(bounds.width, bounds.height);
  return shapeFromChain(chain, bounds);
}

function chainSegments(segs) {
  const EPS  = 0.05; // mm gap tolerance
  const used = new Uint8Array(segs.length);
  const chain = [segs[0]];
  used[0] = 1;

  for (let iter = 0; iter < segs.length * 2 && chain.length < segs.length; iter++) {
    const { x2: ex, y2: ey } = chain[chain.length - 1];
    let found = false;
    for (let i = 0; i < segs.length; i++) {
      if (used[i]) continue;
      const s = segs[i];
      if (Math.hypot(s.x1 - ex, s.y1 - ey) < EPS) {
        chain.push(s); used[i] = 1; found = true; break;
      }
      if (Math.hypot(s.x2 - ex, s.y2 - ey) < EPS) {
        // Reverse segment direction
        chain.push({ ...s, x1: s.x2, y1: s.y2, x2: s.x1, y2: s.y1,
          i: -s.i, j: -s.j,
          mode: s.mode === 'cw_arc' ? 'ccw_arc' : s.mode === 'ccw_arc' ? 'cw_arc' : s.mode });
        used[i] = 1; found = true; break;
      }
    }
    if (!found) break;
  }
  return chain;
}

function shapeFromChain(chain, bounds) {
  const shape = new THREE.Shape();
  const ox = bounds.minX, oy = bounds.minY;

  shape.moveTo(chain[0].x1 - ox, chain[0].y1 - oy);
  for (const seg of chain) {
    if (seg.mode === 'linear') {
      shape.lineTo(seg.x2 - ox, seg.y2 - oy);
    } else {
      const acx = (seg.x1 + seg.i) - ox;
      const acy = (seg.y1 + seg.j) - oy;
      const r   = Math.sqrt(seg.i * seg.i + seg.j * seg.j);
      const a1  = Math.atan2(seg.y1 - (seg.y1 + seg.j), seg.x1 - (seg.x1 + seg.i));
      const a2  = Math.atan2(seg.y2 - (seg.y1 + seg.j), seg.x2 - (seg.x1 + seg.i));
      shape.absarc(acx, acy, r, a1, a2, seg.mode === 'cw_arc');
    }
  }
  shape.closePath();
  return shape;
}

function rectShape(W, H) {
  const s = new THREE.Shape();
  s.moveTo(0, 0); s.lineTo(W, 0); s.lineTo(W, H); s.lineTo(0, H);
  s.closePath();
  return s;
}

// ── Drill visualisation ───────────────────────────────────────────────────────

function buildDrillViz(holes, bounds) {
  const group = new THREE.Group();
  group.name  = 'drills';
  const mat   = new THREE.MeshStandardMaterial({ color: 0x111111 });
  const boardCX = (bounds.minX + bounds.maxX) / 2;
  const boardCY = (bounds.minY + bounds.maxY) / 2;

  const geoCache = {};
  for (const h of holes) {
    const key = h.diameter.toFixed(3);
    if (!geoCache[key]) {
      const g = new THREE.CylinderGeometry(+key / 2, +key / 2, BOARD_THICKNESS + 0.2, 10);
      g.rotateX(Math.PI / 2); // align with board Y-up
      geoCache[key] = g;
    }
    const mesh = new THREE.Mesh(geoCache[key], mat);
    mesh.position.set(
      h.x - boardCX,
      BOARD_THICKNESS / 2,
      -(h.y - boardCY),
    );
    group.add(mesh);
  }
  return group.children.length ? group : null;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function globalBounds(layerDataArr) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const d of layerDataArr) {
    if (!d?.bounds) continue;
    minX = Math.min(minX, d.bounds.minX); maxX = Math.max(maxX, d.bounds.maxX);
    minY = Math.min(minY, d.bounds.minY); maxY = Math.max(maxY, d.bounds.maxY);
  }
  if (!isFinite(minX)) return null;
  return { minX, maxX, minY, maxY,
    get width()  { return this.maxX - this.minX; },
    get height() { return this.maxY - this.minY; },
  };
}

function roundRect(ctx, x, y, w, h, r) {
  if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); return; }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
