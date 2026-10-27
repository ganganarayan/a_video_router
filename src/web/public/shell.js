// App shell behaviour (UI-STRICTURES.md §8): the mobile nav drawer and the
// account menu. Dependency-free and safe on pages that have neither.
(function () {
  function init() {
    var burger = document.getElementById('nav-burger');
    var tabs = document.getElementById('nav-tabs');
    var scrim = document.getElementById('nav-scrim');

    function setDrawer(open) {
      if (!tabs) return;
      tabs.classList.toggle('open', open);
      if (scrim) { scrim.classList.toggle('open', open); scrim.hidden = !open; }
      if (burger) burger.setAttribute('aria-expanded', open ? 'true' : 'false');
      // Keep the page behind the drawer still rather than scrolling under it.
      document.body.style.overflow = open ? 'hidden' : '';
    }

    if (burger && tabs) {
      burger.addEventListener('click', function () {
        setDrawer(!tabs.classList.contains('open'));
      });
      if (scrim) scrim.addEventListener('click', function () { setDrawer(false); });
      // A tab that navigates should not leave the drawer open behind the new page.
      tabs.addEventListener('click', function (e) {
        if (e.target.closest('a')) setDrawer(false);
      });
      // Growing past the breakpoint must not strand an open drawer or a locked body.
      window.addEventListener('resize', function () {
        if (window.innerWidth > 900) setDrawer(false);
      });
    }

    var acctBtn = document.getElementById('acct-btn');
    var acctMenu = document.getElementById('acct-menu');
    function setMenu(open) {
      if (!acctMenu) return;
      acctMenu.hidden = !open;
      if (acctBtn) acctBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    if (acctBtn && acctMenu) {
      acctBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        setMenu(acctMenu.hidden);
      });
      document.addEventListener('click', function (e) {
        if (!acctMenu.hidden && !acctMenu.contains(e.target) && e.target !== acctBtn) setMenu(false);
      });
    }

    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      setMenu(false);
      if (tabs && tabs.classList.contains('open')) { setDrawer(false); if (burger) burger.focus(); }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
