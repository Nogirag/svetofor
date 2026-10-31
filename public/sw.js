/* Кэш оболочки приложения: офлайн-режим и мгновенный запуск с главного экрана.
 * При изменении любого файла ниже поднимайте версию в CACHE. */
'use strict';

var CACHE = 'traffic-light-v23';
var SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/schedule.js',
  './js/feedback.js',
  './js/add-to-home.js',
  './manifest.webmanifest',
  './assets/icons/icon.svg',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/maskable-512.png',
  './assets/icons/apple-touch-icon.png',
  './add-to-home.html'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE)
      // Оболочку берём в обход HTTP-кэша браузера: иначе свежая версия кэша может
      // оказаться слепком старых файлов (допустим, пока сервер держал порт за
      // статик-раздачей), и поднятие CACHE не даст человеку новый код.
      .then(function (cache) {
        return cache.addAll(SHELL.map(function (url) {
          return new Request(url, { cache: 'no-store' });
        }));
      })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (key) { return key !== CACHE; })
        .map(function (key) { return caches.delete(key); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;

  var url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Данные и сводки всегда из сети: их нельзя отдавать из кэша.
  if (url.pathname.indexOf('/api/') !== -1) return;

  // Конфиг из сборки меняется с каждой публикацией: сначала сеть, кэш — офлайн.
  if (/(^|\/)config\.json$/.test(url.pathname)) {
    event.respondWith(
      fetch(request).then(function (response) {
        if (response && response.status === 200) {
          var copy = response.clone();
          caches.open(CACHE).then(function (cache) { cache.put(request, copy); });
        }
        return response;
      }).catch(function () { return caches.match(request); })
    );
    return;
  }

  // Навигация: сеть как источник истины (чтобы не зависеть на старой версии),
  // кэш — как резерв офлайн.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(function () { return caches.match('./index.html'); })
    );
    return;
  }

  // Статика: кэш, затем сеть с дозаписью в кэш.
  event.respondWith(
    caches.match(request).then(function (cached) {
      if (cached) return cached;
      return fetch(request).then(function (response) {
        if (response && response.status === 200) {
          var copy = response.clone();
          caches.open(CACHE).then(function (cache) { cache.put(request, copy); });
        }
        return response;
      });
    })
  );
});
