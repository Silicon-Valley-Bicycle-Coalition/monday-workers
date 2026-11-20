// The portal's one script: dialogs, then tab switching.
//
// Dialogs: a link with data-dialog-open="<id>" opens that <dialog> as a modal instead of following
// its href (the no-script fallback, which renders the dialog open in place). A dialog the server
// rendered open (data-open-on-load) becomes a modal on load, and the query that opened it is
// dropped from the address, so a reload doesn't reopen it. Clicking the backdrop closes a modal,
// unless something in it has been typed or changed (a stray click shouldn't lose it).
//
// Tooltips: an .email-label button shows its tip on hover or keyboard focus (CSS); a tap or click
// toggles it, for touch and for Safari (which doesn't focus a clicked button); Escape hides any
// showing tip without moving focus or the pointer (WCAG 1.4.13).
//
// Tab switching without moving the page. Each tab is still its own server-rendered page (a plain
// link works with no script), but with this script a tab click fetches that page and swaps in its
// panel and tab bar, so the window never scrolls. Anything unexpected (an error status, a
// redirect such as an expired session, a page without a panel) falls back to following the link.
// Served as a hashed, same-origin file (static.ts); no panel carries a script of its own, so
// swapping panel HTML runs nothing. After a swap a polite live region names the new tab, since
// focus stays on the tab bar and a screen reader wouldn't otherwise hear the panel change.
// Plain ES5 so it parses in every browser the portal serves.
export const PORTAL_TABS_JS = `(function () {
  function plainClick(event) {
    return event.button === 0 && !event.defaultPrevented && !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey);
  }

  // Any field changed from what the page rendered.
  function edited(dialog) {
    var fields = dialog.querySelectorAll('input, select, textarea');
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      if (f.type === 'hidden' || f.type === 'submit') continue;
      if (f.tagName === 'SELECT') {
        // With no option marked selected, a single select shows its first.
        var initialIndex = 0;
        for (var j = 0; j < f.options.length; j++) if (f.options[j].defaultSelected) initialIndex = j;
        if (f.selectedIndex !== initialIndex) return true;
      } else if (f.type === 'radio' || f.type === 'checkbox') {
        if (f.checked !== f.defaultChecked) return true;
      } else if (f.value !== f.defaultValue) return true;
    }
    return false;
  }

  function closeTips(except) {
    var open = document.querySelectorAll('.email-label.tip-open');
    for (var i = 0; i < open.length; i++) if (open[i] !== except) open[i].classList.remove('tip-open');
  }

  document.addEventListener('click', function (event) {
    var target = event.target;
    var tipButton = target && target.closest && target.closest('.email-label');
    closeTips(tipButton);
    if (tipButton) {
      tipButton.classList.remove('tip-dismissed');
      tipButton.classList.toggle('tip-open');
      return;
    }
    if (target && target.tagName === 'DIALOG' && target.open) {
      var box = target.getBoundingClientRect();
      var inside = event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
      if (!inside && !edited(target)) target.close();
      return;
    }
    var opener = target && target.closest && target.closest('[data-dialog-open]');
    if (!opener || !plainClick(event)) return;
    var dialog = document.getElementById(opener.getAttribute('data-dialog-open'));
    if (!dialog || !dialog.showModal) return;
    event.preventDefault();
    if (dialog.open) dialog.close();
    dialog.showModal();
  });

  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape' && event.key !== 'Esc') return;
    var showing = document.querySelectorAll('.email-label.tip-open, .email-label:hover, .email-label:focus');
    for (var i = 0; i < showing.length; i++) {
      showing[i].classList.remove('tip-open');
      showing[i].classList.add('tip-dismissed');
    }
  });
  // A dismissed tip comes back the next time the label is pointed at or focused.
  function undismiss(event) {
    var label = event.target && event.target.closest && event.target.closest('.email-label');
    if (!label) return;
    var to = event.relatedTarget;
    if (to && label.contains(to)) return;
    label.classList.remove('tip-dismissed');
    if (event.type === 'focusout') label.classList.remove('tip-open');
  }
  document.addEventListener('mouseout', undismiss);
  document.addEventListener('focusout', undismiss);

  var initial = document.querySelector('dialog[data-open-on-load]');
  if (initial && initial.showModal) {
    // showModal() throws on a dialog that's already open (non-modally).
    initial.removeAttribute('open');
    initial.showModal();
    // The query that opened it has done its job; a reload or a shared link shouldn't reopen it.
    if (location.search && history.replaceState) history.replaceState(history.state, '', location.pathname + location.hash);
  }

  var nav = document.getElementById('tabs');
  var panel = document.querySelector('.portal-panel');
  if (!nav || !panel || !window.fetch || !window.DOMParser || !history.pushState) return;
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  var pending = null;
  var status = document.createElement('p');
  status.className = 'visually-hidden';
  status.setAttribute('aria-live', 'polite');
  document.body.appendChild(status);

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
        var heading = panel.querySelector('h1');
        if (heading) status.textContent = heading.textContent;
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
    if (!link || !plainClick(event)) return;
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
