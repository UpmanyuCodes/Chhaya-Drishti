import * as THREE from 'three';
import { buildLut } from './colormaps.js';

// Shared GLSL: Sun direction in the local map frame of a point.
// Moon-fixed axes: x -> lon 0, y -> lon 90E, z -> north pole.
// Returns (map-plane direction * cos(elev), sin(elev)).
const SUN_GLSL = /* glsl */`
vec3 sunLocal(vec2 m, vec3 sun, float R) {
  float r = length(m);
  float c = 2.0 * atan(r / (2.0 * R));
  float sc = sin(c);
  vec2 dm = r > 1.0 ? m / r : vec2(0.0, 1.0);
  vec3 n = vec3(sc * dm.y, sc * dm.x, -cos(c));
  float sinE = dot(n, sun);
  vec3 sh = sun - sinE * n;
  vec2 d = normalize(vec2(sh.y, sh.x) + 1e-9);
  return vec3(d * sqrt(max(1.0 - sinE * sinE, 0.0)), sinE);
}
`;

// ---- shadow bake: ray-march the height field toward the Sun ------------------
const BAKE_VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const BAKE_FRAG = /* glsl */`
precision highp float;
uniform sampler2D uHeight;
uniform vec3 uSun;
uniform float uHalf, uR, uHmax, uCell;
varying vec2 vUv;
${SUN_GLSL}
const float RS = 0.004653;      // angular radius of the Sun, rad
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec2 m = vec2(vUv.x - 0.5, 0.5 - vUv.y) * 2.0 * uHalf;
  vec3 L = sunLocal(m, uSun, uR);
  vec2 d = normalize(L.xy + 1e-9);
  float tanE = L.z / max(length(L.xy), 1e-4);
  float hp = texture(uHeight, vUv).r;
  float clearMin = 1.0;
  float t = uCell * (0.7 + 0.6 * hash(gl_FragCoord.xy));
  for (int i = 0; i < 150; i++) {
    vec2 q = m + d * t;
    vec2 uv = vec2(q.x / (2.0 * uHalf) + 0.5, 0.5 - q.y / (2.0 * uHalf));
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) break;
    float ray = hp + t * tanE + t * t / (2.0 * uR);   // Moon curves away below the ray
    if (ray > uHmax) break;
    clearMin = min(clearMin, (ray - texture(uHeight, uv).r) / t);
    if (clearMin < -RS) break;
    t += max(uCell * 0.8, t * 0.045);
  }
  // fraction of the solar disc that clears the terrain
  float lit = clamp((clearMin + RS) / (2.0 * RS), 0.0, 1.0);
  gl_FragColor = vec4(lit, lit, lit, 1.0);
}
`;

// ---- terrain surface ---------------------------------------------------------
const VERT = /* glsl */`
uniform sampler2D uHeight;
uniform float uExag, uCurv, uHalfKm, uRkm;
varying vec2 vUv;
varying vec3 vWorld;
void main() {
  vec2 uv = position.xz / (2.0 * uHalfKm) + 0.5;
  float h = texture(uHeight, uv).r;
  float drop = dot(position.xz, position.xz) / (2.0 * uRkm);
  vec3 p = vec3(position.x, h * 0.001 * uExag - uCurv * drop, position.z);
  vUv = uv;
  vWorld = p;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

const FRAG = /* glsl */`
precision highp float;
uniform sampler2D uHeight, uDetail, uL1, uL2, uL3, uLut, uShadow;
uniform vec3 uSun, uBg;
uniform float uHalf, uR, uHmin, uHmax, uGridN;
uniform float uStudio, uExposure, uAmbient;
uniform int uLayerA, uLayerB;
uniform float uLayerMix, uLayerOpacity;
uniform float uPsr, uPsrRef, uContours, uGraticule, uSlopeLimit, uIceThresh, uTime;
uniform vec4 uCursor;
varying vec2 vUv;
varying vec3 vWorld;
${SUN_GLSL}

vec4 lut(int id, float t) {
  return texture(uLut, vec2(clamp(t, 0.002, 0.998), (float(id) + 0.5) / 16.0));
}

vec4 layerColor(int id, float h, vec3 det, vec3 a1, vec3 a2, vec3 a3) {
  vec4 c = vec4(0.0);
  if (id == 1) c = lut(1, (h - uHmin) / (uHmax - uHmin));
  else if (id == 2) c = lut(2, a1.r * 1.25);
  else if (id == 3) c = vec4(vec3(det.b), 1.0);
  else if (id == 4) c = lut(4, a1.g);
  else if (id == 5) c = lut(5, a2.b);
  else if (id == 6) { c = lut(6, a3.g * 1.02); c.a = 1.0 - smoothstep(0.982, 0.998, a3.g); }
  else if (id == 7) c = lut(7, a2.r);
  else if (id == 8) {
    // excluded cells are 0: colour from the best neighbouring cell so the edge
    // of an eligible patch does not fade through the low end of the ramp
    ivec2 i = ivec2(floor(vUv * uGridN - 0.5));
    ivec2 hi = ivec2(int(uGridN) - 1);
    float v = 0.0;
    for (int dy = 0; dy < 2; dy++) for (int dx = 0; dx < 2; dx++)
      v = max(v, texelFetch(uL2, clamp(i + ivec2(dx, dy), ivec2(0), hi), 0).g);
    c = lut(8, (mix(v, a2.g, step(0.3, a2.g) * 0.7) - 0.3) / 0.45);
    c.a = smoothstep(0.16, 0.30, a2.g);
  }
  else if (id == 9) c = lut(9, a3.r);
  return c;
}

// PSR flags are bit-coded in L1.b (1 = this project, 2 = NASA reference):
// decode per texel, then blend bilinearly for a smooth boundary.
vec2 psrMask(vec2 uv) {
  vec2 p = uv * uGridN - 0.5;
  vec2 f = fract(p);
  ivec2 i = ivec2(floor(p));
  ivec2 hi = ivec2(int(uGridN) - 1);
  vec2 acc = vec2(0.0);
  for (int dy = 0; dy < 2; dy++) for (int dx = 0; dx < 2; dx++) {
    float c = floor(texelFetch(uL1, clamp(i + ivec2(dx, dy), ivec2(0), hi), 0).b * 3.0 + 0.5);
    float w = (dx == 0 ? 1.0 - f.x : f.x) * (dy == 0 ? 1.0 - f.y : f.y);
    acc += w * vec2(mod(c, 2.0), step(1.5, c));
  }
  return acc;
}

float isoLine(float v, float width) {
  float d = abs(fract(v - 0.5) - 0.5) / max(fwidth(v), 1e-6);
  return 1.0 - smoothstep(width - 0.5, width + 0.5, d);
}

void main() {
  float h = texture(uHeight, vUv).r;
  vec3 det = texture(uDetail, vUv).rgb;
  vec2 g = det.rg * 2.0 - 1.0;
  g = sign(g) * g * g;                                   // true dz/dx, dz/dy (map frame)
  vec3 a1 = texture(uL1, vUv).rgb;
  vec3 a2 = texture(uL2, vUv).rgb;
  vec3 a3 = texture(uL3, vUv).rgb;
  vec2 m = vec2(vUv.x - 0.5, 0.5 - vUv.y) * 2.0 * uHalf;

  // ---- physically based sunlight (true slopes, baked cast shadows) -----------
  vec3 L = sunLocal(m, uSun, uR);
  vec3 nTrue = normalize(vec3(-g, 1.0));
  float shadow = texture(uShadow, vUv).r;
  float direct = max(dot(nTrue, L), 0.0) * shadow;
  float sunLight = 1.0 - exp(-direct * uExposure);
  vec3 sunCol = vec3(0.80, 0.78, 0.75) * sunLight * vec3(1.0, 0.97, 0.92)
              + vec3(0.045, 0.058, 0.090) * uAmbient * (0.55 + 0.6 * det.b);

  // ---- studio relief light (stage 1): readable everywhere ---------------------
  vec3 nSoft = normalize(vec3(-g * 2.2, 1.0));
  float st = dot(nSoft, normalize(vec3(-0.55, 0.60, 0.58)));
  float relief = 0.16 + 0.92 * pow(clamp(st * 0.5 + 0.5, 0.0, 1.0), 1.7) * 1.25;
  float hn = (h - uHmin) / (uHmax - uHmin);
  vec3 studioCol = mix(vec3(0.52, 0.55, 0.62), vec3(0.80, 0.77, 0.72), smoothstep(0.1, 0.8, hn)) * relief;

  vec3 base = mix(sunCol, studioCol, uStudio);
  float light = mix(sunLight + 0.05, relief, uStudio);

  // ---- data layer (cross-faded) ----------------------------------------------
  vec4 lc = mix(layerColor(uLayerA, h, det, a1, a2, a3),
                layerColor(uLayerB, h, det, a1, a2, a3), uLayerMix);
  float shade = 0.50 + 0.50 * mix(det.b * 1.15, clamp(light, 0.0, 1.2), 0.25);
  vec3 col = mix(base, lc.rgb * shade, lc.a * uLayerOpacity);

  // ---- permanently shadowed regions -------------------------------------------
  vec2 pm = psrMask(vUv);
  if (uPsr > 0.0) {
    float e = abs(pm.x - 0.5);
    float line = 1.0 - smoothstep(0.0, fwidth(pm.x) * 1.6 + 1e-4, e);
    float inside = smoothstep(0.45, 0.55, pm.x);
    col = mix(col, vec3(0.10, 0.36, 0.85), inside * 0.34 * uPsr);
    col = mix(col, vec3(0.45, 0.92, 1.0), line * 0.95 * uPsr);
  }
  if (uPsrRef > 0.0) {
    float e = abs(pm.y - 0.5);
    float line = 1.0 - smoothstep(0.0, fwidth(pm.y) * 1.4 + 1e-4, e);
    col = mix(col, vec3(1.0, 0.36, 0.72), line * 0.9 * uPsrRef);
  }

  // ---- ice threshold highlight -------------------------------------------------
  if (uIceThresh > 0.0) {
    float hit = smoothstep(uIceThresh - 0.02, uIceThresh + 0.02, a2.r);
    float pulse = 0.75 + 0.25 * sin(uTime * 2.4 - length(m) * 0.00012);
    col = mix(col, vec3(0.55, 0.95, 1.0), hit * 0.55 * pulse);
  }

  // ---- slope hazard hatch ------------------------------------------------------
  if (uSlopeLimit > 0.0) {
    float over = smoothstep(uSlopeLimit - 0.6, uSlopeLimit + 0.6, a1.r * 50.0);
    float hatch = smoothstep(0.35, 0.65, fract((m.x + m.y) / 1600.0));
    col = mix(col, vec3(0.95, 0.20, 0.25), over * (0.30 + 0.30 * hatch));
  }

  // ---- contours & graticule ----------------------------------------------------
  if (uContours > 0.0) {
    float minor = isoLine(h / 500.0, 0.6);
    float major = isoLine(h / 2500.0, 1.1);
    col = mix(col, vec3(1.0, 0.95, 0.85), max(minor * 0.22, major * 0.5) * uContours);
  }
  if (uGraticule > 0.0) {
    float r = length(m);
    float lat = degrees(2.0 * atan(r / (2.0 * uR)));
    float lon = degrees(atan(m.x, m.y));
    float gl = max(isoLine(lat, 0.7), isoLine(lon / 15.0, 0.7) * step(0.2, lat));
    col = mix(col, vec3(0.50, 0.85, 1.0), gl * 0.42 * uGraticule);
  }

  // ---- cursor ring -------------------------------------------------------------
  if (uCursor.w > 0.0) {
    float d = distance(vWorld.xz, uCursor.xy);
    float w = fwidth(d) * 1.5;
    float ring = 1.0 - smoothstep(0.0, w, abs(d - uCursor.z));
    float dot_ = 1.0 - smoothstep(uCursor.z * 0.12, uCursor.z * 0.12 + w, d);
    col = mix(col, vec3(1.0), max(ring, dot_) * 0.9 * uCursor.w);
  }

  // ---- soft window edge + depth haze -------------------------------------------
  float edge = min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y));
  col = mix(uBg, col, smoothstep(0.0, 0.03, edge));
  float dist = distance(cameraPosition, vWorld);
  col = mix(col, uBg, smoothstep(600.0, 2200.0, dist) * 0.55);
  gl_FragColor = vec4(col, 1.0);
}
`;

const DEG = Math.PI / 180;

export class Terrain {
  constructor({ renderer, data, geo, segments = 1024, fastShadow = 1024 }) {
    this.renderer = renderer;
    this.geo = geo;
    this.grids = data.grids;
    this.n = data.n;
    const { meta, tex } = data;

    if (!renderer.extensions.has('OES_texture_float_linear')) {
      tex.height.minFilter = tex.height.magFilter = THREE.NearestFilter;
    }

    // shadow targets: full resolution when the Sun is still, half while it moves
    const rt = (size) => new THREE.WebGLRenderTarget(size, size, {
      depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    });
    const maxTex = renderer.capabilities.maxTextureSize;
    this.rtHi = rt(Math.min(2048, maxTex));
    this.rtLo = rt(fastShadow);
    this.bakeMat = new THREE.ShaderMaterial({
      vertexShader: BAKE_VERT, fragmentShader: BAKE_FRAG,
      depthTest: false, depthWrite: false,
      uniforms: {
        uHeight: { value: tex.height }, uSun: { value: new THREE.Vector3(1, 0, 0) },
        uHalf: { value: geo.half }, uR: { value: geo.R },
        uHmax: { value: meta.height.max_m }, uCell: { value: geo.cell },
      },
    });
    this.bakeScene = new THREE.Scene();
    this.bakeScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.bakeMat));
    this.bakeCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this.u = {
      uHeight: { value: tex.height }, uDetail: { value: tex.detail },
      uL1: { value: tex.l1 }, uL2: { value: tex.l2 }, uL3: { value: tex.l3 },
      uLut: { value: buildLut() }, uShadow: { value: this.rtHi.texture },
      uSun: { value: new THREE.Vector3(1, 0, 0) }, uBg: { value: new THREE.Color(0x04050a) },
      uHalf: { value: geo.half }, uR: { value: geo.R },
      uHalfKm: { value: geo.halfKm }, uRkm: { value: geo.R / 1000 },
      uHmin: { value: meta.height.min_m }, uHmax: { value: meta.height.max_m },
      uGridN: { value: this.n },
      uExag: { value: 3 }, uCurv: { value: 1 },
      uStudio: { value: 1 }, uExposure: { value: 7 }, uAmbient: { value: 1 },
      uLayerA: { value: 0 }, uLayerB: { value: 0 }, uLayerMix: { value: 1 }, uLayerOpacity: { value: 0.92 },
      uPsr: { value: 0 }, uPsrRef: { value: 0 }, uContours: { value: 0 }, uGraticule: { value: 0 },
      uSlopeLimit: { value: 0 }, uIceThresh: { value: 0 }, uTime: { value: 0 },
      uCursor: { value: new THREE.Vector4(0, 0, 1, 0) },
    };

    const s = segments, v = s + 1;
    const pos = new Float32Array(v * v * 3);
    for (let j = 0, k = 0; j < v; j++) {
      for (let i = 0; i < v; i++, k += 3) {
        pos[k] = (i / s - 0.5) * 2 * geo.halfKm;
        pos[k + 2] = (j / s - 0.5) * 2 * geo.halfKm;
      }
    }
    const idx = new Uint32Array(s * s * 6);
    for (let j = 0, k = 0; j < s; j++) {
      for (let i = 0; i < s; i++, k += 6) {
        const a = j * v + i, b = a + 1, c = a + v, d = c + 1;
        idx[k] = a; idx[k + 1] = c; idx[k + 2] = b;
        idx[k + 3] = b; idx[k + 4] = c; idx[k + 5] = d;
      }
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geom.setIndex(new THREE.BufferAttribute(idx, 1));
    this.mesh = new THREE.Mesh(geom, new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, uniforms: this.u,
    }));
    this.mesh.frustumCulled = false;

    // animated scalars: name -> { from, to, t, dur }
    this.anim = new Map();
    this.sun = { lon: 0, dec: -1.543 };
    this.setSun(0, -1.543);
    this.bake(false);
  }

  // ---- lighting -----------------------------------------------------------------
  setSun(lonDeg, decDeg) {
    this.sun.lon = lonDeg; this.sun.dec = decDeg;
    const l = lonDeg * DEG, d = decDeg * DEG;
    this.u.uSun.value.set(Math.cos(d) * Math.cos(l), Math.cos(d) * Math.sin(l), Math.sin(d));
    this.bakeMat.uniforms.uSun.value.copy(this.u.uSun.value);
    this.dirty = true;
  }

  bake(fast) {
    const target = fast ? this.rtLo : this.rtHi;
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.bakeScene, this.bakeCam);
    this.renderer.setRenderTarget(prev);
    this.u.uShadow.value = target.texture;
    this.dirty = false;
    this.bakedFast = fast;
  }

  // ---- layers / animated uniforms ----------------------------------------------
  setLayer(id) {
    if (id === this.u.uLayerB.value) return;
    this.u.uLayerA.value = this.u.uLayerMix.value > 0.5 ? this.u.uLayerB.value : this.u.uLayerA.value;
    this.u.uLayerB.value = id;
    this.u.uLayerMix.value = 0;
    this.tween('uLayerMix', 1, 0.55);
  }

  tween(name, to, dur = 0.6) {
    const from = this.u[name].value;
    if (from === to) return;
    this.anim.set(name, { from, to, t: 0, dur });
  }

  /** Advances tweens; returns true while anything is still animating. */
  update(dt, time) {
    this.u.uTime.value = time;
    for (const [name, a] of this.anim) {
      a.t = Math.min(1, a.t + dt / a.dur);
      const e = a.t * a.t * (3 - 2 * a.t);
      this.u[name].value = a.from + (a.to - a.from) * e;
      if (a.t >= 1) this.anim.delete(name);
    }
    return this.anim.size > 0;
  }

  // ---- CPU-side queries ----------------------------------------------------------
  /** Bilinear elevation in metres at world (x, z). */
  heightAt(x, z) {
    const n = this.n, e = this.grids.elev;
    let r = z / this.geo.cellKm + n / 2 - 0.5, c = x / this.geo.cellKm + n / 2 - 0.5;
    r = Math.min(n - 1.001, Math.max(0, r)); c = Math.min(n - 1.001, Math.max(0, c));
    const i = r | 0, j = c | 0, fr = r - i, fc = c - j, k = i * n + j;
    return (e[k] * (1 - fc) + e[k + 1] * fc) * (1 - fr) + (e[k + n] * (1 - fc) + e[k + n + 1] * fc) * fr;
  }

  surfaceY(x, z) {
    return this.heightAt(x, z) * 0.001 * this.u.uExag.value
      - this.u.uCurv.value * (x * x + z * z) / (2 * this.geo.R / 1000);
  }

  /** Ray / height-field intersection (the mesh is displaced on the GPU). */
  raycast(ray) {
    const o = ray.origin, d = ray.direction, H = this.geo.halfKm;
    let t = 0, prev = 0, hit = false;
    for (let i = 0; i < 900 && t < 4000; i++) {
      const x = o.x + d.x * t, z = o.z + d.z * t, y = o.y + d.y * t;
      if (Math.abs(x) < H && Math.abs(z) < H) {
        const gap = y - this.surfaceY(x, z);
        if (gap <= 0) { hit = true; break; }
        prev = t;
        t += Math.max(0.12, gap * 0.22);
      } else {
        if (y < -40 && d.y <= 0) return null;
        prev = t;
        t += 4;
      }
    }
    if (!hit) return null;
    let lo = prev, hi = t;
    for (let i = 0; i < 12; i++) {
      const mid = (lo + hi) / 2;
      const x = o.x + d.x * mid, z = o.z + d.z * mid;
      if (o.y + d.y * mid - this.surfaceY(x, z) > 0) lo = mid; else hi = mid;
    }
    const x = o.x + d.x * hi, z = o.z + d.z * hi;
    return { x, z, y: this.surfaceY(x, z) };
  }

  /** All analysis values at a world position (nearest cell). */
  sample(x, z) {
    const n = this.n, g = this.grids;
    const r = Math.min(n - 1, Math.max(0, Math.round(z / this.geo.cellKm + n / 2 - 0.5)));
    const c = Math.min(n - 1, Math.max(0, Math.round(x / this.geo.cellKm + n / 2 - 0.5)));
    const k = r * n + c;
    const code = Math.round(g.psr[k] / 85);
    const [lat, lon] = this.geo.worldToLatLon(x, z);
    return {
      row: r, col: c, lat, lon,
      elev: this.heightAt(x, z),
      slope: g.slope[k] * 50 / 255,
      slopeMax: g.slopeMax[k] * 60 / 255,
      sun: g.sun[k] / 255,
      earth: g.earth[k] / 255,
      tmax: 25 + g.tmax[k] * 320 / 255,
      ice: g.ice[k] / 255,
      landing: g.landing[k] / 255,
      depth: g.depth[k] === 255 ? null : g.depth[k] * 1.25 / 250,
      psr: (code & 1) === 1,
    };
  }
}
