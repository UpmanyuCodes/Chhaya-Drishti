"""Shared grid definition, projection helpers and readers for the pipeline.

Analysis grid
-------------
All analysis products live on one grid: the central N x N pixels of the LOLA
south-polar stereographic grid at 240 m/pixel (true scale at the pole).

    row i (0 = top), column j (0 = left)
    map_x = (j - N/2 + 0.5) * S      -> points toward longitude 90 E
    map_y = (N/2 - i - 0.5) * S      -> points toward longitude 0 (Earth side)

N = 2000 gives a 480 km x 480 km window centred on the pole (edges ~82.1 S).
"""
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
PROC = ROOT / "data" / "processed"
WEB_DATA = ROOT / "web" / "public" / "data"
WEB_TEX = ROOT / "web" / "public" / "textures"
MAPS = ROOT / "outputs" / "maps"

R_MOON = 1737400.0  # m, LOLA reference sphere
S = 240.0           # m / pixel
N = 2000            # analysis grid size
HALF = N * S / 2.0  # 240 km


def crop_center(arr, n=N):
    """Central n x n window of a pole-centred square grid."""
    c = arr.shape[0] // 2
    h = n // 2
    return arr[c - h:c + h, c - h:c + h]


def read_ldem(name, size):
    """LOLA polar LDEM .img: int16 LSB, height = DN * 0.5 m above 1737.4 km."""
    dn = np.fromfile(RAW / name, dtype="<i2").reshape(size, size)
    return dn.astype(np.float32) * 0.5


def grid_xy(n=N, s=S):
    """Map-plane coordinates (metres) of pixel centres."""
    idx = np.arange(n, dtype=np.float64)
    x = (idx - n / 2 + 0.5) * s
    y = (n / 2 - idx - 0.5) * s
    return np.meshgrid(x, y)  # X[i, j], Y[i, j]


def xy_to_latlon(x, y):
    r = np.hypot(x, y)
    colat = 2.0 * np.arctan(r / (2.0 * R_MOON))
    lat = -90.0 + np.degrees(colat)
    lon = np.degrees(np.arctan2(x, y))
    return lat, lon


def latlon_to_xy(lat, lon):
    colat = np.radians(90.0 + np.asarray(lat, dtype=np.float64))
    r = 2.0 * R_MOON * np.tan(colat / 2.0)
    lam = np.radians(lon)
    return r * np.sin(lam), r * np.cos(lam)


def xy_to_rc(x, y, n=N, s=S):
    """Map metres -> fractional (row, col)."""
    return n / 2 - 0.5 - np.asarray(y) / s, np.asarray(x) / s + n / 2 - 0.5


def latlon_to_rc(lat, lon, n=N, s=S):
    x, y = latlon_to_xy(lat, lon)
    return xy_to_rc(x, y, n, s)


def scale_factor(x, y):
    """Stereographic linear scale k (map distance / true distance)."""
    r = np.hypot(x, y)
    colat = 2.0 * np.arctan(r / (2.0 * R_MOON))
    return 2.0 / (1.0 + np.cos(colat))


# Named features inside the window (IAU planetocentric lat, east lon, diameter km)
FEATURES = [
    ("Shackleton", -89.67, 129.20, 21.0, "crater"),
    ("de Gerlache", -88.50, -87.10, 32.7, "crater"),
    ("Shoemaker", -88.10, 44.90, 51.8, "crater"),
    ("Haworth", -87.50, -5.20, 51.4, "crater"),
    ("Faustini", -87.20, 84.30, 42.5, "crater"),
    ("Sverdrup", -88.30, -152.00, 32.8, "crater"),
    ("Slater", -88.10, 111.30, 25.1, "crater"),
    ("Nobile", -85.30, 53.30, 79.3, "crater"),
    ("Amundsen", -84.50, 82.80, 103.4, "crater"),
    ("Cabeus", -85.30, -42.10, 100.6, "crater"),
    ("Malapert", -84.90, 12.90, 69.0, "crater"),
    ("Mons Mouton", -84.60, -31.00, 100.0, "massif"),
    ("Malapert Massif", -85.99, -0.20, 50.0, "massif"),
    ("Wiechert", -84.00, 165.00, 41.0, "crater"),
    ("Idel'son L", -84.20, 115.80, 28.0, "crater"),
    ("Kocher", -84.50, -134.00, 24.0, "crater"),
    ("Ibn Bajja", -86.30, -72.80, 12.0, "crater"),
    ("Scott", -82.50, 48.50, 107.8, "crater"),
]

# Reference points of interest (name, lat, lon, note)
POIS = [
    ("LCROSS impact", -84.675, -48.725,
     "2009 impactor: water detected in the ejecta plume (5.6 +/- 2.9 wt%)"),
    ("IM-2 Athena", -84.79, -29.20, "2025 lander, Mons Mouton"),
]
