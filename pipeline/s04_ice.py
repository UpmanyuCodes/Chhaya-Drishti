"""Stage 2c - water-ice potential index.

Ice survives where it is cold enough for long enough.  We combine three
independent lines of evidence into a 0..1 favourability index:

  S_T  surface cold-trapping   Diviner annual max temperature.  Water ice loses
                               < 1 mm / Gyr below ~110 K (Paige et al. 2010).
  S_D  subsurface stability    Diviner thermal-model depth at which ice becomes
                               stable (0 m = at the surface).
  S_P  permanent shadow        our horizon-method PSR map (stage 2a).

      index = 0.45 S_T + 0.30 S_D + 0.25 S_P

This is a *favourability* map (where ice can persist), not a detection.

Output : data/processed/ice.npz  (index, cls, labels of the main deposits)
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import json

import numpy as np
from scipy import ndimage

from common import FEATURES, N, PROC, S, grid_xy, latlon_to_xy, scale_factor, xy_to_latlon

W_T, W_D, W_P = 0.45, 0.30, 0.25


def main():
    ill = np.load(PROC / "illumination.npz")
    div = np.load(PROC / "diviner.npz")
    psr = ill["psr"] > 0
    avg = ill["avg"]
    tmax, depth = div["tmax"], div["ice_depth"]

    s_t = np.interp(tmax, [60.0, 110.0, 130.0, 160.0], [1.0, 0.75, 0.30, 0.0])
    s_d = np.where(np.isnan(depth), 0.0, np.exp(-np.nan_to_num(depth) / 0.35))
    s_p = np.where(psr, 1.0, 0.5 * np.clip(1.0 - avg / 0.10, 0.0, 1.0))
    index = (W_T * s_t + W_D * s_d + W_P * s_p).astype(np.float32)

    # classes: 3 = surface cold trap, 2 = shallow subsurface, 1 = marginal, 0 = dry
    cls = np.zeros((N, N), dtype=np.uint8)
    cls[index >= 0.35] = 1
    cls[(np.nan_to_num(depth, nan=9.0) <= 0.5) & (index >= 0.5)] = 2
    cls[psr & (tmax < 110.0)] = 3

    X, Y = grid_xy()
    cell_km2 = (S / 1000.0) ** 2 / scale_factor(X, Y) ** 2

    # ---- catalogue of PSRs ----------------------------------------------------
    lab, n = ndimage.label(psr, structure=np.ones((3, 3)))
    idx = np.arange(1, n + 1)
    area = ndimage.sum(cell_km2, lab, idx)
    order = np.argsort(area)[::-1]
    fx, fy = zip(*[latlon_to_xy(f[1], f[2]) for f in FEATURES])
    fx, fy = np.array(fx), np.array(fy)
    cat = []
    for o in order[:40]:
        m = lab == idx[o]
        cy, cx = ndimage.center_of_mass(m)
        # representative interior point: deepest point of the distance transform
        sl = ndimage.find_objects(m.astype(np.uint8))[0]
        sub = np.pad(m[sl], 1)
        dt = ndimage.distance_transform_edt(sub)
        r, c = np.unravel_index(np.argmax(dt), dt.shape)
        r, c = r - 1 + sl[0].start, c - 1 + sl[1].start
        x, y = X[r, c], Y[r, c]
        lat, lon = xy_to_latlon(x, y)
        d = np.hypot(fx - x, fy - y)
        k = int(np.argmin(d))
        inside = d[k] < FEATURES[k][3] * 1000.0 * 0.62
        cat.append({
            "row": int(r), "col": int(c), "lat": round(float(lat), 3), "lon": round(float(lon), 3),
            "area_km2": round(float(area[o]), 1),
            "tmax_min": round(float(tmax[m].min()), 1),
            "tmax_mean": round(float(tmax[m].mean()), 1),
            "ice_mean": round(float(index[m].mean()), 3),
            "near": FEATURES[k][0], "inside": bool(inside),
            "dist_km": round(float(d[k] / 1000.0), 1),
        })
    stats = {
        "psr_count": int(n),
        "psr_area_km2": round(float(cell_km2[psr].sum()), 0),
        "cold_trap_area_km2": round(float(cell_km2[cls == 3].sum()), 0),
        "shallow_area_km2": round(float(cell_km2[cls == 2].sum()), 0),
        "window_area_km2": round(float(cell_km2.sum()), 0),
        "tmin_K": round(float(tmax.min()), 1),
        "weights": {"temperature": W_T, "depth": W_D, "shadow": W_P},
    }
    np.savez_compressed(PROC / "ice.npz", index=index, cls=cls)
    (PROC / "ice.json").write_text(json.dumps({"stats": stats, "psrs": cat}, indent=1))

    print(json.dumps(stats, indent=1))
    for c in cat[:12]:
        where = "in" if c["inside"] else f"{c['dist_km']:.0f} km from"
        print(f"  {c['area_km2']:7.1f} km2  {where:>12s} {c['near']:16s} "
              f"Tmax min {c['tmax_min']:5.1f} K  ice {c['ice_mean']:.2f}")


if __name__ == "__main__":
    main()
