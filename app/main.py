"""
CinemaSync Signaling Server
──────────────────────────
FastAPI  +  python-socketio  (async mode)

Handles:
  • Room creation / joining
  • WebRTC SDP + ICE relay
  • Chat broadcasting
  • Movie-playback sync
"""

import logging
import os
import uuid

import socketio
from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

# ─── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s │ %(levelname)s │ %(message)s",
)
logger = logging.getLogger("cinemasync")

# ─── In-memory stores ─────────────────────────────────────────────────────────
rooms: dict[str, dict] = {}       # room_id → {"users": [sid, …]}
sid_to_user: dict[str, str] = {}  # sid → user_id
sid_to_room: dict[str, str] = {}  # sid → room_id

MAX_USERS_PER_ROOM = 3

# ─── FastAPI app ───────────────────────────────────────────────────────────────
fastapi_app = FastAPI(title="CinemaSync Signaling Server")
fastapi_app.mount("/static", StaticFiles(directory="app/static"), name="static")
templates = Jinja2Templates(directory="app/templates")

# ─── Socket.IO server ─────────────────────────────────────────────────────────
sio = socketio.AsyncServer(
    async_mode="asgi",
    cors_allowed_origins="*",
    logger=False,
    engineio_logger=False,
    ping_timeout=60,
    ping_interval=25,
)


@fastapi_app.get("/")
async def index(request: Request):
    """Serve the main SPA page."""
    return templates.TemplateResponse("index.html", {"request": request})


@fastapi_app.get("/health")
async def health():
    """Health-check endpoint."""
    return {
        "status": "ok",
        "rooms": len(rooms),
        "connected_users": len(sid_to_user),
    }


@fastapi_app.get("/debug/rooms")
async def debug_rooms():
    """Debug endpoint — see all active rooms and connected users."""
    return {
        "active_rooms": {
            rid: {
                "user_count": len(r["users"]),
                "user_ids": [sid_to_user.get(s, "?") for s in r["users"]],
            }
            for rid, r in rooms.items()
        },
        "total_connections": len(sid_to_user),
    }


@fastapi_app.get("/api/turn-credentials")
async def turn_credentials():
    """
    Fetch fresh TURN server credentials from Metered.ca's free API.
    Set METERED_API_KEY env variable with your key from https://www.metered.ca/stun-turn
    """
    api_key = os.environ.get("METERED_API_KEY", "")

    if not api_key:
        logger.warning("⚠  No METERED_API_KEY set — using STUN only (may fail across NATs)")
        return {
            "iceServers": [
                {"urls": ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"]}
            ]
        }

    try:
        import httpx
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                f"https://cinemasync.metered.live/api/v1/turn/credentials?apiKey={api_key}",
                timeout=5.0,
            )
            if resp.status_code == 200:
                ice_servers = resp.json()
                # Add STUN as first option
                ice_servers.insert(0, {"urls": ["stun:stun.l.google.com:19302"]})
                logger.info("✅  Fetched %d TURN servers from Metered.ca", len(ice_servers) - 1)
                return {"iceServers": ice_servers}
            else:
                logger.error("❌  Metered.ca API error: %s", resp.text)
    except Exception as e:
        logger.error("❌  Failed to fetch TURN credentials: %s", e)

    # Fallback to STUN only
    return {
        "iceServers": [
            {"urls": ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"]}
        ]
    }


# ─── Combine FastAPI + Socket.IO into a single ASGI app ────────────────────────
app = socketio.ASGIApp(sio, other_asgi_app=fastapi_app)


# ═══════════════════════════════════════════════════════════════════════════════
#  Helper Functions
# ═══════════════════════════════════════════════════════════════════════════════

def _generate_room_id() -> str:
    return uuid.uuid4().hex[:8].upper()


def _generate_user_id() -> str:
    return uuid.uuid4().hex[:12]


async def _broadcast_to_room(room_id: str, event: str, data: dict, skip_sid: str | None = None):
    """Send an event to every user in a room, optionally skipping one SID."""
    room = rooms.get(room_id)
    if not room:
        return
    for sid in list(room["users"]):  # copy list to avoid mutation issues
        if sid != skip_sid:
            await sio.emit(event, data, to=sid)


# ═══════════════════════════════════════════════════════════════════════════════
#  Socket.IO Event Handlers
# ═══════════════════════════════════════════════════════════════════════════════

@sio.event
async def connect(sid, environ):
    user_id = _generate_user_id()
    sid_to_user[sid] = user_id
    await sio.emit("user_id", {"user_id": user_id}, to=sid)
    logger.info("🟢  Connected: sid=%s  user_id=%s", sid, user_id)


@sio.event
async def disconnect(sid):
    user_id = sid_to_user.pop(sid, None)
    room_id = sid_to_room.pop(sid, None)

    if room_id:
        room = rooms.get(room_id)
        if room:
            if sid in room["users"]:
                room["users"].remove(sid)

            # Notify remaining users
            await _broadcast_to_room(room_id, "user_disconnected", {
                "user_id": user_id or "unknown",
            })

            # Clean up empty rooms safely
            if not room["users"]:
                rooms.pop(room_id, None)  # safe pop, no KeyError
                logger.info("🗑️  Room deleted (empty): %s", room_id)

    logger.info("🔴  Disconnected: sid=%s  user_id=%s", sid, user_id)


# ─── Room Management ───────────────────────────────────────────────────────────

@sio.event
async def create_room(sid, data):
    # Remove from old room if any
    old_room_id = sid_to_room.pop(sid, None)
    if old_room_id and old_room_id in rooms:
        room = rooms[old_room_id]
        if sid in room["users"]:
            room["users"].remove(sid)
        if not room["users"]:
            rooms.pop(old_room_id, None)

    room_id = _generate_room_id()
    rooms[room_id] = {"users": [sid]}
    sid_to_room[sid] = room_id

    await sio.emit("room_created", {"room_id": room_id}, to=sid)
    logger.info("🏠  Room created: %s by sid=%s", room_id, sid)


@sio.event
async def join_room(sid, data):
    room_id = data.get("room_id", "").strip().upper()

    if not room_id:
        await sio.emit("error", {"message": "Room ID is required."}, to=sid)
        return

    if room_id not in rooms:
        await sio.emit("error", {"message": f"Room '{room_id}' does not exist."}, to=sid)
        return

    room = rooms[room_id]

    if sid in room["users"]:
        await sio.emit("error", {"message": "You are already in this room."}, to=sid)
        return

    if len(room["users"]) >= MAX_USERS_PER_ROOM:
        await sio.emit("error", {"message": "Room is full."}, to=sid)
        return

    # Remove from old room if any
    old_room_id = sid_to_room.pop(sid, None)
    if old_room_id and old_room_id in rooms and old_room_id != room_id:
        old_room = rooms[old_room_id]
        if sid in old_room["users"]:
            old_room["users"].remove(sid)
        if not old_room["users"]:
            rooms.pop(old_room_id, None)

    room["users"].append(sid)
    sid_to_room[sid] = room_id

    user_ids = [sid_to_user.get(s, "?") for s in room["users"]]

    # Notify the joiner
    await sio.emit("room_joined", {
        "room_id": room_id,
        "users": user_ids,
    }, to=sid)

    # Notify everyone else
    await _broadcast_to_room(room_id, "user_joined", {
        "user_id": sid_to_user.get(sid, "unknown"),
        "users": user_ids,
    }, skip_sid=sid)

    logger.info("➕  sid=%s joined room %s  (users=%d)", sid, room_id, len(room["users"]))


# ─── WebRTC Signaling ──────────────────────────────────────────────────────────

@sio.event
async def webrtc_offer(sid, data):
    room_id = sid_to_room.get(sid)
    if not room_id:
        logger.warning("⚠  Offer from sid=%s but no room!", sid)
        return

    payload = {
        "offer": data.get("offer"),
        "from": sid_to_user.get(sid, "unknown"),
    }
    await _broadcast_to_room(room_id, "webrtc_offer", payload, skip_sid=sid)
    logger.info("📡  Offer relayed from sid=%s in room %s", sid, room_id)


@sio.event
async def webrtc_answer(sid, data):
    room_id = sid_to_room.get(sid)
    if not room_id:
        logger.warning("⚠  Answer from sid=%s but no room!", sid)
        return

    payload = {
        "answer": data.get("answer"),
        "from": sid_to_user.get(sid, "unknown"),
    }
    await _broadcast_to_room(room_id, "webrtc_answer", payload, skip_sid=sid)
    logger.info("📡  Answer relayed from sid=%s in room %s", sid, room_id)


@sio.event
async def webrtc_ice_candidate(sid, data):
    room_id = sid_to_room.get(sid)
    if not room_id:
        return

    payload = {
        "candidate": data.get("candidate"),
        "from": sid_to_user.get(sid, "unknown"),
    }
    await _broadcast_to_room(room_id, "webrtc_ice_candidate", payload, skip_sid=sid)
    # Log first candidate only (there are many)
    logger.info("🧊  ICE candidate relayed from sid=%s in room %s", sid, room_id)


# ─── Chat ──────────────────────────────────────────────────────────────────────

@sio.event
async def chat_message(sid, data):
    room_id = sid_to_room.get(sid)
    if not room_id:
        return

    payload = {
        "message": data.get("message", ""),
        "user_id": sid_to_user.get(sid, "unknown"),
        "timestamp": data.get("timestamp", ""),
    }
    await _broadcast_to_room(room_id, "chat_message", payload, skip_sid=sid)
    logger.info("💬  Chat in room %s from %s", room_id, payload["user_id"])


# ─── Screen Share Notifications ────────────────────────────────────────────────

@sio.event
async def screen_share_started(sid, data):
    room_id = sid_to_room.get(sid)
    if not room_id:
        return

    payload = {
        "from": sid_to_user.get(sid, "unknown"),
    }
    await _broadcast_to_room(room_id, "screen_share_started", payload, skip_sid=sid)
    logger.info("🖥️  Screen share started by sid=%s in room %s", sid, room_id)


@sio.event
async def screen_share_stopped(sid, data):
    room_id = sid_to_room.get(sid)
    if not room_id:
        return

    payload = {
        "from": sid_to_user.get(sid, "unknown"),
    }
    await _broadcast_to_room(room_id, "screen_share_stopped", payload, skip_sid=sid)
    logger.info("🖥️  Screen share stopped by sid=%s in room %s", sid, room_id)


# ═══════════════════════════════════════════════════════════════════════════════
if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        host="0.0.0.0",
        port=8000,
        log_level="info",
    )
