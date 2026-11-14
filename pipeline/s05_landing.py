"""Stage 3a - landing-site suitability.

A good polar landing site is flat, sunlit, in radio view of Earth and within
roving distance of ice.  Per cell (240 m):

  safety   mean of clamp(1 - slope_max/12 deg) over a 500 m radius footprint,
           where slope_max is the steepest 80 m facet inside the cell
  power    average sunlight over the 18.6-year cycle   (saturates at 80 %)
  comms    average Earth visibility                    (saturates at 50 %)
  science  exp(-distance to nearest ice target / 8 km)

      score = 0.30 safety + 0.25 power + 0.15 comms + 0.30 science

Hard exclusions: permanently shadowed, < 85 % of the footprint under 10 deg,
less than 25 % average sunlight, or more than 6 deg from the pole (the
"exploration zone" used for Artemis site selection).

Output : data/processed/landing.npz (score, components) + landing.json (sites)
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import json

import numpy as np
from scipy import ndimage

from common import FEATURES, N, PROC, S, grid_xy, latlon_to_xy, xy_to_latlon

W = {"safety": 0.30, "power": 0.25, "comms": 0.15, "science": 0.30}
FOOTPRINT_M = 500.0
ICE_TARGET = 0.85       # ice index of a science target (PSR + surface cold trap)
MAX_COLAT_DEG = 6.0     # candidate zone: within 6 deg of the pole
N_SITES = 8
MIN_SEP_M = 22000.0
COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]


def disc(radius_px):
    r = int(np.ceil(radius_px))
    yy, xx = np.mgrid[-r:r + 1, -r:r + 1]
    k = (xx * xx + yy * yy <= radius_px * radius_px).astype(np.float32)
    return k / k.sum()


def main():
    ter = np.load(PROC / "terrain.npz")
    ill = np.load(PROC / "illumination.npz")
    ice = np.load(PROC / "ice.npz")["index"]
    slope_max, psr, avg, earth = ter["slope_max"], ill["psr"] > 0, ill["avg"], ill["earth"]

    kern = disc(FOOTPRINT_M / S)
    safety = ndimage.convolve(np.clip(1.0 - slope_max / 12.0, 0.0, 1.0), kern, mode="nearest")
    flat_frac = ndimage.convolve((slope_max <= 10.0).astype(np.float32), kern, mode="nearest")
    power = np.clip(avg / 0.80, 0.0, 1.0)
    comms = np.clip(earth / 0.50, 0.0, 1.0)

    # science: distance to ice patches of at least ~1 km2
    target = ndimage.binary_opening(ice >= ICE_TARGET, structure=np.ones((3, 3)))
    dist_ice = ndimage.distance_transform_edt(~target) * S
    science = np.exp(-dist_ice / 8000.0)

    score = (W["safety"] * safety + W["power"] * power + W["comms"] * comms
             + W["science"] * science).astype(np.float32)
    X, Y = grid_xy()
    lat_all, _ = xy_to_latlon(X, Y)
    ok = (~psr) & (flat_frac >= 0.85) & (avg >= 0.25) & (lat_all <= -90.0 + MAX_COLAT_DEG)
    # keep a margin from the window edge so routes have room
    m = 60
    ok[:m, :] = ok[-m:, :] = ok[:, :m] = ok[:, -m:] = False
    score_masked = np.where(ok, score, 0.0).astype(np.float32)

    # ---- pick well-separated maxima -------------------------------------------
    fx, fy = zip(*[latlon_to_xy(f[1], f[2]) for f in FEATURES])
    fx, fy = np.array(fx), np.array(fy)
    work = ndimage.gaussian_filter(score_masked, 1.5) * ok
    sites = []
    sep = int(MIN_SEP_M / S)
    yy, xx = np.ogrid[:N, :N]
    while len(sites) < N_SITES and work.max() > 0:
        r, c = np.unravel_index(np.argmax(work), work.shape)
        x, y = float(X[r, c]), float(Y[r, c])
        lat, lon = xy_to_latlon(x, y)
        d = np.hypot(fx - x, fy - y)
        k = int(np.argmin(d))
        f = FEATURES[k]
        if f[4] == "massif" and d[k] < f[3] * 500.0:
            name = f[0]
        elif f[4] == "crater" and d[k] < f[3] * 500.0 * 0.7:
            name = f"{f[0]} floor"
        elif f[4] == "crater" and d[k] < f[3] * 500.0 * 1.4:
            name = f"{f[0]} rim"
        else:
            # compass bearing from the feature, in map orientation (lon 0 = "north")
            ang = np.degrees(np.arctan2(x - fx[k], y - fy[k])) % 360
            name = f"{COMPASS[int((ang + 22.5) // 45) % 8]} of {f[0]}"
        dup = sum(1 for q in sites if q["name"].rstrip(" BCDE") == name)
        if dup:
            name = f"{name} {'BCDE'[dup - 1]}"
        sites.append({
            "id": len(sites) + 1, "name": name, "row": int(r), "col": int(c),
            "lat": round(float(lat), 3), "lon": round(float(lon), 3),
            "score": round(float(score[r, c]), 3),
            "safety": round(float(safety[r, c]), 3),
            "power": round(float(power[r, c]), 3),
            "comms": round(float(comms[r, c]), 3),
            "science": round(float(science[r, c]), 3),
            "slope_deg": round(float(ter["slope"][r, c]), 1),
            "slope_max_deg": round(float(slope_max[r, c]), 1),
            "sunlight": round(float(avg[r, c]), 3),
            "earth_vis": round(float(earth[r, c]), 3),
            "ice_dist_km": round(float(dist_ice[r, c] / 1000.0), 1),
            "elev_m": round(float(ter["elev"][r, c]), 0),
        })
        work[(yy - r) ** 2 + (xx - c) ** 2 <= sep * sep] = 0.0

    sites.sort(key=lambda q: -q["score"])
    for i, q in enumerate(sites):
        q["id"] = i + 1

    np.savez_compressed(PROC / "landing.npz", score=score_masked, raw=score, safety=safety,
                        science=science.astype(np.float32), target=target)
    (PROC / "landing.json").write_text(json.dumps(
        {"weights": W, "sites": sites,
         "eligible_pct": round(float(100.0 * ok.mean()), 2)}, indent=1))

    print(f"eligible cells: {100 * ok.mean():.2f} % of window")
    from common import latlon_to_rc
    for nm, la, lo in (("Connecting ridge", -89.45, -137.0), ("de Gerlache rim", -88.67, -68.0),
                       ("Shackleton rim", -89.78, -155.0), ("Malapert massif", -85.99, -0.2),
                       ("Nobile rim 1", -85.4, 37.0), ("Mons Mouton plateau", -84.6, -31.0)):
        r0, c0 = (int(round(float(v))) for v in latlon_to_rc(la, lo))
        win = (slice(r0 - 12, r0 + 13), slice(c0 - 12, c0 + 13))
        print(f"   ref {nm:20s} best score within 3 km: {score_masked[win].max():.2f} "
              f"(eligible {100 * ok[win].mean():.0f} %, sun max {100 * avg[win].max():.0f} %)")
    for s in sites:
        print(f"  #{s['id']} {s['name']:22s} ({s['lat']:.2f}, {s['lon']:7.2f})  score {s['score']:.2f}  "
              f"slope {s['slope_max_deg']:4.1f}  sun {100 * s['sunlight']:3.0f}%  "
              f"earth {100 * s['earth_vis']:3.0f}%  ice {s['ice_dist_km']:.1f} km")


if __name__ == "__main__":
    main()
