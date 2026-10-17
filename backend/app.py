import asyncio
import json
import math
import os
import uuid
from datetime import datetime, timedelta
from typing import Optional, List

from fastapi import FastAPI, HTTPException, Depends, WebSocket, WebSocketDisconnect, Query, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from database import init_db, get_db, hash_password
from auth import (
    create_access_token, 
    verify_password, 
    get_current_user, 
    get_current_user_optional, 
    require_roles
)
from services import (
    generate_qr_token, 
    verify_qr_token, 
    calculate_parking_fee, 
    check_grace_period_expirations
)

# Initialize FastAPI App
app = FastAPI(
    title="SpotSync API",
    description="Backend API server for SpotSync Parking Discovery, Reservation & Ticketing Application",
    version="1.1.0"
)

# Enable CORS for all origins
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# WebSocket Connection Manager for Real-Time Updates (REQ-8)
class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)

    async def broadcast(self, message: dict):
        for connection in list(self.active_connections):
            try:
                await connection.send_json(message)
            except Exception:
                self.disconnect(connection)

manager = ConnectionManager()

# Background Task for Grace Period Expiration Monitor (REQ-17)
async def grace_period_monitor_loop():
    while True:
        try:
            expired_lots = check_grace_period_expirations()
            if expired_lots:
                await manager.broadcast({"type": "SLOT_AVAILABILITY_CHANGED", "lot_ids": expired_lots})
        except Exception as e:
            print(f"[GRACE MONITOR ERROR] {e}")
        await asyncio.sleep(30) # Run every 30 seconds

@app.on_event("startup")
async def startup_event():
    init_db()
    asyncio.create_task(grace_period_monitor_loop())

# Helper: Haversine distance in kilometers between two lat/lng points
def haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6371.0 # Earth radius in km
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2)**2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2)**2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return round(R * c, 2)

# Pydantic Schemas
class RegisterSchema(BaseModel):
    name: str
    email: str
    password: str
    phone: Optional[str] = ""
    role: Optional[str] = "driver"

class LoginSchema(BaseModel):
    email: str
    password: str

class ReservationCreateSchema(BaseModel):
    slot_id: str
    lot_id: str
    start_time: str
    duration_hours: float

class StatusUpdateSchema(BaseModel):
    status: str # available, booked, maintenance

class ValidateQRSchema(BaseModel):
    qr_code: str

class NotificationSettingSchema(BaseModel):
    notif_booking: bool
    notif_reminder: bool
    notif_cancellation: bool

class OnboardLotSchema(BaseModel):
    name: str
    address: str
    latitude: float
    longitude: float
    price_per_hour: float
    total_slots: int
    image_url: Optional[str] = None
    admin_id: Optional[str] = None

# --- AUTH ROUTES ---
@app.post("/api/auth/register")
def register(data: RegisterSchema):
    conn = get_db()
    cursor = conn.cursor()

    cursor.execute("SELECT user_id FROM users WHERE email = ?", (data.email,))
    if cursor.fetchone():
        conn.close()
        raise HTTPException(status_code=400, detail="User with this email already exists")

    user_id = f"usr_{uuid.uuid4().hex[:10]}"
    pw_hash = hash_password(data.password)

    cursor.execute(
        "INSERT INTO users (user_id, name, email, password_hash, phone, role) VALUES (?, ?, ?, ?, ?, ?)",
        (user_id, data.name, data.email, pw_hash, data.phone, data.role)
    )
    conn.commit()
    conn.close()

    token = create_access_token({"sub": user_id, "email": data.email, "role": data.role, "name": data.name})
    return {"user": {"user_id": user_id, "name": data.name, "email": data.email, "role": data.role}, "token": token}

@app.post("/api/auth/login")
def login(data: LoginSchema):
    conn = get_db()
    cursor = conn.cursor()

    cursor.execute("SELECT * FROM users WHERE email = ?", (data.email,))
    user = cursor.fetchone()
    conn.close()

    if not user or not verify_password(data.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid email or password")

    token = create_access_token({"sub": user["user_id"], "email": user["email"], "role": user["role"], "name": user["name"]})
    return {
        "user": {
            "user_id": user["user_id"],
            "name": user["name"],
            "email": user["email"],
            "phone": user["phone"],
            "role": user["role"],
            "notif_booking": bool(user["notif_booking"]),
            "notif_reminder": bool(user["notif_reminder"]),
            "notif_cancellation": bool(user["notif_cancellation"])
        },
        "token": token
    }

@app.get("/api/auth/me")
def get_me(user: dict = Depends(get_current_user)):
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT user_id, name, email, phone, role, notif_booking, notif_reminder, notif_cancellation FROM users WHERE user_id = ?", (user["sub"],))
    u = cursor.fetchone()
    conn.close()
    if not u:
        raise HTTPException(status_code=404, detail="User not found")
    return dict(u)

# --- PARKING LOTS & SEARCH (REQ-1 to REQ-6) ---
@app.get("/api/lots")
def search_lots(
    lat: Optional[float] = Query(19.1232),
    lng: Optional[float] = Query(72.8360),
    radius_km: float = Query(5.0),
    search_query: Optional[str] = None,
    min_price: Optional[float] = None,
    max_price: Optional[float] = None,
    sort_by: str = Query("distance") # distance, price, availability
):
    conn = get_db()
    cursor = conn.cursor()

    cursor.execute("""
        SELECT p.*,
               COUNT(s.slot_id) as total_slots_count,
               SUM(CASE WHEN s.status = 'available' THEN 1 ELSE 0 END) as available_slots_count
        FROM parking_lots p
        LEFT JOIN slots s ON p.lot_id = s.lot_id
        GROUP BY p.lot_id
    """)

    lots = []
    for row in cursor.fetchall():
        item = dict(row)
        dist = haversine(lat, lng, item["latitude"], item["longitude"])
        item["distance_km"] = dist
        avail = item["available_slots_count"] or 0
        total = item["total_slots_count"] or item["total_slots"]

        # Availability status badge (REQ-9)
        if avail == 0:
            item["status_label"] = "Full"
            item["status_color"] = "red"
        elif avail / max(1, total) < 0.3:
            item["status_label"] = "Filling Fast"
            item["status_color"] = "orange"
        else:
            item["status_label"] = "Available"
            item["status_color"] = "green"

        lots.append(item)

    conn.close()

    # Filter by search query if provided
    if search_query:
        q = search_query.lower()
        lots = [l for l in lots if q in l["name"].lower() or q in l["address"].lower()]

    # Filter by price
    if min_price is not None:
        lots = [l for l in lots if l["price_per_hour"] >= min_price]
    if max_price is not None:
        lots = [l for l in lots if l["price_per_hour"] <= max_price]

    # Filter by initial radius
    in_radius = [l for l in lots if l["distance_km"] <= radius_km]

    # REQ-6: If no parking lots found in radius, notify & expand radius
    auto_expanded = False
    if not in_radius and lots:
        in_radius = lots # return all lots and flag auto-expansion
        auto_expanded = True

    # Sorting (REQ-5)
    if sort_by == "price":
        in_radius.sort(key=lambda x: x["price_per_hour"])
    elif sort_by == "availability":
        in_radius.sort(key=lambda x: x["available_slots_count"], reverse=True)
    else: # distance default
        in_radius.sort(key=lambda x: x["distance_km"])

    return {
        "lots": in_radius,
        "total_found": len(in_radius),
        "auto_expanded_radius": auto_expanded
    }

@app.get("/api/lots/{lot_id}")
def get_lot_details(lot_id: str):
    conn = get_db()
    cursor = conn.cursor()

    cursor.execute("SELECT * FROM parking_lots WHERE lot_id = ?", (lot_id,))
    lot = cursor.fetchone()
    if not lot:
        conn.close()
        raise HTTPException(status_code=404, detail="Parking lot not found")

    cursor.execute("SELECT * FROM slots WHERE lot_id = ? ORDER BY slot_number ASC", (lot_id,))
    slots = [dict(s) for s in cursor.fetchall()]

    lot_dict = dict(lot)
    lot_dict["slots"] = slots
    lot_dict["available_slots_count"] = sum(1 for s in slots if s["status"] == "available")
    lot_dict["total_slots_count"] = len(slots)

    conn.close()
    return lot_dict

# --- REAL-TIME AVAILABILITY & SLOT MANAGEMENT (REQ-7 to REQ-11) ---
@app.put("/api/slots/{slot_id}/status")
async def update_slot_status(slot_id: str, data: StatusUpdateSchema, user: dict = Depends(require_roles(["lot_admin", "sys_admin"]))):
    conn = get_db()
    cursor = conn.cursor()

    cursor.execute("SELECT lot_id FROM slots WHERE slot_id = ?", (slot_id,))
    row = cursor.fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Slot not found")

    lot_id = row["lot_id"]
    cursor.execute("UPDATE slots SET status = ? WHERE slot_id = ?", (data.status, slot_id))
    conn.commit()
    conn.close()

    # Broadcast status update via WebSocket within < 5s (REQ-8)
    await manager.broadcast({
        "type": "SLOT_STATUS_UPDATED",
        "slot_id": slot_id,
        "lot_id": lot_id,
        "new_status": data.status
    })

    return {"message": "Slot status updated successfully", "slot_id": slot_id, "new_status": data.status}

# --- RESERVATIONS & TRANSACTIONAL LOCKING (REQ-10, REQ-12 - REQ-17, R1 Mitigation) ---
@app.post("/api/reservations")
async def create_reservation(data: ReservationCreateSchema, user: dict = Depends(get_current_user)):
    conn = get_db()
    cursor = conn.cursor()

    user_id = user["sub"]
    slot_id = data.slot_id
    lot_id = data.lot_id

    try:
        # Atomic Transactional Lock (REQ-10): Prevent double booking
        cursor.execute("BEGIN IMMEDIATE;")

        cursor.execute("SELECT status, slot_number FROM slots WHERE slot_id = ? AND lot_id = ?", (slot_id, lot_id))
        slot = cursor.fetchone()
        if not slot:
            conn.rollback()
            conn.close()
            raise HTTPException(status_code=404, detail="Slot not found")

        if slot["status"] != "available":
            conn.rollback()
            conn.close()
            raise HTTPException(
                status_code=409, 
                detail=f"Slot {slot['slot_number']} is no longer available (currently {slot['status']}). Please pick another slot."
            )

        # Check for active existing reservation on this slot
        cursor.execute("""
            SELECT reservation_id FROM reservations 
            WHERE slot_id = ? AND status IN ('active', 'checked_in')
        """, (slot_id,))
        if cursor.fetchone():
            conn.rollback()
            conn.close()
            raise HTTPException(status_code=409, detail="Slot already has an active reservation")

        start_dt = datetime.fromisoformat(data.start_time)
        end_dt = start_dt + timedelta(hours=data.duration_hours)
        end_time_str = end_dt.isoformat()

        res_id = f"res_{uuid.uuid4().hex[:10]}"
        ticket_id = f"tkt_{uuid.uuid4().hex[:10]}"
        qr_code = generate_qr_token(res_id, user_id, slot_id)

        # Update slot status to booked
        cursor.execute("UPDATE slots SET status = 'booked' WHERE slot_id = ?", (slot_id,))

        # Insert reservation
        cursor.execute(
            "INSERT INTO reservations (reservation_id, user_id, slot_id, lot_id, start_time, end_time, status) VALUES (?, ?, ?, ?, ?, ?, 'active')",
            (res_id, user_id, slot_id, lot_id, data.start_time, end_time_str)
        )

        # Insert QR ticket (REQ-22)
        cursor.execute(
            "INSERT INTO tickets (ticket_id, reservation_id, qr_code, status) VALUES (?, ?, ?, 'created')",
            (ticket_id, res_id, qr_code)
        )

        # Fetch lot name for notification
        cursor.execute("SELECT name FROM parking_lots WHERE lot_id = ?", (lot_id,))
        lot_row = cursor.fetchone()
        lot_name = lot_row["name"] if lot_row else "Parking Lot"

        # Booking Confirmation Notification (REQ-27)
        notif_msg = f"Booking Confirmed! Reserved Slot {slot['slot_number']} at {lot_name} from {start_dt.strftime('%H:%M')} to {end_dt.strftime('%H:%M')}."
        cursor.execute(
            "INSERT INTO notifications (notif_id, user_id, type, message) VALUES (?, ?, 'booking', ?)",
            (f"notif_{uuid.uuid4().hex[:8]}", user_id, notif_msg)
        )

        conn.commit()

        # Broadcast live availability update via WebSocket
        await manager.broadcast({
            "type": "SLOT_BOOKED",
            "lot_id": lot_id,
            "slot_id": slot_id,
            "slot_number": slot["slot_number"]
        })

        return {
            "reservation_id": res_id,
            "ticket_id": ticket_id,
            "qr_code": qr_code,
            "slot_number": slot["slot_number"],
            "lot_name": lot_name,
            "start_time": data.start_time,
            "end_time": end_time_str,
            "status": "active"
        }

    except HTTPException:
        raise
    except Exception as e:
        conn.rollback()
        conn.close()
        raise HTTPException(status_code=500, detail=f"Database transaction error: {str(e)}")
    finally:
        conn.close()

@app.get("/api/reservations/my")
def get_my_reservations(user: dict = Depends(get_current_user)):
    conn = get_db()
    cursor = conn.cursor()

    cursor.execute("""
        SELECT r.*, s.slot_number, s.type as slot_type, p.name as lot_name, p.address as lot_address, p.latitude, p.longitude, p.price_per_hour,
               t.ticket_id, t.qr_code, t.entry_time, t.exit_time, t.fee_amount, t.status as ticket_status
        FROM reservations r
        JOIN slots s ON r.slot_id = s.slot_id
        JOIN parking_lots p ON r.lot_id = p.lot_id
        LEFT JOIN tickets t ON r.reservation_id = t.reservation_id
        WHERE r.user_id = ?
        ORDER BY r.created_at DESC
    """, (user["sub"],))

    res_list = [dict(row) for row in cursor.fetchall()]
    conn.close()
    return res_list

@app.post("/api/reservations/{reservation_id}/cancel")
async def cancel_reservation(reservation_id: str, user: dict = Depends(get_current_user)):
    conn = get_db()
    cursor = conn.cursor()

    cursor.execute("SELECT * FROM reservations WHERE reservation_id = ?", (reservation_id,))
    res = cursor.fetchone()
    if not res:
        conn.close()
        raise HTTPException(status_code=404, detail="Reservation not found")

    if res["user_id"] != user["sub"] and user.get("role") not in ["lot_admin", "sys_admin"]:
        conn.close()
        raise HTTPException(status_code=403, detail="Not authorized to cancel this reservation")

    if res["status"] in ["cancelled", "completed", "expired"]:
        conn.close()
        raise HTTPException(status_code=400, detail=f"Reservation is already {res['status']}")

    # Release slot back to pool (REQ-16)
    slot_id = res["slot_id"]
    lot_id = res["lot_id"]

    cursor.execute("UPDATE reservations SET status = 'cancelled' WHERE reservation_id = ?", (reservation_id,))
    cursor.execute("UPDATE tickets SET status = 'invalid' WHERE reservation_id = ?", (reservation_id,))
    cursor.execute("UPDATE slots SET status = 'available' WHERE slot_id = ?", (slot_id,))

    # Cancellation notification (REQ-29)
    cursor.execute(
        "INSERT INTO notifications (notif_id, user_id, type, message) VALUES (?, ?, 'cancellation', ?)",
        (f"notif_cnl_{uuid.uuid4().hex[:8]}", res["user_id"], f"Reservation {reservation_id} has been cancelled. Slot has been freed.")
    )

    conn.commit()
    conn.close()

    await manager.broadcast({
        "type": "SLOT_FREED",
        "lot_id": lot_id,
        "slot_id": slot_id
    })

    return {"message": "Reservation cancelled successfully", "reservation_id": reservation_id}

# --- QR TICKET VALIDATION & GATE SCANNER PORTAL (REQ-22 to REQ-26) ---
@app.post("/api/tickets/validate-entry")
async def validate_entry_ticket(data: ValidateQRSchema, user: dict = Depends(require_roles(["lot_admin", "sys_admin"]))):
    result = verify_qr_token(data.qr_code)
    if not result["valid"]:
        raise HTTPException(status_code=400, detail=result["reason"])

    if result["ticket_status"] == "entered":
        raise HTTPException(status_code=400, detail="Rejection: Ticket has already been used for entry!")
    if result["ticket_status"] in ["exited", "invalid", "expired"]:
        raise HTTPException(status_code=400, detail=f"Rejection: Ticket is invalid or status is {result['ticket_status']}")

    conn = get_db()
    cursor = conn.cursor()
    entry_now = datetime.utcnow().isoformat()

    cursor.execute(
        "UPDATE tickets SET status = 'entered', entry_time = ? WHERE ticket_id = ?",
        (entry_now, result["ticket_id"])
    )
    cursor.execute(
        "UPDATE reservations SET status = 'checked_in' WHERE reservation_id = ?",
        (result["reservation_id"],)
    )
    conn.commit()
    conn.close()

    return {
        "success": True,
        "message": "ENTRY ALLOWED: QR Ticket Validated Successfully!",
        "reservation_id": result["reservation_id"],
        "ticket_id": result["ticket_id"],
        "entry_time": entry_now
    }

@app.post("/api/tickets/validate-exit")
async def validate_exit_ticket(data: ValidateQRSchema, user: dict = Depends(require_roles(["lot_admin", "sys_admin"]))):
    result = verify_qr_token(data.qr_code)
    if not result["valid"]:
        raise HTTPException(status_code=400, detail=result["reason"])

    if result["ticket_status"] != "entered":
        raise HTTPException(status_code=400, detail=f"Rejection: Vehicle has not entered yet or ticket status is {result['ticket_status']}")

    conn = get_db()
    cursor = conn.cursor()
    exit_now = datetime.utcnow().isoformat()

    # Get lot rate per hour
    cursor.execute("""
        SELECT p.price_per_hour, r.slot_id, r.lot_id
        FROM reservations r
        JOIN parking_lots p ON r.lot_id = p.lot_id
        WHERE r.reservation_id = ?
    """, (result["reservation_id"],))
    row = cursor.fetchone()
    rate = row["price_per_hour"]
    slot_id = row["slot_id"]
    lot_id = row["lot_id"]

    fee_info = calculate_parking_fee(result["entry_time"], exit_now, rate)

    cursor.execute(
        "UPDATE tickets SET status = 'exited', exit_time = ?, fee_amount = ? WHERE ticket_id = ?",
        (exit_now, fee_info["total_fee"], result["ticket_id"])
    )
    cursor.execute(
        "UPDATE reservations SET status = 'completed' WHERE reservation_id = ?",
        (result["reservation_id"],)
    )

    # Release slot back to available pool
    cursor.execute("UPDATE slots SET status = 'available' WHERE slot_id = ?", (slot_id,))
    conn.commit()
    conn.close()

    # Broadcast slot freed via WebSocket
    await manager.broadcast({
        "type": "SLOT_FREED",
        "lot_id": lot_id,
        "slot_id": slot_id
    })

    return {
        "success": True,
        "message": "EXIT APPROVED: QR Ticket Processed Successfully!",
        "reservation_id": result["reservation_id"],
        "ticket_id": result["ticket_id"],
        "exit_time": exit_now,
        "parking_duration": fee_info["duration_formatted"],
        "total_fee": fee_info["total_fee"]
    }

# --- NOTIFICATIONS (REQ-27 to REQ-30) ---
@app.get("/api/notifications")
def get_notifications(user: dict = Depends(get_current_user)):
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM notifications WHERE user_id = ? ORDER BY sent_at DESC", (user["sub"],))
    notifs = [dict(n) for n in cursor.fetchall()]
    conn.close()
    return notifs

@app.put("/api/notifications/read-all")
def mark_read(user: dict = Depends(get_current_user)):
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("UPDATE notifications SET is_read = 1 WHERE user_id = ?", (user["sub"],))
    conn.commit()
    conn.close()
    return {"message": "Notifications marked as read"}

@app.put("/api/profile/notification-settings")
def update_notif_settings(data: NotificationSettingSchema, user: dict = Depends(get_current_user)):
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("""
        UPDATE users 
        SET notif_booking = ?, notif_reminder = ?, notif_cancellation = ? 
        WHERE user_id = ?
    """, (int(data.notif_booking), int(data.notif_reminder), int(data.notif_cancellation), user["sub"]))
    conn.commit()
    conn.close()
    return {"message": "Notification preferences saved"}

# --- SYSTEM ADMIN & DASHBOARD STATS ---
@app.post("/api/admin/lots")
def onboard_lot(data: OnboardLotSchema, user: dict = Depends(require_roles(["sys_admin"]))):
    conn = get_db()
    cursor = conn.cursor()

    lot_id = f"lot_{uuid.uuid4().hex[:8]}"
    img = data.image_url or "https://images.unsplash.com/photo-1506521781263-d8422e82f27a?auto=format&fit=crop&w=800&q=80"

    cursor.execute("""
        INSERT INTO parking_lots (lot_id, name, address, latitude, longitude, price_per_hour, total_slots, image_url, admin_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (lot_id, data.name, data.address, data.latitude, data.longitude, data.price_per_hour, data.total_slots, img, data.admin_id))

    # Auto-generate slots for newly onboarded lot
    types = ['standard', 'ev', 'accessible', 'compact']
    slots = []
    for i in range(1, data.total_slots + 1):
        slot_num = f"A-{i:02d}" if i <= data.total_slots//2 else f"B-{(i - data.total_slots//2):02d}"
        slots.append((f"{lot_id}_slot_{i}", lot_id, slot_num, 'available', types[i % 4]))

    cursor.executemany("INSERT INTO slots (slot_id, lot_id, slot_number, status, type) VALUES (?, ?, ?, ?, ?)", slots)
    conn.commit()
    conn.close()

    return {"message": "Parking lot onboarded successfully", "lot_id": lot_id}

@app.get("/api/admin/stats")
def get_admin_stats(user: dict = Depends(require_roles(["sys_admin", "lot_admin"]))):
    conn = get_db()
    cursor = conn.cursor()

    cursor.execute("SELECT COUNT(*) FROM users WHERE role = 'driver'")
    drivers_count = cursor.fetchone()[0]

    cursor.execute("SELECT COUNT(*) FROM parking_lots")
    lots_count = cursor.fetchone()[0]

    cursor.execute("SELECT COUNT(*) FROM slots")
    total_slots = cursor.fetchone()[0]

    cursor.execute("SELECT COUNT(*) FROM slots WHERE status = 'available'")
    avail_slots = cursor.fetchone()[0]

    cursor.execute("SELECT COUNT(*) FROM reservations")
    total_reservations = cursor.fetchone()[0]

    cursor.execute("SELECT SUM(fee_amount) FROM tickets WHERE status = 'exited'")
    total_revenue = cursor.fetchone()[0] or 0.0

    conn.close()

    return {
        "drivers_count": drivers_count,
        "lots_count": lots_count,
        "total_slots": total_slots,
        "available_slots": avail_slots,
        "occupied_slots": total_slots - avail_slots,
        "total_reservations": total_reservations,
        "total_revenue": round(total_revenue, 2)
    }

# --- WEBSOCKET ENDPOINT FOR REAL-TIME AVAILABILITY (REQ-8) ---
@app.websocket("/ws/lots")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            data = await websocket.receive_text()
            # Echo ping/pong or process messages if needed
            await websocket.send_text(f"ACK: {data}")
    except WebSocketDisconnect:
        manager.disconnect(websocket)

# --- SERVE FRONTEND STATIC FILES ---
FRONTEND_DIR = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "frontend"))

from fastapi.responses import FileResponse, RedirectResponse

@app.get("/")
def read_root():
    index_file = os.path.join(FRONTEND_DIR, "index.html")
    if os.path.exists(index_file):
        return FileResponse(index_file)
    return {"message": "SpotSync Server is running v1.1.0"}

if os.path.exists(FRONTEND_DIR):
    app.mount("/app", StaticFiles(directory=FRONTEND_DIR, html=True), name="static_app")
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="static_root")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="127.0.0.1", port=8000, reload=True)
