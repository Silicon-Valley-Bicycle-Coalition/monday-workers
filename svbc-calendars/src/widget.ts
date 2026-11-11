export function widgetResponse(url: URL, organizerId: string | null, webAnalyticsToken: string): Response {
  const maxEvents = Math.min(parseInt(url.searchParams.get('max') || '20', 10), 50);
  const showImages = url.searchParams.get('images') !== 'false';
  const showDescriptions = url.searchParams.get('descriptions') !== 'false';
  const layout = url.searchParams.get('layout') === 'grid' ? 'grid' : 'list';

  const html = widgetHTML(maxEvents, showImages, showDescriptions, organizerId, layout, webAnalyticsToken);
  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'public, max-age=3600' } });
}

function widgetHTML(
  maxEvents: number,
  showImages: boolean,
  showDescriptions: boolean,
  organizerId: string | null,
  layout: 'list' | 'grid',
  webAnalyticsToken: string
): string {
  // Unchanged from events-widgets/src/worker.ts's widgetHTML (styles, card layout, resize
  // postMessage, XSS-safe esc()) — copy that function's body verbatim here, including its full
  // <style> block and inline <script> tags. Only the outbound fetch URL below differs by nothing
  // (still fetches this Worker's own /events with the same query params). The beacon script
  // injection (when a token is present) is the one structural addition to the HTML template.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SVBC Events</title>
${webAnalyticsToken ? `<!-- No Subresource Integrity hash on this script deliberately: Cloudflare serves beacon.min.js from its own edge and updates it without version pinning, so a pinned SRI hash would break the beacon the next time Cloudflare ships an update. This is the standard, documented way to load Cloudflare Web Analytics. --><script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token": "${webAnalyticsToken}"}'></script>` : ''}
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    --svbc-accent: #FCB315;
    --svbc-accent-light: #FEF3D6;
    --svbc-dark: #2C2C2C;
    --svbc-dark-hover: #1a1a1a;
    --svbc-text: #2C2C2C;
    --svbc-text-muted: #6b7280;
    --svbc-border: #e5e7eb;
    --svbc-radius: 10px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    color: var(--svbc-text);
    background: transparent;
    max-width: 720px;
    margin: 0 auto;
    padding: 1rem;
  }
  .svbc-loading { text-align: center; padding: 3rem 1rem; color: var(--svbc-text-muted); font-size: 0.95rem; }
  .svbc-loading-spinner { display: inline-block; width: 28px; height: 28px; border: 3px solid var(--svbc-border); border-top-color: var(--svbc-accent); border-radius: 50%; animation: svbc-spin 0.7s linear infinite; margin-bottom: 0.75rem; }
  @keyframes svbc-spin { to { transform: rotate(360deg); } }
  .svbc-error { text-align: center; padding: 2rem 1rem; color: #b91c1c; background: #fef2f2; border-radius: var(--svbc-radius); font-size: 0.9rem; line-height: 1.5; }
  .svbc-empty { text-align: center; padding: 3rem 1rem; color: var(--svbc-text-muted); font-size: 0.95rem; }
  .svbc-event { border: 1px solid var(--svbc-border); border-radius: var(--svbc-radius); overflow: hidden; margin-bottom: 1.5rem; background: #fff; }
  .svbc-event-header { display: flex; align-items: flex-start; gap: 1rem; padding: 1.25rem 1.5rem; }
  .svbc-date-badge { flex-shrink: 0; width: 54px; text-align: center; background: var(--svbc-accent); border-radius: 8px; padding: 6px 0 8px; }
  .svbc-date-day { display: block; font-size: 1.5rem; font-weight: 700; line-height: 1; color: var(--svbc-text); }
  .svbc-date-month { display: block; font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: var(--svbc-dark); margin-top: 2px; }
  .svbc-event-details { flex: 1; min-width: 0; }
  .svbc-event-title { font-size: 1.15rem; font-weight: 700; line-height: 1.3; margin-bottom: 0.6rem; color: var(--svbc-text); }
  .svbc-meta-row { display: flex; align-items: center; gap: 0.5rem; font-size: 0.88rem; color: var(--svbc-text-muted); line-height: 1.4; margin-bottom: 0.3rem; }
  .svbc-meta-row:last-child { margin-bottom: 0; }
  .svbc-meta-icon { flex-shrink: 0; width: 16px; height: 16px; color: var(--svbc-accent); }
  .svbc-event-img { width: 100%; background: var(--svbc-accent-light); }
  .svbc-event-img img { width: 100%; height: auto; display: block; }
  .svbc-event-body { padding: 1.25rem 1.5rem; }
  .svbc-event-summary { font-size: 0.9rem; color: var(--svbc-text-muted); line-height: 1.6; margin-bottom: 1.25rem; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .svbc-cta { display: inline-block; background: var(--svbc-dark); color: #fff; text-decoration: none; font-size: 0.9rem; font-weight: 600; padding: 0.6rem 1.5rem; border-radius: 6px; transition: background 0.15s ease; }
  .svbc-cta:hover { background: var(--svbc-dark-hover); }
  .svbc-badge { display: inline-block; font-size: 0.7rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; padding: 2px 7px; border-radius: 4px; margin-left: 0.5rem; vertical-align: middle; }
  .svbc-badge-free { background: var(--svbc-accent-light); color: var(--svbc-dark); }
  .svbc-badge-paid { background: #fef3c7; color: #92400e; }
  .svbc-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1.5rem; }
  @media (max-width: 768px) { .svbc-grid { grid-template-columns: repeat(2, 1fr); } }
  @media (max-width: 480px) { .svbc-grid { grid-template-columns: 1fr; } }
  .svbc-grid .svbc-event { margin-bottom: 0; display: flex; flex-direction: column; }
  .svbc-grid .svbc-event-img { position: relative; height: 180px; }
  .svbc-grid .svbc-event-img img { height: 100%; object-fit: cover; }
  .svbc-grid .svbc-event-header { padding: 1rem 1.25rem; }
  .svbc-grid .svbc-date-badge { position: absolute; top: 10px; left: 10px; z-index: 1; box-shadow: 0 2px 6px rgba(0,0,0,0.15); }
  .svbc-grid .svbc-event-details { min-width: 0; }
  .svbc-grid .svbc-event-title { font-size: 1.05rem; margin-bottom: 0.5rem; }
  .svbc-grid .svbc-meta-row { font-size: 0.82rem; }
  .svbc-grid .svbc-event-body { padding: 0.75rem 1.25rem 1.25rem; margin-top: auto; }
  .svbc-grid .svbc-event-summary { font-size: 0.85rem; -webkit-line-clamp: 4; margin-bottom: 1rem; }
  body:has(.svbc-grid) { max-width: 1100px; }
</style>
</head>
<body>
<div id="svbc-events"></div>
<script>
(function() {
  var SHOW_IMAGE = ${showImages};
  var SHOW_DESCRIPTION = ${showDescriptions};
  var MAX_EVENTS = ${maxEvents};
  var LAYOUT = "${layout}";

  var SVG_CALENDAR = '<svg class="svbc-meta-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="12" height="11" rx="1.5"/><path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3"/></svg>';
  var SVG_CLOCK = '<svg class="svbc-meta-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/></svg>';
  var SVG_PIN = '<svg class="svbc-meta-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 1.5A4.25 4.25 0 0 0 3.75 5.75C3.75 9.25 8 14.5 8 14.5s4.25-5.25 4.25-8.75A4.25 4.25 0 0 0 8 1.5Z"/><circle cx="8" cy="5.75" r="1.5"/></svg>';

  var container = document.getElementById("svbc-events");
  container.innerHTML = '<div class="svbc-loading"><div class="svbc-loading-spinner"></div><div>Loading events\\u2026</div></div>';

  fetch("./events?page_size=" + MAX_EVENTS + "${organizerId ? `&organizer=${organizerId}` : ''}")
    .then(function(res) {
      if (!res.ok) throw new Error("Worker returned " + res.status);
      return res.json();
    })
    .then(function(data) {
      var now = new Date();
      var events = (data.events || []).filter(function(evt) { return new Date(evt.start.utc) > now; });
      if (events.length === 0) {
        container.innerHTML = '<div class="svbc-empty">No upcoming events right now \\u2014 check back soon!</div>';
        return;
      }
      if (LAYOUT === "grid") container.className = "svbc-grid";
      var html = "";
      events.forEach(function(evt) {
        var start = new Date(evt.start.local);
        var end = evt.end ? new Date(evt.end.local) : null;
        var months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
        var fullMonths = ["January","February","March","April","May","June","July","August","September","October","November","December"];
        var fullDays = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
        var month = months[start.getMonth()];
        var day = start.getDate();
        var dateStr = fullDays[start.getDay()] + ", " + fullMonths[start.getMonth()] + " " + day + ", " + start.getFullYear();
        var timeStr = fmtTime(start);
        if (end) timeStr += "-" + fmtTime(end);
        var locationStr = "";
        if (evt.venue && evt.venue.name) {
          locationStr = esc(evt.venue.name);
          if (evt.venue.address) locationStr += " | " + esc(evt.venue.address);
        } else if (evt.online_event) {
          locationStr = "Online Event";
        }
        var badgeHtml = evt.is_free ? '<span class="svbc-badge svbc-badge-free">Free</span>' : '<span class="svbc-badge svbc-badge-paid">Tickets</span>';
        var imgHtml = "";
        if (SHOW_IMAGE && safeUrl(evt.logo_url)) {
          imgHtml = '<div class="svbc-event-img"><img src="' + safeUrl(evt.logo_url) + '" alt="" loading="lazy"></div>';
        }
        var bodyParts = "";
        if (SHOW_DESCRIPTION && evt.summary) {
          bodyParts += '<div class="svbc-event-summary">' + esc(evt.summary) + '</div>';
        }
        bodyParts += '<a class="svbc-cta" href="' + safeUrl(evt.url) + '" target="_blank" rel="noopener">More Information</a>';
        var dateBadge = '<div class="svbc-date-badge"><span class="svbc-date-day">' + day + '</span><span class="svbc-date-month">' + month + '</span></div>';
        if (LAYOUT === "grid") {
          var imgWithBadge = '<div class="svbc-event-img">' + dateBadge;
          if (SHOW_IMAGE && safeUrl(evt.logo_url)) {
            imgWithBadge += '<img src="' + safeUrl(evt.logo_url) + '" alt="" loading="lazy">';
          }
          imgWithBadge += '</div>';
          html += '<div class="svbc-event">' + imgWithBadge + '<div class="svbc-event-header"><div class="svbc-event-details"><div class="svbc-event-title">' + esc(evt.name) + '</div><div class="svbc-meta-row">' + SVG_CALENDAR + '<span>' + esc(dateStr) + '</span></div><div class="svbc-meta-row">' + SVG_CLOCK + '<span>' + esc(timeStr) + '</span></div>' + (locationStr ? '<div class="svbc-meta-row">' + SVG_PIN + '<span>' + locationStr + '</span></div>' : '') + '</div></div><div class="svbc-event-body">' + bodyParts + '</div></div>';
        } else {
          html += '<div class="svbc-event"><div class="svbc-event-header">' + dateBadge + '<div class="svbc-event-details"><div class="svbc-event-title">' + esc(evt.name) + badgeHtml + '</div><div class="svbc-meta-row">' + SVG_CALENDAR + '<span>' + esc(dateStr) + '</span></div><div class="svbc-meta-row">' + SVG_CLOCK + '<span>' + esc(timeStr) + '</span></div>' + (locationStr ? '<div class="svbc-meta-row">' + SVG_PIN + '<span>' + locationStr + '</span></div>' : '') + '</div></div>' + imgHtml + '<div class="svbc-event-body">' + bodyParts + '</div></div>';
        }
      });
      container.innerHTML = html;
    })
    .catch(function(err) {
      console.error("SVBC Events Widget Error:", err);
      container.innerHTML = '<div class="svbc-error"><strong>Couldn\\'t load events.</strong><br>Check the browser console for details.</div>';
    });

  function fmtTime(d) {
    var h = d.getHours(), m = d.getMinutes();
    var ampm = h >= 12 ? "pm" : "am";
    h = h % 12 || 12;
    return h + ":" + (m < 10 ? "0" : "") + m + ampm;
  }
  function esc(str) {
    if (!str) return "";
    return str.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }
  // Event URLs come from upstream data and land in src/href attributes: allow only http(s), so a
  // javascript: or data: URL can't run, then escape so a quote can't break out of the attribute.
  function safeUrl(url) {
    return typeof url === "string" && /^https?:\\/\\//i.test(url) ? esc(url) : "";
  }
})();
<\/script>
<script>
(function(){
  function postHeight(){
    var h = document.documentElement.scrollHeight;
    window.parent.postMessage({svbcEventsHeight: h}, "*");
  }
  new ResizeObserver(postHeight).observe(document.body);
  postHeight();
})();
<\/script>
</body>
</html>`;
}
