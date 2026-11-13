"""Stage 2a - illumination modelling: permanently shadowed regions (PSRs),
average sunlight and Earth visibility, from topography alone.

Method (horizon method, after Mazarico et al. 2011)
---------------------------------------------------
For every cell we ray-march the DEM outward in K azimuths in full 3-D
(spherical Moon, so curvature is handled exactly) and store the elevation
angle of the terrain horizon.  The Sun circles the pole once per lunar day and
its sub-solar latitude oscillates +/-1.543 deg over a year, so

    visible fraction of solar disc = clamp((e_sun + r_sun - e_horizon) / 2 r_sun)

  * PSR            : no part of the disc is ever visible, even at mid-summer
  * avg sunlight   : mean visible fraction over all longitudes and seasons
  * Earth visibility: mean visible fraction of Earth's disc over the
                      libration cycle (direct-to-Earth radio link)

Usage: python s02_illumination.py [stride]   (stride>1 = quick preview)
"""
import math
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np
from numba import njit, prange

from common import HALF, N, PROC, R_MOON, S, crop_center, read_ldem

SUN_LAT_MAX = 1.543     # deg, lunar obliquity to the ecliptic
SUN_RADIUS = 0.2666     # deg, apparent solar radius
EARTH_DIST = 384.4e6    # m
EARTH_RADIUS = 0.95     # deg, apparent radius of Earth's disc
LIB_LAT, LIB_LON = 6.68, 7.9  # deg, optical libration amplitudes
K_AZ = 120              # horizon azimuths (3 deg)
MAX_DIST = 210e3        # m


def march_distances():
    d = [S]
    while d[-1] < MAX_DIST:
        d.append(d[-1] + max(S, 0.02 * d[-1]))
    return np.array(d, dtype=np.float64)


@njit(cache=True, fastmath=True)
def sample(dem, row, col):
    n = dem.shape[0]
    if row < 0.0 or col < 0.0 or row > n - 1.001 or col > n - 1.001:
        return -1.0e9
    i, j = int(row), int(col)
    fr, fc = row - i, col - j
    top = dem[i, j] * (1.0 - fc) + dem[i, j + 1] * fc
    bot = dem[i + 1, j] * (1.0 - fc) + dem[i + 1, j + 1] * fc
    return top * (1.0 - fr) + bot * fr


@njit(parallel=True, cache=True, fastmath=True)
def run(dem, n_out, stride, dists, hmax, sun_dec, sun_w, earth_dirs, k_az):
    nf = dem.shape[0]
    R = R_MOON
    m = n_out // stride
    psr = np.zeros((m, m), dtype=np.uint8)
    avg = np.zeros((m, m), dtype=np.float32)
    summer = np.zeros((m, m), dtype=np.float32)
    earth = np.zeros((m, m), dtype=np.float32)
    rs = math.radians(SUN_RADIUS)
    two_pi = 2.0 * math.pi

    for ii in prange(m):
        hor = np.empty(k_az, dtype=np.float64)
        for jj in range(m):
            i = ii * stride + stride // 2
            j = jj * stride + stride // 2
            mx = (j - n_out / 2 + 0.5) * S
            my = (n_out / 2 - i - 0.5) * S
            # unit normal of the sphere at this cell (x -> lon 0, y -> lon 90E)
            rr = math.sqrt(mx * mx + my * my)
            c = 2.0 * math.atan(rr / (2.0 * R))
            sc = math.sin(c)
            lam = math.atan2(mx, my)
            nx, ny, nz = sc * math.cos(lam), sc * math.sin(lam), -math.cos(c)
            hp = sample(dem, i + (nf - n_out) / 2.0, j + (nf - n_out) / 2.0)
            rp = R + hp
            px, py, pz = rp * nx, rp * ny, rp * nz

            # ---- horizon elevation in k_az directions ------------------------
            for k in range(k_az):
                a = two_pi * k / k_az
                vx, vy = math.cos(a), math.sin(a)
                dot = vx * nx + vy * ny
                dx, dy, dz = vx - dot * nx, vy - dot * ny, -dot * nz
                dn = math.sqrt(dx * dx + dy * dy + dz * dz)
                dx, dy, dz = dx / dn, dy / dn, dz / dn
                best = -1.0
                for t in dists:
                    # nothing beyond t can beat the current horizon -> stop
                    if (hmax - hp) / t - t / (2.0 * R) < best - 0.002:
                        break
                    wx, wy, wz = px + t * dx, py + t * dy, pz + t * dz
                    wn = math.sqrt(wx * wx + wy * wy + wz * wz)
                    ux, uy, uz = wx / wn, wy / wn, wz / wn
                    f = 2.0 * R / (1.0 - uz)
                    col = uy * f / S + nf / 2.0 - 0.5
                    row = nf / 2.0 - 0.5 - ux * f / S
                    hq = sample(dem, row, col)
                    if hq < -1.0e8:
                        break
                    rq = R + hq
                    ex, ey, ez = rq * ux - px, rq * uy - py, rq * uz - pz
                    el = (ex * nx + ey * ny + ez * nz) / math.sqrt(ex * ex + ey * ey + ez * ez)
                    if el > best:
                        best = el
                hor[k] = math.asin(best)

            # ---- Sun: sweep longitude x season -------------------------------
            acc = 0.0
            lit_summer = 0.0
            for d in range(sun_dec.shape[0]):
                sd, cd = math.sin(sun_dec[d]), math.cos(sun_dec[d])
                part = 0.0
                for k in range(k_az):
                    a = two_pi * k / k_az
                    e = math.asin(nx * cd * math.cos(a) + ny * cd * math.sin(a) + nz * sd)
                    fr = (e + rs - hor[k]) / (2.0 * rs)
                    if fr > 1.0:
                        fr = 1.0
                    if fr > 0.0:
                        part += fr
                part /= k_az
                acc += part * sun_w[d]
                if d == 0:
                    lit_summer = part
            avg[ii, jj] = acc
            summer[ii, jj] = lit_summer
            psr[ii, jj] = 1 if lit_summer <= 0.0 else 0

            # ---- Earth: sample the libration envelope ------------------------
            vis = 0.0
            re_ = math.radians(EARTH_RADIUS)
            for q in range(earth_dirs.shape[0]):
                gx = earth_dirs[q, 0] - px
                gy = earth_dirs[q, 1] - py
                gz = earth_dirs[q, 2] - pz
                gn = math.sqrt(gx * gx + gy * gy + gz * gz)
                e = math.asin((gx * nx + gy * ny + gz * nz) / gn)
                a = math.atan2(gy, gx)
                if a < 0.0:
                    a += two_pi
                fk = a / two_pi * k_az
                k0 = int(fk) % k_az
                k1 = (k0 + 1) % k_az
                w = fk - int(fk)
                fr = (e + re_ - (hor[k0] * (1.0 - w) + hor[k1] * w)) / (2.0 * re_)
                if fr > 1.0:
                    fr = 1.0
                if fr > 0.0:
                    vis += fr
            earth[ii, jj] = vis / earth_dirs.shape[0]
    return psr, avg, summer, earth


def main():
    stride = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    dem = read_ldem("ldem_75s_240m.img", 3812).astype(np.float32)
    dists = march_distances()

    # seasons: sub-solar latitude = -1.543 deg * cos(phase); index 0 = mid-summer
    nd = 13
    phase = np.linspace(0.0, np.pi, nd)
    sun_dec = np.radians(-SUN_LAT_MAX * np.cos(phase))
    sun_w = np.ones(nd)
    sun_w[0] = sun_w[-1] = 0.5
    sun_w /= sun_w.sum()

    # Earth positions over the libration cycle (Lissajous of lat / lon)
    q = np.linspace(0.0, 2.0 * np.pi, 24, endpoint=False)
    la, lo = np.meshgrid(np.radians(LIB_LAT) * np.sin(q), np.radians(LIB_LON) * np.sin(q + 0.13))
    la, lo = la.ravel(), lo.ravel()
    earth_dirs = EARTH_DIST * np.stack(
        [np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)], axis=1)

    print(f"grid {N // stride}^2, {K_AZ} azimuths, {len(dists)} steps to {dists[-1] / 1000:.0f} km")
    t0 = time.time()
    psr, avg, summer, earth = run(dem, N, stride, dists, float(dem.max()),
                                  sun_dec, sun_w, earth_dirs, K_AZ)
    print(f"done in {time.time() - t0:.0f} s")

    suffix = "" if stride == 1 else f"_s{stride}"
    np.savez_compressed(PROC / f"illumination{suffix}.npz",
                        psr=psr, avg=avg, summer=summer, earth=earth)

    # ---- validation against the published LOLA products ----------------------
    import rasterio
    from common import RAW

    def ref(name):
        with rasterio.open(RAW / name) as ds:
            return crop_center(ds.read(1))[stride // 2::stride, stride // 2::stride]

    ref_psr = ref("LPSR_65S_240M_201608.TIF") > 0
    ref_avg = ref("AVGVISIB_65S_240M_201608.TIF").astype(np.float32) * 0.00004
    ref_earth = ref("AVGVISIB_65S_240M_201608_EARTH.TIF").astype(np.float32) * 0.00004
    mine = psr > 0
    inter, union = (mine & ref_psr).sum(), (mine | ref_psr).sum()
    cell_km2 = (S * stride / 1000.0) ** 2
    print(f"PSR area  ours {mine.sum() * cell_km2:8.0f} km2   NASA {ref_psr.sum() * cell_km2:8.0f} km2")
    print(f"PSR agreement {100 * (mine == ref_psr).mean():.2f} %   IoU {inter / union:.3f}   "
          f"recall {inter / ref_psr.sum():.3f}  precision {inter / mine.sum():.3f}")
    print(f"avg sunlight  r = {np.corrcoef(avg.ravel(), ref_avg.ravel())[0, 1]:.3f}   "
          f"MAE {np.abs(avg - ref_avg).mean():.3f}   (ours {avg.mean():.3f}, NASA {ref_avg.mean():.3f})")
    print(f"Earth vis     r = {np.corrcoef(earth.ravel(), ref_earth.ravel())[0, 1]:.3f}   "
          f"MAE {np.abs(earth - ref_earth).mean():.3f}   (ours {earth.mean():.3f}, NASA {ref_earth.mean():.3f})")


if __name__ == "__main__":
    main()
