"""Stage 2b - thermal environment from the LRO Diviner radiometer.

Input  : dlre_prp_south.tab  (Diviner Polar Resource Product, Paige et al. 2010)
         2.88 M triangles (~500 m) with annual mean / maximum surface
         temperature and the depth at which water ice is thermally stable.
Output : data/processed/diviner.npz on the 240 m analysis grid
           tmax       annual maximum surface temperature, K
           tavg       annual mean surface temperature, K
           ice_depth  depth to stable ice, m (0 = stable at the surface,
                      NaN = not stable within the modelled top metres)
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np
from scipy.spatial import cKDTree

from common import N, PROC, RAW, grid_xy, latlon_to_xy


def main():
    cache = PROC / "diviner_points.npy"
    if cache.exists():
        pts = np.load(cache)
    else:
        pts = np.loadtxt(RAW / "dlre_prp_south.tab", delimiter=",", skiprows=1,
                         usecols=(9, 10, 12, 13, 14), dtype=np.float32)
        np.save(cache, pts)
    lon, lat, tavg, tmax, depth = pts.T
    print(f"{len(pts):,} Diviner facets, lat {lat.min():.2f} .. {lat.max():.2f}")

    flag = np.round(depth).astype(int)
    for v, label in ((-999, "no stable ice"), (-1, "flag -1")):
        sel = flag == v
        if sel.any():
            print(f"  ice_depth {v:5d} ({label}): {100 * sel.mean():5.1f} %  "
                  f"tmax median {np.median(tmax[sel]):.0f} K, tavg median {np.median(tavg[sel]):.0f} K")
    sel = depth == 0
    print(f"  ice_depth     0: {100 * sel.mean():5.1f} %  tmax median {np.median(tmax[sel]):.0f} K")
    sel = depth > 0
    print(f"  ice_depth   > 0: {100 * sel.mean():5.1f} %  tmax median {np.median(tmax[sel]):.0f} K, "
          f"depth median {np.median(depth[sel]):.2f} m")

    x, y = latlon_to_xy(lat.astype(np.float64), lon.astype(np.float64))
    tree = cKDTree(np.column_stack([x, y]))
    X, Y = grid_xy()
    q = np.column_stack([X.ravel(), Y.ravel()])
    dist, idx = tree.query(q, k=4, workers=-1)

    # temperatures: inverse-distance blend of the 4 nearest facets
    w = 1.0 / np.maximum(dist, 1.0) ** 2
    w /= w.sum(axis=1, keepdims=True)
    tmax_g = (tmax[idx] * w).sum(axis=1).reshape(N, N)
    tavg_g = (tavg[idx] * w).sum(axis=1).reshape(N, N)

    # ice depth is categorical at its edges -> nearest facet only
    d = depth[idx[:, 0]].astype(np.float32)
    d[d < -900] = np.nan      # not stable
    d[d < 0] = 0.0            # see note in README: surface-stable class
    depth_g = d.reshape(N, N)

    np.savez_compressed(PROC / "diviner.npz", tmax=tmax_g.astype(np.float32),
                        tavg=tavg_g.astype(np.float32), ice_depth=depth_g)
    print(f"gridded: tmax {tmax_g.min():.0f} .. {tmax_g.max():.0f} K, "
          f"cold traps (tmax < 110 K) {100 * (tmax_g < 110).mean():.2f} % of window, "
          f"ice stable within 1 m {100 * (depth_g <= 1.0).mean():.2f} %")


if __name__ == "__main__":
    main()
