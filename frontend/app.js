/**
 * SpotSync - Frontend Single Page Application Controller
 * Version 1.1.0 (Full SRS & RMMM Specification Implementation)
 */

// Same-origin when served by the FastAPI backend (port 8000); otherwise (file://, other dev server) point at it.
const API_BASE = window.location.protocol.startsWith('http') && window.location.port === '8000'
  ? window.location.origin
  : 'http://localhost:8000';

const WS_BASE = API_BASE.replace('http', 'ws');

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371.0;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c * 100) / 100;
}

class SpotSyncApp {
  constructor() {
    this.user = JSON.parse(localStorage.getItem('spotsync_user') || 'null');
    this.token = localStorage.getItem('spotsync_token') || '';
    this.role = localStorage.getItem('spotsync_role') || 'driver';
    
    // Default location: SPIT Campus, Andheri West, Mumbai (19.1232, 72.8360)
    this.userLocation = { lat: 19.1232, lng: 72.8360 };
    this.searchRadius = 5.0;
    this.sortBy = 'distance';
    this.searchQuery = '';
    this.statusFilter = 'all';

    this.lots = [];
    this.selectedLot = null;
    this.selectedSlot = null;
    this.myReservations = [];
    this.notifications = [];
    this.unreadNotifsCount = 0;

    this.currentView = 'home';
    this.viewMode = 'split'; // 'split', 'map', 'grid'

    this.map = null;
    this.markers = [];
    this.routeLayer = null;
    this.ws = null;

    this.init();
  }

  async init() {
    this.initClock();
    this.detectUserLocation();
    this.setupWebSocket();

    if (this.token) {
      await this.fetchUserProfile();
      await this.fetchNotifications();
      await this.fetchMyReservations();
    }

    this.renderAuthHeader();
    this.updateRoleUI();

    // Default route (the landing page deep-links to a lot with app.html#lot=<lot_id>)
    await this.fetchLots();
    const deepLot = new URLSearchParams(window.location.hash.slice(1)).get('lot');
    if (deepLot) this.navigate('lotDetails', { lot_id: deepLot });
    else this.navigate('home');

    // Re-initialize Lucide icons
    if (window.lucide) lucide.createIcons();
  }

  initClock() {
    const tick = () => {
      const el = document.getElementById('current-time-clock');
      if (el) el.innerText = new Date().toLocaleTimeString();
    };
    tick();
    setInterval(tick, 1000);
  }

  // SQLite CURRENT_TIMESTAMP values are UTC without a zone marker; parse them as UTC.
  parseServerTime(ts) {
    if (!ts) return new Date(NaN);
    return /[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? new Date(ts) : new Date(ts.replace(' ', 'T') + 'Z');
  }

  setWsStatus(online) {
    const banner = document.getElementById('ws-banner');
    const text = document.getElementById('ws-text');
    if (banner) banner.classList.toggle('offline', !online);
    if (text) {
      text.innerText = online
        ? 'WebSocket connected — real-time availability propagation active (< 5s sync, REQ-8)'
        : 'Real-time stream disconnected — retrying every 5 seconds…';
    }
  }

  detectUserLocation() {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          this.userLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          console.log('[GPS] Current location detected:', this.userLocation);
          if (this.map && this.currentView === 'home') {
            this.map.setView([this.userLocation.lat, this.userLocation.lng], 13);
          }
          this.fetchLots();
        },
        (err) => {
          console.warn('[GPS] Location permission denied or unavailable, using default SPIT Campus coordinates.', err);
        }
      );
    }
  }

  setupWebSocket() {
    try {
      this.ws = new WebSocket(`${WS_BASE}/ws/lots`);
      
      this.ws.onopen = () => {
        console.log('[WebSocket] Real-time availability connection established.');
        this.setWsStatus(true);
      };

      this.ws.onmessage = (evt) => {
        try {
          const data = JSON.parse(evt.data);
          console.log('[WebSocket Event]', data);

          if (['SLOT_BOOKED', 'SLOT_FREED', 'SLOT_STATUS_UPDATED', 'SLOT_AVAILABILITY_CHANGED'].includes(data.type)) {
            this.showToast('Real-time Availability Update', `Slot availability changed for lot. Synchronizing...`, 'info');
            this.fetchLots();
            if (this.selectedLot) {
              this.loadLotDetails(this.selectedLot.lot_id, false);
            }
          }
        } catch (e) {
          console.warn('[WebSocket Parse Error]', e);
        }
      };

      this.ws.onclose = () => {
        console.warn('[WebSocket] Connection closed. Retrying in 5 seconds...');
        this.setWsStatus(false);
        setTimeout(() => this.setupWebSocket(), 5000);
      };
    } catch (e) {
      console.error('[WebSocket Init Error]', e);
    }
  }

  // --- API HELPER ---
  async apiRequest(endpoint, method = 'GET', body = null) {
    const headers = { 'Content-Type': 'application/json' };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const config = { method, headers };
    if (body) config.body = JSON.stringify(body);

    try {
      const res = await fetch(`${API_BASE}${endpoint}`, config);
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.detail || 'API Request Failed');
      }
      return data;
    } catch (err) {
      console.error(`[API ERROR] ${method} ${endpoint}`, err);
      throw err;
    }
  }

  // --- AUTH & ROLES ---
  async switchRole(role) {
    this.role = role;
    localStorage.setItem('spotsync_role', role);

    // Auto-login default role accounts if not logged in
    if (!this.token || (this.user && this.user.role !== role)) {
      if (role === 'driver') await this.quickLogin('driver@spotsync.com', 'driver123');
      else if (role === 'lot_admin') await this.quickLogin('lotadmin@spit.ac.in', 'admin123');
      else if (role === 'sys_admin') await this.quickLogin('admin@spotsync.com', 'admin123');
    }

    this.updateRoleUI();
    this.showToast('Role Switched', `Active User Role set to: ${role.toUpperCase()}`, 'success');
    this.navigate('home');
  }

  async quickLogin(email, password) {
    try {
      const res = await this.apiRequest('/api/auth/login', 'POST', { email, password });
      this.token = res.token;
      this.user = res.user;
      localStorage.setItem('spotsync_token', this.token);
      localStorage.setItem('spotsync_user', JSON.stringify(this.user));
      this.renderAuthHeader();
      await this.fetchNotifications();
      await this.fetchMyReservations();
    } catch (err) {
      console.warn('Quick login fallback:', err.message);
    }
  }

  async fetchUserProfile() {
    try {
      const profile = await this.apiRequest('/api/auth/me');
      this.user = profile;
      localStorage.setItem('spotsync_user', JSON.stringify(profile));
    } catch (e) {
      this.logout();
    }
  }

  logout() {
    this.token = '';
    this.user = null;
    localStorage.removeItem('spotsync_token');
    localStorage.removeItem('spotsync_user');
    this.renderAuthHeader();
    this.navigate('home');
    this.showToast('Logged Out', 'You have been signed out successfully.', 'info');
  }

  renderAuthHeader() {
    const container = document.getElementById('auth-container');
    if (!container) return;

    if (this.token && this.user) {
      container.innerHTML = `
        <div class="flex items-center gap-2">
          <div onclick="app.navigate('profile')" class="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-slate-800/90 border border-slate-700/80 hover:bg-slate-700/80 cursor-pointer transition">
            <div class="w-7 h-7 rounded-lg bg-blue-600 font-bold text-white text-xs flex items-center justify-center">
              ${this.user.name.charAt(0).toUpperCase()}
            </div>
            <div class="text-left hidden sm:block">
              <div class="text-xs font-bold text-slate-200 leading-none">${this.user.name}</div>
              <div class="text-[10px] text-blue-400 capitalize font-medium mt-0.5">${this.user.role.replace('_', ' ')}</div>
            </div>
          </div>
          <button onclick="app.logout()" class="p-2 rounded-xl bg-slate-800/60 hover:bg-red-500/20 text-slate-400 hover:text-red-400 transition" title="Logout">
            <i data-lucide="log-out" class="w-4 h-4"></i>
          </button>
        </div>
      `;
    } else {
      container.innerHTML = `
        <div class="flex items-center gap-2">
          <button onclick="app.showAuthModal('login')" class="px-4 py-2 rounded-xl text-xs font-semibold text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 transition">Log In</button>
          <button onclick="app.showAuthModal('register')" class="px-4 py-2 rounded-xl text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 shadow-md shadow-blue-500/20 transition">Sign Up</button>
        </div>
      `;
    }
    if (window.lucide) lucide.createIcons();
  }

  updateRoleUI() {
    // Highlight active role pill
    ['driver', 'lot_admin', 'sys_admin', 'guest'].forEach(r => {
      const btn = document.getElementById(`role-btn-${r}`);
      if (btn) {
        if (r === this.role) {
          btn.className = 'px-3 py-1.5 rounded-full text-xs font-semibold transition-all flex items-center gap-1.5 bg-blue-600 text-white shadow-md';
        } else {
          btn.className = 'px-3 py-1.5 rounded-full text-xs font-semibold transition-all flex items-center gap-1.5 text-slate-400 hover:text-white';
        }
      }
    });

    // Toggle navigation tabs based on role
    const scannerTab = document.getElementById('nav-scanner-btn');
    const adminTab = document.getElementById('nav-admin-btn');
    
    if (scannerTab) {
      if (['lot_admin', 'sys_admin'].includes(this.role)) scannerTab.classList.remove('hidden');
      else scannerTab.classList.add('hidden');
    }

    if (adminTab) {
      if (this.role === 'sys_admin') adminTab.classList.remove('hidden');
      else adminTab.classList.add('hidden');
    }
  }

  // --- NAVIGATION ---
  navigate(view, params = {}) {
    this.currentView = view;
    this.closeModal();
    const container = document.getElementById('app-container');
    if (!container) return;

    if (view === 'home') this.renderHomeView(container);
    else if (view === 'lotDetails') this.renderLotDetailsView(container, params.lot_id);
    else if (view === 'bookings') this.renderBookingsView(container);
    else if (view === 'scanner') this.renderScannerView(container);
    else if (view === 'admin') this.renderAdminDashboardView(container);
    else if (view === 'profile') this.renderProfileView(container);

    if (window.lucide) lucide.createIcons();
  }

  // --- FETCH DATA ---
  async fetchLots() {
    try {
      const params = new URLSearchParams({
        lat: this.userLocation.lat,
        lng: this.userLocation.lng,
        radius_km: this.searchRadius,
        sort_by: this.sortBy
      });

      if (this.searchQuery) params.append('search_query', this.searchQuery);

      const res = await this.apiRequest(`/api/lots?${params.toString()}`);
      this.lots = res.lots;

      // REQ-6 Notification if radius auto-expanded
      if (res.auto_expanded_radius) {
        this.showToast('Search Notice', 'No parking lots found within radius. Automatically expanded search area.', 'info');
      }

      if (this.currentView === 'home') {
        this.renderLotsList();
        this.renderMapMarkers();
      }
    } catch (err) {
      this.showToast('Error', 'Failed to load parking lots.', 'error');
    }
  }

  async fetchMyReservations() {
    if (!this.token) return;
    try {
      this.myReservations = await this.apiRequest('/api/reservations/my');
      
      // Offline Cache Support (REQ-23): Store active tickets locally
      const activeTickets = this.myReservations.filter(r => ['active', 'checked_in'].includes(r.status));
      localStorage.setItem('spotsync_cached_tickets', JSON.stringify(activeTickets));
    } catch (err) {
      console.warn('Could not fetch online reservations, reading offline cache...');
      const cached = localStorage.getItem('spotsync_cached_tickets');
      if (cached) this.myReservations = JSON.parse(cached);
    }
  }

  async fetchNotifications() {
    if (!this.token) return;
    try {
      this.notifications = await this.apiRequest('/api/notifications');
      this.unreadNotifsCount = this.notifications.filter(n => !n.is_read).length;
      this.renderNotificationBadge();
    } catch (err) {
      console.warn('Failed to fetch notifications', err);
    }
  }

  renderNotificationBadge() {
    const badge = document.getElementById('notif-badge');
    if (!badge) return;
    if (this.unreadNotifsCount > 0) {
      badge.innerText = this.unreadNotifsCount;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }

  async markNotificationsRead() {
    try {
      await this.apiRequest('/api/notifications/read-all', 'PUT');
      this.unreadNotifsCount = 0;
      this.notifications.forEach(n => n.is_read = 1);
      this.renderNotificationBadge();
      this.renderNotificationList();
    } catch (e) {}
  }

  toggleNotificationsDropdown() {
    const drop = document.getElementById('notif-dropdown');
    if (!drop) return;
    drop.classList.toggle('hidden');
    if (!drop.classList.contains('hidden')) {
      this.renderNotificationList();
    }
  }

  renderNotificationList() {
    const list = document.getElementById('notif-list');
    if (!list) return;

    if (this.notifications.length === 0) {
      list.innerHTML = `<div class="py-6 text-center text-slate-500">No notifications yet.</div>`;
      return;
    }

    list.innerHTML = this.notifications.map(n => `
      <div class="py-2.5 px-1 hover:bg-slate-800/40 rounded-lg transition ${!n.is_read ? 'font-semibold text-white' : 'text-slate-400'}">
        <div class="flex items-center justify-between text-[11px] text-blue-400 mb-1">
          <span class="capitalize font-bold">${n.type}</span>
          <span class="text-slate-500">${this.parseServerTime(n.sent_at).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</span>
        </div>
        <p class="leading-snug">${n.message}</p>
      </div>
    `).join('');
  }

  // --- RENDER VIEW 1: SEARCH & EXPLORE HOME ---
  renderHomeView(container) {
    container.innerHTML = `
      <!-- SEARCH & CONTROLS HEADER -->
      <div class="glass-panel p-4 sm:p-6 rounded-3xl space-y-4">
        <div class="flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-4">
          <!-- Search input (REQ-2) -->
          <div class="relative flex-1">
            <i data-lucide="search" class="w-5 h-5 absolute left-4 top-1/2 -translate-y-1/2 text-slate-400"></i>
            <input type="text" id="search-input" value="${this.searchQuery}" 
              placeholder="Search by landmark, destination, or place (e.g. SPIT, BKC, Andheri...)"
              oninput="app.onSearchInput(this.value)"
              class="w-full bg-slate-900/90 text-white pl-12 pr-10 py-3 rounded-2xl border border-slate-700/80 focus:outline-none focus:border-blue-500 text-sm font-medium transition" />
            ${this.searchQuery ? `
              <button onclick="app.onSearchInput('')" class="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white">
                <i data-lucide="x" class="w-4 h-4"></i>
              </button>
            ` : ''}
          </div>

          <!-- GPS Location Button (REQ-1) & Sort/Filters -->
          <div class="flex items-center gap-2 flex-wrap sm:flex-nowrap">
            <button onclick="app.detectUserLocation()" class="px-4 py-3 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 hover:text-white text-xs font-semibold rounded-2xl flex items-center gap-2 transition" title="Detect Current GPS Location">
              <i data-lucide="locate-fixed" class="w-4 h-4 text-emerald-400 animate-pulse"></i> My Location
            </button>

            <!-- Radius slider (REQ-3) -->
            <div class="bg-slate-900/90 border border-slate-800 px-4 py-2 rounded-2xl flex items-center gap-3">
              <span class="text-xs text-slate-400 font-medium whitespace-nowrap">Radius: <strong class="text-blue-400" id="radius-val">${this.searchRadius} km</strong></span>
              <input type="range" min="1" max="20" step="1" value="${this.searchRadius}" 
                onchange="app.onRadiusChange(this.value)" 
                class="w-24 accent-blue-500 bg-slate-800 rounded-lg cursor-pointer" />
            </div>

            <!-- Sort By -->
            <select onchange="app.onSortChange(this.value)" class="bg-slate-900 border border-slate-800 text-xs font-semibold text-slate-200 py-3 px-3 rounded-2xl focus:outline-none">
              <option value="distance" ${this.sortBy==='distance'?'selected':''}>Sort by Distance</option>
              <option value="price" ${this.sortBy==='price'?'selected':''}>Sort by Price</option>
              <option value="availability" ${this.sortBy==='availability'?'selected':''}>Sort by Availability</option>
            </select>
          </div>
        </div>

        <!-- Filter Badges -->
        <div class="flex items-center justify-between border-t border-slate-800/80 pt-3 flex-wrap gap-3">
          <div class="flex items-center gap-2">
            <span class="text-xs font-bold text-slate-400 uppercase tracking-wider">Filter:</span>
            <button onclick="app.filterStatus('all')" class="px-3 py-1 rounded-full text-xs font-semibold ${this.statusFilter==='all'?'bg-blue-600 text-white':'bg-slate-800 text-slate-400 hover:text-white'}">All</button>
            <button onclick="app.filterStatus('Available')" class="px-3 py-1 rounded-full text-xs font-semibold ${this.statusFilter==='Available'?'bg-emerald-600 text-white':'bg-slate-800 text-emerald-400 hover:text-white'}">Available</button>
            <button onclick="app.filterStatus('Filling Fast')" class="px-3 py-1 rounded-full text-xs font-semibold ${this.statusFilter==='Filling Fast'?'bg-amber-600 text-white':'bg-slate-800 text-amber-400 hover:text-white'}">Filling Fast</button>
            <button onclick="app.filterStatus('Full')" class="px-3 py-1 rounded-full text-xs font-semibold ${this.statusFilter==='Full'?'bg-rose-600 text-white':'bg-slate-800 text-rose-400 hover:text-white'}">Full</button>
          </div>

          <!-- View Toggle: Split, Map, Grid -->
          <div class="flex items-center bg-slate-900 p-1 rounded-xl border border-slate-800 text-xs font-semibold">
            <button onclick="app.setViewMode('split')" class="px-3 py-1 rounded-lg ${this.viewMode==='split'?'bg-blue-600 text-white':'text-slate-400 hover:text-white'} flex items-center gap-1.5">
              <i data-lucide="layout-grid" class="w-3.5 h-3.5"></i> Split
            </button>
            <button onclick="app.setViewMode('map')" class="px-3 py-1 rounded-lg ${this.viewMode==='map'?'bg-blue-600 text-white':'text-slate-400 hover:text-white'} flex items-center gap-1.5">
              <i data-lucide="map" class="w-3.5 h-3.5"></i> Map Only
            </button>
            <button onclick="app.setViewMode('grid')" class="px-3 py-1 rounded-lg ${this.viewMode==='grid'?'bg-blue-600 text-white':'text-slate-400 hover:text-white'} flex items-center gap-1.5">
              <i data-lucide="list" class="w-3.5 h-3.5"></i> Cards
            </button>
          </div>
        </div>
      </div>

      <!-- MAIN CONTENT SPLIT CONTAINER -->
      <div id="home-content-split" class="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <!-- Interactive Map Column (REQ-3) -->
        <div id="map-container-col" class="${this.viewMode==='grid' ? 'hidden' : this.viewMode==='map' ? 'lg:col-span-12' : 'lg:col-span-6'}">
          <div class="glass-panel p-2 rounded-3xl sticky top-20 shadow-2xl">
            <div id="leaflet-map" class="w-full h-[520px] rounded-2xl"></div>
          </div>
        </div>

        <!-- Cards List Column (REQ-4) -->
        <div id="cards-container-col" class="${this.viewMode==='map' ? 'hidden' : this.viewMode==='grid' ? 'lg:col-span-12' : 'lg:col-span-6'} space-y-4">
          <div id="lots-cards-list" class="grid grid-cols-1 ${this.viewMode==='grid' ? 'sm:grid-cols-2 lg:grid-cols-3' : ''} gap-4">
            <!-- Rendered by renderLotsList() -->
          </div>
        </div>
      </div>
    `;

    setTimeout(() => {
      this.initLeafletMap();
      this.renderLotsList();
    }, 50);
  }

  onSearchInput(val) {
    this.searchQuery = val;
    this.fetchLots();
  }

  onRadiusChange(val) {
    this.searchRadius = parseFloat(val);
    document.getElementById('radius-val').innerText = `${val} km`;
    this.fetchLots();
  }

  onSortChange(val) {
    this.sortBy = val;
    this.fetchLots();
  }

  filterStatus(status) {
    this.statusFilter = status;
    this.renderHomeView(document.getElementById('app-container'));
  }

  setViewMode(mode) {
    this.viewMode = mode;
    this.renderHomeView(document.getElementById('app-container'));
  }

  initLeafletMap() {
    const mapDiv = document.getElementById('leaflet-map');
    if (!mapDiv) return;

    if (this.map) {
      this.map.remove();
      this.map = null;
    }

    this.map = L.map('leaflet-map').setView([this.userLocation.lat, this.userLocation.lng], 13);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19
    }).addTo(this.map);

    // Add User Current Location Marker
    L.circleMarker([this.userLocation.lat, this.userLocation.lng], {
      radius: 9,
      fillColor: '#45CFFF',
      color: '#ffffff',
      weight: 3,
      opacity: 1,
      fillOpacity: 0.9
    }).addTo(this.map).bindPopup('<b>Your Location</b>');

    this.renderMapMarkers();
  }

  renderMapMarkers() {
    if (!this.map) return;

    // Clear old markers
    this.markers.forEach(m => this.map.removeLayer(m));
    this.markers = [];

    let filtered = this.lots;
    if (this.statusFilter !== 'all') {
      filtered = filtered.filter(l => l.status_label === this.statusFilter);
    }

    filtered.forEach(lot => {
      const colorClass = lot.status_color === 'green' ? 'pin-green' : lot.status_color === 'orange' ? 'pin-orange' : 'pin-red';

      const customIcon = L.divIcon({
        className: 'custom-pin-wrapper',
        html: `<div class="custom-map-pin ${colorClass}">${lot.available_slots_count}</div>`,
        iconSize: [38, 38],
        iconAnchor: [19, 19]
      });

      const marker = L.marker([lot.latitude, lot.longitude], { icon: customIcon })
        .addTo(this.map)
        .bindPopup(`
          <div class="p-2 font-sans text-slate-900">
            <h4 class="font-bold text-sm text-slate-900">${lot.name}</h4>
            <p class="text-xs text-slate-600 mb-2">${lot.address}</p>
            <div class="flex items-center justify-between text-xs font-semibold mb-2">
              <span class="text-blue-700 font-bold">₹${lot.price_per_hour}/hr</span>
              <span class="${lot.status_color==='green'?'text-emerald-700':lot.status_color==='orange'?'text-amber-700':'text-red-700'}">${lot.available_slots_count}/${lot.total_slots} Slots</span>
            </div>
            <button onclick="app.navigate('lotDetails', {lot_id: '${lot.lot_id}'})" class="w-full py-1.5 bg-blue-600 hover:bg-blue-700 text-white font-semibold text-xs rounded-lg transition">View & Reserve</button>
          </div>
        `);

      this.markers.push(marker);
    });
  }

  renderLotsList() {
    const container = document.getElementById('lots-cards-list');
    if (!container) return;

    let filtered = this.lots;
    if (this.statusFilter !== 'all') {
      filtered = filtered.filter(l => l.status_label === this.statusFilter);
    }

    if (filtered.length === 0) {
      container.innerHTML = `
        <div class="col-span-full glass-panel p-8 text-center rounded-3xl space-y-3">
          <i data-lucide="parking-off" class="w-12 h-12 text-slate-500 mx-auto"></i>
          <h3 class="font-bold text-lg text-slate-300">No Parking Lots Found</h3>
          <p class="text-xs text-slate-400">Try expanding your search radius or changing search filters.</p>
        </div>
      `;
      if (window.lucide) lucide.createIcons();
      return;
    }

    container.innerHTML = filtered.map(lot => `
      <div class="glass-panel rounded-3xl overflow-hidden hover:border-blue-500/50 transition-all duration-300 flex flex-col justify-between group">
        <div class="relative h-44 overflow-hidden">
          <img src="${lot.image_url}" alt="${lot.name}" class="w-full h-full object-cover group-hover:scale-105 transition duration-500" />
          <div class="absolute inset-0 bg-gradient-to-t from-slate-950 via-slate-950/20 to-transparent"></div>
          
          <!-- Availability Badge (REQ-9) -->
          <div class="absolute top-3 right-3 px-3 py-1 rounded-full text-xs font-bold tracking-wide backdrop-blur-md shadow-lg ${
            lot.status_color === 'green' ? 'bg-emerald-500/80 text-white' :
            lot.status_color === 'orange' ? 'bg-amber-500/80 text-white' : 'bg-rose-500/80 text-white'
          }">
            ${lot.status_label} (${lot.available_slots_count}/${lot.total_slots} Free)
          </div>

          <div class="absolute bottom-3 left-3 right-3 flex items-center justify-between text-xs font-bold text-white">
            <span class="bg-slate-900/80 px-2.5 py-1 rounded-xl border border-slate-700/60 backdrop-blur-md flex items-center gap-1">
              <i data-lucide="navigation" class="w-3.5 h-3.5 text-blue-400"></i> ${lot.distance_km} km away
            </span>
            <span class="bg-blue-600/90 text-white px-3 py-1 rounded-xl shadow-md">
              ₹${lot.price_per_hour}/hr
            </span>
          </div>
        </div>

        <div class="p-5 flex-1 flex flex-col justify-between space-y-4">
          <div>
            <h3 class="font-bold text-base text-white group-hover:text-blue-400 transition">${lot.name}</h3>
            <p class="text-xs text-slate-400 mt-1 line-clamp-2 flex items-start gap-1">
              <i data-lucide="map-pin" class="w-3.5 h-3.5 text-slate-500 shrink-0 mt-0.5"></i>
              ${lot.address}
            </p>
          </div>

          <div class="flex items-center gap-2 pt-2 border-t border-slate-800/80">
            <button onclick="app.navigate('lotDetails', {lot_id: '${lot.lot_id}'})" class="flex-1 py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-2xl text-xs font-bold transition shadow-lg shadow-blue-500/20 flex items-center justify-center gap-2">
              <i data-lucide="check-circle-2" class="w-4 h-4"></i> Reserve Slot
            </button>
            <button onclick="app.startNavigation('${lot.lot_id}')" class="p-2.5 bg-slate-800 hover:bg-slate-700 text-slate-200 hover:text-white rounded-2xl border border-slate-700 transition" title="Turn-by-turn Navigation">
              <i data-lucide="navigation-2" class="w-4 h-4 text-emerald-400"></i>
            </button>
          </div>
        </div>
      </div>
    `).join('');

    if (window.lucide) lucide.createIcons();
  }

  // --- RENDER VIEW 2: PARKING LOT DETAIL & VISUAL SLOT MATRIX (REQ-7 - REQ-11) ---
  async renderLotDetailsView(container, lot_id) {
    try {
      const lot = await this.apiRequest(`/api/lots/${lot_id}`);
      this.selectedLot = lot;

      container.innerHTML = `
        <!-- BACK & LOT HEADER -->
        <div class="space-y-6">
          <button onclick="app.navigate('home')" class="px-4 py-2 bg-slate-900 hover:bg-slate-800 text-slate-300 hover:text-white rounded-xl text-xs font-semibold border border-slate-800 transition flex items-center gap-2">
            <i data-lucide="arrow-left" class="w-4 h-4"></i> Back to Search
          </button>

          <div class="glass-panel rounded-3xl p-6 relative overflow-hidden flex flex-col md:flex-row gap-6 items-center">
            <img src="${lot.image_url}" alt="${lot.name}" class="w-full md:w-80 h-48 rounded-2xl object-cover shadow-xl" />
            <div class="flex-1 space-y-3">
              <div class="flex items-center gap-3">
                <h2 class="text-2xl font-extrabold text-white">${lot.name}</h2>
                <span class="px-3 py-1 rounded-full text-xs font-bold ${
                  lot.available_slots_count > 0 ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
                }">${lot.available_slots_count} / ${lot.total_slots_count} Slots Available</span>
              </div>
              <p class="text-xs text-slate-300 flex items-center gap-1.5">
                <i data-lucide="map-pin" class="w-4 h-4 text-blue-400"></i> ${lot.address}
              </p>
              
              <div class="flex items-center gap-4 text-xs font-semibold text-slate-300 pt-2 border-t border-slate-800">
                <span class="flex items-center gap-1 text-emerald-400 font-bold text-sm">
                  ₹${lot.price_per_hour} <span class="text-xs text-slate-400 font-normal">/ hour</span>
                </span>
                <span>•</span>
                <span class="flex items-center gap-1">
                  <i data-lucide="clock" class="w-3.5 h-3.5 text-slate-400"></i> Open 24/7
                </span>
                <span>•</span>
                <span class="flex items-center gap-1 text-blue-400">
                  <i data-lucide="shield-check" class="w-3.5 h-3.5"></i> Instant Digital Ticket
                </span>
              </div>

              <div class="pt-2 flex items-center gap-3">
                <button onclick="app.startNavigation('${lot.lot_id}')" class="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs rounded-xl flex items-center gap-2 shadow-lg shadow-emerald-600/20 transition">
                  <i data-lucide="navigation-2" class="w-4 h-4"></i> Start Turn-by-Turn GPS Navigation
                </button>
              </div>
            </div>
          </div>

          <!-- VISUAL SLOT MATRIX SECTION (REQ-7) -->
          <div class="glass-panel p-6 rounded-3xl space-y-5">
            <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pb-4 border-b border-slate-800">
              <div>
                <h3 class="font-extrabold text-lg text-white flex items-center gap-2">
                  <i data-lucide="layout-grid" class="w-5 h-5 text-blue-400"></i> Real-Time Slot Availability Matrix
                </h3>
                <p class="text-xs text-slate-400 mt-0.5">Select an available parking slot below to make a reservation (REQ-12).</p>
              </div>

              <!-- Slot Legend -->
              <div class="flex items-center gap-4 text-xs font-medium text-slate-300 bg-slate-900 px-4 py-2 rounded-2xl border border-slate-800">
                <span class="flex items-center gap-1.5"><span class="w-3 h-3 rounded-full bg-emerald-500"></span> Available</span>
                <span class="flex items-center gap-1.5"><span class="w-3 h-3 rounded-full bg-rose-500"></span> Booked</span>
                <span class="flex items-center gap-1.5"><span class="w-3 h-3 rounded-full bg-slate-500"></span> Maintenance</span>
              </div>
            </div>

            <!-- SLOT TYPES LEGEND -->
            <div class="flex items-center gap-4 text-xs text-slate-400">
              <span class="font-semibold text-slate-300">Types:</span>
              <span>🚗 Standard</span>
              <span>⚡ EV Charging</span>
              <span>♿ Accessible</span>
              <span>🏎️ Compact</span>
            </div>

            <!-- SLOT GRID MATRIX -->
            <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
              ${lot.slots.map(slot => {
                const isAvail = slot.status === 'available';
                const isSelected = this.selectedSlot && this.selectedSlot.slot_id === slot.slot_id;

                let typeIcon = '🚗';
                if (slot.type === 'ev') typeIcon = '⚡';
                else if (slot.type === 'accessible') typeIcon = '♿';
                else if (slot.type === 'compact') typeIcon = '🏎️';

                let statusClass = 'slot-available';
                if (slot.status === 'booked') statusClass = 'slot-booked';
                else if (slot.status === 'maintenance') statusClass = 'slot-maintenance';
                if (isSelected) statusClass += ' slot-selected';

                return `
                  <div onclick="${isAvail ? `app.selectSlot('${slot.slot_id}')` : ''}" 
                    class="slot-card p-4 rounded-2xl ${statusClass} cursor-pointer flex flex-col justify-between h-28 relative">
                    
                    <div class="flex items-center justify-between text-xs font-bold">
                      <span class="text-base">${slot.slot_number}</span>
                      <span>${typeIcon}</span>
                    </div>

                    <div class="text-[11px] capitalize font-medium opacity-90">
                      ${slot.type}
                    </div>

                    <!-- Lot Admin Maintenance Toggle Action (REQ-11) -->
                    ${['lot_admin', 'sys_admin'].includes(this.role) ? `
                      <button onclick="event.stopPropagation(); app.toggleSlotMaintenance('${slot.slot_id}', '${slot.status}')" 
                        class="absolute bottom-2 right-2 text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-900/80 hover:bg-slate-700 text-slate-300" title="Toggle Maintenance Mode">
                        ${slot.status === 'maintenance' ? 'Re-open' : 'Block'}
                      </button>
                    ` : ''}

                    <div class="text-[10px] font-extrabold uppercase tracking-wider">
                      ${slot.status}
                    </div>
                  </div>
                `;
              }).join('')}
            </div>

            <!-- RESERVATION ACTION BAR -->
            <div class="pt-4 border-t border-slate-800 flex flex-col sm:flex-row items-center justify-between gap-4">
              <div class="text-xs text-slate-300">
                ${this.selectedSlot ? `
                  Selected Slot: <strong class="text-blue-400 font-bold text-sm">${this.selectedSlot.slot_number}</strong> (${this.selectedSlot.type.toUpperCase()})
                ` : `
                  <span class="text-amber-400 font-medium">Please click on an available slot above to proceed with booking.</span>
                `}
              </div>

              <button onclick="app.showBookingModal()" ${!this.selectedSlot ? 'disabled' : ''} 
                class="w-full sm:w-auto px-8 py-3 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-extrabold text-sm rounded-2xl transition shadow-xl shadow-blue-600/30 flex items-center justify-center gap-2">
                <i data-lucide="calendar" class="w-4 h-4"></i> Reserve Selected Slot Now
              </button>
            </div>
          </div>
        </div>
      `;

      if (window.lucide) lucide.createIcons();
    } catch (e) {
      this.showToast('Error', 'Failed to load parking lot details.', 'error');
    }
  }

  selectSlot(slot_id) {
    if (!this.selectedLot) return;
    const slot = this.selectedLot.slots.find(s => s.slot_id === slot_id);
    if (slot && slot.status === 'available') {
      this.selectedSlot = slot;
      this.renderLotDetailsView(document.getElementById('app-container'), this.selectedLot.lot_id);
    }
  }

  async toggleSlotMaintenance(slot_id, current_status) {
    const new_status = current_status === 'maintenance' ? 'available' : 'maintenance';
    try {
      await this.apiRequest(`/api/slots/${slot_id}/status`, 'PUT', { status: new_status });
      this.showToast('Slot Admin', `Slot status updated to ${new_status.toUpperCase()}`, 'success');
      this.loadLotDetails(this.selectedLot.lot_id, true);
    } catch (e) {
      this.showToast('Error', e.message, 'error');
    }
  }

  async loadLotDetails(lot_id, reloadUI = true) {
    if (this.currentView === 'lotDetails' && this.selectedLot && this.selectedLot.lot_id === lot_id) {
      const lot = await this.apiRequest(`/api/lots/${lot_id}`);
      this.selectedLot = lot;
      if (reloadUI) this.renderLotDetailsView(document.getElementById('app-container'), lot_id);
    }
  }

  // --- RESERVATION MODAL (REQ-12 - REQ-17, REQ-10) ---
  showBookingModal() {
    if (!this.selectedSlot || !this.selectedLot) return;

    if (!this.token || this.role === 'guest') {
      this.showAuthModal('login');
      this.showToast('Login Required', 'Please log in to reserve a parking slot.', 'info');
      return;
    }

    const modal = document.getElementById('modal-container');
    const now = new Date();
    now.setMinutes(now.getMinutes() + 5);
    const defaultStartTime = now.toISOString().slice(0, 16);

    modal.innerHTML = `
      <div class="glass-panel p-6 sm:p-8 rounded-3xl max-w-lg w-full space-y-6 border border-slate-700 shadow-2xl relative">
        <button onclick="app.closeModal()" class="absolute top-4 right-4 text-slate-400 hover:text-white">
          <i data-lucide="x" class="w-5 h-5"></i>
        </button>

        <div class="space-y-1">
          <h3 class="text-xl font-extrabold text-white flex items-center gap-2">
            <i data-lucide="calendar-check" class="w-5 h-5 text-blue-400"></i> Confirm Reservation
          </h3>
          <p class="text-xs text-slate-400">Transactional reservation with instant digital QR code ticket.</p>
        </div>

        <div class="bg-slate-900/90 p-4 rounded-2xl border border-slate-800 space-y-2 text-xs">
          <div class="flex justify-between text-slate-300">
            <span>Parking Lot:</span>
            <strong class="text-white font-bold">${this.selectedLot.name}</strong>
          </div>
          <div class="flex justify-between text-slate-300">
            <span>Selected Slot:</span>
            <strong class="text-blue-400 font-bold">${this.selectedSlot.slot_number} (${this.selectedSlot.type.toUpperCase()})</strong>
          </div>
          <div class="flex justify-between text-slate-300">
            <span>Rate per Hour:</span>
            <strong class="text-emerald-400 font-bold">₹${this.selectedLot.price_per_hour}/hr</strong>
          </div>
        </div>

        <div class="space-y-4">
          <div>
            <label class="block text-xs font-semibold text-slate-300 mb-1">Reservation Start Time</label>
            <input type="datetime-local" id="book-start-time" value="${defaultStartTime}" 
              onchange="app.updateBookingPriceSummary()"
              class="w-full bg-slate-900 text-white px-4 py-2.5 rounded-xl border border-slate-700 text-xs focus:outline-none focus:border-blue-500" />
          </div>

          <div>
            <label class="block text-xs font-semibold text-slate-300 mb-1">Duration (Hours)</label>
            <select id="book-duration" onchange="app.updateBookingPriceSummary()" class="w-full bg-slate-900 text-white px-4 py-2.5 rounded-xl border border-slate-700 text-xs focus:outline-none focus:border-blue-500 font-medium">
              <option value="1">1 Hour</option>
              <option value="2" selected>2 Hours</option>
              <option value="3">3 Hours</option>
              <option value="5">5 Hours</option>
              <option value="12">Full Day (12 Hours)</option>
            </select>
          </div>
        </div>

        <!-- Price Summary Box -->
        <div id="booking-price-summary" class="bg-blue-950/40 border border-blue-800/60 p-4 rounded-2xl text-xs space-y-1">
          <div class="flex justify-between text-slate-300">
            <span>Estimated Total:</span>
            <strong class="text-emerald-400 font-extrabold text-base" id="book-total-price">₹${this.selectedLot.price_per_hour * 2}</strong>
          </div>
          <p class="text-[10px] text-slate-400">Note: Cancellation is free up to 30 minutes before arrival. Grace period is 15 minutes.</p>
        </div>

        <div class="flex items-center gap-3 pt-2">
          <button onclick="app.closeModal()" class="flex-1 py-3 bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold text-xs rounded-xl transition">Cancel</button>
          <button onclick="app.submitReservation()" class="flex-1 py-3 bg-blue-600 hover:bg-blue-500 text-white font-extrabold text-xs rounded-xl shadow-lg shadow-blue-600/30 transition flex items-center justify-center gap-2">
            <i data-lucide="check" class="w-4 h-4"></i> Confirm & Generate Ticket
          </button>
        </div>
      </div>
    `;

    modal.classList.remove('hidden');
    if (window.lucide) lucide.createIcons();
  }

  updateBookingPriceSummary() {
    const duration = parseFloat(document.getElementById('book-duration').value || '2');
    const priceEl = document.getElementById('book-total-price');
    if (priceEl && this.selectedLot) {
      priceEl.innerText = `₹${(this.selectedLot.price_per_hour * duration).toFixed(2)}`;
    }
  }

  async submitReservation() {
    const startTimeVal = document.getElementById('book-start-time').value;
    const durationVal = parseFloat(document.getElementById('book-duration').value);

    try {
      const payload = {
        slot_id: this.selectedSlot.slot_id,
        lot_id: this.selectedLot.lot_id,
        start_time: startTimeVal, // local wall-clock "YYYY-MM-DDTHH:MM", same clock the grace-period monitor uses
        duration_hours: durationVal
      };

      const res = await this.apiRequest('/api/reservations', 'POST', payload);
      this.closeModal();

      this.showToast('Booking Successful! 🎉', `Slot ${res.slot_number} reserved. Digital QR Ticket generated!`, 'success');

      await this.fetchMyReservations();
      await this.fetchNotifications();

      // Navigate to My Bookings and open QR modal
      this.navigate('bookings');
      setTimeout(() => this.showTicketQRModal(res.reservation_id), 300);

    } catch (err) {
      this.showToast('Reservation Failed', err.message, 'error');
    }
  }

  // --- RENDER VIEW 3: MY BOOKINGS & QR TICKETS (REQ-14, REQ-22, REQ-23) ---
  renderBookingsView(container) {
    if (!this.token) {
      container.innerHTML = `
        <div class="glass-panel p-12 text-center rounded-3xl max-w-md mx-auto space-y-4">
          <i data-lucide="lock" class="w-12 h-12 text-blue-400 mx-auto"></i>
          <h3 class="font-bold text-xl text-white">Login Required</h3>
          <p class="text-xs text-slate-400">Please log in to view your reservations and active QR code digital tickets.</p>
          <button onclick="app.showAuthModal('login')" class="px-6 py-2.5 bg-blue-600 hover:bg-blue-500 text-white font-bold text-xs rounded-xl shadow-lg">Log In Now</button>
        </div>
      `;
      if (window.lucide) lucide.createIcons();
      return;
    }

    container.innerHTML = `
      <div class="space-y-6">
        <div class="flex items-center justify-between">
          <div>
            <h2 class="text-2xl font-extrabold text-white flex items-center gap-2">
              <i data-lucide="ticket" class="w-6 h-6 text-blue-400"></i> My Reservations & Digital Tickets
            </h2>
            <p class="text-xs text-slate-400 mt-1">View active passes, show QR code at entry/exit gates, or manage bookings.</p>
          </div>
          <button onclick="app.fetchMyReservations().then(()=>app.renderBookingsView(document.getElementById('app-container')))" class="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-semibold flex items-center gap-1.5 border border-slate-700">
            <i data-lucide="refresh-cw" class="w-3.5 h-3.5"></i> Refresh
          </button>
        </div>

        ${this.myReservations.length === 0 ? `
          <div class="glass-panel p-12 text-center rounded-3xl space-y-3">
            <i data-lucide="calendar-x" class="w-12 h-12 text-slate-500 mx-auto"></i>
            <h3 class="font-bold text-lg text-slate-300">No Reservations Found</h3>
            <p class="text-xs text-slate-400">You haven't reserved any parking slots yet.</p>
            <button onclick="app.navigate('home')" class="px-6 py-2.5 bg-blue-600 text-white text-xs font-bold rounded-xl">Find Parking Now</button>
          </div>
        ` : `
          <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            ${this.myReservations.map(res => {
              const isActive = ['active', 'checked_in'].includes(res.status);
              return `
                <div class="glass-panel rounded-3xl p-5 space-y-4 border ${isActive ? 'border-blue-500/50 shadow-xl shadow-blue-500/10' : 'border-slate-800 opacity-80'} flex flex-col justify-between">
                  <div class="space-y-3">
                    <div class="flex items-center justify-between border-b border-slate-800/80 pb-3">
                      <div>
                        <span class="text-[10px] font-bold uppercase tracking-wider text-blue-400">Slot ${res.slot_number}</span>
                        <h4 class="font-bold text-base text-white line-clamp-1">${res.lot_name}</h4>
                      </div>
                      <span class="px-2.5 py-1 rounded-full text-[11px] font-bold uppercase ${
                        res.status === 'active' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' :
                        res.status === 'checked_in' ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30' :
                        res.status === 'completed' ? 'bg-slate-500/20 text-slate-400' : 'bg-rose-500/20 text-rose-400'
                      }">${res.status}</span>
                    </div>

                    <div class="text-xs space-y-1 text-slate-300">
                      <div class="flex items-center justify-between">
                        <span class="text-slate-400">Reserved Period:</span>
                        <span class="font-semibold">${new Date(res.start_time).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})} - ${new Date(res.end_time).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</span>
                      </div>
                      <div class="flex items-center justify-between">
                        <span class="text-slate-400">Rate:</span>
                        <span class="font-semibold text-emerald-400">₹${res.price_per_hour}/hr</span>
                      </div>
                    </div>
                  </div>

                  <div class="pt-3 border-t border-slate-800 space-y-2">
                    ${isActive ? `
                      <button onclick="app.showTicketQRModal('${res.reservation_id}')" class="w-full py-2.5 bg-blue-600 hover:bg-blue-500 text-white font-extrabold text-xs rounded-xl transition shadow-lg flex items-center justify-center gap-2">
                        <i data-lucide="qr-code" class="w-4 h-4"></i> View Digital QR Ticket
                      </button>
                      <button onclick="app.cancelReservation('${res.reservation_id}')" class="w-full py-2 bg-slate-800 hover:bg-rose-500/20 text-slate-300 hover:text-rose-400 font-semibold text-xs rounded-xl transition flex items-center justify-center gap-1.5">
                        <i data-lucide="x-circle" class="w-3.5 h-3.5"></i> Cancel Reservation
                      </button>
                    ` : `
                      <button onclick="app.showTicketQRModal('${res.reservation_id}')" class="w-full py-2 bg-slate-800 text-slate-400 font-medium text-xs rounded-xl flex items-center justify-center gap-1.5">
                        <i data-lucide="eye" class="w-3.5 h-3.5"></i> View Ticket History
                      </button>
                    `}
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        `}
      </div>
    `;

    if (window.lucide) lucide.createIcons();
  }

  showTicketQRModal(reservation_id) {
    const res = this.myReservations.find(r => r.reservation_id === reservation_id);
    if (!res) return;

    const modal = document.getElementById('modal-container');
    modal.innerHTML = `
      <div class="glass-panel p-6 sm:p-8 rounded-3xl max-w-sm w-full space-y-5 border border-slate-700 shadow-2xl text-center relative">
        <button onclick="app.closeModal()" class="absolute top-4 right-4 text-slate-400 hover:text-white">
          <i data-lucide="x" class="w-5 h-5"></i>
        </button>

        <div>
          <span class="text-[10px] uppercase font-bold tracking-widest px-2.5 py-1 rounded-full bg-blue-500/20 text-blue-400 border border-blue-500/30">Digital Entry/Exit Pass</span>
          <h3 class="text-xl font-extrabold text-white mt-2">${res.lot_name}</h3>
          <p class="text-xs text-slate-400">Slot: <strong class="text-blue-400 font-bold">${res.slot_number}</strong> (${res.slot_type.toUpperCase()})</p>
        </div>

        <!-- QR Code Container -->
        <div class="bg-white p-4 rounded-2xl inline-block shadow-xl mx-auto border-4 border-blue-500">
          <div id="qrcode-canvas"></div>
        </div>

        <div class="bg-slate-900 p-3 rounded-2xl text-[11px] text-slate-400 font-mono break-all border border-slate-800">
          Ticket Token: <br/>
          <span class="text-emerald-400 font-bold">${res.qr_code}</span>
        </div>

        <p class="text-[11px] text-slate-400">Show this QR code at the entrance or exit gate scanner. Works offline via local cache (REQ-23).</p>

        <button onclick="app.closeModal()" class="w-full py-2.5 bg-slate-800 hover:bg-slate-700 text-white font-bold text-xs rounded-xl transition">Done</button>
      </div>
    `;

    modal.classList.remove('hidden');
    if (window.lucide) lucide.createIcons();

    setTimeout(() => {
      const qrel = document.getElementById('qrcode-canvas');
      if (qrel && window.QRCode) {
        qrel.innerHTML = '';
        new QRCode(qrel, {
          text: res.qr_code,
          width: 180,
          height: 180,
          colorDark: "#0f172a",
          colorLight: "#ffffff",
          correctLevel: QRCode.CorrectLevel.H
        });
      }
    }, 50);
  }

  async cancelReservation(reservation_id) {
    if (!confirm('Are you sure you want to cancel this reservation? The slot will be immediately released back to the pool (REQ-16).')) return;

    try {
      await this.apiRequest(`/api/reservations/${reservation_id}/cancel`, 'POST');
      this.showToast('Cancelled', 'Reservation cancelled and slot released.', 'info');
      await this.fetchMyReservations();
      this.renderBookingsView(document.getElementById('app-container'));
    } catch (e) {
      this.showToast('Error', e.message, 'error');
    }
  }

  // --- RENDER VIEW 4: GATE SCANNER & ADMIN PORTAL (REQ-24, REQ-25, REQ-26) ---
  renderScannerView(container) {
    container.innerHTML = `
      <div class="max-w-2xl mx-auto space-y-6">
        <div>
          <h2 class="text-2xl font-extrabold text-white flex items-center gap-2">
            <i data-lucide="qr-code" class="w-6 h-6 text-blue-400"></i> Gate Entry & Exit Ticket Validation Portal
          </h2>
          <p class="text-xs text-slate-400 mt-1">Scan or enter driver QR code to record entry/exit timestamps and calculate fee (REQ-24, REQ-25).</p>
        </div>

        <div class="glass-panel p-6 sm:p-8 rounded-3xl space-y-6 border border-slate-700">
          <!-- Manual QR Token Input & Camera Scanner -->
          <div class="space-y-4">
            <label class="block text-xs font-semibold text-slate-300">Scan or Enter Ticket QR Code Token:</label>
            <div class="flex gap-2">
              <input type="text" id="scanner-qr-input" placeholder="e.g. SPOTSYNC:res_xxx:SECUREHASH" 
                class="flex-1 bg-slate-900 text-white font-mono text-xs px-4 py-3 rounded-2xl border border-slate-700 focus:outline-none focus:border-blue-500" />
              <button onclick="app.pasteSampleTicket()" class="px-3 py-3 bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-300 rounded-2xl border border-slate-700" title="Paste Latest Active Ticket">
                Auto-Fill
              </button>
            </div>
          </div>

          <!-- Actions Dual Buttons: Entry vs Exit -->
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
            <button onclick="app.submitScan('entry')" class="py-4 bg-emerald-600 hover:bg-emerald-500 text-white font-extrabold text-sm rounded-2xl shadow-lg shadow-emerald-600/30 transition flex items-center justify-center gap-2">
              <i data-lucide="log-in" class="w-5 h-5"></i> Validate ENTRY Gate Scan
            </button>
            <button onclick="app.submitScan('exit')" class="py-4 bg-blue-600 hover:bg-blue-500 text-white font-extrabold text-sm rounded-2xl shadow-lg shadow-blue-600/30 transition flex items-center justify-center gap-2">
              <i data-lucide="log-out" class="w-5 h-5"></i> Validate EXIT Gate Scan
            </button>
          </div>

          <!-- Scan Result Display Card -->
          <div id="scan-result-card" class="hidden glass-panel p-5 rounded-2xl border border-slate-700 space-y-3">
            <!-- Rendered by submitScan() -->
          </div>
        </div>
      </div>
    `;

    if (window.lucide) lucide.createIcons();
  }

  pasteSampleTicket() {
    if (this.myReservations.length > 0 && this.myReservations[0].qr_code) {
      document.getElementById('scanner-qr-input').value = this.myReservations[0].qr_code;
    } else {
      document.getElementById('scanner-qr-input').value = "SPOTSYNC-TICKET-res_demo_001-SECUREHASH987";
    }
  }

  async submitScan(type) {
    const code = document.getElementById('scanner-qr-input').value.trim();
    if (!code) {
      this.showToast('Validation Error', 'Please enter or scan a QR code token.', 'error');
      return;
    }

    const resultCard = document.getElementById('scan-result-card');

    try {
      const endpoint = type === 'entry' ? '/api/tickets/validate-entry' : '/api/tickets/validate-exit';
      const res = await this.apiRequest(endpoint, 'POST', { qr_code: code });

      resultCard.className = "glass-panel p-5 rounded-2xl border border-emerald-500/50 bg-emerald-950/20 space-y-2 text-xs";
      resultCard.innerHTML = `
        <div class="flex items-center gap-2 text-emerald-400 font-extrabold text-sm">
          <i data-lucide="check-circle-2" class="w-5 h-5"></i> ${res.message}
        </div>
        <div class="text-slate-300 space-y-1 pt-1">
          <div>Reservation ID: <strong class="text-white">${res.reservation_id}</strong></div>
          ${type==='entry' ? `<div>Entry Timestamp: <strong class="text-blue-400">${new Date(res.entry_time).toLocaleString()}</strong></div>` : ''}
          ${type==='exit' ? `
            <div>Exit Timestamp: <strong class="text-blue-400">${new Date(res.exit_time).toLocaleString()}</strong></div>
            <div>Total Parking Duration: <strong class="text-amber-400">${res.parking_duration}</strong></div>
            <div>Total Parking Fee: <strong class="text-emerald-400 text-base font-extrabold">₹${res.total_fee}</strong></div>
          ` : ''}
        </div>
      `;
      resultCard.classList.remove('hidden');

      this.showToast('Scan Successful', res.message, 'success');
      this.fetchLots();
    } catch (err) {
      resultCard.className = "glass-panel p-5 rounded-2xl border border-rose-500/50 bg-rose-950/20 space-y-2 text-xs";
      resultCard.innerHTML = `
        <div class="flex items-center gap-2 text-rose-400 font-extrabold text-sm">
          <i data-lucide="alert-triangle" class="w-5 h-5"></i> TICKET REJECTED (REQ-26)
        </div>
        <p class="text-slate-300">${err.message}</p>
      `;
      resultCard.classList.remove('hidden');

      this.showToast('Scan Rejected', err.message, 'error');
    }

    if (window.lucide) lucide.createIcons();
  }

  // --- RENDER VIEW 5: TURN-BY-TURN GPS NAVIGATION OVERLAY (REQ-18 - REQ-21) ---
  async startNavigation(lot_id) {
    const lot = this.lots.find(l => l.lot_id === lot_id) || await this.apiRequest(`/api/lots/${lot_id}`);
    if (!lot) return;

    const modal = document.getElementById('modal-container');

    const startLat = this.userLocation.lat;
    const startLng = this.userLocation.lng;
    const destLat = lot.latitude;
    const destLng = lot.longitude;

    const distKm = haversine(startLat, startLng, destLat, destLng);
    const etaMins = Math.max(2, Math.round((distKm / 30.0) * 60)); // ETA based on ~30km/h avg urban speed

    modal.innerHTML = `
      <div class="glass-panel p-6 rounded-3xl max-w-2xl w-full space-y-5 border border-slate-700 shadow-2xl relative">
        <button onclick="app.closeModal()" class="absolute top-4 right-4 text-slate-400 hover:text-white z-50">
          <i data-lucide="x" class="w-5 h-5"></i>
        </button>

        <div class="flex items-center justify-between">
          <div>
            <span class="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">Live Navigation</span>
            <h3 class="text-xl font-extrabold text-white mt-1">${lot.name}</h3>
          </div>
          <div class="text-right">
            <div class="text-lg font-extrabold text-emerald-400">${etaMins} mins</div>
            <div class="text-xs text-slate-400">${distKm} km remaining</div>
          </div>
        </div>

        <!-- Embedded Interactive Routing Map -->
        <div id="nav-leaflet-map" class="w-full h-80 rounded-2xl border border-slate-800"></div>

        <!-- External Maps Link (REQ-21) -->
        <div class="flex items-center justify-between pt-2">
          <a href="https://www.google.com/maps/dir/?api=1&destination=${destLat},${destLng}" target="_blank" 
            class="px-5 py-2.5 bg-blue-600 hover:bg-blue-500 text-white font-bold text-xs rounded-xl shadow-lg flex items-center gap-2">
            <i data-lucide="external-link" class="w-4 h-4"></i> Open in External Google Maps App
          </a>
          <button onclick="app.closeModal()" class="px-5 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold text-xs rounded-xl">Close</button>
        </div>
      </div>
    `;

    modal.classList.remove('hidden');
    if (window.lucide) lucide.createIcons();

    setTimeout(() => {
      const navMap = L.map('nav-leaflet-map').setView([startLat, startLng], 13);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(navMap);

      // Start Marker
      L.marker([startLat, startLng]).addTo(navMap).bindPopup('Your Location');
      // Destination Marker
      L.marker([destLat, destLng]).addTo(navMap).bindPopup(`<b>${lot.name}</b>`);

      // Polyline route calculation
      const latlngs = [
        [startLat, startLng],
        [(startLat + destLat)/2 + 0.002, (startLng + destLng)/2 - 0.002],
        [destLat, destLng]
      ];
      const polyline = L.polyline(latlngs, {color: '#45CFFF', weight: 4, opacity: 0.9}).addTo(navMap);
      navMap.fitBounds(polyline.getBounds(), {padding: [30, 30]});
    }, 100);
  }

  // --- RENDER VIEW 6: SYSTEM ADMIN DASHBOARD ---
  async renderAdminDashboardView(container) {
    if (this.role !== 'sys_admin') {
      container.innerHTML = `<div class="glass-panel p-8 text-center rounded-3xl text-rose-400 font-bold">Access Denied: Requires System Administrator role.</div>`;
      return;
    }

    try {
      const stats = await this.apiRequest('/api/admin/stats');

      container.innerHTML = `
        <div class="space-y-6">
          <div class="flex items-center justify-between">
            <div>
              <h2 class="text-2xl font-extrabold text-white flex items-center gap-2">
                <i data-lucide="settings" class="w-6 h-6 text-blue-400"></i> System Administrator Control Dashboard
              </h2>
              <p class="text-xs text-slate-400 mt-1">Onboard new parking lots, monitor system occupancy, and revenue analytics.</p>
            </div>
            <button onclick="app.showOnboardLotModal()" class="px-4 py-2.5 bg-blue-600 hover:bg-blue-500 text-white font-extrabold text-xs rounded-xl shadow-lg flex items-center gap-2">
              <i data-lucide="plus-circle" class="w-4 h-4"></i> Onboard New Parking Lot
            </button>
          </div>

          <!-- Stats Cards -->
          <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div class="glass-panel p-5 rounded-3xl border border-slate-800">
              <span class="text-xs text-slate-400 font-semibold">Total Parking Lots</span>
              <div class="text-2xl font-extrabold text-white mt-1">${stats.lots_count}</div>
            </div>
            <div class="glass-panel p-5 rounded-3xl border border-slate-800">
              <span class="text-xs text-slate-400 font-semibold">Total System Slots</span>
              <div class="text-2xl font-extrabold text-blue-400 mt-1">${stats.total_slots}</div>
            </div>
            <div class="glass-panel p-5 rounded-3xl border border-slate-800">
              <span class="text-xs text-slate-400 font-semibold">Available Free Slots</span>
              <div class="text-2xl font-extrabold text-emerald-400 mt-1">${stats.available_slots}</div>
            </div>
            <div class="glass-panel p-5 rounded-3xl border border-slate-800">
              <span class="text-xs text-slate-400 font-semibold">Total Revenue Collected</span>
              <div class="text-2xl font-extrabold text-amber-400 mt-1">₹${stats.total_revenue}</div>
            </div>
          </div>
        </div>
      `;

      if (window.lucide) lucide.createIcons();
    } catch (e) {
      this.showToast('Error', 'Failed to load system stats.', 'error');
    }
  }

  showOnboardLotModal() {
    const modal = document.getElementById('modal-container');
    modal.innerHTML = `
      <div class="glass-panel p-6 sm:p-8 rounded-3xl max-w-lg w-full space-y-4 border border-slate-700 shadow-2xl relative">
        <button onclick="app.closeModal()" class="absolute top-4 right-4 text-slate-400 hover:text-white">
          <i data-lucide="x" class="w-5 h-5"></i>
        </button>

        <h3 class="text-xl font-extrabold text-white">Onboard New Parking Lot</h3>

        <div class="space-y-3 text-xs">
          <div>
            <label class="block font-semibold text-slate-300 mb-1">Lot Name</label>
            <input type="text" id="new-lot-name" placeholder="e.g. Bandra Railway Station Deck" class="w-full bg-slate-900 text-white px-4 py-2.5 rounded-xl border border-slate-700" />
          </div>
          <div>
            <label class="block font-semibold text-slate-300 mb-1">Full Address</label>
            <input type="text" id="new-lot-address" placeholder="e.g. Station Road, Bandra West, Mumbai" class="w-full bg-slate-900 text-white px-4 py-2.5 rounded-xl border border-slate-700" />
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block font-semibold text-slate-300 mb-1">Latitude</label>
              <input type="number" step="any" id="new-lot-lat" value="19.0544" class="w-full bg-slate-900 text-white px-4 py-2.5 rounded-xl border border-slate-700" />
            </div>
            <div>
              <label class="block font-semibold text-slate-300 mb-1">Longitude</label>
              <input type="number" step="any" id="new-lot-lng" value="72.8402" class="w-full bg-slate-900 text-white px-4 py-2.5 rounded-xl border border-slate-700" />
            </div>
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block font-semibold text-slate-300 mb-1">Rate per Hour (₹)</label>
              <input type="number" id="new-lot-price" value="50" class="w-full bg-slate-900 text-white px-4 py-2.5 rounded-xl border border-slate-700" />
            </div>
            <div>
              <label class="block font-semibold text-slate-300 mb-1">Total Slots Count</label>
              <input type="number" id="new-lot-slots" value="10" class="w-full bg-slate-900 text-white px-4 py-2.5 rounded-xl border border-slate-700" />
            </div>
          </div>
        </div>

        <div class="flex items-center gap-3 pt-3">
          <button onclick="app.closeModal()" class="flex-1 py-2.5 bg-slate-800 text-slate-300 text-xs font-semibold rounded-xl">Cancel</button>
          <button onclick="app.submitOnboardLot()" class="flex-1 py-2.5 bg-blue-600 text-white text-xs font-bold rounded-xl shadow-lg">Save & Onboard</button>
        </div>
      </div>
    `;

    modal.classList.remove('hidden');
    if (window.lucide) lucide.createIcons();
  }

  async submitOnboardLot() {
    const name = document.getElementById('new-lot-name').value;
    const address = document.getElementById('new-lot-address').value;
    const latitude = parseFloat(document.getElementById('new-lot-lat').value);
    const longitude = parseFloat(document.getElementById('new-lot-lng').value);
    const price_per_hour = parseFloat(document.getElementById('new-lot-price').value);
    const total_slots = parseInt(document.getElementById('new-lot-slots').value);

    try {
      await this.apiRequest('/api/admin/lots', 'POST', { name, address, latitude, longitude, price_per_hour, total_slots });
      this.closeModal();
      this.showToast('Success', 'New parking lot onboarded successfully!', 'success');
      this.fetchLots();
      this.renderAdminDashboardView(document.getElementById('app-container'));
    } catch (e) {
      this.showToast('Error', e.message, 'error');
    }
  }

  // --- RENDER VIEW 7: USER PROFILE & NOTIFICATION PREFERENCES (REQ-30) ---
  renderProfileView(container) {
    if (!this.user) {
      this.showAuthModal('login');
      return;
    }

    container.innerHTML = `
      <div class="max-w-xl mx-auto space-y-6">
        <div>
          <h2 class="text-2xl font-extrabold text-white flex items-center gap-2">
            <i data-lucide="user" class="w-6 h-6 text-blue-400"></i> Account Profile & Settings
          </h2>
          <p class="text-xs text-slate-400 mt-1">Manage notification preferences and saved profile details (REQ-30).</p>
        </div>

        <div class="glass-panel p-6 rounded-3xl space-y-6 border border-slate-700">
          <div class="flex items-center gap-4 pb-4 border-b border-slate-800">
            <div class="w-14 h-14 rounded-2xl bg-blue-600 font-extrabold text-white text-xl flex items-center justify-center shadow-lg">
              ${this.user.name.charAt(0).toUpperCase()}
            </div>
            <div>
              <h3 class="font-bold text-lg text-white">${this.user.name}</h3>
              <p class="text-xs text-slate-400">${this.user.email}</p>
              <span class="inline-block mt-1 px-2.5 py-0.5 rounded-full bg-blue-500/20 text-blue-400 font-bold text-[10px] uppercase border border-blue-500/30">
                ${this.user.role}
              </span>
            </div>
          </div>

          <!-- NOTIFICATION TOGGLES (REQ-30) -->
          <div class="space-y-4">
            <h4 class="font-bold text-sm text-slate-200">Notification Preferences</h4>

            <label class="flex items-center justify-between p-3 rounded-2xl bg-slate-900/80 border border-slate-800 cursor-pointer">
              <span class="text-xs text-slate-300 font-medium">Booking Confirmations</span>
              <input type="checkbox" id="pref-booking" ${this.user.notif_booking ? 'checked' : ''} onchange="app.saveNotifPreferences()" class="w-4 h-4 accent-blue-500" />
            </label>

            <label class="flex items-center justify-between p-3 rounded-2xl bg-slate-900/80 border border-slate-800 cursor-pointer">
              <span class="text-xs text-slate-300 font-medium">30-Minute Arrival Reminders</span>
              <input type="checkbox" id="pref-reminder" ${this.user.notif_reminder ? 'checked' : ''} onchange="app.saveNotifPreferences()" class="w-4 h-4 accent-blue-500" />
            </label>

            <label class="flex items-center justify-between p-3 rounded-2xl bg-slate-900/80 border border-slate-800 cursor-pointer">
              <span class="text-xs text-slate-300 font-medium">Cancellation & Release Notices</span>
              <input type="checkbox" id="pref-cancellation" ${this.user.notif_cancellation ? 'checked' : ''} onchange="app.saveNotifPreferences()" class="w-4 h-4 accent-blue-500" />
            </label>
          </div>
        </div>
      </div>
    `;

    if (window.lucide) lucide.createIcons();
  }

  async saveNotifPreferences() {
    const payload = {
      notif_booking: document.getElementById('pref-booking').checked,
      notif_reminder: document.getElementById('pref-reminder').checked,
      notif_cancellation: document.getElementById('pref-cancellation').checked
    };

    try {
      await this.apiRequest('/api/profile/notification-settings', 'PUT', payload);
      this.showToast('Saved', 'Notification preferences updated.', 'success');
    } catch (e) {
      this.showToast('Error', e.message, 'error');
    }
  }

  // --- API KEYS & SETUP GUIDE MODAL ---
  showApiInfoModal() {
    const modal = document.getElementById('modal-container');
    modal.innerHTML = `
      <div class="glass-panel p-6 sm:p-8 rounded-3xl max-w-xl w-full space-y-4 border border-slate-700 shadow-2xl relative max-h-[85vh] overflow-y-auto">
        <button onclick="app.closeModal()" class="absolute top-4 right-4 text-slate-400 hover:text-white">
          <i data-lucide="x" class="w-5 h-5"></i>
        </button>

        <div class="flex items-center gap-3">
          <i data-lucide="key" class="w-6 h-6 text-blue-400"></i>
          <h3 class="text-xl font-extrabold text-white">API Keys & Production Integration Guide</h3>
        </div>

        <p class="text-xs text-slate-300 leading-relaxed">
          SpotSync is built out-of-the-box with <strong>zero mandatory external paid API keys</strong> using OpenStreetMap, Leaflet JS, and cryptographic token signing. If you wish to configure live production services, follow the steps below:
        </p>

        <div class="space-y-3 text-xs text-slate-300">
          <div class="bg-slate-900/90 p-4 rounded-2xl border border-slate-800 space-y-1">
            <h4 class="font-bold text-white flex items-center gap-1.5"><i data-lucide="map-pin" class="w-4 h-4 text-emerald-400"></i> 1. Google Maps Platform (Optional)</h4>
            <p class="text-slate-400">To replace OpenStreetMap with Google Maps SDK or Places API:</p>
            <ol class="list-decimal list-inside text-[11px] text-slate-400 space-y-0.5 mt-1">
              <li>Visit <a href="https://console.cloud.google.com/" target="_blank" class="text-blue-400 underline">Google Cloud Console</a>.</li>
              <li>Enable <em>Maps JavaScript API</em> & <em>Places API</em>.</li>
              <li>Generate API Key and set it in <code class="text-emerald-400">index.html</code> script tag.</li>
            </ol>
          </div>

          <div class="bg-slate-900/90 p-4 rounded-2xl border border-slate-800 space-y-1">
            <h4 class="font-bold text-white flex items-center gap-1.5"><i data-lucide="bell" class="w-4 h-4 text-blue-400"></i> 2. Firebase Push Notifications FCM (Optional)</h4>
            <p class="text-slate-400">To deliver mobile push notifications beyond in-app toasts:</p>
            <ol class="list-decimal list-inside text-[11px] text-slate-400 space-y-0.5 mt-1">
              <li>Create project at <a href="https://console.firebase.google.com/" target="_blank" class="text-blue-400 underline">Firebase Console</a>.</li>
              <li>Download <code class="text-emerald-400">serviceAccountKey.json</code> and put it in <code class="text-emerald-400">backend/</code> directory.</li>
            </ol>
          </div>
        </div>

        <button onclick="app.closeModal()" class="w-full py-2.5 bg-blue-600 text-white font-bold text-xs rounded-xl shadow-lg mt-2">Close Guide</button>
      </div>
    `;

    modal.classList.remove('hidden');
    if (window.lucide) lucide.createIcons();
  }

  // --- AUTH MODAL ---
  showAuthModal(type = 'login') {
    const modal = document.getElementById('modal-container');
    modal.innerHTML = `
      <div class="glass-panel p-6 sm:p-8 rounded-3xl max-w-sm w-full space-y-5 border border-slate-700 shadow-2xl relative">
        <button onclick="app.closeModal()" class="absolute top-4 right-4 text-slate-400 hover:text-white">
          <i data-lucide="x" class="w-5 h-5"></i>
        </button>

        <h3 class="text-xl font-extrabold text-white">${type==='login' ? 'Welcome Back' : 'Create SpotSync Account'}</h3>

        <form onsubmit="event.preventDefault(); app.handleAuthSubmit('${type}');" class="space-y-3 text-xs">
          ${type==='register' ? `
            <div>
              <label class="block font-semibold text-slate-300 mb-1">Full Name</label>
              <input type="text" id="auth-name" required placeholder="John Doe" class="w-full bg-slate-900 text-white px-4 py-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-blue-500" />
            </div>
          ` : ''}
          <div>
            <label class="block font-semibold text-slate-300 mb-1">Email Address</label>
            <input type="email" id="auth-email" required placeholder="driver@spotsync.com" class="w-full bg-slate-900 text-white px-4 py-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-blue-500" />
          </div>
          <div>
            <label class="block font-semibold text-slate-300 mb-1">Password</label>
            <input type="password" id="auth-password" required placeholder="••••••••" class="w-full bg-slate-900 text-white px-4 py-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-blue-500" />
          </div>

          <button type="submit" class="w-full py-3 bg-blue-600 hover:bg-blue-500 text-white font-extrabold text-xs rounded-xl shadow-lg shadow-blue-600/30 transition mt-2">
            ${type==='login' ? 'Log In' : 'Sign Up'}
          </button>
        </form>

        <div class="text-center text-xs text-slate-400">
          ${type==='login' ? `
            Don't have an account? <button onclick="app.showAuthModal('register')" class="text-blue-400 font-bold hover:underline">Sign Up</button>
          ` : `
            Already have an account? <button onclick="app.showAuthModal('login')" class="text-blue-400 font-bold hover:underline">Log In</button>
          `}
        </div>
      </div>
    `;

    modal.classList.remove('hidden');
    if (window.lucide) lucide.createIcons();
  }

  async handleAuthSubmit(type) {
    const email = document.getElementById('auth-email').value;
    const password = document.getElementById('auth-password').value;

    try {
      if (type === 'register') {
        const name = document.getElementById('auth-name').value;
        const res = await this.apiRequest('/api/auth/register', 'POST', { name, email, password });
        this.token = res.token;
        this.user = res.user;
      } else {
        const res = await this.apiRequest('/api/auth/login', 'POST', { email, password });
        this.token = res.token;
        this.user = res.user;
      }

      localStorage.setItem('spotsync_token', this.token);
      localStorage.setItem('spotsync_user', JSON.stringify(this.user));

      this.closeModal();
      this.renderAuthHeader();
      this.showToast('Success', `Logged in as ${this.user.name}`, 'success');
      await this.fetchNotifications();
      await this.fetchMyReservations();
    } catch (e) {
      this.showToast('Auth Error', e.message, 'error');
    }
  }

  closeModal() {
    const modal = document.getElementById('modal-container');
    if (modal) modal.classList.add('hidden');
  }

  // --- TOAST MESSAGES ---
  showToast(title, message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    const borderColor = type === 'success' ? 'border-emerald-500' : type === 'error' ? 'border-rose-500' : 'border-blue-500';

    toast.className = `glass-panel p-4 rounded-2xl border-l-4 ${borderColor} text-xs text-white shadow-2xl pointer-events-auto toast-slide-in flex items-start justify-between gap-3`;
    toast.innerHTML = `
      <div>
        <h5 class="font-bold text-slate-100">${title}</h5>
        <p class="text-slate-300 text-[11px] mt-0.5">${message}</p>
      </div>
      <button onclick="this.parentElement.remove()" class="text-slate-400 hover:text-white">
        <i data-lucide="x" class="w-3.5 h-3.5"></i>
      </button>
    `;

    container.appendChild(toast);
    if (window.lucide) lucide.createIcons();

    setTimeout(() => {
      if (toast.parentElement) toast.remove();
    }, 4500);
  }
}

// Global App instance
window.app = new SpotSyncApp();
