// The staff search page: one self-contained HTML document (inline CSS and script, Leaflet and turf
// from pinned CDN versions). The organizer types a location or arrives from an Events row, previews
// the matches on a map, and only then confirms. The map is drawn from /api/preview, and the search
// area is re-drawn with the same turf.buffer the server used, so what is seen is what is searched.
// All data reaches the DOM through textContent / setAttribute, never innerHTML.

export interface PageEvent {
  eventItemId: string;
  eventName: string;
  address: string;
  miles: number;
}

export interface PageInit {
  event?: PageEvent;
  notice?: string;
}

// Safe inside <script>: `<` (so </script> and <!--) and the two JS line separators are escaped.
function embedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

const STYLE = `
  :root { color-scheme: light dark; --bg:#fff; --fg:#1c1c1c; --muted:#5b5b5b; --line:#c9c9c9; --accent:#0b5cad; --warn:#8a4b00; --err:#b00020; }
  @media (prefers-color-scheme: dark) { :root { --bg:#16181b; --fg:#ececec; --muted:#a3a3a3; --line:#3a3d42; --accent:#6aa9ff; --warn:#f0b35a; --err:#ff8a9b; } }
  body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.45 system-ui, sans-serif; }
  main { max-width:960px; margin:0 auto; padding:16px; }
  h1 { font-size:1.4rem; margin:0 0 12px; }
  form { display:grid; gap:12px; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); align-items:end; }
  label { display:grid; gap:4px; font-weight:600; font-size:.9rem; }
  input, select, button { font:inherit; padding:8px; border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--fg); }
  input[readonly] { background:transparent; }
  button { cursor:pointer; background:var(--accent); border-color:var(--accent); color:#fff; font-weight:600; }
  button:disabled { opacity:.5; cursor:not-allowed; }
  .wide { grid-column:1 / -1; }
  .notice { padding:8px 12px; border:1px solid var(--warn); border-radius:6px; color:var(--warn); margin:0 0 12px; }
  .error { color:var(--err); }
  .hint { color:var(--muted); font-weight:400; }
  #result { margin-top:16px; }
  #map { height:480px; border:1px solid var(--line); border-radius:6px; margin:8px 0; }
  #legend { display:flex; flex-wrap:wrap; gap:16px; margin:0; padding:0; list-style:none; }
  .swatch { display:inline-block; width:12px; height:12px; border-radius:50%; margin-right:6px; vertical-align:-1px; border:1px solid #000; }
  #confirmBox { margin-top:12px; display:grid; gap:8px; }
`;

const SCRIPT = String.raw`
(function () {
  var init = window.__INIT__ || {};
  var event = init.event || null;
  var KINDS = [
    { key: 'person', name: 'People', color: '#0072B2' },
    { key: 'historical', name: 'Historical', color: '#E69F00' },
    { key: 'organization', name: 'Organizations', color: '#009E73' }
  ];
  var MAX_LABEL = 60;
  var $ = function (id) { return document.getElementById(id); };
  var els = {
    query: $('query'), miles: $('miles'), board: $('board'), label: $('label'), preview: $('previewBtn'),
    status: $('status'), result: $('result'), heading: $('heading'), counts: $('counts'), skipped: $('skipped'),
    legend: $('legend'), confirm: $('confirmBtn'), historical: $('historicalNote'), done: $('done')
  };
  var map = null, layer = null, current = null, labelTouched = false, busy = false;

  function say(text, isError) {
    els.status.textContent = text || '';
    els.status.className = isError ? 'error' : '';
  }

  // 403/429/404 arrive as plain text, so look at the status before trying to parse JSON.
  async function api(path, options) {
    var res;
    try { res = await fetch(path, options); } catch (e) { return { ok: false, message: 'Could not reach the server. Check your connection and try again.' }; }
    if (res.status === 403) return { ok: false, message: 'Your sign-in has expired or you do not have access. Reload the page to sign in again.' };
    if (res.status === 429) return { ok: false, message: 'Too many requests. Wait a minute and try again.' };
    if (res.status === 404) return { ok: false, message: 'That was not found. Reload the page and try again.' };
    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) return { ok: false, message: (data && typeof data.message === 'string' && data.message) || 'Something went wrong (' + res.status + ').' };
    if (data === null) return { ok: false, message: 'The server sent an unreadable response.' };
    return { ok: true, data: data };
  }

  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  function defaultLabel() {
    var opt = els.board.options[els.board.selectedIndex];
    var name = opt && opt.value ? opt.textContent : '';
    return name.replace(/,/g, '').trim().slice(0, MAX_LABEL).trim();
  }

  function boardName() {
    var opt = els.board.options[els.board.selectedIndex];
    return opt && opt.value ? opt.textContent : '';
  }

  function labelOk() {
    var t = els.label.value.trim();
    return t.length >= 1 && t.length <= MAX_LABEL && t.indexOf(',') === -1;
  }

  function updateConfirm() {
    var ok = !!current && !!els.board.value && labelOk() && !busy;
    els.confirm.disabled = !ok;
    if (current) {
      var c = current.counts;
      var people = c.person + c.historical;
      els.confirm.textContent = 'Add ' + plural(people, 'person', 'people') + ' and ' + plural(c.organization, 'organization', 'organizations') +
        ' to "' + boardName() + '"';
      els.historical.textContent = c.historical > 0 ? c.historical + " of these are Historical and won't get the email yet." : '';
    } else {
      els.confirm.textContent = 'Confirm';
      els.historical.textContent = '';
    }
  }

  function clearPreview() {
    current = null;
    els.result.hidden = true;
    els.done.textContent = '';
    if (layer) layer.clearLayers();
    say('');
    updateConfirm();
  }

  function request() {
    var miles = Number(els.miles.value);
    var body = { miles: miles };
    if (event) body.eventItemId = event.eventItemId; else body.query = els.query.value.trim();
    return body;
  }

  function pin(match) {
    var kind = KINDS.filter(function (k) { return k.key === match.kind; })[0] || KINDS[0];
    var m = L.circleMarker([match.lat, match.lng], { radius: 6, color: '#000', weight: 1, fillColor: kind.color, fillOpacity: 0.9 });
    var tip = document.createElement('span');
    tip.textContent = match.name + ' (' + kind.name + ')';
    m.bindTooltip(tip);
    return m;
  }

  function draw(preview) {
    if (!map) {
      map = L.map('map');
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>'
      }).addTo(map);
      layer = L.layerGroup().addTo(map);
    }
    layer.clearLayers();
    var r = preview.resolved;
    var feature;
    if (r.kind === 'line') {
      feature = turf.feature(r.geometry);
      L.geoJSON(feature, { style: { color: '#c1121f', weight: 5 } }).addTo(layer);
    } else {
      feature = turf.point([r.lng, r.lat]);
      L.marker([r.lat, r.lng]).addTo(layer);
    }
    var area = turf.buffer(feature, preview.miles, { units: 'miles' });
    var areaLayer = L.geoJSON(area, { style: { color: '#c1121f', weight: 2, dashArray: '6 4', fillOpacity: 0.08 } }).addTo(layer);
    preview.matches.forEach(function (m) { pin(m).addTo(layer); });
    map.invalidateSize();
    map.fitBounds(areaLayer.getBounds(), { padding: [20, 20] });
  }

  function show(preview) {
    current = preview;
    els.result.hidden = false;
    var r = preview.resolved;
    els.heading.textContent = r.label + (r.kind === 'line' ? ' (' + r.lengthMiles.toFixed(2) + ' mi of road)' : '');
    els.counts.textContent = KINDS.map(function (k) { return k.name + ': ' + preview.counts[k.key]; }).join('  |  ');
    var skipped = KINDS.filter(function (k) { return preview.skippedNoLocation[k.key] > 0; })
      .map(function (k) { return k.name + ': ' + preview.skippedNoLocation[k.key]; });
    els.skipped.textContent = skipped.length ? 'Skipped, no location on file: ' + skipped.join(', ') : '';
    draw(preview);
    updateConfirm();
  }

  async function runPreview() {
    clearPreview();
    var body = request();
    if (!event && !body.query) { say('Enter an address, place, or road between two cross streets.', true); return; }
    if (!(body.miles >= 0.05 && body.miles <= 10)) { say('Miles must be from 0.05 to 10.', true); return; }
    busy = true; els.preview.disabled = true; say('Searching...');
    var res = await api('/api/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    busy = false; els.preview.disabled = false;
    if (!res.ok) { say(res.message, true); return; }
    say('');
    show(res.data);
  }

  async function runConfirm() {
    if (!current || !labelOk() || !els.board.value) return;
    var body = request();
    body.boardId = Number(els.board.value);
    body.label = els.label.value.trim();
    busy = true; updateConfirm(); say('Adding...');
    var res = await api('/api/confirm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    busy = false;
    if (!res.ok) { say(res.message, true); updateConfirm(); return; }
    say('');
    els.confirm.disabled = true;
    var d = res.data;
    els.done.textContent = 'Queued ' + d.queued + '. Already on the board: ' + d.alreadyOnBoard + '. ';
    var a = document.createElement('a');
    a.href = 'https://monday.com/boards/' + encodeURIComponent(els.board.value);
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = 'Open the board';
    els.done.appendChild(a);
    var note = d.writeMode === 'off' ? 'Writes are off — nothing will be added to Monday.'
      : (d.writeMode === 'hold' || d.writeMode === 'unknown') ? 'Writes are on hold — rows will appear when writes resume.' : '';
    if (note) { var p = document.createElement('div'); p.textContent = note; els.done.appendChild(p); }
    // The search is spent: further edits must start from a new preview.
    current = null;
  }

  KINDS.forEach(function (k) {
    var li = document.createElement('li');
    var sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = k.color;
    li.appendChild(sw);
    li.appendChild(document.createTextNode(k.name));
    els.legend.appendChild(li);
  });

  async function loadBoards() {
    var res = await api('/api/boards');
    if (!res.ok) { say(res.message, true); return; }
    res.data.forEach(function (b) {
      var o = document.createElement('option');
      o.value = b.id;
      o.textContent = b.name;
      els.board.appendChild(o);
    });
  }

  if (els.query) els.query.addEventListener('input', clearPreview);
  els.miles.addEventListener('input', clearPreview);
  els.board.addEventListener('change', function () {
    if (!labelTouched) els.label.value = defaultLabel();
    updateConfirm();
  });
  els.label.addEventListener('input', function () { labelTouched = true; updateConfirm(); });
  els.preview.addEventListener('click', runPreview);
  els.confirm.addEventListener('click', runConfirm);
  if (els.query) els.query.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); runPreview(); } });
  els.miles.value = String(event ? event.miles : 0.5);
  updateConfirm();
  loadBoards();
})();
`;

export function renderPage(init: PageInit = {}): string {
  const event = init.event;
  const notice = init.notice ? `<p class="notice" id="notice"></p>` : '';
  const where = event
    ? `<label class="wide">Event: <span class="hint" id="eventName"></span>
        <input id="eventAddress" type="text" readonly aria-label="Event address"></label>`
    : `<label class="wide">Address, place, or "road between A and B"
        <input id="query" type="text" autocomplete="off" placeholder="Stevens Creek Blvd between Saratoga Ave and Winchester Blvd"></label>`;
  const fill = event
    ? `document.getElementById('eventName').textContent = window.__INIT__.event.eventName;
       document.getElementById('eventAddress').value = window.__INIT__.event.address;`
    : '';
  const noticeFill = init.notice ? `document.getElementById('notice').textContent = window.__INIT__.notice;` : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Find nearby</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>Find people and organizations nearby</h1>
${notice}
<form onsubmit="return false">
  ${where}
  <label>Miles <input id="miles" type="number" min="0.05" max="10" step="0.05" value="0.5"></label>
  <label>Results board <select id="board"><option value="">Choose a board</option></select></label>
  <label>Nearby label <input id="label" type="text" maxlength="60" autocomplete="off"></label>
  <button id="previewBtn" type="button">Preview</button>
</form>
<p id="status" role="status"></p>
<section id="result" hidden>
  <h2 id="heading"></h2>
  <p id="counts"></p>
  <p id="skipped" class="hint"></p>
  <div id="map"></div>
  <ul id="legend" aria-label="Pin colors"></ul>
  <div id="confirmBox">
    <p id="historicalNote" class="hint"></p>
    <button id="confirmBtn" type="button" disabled>Confirm</button>
  </div>
</section>
<p id="done" role="status"></p>
</main>
<script>window.__INIT__ = ${embedJson(init)};</script>
<script>${fill}${noticeFill}</script>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@turf/turf@7.2.0/turf.min.js"></script>
<script>${SCRIPT}</script>
</body>
</html>`;
}
