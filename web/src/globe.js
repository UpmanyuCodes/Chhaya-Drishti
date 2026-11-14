import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { animate, ease, lerp } from './tween.js';

const DEG = Math.PI / 180;

/** lat/lon (deg) -> unit vector in the globe's local frame (matches the equirect texture). */
export function llToVec(lat, lon, r = 1) {
  const a = lat * DEG, o = lon * DEG;
  return new THREE.Vector3(Math.cos(a) * Math.cos(o) * r, Math.sin(a) * r, -Math.cos(a) * Math.sin(o) * r);
}

export function makeStars(radius, count = 2600) {
  const pos = new Float32Array(count * 3), col = new Float32Array(count * 3), size = new Float32Array(count);
  const c = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const u = Math.random() * 2 - 1, t = Math.random() * Math.PI * 2, s = Math.sqrt(1 - u * u);
    pos.set([s * Math.cos(t) * radius, u * radius, s * Math.sin(t) * radius], i * 3);
    const b = 0.35 + 0.65 * Math.pow(Math.random(), 2.2);
    c.setHSL(0.55 + Math.random() * 0.12, 0.25 * Math.random(), b);
    col.set([c.r, c.g, c.b], i * 3);
    size[i] = 1 + Math.pow(Math.random(), 4) * 2.2;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  const m = new THREE.ShaderMaterial({
    uniforms: { uRatio: { value: Math.min(window.devicePixelRatio, 2) } },
    vertexShader: `attribute float aSize; uniform float uRatio; varying vec3 vC;
      void main(){ vC = color; gl_PointSize = aSize * uRatio; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `varying vec3 vC; void main(){ float d = length(gl_PointCoord - 0.5);
      gl_FragColor = vec4(vC, smoothstep(0.5, 0.1, d)); }`,
    vertexColors: true, transparent: true, depthWrite: false,
  });
  const pts = new THREE.Points(g, m);
  pts.frustumCulled = false;
  return pts;
}

const SITES = [
  { name: 'Chandrayaan-3', sub: 'Shiv Shakti · 2023', lat: -69.373, lon: 32.319, kind: 'isro up' },
  { name: 'Chandrayaan-2', sub: 'Vikram · 2019', lat: -70.881, lon: 22.784, kind: 'isro left' },
  { name: 'IM-1 Odysseus', sub: '2024', lat: -80.13, lon: 1.44, kind: 'other left' },
  { name: 'LCROSS', sub: 'water found · 2009', lat: -84.675, lon: -48.725, kind: 'other left down' },
];

export class Globe {
  constructor({ renderer, data, geo, dom }) {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.05, 400);
    this.offset = 0.17;            // shifts the Moon right of centre to leave room for the title
    this.home = llToVec(-50, 14, 4.7);
    this.camera.position.copy(this.home);

    this.moon = new THREE.Group();
    this.scene.add(this.moon);
    const mat = new THREE.MeshStandardMaterial({
      map: data.tex.moonColor, normalMap: data.tex.moonNormal,
      normalScale: new THREE.Vector2(1.15, 1.15), roughness: 1, metalness: 0,
    });
    this.moon.add(new THREE.Mesh(new THREE.SphereGeometry(1, 192, 96), mat));

    this.sun = new THREE.DirectionalLight(0xfff4e6, 3.6);
    this.sun.position.copy(llToVec(-1.5, -52, 10));
    this.scene.add(this.sun, new THREE.AmbientLight(0x8fb0ff, 0.045));
    this.scene.add(makeStars(180));

    // study-area outline: the square analysis window projected back onto the sphere
    const pts = [];
    const H = geo.halfKm, steps = 40;
    const edge = (x0, z0, x1, z1) => {
      for (let i = 0; i < steps; i++) {
        const t = i / steps;
        const [lat, lon] = geo.worldToLatLon(lerp(x0, x1, t), lerp(z0, z1, t));
        pts.push(llToVec(lat, lon, 1.004));
      }
    };
    edge(-H, -H, H, -H); edge(H, -H, H, H); edge(H, H, -H, H); edge(-H, H, -H, -H);
    this.outline = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: 0x7fe3ff, transparent: true, opacity: 0.95 }));
    this.moon.add(this.outline);

    // pulsing halo at the pole
    const ring = (r0, r1, op) => {
      const m = new THREE.Mesh(new THREE.RingGeometry(r0, r1, 96),
        new THREE.MeshBasicMaterial({ color: 0x7fe3ff, transparent: true, opacity: op, side: THREE.DoubleSide, depthWrite: false }));
      m.position.set(0, -1.006, 0);
      m.rotation.x = Math.PI / 2;
      this.moon.add(m);
      return m;
    };
    this.halo = ring(0.20, 0.206, 0.8);
    ring(0.004, 0.012, 1);

    this.controls = new OrbitControls(this.camera, dom);
    this.controls.enablePan = false;
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.minDistance = 2.2;
    this.controls.maxDistance = 8;
    this.controls.rotateSpeed = 0.5;
    this.controls.enabled = false;

    this.labels = [
      { text: 'Study area', sub: 'South Pole · 82°S–90°S', pos: llToVec(-90, 0, 1.01), kind: 'focus down' },
      ...SITES.map((s) => ({ text: s.name, sub: s.sub, pos: llToVec(s.lat, s.lon, 1.008), kind: s.kind })),
    ];
    this.spin = true;
    this.busy = false;
  }

  resize(w, h) {
    this.w = w; this.h = h;
    this.camera.aspect = w / h;
    this.applyOffset();
  }

  applyOffset() {
    const { w, h } = this;
    const off = w > 900 ? this.offset : 0;
    if (off) this.camera.setViewOffset(w, h, -off * w, 0, w, h); else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
  }

  update(dt, time) {
    if (this.spin && !this.busy) this.moon.rotation.y += dt * 0.035;
    this.halo.scale.setScalar(1 + 0.18 * Math.sin(time * 1.6));
    this.halo.material.opacity = 0.55 + 0.35 * Math.cos(time * 1.6);
    if (this.controls.enabled) this.controls.update();
    else this.camera.lookAt(0, 0, 0);
  }

  /** World-space label anchors, with a facing test so far-side labels hide. */
  labelState(label, out) {
    out.copy(label.pos).applyMatrix4(this.moon.matrixWorld);
    const toCam = this.camera.position.clone().sub(out).normalize();
    return out.clone().normalize().dot(toCam);
  }

  /** Dive from orbit to directly above the south pole, map-north (lon 0) up. */
  flyToPole(done) {
    this.busy = true;
    this.controls.enabled = false;
    const cam = this.camera;
    const p0 = cam.position.clone(), d0 = p0.length();
    const q0 = p0.clone().normalize(), q1 = new THREE.Vector3(0, -1, 0);
    const up0 = cam.up.clone(), up1 = new THREE.Vector3(1, 0, 0);
    const rot0 = this.moon.rotation.y;
    const rot1 = Math.round(rot0 / (2 * Math.PI)) * 2 * Math.PI;
    const off0 = this.offset;
    const axis = new THREE.Vector3().crossVectors(q0, q1).normalize();
    const ang = q0.angleTo(q1);
    animate({
      dur: 3.4, ease: ease.inOut,
      update: (k) => {
        const dir = q0.clone().applyAxisAngle(axis, ang * k);
        cam.position.copy(dir.multiplyScalar(lerp(d0, 1.42, k * k)));
        cam.up.copy(up0).lerp(up1, k).normalize();
        this.moon.rotation.y = lerp(rot0, rot1, k);
        this.offset = lerp(off0, 0, k);
        this.applyOffset();
        cam.lookAt(0, 0, 0);
      },
      done: () => { this.offset = off0; done?.(); },
    });
  }

  /** Restore the orbital overview. */
  reset() {
    this.busy = false;
    this.camera.up.set(0, 1, 0);
    this.camera.position.copy(this.home);
    this.applyOffset();
    this.camera.lookAt(0, 0, 0);
    this.controls.target.set(0, 0, 0);
    this.controls.enabled = true;
    this.controls.update();
  }
}
