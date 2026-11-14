const nf = (v) => Number(v).toLocaleString('en-US');

/** Content of the "Data & method" dialog. */
export function aboutHtml(meta) {
  const il = meta.illumination, t = meta.terrain;
  return `
  <p class="eyebrow">Data &amp; method</p>
  <h2>How this map was made</h2>
  <p>Everything shown is computed from open, public-domain measurements by NASA’s Lunar Reconnaissance Orbiter (LRO). The study area is a ${nf(t.area_km2)} km² window centred on the south pole (to ${Math.abs(meta.grid.edge_lat)}°S), analysed on a ${meta.grid.cell_m} m grid of ${nf(meta.grid.n * meta.grid.n)} cells.</p>

  <h3>Why LRO data instead of Chandrayaan-2</h3>
  <p>Chandrayaan-2 products (TMC-2 terrain, OHRC imagery, DFSAR radar) are published through ISRO’s PRADAN portal, which needs a registered account and delivers individual orbit strips rather than a seamless polar mosaic. LRO offers the same kinds of measurement as ready-made polar grids, so the whole pipeline runs on free downloads. The method is sensor-agnostic: a Chandrayaan-2 DEM can be dropped into stage 1 unchanged.</p>

  <h3>Sources</h3>
  <table>
    <tr><th>Dataset</th><th>Used for</th></tr>
    <tr><td><a href="https://pds-geosciences.wustl.edu/missions/lro/lola.htm" target="_blank" rel="noopener">LOLA polar DEM</a> · 240 m and 80 m</td><td>Elevation, slope, hillshade, shadow modelling, routing</td></tr>
    <tr><td><a href="https://pds-geosciences.wustl.edu/missions/lro/diviner.htm" target="_blank" rel="noopener">Diviner Polar Resource Product</a></td><td>Maximum temperature, depth to stable ice</td></tr>
    <tr><td><a href="https://pgda.gsfc.nasa.gov/products/69" target="_blank" rel="noopener">LOLA illumination &amp; PSR maps</a> (Mazarico et al.)</td><td>Independent check of our shadow model</td></tr>
    <tr><td><a href="https://svs.gsfc.nasa.gov/4720" target="_blank" rel="noopener">NASA SVS CGI Moon Kit</a></td><td>Global colour and relief for the orbital view</td></tr>
  </table>

  <h3>Stage 1 · Terrain</h3>
  <p>Slope is measured on the 80 m elevation model and summarised per 240 m cell (mean and steepest facet). Hillshade uses a Sun at azimuth 315°, altitude 45°.</p>

  <h3>Stage 2 · Shadow and ice</h3>
  <p><b>Permanent shadow.</b> For every cell we trace the terrain horizon in 120 directions out to 210 km on a spherical Moon, then sweep the Sun through a full lunar day at every season (sub-solar latitude ±1.54°). A cell is permanently shadowed if no part of the solar disc ever clears its horizon.</p>
  <p><b>Check.</b> The result agrees with NASA’s published PSR map on ${il.psr_agreement_pct} % of cells (IoU ${il.psr_iou}; ${nf(il.psr_area_km2)} km² vs ${nf(il.nasa_psr_area_km2)} km²). Average sunlight correlates at r = ${il.sunlight_r}, Earth visibility at r = ${il.earth_r}.</p>
  <p><b>Ice potential index</b> = 0.45 × temperature score + 0.30 × subsurface-stability score + 0.25 × permanent-shadow score. Water ice sublimates slower than 1 mm per billion years below about 110 K (Paige et al. 2010).</p>
  <p><b>Live sunlight</b> in the 3D view is ray-marched on your graphics card each time the Sun moves, using the same elevation data.</p>

  <h3>Stage 3 · Landing and rover</h3>
  <p><b>Landing score</b> = 0.30 safety + 0.30 science + 0.25 power + 0.15 comms, after hard exclusions (permanent shadow, under 25 % sunlight, less than 85 % of a 500 m footprint below 10°, more than 6° from the pole).</p>
  <p><b>Routes</b> are least-cost paths (A* / Dijkstra) on the 240 m grid. Cost = distance × (1 + (slope / 10°)²) × (1 + shadow-avoidance × darkness); cells steeper than the rover limit are impassable. The planner runs live in your browser, so you can move the sliders and replan.</p>

  <h3>Limits to keep in mind</h3>
  <ul>
    <li>The ice map shows where ice <em>can persist</em>. It is not a detection of ice.</li>
    <li>At 240 m per cell, boulders and small craters are invisible; a real mission would re-check the chosen site with metre-scale imagery.</li>
    <li>Shadows near the edge of the window ignore terrain outside it in the live view (the analysis layers use a wider DEM).</li>
    <li>Drive times assume continuous driving at 10 cm/s and ignore charging and communication stops.</li>
  </ul>

  <p class="credits">Team Tha Hack Pack · Chhaya Drishti (छाया दृष्टि, “shadow vision”). Data courtesy NASA / GSFC / MIT (LOLA), NASA / UCLA (Diviner), NASA Scientific Visualization Studio.</p>`;
}
