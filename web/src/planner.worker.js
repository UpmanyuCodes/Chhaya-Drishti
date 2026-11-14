// Rover route planner - runs off the main thread.
// Same cost model as pipeline/s06_paths.py:
//   cost = distance * (1 + (slope / 10 deg)^2) * (1 + wDark * darkness)
//   darkness = clamp(1 - avg_sunlight / 0.30);  cells steeper than maxSlope are impassable
//
// mode 'p2p' : A* between two cells (Euclidean heuristic, admissible because every
//              multiplier is >= 1)
// mode 'ice' : Dijkstra flood from the start until the first ice-target cell

let n = 0, nn = 0, cell = 240;
let slope, sun, ice;
let g, prev, closed;

// ---- binary min-heap on (key, id) ------------------------------------------------
let hk = new Float64Array(1 << 16), hv = new Int32Array(1 << 16), hn = 0;
function push(key, id) {
  if (hn === hk.length) {
    const k2 = new Float64Array(hn * 2), v2 = new Int32Array(hn * 2);
    k2.set(hk); v2.set(hv); hk = k2; hv = v2;
  }
  let i = hn++;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (hk[p] <= key) break;
    hk[i] = hk[p]; hv[i] = hv[p]; i = p;
  }
  hk[i] = key; hv[i] = id;
}
function pop() {
  const top = hv[0];
  const key = hk[--hn], id = hv[hn];
  let i = 0;
  for (;;) {
    let c = 2 * i + 1;
    if (c >= hn) break;
    if (c + 1 < hn && hk[c + 1] < hk[c]) c++;
    if (hk[c] >= key) break;
    hk[i] = hk[c]; hv[i] = hv[c]; i = c;
  }
  hk[i] = key; hv[i] = id;
  return top;
}

const DR = [-1, -1, -1, 0, 0, 1, 1, 1];
const DC = [-1, 0, 1, -1, 1, -1, 0, 1];

function isTarget(r, c, thr) {
  if (r < 1 || c < 1 || r >= n - 1 || c >= n - 1) return false;
  for (let dr = -1; dr <= 1; dr++) {
    const k = (r + dr) * n + c;
    if (ice[k - 1] < thr || ice[k] < thr || ice[k + 1] < thr) return false;
  }
  return true;
}

function plan({ mode, start, goal, maxSlope, wDark, iceThresh }) {
  g.fill(Infinity); prev.fill(-1); closed.fill(0); hn = 0;
  const limit = (maxSlope * 255) / 50;           // slope grid is deg * 255 / 50
  const thr = Math.round(iceThresh * 255);
  const s = start[0] * n + start[1];
  let gr = goal ? goal[0] : 0, gc = goal ? goal[1] : 0, snapped = false;
  if (mode === 'p2p' && slope[gr * n + gc] > limit) {
    // goal sits on ground too steep to drive: use the nearest drivable cell within ~2 km
    let best = -1, bd = Infinity;
    for (let dr = -8; dr <= 8; dr++) for (let dc = -8; dc <= 8; dc++) {
      const r = gr + dr, c = gc + dc, d = dr * dr + dc * dc;
      if (r < 0 || c < 0 || r >= n || c >= n || d >= bd || slope[r * n + c] > limit) continue;
      bd = d; best = r * n + c;
    }
    if (best < 0) return { found: false, reason: 'goal-steep' };
    gr = (best / n) | 0; gc = best - gr * n; snapped = true;
  }
  const goalId = goal ? gr * n + gc : -1;

  g[s] = 0;
  push(0, s);
  let found = -1, expanded = 0;
  while (hn > 0) {
    const u = pop();
    if (closed[u]) continue;
    closed[u] = 1;
    expanded++;
    const r = (u / n) | 0, c = u - r * n;
    if (mode === 'p2p' ? u === goalId : isTarget(r, c, thr)) { found = u; break; }
    const gu = g[u];
    for (let k = 0; k < 8; k++) {
      const rr = r + DR[k], cc = c + DC[k];
      if (rr < 0 || cc < 0 || rr >= n || cc >= n) continue;
      const v = rr * n + cc;
      if (closed[v]) continue;
      const sl8 = slope[v];
      if (sl8 > limit) continue;
      const sl = (sl8 * 50) / 255 / 10;
      const dark = Math.min(1, Math.max(0, 1 - sun[v] / 76.5));   // 0.30 * 255
      const step = (k === 1 || k === 3 || k === 4 || k === 6) ? cell : cell * 1.41421356;
      const ng = gu + step * (1 + sl * sl) * (1 + wDark * dark);
      if (ng < g[v]) {
        g[v] = ng;
        prev[v] = u;
        const h = mode === 'p2p' ? Math.hypot(rr - gr, cc - gc) * cell : 0;
        push(ng + h, v);
      }
    }
  }
  if (found < 0) return { found: false, reason: 'unreachable', expanded };
  const out = [];
  for (let u = found; u >= 0; u = prev[u]) out.push(u);
  out.reverse();
  return { found: true, path: Int32Array.from(out), cost: g[found], expanded, snapped };
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') {
    ({ n, cell, slope, sun, ice } = m);
    nn = n * n;
    g = new Float32Array(nn); prev = new Int32Array(nn); closed = new Uint8Array(nn);
    self.postMessage({ type: 'ready' });
  } else if (m.type === 'plan') {
    const t0 = performance.now();
    const res = plan(m);
    res.type = 'result'; res.id = m.id; res.ms = performance.now() - t0;
    self.postMessage(res, res.path ? [res.path.buffer] : []);
  }
};
