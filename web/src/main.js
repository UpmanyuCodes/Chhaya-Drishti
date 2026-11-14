import '@fontsource-variable/space-grotesk';
import '@fontsource-variable/jetbrains-mono';
import './style.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { loadAll, makeGeo, fmtLat, fmtLon } from './data.js';
import { Terrain } from './terrain.js';
import { Globe, makeStars } from './globe.js';
import { Markers, Route, pathProfile, ProfileChart } from './overlays.js';
import { LAYERS, cssGradient, colorAt } from './colormaps.js';
import { animate, ease, tickTweens, lerp } from './tween.js';
import { aboutHtml } from './about.js';

const $ = (s) => document.querySelector(s);
const nf = (v, d = 0) => Number(v).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LUNAR_DAY = 29.53;
const SUN_DEC_MAX = 1.543;
const ICE_TARGET = 0.85;

const S = {
  view: 'orbit', stage: 0, busy: true, layer: 'relief',
  exag: 3, contours: false, graticule: false, labels: true, curvature: true,
  psr: true, psrRef: false, sunDay: 4.0, sunDec: -SUN_DEC_MAX, playing: false, iceThresh: 0,
  tool: null, picks: [], maxSlope: 15, wDark: 1.5, site: null, profile: null, lastReq: null,
  rover: { playing: false, frac: 0 },
};

let renderer, data, meta, geo, terrain, globe, scene, camera, controls, markers, route, worker, chart;
let stats, dirty = true, camTween = null, planId = 0, sliderActive = false;
const pointer = { x: 0, y: 0, inside: false, moved: false, down: null };
const ray = new THREE.Raycaster();

// =====================================================================================
// boot
// =====================================================================================
async function boot() {
  const canvas = $('#gl');
  const t0 = performance.now(), lap = (m) => import.meta.env.DEV && console.info(`[boot] ${m} ${(performance.now() - t0).toFixed(0)} ms`);
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    if (!renderer.capabilities.isWebGL2) throw new Error('WebGL 2 unavailable');
  } catch (err) {
    $('#loader-msg').textContent = 'This site needs WebGL 2 — please use a recent Chrome, Edge or Firefox.';
    throw err;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.setClearColor(0x04050a, 1);

  try {
    data = await loadAll((p) => {
      $('#loader-bar').style.width = `${(p * 100).toFixed(1)}%`;
      $('#loader-pct').textContent = Math.round(p * 100);
    });
  } catch (err) {
    $('#loader-msg').textContent = `Could not load the data files (${err.message}).`;
    throw err;
  }
  lap('data loaded');
  $('#loader-msg').textContent = 'Building terrain…';
  await sleep(30);

  meta = data.meta;
  geo = makeGeo(meta);
  stats = computeStats();

  terrain = new Terrain({ renderer, data, geo, ...quality() });
  lap('terrain built');
  globe = new Globe({ renderer, data, geo, dom: canvas });

  scene = new THREE.Scene();
  scene.add(terrain.mesh, makeStars(5000, 3200));
  camera = new THREE.PerspectiveCamera(36, 1, 1, 14000);
  camera.position.set(0, 760, 2);
  controls = new OrbitControls(camera, canvas);
  Object.assign(controls, {
    enableDamping: true, dampingFactor: 0.08, maxPolarAngle: Math.PI * 0.47,
    minDistance: 5, maxDistance: 1100, zoomToCursor: true, screenSpacePanning: false,
    rotateSpeed: 0.55, zoomSpeed: 0.9, enabled: false,
  });
  controls.addEventListener('start', () => { camTween?.cancel(); camTween = null; });

  markers = new Markers($('#markers'));
  route = new Route(scene, terrain);
  buildMarkers();

  worker = new Worker(new URL('./planner.worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = onPlannerMessage;
  worker.postMessage({
    type: 'init', n: data.n, cell: geo.cell,
    slope: data.grids.slope, sun: data.grids.sun, ice: data.grids.ice,
  });

  buildHero();
  $('#about-body').innerHTML = aboutHtml(meta);
  bindUi();
  onResize();
  window.addEventListener('resize', onResize);

  globe.reset();
  setView('orbit');
  renderer.compile(scene, camera);
  lap('ready');
  S.busy = false;
  if (import.meta.env.DEV) window.__cd = { S, terrain, globe, camera, controls, route, markers, renderer, goStage, selectSite, meta };
  $('#loader').classList.add('done');
  document.body.classList.add('ready');
  requestAnimationFrame((t) => { last = t; frame(t); });
}

/** Mesh density / shadow resolution by GPU class; override with ?q=low|high. */
function quality() {
  const gl = renderer.getContext();
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const gpu = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
  const q = new URLSearchParams(location.search).get('q');
  const integrated = /Intel|Mali|Adreno|PowerVR|SwiftShader|llvmpipe|Microsoft Basic/i.test(gpu) || window.innerWidth < 800;
  const low = q ? q === 'low' : integrated;
  return low ? { segments: 512, fastShadow: 768 } : { segments: 1024, fastShadow: 1024 };
}

function computeStats() {
  const g = data.grids, nn = g.slope.length;
  const slopeHist = new Float64Array(256), iceHist = new Float64Array(256);
  for (let i = 0; i < nn; i++) { slopeHist[g.slope[i]]++; iceHist[g.ice[i]]++; }
  const cellKm2 = (meta.grid.cell_m / 1000) ** 2;
  const slopeCum = new Float64Array(257);
  for (let i = 0; i < 256; i++) slopeCum[i + 1] = slopeCum[i] + slopeHist[i];
  const iceAbove = new Float64Array(257);       // area with ice index >= k/255
  for (let i = 255; i >= 0; i--) iceAbove[i] = iceAbove[i + 1] + iceHist[i] * cellKm2;
  const below = (deg) => slopeCum[Math.min(256, Math.floor((deg * 255) / 50) + 1)] / nn;
  const bins = [];
  for (let d = 0; d < 40; d += 2.5) bins.push({ d, f: below(d + 2.5) - below(d) });
  return { below, bins, iceAbove, nn };
}

// =====================================================================================
// markers
// =====================================================================================
function buildMarkers() {
  for (const l of globe.labels) {
    const it = markers.add({
      group: 'globe', cls: `glabel ${l.kind}`, pos: new THREE.Vector3(),
      html: `<i></i><span><b>${l.text}</b><small>${l.sub}</small></span>`,
    });
    it.local = l.pos;
  }
  for (const f of meta.features) {
    markers.add({
      group: 'feature', cls: `flabel ${f.kind}`, xz: geo.rcToWorld(f.row, f.col), lift: 1.2,
      range: f.name === 'Shackleton' ? 2000 : 330 + f.diam_km * 9, html: `<span>${f.name}</span>`,
    });
  }
  for (const p of meta.pois) {
    markers.add({
      group: 'poi', cls: 'poi', xz: geo.rcToWorld(p.row, p.col), lift: 0.6, title: p.note,
      html: `<i></i><span><b>${p.name}</b><small>${p.note}</small></span>`,
    });
  }
  meta.psrs.slice(0, 8).forEach((p, i) => {
    markers.add({
      group: 'psr', cls: 'psr-pin', xz: geo.rcToWorld(p.row, p.col), lift: 0.8,
      html: `<i>❄</i><span><b>${psrName(p)}</b><small>${nf(p.area_km2)} km² · ${nf(p.tmax_min)} K</small></span>`,
      onClick: () => flyToPoint(...geo.rcToWorld(p.row, p.col), 28 + Math.sqrt(p.area_km2) * 2.2),
    });
  });
  for (const s of meta.landing.sites) {
    s.marker = markers.add({
      group: 'site', cls: 'site-pin', xz: geo.rcToWorld(s.row, s.col), lift: 0.4,
      html: `<i>${s.id}</i><span>${s.name}</span>`, onClick: () => selectSite(s),
    });
  }
}

const psrName = (p) => (p.inside ? `${p.near} floor` : `Near ${p.near}`);

function syncMarkerGroups() {
  const t = S.view === 'terrain';
  markers.setGroupVisible('globe', !t);
  markers.setGroupVisible('feature', t && S.labels);
  markers.setGroupVisible('poi', t && S.stage >= 2);
  markers.setGroupVisible('psr', t && S.stage === 2);
  markers.setGroupVisible('site', t && S.stage === 3);
  for (const g of ['route', 'pick', 'rover']) markers.setGroupVisible(g, t);
  dirty = true;
}

// =====================================================================================
// views & stages
// =====================================================================================
const VIEWS = {
  1: { pos: [-40, 290, 400], tgt: [0, 0, 5] },
  2: { pos: [-75, 120, 140], tgt: [8, 0, -18] },
  3: { pos: [-30, 235, 70], tgt: [-18, 0, -112] },
};
const STAGE_LAYER = { 1: 'relief', 2: 'live', 3: 'landing' };

function setVeil(on) {
  $('#veil').classList.toggle('on', on);
  return sleep(520);
}

function setView(view) {
  S.view = view;
  document.body.dataset.view = view;
  globe.controls.enabled = view === 'orbit';
  controls.enabled = view === 'terrain';
  if (view === 'orbit') { S.stage = 0; document.body.dataset.stage = 0; }
  syncNav();
  syncMarkerGroups();
}

function syncNav() {
  document.querySelectorAll('#stages button').forEach((b) =>
    b.classList.toggle('on', Number(b.dataset.stage) === S.stage));
}

async function goStage(n) {
  if (S.busy || n === S.stage) return;
  if (n === 0) {
    S.busy = true;
    stopPlayback();
    await setVeil(true);
    globe.reset();
    setView('orbit');
    $('#tip').classList.remove('on');
    await setVeil(false);
    S.busy = false;
  } else if (S.view === 'orbit') {
    S.busy = true;
    document.body.dataset.view = 'dive';
    globe.flyToPole(async () => {
      await setVeil(true);
      setView('terrain');
      camera.position.set(0, 760, 2);
      controls.target.set(0, 0, 0);
      controls.update();
      applyStage(n, 3.0);
      await setVeil(false);
      S.busy = false;
    });
  } else {
    applyStage(n, 1.7);
  }
}

function applyStage(n, flyDur) {
  stopPlayback();
  S.stage = n;
  document.body.dataset.stage = n;
  S.tool = null; S.picks = []; S.site = null; S.profile = null; S.lastReq = null;
  route.clear();
  markers.clear('route'); markers.clear('pick'); markers.clear('rover');
  for (const s of meta.landing.sites) s.marker.el.classList.remove('sel');
  terrain.tween('uPsr', n === 2 ? (S.psr ? 1 : 0) : n === 3 ? 0.5 : 0);
  terrain.tween('uPsrRef', n === 2 && S.psrRef ? 1 : 0);
  terrain.u.uIceThresh.value = n === 2 ? S.iceThresh : 0;
  syncNav();
  renderPanels();
  setLayer(STAGE_LAYER[n]);
  syncMarkerGroups();
  const v = VIEWS[n];
  flyTo(v.pos, v.tgt, flyDur);
}

function flyTo(pos, tgt, dur = 1.6) {
  camTween?.cancel();
  const p0 = camera.position.clone(), t0 = controls.target.clone();
  const p1 = new THREE.Vector3(...pos), t1 = new THREE.Vector3(...tgt);
  t1.y = terrain.surfaceY(t1.x, t1.z);
  camTween = animate({
    dur, ease: ease.inOut,
    update: (k) => {
      camera.position.lerpVectors(p0, p1, k);
      controls.target.lerpVectors(t0, t1, k);
      dirty = true;
    },
    done: () => { camTween = null; },
  });
}

function flyToPoint(x, z, dist = 60) {
  const d = new THREE.Vector3().subVectors(camera.position, controls.target);
  d.y = 0;
  if (d.lengthSq() < 1e-6) d.set(0, 0, 1);
  d.normalize();
  const y = terrain.surfaceY(x, z);
  flyTo([x + d.x * dist * 0.72, y + dist * 0.66, z + d.z * dist * 0.72], [x, y, z], 1.5);
}

// =====================================================================================
// layers
// =====================================================================================
const LAYER_INFO = {
  relief: 'Shaded relief from the 80 m LOLA elevation model, lit from the upper left so every crater reads clearly.',
  live: 'Physically based sunlight. Shadows are ray-traced on your GPU from the elevation model, with the Moon’s curvature and the finite size of the solar disc.',
  hazard: 'Slope with everything steeper than the rover limit hatched in red.',
  elevation: 'Height above the 1,737.4 km reference sphere.',
  slope: 'Mean slope of each 240 m cell, measured over an 80 m baseline.',
  hillshade: 'Classic cartographic hillshade: Sun at azimuth 315°, altitude 45°.',
  sunlight: 'Share of time the Sun is visible, averaged over the lunar day and the seasons (horizon-method model).',
  tmax: 'Annual maximum surface temperature from LRO Diviner. Below 110 K (the blues) water ice is stable for billions of years.',
  icedepth: 'Depth at which ice becomes thermally stable (Diviner model). White = stable right at the surface.',
  ice: 'Favourability index combining temperature (45 %), subsurface stability (30 %) and permanent shadow (25 %).',
  landing: 'Score for flat, sunlit, Earth-visible ground close to ice. Uncoloured areas fail a hard safety rule.',
  earth: 'Share of time Earth is above the local horizon — needed for a direct radio link.',
};

function setLayer(key) {
  S.layer = key;
  const id = key === 'hazard' ? 2 : (LAYERS[key]?.id ?? 0);
  terrain.setLayer(id);
  terrain.tween('uStudio', S.stage === 2 ? 0 : 1, 0.8);
  terrain.u.uSlopeLimit.value = key === 'hazard' ? S.maxSlope : 0;
  document.querySelectorAll('[data-layer]').forEach((b) => b.classList.toggle('on', b.dataset.layer === key));
  const L = LAYERS[key === 'hazard' ? 'slope' : key];
  const el = $('#legend');
  if (el) {
    let html = '';
    if (L?.stops) {
      const ticks = L.ticks.map((t, i) => {
        const p = L.tickPos ? L.tickPos[i] : i / (L.ticks.length - 1);
        return `<span style="left:${p * 100}%">${t}</span>`;
      }).join('');
      html += `<div class="ramp" style="background:${cssGradient(L)}"></div><div class="ticks">${ticks}</div>`;
    }
    html += `<p>${LAYER_INFO[key] || ''}</p>`;
    el.innerHTML = html;
  }
  dirty = true;
}

// =====================================================================================
// panels
// =====================================================================================
const chip = (key, label) => `<button class="chip" data-layer="${key}">${label}</button>`;
const slider = (bind, label, min, max, step, value, out) => `
  <label class="slider"><span>${label}<output data-out="${bind}">${out}</output></span>
  <input type="range" data-bind="${bind}" min="${min}" max="${max}" step="${step}" value="${value}"></label>`;
const toggle = (bind, label, on) => `
  <label class="toggle"><input type="checkbox" data-bind="${bind}" ${on ? 'checked' : ''}><i></i><span>${label}</span></label>`;
const stat = (value, label, cls = '') => `<div class="stat ${cls}"><b>${value}</b><small>${label}</small></div>`;

function renderPanels() {
  renderLeft();
  renderRight();
  renderDock();
}

function renderLeft() {
  const el = $('#left');
  if (S.stage === 1) {
    el.innerHTML = `
      <p class="eyebrow">Stage 01</p><h2>Terrain</h2>
      <p class="desc">${nf(meta.terrain.area_km2)} km² around the pole, measured by the LOLA laser altimeter. The relief spans ${meta.terrain.relief_km} km — more than Everest above sea level.</p>
      <div class="chips">${chip('relief', 'Relief')}${chip('elevation', 'Elevation')}${chip('slope', 'Slope')}${chip('hillshade', 'Hillshade')}</div>
      <div class="legend" id="legend"></div>
      ${slider('exag', 'Vertical exaggeration', 1, 8, 0.5, S.exag, `${S.exag.toFixed(1)}×`)}
      <div class="toggles">
        ${toggle('contours', 'Contours · 500 m', S.contours)}
        ${toggle('graticule', 'Lat / lon grid', S.graticule)}
        ${toggle('labels', 'Feature names', S.labels)}
        ${toggle('curvature', 'Moon curvature', S.curvature)}
      </div>
      <button class="tool" data-tool="profile"><b>Draw a cross-section</b><small>Click two points on the terrain</small></button>`;
  } else if (S.stage === 2) {
    el.innerHTML = `
      <p class="eyebrow">Stage 02</p><h2>Shadow &amp; Ice</h2>
      <p class="desc">The Sun never climbs more than ~1.5° above the polar horizon, so crater floors stay dark forever. Where it is dark and cold enough, ice survives.</p>
      <div class="chips">${chip('live', 'Live sunlight')}${chip('sunlight', 'Avg sunlight')}${chip('tmax', 'Temperature')}${chip('icedepth', 'Ice depth')}${chip('ice', 'Ice potential')}</div>
      <div class="legend" id="legend"></div>
      <div class="toggles">
        ${toggle('psr', 'Permanent shadow — this model', S.psr)}
        ${toggle('psrRef', 'NASA reference outline', S.psrRef)}
        ${toggle('labels', 'Feature names', S.labels)}
      </div>
      ${slider('iceThresh', 'Highlight ice index ≥', 0, 0.95, 0.05, S.iceThresh, iceOut())}`;
  } else if (S.stage === 3) {
    const sites = meta.landing.sites.map((s) => `
      <button class="site" data-site="${s.id}">
        <i>${s.id}</i><span><b>${s.name}</b><small>${fmtLat(s.lat)} ${fmtLon(s.lon)} · ice ${s.ice_dist_km} km</small></span>
        <em>${Math.round(s.score * 100)}</em>
      </button>`).join('');
    el.innerHTML = `
      <p class="eyebrow">Stage 03</p><h2>Landing &amp; Rover</h2>
      <p class="desc">Sites are ranked for safety, solar power, Earth contact and distance to ice. Pick one to plan the drive.</p>
      <div class="chips">${chip('landing', 'Suitability')}${chip('earth', 'Earth view')}${chip('hazard', 'Slope hazard')}${chip('ice', 'Ice')}${chip('relief', 'Relief')}</div>
      <div class="legend" id="legend"></div>
      <h3>Candidate landing sites</h3>
      <div class="sites">${sites}</div>
      <h3>Route planner</h3>
      <div class="tools">
        <button class="tool" data-tool="ice"><b>To nearest ice</b><small>Click a start point</small></button>
        <button class="tool" data-tool="p2p"><b>A → B</b><small>Click start, then goal</small></button>
      </div>
      ${slider('maxSlope', 'Rover slope limit', 5, 25, 1, S.maxSlope, slopeOut())}
      ${slider('wDark', 'Shadow avoidance', 0, 4, 0.25, S.wDark, `${S.wDark.toFixed(2)}×`)}`;
  } else {
    el.innerHTML = '';
  }
}

const iceOut = () => (S.iceThresh > 0
  ? `${S.iceThresh.toFixed(2)} · ${nf(stats.iceAbove[Math.round(S.iceThresh * 255)])} km²` : 'off');
const slopeOut = () => `${S.maxSlope}° · ${Math.round(stats.below(S.maxSlope) * 100)} % drivable`;

function renderRight() {
  const el = $('#right');
  const t = meta.terrain, il = meta.illumination, ic = meta.ice;
  if (S.stage === 1) {
    const max = Math.max(...stats.bins.map((b) => b.f));
    const bars = stats.bins.map((b) => `<i style="height:${Math.max(2, (b.f / max) * 100)}%;background:${colorAt(LAYERS.slope, (b.d + 1.25) / 40)}" title="${b.d}–${b.d + 2.5}°: ${(b.f * 100).toFixed(1)} %"></i>`).join('');
    const feats = meta.features.map((f, i) => `<button class="tag" data-feature="${i}">${f.name}</button>`).join('');
    el.innerHTML = `
      <h3>Terrain statistics</h3>
      <div class="stats">
        ${stat(`${t.relief_km} km`, 'total relief')}
        ${stat(`${t.slope_mean_deg}°`, 'mean slope')}
        ${stat(`${nf(t.elev_min_m)} m`, 'lowest point')}
        ${stat(`+${nf(t.elev_max_m)} m`, 'highest point')}
      </div>
      <h3>Slope distribution</h3>
      <div class="hist">${bars}</div>
      <div class="hist-axis"><span>0°</span><span>10°</span><span>20°</span><span>30°</span><span>40°</span></div>
      <p class="note"><b>${Math.round(stats.below(5) * 100)} %</b> of the ground is gentler than 5°, <b>${Math.round(stats.below(10) * 100)} %</b> gentler than 10°, <b>${Math.round(stats.below(15) * 100)} %</b> gentler than 15°.</p>
      <h3>Fly to</h3>
      <div class="tags">${feats}</div>`;
  } else if (S.stage === 2) {
    const list = meta.psrs.slice(0, 8).map((p, i) => `
      <button class="row" data-psr="${i}"><span>${psrName(p)}</span><b>${nf(p.area_km2)} km²</b><em>${nf(p.tmax_min)} K</em></button>`).join('');
    const w = ic.weights;
    el.innerHTML = `
      <h3>Permanent shadow</h3>
      <div class="stats">
        ${stat(`${nf(il.psr_area_km2)} km²`, 'never sunlit', 'ice')}
        ${stat(`${(100 * il.psr_area_km2 / t.area_km2).toFixed(1)} %`, 'of the study area')}
        ${stat(`${nf(ic.cold_trap_area_km2)} km²`, 'cold traps < 110 K', 'ice')}
        ${stat(`${nf(ic.tmin_K, 1)} K`, 'coldest surface')}
      </div>
      <div class="verify">
        <b>Validated against NASA</b>
        <p>Our horizon-method shadow map matches the published LOLA PSR product on <strong>${il.psr_agreement_pct} %</strong> of cells (IoU ${il.psr_iou}). Average sunlight correlates at r = ${il.sunlight_r}.</p>
      </div>
      <h3>Largest shadowed regions</h3>
      <div class="rows"><div class="row head"><span>Region</span><b>Area</b><em>Coldest</em></div>${list}</div>
      <h3>Ice potential index</h3>
      <div class="weights">
        <div><i style="width:${w.temperature * 100}%"></i><span>Temperature</span><b>${w.temperature * 100} %</b></div>
        <div><i style="width:${w.depth * 100}%"></i><span>Subsurface stability</span><b>${w.depth * 100} %</b></div>
        <div><i style="width:${w.shadow * 100}%"></i><span>Permanent shadow</span><b>${w.shadow * 100} %</b></div>
      </div>
      <p class="note">A favourability map — where ice can persist — not a direct detection.</p>`;
  } else if (S.stage === 3) {
    el.innerHTML = siteHtml() + routeHtml();
  } else {
    el.innerHTML = '';
  }
}

function siteHtml() {
  const s = S.site;
  if (!s) {
    const w = meta.landing.weights;
    return `
      <h3>How sites are scored</h3>
      <div class="weights amber">
        <div><i style="width:${w.safety * 100}%"></i><span>Safety · gentle slopes</span><b>${w.safety * 100} %</b></div>
        <div><i style="width:${w.science * 100}%"></i><span>Science · distance to ice</span><b>${w.science * 100} %</b></div>
        <div><i style="width:${w.power * 100}%"></i><span>Power · sunlight</span><b>${w.power * 100} %</b></div>
        <div><i style="width:${w.comms * 100}%"></i><span>Comms · Earth in view</span><b>${w.comms * 100} %</b></div>
      </div>
      <p class="note">Only ${meta.landing.eligible_pct} % of the study area passes the hard rules: within 6° of the pole, never in permanent shadow, at least 25 % sunlight, and 85 % of a 500 m footprint under 10° slope.</p>
      <p class="note">Select a numbered site, or use the route planner and click anywhere on the terrain.</p>`;
  }
  const bar = (label, v) => `<div><i style="width:${v * 100}%"></i><span>${label}</span><b>${Math.round(v * 100)}</b></div>`;
  return `
    <p class="eyebrow">Landing site ${s.id}</p>
    <div class="site-head"><h2>${s.name}</h2><div class="score"><b>${Math.round(s.score * 100)}</b><small>/100</small></div></div>
    <p class="coords">${fmtLat(s.lat)} · ${fmtLon(s.lon)} · ${nf(s.elev_m)} m</p>
    <div class="weights amber">${bar('Safety', s.safety)}${bar('Science', s.science)}${bar('Power', s.power)}${bar('Comms', s.comms)}</div>
    <div class="stats">
      ${stat(`${s.slope_max_deg}°`, 'steepest 80 m facet')}
      ${stat(`${Math.round(s.sunlight * 100)} %`, 'average sunlight')}
      ${stat(`${Math.round(s.earth_vis * 100)} %`, 'Earth visibility')}
      ${stat(`${s.ice_dist_km} km`, 'to nearest ice', 'ice')}
    </div>`;
}

function routeHtml() {
  const p = S.profile;
  if (!p || S.stage !== 3) return '';
  const e = p.end;
  return `
    <h3>Rover traverse</h3>
    <div class="stats">
      ${stat(`${p.lengthKm.toFixed(1)} km`, 'drive distance')}
      ${stat(`${p.hours < 48 ? `${p.hours.toFixed(0)} h` : `${(p.hours / 24).toFixed(1)} d`}`, 'driving at 10 cm/s')}
      ${stat(`${p.maxSlope.toFixed(1)}°`, 'steepest cell')}
      ${stat(p.ascent + p.descent > 9000
    ? `+${(p.ascent / 1000).toFixed(1)} / −${(p.descent / 1000).toFixed(1)} km`
    : `+${nf(p.ascent)} / −${nf(p.descent)} m`, 'climb / descent')}
      ${stat(`${p.psrKm.toFixed(1)} km`, 'inside permanent shadow', 'ice')}
      ${stat(`${nf(e.tmax)} K`, `at goal · ice index ${e.ice.toFixed(2)}`, 'ice')}
    </div>`;
}

function renderDock() {
  const el = $('#dock');
  chart = null;
  if (S.stage === 2) {
    el.className = 'panel sun';
    el.innerHTML = `
      <button id="play" class="play" aria-label="Play">${playIcon(S.playing)}</button>
      <div class="sun-main">
        <label class="slider"><span>Lunar day<output data-out="sunDay"></output></span>
        <input type="range" data-bind="sunDay" min="0" max="${LUNAR_DAY}" step="0.01" value="${S.sunDay}"></label>
      </div>
      <div class="sun-side">
        <label class="slider"><span>Season<output data-out="sunDec"></output></span>
        <input type="range" data-bind="sunDec" min="${-SUN_DEC_MAX}" max="${SUN_DEC_MAX}" step="0.01" value="${S.sunDec}"></label>
      </div>`;
    sunReadout();
  } else if (S.profile && (S.stage === 1 || S.stage === 3)) {
    const p = S.profile, rover = S.stage === 3;
    el.className = 'panel profile';
    el.innerHTML = `
      <div class="dock-head">
        ${rover ? `<button id="play" class="play" aria-label="Drive">${playIcon(S.rover.playing)}</button>` : ''}
        <div><b>${rover ? 'Traverse profile' : 'Cross-section'}</b>
        <small>${p.lengthKm.toFixed(1)} km · max slope ${p.maxSlope.toFixed(1)}° · <i class="key"></i> permanent shadow</small></div>
        <button class="ghost small" data-act="clear-route">Clear</button>
      </div>
      <canvas id="profile"></canvas>`;
    chart = new ProfileChart($('#profile'), (f) => { if (!S.rover.playing) setRover(f); });
    chart.set(p);
  } else {
    el.className = 'panel hidden';
    el.innerHTML = '';
  }
}

const playIcon = (on) => (on
  ? '<svg viewBox="0 0 24 24"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>'
  : '<svg viewBox="0 0 24 24"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l11-6.5a1 1 0 0 0 0-1.72l-11-6.5A1 1 0 0 0 8 5.5z"/></svg>');

function sunReadout() {
  const d = document.querySelector('[data-out="sunDay"]'), s = document.querySelector('[data-out="sunDec"]');
  if (!d || !s) return;
  d.textContent = `day ${S.sunDay.toFixed(1)} of ${LUNAR_DAY}`;
  const e = -S.sunDec;
  s.textContent = `${e > 0.5 ? 'summer' : e < -0.5 ? 'winter' : 'equinox'} · Sun ${e >= 0 ? '+' : '−'}${Math.abs(e).toFixed(2)}° at pole`;
  const inp = document.querySelector('[data-bind="sunDay"]');
  if (inp && S.playing) inp.value = S.sunDay;
}

// =====================================================================================
// sun, rover
// =====================================================================================
function applySun() {
  // the sub-solar point drifts westward: one full turn per synodic month
  terrain.setSun(-(S.sunDay / LUNAR_DAY) * 360, S.sunDec);
  sunReadout();
  dirty = true;
}

function stopPlayback() {
  S.playing = false;
  S.rover.playing = false;
}

function togglePlay() {
  if (S.stage === 2) {
    S.playing = !S.playing;
    if (S.playing && S.layer !== 'live') setLayer('live');
  } else if (S.stage === 3 && route.active) {
    S.rover.playing = !S.rover.playing;
    if (S.rover.playing && S.rover.frac >= 1) S.rover.frac = 0;
  }
  const b = $('#play');
  if (b) b.innerHTML = playIcon(S.playing || S.rover.playing);
  dirty = true;
}

function setRover(frac) {
  markers.clear('rover');
  chart?.setCursor(frac);
  if (frac != null && route.active) {
    S.rover.frac = frac;
    markers.add({ group: 'rover', cls: 'rover', xz: route.pointAt(frac), lift: 0.25, html: '<i></i>' });
  }
  dirty = true;
}

// =====================================================================================
// route planning & tools
// =====================================================================================
function setTool(tool) {
  S.tool = S.tool === tool ? null : tool;
  S.picks = [];
  markers.clear('pick');
  document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === S.tool));
  document.body.classList.toggle('picking', !!S.tool);
  if (S.tool) toast({ profile: 'Click the first point of the section', ice: 'Click where the rover starts', p2p: 'Click the start point' }[S.tool]);
}

function onTerrainClick(hit) {
  if (!S.tool) return;
  const s = terrain.sample(hit.x, hit.z);
  S.picks.push({ x: hit.x, z: hit.z, row: s.row, col: s.col });
  const label = S.tool === 'ice' ? 'A' : 'AB'[S.picks.length - 1];
  if (S.picks.length === 1) markers.clear('pick');
  markers.add({ group: 'pick', cls: 'pick', xz: [hit.x, hit.z], lift: 0.3, html: `<i>${label}</i>` });
  dirty = true;

  if (S.tool === 'ice') {
    deselectSite();
    plan({ mode: 'ice', start: [s.row, s.col] });
    S.picks = [];
  } else if (S.picks.length === 2) {
    const [a, b] = S.picks;
    S.picks = [];
    if (S.tool === 'p2p') {
      deselectSite();
      plan({ mode: 'p2p', start: [a.row, a.col], goal: [b.row, b.col] });
    } else {
      const pts = [];
      for (let i = 0; i <= 240; i++) pts.push([lerp(a.x, b.x, i / 240), lerp(a.z, b.z, i / 240)]);
      route.set(pts, false);
      S.profile = pathProfile(pts, terrain);
      renderDock();
      setTool(null);
      $('#toast').classList.remove('on');
      markers.add({ group: 'pick', cls: 'pick', xz: [a.x, a.z], lift: 0.3, html: '<i>A</i>' });
      markers.add({ group: 'pick', cls: 'pick', xz: [b.x, b.z], lift: 0.3, html: '<i>B</i>' });
    }
  } else {
    toast(S.tool === 'profile' ? 'Now click the end point' : 'Now click the goal');
  }
}

function plan(req) {
  S.lastReq = req;
  worker.postMessage({ type: 'plan', id: ++planId, ...req, maxSlope: S.maxSlope, wDark: S.wDark, iceThresh: ICE_TARGET });
}

function onPlannerMessage(e) {
  const m = e.data;
  if (m.type !== 'result' || m.id !== planId) return;
  S.rover.playing = false;
  S.rover.frac = 0;
  markers.clear('rover'); markers.clear('route');
  if (!m.found) {
    route.clear();
    S.profile = null;
    toast(m.reason === 'goal-steep'
      ? `No drivable ground near that goal at a ${S.maxSlope}° limit`
      : `No route within the ${S.maxSlope}° slope limit — raise the limit or move the start`);
  } else {
    const n = data.n, raw = [];
    for (const k of m.path) raw.push(geo.rcToWorld((k / n) | 0, k % n));
    if (raw.length < 2) raw.push([raw[0][0] + 0.01, raw[0][1]]);
    route.set(raw);
    S.profile = pathProfile(raw, terrain);
    const end = raw[raw.length - 1];
    markers.add({
      group: 'route', cls: 'goal', xz: end, lift: 0.3,
      html: `<i>${S.lastReq.mode === 'ice' ? '❄' : 'B'}</i><span>${S.lastReq.mode === 'ice' ? 'Ice target' : 'Goal'} · ${S.profile.lengthKm.toFixed(1)} km</span>`,
    });
    if (S.tool) setTool(null);
    if (m.snapped) toast('Goal moved to the nearest ground the rover can drive on');
    else $('#toast').classList.remove('on');
  }
  renderRight();
  renderDock();
  syncMarkerGroups();
}

function selectSite(s) {
  if (S.stage !== 3) return;
  deselectSite();
  S.site = s;
  s.marker.el.classList.add('sel');
  document.querySelectorAll('[data-site]').forEach((b) => b.classList.toggle('on', Number(b.dataset.site) === s.id));
  markers.clear('pick');
  const [x, z] = geo.rcToWorld(s.row, s.col);
  flyToPoint(x, z, 46);
  renderRight();
  plan({ mode: 'ice', start: [s.row, s.col] });
}

function deselectSite() {
  if (!S.site) return;
  S.site.marker.el.classList.remove('sel');
  S.site = null;
  document.querySelectorAll('[data-site]').forEach((b) => b.classList.remove('on'));
}

function clearRoute() {
  route.clear();
  S.profile = null; S.lastReq = null; S.rover.playing = false;
  markers.clear('route'); markers.clear('pick'); markers.clear('rover');
  deselectSite();
  renderRight();
  renderDock();
  dirty = true;
}

// =====================================================================================
// UI wiring
// =====================================================================================
let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), 3200);
}

let replanTimer;
const BINDINGS = {
  exag: (v) => {
    S.exag = v; terrain.u.uExag.value = v; route.refresh();
    return `${v.toFixed(1)}×`;
  },
  contours: (v) => { S.contours = v; terrain.tween('uContours', v ? 1 : 0, 0.3); },
  graticule: (v) => { S.graticule = v; terrain.tween('uGraticule', v ? 1 : 0, 0.3); },
  curvature: (v) => { S.curvature = v; terrain.tween('uCurv', v ? 1 : 0, 0.8); setTimeout(() => route.refresh(), 850); },
  labels: (v) => { S.labels = v; syncMarkerGroups(); },
  psr: (v) => { S.psr = v; terrain.tween('uPsr', v ? 1 : 0, 0.3); },
  psrRef: (v) => { S.psrRef = v; terrain.tween('uPsrRef', v ? 1 : 0, 0.3); },
  iceThresh: (v) => { S.iceThresh = v; terrain.u.uIceThresh.value = v; return iceOut(); },
  sunDay: (v) => { S.sunDay = v; applySun(); },
  sunDec: (v) => { S.sunDec = v; applySun(); },
  maxSlope: (v) => {
    S.maxSlope = v;
    if (S.layer === 'hazard') terrain.u.uSlopeLimit.value = v;
    queueReplan();
    return slopeOut();
  },
  wDark: (v) => { S.wDark = v; queueReplan(); return `${v.toFixed(2)}×`; },
};

function queueReplan() {
  clearTimeout(replanTimer);
  replanTimer = setTimeout(() => { if (S.lastReq) plan(S.lastReq); }, 140);
}

function bindUi() {
  $('#stages').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-stage]');
    if (b) goStage(Number(b.dataset.stage));
  });
  $('#brand').addEventListener('click', () => goStage(0));
  $('#btn-begin').addEventListener('click', () => goStage(1));
  $('#btn-about').addEventListener('click', () => $('#about').showModal());
  $('#about-close').addEventListener('click', () => $('#about').close());
  $('#about').addEventListener('click', (e) => { if (e.target.id === 'about') $('#about').close(); });

  document.addEventListener('input', (e) => {
    const el = e.target.closest('[data-bind]');
    if (!el) return;
    const v = el.type === 'checkbox' ? el.checked : Number(el.value);
    const out = BINDINGS[el.dataset.bind]?.(v);
    const o = document.querySelector(`[data-out="${el.dataset.bind}"]`);
    if (o && out !== undefined) o.textContent = out;
    dirty = true;
  });
  document.addEventListener('pointerdown', (e) => { if (e.target.matches('input[type=range]')) sliderActive = true; });
  window.addEventListener('pointerup', () => { sliderActive = false; dirty = true; });

  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-layer],[data-tool],[data-site],[data-psr],[data-feature],[data-act],#play');
    if (!t) return;
    if (t.id === 'play') togglePlay();
    else if (t.dataset.layer) setLayer(t.dataset.layer);
    else if (t.dataset.tool) setTool(t.dataset.tool);
    else if (t.dataset.site) selectSite(meta.landing.sites.find((s) => s.id === Number(t.dataset.site)));
    else if (t.dataset.psr) {
      const p = meta.psrs[Number(t.dataset.psr)];
      flyToPoint(...geo.rcToWorld(p.row, p.col), 28 + Math.sqrt(p.area_km2) * 2.2);
    } else if (t.dataset.feature) {
      const f = meta.features[Number(t.dataset.feature)];
      flyToPoint(...geo.rcToWorld(f.row, f.col), 30 + f.diam_km * 1.5);
    } else if (t.dataset.act === 'clear-route') clearRoute();
  });

  const cv = $('#gl');
  cv.addEventListener('pointermove', (e) => {
    pointer.x = e.clientX; pointer.y = e.clientY; pointer.inside = true; pointer.moved = true;
  });
  cv.addEventListener('pointerleave', () => { pointer.inside = false; pointer.moved = true; });
  cv.addEventListener('pointerdown', (e) => { pointer.down = { x: e.clientX, y: e.clientY }; });
  cv.addEventListener('pointerup', (e) => {
    const d = pointer.down;
    pointer.down = null;
    if (!d || S.view !== 'terrain' || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) return;
    const hit = pick(e.clientX, e.clientY);
    if (hit) onTerrainClick(hit);
  });

  window.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea') || $('#about').open) return;
    if (e.key >= '0' && e.key <= '3') goStage(Number(e.key));
    else if (e.key === ' ') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'Escape' && S.tool) setTool(null);
  });
}

function buildHero() {
  const il = meta.illumination, ic = meta.ice;
  $('#hero-stats').innerHTML = `
    ${stat(nf(il.psr_area_km2), 'km² in permanent shadow')}
    ${stat(`${nf(ic.tmin_K)} K`, 'coldest surface')}
    ${stat(`${il.psr_agreement_pct} %`, 'match with NASA’s PSR map')}
    ${stat(meta.landing.sites.length, 'landing sites ranked')}`;
}

// =====================================================================================
// picking, tooltip
// =====================================================================================
function pick(cx, cy) {
  const r = renderer.domElement.getBoundingClientRect();
  ray.setFromCamera(new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1), camera);
  return terrain.raycast(ray.ray);
}

function updateHover() {
  pointer.moved = false;
  const tip = $('#tip'), cur = terrain.u.uCursor.value;
  const hit = pointer.inside && !pointer.down ? pick(pointer.x, pointer.y) : null;
  if (!hit) {
    if (cur.w !== 0) { cur.w = 0; dirty = true; }
    tip.classList.remove('on');
    return;
  }
  cur.set(hit.x, hit.z, Math.max(0.35, camera.position.distanceTo(new THREE.Vector3(hit.x, hit.y, hit.z)) * 0.011), 1);
  const s = terrain.sample(hit.x, hit.z);
  const rows = [['Elevation', `${nf(s.elev)} m`]];
  if (S.stage !== 2) rows.push(['Slope', `${s.slope.toFixed(1)}°`]);
  if (S.stage >= 2) rows.push(['Sunlight', s.psr ? '<em>permanent shadow</em>' : `${Math.round(s.sun * 100)} %`]);
  if (S.stage === 2) {
    rows.push(['Max temp', `${nf(s.tmax)} K`]);
    rows.push(['Ice depth', s.depth == null ? '—' : s.depth < 0.01 ? 'surface' : `${s.depth.toFixed(2)} m`]);
    rows.push(['Ice index', s.ice.toFixed(2)]);
  }
  if (S.stage === 3) {
    rows.push(['Earth view', `${Math.round(s.earth * 100)} %`]);
    rows.push(['Landing', s.landing > 0.02 ? `${Math.round(s.landing * 100)} / 100` : 'excluded']);
  }
  tip.innerHTML = `<b>${fmtLat(s.lat)} · ${fmtLon(s.lon)}</b>${rows.map(([k, v]) => `<div><span>${k}</span><span>${v}</span></div>`).join('')}`;
  const w = window.innerWidth, flip = pointer.x > w - (w > 860 ? 560 : 220);
  tip.style.transform = `translate3d(${pointer.x + (flip ? -18 : 18)}px, ${pointer.y + 18}px, 0) translateX(${flip ? '-100%' : '0'})`;
  tip.classList.add('on');
  dirty = true;
}

// =====================================================================================
// render loop
// =====================================================================================
let last = 0, time = 0;
const tmp = new THREE.Vector3();

function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  globe.resize(w, h);
  route.setResolution(w, h);
  dirty = true;
}

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  time += dt;
  let active = tickTweens(dt);
  const w = window.innerWidth, h = window.innerHeight;

  if (S.view === 'orbit') {
    globe.update(dt, time);
    renderer.render(globe.scene, globe.camera);
    globe.moon.updateMatrixWorld();
    for (const it of markers.items) if (it.local) it.pos.copy(it.local).applyMatrix4(globe.moon.matrixWorld);
    markers.update(globe.camera, w, h, null, (it) => {
      if (!it.local) return 1;
      tmp.copy(globe.camera.position).sub(it.pos).normalize();
      return tmp.dot(it.pos.clone().normalize());
    });
    return;
  }

  if (S.playing) {
    S.sunDay = (S.sunDay + (dt * LUNAR_DAY) / 48) % LUNAR_DAY;
    applySun();
    active = true;
  }
  if (S.rover.playing && route.active) {
    const dur = Math.min(26, Math.max(8, S.profile.lengthKm * 1.3));
    const f = Math.min(1, S.rover.frac + dt / dur);
    setRover(f);
    if (f >= 1) { S.rover.playing = false; const b = $('#play'); if (b) b.innerHTML = playIcon(false); }
    active = true;
  }
  if (terrain.update(dt, time)) active = true;
  if (S.stage === 2 && S.iceThresh > 0) active = true;      // pulsing highlight
  if (controls.update()) active = true;
  if (pointer.moved) updateHover();

  const fast = S.playing || sliderActive;
  if (terrain.dirty) { terrain.bake(fast); active = true; }
  else if (terrain.bakedFast && !fast) { terrain.bake(false); active = true; }

  if (!active && !dirty) return;
  dirty = false;

  // keep the camera above the ground and the orbit pivot on the surface, inside the map
  const H = geo.halfKm, tg = controls.target;
  tg.x = Math.min(H, Math.max(-H, tg.x));
  tg.z = Math.min(H, Math.max(-H, tg.z));
  if (!camTween) tg.y = lerp(tg.y, terrain.surfaceY(tg.x, tg.z), 0.12);
  if (geo.inside(camera.position.x, camera.position.z)) {
    const floor = terrain.surfaceY(camera.position.x, camera.position.z) + 1.2;
    if (camera.position.y < floor) camera.position.y = floor;
  }
  camera.lookAt(tg);

  renderer.render(scene, camera);
  markers.update(camera, w, h, (x, z) => terrain.surfaceY(x, z));
  $('#compass-needle').style.transform = `rotate(${controls.getAzimuthalAngle()}rad)`;
}

boot();
