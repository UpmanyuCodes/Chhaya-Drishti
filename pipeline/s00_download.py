"""Download the open NASA datasets used by the pipeline into data/raw (about 0.9 GB).

Everything here is public domain and needs no account.
"""
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import RAW

PDS = "https://pds-geosciences.wustl.edu/lro"
PGDA = "https://pgda.gsfc.nasa.gov/data/MoonIllumination"
SVS = "https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720"

FILES = [
    # LOLA laser-altimeter elevation, south-polar stereographic
    f"{PDS}/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/polar/img/ldem_75s_240m.img",
    f"{PDS}/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/polar/img/ldem_80s_80m.img",
    # Diviner Polar Resource Product: temperatures + depth to stable ice
    f"{PDS}/lro-l-dlre-4-rdr-v1/lrodlr_1001/data/prp/dlre_prp_south.tab",
    # published illumination products (used only to validate our own model)
    f"{PGDA}/LPSR_65S_240M_201608.TIF",
    f"{PGDA}/AVGVISIB_65S_240M_201608.TIF",
    f"{PGDA}/AVGVISIB_65S_240M_201608_EARTH.TIF",
    # global colour + elevation for the orbital view
    f"{SVS}/lroc_color_poles_4k.tif",
    f"{SVS}/ldem_16.tif",
]


def main():
    RAW.mkdir(parents=True, exist_ok=True)
    for url in FILES:
        dest = RAW / url.rsplit("/", 1)[1]
        if dest.exists() and dest.stat().st_size > 0:
            print(f"  have  {dest.name}")
            continue
        print(f"  fetch {dest.name} ...", end="", flush=True)
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        tmp = dest.with_suffix(dest.suffix + ".part")
        with urllib.request.urlopen(req) as r, open(tmp, "wb") as f:
            while chunk := r.read(1 << 20):
                f.write(chunk)
        tmp.rename(dest)
        print(f" {dest.stat().st_size / 1e6:.0f} MB")


if __name__ == "__main__":
    main()
