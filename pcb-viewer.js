/**
 * PCBViewer — core 3D viewer library
 * Loads GLB/GLTF (KiCad, Altium) and STEP/STP files and provides a full control API.
 *
 * Usage:
 *   const viewer = new PCBViewer('#canvas-container', { showGrid: true });
 *   await viewer.loadGLB(file);               // File | string (URL) — KiCad / Altium GLB
 *   await viewer.loadSTEP(file);              // File | string (URL) — any STEP/STP file
 *   viewer.setView('top');
 *   viewer.toggleLayer('silkscreen_front', false);
 *   viewer.on('componentClick', ({ name, object }) => …);
 */

import * as THREE from 'three';
import { OrbitControls }  from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader }     from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader }    from 'three/addons/loaders/DRACOLoader.js';

// ─── STEP loader (occt-import-js) — lazy-loaded from CDN ─────────────────────
const OCCT_VERSION = '0.0.23';
const OCCT_CDN     = `https://cdn.jsdelivr.net/npm/occt-import-js@${OCCT_VERSION}/dist`;

// Default material palette for STEP solids when the file has no colour data
const STEP_DEFAULT_COLORS = [
  0x2d7a3a, // PCB green
  0xc0392b, // red component body
  0x2980b9, // blue
  0xf39c12, // amber
  0x8e44ad, // purple
  0x16a085, // teal
  0x7f8c8d, // grey
];

// ─── KiCad GLB layer name patterns ────────────────────────────────────────────
const LAYER_DEFS = {
  board:            { label: 'Board',          patterns: [/^board$/i, /^edge[\._]cuts/i, /^pcb$/i, /^substrate/i]         },
  copper_front:     { label: 'Front Copper',   patterns: [/^f[\._]cu$/i, /^f\.cu/i]                                       },
  copper_back:      { label: 'Back Copper',    patterns: [/^b[\._]cu$/i, /^b\.cu/i]                                       },
  silkscreen_front: { label: 'Front Silkscreen', patterns: [/^f[\._](silk(screen)?)/i]                                    },
  silkscreen_back:  { label: 'Back Silkscreen',  patterns: [/^b[\._](silk(screen)?)/i]                                    },
  mask_front:       { label: 'Front Mask',     patterns: [/^f[\._]mask/i]                                                 },
  mask_back:        { label: 'Back Mask',      patterns: [/^b[\._]mask/i]                                                 },
  fab_front:        { label: 'Front Fab',      patterns: [/^f[\._](fab|courtyard)/i]                                      },
  fab_back:         { label: 'Back Fab',       patterns: [/^b[\._](fab|courtyard)/i]                                      },
  components:       { label: 'Components',     patterns: []  /* populated dynamically */                                  },
};

// Camera preset directions (unit vectors toward the camera)
const VIEW_PRESETS = {
  top:       { eye: [0, 1,   0],    up: [0, 0, -1] },
  bottom:    { eye: [0, -1,  0],    up: [0, 0,  1] },
  front:     { eye: [0, 0,   1],    up: [0, 1,  0] },
  back:      { eye: [0, 0,  -1],    up: [0, 1,  0] },
  left:      { eye: [-1, 0,  0],    up: [0, 1,  0] },
  right:     { eye: [1,  0,  0],    up: [0, 1,  0] },
  isometric: { eye: [1,  1,  1],    up: [0, 1,  0] },
};

// ─── helpers ──────────────────────────────────────────────────────────────────
function classifyObject(name) {
  for (const [key, def] of Object.entries(LAYER_DEFS)) {
    if (key === 'components') continue;
    for (const pat of def.patterns) {
      if (pat.test(name)) return key;
    }
  }
  return null; // caller decides if it's a component
}

function isComponentName(name) {
  // Ref designators: R1, C10, U3, J2, LED1, SW1, TP4, Q1, L2, D3, …
  return /^[A-Z]{1,4}\d+/i.test(name);
}

function lerp(a, b, t) { return a + (b - a) * t; }

// ─── PCBViewer ────────────────────────────────────────────────────────────────
export class PCBViewer {
  // private fields
  #container;
  #renderer;
  #scene;
  #camera;
  #controls;
  #loader;
  #occt           = null;   // occt-import-js instance (lazy-loaded for STEP support)
  #stepMode       = false;  // true when a STEP file is loaded (no layers/component picking)
  #resizeObserver = null;   // watches container visibility changes
  #rafId          = null;

  #model       = null;   // root THREE.Group of the loaded GLB
  #boundingBox = new THREE.Box3();
  #center      = new THREE.Vector3();
  #size        = new THREE.Vector3();

  // layer registry: layerKey → { objects: Set<Object3D>, visible: boolean }
  #layers = {};

  // component registry: name → { object, originalPosition, info }
  #components = new Map();

  // picking
  #raycaster = new THREE.Raycaster();
  #pointer   = new THREE.Vector2();
  #selected  = null;
  #hovered   = null;
  #selectionBox = null;  // THREE.Box3Helper
  #selectionMat = null;  // highlight material
  #originalMaterials = new WeakMap();

  // measurement
  #measMode   = false;
  #measPoints = [];
  #measObjects = [];   // lines / sprites in scene

  // explode
  #explodeFactor = 0;  // 0–1
  #explodeCenter = new THREE.Vector3();

  // animation (camera transitions)
  #camAnim = null;

  // grid
  #grid = null;

  // event listeners
  #handlers = {};

  // options
  #opts = {
    backgroundColor: 0x12121f,
    gridColor: 0x333355,
    ambientIntensity: 0.5,
    dirLightIntensity: 1.0,
    enableShadows: false,
    antialias: true,
  };

  /**
   * @param {string|HTMLElement} container  CSS selector or DOM element
   * @param {object}             options    optional overrides
   */
  constructor(container, options = {}) {
    this.#container = typeof container === 'string'
      ? document.querySelector(container)
      : container;

    Object.assign(this.#opts, options);

    // Initialise layer registry
    for (const key of Object.keys(LAYER_DEFS)) {
      this.#layers[key] = { objects: new Set(), visible: true };
    }

    this.#initRenderer();
    this.#initScene();
    this.#initLoader();
    this.#initEvents();
    this.#animate();
  }

  // ── init ──────────────────────────────────────────────────────────────────

  #initRenderer() {
    this.#renderer = new THREE.WebGLRenderer({
      antialias: this.#opts.antialias,
      preserveDrawingBuffer: true,  // needed for screenshots
    });
    this.#renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.#renderer.setSize(this.#container.clientWidth, this.#container.clientHeight);
    this.#renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.#renderer.toneMapping      = THREE.ACESFilmicToneMapping;
    this.#renderer.toneMappingExposure = 1.2;
    this.#container.appendChild(this.#renderer.domElement);
  }

  #initScene() {
    this.#scene = new THREE.Scene();
    this.#scene.background = new THREE.Color(this.#opts.backgroundColor);
    this.#scene.fog = new THREE.FogExp2(this.#opts.backgroundColor, 0.0015);

    // Lights
    const ambient = new THREE.AmbientLight(0xffffff, this.#opts.ambientIntensity);
    this.#scene.add(ambient);

    const key = new THREE.DirectionalLight(0xffffff, this.#opts.dirLightIntensity);
    key.position.set(5, 10, 7);
    this.#scene.add(key);

    const fill = new THREE.DirectionalLight(0x8899ff, 0.3);
    fill.position.set(-5, 3, -5);
    this.#scene.add(fill);

    const rim = new THREE.DirectionalLight(0xffddaa, 0.2);
    rim.position.set(0, -5, -8);
    this.#scene.add(rim);

    // Camera
    const { clientWidth: w, clientHeight: h } = this.#container;
    this.#camera = new THREE.PerspectiveCamera(45, w / h, 0.01, 2000);
    this.#camera.position.set(0, 80, 120);

    // Controls
    this.#controls = new OrbitControls(this.#camera, this.#renderer.domElement);
    this.#controls.enableDamping   = true;
    this.#controls.dampingFactor   = 0.06;
    this.#controls.screenSpacePanning = true;
    this.#controls.minDistance     = 0.5;
    this.#controls.maxDistance     = 800;
    this.#controls.zoomSpeed       = 1.2;

    // Grid
    this.#createGrid(200, 40);
  }

  #initLoader() {
    const draco = new DRACOLoader();
    draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
    this.#loader = new GLTFLoader();
    this.#loader.setDRACOLoader(draco);
  }

  #initEvents() {
    const el = this.#renderer.domElement;
    el.addEventListener('pointermove', this.#onPointerMove.bind(this));
    el.addEventListener('click',       this.#onClick.bind(this));
    window.addEventListener('resize',  this.#onResize.bind(this));

    // ResizeObserver: catches hidden→visible transitions and sidebar layout shifts
    // that window 'resize' alone won't fire for (e.g. container was 0×0 on init).
    this.#resizeObserver = new ResizeObserver(() => this.#onResize());
    this.#resizeObserver.observe(this.#container);
  }

  // ── render loop ───────────────────────────────────────────────────────────

  #animate() {
    this.#rafId = requestAnimationFrame(this.#animate.bind(this));
    this.#controls.update();
    this.#stepCamAnim();
    this.#renderer.render(this.#scene, this.#camera);
  }

  // ── public: load ──────────────────────────────────────────────────────────

  /**
   * Load a GLB file.
   * @param {File|string} source  File object from <input> / drag-drop, or a URL string.
   * @returns {Promise<void>}
   */
  async loadGLB(source) {
    this.#emit('loadStart', {});

    let url;
    let objectUrl = null;
    if (typeof source === 'string') {
      url = source;
    } else {
      objectUrl = URL.createObjectURL(source);
      url = objectUrl;
    }

    try {
      const gltf = await new Promise((resolve, reject) => {
        this.#loader.load(
          url,
          resolve,
          (e) => this.#emit('loadProgress', { loaded: e.loaded, total: e.total }),
          reject,
        );
      });

      this.#stepMode = false;
      this.#ingestGLTF(gltf);
      this.fitToBoard();
      this.#emit('loadComplete', { layers: this.getLayers(), components: this.getAllComponents(), fileType: 'glb' });
    } finally {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    }
  }

  /** Load a GLB from a URL. */
  loadURL(url) { return this.loadGLB(url); }

  // ── public: STEP loading ──────────────────────────────────────────────────

  /**
   * Load a STEP or STP file directly in the browser (no server needed).
   * Uses occt-import-js (OpenCASCADE compiled to WASM) — loaded lazily from CDN.
   * The model is displayed as a plain 3D solid; no layer/component data is extracted.
   *
   * @param {File|string} source  File object from <input> / drag-drop, or a URL string.
   * @returns {Promise<void>}
   */
  async loadSTEP(source) {
    this.#emit('loadStart', {});

    // Resolve to ArrayBuffer
    let buffer;
    if (typeof source === 'string') {
      this.#emit('loadProgress', { loaded: 0, total: 1, stage: 'fetch' });
      const resp = await fetch(source);
      if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching STEP file`);
      buffer = await resp.arrayBuffer();
    } else {
      buffer = await source.arrayBuffer();
    }

    // Lazy-load occt-import-js WASM module
    this.#emit('loadProgress', { loaded: 0, total: 1, stage: 'loading-wasm' });
    const occt = await this.#loadOcct();

    // Parse STEP — this runs synchronously in WASM (may take 0.5–5 s for complex boards)
    this.#emit('loadProgress', { loaded: 0, total: 1, stage: 'parsing' });
    await new Promise(r => setTimeout(r, 20)); // let the browser paint the progress state
    const result = occt.ReadStepFile(new Uint8Array(buffer), null);

    if (!result.success) throw new Error('occt-import-js could not parse this STEP file.');

    this.#stepMode = true;
    this.#ingestSTEP(result);
    this.fitToBoard();
    this.#emit('loadComplete', { layers: [], components: [], fileType: 'step' });
  }

  /**
   * Lazy-load occt-import-js from CDN via script injection (UMD — no ESM build available).
   * Subsequent calls return the cached instance immediately.
   * @returns {Promise<object>} occt instance
   */
  async #loadOcct() {
    if (this.#occt) return this.#occt;

    // Inject the UMD script tag once
    if (!window.__occtimportjs__) {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = `${OCCT_CDN}/occt-import-js.js`;
        s.onload  = resolve;
        s.onerror = () => reject(new Error(`Failed to load occt-import-js from ${OCCT_CDN}`));
        document.head.appendChild(s);
      });
    }

    this.#occt = await window.occtimportjs({
      locateFile: (path) => `${OCCT_CDN}/${path}`,
    });
    return this.#occt;
  }

  /**
   * Convert an occt-import-js result into Three.js meshes and add them to the scene.
   * @param {{ meshes: object[] }} result
   */
  #ingestSTEP(result) {
    // Clear previous model
    if (this.#model) this.#scene.remove(this.#model);
    for (const key of Object.keys(LAYER_DEFS)) this.#layers[key].objects.clear();
    this.#components.clear();
    this.clearMeasurements();
    this.#clearSelection();

    const group = new THREE.Group();
    group.name  = 'STEP_model';

    let colorIdx = 0;

    for (const mesh of result.meshes) {
      if (!mesh.attributes?.position || !mesh.index) continue; // skip degenerate

      const geo = new THREE.BufferGeometry();

      // Vertex positions
      geo.setAttribute('position',
        new THREE.BufferAttribute(new Float32Array(mesh.attributes.position.array), 3));

      // Normals (optional in STEP — compute if missing)
      if (mesh.attributes.normal?.array) {
        geo.setAttribute('normal',
          new THREE.BufferAttribute(new Float32Array(mesh.attributes.normal.array), 3));
      } else {
        geo.computeVertexNormals();
      }

      // Triangle indices
      geo.setIndex(new THREE.BufferAttribute(new Uint32Array(mesh.index.array), 1));

      // Colour — STEP colours are typically 0–1 floats
      let threeColor;
      if (mesh.color && Array.isArray(mesh.color) && mesh.color.length >= 3) {
        const [r, g, b] = mesh.color;
        // Normalise: if any channel > 1 assume 0–255
        const s = (r > 1 || g > 1 || b > 1) ? 255 : 1;
        threeColor = new THREE.Color(r / s, g / s, b / s);
      } else {
        threeColor = new THREE.Color(STEP_DEFAULT_COLORS[colorIdx % STEP_DEFAULT_COLORS.length]);
        colorIdx++;
      }

      const mat = new THREE.MeshPhysicalMaterial({
        color:     threeColor,
        metalness: 0.15,
        roughness: 0.45,
        side:      THREE.DoubleSide,
      });

      const threeMesh = new THREE.Mesh(geo, mat);
      threeMesh.name  = mesh.name || `solid_${group.children.length}`;
      group.add(threeMesh);

      this.#originalMaterials.set(threeMesh, mat.clone());
    }

    this.#model = group;
    this.#scene.add(this.#model);

    // Centre model at origin
    this.#boundingBox.setFromObject(this.#model);
    this.#boundingBox.getCenter(this.#center);
    this.#boundingBox.getSize(this.#size);
    this.#model.position.sub(this.#center);
    this.#explodeCenter.set(0, 0, 0);

    if (this.#grid) this.#grid.position.y = -(this.#size.y / 2);
  }

  // ── GLB ingestion ─────────────────────────────────────────────────────────

  #ingestGLTF(gltf) {
    // Clear previous model
    if (this.#model) {
      this.#scene.remove(this.#model);
      this.#clearSelection();
    }
    for (const key of Object.keys(LAYER_DEFS)) {
      this.#layers[key].objects.clear();
    }
    this.#components.clear();
    this.clearMeasurements();

    this.#model = gltf.scene;
    this.#scene.add(this.#model);

    // Compute global bounding box
    this.#boundingBox.setFromObject(this.#model);
    this.#boundingBox.getCenter(this.#center);
    this.#boundingBox.getSize(this.#size);

    // Centre the model at origin
    this.#model.position.sub(this.#center);
    this.#explodeCenter.set(0, 0, 0);

    // Traverse & classify
    this.#model.traverse((obj) => {
      if (!obj.isMesh && !obj.isGroup) return;

      const name = obj.name || '';
      const layerKey = classifyObject(name);

      if (layerKey) {
        this.#layers[layerKey].objects.add(obj);
      } else if (isComponentName(name) || this.#isLikelyComponent(obj)) {
        this.#layers['components'].objects.add(obj);
        if (!this.#components.has(name)) {
          const box = new THREE.Box3().setFromObject(obj);
          const pos = new THREE.Vector3();
          box.getCenter(pos);
          this.#components.set(name, {
            object: obj,
            originalPosition: obj.position.clone(),
            worldCenter: pos,
            info: this.#extractMeta(obj, gltf),
          });
        }
      } else {
        // Unknown — put into 'board' as fallback
        this.#layers['board'].objects.add(obj);
      }

      // Save original material for highlight/unhighlight
      if (obj.isMesh && obj.material) {
        this.#originalMaterials.set(obj, Array.isArray(obj.material)
          ? obj.material.map(m => m.clone())
          : obj.material.clone());
      }
    });

    // Snap grid to board bottom
    if (this.#grid) {
      this.#grid.position.y = -(this.#size.y / 2);
    }
  }

  #isLikelyComponent(obj) {
    // Heuristic: small objects far from origin relative to board size are likely components
    if (!obj.isMesh) return false;
    const box = new THREE.Box3().setFromObject(obj);
    const objSize = new THREE.Vector3();
    box.getSize(objSize);
    const boardDiag = this.#size.length();
    return objSize.length() < boardDiag * 0.5;
  }

  #extractMeta(obj, gltf) {
    // KiCad embeds custom properties as userData extras
    return {
      name:      obj.name,
      reference: obj.userData?.reference || obj.name,
      value:     obj.userData?.value     || '',
      footprint: obj.userData?.footprint || '',
      ...obj.userData,
    };
  }

  // ── public: camera / view ─────────────────────────────────────────────────

  /**
   * Fly to a preset view.
   * @param {'top'|'bottom'|'front'|'back'|'left'|'right'|'isometric'} view
   * @param {number} duration  animation ms (default 600)
   */
  setView(view, duration = 600) {
    const preset = VIEW_PRESETS[view];
    if (!preset) throw new Error(`Unknown view "${view}". Valid: ${Object.keys(VIEW_PRESETS).join(', ')}`);

    const dist = this.#camera.position.distanceTo(this.#controls.target);
    const dir  = new THREE.Vector3(...preset.eye).normalize();
    const target = this.#controls.target.clone();
    const newPos  = target.clone().addScaledVector(dir, dist);

    this.#animateCamera(newPos, target, new THREE.Vector3(...preset.up), duration);
  }

  /**
   * Fit the entire board into view.
   */
  fitToBoard() {
    if (!this.#model) return;

    const box = new THREE.Box3().setFromObject(this.#model);
    const size   = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);

    const maxDim = Math.max(size.x, size.y, size.z);
    const fov    = (this.#camera.fov * Math.PI) / 180;
    const dist   = Math.abs(maxDim / 2 / Math.tan(fov / 2)) * 1.6;

    const dir = new THREE.Vector3(1, 1, 1).normalize();
    const newPos = center.clone().addScaledVector(dir, dist);

    this.#animateCamera(newPos, center, new THREE.Vector3(0, 1, 0), 700);

    this.#controls.minDistance = maxDim * 0.05;
    this.#controls.maxDistance = maxDim * 10;
  }

  /**
   * Set exact camera position (world space).
   * @param {number} x
   * @param {number} y
   * @param {number} z
   */
  setCameraPosition(x, y, z) {
    this.#camera.position.set(x, y, z);
    this.#controls.update();
  }

  /** Reset camera to initial position. */
  resetCamera() { this.fitToBoard(); }

  /**
   * Set the orbit target (look-at point).
   * @param {number} x
   * @param {number} y
   * @param {number} z
   */
  setTarget(x, y, z) {
    this.#controls.target.set(x, y, z);
    this.#controls.update();
  }

  // ── public: layers ────────────────────────────────────────────────────────

  /**
   * Get all layer definitions with current visibility.
   * @returns {Array<{ key, label, visible, objectCount }>}
   */
  getLayers() {
    return Object.entries(this.#layers).map(([key, state]) => ({
      key,
      label:       LAYER_DEFS[key]?.label ?? key,
      visible:     state.visible,
      objectCount: state.objects.size,
    }));
  }

  /**
   * Show or hide a layer.
   * @param {string}  layerKey  e.g. 'components', 'silkscreen_front'
   * @param {boolean} visible
   */
  toggleLayer(layerKey, visible) {
    const state = this.#layers[layerKey];
    if (!state) throw new Error(`Unknown layer "${layerKey}"`);
    state.visible = visible ?? !state.visible;
    for (const obj of state.objects) {
      obj.visible = state.visible;
    }
    this.#emit('layerChange', { key: layerKey, visible: state.visible });
  }

  /**
   * Show all layers.
   */
  showAllLayers() {
    for (const key of Object.keys(this.#layers)) {
      this.toggleLayer(key, true);
    }
  }

  // ── public: components ────────────────────────────────────────────────────

  /**
   * Get metadata for all components found in the GLB.
   * @returns {Array<{ name, reference, value, footprint, worldCenter }>}
   */
  getAllComponents() {
    return Array.from(this.#components.entries()).map(([name, data]) => ({
      name,
      reference: data.info.reference,
      value:     data.info.value,
      footprint: data.info.footprint,
      worldCenter: data.worldCenter.toArray(),
    }));
  }

  /**
   * Get info for a single component.
   * @param {string} name
   */
  getComponentInfo(name) {
    return this.#components.get(name)?.info ?? null;
  }

  /**
   * Select (highlight) a component by name. Pass null to deselect.
   * @param {string|null} name
   */
  selectComponent(name) {
    this.#clearSelection();
    if (!name) return;

    const entry = this.#components.get(name);
    if (!entry) {
      console.warn(`PCBViewer: component "${name}" not found`);
      return;
    }

    this.#applyHighlight(entry.object, 0x00e5ff);
    this.#selected = entry.object;

    // Add bounding box helper
    const box = new THREE.Box3().setFromObject(entry.object);
    this.#selectionBox = new THREE.Box3Helper(box, new THREE.Color(0x00e5ff));
    this.#scene.add(this.#selectionBox);

    this.#emit('selectionChange', { name, info: entry.info });
  }

  /**
   * Highlight a component with a custom colour without "selecting" it.
   * @param {string} name
   * @param {number|string} color  THREE.js-compatible colour
   */
  highlightComponent(name, color = 0xffff00) {
    const entry = this.#components.get(name);
    if (entry) this.#applyHighlight(entry.object, color);
  }

  /** Clear all highlights / selection. */
  clearHighlights() { this.#clearSelection(); }

  /**
   * Fly the camera to focus on a specific component.
   * @param {string} name
   */
  focusComponent(name) {
    const entry = this.#components.get(name);
    if (!entry) return;

    const box = new THREE.Box3().setFromObject(entry.object);
    const center = new THREE.Vector3();
    const size   = new THREE.Vector3();
    box.getCenter(center);
    box.getSize(size);

    const dist = Math.max(size.length() * 2.5, 5);
    const dir  = new THREE.Vector3(1, 1, 1).normalize();
    this.#animateCamera(center.clone().addScaledVector(dir, dist), center, new THREE.Vector3(0, 1, 0), 500);
  }

  // ── public: display options ───────────────────────────────────────────────

  /**
   * Toggle wireframe rendering for all visible meshes.
   * @param {boolean} on
   */
  setWireframe(on) {
    if (!this.#model) return;
    this.#model.traverse((obj) => {
      if (!obj.isMesh) return;
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      mats.forEach(m => { m.wireframe = on; });
    });
  }

  /**
   * Show / hide the ground grid.
   * @param {boolean} visible
   */
  setGrid(visible) {
    if (this.#grid) this.#grid.visible = visible;
  }

  /**
   * Change the scene background colour.
   * @param {number|string} color  e.g. 0x1a1a2e or '#1a1a2e'
   */
  setBackground(color) {
    this.#scene.background = new THREE.Color(color);
    this.#scene.fog.color  = new THREE.Color(color);
  }

  /**
   * Explode components outward from the board centre.
   * @param {number} factor  0 = assembled, 1 = fully exploded
   */
  setExplode(factor) {
    if (!this.#model) return;
    this.#explodeFactor = Math.max(0, Math.min(1, factor));

    const boardDiag = this.#size.length();
    const maxDist   = boardDiag * 0.6 * this.#explodeFactor;

    for (const [, entry] of this.#components) {
      const obj = entry.object;
      const orig = entry.originalPosition;

      // Direction: away from board centre (XZ plane)
      const dir = new THREE.Vector3(orig.x, 0, orig.z).normalize();
      if (dir.lengthSq() < 0.001) dir.set(0, 1, 0);

      // Also push slightly up (Y) so components lift off the board
      dir.y = this.#explodeFactor * 0.5;
      dir.normalize();

      obj.position.copy(orig).addScaledVector(dir, maxDist);
    }
  }

  /**
   * Toggle ambient occlusion proxy (just an opacity darken on bottom faces).
   * @param {number} intensity  0–1
   */
  setAmbientIntensity(intensity) {
    this.#scene.children
      .filter(c => c.isAmbientLight)
      .forEach(l => { l.intensity = intensity; });
  }

  // ── public: measurement ───────────────────────────────────────────────────

  /**
   * Enter measurement mode. Next two clicks on the model place measurement points.
   */
  startMeasurement() {
    this.#measMode   = true;
    this.#measPoints = [];
    this.#emit('measurementStart', {});
  }

  /** Exit measurement mode without adding a measurement. */
  cancelMeasurement() {
    this.#measMode   = false;
    this.#measPoints = [];
    this.#emit('measurementCancel', {});
  }

  /** Remove all measurement lines from the scene. */
  clearMeasurements() {
    for (const obj of this.#measObjects) this.#scene.remove(obj);
    this.#measObjects = [];
    this.#measMode    = false;
    this.#measPoints  = [];
    this.#emit('measurementClear', {});
  }

  // ── public: rendering / export ────────────────────────────────────────────

  /**
   * Capture the current view as a PNG data URL.
   * @returns {string}
   */
  screenshot() {
    this.#renderer.render(this.#scene, this.#camera);
    return this.#renderer.domElement.toDataURL('image/png');
  }

  /**
   * Download a screenshot as a PNG file.
   * @param {string} filename
   */
  downloadScreenshot(filename = 'pcb-view.png') {
    const a = document.createElement('a');
    a.href     = this.screenshot();
    a.download = filename;
    a.click();
  }

  // ── public: events ────────────────────────────────────────────────────────

  /**
   * Register an event listener.
   *
   * Events:
   *   loadStart      {}
   *   loadProgress   { loaded, total }
   *   loadComplete   { layers, components }
   *   componentClick { name, info, point }
   *   componentHover { name, info }  — or { name: null } on mouse-out
   *   selectionChange { name, info }
   *   layerChange    { key, visible }
   *   measurementAdd { p1, p2, distance, unit }
   *   measurementStart {}
   *   measurementCancel {}
   *   measurementClear {}
   *
   * @param {string}   event
   * @param {Function} cb
   */
  on(event, cb) {
    if (!this.#handlers[event]) this.#handlers[event] = new Set();
    this.#handlers[event].add(cb);
    return () => this.#handlers[event].delete(cb);  // returns unsubscribe fn
  }

  /** Remove a previously registered listener. */
  off(event, cb) {
    this.#handlers[event]?.delete(cb);
  }

  /** Clean up everything — call when removing the viewer. */
  dispose() {
    cancelAnimationFrame(this.#rafId);
    window.removeEventListener('resize', this.#onResize.bind(this));
    this.#resizeObserver?.disconnect();
    this.#controls.dispose();
    this.#renderer.dispose();
    this.#container.removeChild(this.#renderer.domElement);
  }

  // ── internal: events ──────────────────────────────────────────────────────

  #emit(event, data) {
    if (!this.#handlers[event]) return;
    for (const cb of this.#handlers[event]) {
      try { cb(data); } catch (e) { console.error(e); }
    }
  }

  // ── internal: picking ─────────────────────────────────────────────────────

  #getPointerNDC(e) {
    const rect = this.#renderer.domElement.getBoundingClientRect();
    this.#pointer.set(
      ((e.clientX - rect.left) / rect.width)  * 2 - 1,
      -((e.clientY - rect.top)  / rect.height) * 2 + 1,
    );
  }

  #pickComponents(pointer) {
    if (!this.#model) return null;
    this.#raycaster.setFromCamera(pointer, this.#camera);

    const candidates = [];
    for (const [name, entry] of this.#components) {
      candidates.push(entry.object);
    }
    const hits = this.#raycaster.intersectObjects(candidates, true);
    if (!hits.length) return null;

    // Find the component entry that owns this hit
    let hitObj = hits[0].object;
    let name = null;
    while (hitObj) {
      name = [...this.#components.keys()].find(k => this.#components.get(k).object === hitObj);
      if (name) break;
      hitObj = hitObj.parent;
    }
    return name ? { name, point: hits[0].point } : null;
  }

  #onPointerMove(e) {
    this.#getPointerNDC(e);
    const hit = this.#pickComponents(this.#pointer);
    const name = hit?.name ?? null;

    if (name !== (this.#hovered?.name ?? null)) {
      this.#hovered = hit ? { name } : null;
      this.#renderer.domElement.style.cursor = hit ? 'pointer' : 'default';
      this.#emit('componentHover', hit
        ? { name, info: this.#components.get(name)?.info }
        : { name: null });
    }
  }

  #onClick(e) {
    this.#getPointerNDC(e);

    if (this.#measMode) {
      this.#handleMeasurementClick();
      return;
    }

    const hit = this.#pickComponents(this.#pointer);
    if (hit) {
      this.selectComponent(hit.name);
      this.#emit('componentClick', {
        name: hit.name,
        info: this.#components.get(hit.name)?.info,
        point: hit.point,
      });
    } else {
      this.#clearSelection();
      this.#emit('selectionChange', { name: null, info: null });
    }
  }

  // ── internal: measurement ─────────────────────────────────────────────────

  #handleMeasurementClick() {
    this.#raycaster.setFromCamera(this.#pointer, this.#camera);
    const hits = this.#raycaster.intersectObjects([this.#model], true);
    if (!hits.length) return;

    const pt = hits[0].point;
    this.#measPoints.push(pt.clone());

    // Place a small sphere marker
    const geo = new THREE.SphereGeometry(0.3, 8, 8);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffcc00 });
    const sphere = new THREE.Mesh(geo, mat);
    sphere.position.copy(pt);
    this.#scene.add(sphere);
    this.#measObjects.push(sphere);

    if (this.#measPoints.length === 2) {
      const [p1, p2] = this.#measPoints;
      const distance = p1.distanceTo(p2);

      // Draw line
      const pts = [p1, p2];
      const lineGeo = new THREE.BufferGeometry().setFromPoints(pts);
      const lineMat = new THREE.LineBasicMaterial({ color: 0xffcc00, linewidth: 2 });
      const line = new THREE.Line(lineGeo, lineMat);
      this.#scene.add(line);
      this.#measObjects.push(line);

      // Label (sprite)
      const mid = new THREE.Vector3().addVectors(p1, p2).multiplyScalar(0.5);
      const label = this.#makeMeasLabel(`${distance.toFixed(2)} mm`, mid);
      this.#measObjects.push(label);

      this.#measMode   = false;
      this.#measPoints = [];
      this.#emit('measurementAdd', { p1: p1.toArray(), p2: p2.toArray(), distance, unit: 'mm' });
    }
  }

  #makeMeasLabel(text, position) {
    const canvas  = document.createElement('canvas');
    canvas.width  = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.roundRect(0, 0, 256, 64, 8);
    ctx.fill();
    ctx.fillStyle = '#ffcc00';
    ctx.font      = 'bold 28px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 128, 32);

    const tex = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false });
    const spr = new THREE.Sprite(mat);
    spr.position.copy(position);
    spr.scale.set(8, 2, 1);
    this.#scene.add(spr);
    return spr;
  }

  // ── internal: highlight ───────────────────────────────────────────────────

  #applyHighlight(object, color) {
    object.traverse((obj) => {
      if (!obj.isMesh) return;
      const orig = this.#originalMaterials.get(obj);
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      mats.forEach((m) => {
        m.emissive = new THREE.Color(color);
        m.emissiveIntensity = 0.35;
      });
    });
  }

  #clearSelection() {
    if (this.#selected) {
      this.#selected.traverse((obj) => {
        if (!obj.isMesh) return;
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach((m) => {
          m.emissive?.set(0, 0, 0);
          m.emissiveIntensity = 0;
        });
      });
      this.#selected = null;
    }
    if (this.#selectionBox) {
      this.#scene.remove(this.#selectionBox);
      this.#selectionBox = null;
    }
  }

  // ── internal: camera animation ────────────────────────────────────────────

  #animateCamera(targetPos, targetLookAt, up, duration) {
    const startPos    = this.#camera.position.clone();
    const startLookAt = this.#controls.target.clone();
    const startUp     = this.#camera.up.clone();
    const startTime   = performance.now();

    this.#camAnim = { startPos, startLookAt, startUp, targetPos, targetLookAt, up, startTime, duration };
  }

  #stepCamAnim() {
    if (!this.#camAnim) return;
    const { startPos, startLookAt, startUp, targetPos, targetLookAt, up, startTime, duration } = this.#camAnim;

    const elapsed = performance.now() - startTime;
    const t = Math.min(elapsed / duration, 1);
    const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; // easeInOutQuad

    this.#camera.position.lerpVectors(startPos, targetPos, ease);
    this.#controls.target.lerpVectors(startLookAt, targetLookAt, ease);
    this.#camera.up.lerpVectors(startUp, up, ease);
    this.#controls.update();

    if (t >= 1) this.#camAnim = null;
  }

  // ── internal: grid ────────────────────────────────────────────────────────

  #createGrid(size = 200, divisions = 40) {
    this.#grid = new THREE.GridHelper(size, divisions, this.#opts.gridColor, this.#opts.gridColor);
    this.#grid.material.opacity    = 0.25;
    this.#grid.material.transparent = true;
    this.#scene.add(this.#grid);
  }

  // ── internal: resize ──────────────────────────────────────────────────────

  #onResize() {
    const w = this.#container.clientWidth;
    const h = this.#container.clientHeight;
    if (w === 0 || h === 0) return; // container not visible yet — skip
    this.#camera.aspect = w / h;
    this.#camera.updateProjectionMatrix();
    this.#renderer.setSize(w, h);
  }
}
