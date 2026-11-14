import * as THREE from 'three';

const BASE = import.meta.env.BASE_URL;

const FILES = [
  ['meta', 'data/meta.json', 0.02],
  ['height', 'data/height.webp', 4.3],
  ['layers1', 'data/layers1.webp', 4.5],
  ['layers2', 'data/layers2.webp', 3.8],
  ['layers3', 'data/layers3.webp', 5.3],
  ['detail', 'data/detail.webp', 5.0],
  ['moonColor', 'textures/moon_color.jpg', 1.8],
  ['moonNormal', 'textures/moon_normal.jpg', 2.7],
];

async function fetchWithProgress(url, onBytes) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  if (!res.body) return res.blob();
  const reader = res.body.getReader();
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    onBytes(value.length);
  }
  return new Blob(chunks, { type: res.headers.get('content-type') || '' });
}

// `flip` = image top row at v = 1 (what a UV sphere expects); the analysis grids
// keep row 0 at v = 0 so texel (row, col) lines up with the typed arrays.
const bitmap = (blob, flip = false) => createImageBitmap(blob, {
  premultiplyAlpha: 'none', colorSpaceConversion: 'none',
  imageOrientation: flip ? 'flipY' : 'none',
});

function pixels(bmp) {
  const cv = document.createElement('canvas');
  cv.width = bmp.width; cv.height = bmp.height;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  return ctx.getImageData(0, 0, bmp.width, bmp.height).data;
}

function channel(px, offset, n) {
  const out = new Uint8Array(n);
  for (let i = 0, j = offset; i < n; i++, j += 4) out[i] = px[j];
  return out;
}

function dataTexture(bmp, srgb = false) {
  const t = new THREE.Texture(bmp);
  t.flipY = false;                       // row 0 of the grid = v 0
  t.generateMipmaps = false;
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

/**
 * Loads every asset, decodes the analysis grids into typed arrays (for
 * read-outs, statistics and route planning) and GPU textures (for rendering).
 */
export async function loadAll(onProgress) {
  const total = FILES.reduce((s, f) => s + f[2], 0) * 1e6;
  let loaded = 0;
  const tick = (n) => { loaded += n; onProgress(Math.min(0.97, loaded / total)); };

  const blobs = Object.fromEntries(await Promise.all(
    FILES.map(async ([key, path]) => [key, await fetchWithProgress(BASE + path, tick)])));

  const t0 = performance.now(), lap = (m) => import.meta.env.DEV && console.info(`[data] ${m} ${(performance.now() - t0).toFixed(0)} ms`);
  lap('fetched');
  const meta = JSON.parse(await blobs.meta.text());
  const n = meta.grid.n, nn = n * n;
  const [bH, b1, b2, b3, bD, bMC, bMN] = await Promise.all(
    ['height', 'layers1', 'layers2', 'layers3', 'detail', 'moonColor', 'moonNormal']
      .map((k) => bitmap(blobs[k], k.startsWith('moon'))));

  lap('bitmaps decoded');
  // ---- elevation: 16 bit packed in R (hi) + G (lo) ---------------------------
  const { min_m: hmin, max_m: hmax } = meta.height;
  const elev = new Float32Array(nn);
  {
    const px = pixels(bH);
    const k = (hmax - hmin) / 65535;
    for (let i = 0, j = 0; i < nn; i++, j += 4) elev[i] = hmin + ((px[j] << 8) | px[j + 1]) * k;
  }
  const p1 = pixels(b1), p2 = pixels(b2), p3 = pixels(b3);
  const grids = {
    elev,
    slope: channel(p1, 0, nn),      // deg * 255 / 50
    sun: channel(p1, 1, nn),        // 0..255 = 0..100 %
    psr: channel(p1, 2, nn),        // 85 ours | 170 NASA
    ice: channel(p2, 0, nn),
    landing: channel(p2, 1, nn),
    tmax: channel(p2, 2, nn),       // 25..345 K
    earth: channel(p3, 0, nn),
    depth: channel(p3, 1, nn),      // 0..250 = 0..1.25 m, 255 none
    slopeMax: channel(p3, 2, nn),   // deg * 255 / 60
  };

  lap('grids extracted');
  const heightTex = new THREE.DataTexture(elev, n, n, THREE.RedFormat, THREE.FloatType);
  heightTex.minFilter = heightTex.magFilter = THREE.LinearFilter;
  heightTex.wrapS = heightTex.wrapT = THREE.ClampToEdgeWrapping;
  heightTex.needsUpdate = true;

  const l1 = dataTexture(b1);
  l1.minFilter = l1.magFilter = THREE.LinearFilter;
  const moonColor = dataTexture(bMC, true);
  const moonNormal = dataTexture(bMN);
  for (const t of [moonColor, moonNormal]) {
    t.wrapS = THREE.RepeatWrapping;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.anisotropy = 8;
  }
  const detail = dataTexture(bD);
  detail.generateMipmaps = true;
  detail.minFilter = THREE.LinearMipmapLinearFilter;
  detail.anisotropy = 8;

  onProgress(1);
  return {
    meta, n, grids,
    tex: { height: heightTex, l1, l2: dataTexture(b2), l3: dataTexture(b3), detail, moonColor, moonNormal },
  };
}

/** Grid / map / world conversions. World: X = map x (km), Z = -map y (km). */
export function makeGeo(meta) {
  const { n, cell_m: cell, half_m: half, radius_m: R } = meta.grid;
  const halfKm = half / 1000, cellKm = cell / 1000;
  const geo = {
    n, cell, half, R, halfKm, cellKm,
    rcToWorld: (row, col) => [(col - n / 2 + 0.5) * cellKm, (row - n / 2 + 0.5) * cellKm],
    worldToRc: (x, z) => [z / cellKm + n / 2 - 0.5, x / cellKm + n / 2 - 0.5],
    worldToLatLon(x, z) {
      const r = Math.hypot(x, z) * 1000;
      const lat = -90 + (2 * Math.atan(r / (2 * R)) * 180) / Math.PI;
      const lon = (Math.atan2(x, -z) * 180) / Math.PI;
      return [lat, lon];
    },
    latLonToWorld(lat, lon) {
      const r = (2 * R * Math.tan(((90 + lat) * Math.PI) / 360)) / 1000;
      const l = (lon * Math.PI) / 180;
      return [r * Math.sin(l), -r * Math.cos(l)];
    },
    inside: (x, z) => Math.abs(x) < halfKm && Math.abs(z) < halfKm,
  };
  return geo;
}

export const fmtLat = (lat) => `${Math.abs(lat).toFixed(2)}°${lat < 0 ? 'S' : 'N'}`;
export const fmtLon = (lon) => `${Math.abs(lon).toFixed(1)}°${lon < 0 ? 'W' : 'E'}`;
