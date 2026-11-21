/* GoMo Candles — "Use my current location": GPS → address (via the API), with a small map to drag the pin. */
(function () {
  'use strict';

  var LEAFLET_JS = { src: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js', sri: 'sha384-cxOPjt7s7Iz04uaHJceBmS+qpjv2JkIHNVcuOrM+YHwZOmJGBXI00mdUXEq65HTH' };
  var LEAFLET_CSS = { href: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css', sri: 'sha384-sHL9NAb7lN7rfvG5lfHpm643Xkcjzp4jFvuavGOndn6pjVqS6ny56CAt3nsEVT4H' };
  var PIN_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.6"/></svg>';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  var leafletLoading = null;
  function loadLeaflet() {
    if (window.L && window.L.map) return Promise.resolve(window.L);
    if (leafletLoading) return leafletLoading;
    leafletLoading = new Promise(function (resolve, reject) {
      var css = document.createElement('link');
      css.rel = 'stylesheet'; css.href = LEAFLET_CSS.href; css.integrity = LEAFLET_CSS.sri; css.crossOrigin = 'anonymous';
      document.head.appendChild(css);
      var s = document.createElement('script');
      s.src = LEAFLET_JS.src; s.integrity = LEAFLET_JS.sri; s.crossOrigin = 'anonymous';
      s.onload = function () { resolve(window.L); };
      s.onerror = function () { leafletLoading = null; reject(new Error('map')); };
      document.head.appendChild(s);
    });
    return leafletLoading;
  }

  function available() {
    return !!(navigator.geolocation && (window.isSecureContext || location.hostname === 'localhost'));
  }

  function geoError(err) {
    if (err && err.code === 1) return 'Location permission is blocked. Allow location for this site in your browser settings, or type your address.';
    if (err && err.code === 3) return 'Finding your location took too long. Please try again, or type your address.';
    return 'We could not get your location. Please try again, or type your address.';
  }

  function position() {
    return new Promise(function (resolve, reject) {
      navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
    });
  }

  /**
   * Render the location picker into `box`.
   * opts.api(path) → Promise(data)   opts.onApply(fields)   opts.onCancel()
   */
  function start(box, opts) {
    var state = { lat: null, lng: null, accuracy: null, address: null, busy: true, error: '', map: null, marker: null, seq: 0 };
    box.hidden = false;
    box.classList.add('loc-box');

    function render() {
      var a = state.address;
      var preview = '';
      if (a) {
        preview = '<div class="loc-preview"><b>' + esc(a.line1 || a.line2 || a.city || 'Pinned location') + '</b>' +
          '<span>' + esc([a.line1 ? a.line2 : '', a.city, a.state, a.pincode].filter(Boolean).join(', ')) + '</span>' +
          (state.accuracy > 200 ? '<em>Location is approximate (±' + Math.round(state.accuracy) + ' m) — drag the pin to your door, then check the house / street.</em>' :
            a.confidence !== 'high' ? '<em>Please check the house / flat and street after applying.</em>' : '') + '</div>';
      }
      box.innerHTML =
        '<div class="loc-head">' + PIN_ICON + '<b>Your location</b><button type="button" class="link-btn" data-loc="cancel">Close</button></div>' +
        (state.error ? '<div class="alert err" role="alert">' + esc(state.error) + '</div>' : '') +
        '<div class="loc-map" aria-label="Map — drag the pin to your exact location"></div>' +
        (state.busy ? '<div class="loc-status"><span class="spinner"></span> ' + (state.lat == null ? 'Finding you…' : 'Looking up the address…') + '</div>' : preview) +
        '<div class="loc-actions">' +
          '<button type="button" class="btn btn-line btn-sm" data-loc="retry"' + (state.busy ? ' disabled' : '') + '>Locate me again</button>' +
          '<button type="button" class="btn btn-rust btn-sm" data-loc="apply"' + (state.busy || !a ? ' disabled' : '') + '>Use this address</button>' +
        '</div>' +
        '<p class="loc-credit">Map data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors</p>';
      mountMap();
    }

    function mountMap() {
      var el = box.querySelector('.loc-map');
      if (state.lat == null) { el.classList.add('empty'); return; }
      loadLeaflet().then(function (L) {
        if (!box.contains(el)) return;
        if (state.map) { try { state.map.remove(); } catch (e) { /* ignore */ } }
        state.map = L.map(el, { zoomControl: true, attributionControl: false }).setView([state.lat, state.lng], 17);
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(state.map);
        var icon = L.divIcon({ className: 'loc-pin', html: PIN_ICON, iconSize: [36, 36], iconAnchor: [18, 34] });
        state.marker = L.marker([state.lat, state.lng], { draggable: true, icon: icon, keyboard: true, title: 'Drag to your exact location' }).addTo(state.map);
        if (state.accuracy && state.accuracy < 2000) L.circle([state.lat, state.lng], { radius: state.accuracy, weight: 1, color: '#9c5530', fillOpacity: 0.08 }).addTo(state.map);
        state.marker.on('dragend', function () {
          var ll = state.marker.getLatLng();
          state.lat = ll.lat; state.lng = ll.lng; state.accuracy = 10;
          lookup();
        });
      }).catch(function () { el.innerHTML = '<div class="loc-nomap">Map unavailable — the address below is based on your GPS position.</div>'; });
    }

    function lookup() {
      var mine = ++state.seq;
      state.busy = true; state.error = '';
      renderStatusOnly();
      opts.api('/api/geo/reverse?lat=' + state.lat.toFixed(6) + '&lng=' + state.lng.toFixed(6)).then(function (d) {
        if (mine !== state.seq) return;
        state.address = d.address; state.busy = false; render();
      }).catch(function (err) {
        if (mine !== state.seq) return;
        state.busy = false; state.error = err.message || 'Could not look up this location.'; render();
      });
    }

    // Avoid re-creating the map while only the text changes during a pin drag.
    function renderStatusOnly() {
      if (!state.map) return render();
      var prev = box.querySelector('.loc-preview, .loc-status');
      if (prev) prev.outerHTML = '<div class="loc-status"><span class="spinner"></span> Looking up the address…</div>';
      $$('[data-loc="apply"], [data-loc="retry"]').forEach(function (b) { b.disabled = true; });
    }
    function $$(sel) { return Array.prototype.slice.call(box.querySelectorAll(sel)); }

    function locate() {
      state.busy = true; state.error = ''; state.address = null;
      render();
      position().then(function (pos) {
        state.lat = pos.coords.latitude; state.lng = pos.coords.longitude; state.accuracy = pos.coords.accuracy;
        render();
        lookup();
      }).catch(function (err) {
        state.busy = false; state.error = geoError(err); render();
      });
    }

    box.onclick = function (e) {
      var b = e.target.closest('[data-loc]');
      if (!b) return;
      e.preventDefault();
      var act = b.getAttribute('data-loc');
      if (act === 'cancel') { stop(); if (opts.onCancel) opts.onCancel(); }
      else if (act === 'retry') locate();
      else if (act === 'apply' && state.address) {
        var a = state.address;
        var fields = { line1: a.line1 || '', line2: a.line2 || '', city: a.city || '', state: a.state || '', pincode: a.pincode || '',
          lat: Math.round(state.lat * 1e6) / 1e6, lng: Math.round(state.lng * 1e6) / 1e6, accuracy: Math.round(state.accuracy || 0) };
        stop();
        opts.onApply(fields);
      }
    };

    function stop() {
      if (state.map) { try { state.map.remove(); } catch (e) { /* ignore */ } state.map = null; }
      state.seq++;
      box.innerHTML = '';
      box.hidden = true;
      box.onclick = null;
    }

    locate();
    return { stop: stop };
  }

  /** PIN code → { city, district, state, areas[] } via the API (cached server-side). */
  function lookupPin(pin, api) {
    return api('/api/geo/pincode/' + encodeURIComponent(pin)).then(function (d) { return d.pincode; });
  }

  window.GomoLocation = { available: available, start: start, lookupPin: lookupPin, loadLeaflet: loadLeaflet };
})();
