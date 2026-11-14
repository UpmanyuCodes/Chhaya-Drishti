"""Export everything the website needs into web/public.

data/height.webp   16-bit elevation packed into R (high byte) and G (low byte), lossless
data/layers1.webp  R slope (0..50 deg)  G avg sunlight (0..1)  B PSR (85 ours, 170 NASA, 255 both)
data/layers2.webp  R ice index (0..1)   G landing score (0..1) B Tmax (25..345 K)
data/layers3.webp  R Earth visibility   G ice depth (0..1.25 m, 255 = not stable)  B max slope (0..60 deg)
data/detail.webp   4096^2: R,G signed-sqrt terrain gradient, B fine hillshade
data/meta.json     grid definition, encodings, statistics, features, sites, routes
textures/moon_*.jpg  global colour + normal map for the orbital view
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import json

import numpy as np
import rasterio
from PIL import Image

from common import (FEATURES, HALF, N, POIS, PROC, R_MOON, RAW, S, WEB_DATA, WEB_TEX,
                    crop_center, grid_xy, latlon_to_rc, scale_factor)

Image.MAX_IMAGE_PIXELS = None


def u8(a, lo, hi):
    return np.clip(np.round((np.asarray(a, dtype=np.float64) - lo) / (hi - lo) * 255.0), 0, 255).astype(np.uint8)


def save_rgb(name, r, g, b, lossless=True, quality=90):
    im = Image.fromarray(np.dstack([r, g, b]))
    path = WEB_DATA / name
    if lossless:
        im.save(path, "WEBP", lossless=True, quality=100, method=6, exact=True)
    else:
        im.save(path, "WEBP", quality=quality, method=6)
    print(f"  {name:14s} {path.stat().st_size / 1e6:6.2f} MB")


def moon_textures():
    col = Image.open(RAW / "lroc_color_poles_4k.tif").convert("RGB")
    col.save(WEB_TEX / "moon_color.jpg", quality=88, optimize=True)

    dem = np.asarray(Image.open(RAW / "ldem_16.tif"), dtype=np.float32) * 1000.0  # km -> m
    h, w = dem.shape
    lat = np.radians(90.0 - (np.arange(h) + 0.5) * 180.0 / h)[:, None]
    dlon = 2.0 * np.pi / w * R_MOON * np.maximum(np.cos(lat), 0.05)
    dlat = np.pi / h * R_MOON
    gx = (np.roll(dem, -1, axis=1) - np.roll(dem, 1, axis=1)) / (2.0 * dlon)
    gy = np.gradient(dem, axis=0) / -dlat          # +v = north
    k = 2.2                                        # relief exaggeration for the globe
    nx, ny, nz = -gx * k, -gy * k, np.ones_like(gx)
    norm = np.sqrt(nx * nx + ny * ny + nz * nz)
    rgb = np.dstack([nx / norm, ny / norm, nz / norm]) * 0.5 + 0.5
    Image.fromarray((rgb * 255).astype(np.uint8)).resize((4096, 2048), Image.LANCZOS) \
        .save(WEB_TEX / "moon_normal.jpg", quality=90, optimize=True)
    for f in ("moon_color.jpg", "moon_normal.jpg"):
        print(f"  {f:14s} {(WEB_TEX / f).stat().st_size / 1e6:6.2f} MB")


def main():
    WEB_DATA.mkdir(parents=True, exist_ok=True)
    WEB_TEX.mkdir(parents=True, exist_ok=True)

    ter = np.load(PROC / "terrain.npz")
    ill = np.load(PROC / "illumination.npz")
    div = np.load(PROC / "diviner.npz")
    ice = np.load(PROC / "ice.npz")
    land = np.load(PROC / "landing.npz")
    det = np.load(PROC / "detail.npz")

    def ref(name):
        with rasterio.open(RAW / name) as ds:
            return crop_center(ds.read(1))

    nasa_psr = ref("LPSR_65S_240M_201608.TIF") > 0
    nasa_avg = ref("AVGVISIB_65S_240M_201608.TIF").astype(np.float32) * 0.00004
    nasa_earth = ref("AVGVISIB_65S_240M_201608_EARTH.TIF").astype(np.float32) * 0.00004

    elev = ter["elev"]
    hmin, hmax = float(np.floor(elev.min())), float(np.ceil(elev.max()))
    h16 = np.round((elev - hmin) / (hmax - hmin) * 65535.0).astype(np.uint16)
    psr = ill["psr"] > 0

    print("web data:")
    save_rgb("height.webp", (h16 >> 8).astype(np.uint8), (h16 & 255).astype(np.uint8),
             np.zeros((N, N), np.uint8))
    save_rgb("layers1.webp", u8(ter["slope"], 0, 50), u8(ill["avg"], 0, 1),
             (psr * 85 + nasa_psr * 170).astype(np.uint8))
    save_rgb("layers2.webp", u8(ice["index"], 0, 1), u8(land["score"], 0, 1), u8(div["tmax"], 25, 345))
    depth = div["ice_depth"]
    depth8 = np.where(np.isnan(depth), 255, np.clip(np.round(np.nan_to_num(depth) / 1.25 * 250), 0, 250))
    save_rgb("layers3.webp", u8(ill["earth"], 0, 1), depth8.astype(np.uint8), u8(ter["slope_max"], 0, 60))

    def enc(g):  # signed sqrt keeps precision for the gentle slopes that dominate
        g = np.clip(g, -1.0, 1.0)
        return np.clip(np.round((np.sign(g) * np.sqrt(np.abs(g)) * 0.5 + 0.5) * 255.0), 0, 255).astype(np.uint8)

    save_rgb("detail.webp", enc(det["gx"]), enc(det["gy"]), u8(det["hs"], 0, 1), lossless=False, quality=92)
    moon_textures()

    # ---- metadata -------------------------------------------------------------
    X, Y = grid_xy()
    cell_km2 = (S / 1000.0) ** 2 / scale_factor(X, Y) ** 2
    inter, union = (psr & nasa_psr).sum(), (psr | nasa_psr).sum()
    ice_info = json.loads((PROC / "ice.json").read_text())
    land_info = json.loads((PROC / "landing.json").read_text())
    path_info = json.loads((PROC / "paths.json").read_text())

    feats = []
    for name, lat, lon, diam, kind in FEATURES:
        r, c = latlon_to_rc(lat, lon)
        if 0 <= r < N and 0 <= c < N:
            feats.append({"name": name, "lat": lat, "lon": lon, "diam_km": diam, "kind": kind,
                          "row": round(float(r), 1), "col": round(float(c), 1)})
    pois = []
    for name, lat, lon, note in POIS:
        r, c = latlon_to_rc(lat, lon)
        pois.append({"name": name, "lat": lat, "lon": lon, "note": note,
                     "row": round(float(r), 1), "col": round(float(c), 1)})

    slope = ter["slope"]
    meta = {
        "grid": {"n": N, "cell_m": S, "half_m": HALF, "radius_m": R_MOON,
                 "edge_lat": round(float(-90 + np.degrees(2 * np.arctan(HALF / (2 * R_MOON)))), 2)},
        "height": {"min_m": hmin, "max_m": hmax},
        "encoding": {
            "slope_deg": [0, 50], "sunlight": [0, 1], "ice": [0, 1], "landing": [0, 1],
            "tmax_K": [25, 345], "earth": [0, 1], "ice_depth_m": [0, 1.25], "slope_max_deg": [0, 60],
        },
        "terrain": {
            "elev_min_m": hmin, "elev_max_m": hmax, "relief_km": round((hmax - hmin) / 1000.0, 1),
            "slope_mean_deg": round(float(slope.mean()), 1),
            "slope_median_deg": round(float(np.median(slope)), 1),
            "area_km2": round(float(cell_km2.sum()), 0),
        },
        "illumination": {
            "psr_area_km2": round(float(cell_km2[psr].sum()), 0),
            "nasa_psr_area_km2": round(float(cell_km2[nasa_psr].sum()), 0),
            "psr_agreement_pct": round(float(100.0 * (psr == nasa_psr).mean()), 2),
            "psr_iou": round(float(inter / union), 3),
            "sunlight_r": round(float(np.corrcoef(ill["avg"].ravel(), nasa_avg.ravel())[0, 1]), 3),
            "earth_r": round(float(np.corrcoef(ill["earth"].ravel(), nasa_earth.ravel())[0, 1]), 3),
            "max_sunlight": round(float(ill["avg"].max()), 3),
        },
        "ice": ice_info["stats"],
        "psrs": ice_info["psrs"],
        "landing": land_info,
        "routes": path_info,
        "features": feats,
        "pois": pois,
    }
    (WEB_DATA / "meta.json").write_text(json.dumps(meta, separators=(",", ":")))
    print(f"  meta.json      {(WEB_DATA / 'meta.json').stat().st_size / 1e3:6.1f} kB")
    print(json.dumps(meta["illumination"], indent=1))


if __name__ == "__main__":
    main()
