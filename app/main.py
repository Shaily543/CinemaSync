"""
ShareMOV - P2P Video Call, Chat & Screen Share Signaling Server
================================================================
FastAPI backend with Socket.IO for WebRTC signaling, room management,
live chat, and synchronized movie playback control.
"""

import uuid
import logging
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.requests import Request
import socketio

# ─── Logging ────────────────────────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO, format="%(asctime)s │ %(levelname)s │ %(message)s")
logger = logging.getLogger("sharemov")

# ─── Paths ──────────────────────────────────────────────────────────────────────
BASE_DIR = Path(__file__).resolve().parent
TEMPLATES_DIR = BASE_DIR / "templates"
STATIC_DIR = BASE_DIR / "static"

# ─── In-Memory Store ────────────────────────────────────────────────────────────
# rooms = { room_id: { "users": [sid, ...] } }
rooms: dict[str, dict] = {}
# sid_to_user = { sid: user_id }
sid_to_user: dict[str, str] = {}
# sid_to_room = { sid: room_id }
sid_to_room: dict[str, str] = {}

# ─── Socket.IO (Async) ─────────────────────────────────────────────────────────
sio = socketio.AsyncServer(
    async_mode="asgi",
    cors_allowed_origins="*",
    logger=False,
    engineio_logger=False,
)

# ─── FastAPI App ────────────────────────────────────────────────────────────────
fastapi_app = FastAPI(title="ShareMOV", version="0.1.0")
fastapi_app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
templates = Jinja2Templates(directory=str(TEMPLATES_DIR))


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


# ─── Combine FastAPI + Socket.IO into a single ASGI app ────────────────────────
app = socketio.ASGIApp(sio, other_asgi_app=fastapi_app)


# ═══════════════════════════════════════════════════════════════════════════════
#  Helper Functions
# ═══════════════════════════════════════════════════════════════════════════════

def _generate_room_id() -> str:
    """Generate a short, unique 8-character room ID."""
    return uuid.uuid4().hex[:8].upper()


def _generate_user_id() -> str:
    """Generate a unique user identifier."""
    return uuid.uuid4().hex[:12]


async def _get_room_sids(room_id: str) -> list[str]:
    """Return the list of SIDs currently in a room."""
    room = rooms.get(room_id)
    if room:
        return list(room["users"])
    return []


async def _broadcast_to_room(room_id: str, event: str, data: dict, skip_sid: str | None = None):
    """Send an event to every user in a room, optionally skipping one SID."""
    sids = await _get_room_sids(room_id)
    for sid in sids:
        if sid != skip_sid:
            await sio.emit(event, data, to=sid)


# ═══════════════════════════════════════════════════════════════════════════════
#  Socket.IO Event Handlers
# ═══════════════════════════════════════════════════════════════════════════════

@sio.event
async def connect(sid, environ):
    """Handle new client connection — assign a user ID."""
    user_id = _generate_user_id()
    sid_to_user[sid] = user_id
    await sio.emit("user_id", {"user_id": user_id}, to=sid)
    logger.info("🟢  Connected: sid=%s  user_id=%s", sid, user_id)


@sio.event
async def disconnect(sid):
    """Handle client disconnect — clean up rooms and notify peers."""
    user_id = sid_to_user.pop(sid, None)
    room_id = sid_to_room.pop(sid, None)

    if room_id and room_id in rooms:
        room = rooms[room_id]
        if sid in room["users"]:
            room["users"].remove(sid)

        # Notify remaining users
        await _broadcast_to_room(room_id, "user_disconnected", {
            "user_id": user_id or "unknown",
        })

        # Clean up empty rooms
        if not room["users"]:
            del rooms[room_id]
            logger.info("🗑️  Room deleted (empty): %s", room_id)

    logger.info("🔴  Disconnected: sid=%s  user_id=%s", sid, user_id)


# ─── Room Management ───────────────────────────────────────────────────────────

@sio.event
async def create_room(sid, data):
    """Create a new room and join the creator into it."""
    room_id = _generate_room_id()
    rooms[room_id] = {"users": [sid]}
    sid_to_room[sid] = room_id

    await sio.emit("room_created", {"room_id": room_id}, to=sid)
    logger.info("🏠  Room created: %s by sid=%s", room_id, sid)


@sio.event
async def join_room(sid, data):
    """Join an existing room."""
    room_id = data.get("room_id", "").strip().upper()

    if not room_id:
        await sio.emit("error", {"message": "Room ID is required."}, to=sid)
        return

    if room_id not in rooms:
        await sio.emit("error", {"message": f"Room '{room_id}' does not exist."}, to=sid)
        return

    room = rooms[room_id]

    # Prevent joining the same room twice
    if sid in room["users"]:
        await sio.emit("error", {"message": "You are already in this room."}, to=sid)
        return

    # Limit room to 3 users max (small group testing)
    if len(room["users"]) >= 3:
        await sio.emit("error", {"message": "Room is full (max 3 users)."}, to=sid)
        return

    # Leave any previous room
    old_room_id = sid_to_room.get(sid)
    if old_room_id and old_room_id in rooms and old_room_id != room_id:
        old_room = rooms[old_room_id]
        if sid in old_room["users"]:
            old_room["users"].remove(sid)
        if not old_room["users"]:
            del rooms[old_room_id]

    room["users"].append(sid)
    sid_to_room[sid] = room_id

    user_id = sid_to_user.get(sid, "unknown")

    # Build user list for the client
    user_list = [sid_to_user.get(s, "unknown") for s in room["users"]]

    # Tell the joiner they're in
    await sio.emit("room_joined", {
        "room_id": room_id,
        "users": user_list,
    }, to=sid)

    # Tell everyone else that someone new joined
    await _broadcast_to_room(room_id, "user_joined", {
        "user_id": user_id,
        "users": user_list,
    }, skip_sid=sid)

    logger.info("➕  sid=%s joined room %s  (users=%d)", sid, room_id, len(room["users"]))


# ─── WebRTC Signaling ──────────────────────────────────────────────────────────

@sio.event
async def webrtc_offer(sid, data):
    """
    Relay a WebRTC SDP offer to all other users in the same room.
    The 'from' field lets the receiver know who sent it.
    """
    room_id = sid_to_room.get(sid)
    if not room_id:
        return

    user_id = sid_to_user.get(sid, "unknown")
    payload = {
        "offer": data.get("offer"),
        "from": user_id,
    }

    await _broadcast_to_room(room_id, "webrtc_offer", payload, skip_sid=sid)
    logger.info("📡  Offer relayed from sid=%s in room %s", sid, room_id)


@sio.event
async def webrtc_answer(sid, data):
    """
    Relay a WebRTC SDP answer back to the offerer.
    Broadcasts to all other peers in the room.
    """
    room_id = sid_to_room.get(sid)
    if not room_id:
        return

    user_id = sid_to_user.get(sid, "unknown")
    payload = {
        "answer": data.get("answer"),
        "from": user_id,
    }

    await _broadcast_to_room(room_id, "webrtc_answer", payload, skip_sid=sid)
    logger.info("📡  Answer relayed from sid=%s in room %s", sid, room_id)


@sio.event
async def webrtc_ice_candidate(sid, data):
    """Relay ICE candidates to all other peers in the room."""
    room_id = sid_to_room.get(sid)
    if not room_id:
        return

    user_id = sid_to_user.get(sid, "unknown")
    payload = {
        "candidate": data.get("candidate"),
        "from": user_id,
    }

    await _broadcast_to_room(room_id, "webrtc_ice_candidate", payload, skip_sid=sid)


# ─── Chat ──────────────────────────────────────────────────────────────────────

@sio.event
async def chat_message(sid, data):
    """Broadcast a chat message to everyone else in the room."""
    room_id = sid_to_room.get(sid)
    if not room_id:
        return

    user_id = sid_to_user.get(sid, "unknown")
    payload = {
        "message": data.get("message", ""),
        "user_id": user_id,
        "timestamp": data.get("timestamp", ""),
    }

    await _broadcast_to_room(room_id, "chat_message", payload, skip_sid=sid)
    logger.info("💬  Chat in room %s from %s", room_id, user_id)


# ─── Movie Playback Sync ──────────────────────────────────────────────────────

@sio.event
async def movie_control(sid, data):
    """Broadcast movie playback control events (play/pause/seek/load) to room peers."""
    room_id = sid_to_room.get(sid)
    if not room_id:
        return

    payload = {
        "action": data.get("action"),
        "value": data.get("value"),
    }

    await _broadcast_to_room(room_id, "movie_control", payload, skip_sid=sid)
    logger.info("🎬  Movie control '%s' in room %s", data.get("action"), room_id)


# ═══════════════════════════════════════════════════════════════════════════════
#  Run with:  uvicorn app.main:app --reload
# ═══════════════════════════════════════════════════════════════════════════════
if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        host="0.0.0.0",
        port=8000,
        log_level="info",
    )
