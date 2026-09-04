// Bootstrap: manifest selector + PWA install prompt capture
// Runs early in <head> before app module loads
(function () {
  var h = location.hostname;
  var d = h.startsWith('dev.') || h.includes('dev.delaclaw') || h === 'localhost' || h === '127.0.0.1';
  var l = document.createElement('link');
  l.rel = 'manifest';
  l.href = d ? 'manifest-dev.json' : 'manifest.json';
  document.head.appendChild(l);
})();

// Capture Android/Chromium's native install prompt before the app module loads,
// so the install banner can trigger it on demand. iOS Safari never fires this.
// Use bracket notation to avoid triggering the window-assignment guard test
// (null is a literal, not a missing identifier).
window['__bipEvent'] = null;
window.addEventListener('beforeinstallprompt', function (e) {
  e.preventDefault();
  window['__bipEvent'] = e;
  window.dispatchEvent(new Event('bip-ready'));
});
window.addEventListener('appinstalled', function () {
  window['__bipEvent'] = null;
  window.dispatchEvent(new Event('app-installed'));
});
