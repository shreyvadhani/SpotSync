import sqlite3
import hashlib
import os
import json
import uuid
from datetime import datetime, timedelta

DB_PATH = os.path.join(os.path.dirname(__file__), 'spot_sync.db')

def get_db():
    conn = sqlite3.connect(DB_PATH, timeout=20.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    conn.execute("PRAGMA journal_mode = WAL;")
    return conn

def hash_password(password: str) -> str:
    return hashlib.sha256(password.encode('utf-8')).hexdigest()

def init_db():
    conn = get_db()
    cursor = conn.cursor()

    # Create Tables according to SRS Appendix B.2 & Section 6
    cursor.executescript('''
    CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        phone TEXT,
        role TEXT NOT NULL CHECK(role IN ('driver', 'lot_admin', 'sys_admin', 'guest')),
        notif_booking INTEGER DEFAULT 1,
        notif_reminder INTEGER DEFAULT 1,
        notif_cancellation INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS parking_lots (
        lot_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        address TEXT NOT NULL,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        price_per_hour REAL NOT NULL,
        total_slots INTEGER NOT NULL,
        image_url TEXT,
        admin_id TEXT,
        FOREIGN KEY (admin_id) REFERENCES users(user_id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS slots (
        slot_id TEXT PRIMARY KEY,
        lot_id TEXT NOT NULL,
        slot_number TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('available', 'booked', 'maintenance')),
        type TEXT NOT NULL CHECK(type IN ('standard', 'ev', 'accessible', 'compact')),
        FOREIGN KEY (lot_id) REFERENCES parking_lots(lot_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS reservations (
        reservation_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        slot_id TEXT NOT NULL,
        lot_id TEXT NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active', 'checked_in', 'completed', 'cancelled', 'expired')),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
        FOREIGN KEY (slot_id) REFERENCES slots(slot_id) ON DELETE CASCADE,
        FOREIGN KEY (lot_id) REFERENCES parking_lots(lot_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS tickets (
        ticket_id TEXT PRIMARY KEY,
        reservation_id TEXT UNIQUE NOT NULL,
        qr_code TEXT UNIQUE NOT NULL,
        entry_time TEXT,
        exit_time TEXT,
        fee_amount REAL DEFAULT 0.0,
        status TEXT NOT NULL CHECK(status IN ('created', 'entered', 'exited', 'invalid', 'expired')),
        FOREIGN KEY (reservation_id) REFERENCES reservations(reservation_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS notifications (
        notif_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('booking', 'reminder', 'cancellation', 'system')),
        message TEXT NOT NULL,
        is_read INTEGER DEFAULT 0,
        sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
    );
    ''')

    conn.commit()
    seed_initial_data(conn)
    conn.close()

def seed_initial_data(conn):
    cursor = conn.cursor()

    # Check if users exist
    cursor.execute("SELECT COUNT(*) FROM users")
    if cursor.fetchone()[0] > 0:
        return

    print("Seeding initial SpotSync database...")

    # Seed Default Users
    admin_pw = hash_password("admin123")
    driver_pw = hash_password("driver123")

    users_data = [
        ("usr_sysadmin", "System Admin", "admin@spotsync.com", admin_pw, "+19876543210", "sys_admin"),
        ("usr_admin1", "SPIT Lot Manager", "lotadmin@spit.ac.in", admin_pw, "+19876543211", "lot_admin"),
        ("usr_admin2", "BKC Hub Manager", "bkcadmin@spotsync.com", admin_pw, "+19876543212", "lot_admin"),
        ("usr_driver1", "John Driver", "driver@spotsync.com", driver_pw, "+19876543213", "driver"),
        ("usr_driver2", "Sarah Connor", "sarah@spotsync.com", driver_pw, "+19876543214", "driver"),
    ]

    cursor.executemany(
        "INSERT INTO users (user_id, name, email, password_hash, phone, role) VALUES (?, ?, ?, ?, ?, ?)",
        users_data
    )

    # Seed Parking Lots near SPIT Mumbai & BKC area
    lots_data = [
        (
            "lot_spit",
            "Sardar Patel Inst. of Technology Parking",
            "Bhavan's Campus, Munshi Nagar, Andheri West, Mumbai, Maharashtra 400058",
            19.1232, 72.8360,
            40.0, 12,
            "https://images.unsplash.com/photo-1506521781263-d8422e82f27a?auto=format&fit=crop&w=800&q=80",
            "usr_admin1"
        ),
        (
            "lot_bkc",
            "BKC Financial Center Multi-Level Parking",
            "G Block, Bandra Kurla Complex, Bandra East, Mumbai 400051",
            19.0657, 72.8687,
            80.0, 16,
            "https://images.unsplash.com/photo-1590674899484-d5640e854abe?auto=format&fit=crop&w=800&q=80",
            "usr_admin2"
        ),
        (
            "lot_lower_parel",
            "Phoenix Palladium Mall Covered Parking",
            "462, Senapati Bapat Marg, Lower Parel, Mumbai 400013",
            18.9950, 72.8258,
            100.0, 10,
            "https://images.unsplash.com/photo-1573348722427-f1d6819fdf98?auto=format&fit=crop&w=800&q=80",
            "usr_admin1"
        ),
        (
            "lot_andheri_hub",
            "Andheri Metro Station Smart Deck",
            "SV Road, Opp Andheri Station, Mumbai 400058",
            19.1197, 72.8464,
            50.0, 8,
            "https://images.unsplash.com/photo-1543465077-db45d34b88a5?auto=format&fit=crop&w=800&q=80",
            "usr_admin2"
        )
    ]

    cursor.executemany(
        "INSERT INTO parking_lots (lot_id, name, address, latitude, longitude, price_per_hour, total_slots, image_url, admin_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        lots_data
    )

    # Seed Slots for each lot
    types = ['standard', 'ev', 'accessible', 'compact']
    for lot_id, name, addr, lat, lng, price, count, img, admin in lots_data:
        slots = []
        for i in range(1, count + 1):
            slot_num = f"A-{i:02d}" if i <= count//2 else f"B-{(i - count//2):02d}"
            stype = types[i % 4]
            # Make a couple of slots booked/maintenance for realism
            status = 'available'
            if i == 3:
                status = 'maintenance'
            elif i == 5:
                status = 'booked'

            slots.append((
                f"{lot_id}_slot_{i}",
                lot_id,
                slot_num,
                status,
                stype
            ))
        cursor.executemany(
            "INSERT INTO slots (slot_id, lot_id, slot_number, status, type) VALUES (?, ?, ?, ?, ?)",
            slots
        )

    # Create a sample past reservation & ticket for John Driver
    now = datetime.now()
    start_str = (now - timedelta(hours=2)).isoformat()
    end_str = (now + timedelta(hours=1)).isoformat()

    sample_res_id = "res_demo_001"
    sample_ticket_id = "tkt_demo_001"
    sample_qr = "SPOTSYNC-TICKET-res_demo_001-SECUREHASH987"

    cursor.execute(
        "INSERT INTO reservations (reservation_id, user_id, slot_id, lot_id, start_time, end_time, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (sample_res_id, "usr_driver1", "lot_spit_slot_5", "lot_spit", start_str, end_str, "checked_in")
    )

    cursor.execute(
        "INSERT INTO tickets (ticket_id, reservation_id, qr_code, entry_time, exit_time, fee_amount, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (sample_ticket_id, sample_res_id, sample_qr, (now - timedelta(hours=1, minutes=45)).isoformat(), None, 40.0, "entered")
    )

    # Seed Notifications
    cursor.execute(
        "INSERT INTO notifications (notif_id, user_id, type, message) VALUES (?, ?, ?, ?)",
        ("notif_001", "usr_driver1", "booking", "Booking Confirmed! Slot A-05 reserved at Sardar Patel Inst. of Technology Parking.")
    )

    conn.commit()
    print("Database seeding completed successfully.")

if __name__ == '__main__':
    init_db()
