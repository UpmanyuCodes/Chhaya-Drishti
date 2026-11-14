import * as THREE from 'three';

// Each layer: shader id, label, unit, value range shown in the legend, colour stops.
// `a` on a stop is opacity (lets a layer fade out to the bare relief underneath).
export const LAYERS = {
  relief: { id: 0, name: 'Relief' },
  elevation: {
    id: 1, name: 'Elevation', unit: 'm', ticks: ['-6.7 km', '0', '+7.0 km'],
    stops: [[0, '#1a1440'], [0.15, '#233f8f'], [0.3, '#2b7fa8'], [0.45, '#58b79a'],
      [0.6, '#c9d48a'], [0.75, '#e0a35c'], [0.88, '#b86a4a'], [1, '#f4efe9']],
  },
  slope: {
    id: 2, name: 'Slope', unit: '°', ticks: ['0°', '10°', '20°', '30°', '40°+'],
    stops: [[0, '#0d2a3a'], [0.125, '#1f7a6b'], [0.25, '#9bcf5a'], [0.375, '#f4d03f'],
      [0.5, '#f08a2c'], [0.75, '#cf2f45'], [1, '#7a1040']],
  },
  hillshade: {
    id: 3, name: 'Hillshade', ticks: ['shaded', 'lit'],
    stops: [[0, '#000000'], [1, '#ffffff']],
  },
  sunlight: {
    id: 4, name: 'Average sunlight', unit: '%', ticks: ['0 %', '50 %', '100 %'],
    stops: [[0, '#05060d'], [0.1, '#1b1140'], [0.3, '#5b1f6e'], [0.5, '#b83e5e'],
      [0.7, '#f0803a'], [0.85, '#ffd166'], [1, '#fff8dc']],
  },
  tmax: {
    id: 5, name: 'Max temperature', unit: 'K', ticks: ['25 K', '110 K', '185 K', '265 K', '345 K'],
    tickPos: [0, 0.266, 0.5, 0.75, 1],
    stops: [[0, '#f2feff'], [0.12, '#7fdcff'], [0.255, '#2f6bff'], [0.275, '#3b2a6b'],
      [0.5, '#b23a6a'], [0.75, '#f08a3c'], [1, '#ffe9a8']],
  },
  icedepth: {
    id: 6, name: 'Depth to stable ice', unit: 'm', ticks: ['surface', '0.5 m', '1.25 m'],
    tickPos: [0, 0.4, 1],
    stops: [[0, '#f2feff'], [0.2, '#8fe6ff'], [0.5, '#3f8cff'], [1, '#2a2f8f']],
  },
  ice: {
    id: 7, name: 'Ice potential index', ticks: ['low', '0.5', 'high'],
    stops: [[0, '#0b1030', 0], [0.3, '#16307a', 0], [0.45, '#1f4fb0', 0.85], [0.65, '#2f8cff'],
      [0.82, '#6fe3ff'], [1, '#ffffff']],
  },
  landing: {
    id: 8, name: 'Landing suitability', ticks: ['poor', 'good', 'best'],
    stops: [[0, '#2a1740'], [0.3, '#3f3f9f'], [0.55, '#2f9f8f'], [0.8, '#a6e05a'], [1, '#ffe45c']],
  },
  earth: {
    id: 9, name: 'Earth visibility', unit: '%', ticks: ['0 %', '50 %', '100 %'],
    stops: [[0, '#070b14'], [0.4, '#114b5f'], [0.7, '#1a936f'], [1, '#c6f7c3']],
  },
};

const ROWS = 16;

function hex(c) {
  const v = parseInt(c.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function sample(stops, t) {
  let i = 0;
  while (i < stops.length - 2 && t > stops[i + 1][0]) i++;
  const [t0, c0, a0 = 1] = stops[i];
  const [t1, c1, a1 = 1] = stops[i + 1];
  const f = Math.min(1, Math.max(0, (t - t0) / (t1 - t0 || 1)));
  const p = hex(c0), q = hex(c1);
  return [p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f, p[2] + (q[2] - p[2]) * f,
    255 * (a0 + (a1 - a0) * f)];
}

/** 256 x 16 RGBA lookup texture, one row per layer id. */
export function buildLut() {
  const data = new Uint8Array(256 * ROWS * 4);
  for (const layer of Object.values(LAYERS)) {
    if (!layer.stops) continue;
    for (let x = 0; x < 256; x++) {
      const c = sample(layer.stops, x / 255);
      data.set(c.map(Math.round), (layer.id * 256 + x) * 4);
    }
  }
  const tex = new THREE.DataTexture(data, 256, ROWS, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

export function cssGradient(layer) {
  return `linear-gradient(90deg, ${layer.stops.map(([t, c]) => `${c} ${(t * 100).toFixed(1)}%`).join(', ')})`;
}

export function colorAt(layer, t) {
  const c = sample(layer.stops, t);
  return `rgb(${c[0] | 0}, ${c[1] | 0}, ${c[2] | 0})`;
}
