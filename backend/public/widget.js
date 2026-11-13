/*!
 * Sire Printing chatbot - embeddable widget loader.
 *
 * Usage on any website - paste before </body> (the admin panel gives each
 * registered company its own snippet):
 *   <script src="https://bot.sireprinting.co.uk/widget.js" data-id="soapboxeswholesale" async></script>
 *
 * Optional: data-position="bl" (bottom-left), and data-title / data-accent /
 * data-greeting to override the company's saved branding.
 * data-sireprinting-id is still accepted in place of data-id.
 */
(function () {
  if (window.__sirePrintingWidgetLoaded) return;
  window.__sirePrintingWidgetLoaded = true;

  var currentScript =
    document.currentScript ||
    (function () {
      var s = document.getElementsByTagName('script');
      return s[s.length - 1];
    })();

  // Base URL of the Sire Printing chatbot server (the folder this script lives in).
  var BASE = new URL('.', currentScript.src).href.replace(/\/+$/, '');
  var SERVER_ORIGIN = new URL(BASE).origin;

  var attr = function (n) { return currentScript.getAttribute(n) || ''; };
  var cfg = {
    siteId: attr('data-id') || attr('data-sireprinting-id') || 'default',
    title: attr('data-title'), // empty = use the company's saved name
    accent: attr('data-accent') || '#4f46e5', // replaced by the company's color below unless set
    accentFixed: !!attr('data-accent'),
    position: currentScript.getAttribute('data-position') || 'br', // br | bl
    greeting: currentScript.getAttribute('data-greeting') || '',
  };

  var host = document.createElement('div');
  host.id = 'sireprinting-widget-host';
  host.style.cssText = 'all: initial;';
  var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;

  var side = cfg.position === 'bl' ? 'left' : 'right';

  var style = document.createElement('style');
  style.textContent = [
    ':host, * { box-sizing: border-box; }',
    '.pb-launcher {',
    '  position: fixed; bottom: 20px; ' + side + ': 20px; z-index: 2147483000;',
    '  width: 60px; height: 60px; border-radius: 50%; border: 0; cursor: pointer;',
    '  background: ' + cfg.accent + '; color: #fff; box-shadow: 0 6px 24px rgba(0,0,0,.25);',
    '  display: flex; align-items: center; justify-content: center;',
    '  transition: transform .15s ease; font-family: system-ui, sans-serif;',
    '}',
    '.pb-launcher:hover { transform: scale(1.06); }',
    '.pb-launcher svg { width: 28px; height: 28px; }',
    '.pb-frame-wrap {',
    '  position: fixed; bottom: 92px; ' + side + ': 20px; z-index: 2147483000;',
    '  width: 384px; height: 620px; max-height: calc(100vh - 112px);',
    '  border-radius: 16px; overflow: hidden; box-shadow: 0 12px 48px rgba(0,0,0,.3);',
    '  opacity: 0; transform: translateY(12px) scale(.98); pointer-events: none;',
    '  transition: opacity .18s ease, transform .18s ease; background: #fff;',
    '}',
    '.pb-frame-wrap.pb-open { opacity: 1; transform: translateY(0) scale(1); pointer-events: auto; }',
    '.pb-frame-wrap iframe { width: 100%; height: 100%; border: 0; display: block; }',
    '@media (max-width: 480px) {',
    '  .pb-frame-wrap { inset: 0; width: 100%; height: 100%; max-height: 100%; border-radius: 0; bottom: 0; }',
    '  .pb-frame-wrap.pb-open ~ .pb-launcher { display: none; }',
    '}',
  ].join('\n');

  var wrap = document.createElement('div');
  wrap.className = 'pb-frame-wrap';

  var iframe = document.createElement('iframe');
  iframe.title = cfg.title || 'Chat';
  iframe.allow = 'microphone';
  // Random visitor ID kept on the customer's own site (first-party storage, so
  // browsers don't wipe it like they do storage inside third-party iframes).
  // Lets a returning visitor continue their chat. Carries no personal data.
  var visitorKey = '';
  try {
    visitorKey = localStorage.getItem('sp_vid') || '';
    if (!/^[A-Za-z0-9-]{8,64}$/.test(visitorKey)) {
      visitorKey = (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
        : 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
      localStorage.setItem('sp_vid', visitorKey);
    }
  } catch (e) {}

  var params = new URLSearchParams({
    siteId: cfg.siteId,
    parentOrigin: window.location.origin,
    // page the visitor is on, so the agent knows which product they're browsing
    pageUrl: (window.location.origin + window.location.pathname).slice(0, 500),
  });
  // Only explicit overrides go on the URL; otherwise the chat uses the company's branding.
  if (cfg.title) params.set('title', cfg.title);
  if (cfg.accentFixed) params.set('accent', cfg.accent);
  if (cfg.greeting) params.set('greeting', cfg.greeting);
  if (visitorKey) params.set('vk', visitorKey);
  iframe.src = BASE + '/chat?' + params.toString();
  wrap.appendChild(iframe);

  var launcher = document.createElement('button');
  launcher.className = 'pb-launcher';
  launcher.setAttribute('aria-label', 'Open chat');
  launcher.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

  var open = false;
  function setOpen(next) {
    open = next;
    wrap.classList.toggle('pb-open', open);
    launcher.setAttribute('aria-label', open ? 'Close chat' : 'Open chat');
    launcher.innerHTML = open
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
    if (open) {
      try {
        iframe.contentWindow.postMessage({ type: 'sireprinting:opened' }, SERVER_ORIGIN);
      } catch (e) {}
    }
  }

  launcher.addEventListener('click', function () {
    setOpen(!open);
  });

  window.addEventListener('message', function (event) {
    if (event.origin !== SERVER_ORIGIN) return;
    var data = event.data || {};
    if (data.type === 'sireprinting:close') setOpen(false);
  });

  root.appendChild(style);
  root.appendChild(wrap);
  root.appendChild(launcher);

  // The company's saved color and name for the chat button.
  fetch(BASE + '/api/site/' + encodeURIComponent(cfg.siteId))
    .then(function (r) {
      // Paused or deleted in the admin panel: take the chat button off the page.
      if (r.status === 404) { disabled = true; host.remove(); return null; }
      return r.ok ? r.json() : null;
    })
    .then(function (c) {
      if (!c) return;
      if (!cfg.accentFixed && c.accentColor) launcher.style.background = c.accentColor;
      if (!cfg.title && c.companyName) iframe.title = c.companyName + ' chat';
    })
    .catch(function () {});

  var disabled = false;
  function mount() {
    if (!disabled) document.body.appendChild(host);
  }
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);

  window.SirePrinting = {
    open: function () {
      setOpen(true);
    },
    close: function () {
      setOpen(false);
    },
    toggle: function () {
      setOpen(!open);
    },
  };
})();
