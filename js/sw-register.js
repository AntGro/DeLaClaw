// Service Worker registration — network-first, auto-reload on update
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then(function (reg) {
    // Force update check on every page load
    reg.update();
  });
  // Auto-reload when a new service worker takes control (deploy update)
  var refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', function () {
    if (!refreshing) {
      refreshing = true;
      location.reload();
    }
  });
}
