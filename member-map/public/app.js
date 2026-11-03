// The member map page: OSM tiles, block-group gap shading, the EPC outline, member/lead/org dots
// and bike lanes. Leaflet is the global `L` (classic script in index.html, loaded before this
// deferred module). Monday-derived strings reach the DOM only through format.js's escaping or
// as text nodes.
import { blockGroupSummary, pointPopupHtml, statusLine } from './js/format.js';

const css = getComputedStyle(document.documentElement);
const color = (name) => css.getPropertyValue(`--${name}`).trim();
const GAP_OPACITY = Number(color('gap-opacity')) || 0.6;

const LEGENDS = {
  pop: 'Darker = fewer members per resident. Unshaded: no gap, or under 100 residents.',
  lead: 'Darker = more warm leads (lapsed and never members) living there. Unshaded: no gap, or under 100 residents.',
  bike: 'Darker = fewer bike facilities per street mile. Unshaded: no gap, or under 100 residents.',
  none: 'No shading. Click a neighborhood for its numbers.',
};

const state = { shading: 'pop', snapshot: null, blockGroups: null, epc: null, lanes: null, lanesLoading: null };
const layers = { members: L.featureGroup(), leads: L.featureGroup(), orgs: L.featureGroup() };

const map = L.map('map', { preferCanvas: true, zoomControl: true });
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

// ── Block-group shading ──────────────────────────────────────────────────────────────────────

function gapClass(props) {
  if (state.shading === 'bike') return props.bikeClass;
  const counts = state.snapshot?.blockGroups?.[props.GEOID];
  if (state.shading === 'pop') return counts?.popClass ?? null;
  if (state.shading === 'lead') return counts?.leadClass ?? null;
  return null;
}

function blockGroupStyle(feature) {
  const cls = gapClass(feature.properties);
  const base = { color: color('bg-border'), weight: 0.5, opacity: 0.8, fill: true };
  if (cls === 1 || cls === 2 || cls === 3) return { ...base, fillColor: color(`gap-${cls}`), fillOpacity: GAP_OPACITY };
  return { ...base, fillOpacity: 0 }; // class 0 or unscored: hairline border only, still clickable
}

function blockGroupPopup(props) {
  const box = document.createElement('div');
  const title = document.createElement('strong');
  title.textContent = `Block group ${props.GEOID}`;
  const body = document.createElement('p');
  body.className = 'bg-summary';
  body.textContent = blockGroupSummary(props, state.snapshot?.blockGroups?.[props.GEOID]);
  box.append(title, body);
  return box;
}

function setShading(value) {
  state.shading = value;
  document.getElementById('legend-text').textContent = LEGENDS[value];
  document.getElementById('legend-swatches').hidden = value === 'none';
  state.blockGroups?.setStyle(blockGroupStyle);
}

// ── Overlays (EPC, bike lanes) ───────────────────────────────────────────────────────────────

const LANE_STYLE = {
  1: { color: color('lane-1') },
  2: { color: color('lane-2') },
  3: { color: color('lane-3'), dashArray: '4 4' },
  4: { color: color('lane-4') },
};

async function getJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function loadLanes() {
  state.lanesLoading ??= getJson('data/bikelanes.geojson').then((data) => {
    state.lanes = L.geoJSON(data, {
      interactive: false,
      style: (f) => ({ weight: 2, opacity: 0.9, ...(LANE_STYLE[f.properties.class] ?? LANE_STYLE[3]) }),
    });
    return state.lanes;
  });
  return state.lanesLoading;
}

// All vector layers share one canvas, so draw order is add order. Keep shading at the bottom,
// then lanes, the EPC outline, and the dots on top.
function restack() {
  for (const layer of [state.lanes, state.epc, layers.leads, layers.members]) {
    if (layer && map.hasLayer(layer)) layer.bringToFront();
  }
}

async function setLayer(name, on) {
  let layer;
  if (name === 'lanes') {
    document.getElementById('lane-key').hidden = !on;
    layer = on ? await loadLanes().catch(() => null) : state.lanes;
    if (on && !layer) { showStatus('Bike lanes failed to load. Reload the page to try again.'); return; }
  } else if (name === 'epc') {
    layer = state.epc;
  } else {
    layer = layers[name];
  }
  if (!layer) return;
  const wanted = document.querySelector(`input[name="layer"][value="${name}"]`)?.checked;
  if (wanted && !map.hasLayer(layer)) layer.addTo(map);
  if (!wanted && map.hasLayer(layer)) map.removeLayer(layer);
  restack();
}

// ── Dots ─────────────────────────────────────────────────────────────────────────────────────

const orgIcon = L.divIcon({ className: 'org-marker', iconSize: [8, 8] });

function buildPoints(snapshot) {
  for (const p of snapshot.points) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;
    let marker;
    if (p.kind === 'org') {
      marker = L.marker([p.lat, p.lng], { icon: orgIcon });
      layers.orgs.addLayer(marker);
    } else {
      const fill = p.kind === 'member' ? color('dot-member') : color('dot-lead');
      marker = L.circleMarker([p.lat, p.lng], { radius: 4, color: '#ffffff', weight: 1, fillColor: fill, fillOpacity: 0.9 });
      (p.kind === 'member' ? layers.members : layers.leads).addLayer(marker);
    }
    marker.bindPopup(() => pointPopupHtml(p, snapshot.accountUrl));
  }
}

// ── Status line and the first-run refresh ────────────────────────────────────────────────────

function showStatus(text) {
  document.getElementById('status').textContent = text;
}

function showNoData() {
  const status = document.getElementById('status');
  status.textContent = 'No data yet. The first weekly refresh hasn’t run.';
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Refresh now';
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const res = await fetch('api/refresh', { method: 'POST' });
      if (res.status === 202) showStatus('Refresh started. Reload this page in a few minutes.');
      else if (res.status === 429) showStatus('A refresh is already running or ran in the last 10 minutes. Reload this page in a few minutes.');
      else { showStatus(`Refresh failed (HTTP ${res.status}).`); }
    } catch {
      showStatus('Refresh failed: the network request didn’t complete.');
    }
  });
  status.append(' ', button);
}

async function loadSnapshot() {
  let res;
  try {
    res = await fetch('api/snapshot', { headers: { Accept: 'application/json' } });
  } catch {
    showStatus('Couldn’t load the member data: the network request didn’t complete.');
    return;
  }
  if (res.status === 503) { showNoData(); return; }
  if (!res.ok) { showStatus(`Couldn’t load the member data (HTTP ${res.status}).`); return; }
  state.snapshot = await res.json();
  showStatus(statusLine(state.snapshot));
  buildPoints(state.snapshot);
}

// ── Controls ─────────────────────────────────────────────────────────────────────────────────

function wireControls() {
  for (const radio of document.querySelectorAll('input[name="shading"]')) {
    radio.addEventListener('change', () => radio.checked && setShading(radio.value));
  }
  for (const box of document.querySelectorAll('input[name="layer"]')) {
    box.addEventListener('change', () => setLayer(box.value, box.checked));
  }
  const toggle = document.getElementById('panel-toggle');
  const panel = document.getElementById('panel');
  const setOpen = (open) => {
    panel.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', String(open));
  };
  toggle.addEventListener('click', () => setOpen(!panel.classList.contains('open')));
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panel.classList.contains('open')) { setOpen(false); toggle.focus(); }
  });
}

async function main() {
  wireControls();
  setShading(document.querySelector('input[name="shading"]:checked')?.value ?? 'pop');

  const [bg, epc] = await Promise.all([
    getJson('data/blockgroups.geojson'),
    getJson('data/epc.geojson').catch(() => null),
    loadSnapshot().catch(() => showStatus('Couldn\u2019t read the member data. Reload the page to try again.')),
  ]).catch(() => [null, null]);
  if (!bg) { showStatus('Couldn’t load the neighborhood boundaries. Reload the page to try again.'); return; }

  state.blockGroups = L.geoJSON(bg, { style: blockGroupStyle })
    .bindPopup((layer) => blockGroupPopup(layer.feature.properties))
    .addTo(map);
  map.fitBounds(state.blockGroups.getBounds());

  if (epc) {
    state.epc = L.geoJSON(epc, { interactive: false, style: { color: color('epc'), weight: 3, opacity: 0.9, fill: false } });
  }
  for (const box of document.querySelectorAll('input[name="layer"]')) {
    if (box.checked) await setLayer(box.value, true);
  }
}

main();
