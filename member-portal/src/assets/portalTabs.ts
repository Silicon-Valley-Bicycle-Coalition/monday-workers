// Tab switching without moving the page. Each tab is still its own server-rendered page (a plain
// link works with no script), but with this script a tab click fetches that page and swaps in its
// panel and tab bar, so the window never scrolls. Anything unexpected (an error status, a
// redirect such as an expired session, a page without a panel) falls back to following the link.
// Served as a hashed, same-origin file (static.ts); no panel carries a script of its own, so
// swapping panel HTML runs nothing. Plain ES5 so it parses in every browser the portal serves.
export const PORTAL_TABS_JS = `(function () {
  var nav = document.getElementById('tabs');
  var panel = document.querySelector('.portal-panel');
  if (!nav || !panel || !window.fetch || !window.DOMParser || !history.pushState) return;
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  var pending = null;

  function pathOf(url) {
    var u = new URL(url, location.href);
    return u.pathname + u.search;
  }

  // A shorter panel would let the browser pull the page up; hold the height the window needs.
  function holdScroll(y) {
    panel.style.minHeight = '';
    var shortBy = y + window.innerHeight - document.documentElement.scrollHeight;
    if (shortBy > 0) panel.style.minHeight = panel.offsetHeight + shortBy + 'px';
    window.scrollTo(window.scrollX, y);
  }

  function show(url, fallback, push) {
    var y = window.scrollY;
    var token = {};
    pending = token;
    panel.setAttribute('aria-busy', 'true');
    fetch(url, { credentials: 'same-origin', headers: { Accept: 'text/html' } })
      .then(function (res) {
        if (!res.ok || pathOf(res.url) !== pathOf(url)) throw new Error('not a tab page');
        return res.text();
      })
      .then(function (html) {
        if (pending !== token) return;
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var nextPanel = doc.querySelector('.portal-panel');
        var nextNav = doc.getElementById('tabs');
        if (!nextPanel || !nextNav) throw new Error('not a tab page');
        panel.innerHTML = nextPanel.innerHTML;
        nav.innerHTML = nextNav.innerHTML;
        document.title = doc.title;
        if (push) history.pushState({ portalTab: true }, '', url);
        panel.removeAttribute('aria-busy');
        holdScroll(y);
        var active = nav.querySelector('[aria-current="page"]');
        if (active && push) active.focus({ preventScroll: true });
      })
      .catch(function () {
        if (pending === token) location.href = fallback;
      });
  }

  nav.addEventListener('click', function (event) {
    var link = event.target.closest && event.target.closest('a.portal-tab');
    if (!link || event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (link.getAttribute('aria-current') === 'page') return;
    var current = nav.querySelector('[aria-current="page"]');
    if (current) current.removeAttribute('aria-current');
    link.setAttribute('aria-current', 'page');
    show(link.href.split('#')[0], link.href, true);
  });

  window.addEventListener('popstate', function () {
    var url = location.href.split('#')[0];
    show(url, url, false);
  });
})();
`;
