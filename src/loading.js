// The loading screen's words wait for the face they are set in (a fallback font that then
// swaps was the first thing seen); after a few seconds they show in whatever there is. A plain
// script, not a module, so it runs the moment the loading screen is in the page; it lives in a
// file rather than inline so the content security policy (_headers) can allow scripts from the
// site alone (2026-10-29).
(function () { var l = document.getElementById('loading'), show = function () { l.classList.add('font'); };
  if (document.fonts && document.fonts.load) document.fonts.load('24px "VT323"').then(show, show); else show();
  setTimeout(show, 4000); })();
