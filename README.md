# SpotSync - Real-Time Parking Discovery, Reservation & Ticketing Application

> **Specification**: Software Requirements Specification (SRS) Version 1.1 & RMMM Plan  
> **Institution**: Sardar Patel Institute of Technology (SPIT), Department of Computer Engineering

---

## 🚀 Live Access

The project is currently running and accessible at:

* **Landing Page** (scroll-scrubbed hero video + live parking explorer): [http://localhost:8000/](http://localhost:8000/)
* **Interactive Web Application**: [http://localhost:8000/app.html](http://localhost:8000/app.html) (the landing page's "Open App" / "View Bays & Reserve" buttons link here; `app.html#lot=<lot_id>` deep-links to a lot)
* **Interactive OpenAPI / Swagger Documentation**: [http://localhost:8000/docs](http://localhost:8000/docs)
* **Real-Time WebSocket Stream**: `ws://localhost:8000/ws/lots`

---

## 🔑 Pre-Seeded Demo Accounts

You can switch between any role instantly using the role pills in the top navbar or log in with these credentials:

| Role | Email | Password | Assigned Location / Access |
|---|---|---|---|
| **Driver / End User** | `driver@spotsync.com` | `driver123` | Search, Reserve Slot, View QR Ticket, Turn-by-turn Navigation |
| **Parking Lot Admin** | `lotadmin@spit.ac.in` | `admin123` | SPIT Lot Management & Entry/Exit Gate QR Scanner |
| **System Administrator** | `admin@spotsync.com` | `admin123` | System Analytics, Revenue Stats & Onboard New Lots |
| **Guest User** | *No login needed* | *N/A* | Public browsing of lots and live availability |

---

## 🛠️ System Architecture & SRS v1.1 Feature Implementation

### 1. Location-Based Parking Search (`REQ-1` to `REQ-6`)
* **Automatic GPS Detection**: Detects current GPS coordinates or falls back to Sardar Patel Institute of Technology (19.1232, 72.8360).
* **Destination Search**: Real-time filtering by landmark/area name.
* **Dual View**: Seamlessly switch between **Split View**, **Interactive Leaflet Map View**, and **Card Grid View**.
* **Distance & Sorting**: Calculates real-time Haversine distance in km, with sorting by Distance, Hourly Rate, or Slot Availability.
* **Auto-Radius Expansion (`REQ-6`)**: Automatically expands radius and alerts the user if no lots are found in the initial radius.

### 2. Real-Time Parking Availability (`REQ-7` to `REQ-11`)
* **WebSocket Live Propagation (`REQ-8`)**: Updates slot status to all connected browsers in `< 5 seconds`.
* **Color-Coded Status Badges (`REQ-9`)**: 
  * `Available` (Green)
  * `Filling Fast` (Yellow/Orange: <30% capacity remaining)
  * `Full` (Red: 0 slots remaining)
* **Visual Slot Layout Matrix**: Interactive grid showing individual slots (`A-01`, `B-02`...) categorized by vehicle type:
  * 🚗 Standard
  * ⚡ EV Charging
  * ♿ Accessible
  * 🏎️ Compact
* **Admin Maintenance Override (`REQ-11`)**: Lot administrators can manually block or re-open slots for maintenance.

### 3. Parking Slot Reservation & Transactional Double-Booking Prevention (`REQ-12` to `REQ-17`)
* **ACID Transaction Locking (`REQ-10` & `R1 Risk Mitigation`)**: Runs slot verification and reservation write inside a single SQLite atomic `BEGIN IMMEDIATE` transaction, preventing two simultaneous users from reserving the same slot.
* **Flexible Booking Window**: Set custom start time and duration (1h, 2h, 3h, 5h, full-day) with live price breakdown.
* **Cancellation Policy (`REQ-15`, `REQ-16`)**: Free cancellation up to 30 mins before arrival. Slots are immediately released back to the live pool.
* **15-Minute Grace Period Background Monitor (`REQ-17`)**: Asynchronous background worker checks for un-scanned reservations exceeding 15 minutes past start time, auto-cancelling the booking and freeing the slot.

### 4. Turn-by-Turn GPS Navigation (`REQ-18` to `REQ-21`)
* **In-App Interactive Route**: Renders GPS driving path from user's current location to the parking facility.
* **Live ETA & Distance**: Dynamic calculation of remaining distance (km) and estimated travel time (minutes).
* **External Maps Integration (`REQ-21`)**: One-click button to open route directly in the native Google Maps app.

### 5. Contactless Digital QR Code Ticketing (`REQ-22` to `REQ-26`)
* **Cryptographic Token Signing**: Each QR code token (`SPOTSYNC:res_xxx:SIGNATURE`) is signed using HMAC-SHA256 to prevent forgery or replay attacks.
* **Offline Caching (`REQ-23`)**: Active tickets are cached in browser `localStorage` so users can display passes without network connectivity.
* **Gate Entry Scan (`REQ-24`)**: Validates QR token, checks active status, records entrance timestamp.
* **Gate Exit Scan & Automated Fee Calculation (`REQ-25`)**: Records departure timestamp, calculates parking duration and hourly billing fee, marks pass completed, and frees the slot.
* **Fraud & Replay Prevention (`REQ-26`)**: Rejects invalid, expired, or already-used passes with clear visual alerts.

### 6. Notifications Engine (`REQ-27` to `REQ-30`)
* **In-App Toast Alerts & Bell Center**: Instant alerts on booking confirmations, 30-min reminders, and cancellations.
* **Category Preference Toggles (`REQ-30`)**: Toggle booking, reminder, and cancellation notifications in user profile.

---

## 🔑 External API Keys Setup Guide (Optional)

SpotSync is fully self-contained using OpenStreetMap, Leaflet JS, and cryptographic token signing out-of-the-box. If you want to connect external cloud providers:

### Google Maps Platform (Optional)
1. Go to [Google Cloud Console](https://console.cloud.google.com/).
2. Enable **Maps JavaScript API** and **Places API**.
3. Create an API Key in Credentials.
4. Replace the OpenStreetMap tile layer in `frontend/app.js` with Google Maps SDK script.

### Firebase Cloud Messaging (FCM) (Optional)
1. Create a project at [Firebase Console](https://console.firebase.google.com/).
2. Under Project Settings > Service Accounts, click **Generate New Private Key**.
3. Save the JSON file as `backend/serviceAccountKey.json`.

---

## 🏃 Rerunning the Project

* **Via Windows Batch File**: Double-click `start.bat` (installs `backend/requirements.txt`, starts the server, opens the browser).
* **Via Terminal**:
  ```bash
  cd backend
  python -m pip install -r requirements.txt
  python app.py
  ```

### Frontend layout (`frontend/`)
| File | Purpose |
|---|---|
| `index.html`, `landing.css`, `landing.js` | Landing page, ported from the "SpotSync landing page animation" template; the Explore panel and hero card read live data from `/api/lots` + `/ws/lots` |
| `app.html`, `app.js`, `styles.css` | The application (search, reserve, QR tickets, gate scanner, admin), themed to the same design language |
| `assets/spotsync-hero.mp4` | Scroll-scrubbed hero video |
* **Run Automated E2E Test Suite**:
  ```bash
  python test_e2e.py
  ```
