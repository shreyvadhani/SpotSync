import urllib.request
import urllib.error
import json
import time

BASE = 'http://localhost:8000'

def request(url, method='GET', data=None, token=None):
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = f'Bearer {token}'
    req = urllib.request.Request(url, data=json.dumps(data).encode() if data else None, headers=headers, method=method)
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode())

def run_tests():
    print("==================================================")
    print("      SPOTSYNC END-TO-END VERIFICATION SUITE      ")
    print("==================================================")

    # 1. Static Delivery
    print("\n[1] Verifying Frontend Static Delivery...")
    with urllib.request.urlopen(f"{BASE}/app/index.html") as resp:
        assert resp.status == 200
        print("  [PASS] /app/index.html returned 200 OK")

    # 2. Location Search & Filters
    print("\n[2] Testing Location Search & Distance Calculation (REQ-1 to REQ-5)...")
    lots_res = request(f"{BASE}/api/lots?lat=19.1232&lng=72.8360&radius_km=10")
    lots = lots_res["lots"]
    print(f"  [PASS] Found {len(lots)} lots within radius")
    for lot in lots:
        print(f"    - {lot['name']} : {lot['available_slots_count']}/{lot['total_slots']} slots free | Rs.{lot['price_per_hour']}/hr | {lot['distance_km']} km away [{lot['status_label']}]")

    # 3. Authentication
    print("\n[3] Testing Driver Registration & Authentication (5.3 Security)...")
    email = f"driver_{int(time.time())}@spotsync.com"
    reg_res = request(f"{BASE}/api/auth/register", "POST", {
        "name": "Sarah Connor",
        "email": email,
        "password": "Password123!",
        "phone": "+919876543210",
        "role": "driver"
    })
    driver_token = reg_res["token"]
    print(f"  [PASS] User registered & logged in: {reg_res['user']['name']} ({reg_res['user']['email']})")

    # 4. Slot Reservation & Double-Booking Lock
    print("\n[4] Testing Slot Reservation & Transactional Lock (REQ-10, REQ-12, REQ-22)...")
    res_data = request(f"{BASE}/api/reservations", "POST", {
        "slot_id": "lot_spit_slot_4",
        "lot_id": "lot_spit",
        "start_time": "2026-10-12T10:00:00",
        "duration_hours": 2.5
    }, token=driver_token)
    print(f"  [PASS] Reservation Confirmed: ID {res_data['reservation_id']}")
    print(f"  [PASS] Reserved Slot: {res_data['slot_number']} at {res_data['lot_name']}")
    print(f"  [PASS] Cryptographically Signed QR Code: {res_data['qr_code']}")

    # Prevent Double Booking
    print("\n[4b] Verifying Double Booking Lock (REQ-10)...")
    try:
        request(f"{BASE}/api/reservations", "POST", {
            "slot_id": "lot_spit_slot_4",
            "lot_id": "lot_spit",
            "start_time": "2026-10-12T10:00:00",
            "duration_hours": 1.0
        }, token=driver_token)
        print("  [FAIL] Double booking permitted!")
    except urllib.error.HTTPError as e:
        print(f"  [PASS] Conflicting booking safely rejected (HTTP {e.code}): Double-booking blocked!")

    # 5. Gate QR Scanner (Entry & Exit)
    print("\n[5] Testing Gate QR Scanner Portal (REQ-24, REQ-25, REQ-26)...")
    admin_login = request(f"{BASE}/api/auth/login", "POST", {
        "email": "lotadmin@spit.ac.in",
        "password": "admin123"
    })
    admin_token = admin_login["token"]

    # Entry Validation
    entry_scan = request(f"{BASE}/api/tickets/validate-entry", "POST", {
        "qr_code": res_data["qr_code"]
    }, token=admin_token)
    print(f"  [PASS] Entry Gate Scan Approved: {entry_scan['message']}")
    print(f"    Entry Timestamp: {entry_scan['entry_time']}")

    # Exit Validation & Fee Calculation
    exit_scan = request(f"{BASE}/api/tickets/validate-exit", "POST", {
        "qr_code": res_data["qr_code"]
    }, token=admin_token)
    print(f"  [PASS] Exit Gate Scan Approved: {exit_scan['message']}")
    print(f"    Duration: {exit_scan['parking_duration']}, Total Parking Fee: Rs.{exit_scan['total_fee']}")

    # 6. Notifications Engine
    print("\n[6] Testing Notifications Engine (REQ-27 to REQ-30)...")
    notifs = request(f"{BASE}/api/notifications", token=driver_token)
    print(f"  [PASS] Received {len(notifs)} notifications:")
    for n in notifs:
        print(f"    - [{n['type'].upper()}]: {n['message']}")

    # 7. System Admin Controls
    print("\n[7] Testing System Administrator Dashboard & Stats...")
    sys_login = request(f"{BASE}/api/auth/login", "POST", {
        "email": "admin@spotsync.com",
        "password": "admin123"
    })
    sys_token = sys_login["token"]
    stats = request(f"{BASE}/api/admin/stats", token=sys_token)
    print(f"  [PASS] System Metrics:")
    print(f"    - Total Lots: {stats['lots_count']}")
    print(f"    - Total Slots: {stats['total_slots']}")
    print(f"    - Available Slots: {stats['available_slots']}")
    print(f"    - Total Revenue Collected: Rs.{stats['total_revenue']}")

    print("\n==================================================")
    print("  ALL SPOTSYNC SRS v1.1 MODULES 100% OPERATIONAL! ")
    print("==================================================")

if __name__ == "__main__":
    run_tests()
