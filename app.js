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

  // ── viewer events ──────────────────────────────────────────────────────

  viewer.on('loadStart', () => {
    setStatus('Loading…', 'info');
    progressWrap.hidden = false;
    progressBar.style.width = '0%';
  });

  viewer.on('loadProgress', ({ loaded, total, stage }) => {
    const pct = total ? Math.round((loaded / total) * 100) : 0;
    progressBar.style.width = (stage ? 50 : pct) + '%'; // WASM stages don't have byte progress
    const stageLabel = { 'fetch': 'Fetching…', 'loading-wasm': 'Loading WASM engine…', 'parsing': 'Parsing geometry…' }[stage] || `Loading… ${pct}%`;
    setStatus(stageLabel, 'info');
  });

  viewer.on('loadComplete', ({ layers, components, fileType }) => {
    progressWrap.hidden = true;
    dropzone.hidden = true;
    canvas.hidden   = false;

    // sync controls to viewer defaults
    wireframeChk.checked = false;
    gridChk.checked = true;
    explodeSlider.value = 0;

    if (fileType === 'step') {
      // STEP mode — no layer/component data; hide those panels gracefully
      setStatus('STEP model loaded — 3D view only (no layer or component data)', 'success');
      layerList.innerHTML   = '<p class="empty" style="padding:10px 8px">STEP files don\'t contain layer data</p>';
      componentList.innerHTML = '<p class="empty" style="padding:10px 8px">No component list in STEP mode</p>';
      statsEl.textContent   = 'STEP model';
      document.getElementById('sidebar-left').style.opacity = '0.5';
      document.getElementById('sidebar-right').querySelector('#component-list').parentElement.style.opacity = '0.5';
    } else {
      document.getElementById('sidebar-left').style.opacity = '';
      document.getElementById('sidebar-right').querySelector('#component-list').parentElement.style.opacity = '';
      setStatus(`Loaded — ${components.length} component(s), ${layers.filter(l => l.objectCount > 0).length} layer(s)`, 'success');
      renderLayers(layers);
      renderComponentList(components);
      updateStats(components.length, layers);
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

async function loadFile(file) {
  if (!file) return;

  const isGLB  = /\.(glb|gltf)$/i.test(file.name);
  const isSTEP = /\.(step|stp)$/i.test(file.name);

  if (!isGLB && !isSTEP) {
    setStatus('Unsupported format. Drop a .glb / .gltf (KiCad) or .step / .stp (any EDA tool) file.', 'error');
    return;
  }

  // Show the canvas BEFORE constructing the viewer so the container has
  // real pixel dimensions when Three.js initialises the renderer.
  canvas.hidden = false;
  dropzone.hidden = true;
  initViewer();

  try {
    if (isSTEP) {
      await viewer.loadSTEP(file);
    } else {
      await viewer.loadGLB(file);
    }
  } catch (err) {
    setStatus('Error loading file: ' + err.message, 'error');
    console.error(err);
  }
}

// Drag and drop on the dropzone
dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('drag-over'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('drag-over');
  loadFile(e.dataTransfer.files[0]);
});

// Drag and drop anywhere on the canvas (for re-loading)
canvas.addEventListener('dragover', e => e.preventDefault());
canvas.addEventListener('drop', (e) => {
  e.preventDefault();
  loadFile(e.dataTransfer.files[0]);
});

// File input button
fileInput.addEventListener('change', () => loadFile(fileInput.files[0]));
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
setStatus('Drop a .glb or .step file to begin');
