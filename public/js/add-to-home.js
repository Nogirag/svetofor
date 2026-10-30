(function () {
  'use strict';

  var ua = navigator.userAgent || '';
  var isIos = /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var isAndroid = /Android/.test(ua);
  var standalone = window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true;

  function show(id) {
    var el = document.getElementById(id);
    if (el) el.hidden = false;
  }

  if (standalone) {
    show('installedNote');
  } else if (isIos) {
    show('iosSteps');
  } else if (isAndroid) {
    show('androidSteps');
  } else {
    show('desktopSteps');
  }

  var url = location.href.split('#')[0];
  var shareUrl = document.getElementById('shareUrl');
  if (shareUrl) shareUrl.textContent = url;

  var copyBtn = document.getElementById('copyBtn');
  if (copyBtn) {
    copyBtn.addEventListener('click', function () {
      function fallback() {
        var field = document.createElement('textarea');
        field.value = url;
        field.setAttribute('readonly', '');
        field.style.position = 'fixed';
        field.style.opacity = '0';
        document.body.appendChild(field);
        field.select();
        var ok = false;
        try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
        document.body.removeChild(field);
        copyBtn.textContent = ok ? 'Скопировано' : 'Скопируйте вручную';
        setTimeout(function () { copyBtn.textContent = 'Скопировать'; }, 2000);
      }
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(url).then(function () {
          copyBtn.textContent = 'Скопировано';
          setTimeout(function () { copyBtn.textContent = 'Скопировать'; }, 2000);
        }, fallback);
      } else {
        fallback();
      }
    });
  }

  // iOS не даёт программно добавить на экран — подсказываем, где кнопка.
  var deferredPrompt = null;
  var installBtn = document.getElementById('installBtn');

  window.addEventListener('beforeinstallprompt', function (event) {
    event.preventDefault();
    deferredPrompt = event;
    if (installBtn) {
      installBtn.hidden = false;
      installBtn.addEventListener('click', function () {
        if (!deferredPrompt) return;
        deferredPrompt.prompt();
        deferredPrompt.userChoice.then(function () {
          deferredPrompt = null;
          installBtn.hidden = true;
        });
      });
    }
  });

  window.addEventListener('appinstalled', function () {
    if (installBtn) installBtn.hidden = true;
    show('installedNote');
  });
})();
