import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LAYERS, colorAt } from './colormaps.js';

const v3 = new THREE.Vector3();

/** DOM markers pinned to 3-D positions (labels, site pins, rover). */
export class Markers {
  constructor(container) {
    this.root = container;
    this.items = [];
  }

  /**
   * opts: html, cls, group, onClick, title
   *   pos   : THREE.Vector3 world position, or
   *   xz    : [x, z] on the terrain (height follows the surface), lift in km
   *   range : hide when the camera is farther than this (km)
   */
  add(opts) {
    const el = document.createElement(opts.onClick ? 'button' : 'div');
    el.className = `marker ${opts.cls || ''}`;
    el.innerHTML = opts.html;
    if (opts.title) el.title = opts.title;
    if (opts.onClick) el.addEventListener('click', (e) => { e.stopPropagation(); opts.onClick(item); });
    this.root.appendChild(el);
    const item = { el, shown: false, ...opts };
    this.items.push(item);
    return item;
  }

  clear(group) {
    this.items = this.items.filter((it) => {
      if (group && it.group !== group) return true;
      it.el.remove();
      return false;
    });
  }

  setGroupVisible(group, on) {
    for (const it of this.items) if (it.group === group) it.hidden = !on;
  }

  update(camera, w, h, surfaceY, facing) {
    for (const it of this.items) {
      let vis = !it.hidden;
      if (vis) {
        if (it.xz) v3.set(it.xz[0], surfaceY(it.xz[0], it.xz[1]) + (it.lift || 0), it.xz[1]);
        else v3.copy(it.pos);
        if (it.range && camera.position.distanceTo(v3) > it.range) vis = false;
        if (vis && facing && facing(it) < 0.12) vis = false;
        if (vis) {
          v3.project(camera);
          if (v3.z > 1 || v3.z < -1 || Math.abs(v3.x) > 1.15 || Math.abs(v3.y) > 1.15) vis = false;
          else it.el.style.transform = `translate3d(${((v3.x * 0.5 + 0.5) * w).toFixed(1)}px, ${((-v3.y * 0.5 + 0.5) * h).toFixed(1)}px, 0)`;
        }
      }
      if (vis !== it.shown) {
        it.shown = vis;
        it.el.classList.toggle('on', vis);
      }
    }
  }
}

/** Chaikin corner cutting keeps a grid path close to its cells but removes the stair-steps. */
function smooth(pts, rounds = 2) {
  let p = pts;
  for (let k = 0; k < rounds && p.length > 2; k++) {
    const q = [p[0]];
    for (let i = 0; i < p.length - 1; i++) {
      const [ax, az] = p[i], [bx, bz] = p[i + 1];
      q.push([ax * 0.75 + bx * 0.25, az * 0.75 + bz * 0.25], [ax * 0.25 + bx * 0.75, az * 0.25 + bz * 0.75]);
    }
    q.push(p[p.length - 1]);
    p = q;
  }
  return p;
}

/** A polyline draped over the terrain (rover traverse or cross-section). */
export class Route {
  constructor(scene, terrain, color = 0xffc857) {
    this.terrain = terrain;
    this.pts = [];
    const mk = (opacity, depthTest, width) => {
      const mat = new LineMaterial({
        color, linewidth: width, transparent: true, opacity, depthTest, depthWrite: false,
      });
      const line = new Line2(new LineGeometry(), mat);
      line.visible = false;
      line.frustumCulled = false;
      line.renderOrder = depthTest ? 3 : 2;
      scene.add(line);
      return line;
    };
    this.ghost = mk(0.28, false, 2.5);   // faint, always visible (behind ridges)
    this.line = mk(1.0, true, 4);
  }

  setResolution(w, h) {
    this.line.material.resolution.set(w, h);
    this.ghost.material.resolution.set(w, h);
  }

  /** pts: array of [x, z] world positions. */
  set(pts, doSmooth = true) {
    this.pts = doSmooth ? smooth(pts) : pts;
    this.cum = [0];
    for (let i = 1; i < this.pts.length; i++) {
      this.cum.push(this.cum[i - 1] + Math.hypot(this.pts[i][0] - this.pts[i - 1][0], this.pts[i][1] - this.pts[i - 1][1]));
    }
    this.refresh();
  }

  /** Re-drape after the vertical exaggeration changed. */
  refresh() {
    if (this.pts.length < 2) return;
    const t = this.terrain, lift = 0.05 * t.u.uExag.value + 0.04;
    const flat = [];
    for (const [x, z] of this.pts) flat.push(x, t.surfaceY(x, z) + lift, z);
    for (const l of [this.line, this.ghost]) {
      l.geometry.dispose();
      l.geometry = new LineGeometry();
      l.geometry.setPositions(flat);
      l.visible = true;
    }
  }

  clear() {
    this.pts = [];
    this.line.visible = this.ghost.visible = false;
  }

  get active() { return this.pts.length > 1; }

  /** World [x, z] at a fraction 0..1 of the path length. */
  pointAt(frac) {
    const total = this.cum[this.cum.length - 1], d = frac * total;
    let i = 1;
    while (i < this.cum.length - 1 && this.cum[i] < d) i++;
    const f = (d - this.cum[i - 1]) / Math.max(1e-9, this.cum[i] - this.cum[i - 1]);
    const a = this.pts[i - 1], b = this.pts[i];
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
  }
}

/**
 * Statistics + profile along a list of [x, z] world samples.
 * speed: rover drive speed km/h (driving time only).
 */
export function pathProfile(pts, terrain, speed = 0.36) {
  const dist = [0], elev = [], slope = [], psr = [];
  let len3 = 0, up = 0, down = 0, maxSlope = 0, slopeSum = 0, psrKm = 0;
  for (let i = 0; i < pts.length; i++) {
    const s = terrain.sample(pts[i][0], pts[i][1]);
    elev.push(s.elev); slope.push(s.slope); psr.push(s.psr);
    maxSlope = Math.max(maxSlope, s.slope); slopeSum += s.slope;
    if (i > 0) {
      const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      const dz = (elev[i] - elev[i - 1]) / 1000;
      dist.push(dist[i - 1] + d);
      len3 += Math.hypot(d, dz);
      if (dz > 0) up += dz * 1000; else down -= dz * 1000;
      if (s.psr) psrKm += d;
    }
  }
  const end = terrain.sample(pts[pts.length - 1][0], pts[pts.length - 1][1]);
  return {
    dist, elev, slope, psr,
    lengthKm: len3, ascent: up, descent: down, maxSlope, meanSlope: slopeSum / pts.length,
    psrKm, hours: len3 / speed, end,
  };
}

/** Elevation profile drawn on a canvas; reports hover position as a path fraction. */
export class ProfileChart {
  constructor(canvas, onHover) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.cursor = null;
    this.pad = { l: 46, r: 12, t: 10, b: 22 };
    canvas.addEventListener('pointermove', (e) => {
      if (!this.p) return;
      const r = canvas.getBoundingClientRect();
      const f = (e.clientX - r.left - this.pad.l) / (r.width - this.pad.l - this.pad.r);
      onHover(Math.min(1, Math.max(0, f)));
    });
    canvas.addEventListener('pointerleave', () => onHover(null));
    new ResizeObserver(() => this.draw()).observe(canvas);
  }

  set(profile) { this.p = profile; this.draw(); }
  setCursor(frac) { this.cursor = frac; this.draw(); }

  draw() {
    const { cv, ctx, pad } = this;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const p = this.p;
    if (!p) return;
    const n = p.elev.length, total = p.dist[n - 1] || 1;
    let lo = Math.min(...p.elev), hi = Math.max(...p.elev);
    const span = Math.max(40, hi - lo);
    lo -= span * 0.12; hi += span * 0.12;
    const X = (d) => pad.l + (d / total) * (w - pad.l - pad.r);
    const Y = (e) => pad.t + (1 - (e - lo) / (hi - lo)) * (h - pad.t - pad.b);

    // permanently shadowed stretches
    ctx.fillStyle = 'rgba(70, 150, 255, 0.20)';
    for (let i = 1; i < n; i++) {
      if (p.psr[i]) ctx.fillRect(X(p.dist[i - 1]), pad.t, Math.max(1, X(p.dist[i]) - X(p.dist[i - 1])), h - pad.t - pad.b);
    }

    // grid + axis labels
    ctx.font = '10px "JetBrains Mono Variable", ui-monospace, monospace';
    ctx.fillStyle = 'rgba(200, 215, 235, 0.55)';
    ctx.strokeStyle = 'rgba(160, 190, 230, 0.10)';
    ctx.lineWidth = 1;
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let i = 0; i <= 3; i++) {
      const e = lo + ((hi - lo) * i) / 3, y = Y(e);
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
      ctx.fillText(`${Math.round(e)} m`, pad.l - 6, y);
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (let i = 0; i <= 4; i++) {
      const d = (total * i) / 4;
      ctx.fillText(`${d.toFixed(total < 10 ? 1 : 0)} km`, Math.min(w - 20, Math.max(pad.l + 14, X(d))), h - pad.b + 6);
    }

    // area under the profile
    const grad = ctx.createLinearGradient(0, pad.t, 0, h - pad.b);
    grad.addColorStop(0, 'rgba(127, 227, 255, 0.28)');
    grad.addColorStop(1, 'rgba(127, 227, 255, 0.01)');
    ctx.beginPath();
    ctx.moveTo(X(0), h - pad.b);
    for (let i = 0; i < n; i++) ctx.lineTo(X(p.dist[i]), Y(p.elev[i]));
    ctx.lineTo(X(total), h - pad.b);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // profile line coloured by local slope
    ctx.lineWidth = 2.2; ctx.lineCap = 'round';
    for (let i = 1; i < n; i++) {
      ctx.strokeStyle = colorAt(LAYERS.slope, Math.min(1, Math.max(0.2, p.slope[i] / 40 + 0.12)));
      ctx.beginPath();
      ctx.moveTo(X(p.dist[i - 1]), Y(p.elev[i - 1]));
      ctx.lineTo(X(p.dist[i]), Y(p.elev[i]));
      ctx.stroke();
    }

    if (this.cursor != null) {
      const d = this.cursor * total;
      let i = 1;
      while (i < n - 1 && p.dist[i] < d) i++;
      const f = (d - p.dist[i - 1]) / Math.max(1e-9, p.dist[i] - p.dist[i - 1]);
      const e = p.elev[i - 1] + (p.elev[i] - p.elev[i - 1]) * f;
      ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(X(d), pad.t); ctx.lineTo(X(d), h - pad.b); ctx.stroke();
      ctx.fillStyle = '#ffc857';
      ctx.beginPath(); ctx.arc(X(d), Y(e), 4.5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#0b0e16'; ctx.lineWidth = 1.5; ctx.stroke();
    }
  }
}
