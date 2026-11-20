/**
 * Splits bike facility polylines at county and city boundaries
 *
 * A single MTC feature can run across a county or city line (a creek trail,
 * an arterial between two cities). Attributing the whole feature to the
 * place under one of its points miscounts the rest of it, and features
 * entirely outside both counties must be dropped rather than assigned to the
 * nearest one. So each polyline is cut wherever it crosses any boundary
 * edge, and each resulting piece is attributed by testing a point inside it.
 *
 * Geometry is planar in lon/lat, which is accurate enough for intersection
 * tests at this scale; lengths still use the haversine distance.
 */

const { pointInPolygon } = require('./cityBoundaries');

// Grid cell size in degrees for the boundary-edge index (~0.5 km)
const CELL = 0.005;

function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 3958.8; // Earth's radius in miles
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function ringsBbox(rings) {
  let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
  for (const ring of rings) {
    for (const [x, y] of ring) {
      if (x < xmin) xmin = x;
      if (x > xmax) xmax = x;
      if (y < ymin) ymin = y;
      if (y > ymax) ymax = y;
    }
  }
  return { xmin, ymin, xmax, ymax };
}

/**
 * Even-odd test across all of a polygon's rings, so Esri holes (and
 * multipart polygons delivered as one ring list) are handled correctly.
 */
function pointInRings(x, y, area) {
  const { bbox, rings } = area;
  if (x < bbox.xmin || x > bbox.xmax || y < bbox.ymin || y > bbox.ymax) {
    return false;
  }
  let inside = false;
  for (const ring of rings) {
    if (pointInPolygon(x, y, ring)) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Build the attribution index from county boundaries ({ name: { rings } })
 * and city boundaries ([{ name, county, polygons: [rings, ...] }]).
 */
function buildBoundaryIndex(countyBoundaries, cityBoundaries) {
  const counties = Object.values(countyBoundaries).map(county => ({
    name: county.name,
    rings: county.rings,
    bbox: ringsBbox(county.rings)
  }));

  const cities = [];
  for (const city of cityBoundaries) {
    for (const rings of city.polygons) {
      cities.push({ name: city.name, county: city.county, rings, bbox: ringsBbox(rings) });
    }
  }

  // Index every boundary edge by the grid cells its bounding box covers
  const grid = new Map();
  const addEdges = rings => {
    for (const ring of rings) {
      for (let i = 0; i < ring.length - 1; i++) {
        const edge = [ring[i][0], ring[i][1], ring[i + 1][0], ring[i + 1][1]];
        forEachCell(edge[0], edge[1], edge[2], edge[3], key => {
          let bucket = grid.get(key);
          if (!bucket) {
            bucket = [];
            grid.set(key, bucket);
          }
          bucket.push(edge);
        });
      }
    }
  };
  counties.forEach(county => addEdges(county.rings));
  cities.forEach(city => addEdges(city.rings));

  return { counties, cities, grid };
}

function forEachCell(x1, y1, x2, y2, fn) {
  const cx1 = Math.floor(Math.min(x1, x2) / CELL);
  const cx2 = Math.floor(Math.max(x1, x2) / CELL);
  const cy1 = Math.floor(Math.min(y1, y2) / CELL);
  const cy2 = Math.floor(Math.max(y1, y2) / CELL);
  for (let cx = cx1; cx <= cx2; cx++) {
    for (let cy = cy1; cy <= cy2; cy++) {
      fn(`${cx},${cy}`);
    }
  }
}

/**
 * Parameters t in (0, 1) where segment p->q crosses a boundary edge, plus
 * whether either endpoint lies on an edge (a vertex sitting exactly on a
 * boundary, so the next piece's place must be re-tested)
 */
function crossings(px, py, qx, qy, grid) {
  const seen = new Set();
  const ts = [];
  let touches = false;
  forEachCell(px, py, qx, qy, key => {
    const bucket = grid.get(key);
    if (!bucket) return;
    for (const edge of bucket) {
      if (seen.has(edge)) continue;
      seen.add(edge);
      const [ax, ay, bx, by] = edge;
      const rx = qx - px, ry = qy - py;
      const sx = bx - ax, sy = by - ay;
      const denom = rx * sy - ry * sx;
      if (denom === 0) continue; // Parallel or collinear: no single crossing point
      const t = ((ax - px) * sy - (ay - py) * sx) / denom;
      const u = ((ax - px) * ry - (ay - py) * rx) / denom;
      if (u < 0 || u > 1 || t < 0 || t > 1) continue;
      if (t > 0 && t < 1) {
        ts.push(t);
      } else {
        touches = true;
      }
    }
  });
  return { ts: ts.sort((a, b) => a - b), touches };
}

/**
 * County and city for a point. Returns null outside both counties; city is
 * 'Unincorporated' inside a county but outside all of its cities.
 */
function locate(x, y, index) {
  const county = index.counties.find(c => pointInRings(x, y, c));
  if (!county) return null;
  const city = index.cities.find(c => c.county === county.name && pointInRings(x, y, c));
  return { county: county.name, city: city ? city.name : 'Unincorporated' };
}

/**
 * Split a feature's paths at every boundary crossing and return its miles
 * per place: [{ county, city, miles }]. Parts outside both counties are
 * dropped. Location is only re-tested after a crossing, since a run of
 * vertices between two crossings can't change place.
 */
function attributePolyline(paths, index) {
  const totals = new Map();
  const add = (place, miles) => {
    if (!place || miles === 0) return;
    const key = `${place.county}\u0000${place.city}`;
    const entry = totals.get(key);
    if (entry) {
      entry.miles += miles;
    } else {
      totals.set(key, { county: place.county, city: place.city, miles });
    }
  };

  for (const path of paths) {
    let place;
    let needsLocate = true;

    for (let i = 0; i < path.length - 1; i++) {
      const [px, py] = path[i];
      const [qx, qy] = path[i + 1];
      const { ts, touches } = crossings(px, py, qx, qy, index.grid);
      const cuts = [0, ...ts, 1];
      if (touches) needsLocate = true;

      for (let k = 0; k < cuts.length - 1; k++) {
        const t0 = cuts[k], t1 = cuts[k + 1];
        if (t1 === t0) continue;
        const x0 = px + (qx - px) * t0, y0 = py + (qy - py) * t0;
        const x1 = px + (qx - px) * t1, y1 = py + (qy - py) * t1;
        if (needsLocate || k > 0) {
          place = locate((x0 + x1) / 2, (y0 + y1) / 2, index);
          needsLocate = false;
        }
        add(place, haversineDistance(y0, x0, y1, x1));
      }
      if (touches) needsLocate = true;
    }
  }

  return [...totals.values()];
}

module.exports = {
  buildBoundaryIndex,
  attributePolyline,
  haversineDistance
};
