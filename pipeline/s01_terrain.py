"""Stage 1 - terrain products from LOLA laser-altimeter DEMs.

Inputs  : ldem_75s_240m.img (analysis grid), ldem_80s_80m.img (fine detail)
Outputs : data/processed/terrain.npz
            elev        height above the 1737.4 km sphere, m          (240 m grid)
            slope       mean slope over each cell, 80 m baseline, deg
            slope_max   steepest 80 m facet inside each cell, deg
            rough       RMS height residual inside each cell, m
            hillshade   classic 315/45 hillshade, 0..1
          data/processed/detail.npz  (4096^2 gradient + hillshade for rendering)
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np
from scipy import ndimage

from common import N, PROC, S, crop_center, grid_xy, read_ldem, scale_factor


def gradient(z, spacing, k):
    """dz/dx (toward +map_x) and dz/dy (toward +map_y) in true metres."""
    gy, gx = np.gradient(z, spacing)
    return gx * k, -gy * k  # rows grow toward -map_y


def hillshade(gx, gy, az_deg=315.0, alt_deg=45.0, zf=1.0):
    az, alt = np.radians(az_deg), np.radians(alt_deg)
    lx, ly, lz = np.sin(az) * np.cos(alt), np.cos(az) * np.cos(alt), np.sin(alt)
    nx, ny = -gx * zf, -gy * zf
    norm = np.sqrt(nx * nx + ny * ny + 1.0)
    return np.clip((nx * lx + ny * ly + lz) / norm, 0.0, 1.0)


def main():
    PROC.mkdir(parents=True, exist_ok=True)

    # ---- 240 m analysis grid -------------------------------------------------
    elev = crop_center(read_ldem("ldem_75s_240m.img", 3812)).copy()
    X, Y = grid_xy()
    k = scale_factor(X, Y).astype(np.float32)

    # ---- 80 m grid: slope / roughness statistics per 240 m cell ---------------
    fine = crop_center(read_ldem("ldem_80s_80m.img", 7600), 3 * N)
    Xf, Yf = grid_xy(3 * N, 80.0)
    kf = scale_factor(Xf, Yf).astype(np.float32)
    del Xf, Yf
    gxf, gyf = gradient(fine, 80.0, kf)
    slope_f = np.degrees(np.arctan(np.hypot(gxf, gyf))).astype(np.float32)

    blocks = slope_f.reshape(N, 3, N, 3)
    slope = blocks.mean(axis=(1, 3))
    slope_max = blocks.max(axis=(1, 3))
    fb = fine.reshape(N, 3, N, 3)
    rough = fb.std(axis=(1, 3))

    gx, gy = gradient(elev, S, k)
    hs = hillshade(gx, gy).astype(np.float32)

    np.savez_compressed(
        PROC / "terrain.npz",
        elev=elev, slope=slope.astype(np.float32),
        slope_max=slope_max.astype(np.float32),
        rough=rough.astype(np.float32), hillshade=hs,
    )

    # ---- 4096^2 detail textures (gradient + hillshade) for the renderer -------
    zoom = 4096 / (3 * N)
    det_gx = ndimage.zoom(gxf, zoom, order=1)
    det_gy = ndimage.zoom(gyf, zoom, order=1)
    det_hs = hillshade(det_gx, det_gy)
    np.savez_compressed(PROC / "detail.npz", gx=det_gx.astype(np.float32),
                        gy=det_gy.astype(np.float32), hs=det_hs.astype(np.float32))

    print(f"elevation  {elev.min():8.0f} .. {elev.max():8.0f} m  (relief {np.ptp(elev)/1000:.1f} km)")
    print(f"slope mean {slope.mean():.1f} deg, median {np.median(slope):.1f}, "
          f"p95 {np.percentile(slope, 95):.1f}, max {slope_max.max():.1f}")
    for lim in (5, 10, 15, 20):
        print(f"  cells with max-slope <= {lim:2d} deg: {100 * (slope_max <= lim).mean():5.1f} %")


if __name__ == "__main__":
    main()
