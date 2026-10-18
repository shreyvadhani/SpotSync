/**
 * SpotSync landing page — scroll-scrubbed hero video, GSAP reveals and the
 * "Explore parking" panel, which is fed by the live SpotSync API + WebSocket.
 */
(function () {
  const VIDEO_URL = 'assets/spotsync-hero.mp4';
  const VIDEO_END = 3.85;
  const REDUCED_FRAME = 1.8;
  const SMOOTH = 0.14;

  const API_BASE = location.protocol.startsWith('http') && location.port === '8000'
    ? location.origin : 'http://localhost:8000';
  const WS_BASE = API_BASE.replace(/^http/, 'ws');
  const DEFAULT_LOC = { lat: 19.1232, lng: 72.8360 }; // SPIT campus (fallback only)
  let loc = DEFAULT_LOC, usingDefault = true;

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------------- mobile menu ---------------- */
  const menu = $('[data-menu]'), menuBtn = $('[data-menu-btn]');
  if (menuBtn) menuBtn.addEventListener('click', () => menu.classList.toggle('open'));
  $$('a', menu).forEach(a => a.addEventListener('click', () => menu.classList.remove('open')));

  /* ---------------- scroll-driven video ---------------- */
  const v = $('[data-video]'), fb = $('[data-fallback]');
  let cur = 0, target = 0, maxScroll = 1, raf = 0;
  let ready = false, failed = false, stalled = false, seekAt = 0, vEnd = VIDEO_END;

  function initVideo() {
    if (!v) return;
    v.muted = true; v.defaultMuted = true; v.playsInline = true; v.loop = false; v.preload = 'auto';
    v.setAttribute('playsinline', ''); v.setAttribute('webkit-playsinline', '');
    const reveal = () => { v.style.opacity = '1'; };
    const meta = () => {
      const d = v.duration;
      if (isFinite(d) && d > 0) {
        vEnd = Math.min(VIDEO_END, Math.max(0, d - 0.05)); ready = true;
        if (reduce) { try { v.currentTime = Math.min(REDUCED_FRAME, vEnd); } catch (e) {} }
        kick();
      }
    };
    v.addEventListener('loadedmetadata', meta);
    v.addEventListener('loadeddata', () => { meta(); reveal(); });
    v.addEventListener('canplay', () => { meta(); reveal(); });
    v.addEventListener('seeked', () => { seekAt = 0; kick(); });
    v.addEventListener('error', () => { failed = true; v.style.opacity = '0'; if (fb) fb.style.opacity = '1'; });
    // iOS / data-saver browsers won't load until a gesture: prime once, then pause
    const prime = () => {
      window.removeEventListener('pointerdown', prime, true); window.removeEventListener('touchstart', prime, true);
      if (ready) return;
      const pr = v.play(); if (pr && pr.then) pr.then(() => v.pause()).catch(() => {});
    };
    window.addEventListener('pointerdown', prime, true); window.addEventListener('touchstart', prime, true);
    setTimeout(() => { if (!ready && fb) fb.style.opacity = '1'; }, 7000);
    v.src = VIDEO_URL; v.load();
  }

  function measure() {
    const f = $('#about'); if (!f) return;
    maxScroll = Math.max(1, f.getBoundingClientRect().top + window.scrollY - 0.2 * window.innerHeight);
  }
  function kick() { if (!raf) raf = requestAnimationFrame(tick); }

  function tick() {
    raf = 0;
    target = clamp(window.scrollY / maxScroll, 0, 1);
    cur += (target - cur) * SMOOTH;
    if (Math.abs(target - cur) < 0.0005) cur = target;
    const t = cur * vEnd;
    let more = cur !== target;
    if (v && ready && !failed && !reduce && !stalled) {
      if (v.seeking) {
        more = true;
        if (seekAt && performance.now() - seekAt > 3000) { stalled = true; more = false; }
      } else if (Math.abs(v.currentTime - t) > 0.03) {
        v.currentTime = t; seekAt = performance.now(); more = true;
      }
    }
    paintHud(t); updateNav();
    if (more) kick();
  }

  function paintHud(t) {
    const l = $('[data-hud-label]'), b = $('[data-hud-bar]'), p = $('[data-hud-pct]');
    if (l) l.textContent = 'SYNC ' + t.toFixed(2).padStart(5, '0') + 's';
    if (b) b.style.transform = 'scaleX(' + cur.toFixed(4) + ')';
    if (p) p.textContent = String(Math.round(cur * 100)).padStart(3, '0') + '%';
  }

  let activeNav = null;
  function updateNav() {
    const ids = ['home', 'how', 'features', 'explore', 'about'], vh = window.innerHeight;
    let act = 'home';
    ids.forEach(id => { const el = document.getElementById(id); if (el && el.getBoundingClientRect().top <= vh * 0.5) act = id; });
    if (act === activeNav) return;
    activeNav = act;
    $$('[data-nav]').forEach(a => {
      const on = a.getAttribute('data-nav') === act;
      a.style.color = on ? '#fff' : '';
      const d = $('[data-nav-dot]', a); if (d) d.style.opacity = on ? '1' : '0';
    });
  }

  window.addEventListener('scroll', kick, { passive: true, capture: true });
  window.addEventListener('resize', () => { measure(); kick(); });
  if (window.ResizeObserver) new ResizeObserver(() => { measure(); kick(); }).observe(document.body);

  /* ---------------- GSAP motion ---------------- */
  function initMotion() {
    const g = window.gsap, ST = window.ScrollTrigger;
    if (!g) return;
    if (ST) g.registerPlugin(ST);
    g.from('[data-header]', { y: -28, opacity: 0, duration: 1, ease: 'power3.out' });
    g.from('[data-line]', { yPercent: 115, duration: 1.4, ease: 'expo.out', stagger: 0.14, delay: 0.2 });
    g.from('[data-hero-in]', { y: 26, opacity: 0, duration: 1.1, ease: 'power3.out', stagger: 0.1, delay: 0.65 });
    if (!ST) return;
    g.to('[data-hero]', { y: -70, opacity: 0, ease: 'none', scrollTrigger: { trigger: '#home', start: 'top top', end: 'bottom 30%', scrub: true } });
    g.utils.toArray('[data-rv]').forEach((el, i) => {
      g.from(el, { y: 46, opacity: 0, duration: 1.1, ease: 'power3.out', delay: (i % 2) * 0.08, scrollTrigger: { trigger: el, start: 'top 90%', toggleActions: 'play none none reverse' } });
    });
    g.utils.toArray('[data-bar]').forEach(el => {
      g.from(el, { scaleX: 0, transformOrigin: '0 50%', ease: 'none', scrollTrigger: { trigger: el, start: 'top 88%', end: 'top 48%', scrub: true } });
    });
    g.utils.toArray('[data-par]').forEach(el => {
      g.to(el, { y: parseFloat(el.getAttribute('data-par')) * 6, ease: 'none', scrollTrigger: { trigger: '#home', start: 'top top', end: 'bottom top', scrub: true } });
    });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => ST.refresh());
  }

  /* ---------------- explore parking (live API) ---------------- */
  const FILTERS = [
    { key: 'all', label: 'All', test: () => true },
    { key: 'ev', label: 'EV', test: l => (l.ev_available || 0) > 0 },
    { key: 'accessible', label: 'Accessible', test: l => (l.accessible_available || 0) > 0 },
    { key: 'compact', label: 'Compact', test: l => (l.compact_available || 0) > 0 },
  ];
  const st = { lots: [], filter: 'all', sel: null, loaded: false, offline: false };

  function statusColor(l) {
    const open = l.available_slots_count || 0, total = l.total_slots_count || l.total_slots || 1;
    if (open === 0) return 'rgba(255,255,255,.64)';
    return open / total < 0.3 ? '#F5A524' : '#35D59A';
  }
  const fillPct = l => {
    const open = l.available_slots_count || 0, total = l.total_slots_count || l.total_slots || 1;
    return open > 0 ? Math.max(4, Math.round(open / total * 100)) : 0;
  };

  // Distance is only meaningful from the user's real position; say so when we had to fall back.
  const distLabel = l => usingDefault ? `${l.distance_km} KM FROM SPIT` : `${l.distance_km} KM AWAY`;

  function locate() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(p => {
      loc = { lat: p.coords.latitude, lng: p.coords.longitude }; usingDefault = false; loadLots();
    }, () => {}, { timeout: 8000, maximumAge: 300000 });
  }

  async function loadLots() {
    try {
      const q = new URLSearchParams({ lat: loc.lat, lng: loc.lng, radius_km: 50, sort_by: 'distance' });
      const res = await fetch(`${API_BASE}/api/lots?${q}`);
      if (!res.ok) throw new Error(res.status);
      const data = await res.json();
      st.lots = data.lots || []; st.loaded = true; st.offline = false;
    } catch (e) {
      st.offline = true;
    }
    renderHero(); renderExplore();
  }

  function renderHero() {
    const l = st.lots[0];
    if (!l) {
      $('#hero-name').textContent = st.offline ? 'Backend offline' : 'No lots yet';
      $('#hero-meta').textContent = st.offline ? 'START THE SERVER' : '—';
      $('#hero-open').textContent = '–';
      return;
    }
    $('#hero-name').textContent = l.name;
    $('#hero-meta').textContent = `${distLabel(l)} · ₹${l.price_per_hour}/HR`;
    $('#hero-open').textContent = l.available_slots_count;
    $('#hero-fill').style.width = fillPct(l) + '%';
  }

  function renderExplore() {
    const chips = $('#chips'), rows = $('#rows'), msg = $('#xp-msg'), sel = $('#sel');
    chips.innerHTML = FILTERS.map(f => `<button class="chip${st.filter === f.key ? ' on' : ''}" data-f="${f.key}">${f.label}</button>`).join('');
    $$('.chip', chips).forEach(b => b.addEventListener('click', () => { st.filter = b.dataset.f; st.sel = null; renderExplore(); }));

    const test = FILTERS.find(f => f.key === st.filter).test;
    const vis = st.lots.filter(test);
    const selLot = vis.find(l => l.lot_id === st.sel) || vis[0] || null;
    st.sel = selLot ? selLot.lot_id : null;

    rows.innerHTML = vis.map(l => {
      const open = l.available_slots_count || 0, tags = [];
      if (l.ev_available) tags.push('EV');
      if (l.accessible_available) tags.push('ACC');
      if (l.compact_available) tags.push('CMP');
      return `<button class="lot${selLot && selLot.lot_id === l.lot_id ? ' on' : ''}" data-id="${esc(l.lot_id)}">
        <span class="n">${esc(l.name)}</span>
        <span class="o" style="color:${statusColor(l)}">${open > 0 ? open + ' open' : 'Full'}</span>
        <span class="m">${distLabel(l)} · ₹${l.price_per_hour}/HR${tags.length ? ' · ' + tags.join(' ') : ''}</span>
        <span class="f"><i style="width:${fillPct(l)}%;background:${statusColor(l)}"></i></span>
      </button>`;
    }).join('');
    $$('.lot', rows).forEach(b => b.addEventListener('click', () => { st.sel = b.dataset.id; renderExplore(); }));

    msg.hidden = true; sel.hidden = !selLot;
    if (!st.loaded || st.offline) {
      msg.hidden = false;
      msg.textContent = st.offline
        ? 'CANNOT REACH THE SPOTSYNC SERVER — RUN start.bat AND REFRESH'
        : 'LOADING GARAGES…';
    } else if (!vis.length) {
      msg.hidden = false; msg.textContent = 'NO GARAGES MATCH THIS FILTER';
    }
    $('#xp-live').textContent = st.offline ? 'Offline' : 'Live';

    if (selLot) {
      const open = selLot.available_slots_count || 0;
      $('#sel-k').textContent = `${distLabel(selLot).toLowerCase()} · ${open}/${selLot.total_slots_count || selLot.total_slots} bays open`;
      $('#sel-name').textContent = selLot.name;
      $('#sel-addr').textContent = selLot.address;
      $('#sel-price').textContent = `₹${selLot.price_per_hour} PER HOUR`;
      const go = $('#sel-go');
      go.href = `app.html#lot=${encodeURIComponent(selLot.lot_id)}`;
      $('#sel-go-label').textContent = open > 0 ? 'VIEW BAYS & RESERVE' : 'FULL — VIEW LOT';
    }
  }

  function connectSocket() {
    try {
      const ws = new WebSocket(`${WS_BASE}/ws/lots`);
      ws.onmessage = e => {
        try { const d = JSON.parse(e.data); if (d.type && d.type.startsWith('SLOT_')) loadLots(); } catch (_) {}
      };
      ws.onclose = () => setTimeout(connectSocket, 5000);
    } catch (_) {}
  }

  /* ---------------- boot ---------------- */
  initVideo(); measure(); kick();
  renderExplore();
  loadLots();
  locate();
  connectSocket();
  if (!reduce) {
    let tries = 0;
    const go = () => { if (window.gsap) initMotion(); else if (tries++ < 60) setTimeout(go, 100); };
    go();
  }
})();
