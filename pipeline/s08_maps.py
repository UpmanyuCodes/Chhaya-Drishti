"""Static map deliverables (PNG) for reports and slides -> outputs/maps/.

  01_elevation.png   02_slope.png   03_hillshade.png
  04_psr.png         05_ice_potential.png
  06_landing_suitability.png        07_rover_routes.png
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import json

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.colors import LinearSegmentedColormap

from common import FEATURES, HALF, MAPS, N, PROC, latlon_to_xy

EXT = [-HALF / 1000, HALF / 1000, -HALF / 1000, HALF / 1000]
BG = "#05070d"


def cmap(name, stops):
    return LinearSegmentedColormap.from_list(name, stops)


ELEV = cmap("elev", ["#1a1440", "#233f8f", "#2b7fa8", "#58b79a", "#c9d48a", "#e0a35c", "#b86a4a", "#f4efe9"])
SLOPE = cmap("slope", [(0, "#0d2a3a"), (0.125, "#1f7a6b"), (0.25, "#9bcf5a"), (0.375, "#f4d03f"),
                       (0.5, "#f08a2c"), (0.75, "#cf2f45"), (1, "#7a1040")])
ICE = cmap("ice", ["#0b1030", "#16307a", "#2f8cff", "#6fe3ff", "#ffffff"])
LAND = cmap("land", ["#2a1740", "#3f3f9f", "#2f9f8f", "#a6e05a", "#ffe45c"])


def base(title, subtitle):
    fig, ax = plt.subplots(figsize=(10, 10.6), dpi=150, facecolor=BG)
    ax.set_facecolor(BG)
    ax.set_title(title, color="white", fontsize=17, fontweight="bold", loc="left", pad=26)
    ax.text(0, 1.012, subtitle, transform=ax.transAxes, color="#9fb0c8", fontsize=9.5)
    ax.set_xlabel("km  (toward 90°E →)", color="#9fb0c8")
    ax.set_ylabel("km  (toward Earth, 0° ↑)", color="#9fb0c8")
    ax.tick_params(colors="#9fb0c8")
    for s in ax.spines.values():
        s.set_color("#2a3550")
    return fig, ax


def decorate(ax, labels=True):
    # latitude circles
    th = np.linspace(0, 2 * np.pi, 361)
    for lat in (-88, -86, -84):
        r = np.hypot(*latlon_to_xy(lat, 0)) / 1000
        ax.plot(r * np.cos(th), r * np.sin(th), color="white", lw=0.4, alpha=0.25)
        ax.text(0, -r, f"{-lat}°S", color="white", alpha=0.5, fontsize=7, ha="center", va="bottom", clip_on=True)
    if labels:
        for name, lat, lon, diam, kind in FEATURES:
            x, y = latlon_to_xy(lat, lon)
            if abs(x) < HALF and abs(y) < HALF:
                ax.text(x / 1000, y / 1000, name, color="white", fontsize=6.5, ha="center", va="center",
                        alpha=0.85, path_effects=_outline())
    ax.set_xlim(EXT[0], EXT[1])
    ax.set_ylim(EXT[2], EXT[3])


def _outline():
    import matplotlib.patheffects as pe
    return [pe.withStroke(linewidth=1.6, foreground="black")]


def save(fig, name, im=None, label=None):
    if im is not None:
        cb = fig.colorbar(im, ax=fig.axes[0], fraction=0.035, pad=0.02)
        cb.set_label(label, color="#9fb0c8")
        cb.ax.tick_params(colors="#9fb0c8")
        cb.outline.set_edgecolor("#2a3550")
    fig.savefig(MAPS / name, facecolor=BG, bbox_inches="tight")
    plt.close(fig)
    print(f"  {name}")


def main():
    MAPS.mkdir(parents=True, exist_ok=True)
    ter = np.load(PROC / "terrain.npz")
    ill = np.load(PROC / "illumination.npz")
    ice = np.load(PROC / "ice.npz")["index"]
    land = np.load(PROC / "landing.npz")["score"]
    sites = json.loads((PROC / "landing.json").read_text())["sites"]
    routes = json.loads((PROC / "paths.json").read_text())["routes"]
    hs = ter["hillshade"]
    shade = 0.45 + 0.55 * hs
    src = "Data: NASA LRO LOLA / Diviner · south-polar stereographic, 240 m per pixel"

    def rgb(c, data, lo, hi):
        col = c(np.clip((data - lo) / (hi - lo), 0, 1))[..., :3]
        return col * shade[..., None]

    def to_km(row, col):
        return (np.asarray(col) - N / 2 + 0.5) * 0.24, (N / 2 - np.asarray(row) - 0.5) * 0.24

    print("maps:")
    fig, ax = base("Elevation", src)
    ax.imshow(rgb(ELEV, ter["elev"], -6700, 7100), extent=EXT)
    decorate(ax)
    save(fig, "01_elevation.png", plt.cm.ScalarMappable(plt.Normalize(-6.7, 7.1), ELEV), "km above reference sphere")

    fig, ax = base("Slope", src + " · 80 m baseline")
    ax.imshow(rgb(SLOPE, ter["slope"], 0, 40), extent=EXT)
    decorate(ax)
    save(fig, "02_slope.png", plt.cm.ScalarMappable(plt.Normalize(0, 40), SLOPE), "degrees")

    fig, ax = base("Hillshade", src + " · Sun azimuth 315°, altitude 45°")
    ax.imshow(hs, cmap="gray", extent=EXT, vmin=0, vmax=1)
    decorate(ax)
    save(fig, "03_hillshade.png")

    psr = ill["psr"] > 0
    fig, ax = base("Permanently shadowed regions", src + " · horizon-method illumination model")
    img = np.dstack([hs * 0.55] * 3)
    img[psr] = np.array([0.20, 0.62, 1.0]) * (0.55 + 0.45 * hs[psr, None])
    ax.imshow(img, extent=EXT)
    decorate(ax)
    save(fig, "04_psr.png")

    fig, ax = base("Water-ice potential index", src + " · temperature 45 %, depth 30 %, shadow 25 %")
    col = ICE(np.clip(ice, 0, 1))[..., :3]
    a = np.clip((ice - 0.3) / 0.2, 0, 1)[..., None]
    ax.imshow((col * a + np.dstack([hs * 0.5] * 3) * (1 - a)) * (0.6 + 0.4 * hs[..., None]), extent=EXT)
    decorate(ax)
    save(fig, "05_ice_potential.png", plt.cm.ScalarMappable(plt.Normalize(0, 1), ICE), "index (0-1)")

    def sites_on(ax):
        for s in sites:
            x, y = to_km(s["row"], s["col"])
            ax.plot(x, y, "o", ms=13, mfc="#ffc857", mec="black", mew=1)
            ax.text(x, y, str(s["id"]), color="black", fontsize=8, fontweight="bold", ha="center", va="center")

    fig, ax = base("Landing-site suitability", src + " · numbered = ranked candidate sites")
    col = LAND(np.clip((land - 0.3) / 0.45, 0, 1))[..., :3]
    a = (land > 0.05)[..., None]
    ax.imshow(np.where(a, col, np.dstack([hs * 0.5] * 3)) * (0.6 + 0.4 * hs[..., None]), extent=EXT)
    decorate(ax, labels=False)
    sites_on(ax)
    save(fig, "06_landing_suitability.png", plt.cm.ScalarMappable(plt.Normalize(0.3, 0.75), LAND), "score")

    # one panel per site: the traverse from the lander to its ice target
    img = np.dstack([hs * 0.62] * 3)
    img[psr] = np.array([0.16, 0.45, 0.85]) * (0.5 + 0.5 * hs[psr, None])
    fig, axes = plt.subplots(2, 4, figsize=(16, 8.9), dpi=150, facecolor=BG)
    fig.suptitle("Rover traverses to ice", color="white", fontsize=17, fontweight="bold", x=0.02, ha="left")
    fig.text(0.02, 0.925, src + " · least-cost routes, 15° slope limit · blue = permanent shadow",
             color="#9fb0c8", fontsize=9.5)
    by_site = {r["site"]: r for r in routes}
    for ax, s in zip(axes.ravel(), sites):
        r = by_site.get(s["id"], {})
        ax.set_facecolor(BG)
        ax.imshow(img, extent=EXT)
        x0, y0 = to_km(s["row"], s["col"])
        half = 6.0
        if r.get("found"):
            x, y = to_km(r["rows"], r["cols"])
            ax.plot(x, y, color="#ffc857", lw=2.6, solid_capstyle="round")
            ax.plot(x[-1], y[-1], "*", ms=15, mfc="#7fe3ff", mec="black", mew=0.7)
            cx, cy = (x.min() + x.max()) / 2, (y.min() + y.max()) / 2
            half = max(6.0, 0.75 * max(np.ptp(x), np.ptp(y)) + 3.0)
            title = f"{r['length_km']:.1f} km · max {r['max_slope_deg']:.0f}° · goal {r['target_tmax_K']:.0f} K"
        else:
            cx, cy, title = x0, y0, "no route"
        ax.plot(x0, y0, "o", ms=15, mfc="#ffc857", mec="black", mew=1)
        ax.text(x0, y0, str(s["id"]), color="black", fontsize=9, fontweight="bold", ha="center", va="center")
        ax.set_xlim(cx - half, cx + half)
        ax.set_ylim(cy - half, cy + half)
        ax.set_title(f"{s['id']}  {s['name']}\n{title}", color="white", fontsize=10, loc="left")
        ax.tick_params(colors="#9fb0c8", labelsize=7)
        for sp in ax.spines.values():
            sp.set_color("#2a3550")
    fig.tight_layout(rect=(0, 0, 1, 0.91), h_pad=3.5)
    fig.savefig(MAPS / "07_rover_routes.png", facecolor=BG)
    plt.close(fig)
    print("  07_rover_routes.png")

if __name__ == "__main__":
    main()
