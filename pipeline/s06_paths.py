"""Stage 3b - rover traverse planning (A* / Dijkstra on the 240 m grid).

Cost of stepping into a cell (the same function runs live in the browser,
see web/src/planner.worker.js):

    cost = distance * (1 + (slope / 10 deg)^2) * (1 + w_dark * darkness)

    slope     mean 80 m-baseline slope of the cell; cells steeper than
              MAX_SLOPE are impassable
    darkness  clamp(1 - avg_sunlight / 0.30) - a solar rover avoids ground
              that is rarely lit, but may still enter it to reach ice

For each landing site we flood outward (Dijkstra) and stop at the first cell
belonging to an ice target, which yields the cheapest traverse to ice.

Output : data/processed/paths.json
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import heapq
import json

import numpy as np
from numba import njit

from common import N, PROC, S, grid_xy, xy_to_latlon

MAX_SLOPE = 15.0
W_DARK = 1.5
ROVER_SPEED_KMH = 0.36      # 10 cm/s drive speed (VIPER-class), driving time only


@njit(cache=True)
def dijkstra_to_target(slope, dark, target, r0, c0, max_slope, w_dark, s):
    n = slope.shape[0]
    dist = np.full(n * n, np.inf)
    prev = np.full(n * n, -1, dtype=np.int32)
    done = np.zeros(n * n, dtype=np.uint8)
    start = r0 * n + c0
    dist[start] = 0.0
    heap = [(0.0, start)]
    dr = (-1, -1, -1, 0, 0, 1, 1, 1)
    dc = (-1, 0, 1, -1, 1, -1, 0, 1)
    goal = -1
    while len(heap) > 0:
        d, u = heapq.heappop(heap)
        if done[u]:
            continue
        done[u] = 1
        r, c = u // n, u % n
        if target[r, c]:
            goal = u
            break
        for k in range(8):
            rr, cc = r + dr[k], c + dc[k]
            if rr < 0 or cc < 0 or rr >= n or cc >= n:
                continue
            sl = slope[rr, cc]
            if sl > max_slope:
                continue
            v = rr * n + cc
            if done[v]:
                continue
            step = s * (1.41421356 if dr[k] != 0 and dc[k] != 0 else 1.0)
            cost = step * (1.0 + (sl / 10.0) ** 2) * (1.0 + w_dark * dark[rr, cc])
            nd = d + cost
            if nd < dist[v]:
                dist[v] = nd
                prev[v] = u
                heapq.heappush(heap, (nd, v))
    path = []
    u = goal
    while u >= 0:
        path.append(u)
        u = prev[u]
    return np.array(path[::-1], dtype=np.int64), (dist[goal] if goal >= 0 else np.inf)


def path_stats(rows, cols, ter, ill, ice, tmax):
    elev = ter["elev"][rows, cols].astype(float)
    slope = ter["slope"][rows, cols].astype(float)
    seg = np.hypot(np.diff(rows), np.diff(cols)) * S
    dz = np.diff(elev)
    length = float(np.sqrt(seg ** 2 + dz ** 2).sum())
    psr = ill["psr"][rows, cols] > 0
    return {
        "length_km": round(length / 1000.0, 2),
        "ascent_m": round(float(dz[dz > 0].sum()), 0),
        "descent_m": round(float(-dz[dz < 0].sum()), 0),
        "max_slope_deg": round(float(slope.max()), 1),
        "mean_slope_deg": round(float(slope.mean()), 1),
        "shadow_km": round(float(seg[psr[1:]].sum() / 1000.0), 2),
        "drive_hours": round(length / 1000.0 / ROVER_SPEED_KMH, 1),
        "target_ice": round(float(ice[rows[-1], cols[-1]]), 2),
        "target_tmax_K": round(float(tmax[rows[-1], cols[-1]]), 0),
    }


def main():
    ter = np.load(PROC / "terrain.npz")
    ill = np.load(PROC / "illumination.npz")
    ice = np.load(PROC / "ice.npz")["index"]
    tmax = np.load(PROC / "diviner.npz")["tmax"]
    land = np.load(PROC / "landing.npz")
    sites = json.loads((PROC / "landing.json").read_text())["sites"]

    slope = ter["slope"].astype(np.float32)
    dark = np.clip(1.0 - ill["avg"] / 0.30, 0.0, 1.0).astype(np.float32)
    target = land["target"]
    X, Y = grid_xy()

    out = []
    for s in sites:
        p, cost = dijkstra_to_target(slope, dark, target, s["row"], s["col"], MAX_SLOPE, W_DARK, S)
        if len(p) == 0:
            print(f"  #{s['id']} {s['name']}: no traversable route to ice")
            out.append({"site": s["id"], "found": False})
            continue
        rows, cols = p // N, p % N
        st = path_stats(rows, cols, ter, ill, ice, tmax)
        lat, lon = xy_to_latlon(X[rows[-1], cols[-1]], Y[rows[-1], cols[-1]])
        out.append({"site": s["id"], "found": True, "rows": rows.tolist(), "cols": cols.tolist(),
                    "target": {"lat": round(float(lat), 3), "lon": round(float(lon), 3)}, **st})
        print(f"  #{s['id']} {s['name']:22s} {st['length_km']:6.1f} km  max slope {st['max_slope_deg']:4.1f}  "
              f"+{st['ascent_m']:.0f}/-{st['descent_m']:.0f} m  in PSR {st['shadow_km']:.1f} km  "
              f"target ice {st['target_ice']:.2f} @ {st['target_tmax_K']:.0f} K")

    (PROC / "paths.json").write_text(json.dumps(
        {"params": {"max_slope_deg": MAX_SLOPE, "w_dark": W_DARK, "speed_kmh": ROVER_SPEED_KMH},
         "routes": out}))


if __name__ == "__main__":
    main()
