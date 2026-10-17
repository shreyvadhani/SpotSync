import hmac
import hashlib
import time
import math
from datetime import datetime, timedelta
from database import get_db

QR_SECRET = "SPOTSYNC_QR_SIGNING_SECRET_KEY_9988"
DEFAULT_GRACE_PERIOD_MINUTES = 15

def generate_qr_token(reservation_id: str, user_id: str, slot_id: str) -> str:
    """Generates a cryptographically signed QR code token for contactless entry/exit"""
    data_payload = f"{reservation_id}:{user_id}:{slot_id}"
    signature = hmac.new(
        QR_SECRET.encode('utf-8'),
        data_payload.encode('utf-8'),
        hashlib.sha256
    ).hexdigest()[:16].upper()
    return f"SPOTSYNC:{reservation_id}:{signature}"

def verify_qr_token(qr_code: str) -> dict:
    """Validates the QR token format and cryptographic signature"""
    parts = qr_code.split(":")
    if len(parts) != 3 or parts[0] != "SPOTSYNC":
        return {"valid": False, "reason": "Invalid QR code format"}
    
    res_id = parts[1]
    provided_sig = parts[2]

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT r.reservation_id, r.user_id, r.slot_id, r.status as res_status, t.status as ticket_status, t.ticket_id, t.entry_time
        FROM reservations r
        JOIN tickets t ON r.reservation_id = t.reservation_id
        WHERE r.reservation_id = ?
    """, (res_id,))
    row = cursor.fetchone()
    conn.close()

    if not row:
        return {"valid": False, "reason": "Reservation not found"}

    expected_data = f"{row['reservation_id']}:{row['user_id']}:{row['slot_id']}"
    expected_sig = hmac.new(
        QR_SECRET.encode('utf-8'),
        expected_data.encode('utf-8'),
        hashlib.sha256
    ).hexdigest()[:16].upper()

    if not hmac.compare_digest(provided_sig, expected_sig):
        return {"valid": False, "reason": "Security verification failed: Signature forged or invalid"}

    return {
        "valid": True,
        "reservation_id": row["reservation_id"],
        "ticket_id": row["ticket_id"],
        "user_id": row["user_id"],
        "slot_id": row["slot_id"],
        "res_status": row["res_status"],
        "ticket_status": row["ticket_status"],
        "entry_time": row["entry_time"]
    }

def calculate_parking_fee(entry_time_str: str, exit_time_str: str, price_per_hour: float) -> dict:
    """Calculates total parking duration and fee based on entry and exit timestamps (REQ-25)"""
    entry_dt = datetime.fromisoformat(entry_time_str)
    exit_dt = datetime.fromisoformat(exit_time_str)

    duration_seconds = max(0, (exit_dt - entry_dt).total_seconds())
    duration_hours = max(0.5, round(duration_seconds / 3600.0, 2))
    # Billable hours (at least 1 hour minimum, rounded up to next 0.5hr)
    billable_hours = math.ceil(duration_hours * 2) / 2.0
    if billable_hours < 1.0:
        billable_hours = 1.0

    total_fee = round(billable_hours * price_per_hour, 2)

    mins = int((duration_seconds % 3600) // 60)
    hrs = int(duration_seconds // 3600)
    duration_formatted = f"{hrs}h {mins}m" if hrs > 0 else f"{mins} mins"

    return {
        "duration_hours": duration_hours,
        "billable_hours": billable_hours,
        "duration_formatted": duration_formatted,
        "total_fee": total_fee
    }

def check_grace_period_expirations():
    """
    REQ-17 & Business Rule: Automatically cancels reservations and releases slots
    if the user does not check in (scan QR) within grace period (default 15 mins).
    """
    conn = get_db()
    cursor = conn.cursor()

    now = datetime.utcnow()
    # Find active reservations where start_time + grace_period < now and status == 'active'
    cursor.execute("""
        SELECT r.reservation_id, r.user_id, r.slot_id, r.lot_id, r.start_time, p.name as lot_name
        FROM reservations r
        JOIN parking_lots p ON r.lot_id = p.lot_id
        WHERE r.status = 'active'
    """)

    expired_lots = set()

    for row in cursor.fetchall():
        try:
            start_dt = datetime.fromisoformat(row['start_time'])
            grace_deadline = start_dt + timedelta(minutes=DEFAULT_GRACE_PERIOD_MINUTES)
            if now > grace_deadline:
                res_id = row['reservation_id']
                slot_id = row['slot_id']
                user_id = row['user_id']
                lot_id = row['lot_id']
                lot_name = row['lot_name']

                # Transaction to expire reservation and free slot
                cursor.execute("UPDATE reservations SET status = 'expired' WHERE reservation_id = ?", (res_id,))
                cursor.execute("UPDATE tickets SET status = 'expired' WHERE reservation_id = ?", (res_id,))
                cursor.execute("UPDATE slots SET status = 'available' WHERE slot_id = ?", (slot_id,))
                
                # Send cancellation notification REQ-29
                notif_msg = f"Reservation Expired: You did not check in within {DEFAULT_GRACE_PERIOD_MINUTES} mins of start time at {lot_name}. Slot has been released."
                cursor.execute(
                    "INSERT INTO notifications (notif_id, user_id, type, message) VALUES (?, ?, 'cancellation', ?)",
                    (f"notif_exp_{res_id[:8]}", user_id, notif_msg)
                )

                expired_lots.add(lot_id)
                print(f"[GRACE MONITOR] Expired reservation {res_id}, freed slot {slot_id}")
        except Exception as e:
            print(f"[GRACE MONITOR ERROR] {e}")

    conn.commit()
    conn.close()
    return list(expired_lots)
