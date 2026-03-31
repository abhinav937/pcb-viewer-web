/**
 * app.js — wires the PCBViewer API to the HTML UI.
 * This file owns the DOM; pcb-viewer.js owns the 3D scene.
 */

import { PCBViewer } from './pcb-viewer.js';

// ─── DOM refs ──────────────────────────────────────────────────────────────
const dropzone     = document.getElementById('dropzone');
const canvas       = document.getElementById('canvas-container');
const fileInput    = document.getElementById('file-input');
const layerList    = document.getElementById('layer-list');
const componentList = document.getElementById('component-list');
const infoPanel    = document.getElementById('info-panel');
const infoContent  = document.getElementById('info-content');
const statusBar    = document.getElementById('status');
const progressBar  = document.getElementById('progress-bar');
const progressWrap = document.getElementById('progress-wrap');
const searchBox    = document.getElementById('search-box');
const measBtn      = document.getElementById('btn-measure');
const explodeSlider = document.getElementById('explode-slider');
const wireframeChk = document.getElementById('chk-wireframe');
const gridChk      = document.getElementById('chk-grid');
const bgSelect     = document.getElementById('bg-select');
const statsEl      = document.getElementById('stats');

// ─── Viewer ────────────────────────────────────────────────────────────────
let viewer = null;

function initViewer() {
  if (viewer) { viewer.dispose(); }
  viewer = new PCBViewer('#canvas-container', { showGrid: true });
  window._viewer = viewer; // debug access

  // ── viewer events ──────────────────────────────────────────────────────

  viewer.on('loadStart', () => {
    setStatus('Loading…', 'info');
    progressWrap.hidden = false;
    progressBar.style.width = '0%';
  });

  viewer.on('loadProgress', ({ loaded, total, stage }) => {
    const pct = total ? Math.round((loaded / total) * 100) : 0;
    const stageLabel = {
      'fetch':        'Fetching…',
      'loading-wasm': 'Loading WASM engine…',
      'parsing':      'Parsing STEP geometry…',
      'reading':      `Reading Gerber files… ${pct}%`,
      'building':     'Building 3D board from Gerbers…',
      'extracting':   'Extracting ZIP…',
    }[stage] || `Loading… ${pct}%`;
    progressBar.style.width = (stage === 'reading' ? pct : 60) + '%';
    setStatus(stageLabel, 'info');
  });

  viewer.on('loadComplete', ({ layers, components, fileType, detectedLayers = [], skipped = [] }) => {
    progressWrap.hidden = true;
    dropzone.hidden = true;
    canvas.hidden   = false;

    // sync controls to viewer defaults
    wireframeChk.checked = false;
    gridChk.checked = true;
    explodeSlider.value = 0;

    const noLayerMode = fileType === 'step' || fileType === 'gerber';

    if (fileType === 'step') {
      setStatus('STEP model loaded — 3D geometry only', 'success');
      layerList.innerHTML     = '<p class="empty" style="padding:10px 8px">STEP files don\'t contain layer data</p>';
      componentList.innerHTML = '<p class="empty" style="padding:10px 8px">No component list in STEP mode</p>';
      statsEl.textContent     = 'STEP model';
    } else if (fileType === 'gerber') {
      const layerCount = layers.filter(l => l.objectCount > 0).length;
      const skippedNote = skipped.length ? ` · ${skipped.length} unrecognised files skipped` : '';
      setStatus(`Gerber PCB loaded — ${layerCount} layer(s) rendered${skippedNote}`, 'success');
      renderLayers(layers);  // layers now has real toggleable meshes
      componentList.innerHTML = '<p class="empty" style="padding:10px 8px">Gerber files don\'t carry component data</p>';
      statsEl.textContent     = `Gerber · ${layerCount} layer(s)`;
    } else {
      setStatus(`Loaded — ${components.length} component(s), ${layers.filter(l => l.objectCount > 0).length} layer(s)`, 'success');
      renderLayers(layers);
      renderComponentList(components);
      updateStats(components.length, layers);
    }

    if (noLayerMode) {
      document.getElementById('sidebar-left').style.opacity = '0.5';
      document.getElementById('sidebar-right').querySelector('#component-list').parentElement.style.opacity = '0.5';
    } else {
      document.getElementById('sidebar-left').style.opacity = '';
      document.getElementById('sidebar-right').querySelector('#component-list').parentElement.style.opacity = '';
    }
  });

  viewer.on('componentClick', ({ name, info, point }) => {
    showInfoPanel(name, info);
  });

  viewer.on('componentHover', ({ name, info }) => {
    highlightListItem(name);
  });

  viewer.on('selectionChange', ({ name, info }) => {
    if (!name) { infoPanel.hidden = true; }
    highlightListItem(name);
  });

  viewer.on('layerChange', ({ key, visible }) => {
    // sync checkbox in layer list
    const chk = layerList.querySelector(`[data-layer="${key}"]`);
    if (chk) chk.checked = visible;
  });

  viewer.on('measurementAdd', ({ distance }) => {
    setStatus(`Measurement: ${distance.toFixed(3)} mm`, 'success');
    measBtn.classList.remove('active');
  });

  viewer.on('measurementCancel', () => {
    measBtn.classList.remove('active');
  });
}

// ─── UI: status bar ────────────────────────────────────────────────────────
function setStatus(msg, type = 'info') {
  statusBar.textContent = msg;
  statusBar.className   = 'status-bar ' + type;
}

// ─── UI: layers panel ──────────────────────────────────────────────────────
function renderLayers(layers) {
  layerList.innerHTML = '';
  for (const layer of layers) {
    if (layer.objectCount === 0) continue;

    const row = document.createElement('label');
    row.className = 'layer-row';

    const chk = document.createElement('input');
    chk.type    = 'checkbox';
    chk.checked = layer.visible;
    chk.dataset.layer = layer.key;
    chk.addEventListener('change', () => viewer.toggleLayer(layer.key, chk.checked));

    const dot = document.createElement('span');
    dot.className = 'layer-dot ' + layer.key;

    const lbl = document.createElement('span');
    lbl.textContent = layer.label;

    const cnt = document.createElement('span');
    cnt.className   = 'layer-count';
    cnt.textContent = layer.objectCount;

    row.append(chk, dot, lbl, cnt);
    layerList.appendChild(row);
  }
}

// ─── UI: component list ────────────────────────────────────────────────────
let allComponents = [];

function renderComponentList(components) {
  allComponents = components;
  filterComponents('');
}

function filterComponents(query) {
  const q = query.toLowerCase();
  componentList.innerHTML = '';

  const filtered = allComponents.filter(c =>
    !q || c.name.toLowerCase().includes(q) ||
    (c.value && c.value.toLowerCase().includes(q)) ||
    (c.reference && c.reference.toLowerCase().includes(q))
  );

  for (const comp of filtered) {
    const row = document.createElement('div');
    row.className  = 'comp-row';
    row.dataset.name = comp.name;
    row.innerHTML  = `
      <span class="comp-ref">${escHtml(comp.reference || comp.name)}</span>
      <span class="comp-val">${escHtml(comp.value || '')}</span>`;

    row.addEventListener('click', () => {
      viewer.selectComponent(comp.name);
      viewer.focusComponent(comp.name);
      showInfoPanel(comp.name, viewer.getComponentInfo(comp.name));
    });

    row.addEventListener('mouseenter', () => {
      viewer.highlightComponent(comp.name, 0x00e5ff);
    });

    componentList.appendChild(row);
  }

  if (filtered.length === 0) {
    componentList.innerHTML = '<p class="empty">No components found</p>';
  }
}

function highlightListItem(name) {
  for (const row of componentList.querySelectorAll('.comp-row')) {
    row.classList.toggle('hovered', row.dataset.name === name);
  }
}

// ─── UI: info panel ────────────────────────────────────────────────────────
function showInfoPanel(name, info) {
  if (!info) { infoPanel.hidden = true; return; }

  infoPanel.hidden = false;
  infoContent.innerHTML = `
    <table class="info-table">
      ${row('Reference', info.reference || name)}
      ${row('Value',     info.value     || '—')}
      ${row('Footprint', info.footprint || '—')}
      ${Object.entries(info)
          .filter(([k]) => !['reference','value','footprint','name'].includes(k))
          .map(([k, v]) => row(k, v))
          .join('')}
    </table>`;
}

function row(k, v) {
  return `<tr><td class="k">${escHtml(String(k))}</td><td class="v">${escHtml(String(v))}</td></tr>`;
}

// ─── UI: stats ─────────────────────────────────────────────────────────────
function updateStats(compCount, layers) {
  const activeLayers = layers.filter(l => l.objectCount > 0).length;
  statsEl.textContent = `${compCount} components · ${activeLayers} layers`;
}

// ─── UI: controls wiring ───────────────────────────────────────────────────

// View buttons
document.querySelectorAll('[data-view]').forEach(btn => {
  btn.addEventListener('click', () => {
    if (!viewer) return;
    viewer.setView(btn.dataset.view);
    document.querySelectorAll('[data-view]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

// Fit button
document.getElementById('btn-fit').addEventListener('click', () => viewer?.fitToBoard());

// Screenshot
document.getElementById('btn-screenshot').addEventListener('click', () => {
  viewer?.downloadScreenshot('pcb-view.png');
});

// Measure toggle
measBtn.addEventListener('click', () => {
  if (!viewer) return;
  if (measBtn.classList.contains('active')) {
    viewer.cancelMeasurement();
    measBtn.classList.remove('active');
  } else {
    viewer.startMeasurement();
    measBtn.classList.add('active');
    setStatus('Click two points on the model to measure', 'info');
  }
});

// Clear measurements
document.getElementById('btn-clear-meas').addEventListener('click', () => {
  viewer?.clearMeasurements();
  measBtn.classList.remove('active');
  setStatus('Measurements cleared', 'info');
});

// Wireframe
wireframeChk.addEventListener('change', () => viewer?.setWireframe(wireframeChk.checked));

// Grid
gridChk.addEventListener('change', () => viewer?.setGrid(gridChk.checked));

// Background
bgSelect.addEventListener('change', () => viewer?.setBackground(bgSelect.value));

// Explode
explodeSlider.addEventListener('input', () => {
  viewer?.setExplode(parseFloat(explodeSlider.value));
});

// Layer show-all button
document.getElementById('btn-show-all').addEventListener('click', () => {
  viewer?.showAllLayers();
  layerList.querySelectorAll('input[type=checkbox]').forEach(c => { c.checked = true; });
});

// Component search
searchBox.addEventListener('input', () => filterComponents(searchBox.value));

// Info panel close
document.getElementById('btn-info-close').addEventListener('click', () => {
  infoPanel.hidden = true;
  viewer?.selectComponent(null);
});

// ─── File loading ──────────────────────────────────────────────────────────

const GERBER_EXT = /\.(gbr|gtl|gbl|gto|gbo|gts|gbs|gtp|gbp|gko|gm1|drl|xln|exc|ncd)$/i;
const GLB_EXT    = /\.(glb|gltf)$/i;
const STEP_EXT   = /\.(step|stp)$/i;
const ZIP_EXT    = /\.zip$/i;

// ── JSZip lazy loader ──────────────────────────────────────────────────────
let _jszip = null;
async function getJSZip() {
  if (_jszip) return _jszip;
  await new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src     = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';
    s.onload  = res;
    s.onerror = () => rej(new Error('Failed to load JSZip from CDN'));
    document.head.appendChild(s);
  });
  _jszip = window.JSZip;
  return _jszip;
}

/** Extract Gerber files from a ZIP and return them as File objects. */
async function extractGerbersFromZip(zipFile) {
  setStatus('Extracting ZIP…', 'info');
  const JSZip = await getJSZip();
  const zip   = await JSZip.loadAsync(zipFile);

  const files = [];
  const promises = [];

  zip.forEach((relativePath, entry) => {
    if (entry.dir) return;

    // Only pull files whose names look like Gerber / drill files
    const basename = relativePath.split('/').pop(); // strip sub-folders
    const isGerber = GERBER_EXT.test(basename) || GLB_EXT.test(basename) || STEP_EXT.test(basename);
    if (!isGerber) return;

    promises.push(
      entry.async('arraybuffer').then(buf => {
        files.push(new File([buf], basename, { type: 'application/octet-stream' }));
      })
    );
  });

  await Promise.all(promises);
  return files;
}

/** Route one or more dropped / selected files to the right loader. */
async function loadFiles(fileList) {
  const files = Array.from(fileList);
  if (!files.length) return;

  // ── ZIP: extract first, then re-classify ──────────────────────────────
  const zips = files.filter(f => ZIP_EXT.test(f.name));
  if (zips.length) {
    try {
      const extracted = await extractGerbersFromZip(zips[0]);
      if (!extracted.length) {
        setStatus('ZIP contained no recognised Gerber / GLB / STEP files.', 'error');
        return;
      }
      await loadFiles(extracted); // recurse with the extracted files
    } catch (err) {
      setStatus('ZIP error: ' + err.message, 'error');
    }
    return;
  }

  // ── Classify flat file list ────────────────────────────────────────────
  const gerbers = files.filter(f => GERBER_EXT.test(f.name));
  const glbs    = files.filter(f => GLB_EXT.test(f.name));
  const steps   = files.filter(f => STEP_EXT.test(f.name));
  const unknown = files.filter(f =>
    !GERBER_EXT.test(f.name) && !GLB_EXT.test(f.name) && !STEP_EXT.test(f.name));

  if (unknown.length === files.length) {
    setStatus(
      `Unsupported file(s): ${unknown.map(f => f.name).join(', ')}. ` +
      'Drop a .zip, .glb, .step, or Gerber files (.gbr / .gtl / .drl …).',
      'error'
    );
    return;
  }

  // Prefer Gerbers if any are present (multi-layer set)
  if (gerbers.length) { await _initAndLoad(() => viewer.loadGerbers(gerbers)); return; }
  if (glbs.length)    { await _initAndLoad(() => viewer.loadGLB(glbs[0]));    return; }
  if (steps.length)   { await _initAndLoad(() => viewer.loadSTEP(steps[0]));  return; }
}

async function _initAndLoad(loaderFn) {
  // Show canvas BEFORE creating viewer so container has real dimensions
  canvas.hidden   = false;
  dropzone.hidden = true;
  initViewer();
  try {
    await loaderFn();
  } catch (err) {
    setStatus('Error: ' + err.message, 'error');
    console.error(err);
  }
}

// Drag and drop on the dropzone
dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('drag-over'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('drag-over');
  loadFiles(e.dataTransfer.files);
});

// Drag and drop anywhere on the canvas (for re-loading)
canvas.addEventListener('dragover', e => e.preventDefault());
canvas.addEventListener('drop', (e) => { e.preventDefault(); loadFiles(e.dataTransfer.files); });

// File input — allow multiple files for Gerber sets
fileInput.addEventListener('change', () => loadFiles(fileInput.files));
document.getElementById('btn-open').addEventListener('click', () => fileInput.click());

// ─── Keyboard shortcuts ────────────────────────────────────────────────────
window.addEventListener('keydown', (e) => {
  if (!viewer) return;
  if (document.activeElement.tagName === 'INPUT') return;

  switch (e.key.toLowerCase()) {
    case '1': viewer.setView('top');       break;
    case '2': viewer.setView('front');     break;
    case '3': viewer.setView('right');     break;
    case '4': viewer.setView('isometric'); break;
    case '5': viewer.setView('bottom');    break;
    case 'f': viewer.fitToBoard();         break;
    case 'w': wireframeChk.checked = !wireframeChk.checked; viewer.setWireframe(wireframeChk.checked); break;
    case 'g': gridChk.checked = !gridChk.checked; viewer.setGrid(gridChk.checked); break;
    case 'escape':
      viewer.selectComponent(null);
      viewer.cancelMeasurement();
      measBtn.classList.remove('active');
      infoPanel.hidden = true;
      break;
  }
});

// ─── utils ─────────────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Boot ───────────────────────────────────────────────────────────────────
setStatus('Drop a .glb, .step, or Gerber set to begin');
