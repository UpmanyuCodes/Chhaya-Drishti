"""Run the whole analysis: download -> terrain -> shadow/ice -> landing/rover -> web export.

    python pipeline/run_all.py            # everything (first run downloads ~0.9 GB)
    python pipeline/run_all.py --from 4   # resume from a stage number
"""
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
STAGES = [
    ("s00_download.py", "download NASA source data"),
    ("s01_terrain.py", "stage 1 - elevation, slope, hillshade"),
    ("s02_illumination.py", "stage 2 - permanent shadow and sunlight (about 15 min)"),
    ("s03_diviner.py", "stage 2 - Diviner temperatures"),
    ("s04_ice.py", "stage 2 - ice potential index"),
    ("s05_landing.py", "stage 3 - landing-site suitability"),
    ("s06_paths.py", "stage 3 - rover routes"),
    ("s07_export.py", "export textures and metadata for the website"),
    ("s08_maps.py", "static PNG maps"),
]


def main():
    start = int(sys.argv[sys.argv.index("--from") + 1]) if "--from" in sys.argv else 0
    for i, (script, what) in enumerate(STAGES):
        if i < start:
            continue
        print(f"\n=== [{i}] {what} ===", flush=True)
        # -I: isolated mode, so nothing in the data folders can be imported as code
        subprocess.run([sys.executable, "-I", str(HERE / script)], check=True)
    print("\nAll done. Start the site with:  cd web && npm install && npm run dev")


if __name__ == "__main__":
    main()
