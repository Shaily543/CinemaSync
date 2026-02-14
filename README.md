# 🎬 CinemaSync

**Watch movies together in real-time with friends using peer-to-peer video calls, live chat, and synchronized playback.**

CinemaSync is a modern web application that enables seamless movie watching experiences with real-time video communication, instant messaging, and screen sharing capabilities. Built with WebRTC for direct peer-to-peer connections and FastAPI for robust signaling.

---

## ✨ Features

- 🎥 **P2P Video Calls** - Crystal clear video and audio communication with direct peer-to-peer connections
- 💬 **Live Chat** - Real-time messaging while watching without switching apps
- 🎬 **Synchronized Playback** - Watch movies in perfect sync with your friend
- 🖥️ **Screen Sharing** - Share your screen with friends during the watch session
- 🔗 **Simple Room Creation** - Generate unique 8-character room IDs to invite friends
- 🌍 **NAT Traversal** - Automatic TURN server configuration for reliable connections across networks
- 📱 **Responsive Design** - Works on desktop and mobile devices with adaptive UI
- ⚙️ **System Status Monitoring** - Real-time connection status and system messages
- 🔐 **Secure P2P** - Direct encrypted connections without centralized media handling

---

## 🚀 Quick Start

### Prerequisites

- Python 3.12+
- [uv](https://github.com/astral-sh/uv) package manager (or pip)
- Modern web browser with WebRTC support

### Installation

1. **Clone the repository**

   ```bash
   git clone <repository-url>
   cd CinemaSync
   ```

2. **Install dependencies**

   ```bash
   uv sync
   ```

3. **Set up environment variables (optional)**

   ```bash
   export METERED_API_KEY="your-metered-api-key"  # Get from https://www.metered.ca
   ```

4. **Run the server**

   ```bash
   uv run uvicorn app.main:app --host 0.0.0.0 --port 8000
   ```

5. **Access the application**
   - Open your browser to `http://localhost:8000`

### Run Over the Internet

To access CinemaSync from outside your local network:

```bash
# Terminal 1: Start the CinemaSync server
uv run uvicorn app.main:app --host 0.0.0.0 --port 8000

# Terminal 2: Expose via ngrok (or similar tunneling service)
ngrok http 8000
```

Then share the ngrok URL with your friends to connect.

---

## 📋 How It Works

### Room Management

1. **Create Room**: Click "Create Room" to generate a unique 8-character room ID
2. **Join Room**: Share your room ID with a friend and they can join by entering it
3. **Start Watching**: Once connected, click "Start Watching" to enter the video call area

### Video Communication

- **Enable/Disable Audio**: Toggle microphone on/off during calls
- **Enable/Disable Video**: Toggle camera on/off during calls
- **Screen Sharing**: Share your screen with your friend using the screen share button
- **Exit Room**: Leave the room and return to the home screen

### Real-time Chat

- Send and receive instant text messages during video sessions
- System messages show connection status and events
- Chat persists during the entire watching session

---

## 🏗️ Architecture

### Backend (FastAPI + Socket.IO)

- **Signaling Server**: Handles WebRTC offer/answer exchange and ICE candidates
- **Room Management**: Creates and manages virtual rooms with user limits (max 3 users)
- **Event Broadcasting**: Distributes messages to all users in a room
- **Health Monitoring**: Provides endpoints for debugging and room status

### Frontend (HTML/CSS/JavaScript)

- **Responsive UI**: Mobile-first design with dynamic layouts
- **WebRTC Implementation**: Manages peer connections, media streams, and ICE candidates
- **Socket.IO Client**: Real-time bidirectional communication with the signaling server
- **State Management**: Tracks application state, connections, and user interactions

### WebRTC Flow

```
Client 1                    Signaling Server                Client 2
   |                              |                            |
   |------ create_room ---------->|                            |
   |<----- room_created -----------|                            |
   |                              |<----- join_room -----------|
   |<---- user_joined_event ------|------ user_joined ------->|
   |                              |                            |
   |------ webrtc_offer --------->|------ webrtc_offer ------>|
   |<------ webrtc_answer --------|<----- webrtc_answer ------|
   |------ ice_candidate -------->|------ ice_candidate ----->|
   |                    (P2P Connection Established)           |
   |<══════════════════ Direct Media/Data ═════════════════>|
```

---

## 📁 Project Structure

```
CinemaSync/
├── app/
│   ├── main.py              # FastAPI + Socket.IO signaling server
│   ├── static/
│   │   ├── css/
│   │   │   └── style.css    # Responsive UI styling
│   │   └── js/
│   │       └── app.js       # Frontend logic & WebRTC implementation
│   └── templates/
│       └── index.html       # Single-page application
├── pyproject.toml           # Project metadata & dependencies
├── uv.lock                  # Dependency lock file
└── README.md               # This file
```

---

## 🔧 API Endpoints

### Health & Debug

- `GET /` - Serve the main SPA page
- `GET /health` - Health check with active rooms and connections
- `GET /debug/rooms` - Debug endpoint showing all active rooms and users
- `GET /api/turn-credentials` - Fetch TURN server credentials from Metered.ca

### Socket.IO Events

#### Client → Server

- `create_room` - Create a new room
- `join_room` - Join an existing room
- `webrtc_offer` - Send WebRTC offer
- `webrtc_answer` - Send WebRTC answer
- `webrtc_ice_candidate` - Send ICE candidate
- `chat_message` - Send chat message
- `screen_share_started` - Notify screen sharing start
- `screen_share_stopped` - Notify screen sharing stop

#### Server → Client

- `room_created` - Room successfully created
- `room_joined` - Successfully joined a room
- `user_joined` - New user joined the room
- `user_disconnected` - User left the room
- `webrtc_offer` - Received WebRTC offer
- `webrtc_answer` - Received WebRTC answer
- `webrtc_ice_candidate` - Received ICE candidate
- `chat_message` - Received chat message
- `screen_share_started` - User started screen sharing
- `screen_share_stopped` - User stopped screen sharing
- `error` - Error message from server

---

## 🛠️ Configuration

### Environment Variables

- `METERED_API_KEY` - API key for Metered.ca TURN servers (optional)
  - Without it, the app falls back to Google's public STUN servers
  - Get your free key at https://www.metered.ca/stun-turn

### WebRTC Configuration

Default TURN servers are configured in [app.js](app/static/js/app.js):

```javascript
const RTCConfig = {
    iceServers: [
        { urls: 'stun:stun.relay.metered.ca:80' },
        { urls: 'turn:global.relay.metered.ca:80', ... },
        // ... additional TURN servers
    ]
};
```

---

## 📊 Room Limits

- **Maximum users per room**: 3
- **Room ID format**: 8 uppercase alphanumeric characters
- **Auto-cleanup**: Empty rooms are automatically deleted

---

## 🔍 Debugging

### View Active Rooms

```bash
curl http://localhost:8000/debug/rooms
```

### Monitor Logs

The server logs all important events:

```
✅ Connected: sid=... user_id=...
🏠 Room created: ABCD1234 by sid=...
➕ sid=... joined room ABCD1234 (users=2)
📡 Offer relayed from sid=... in room ABCD1234
💬 Chat in room ABCD1234 from user_id
🔴 Disconnected: sid=...
```

---

## 🚨 Troubleshooting

### Connection Issues

1. **Video/Audio not working**: Check browser permissions for camera/microphone
2. **Cannot connect to remote user**:
   - Ensure both users are in the same room
   - Check firewall settings
   - Try updating METERED_API_KEY
3. **NAT/Firewall blocking**: TURN servers help, but ensure ports 80 and 443 are accessible

### Chat Not Updating

- Check browser console for errors
- Verify Socket.IO connection is established
- Refresh the page and try again

### Screen Share Not Working

- Ensure your browser supports the Screen Capture API
- Grant permission when prompted
- Check system-level screen sharing permissions

---

## 🤝 Contributing

Contributions are welcome! Please feel free to submit pull requests or open issues for bugs and feature requests.

---

## 📄 License

This project is provided as-is for educational and personal use.

---

## 🎓 Technologies Used

- **Backend**: FastAPI, python-socketio, Uvicorn
- **Frontend**: Vanilla JavaScript, HTML5, CSS3
- **Real-time Communication**: WebRTC, Socket.IO
- **Signaling**: Custom Socket.IO-based signaling protocol
- **ICE Servers**: Metered.ca TURN servers (fallback to Google STUN)

---

## 📞 Support

For issues, questions, or suggestions, please open an issue on the repository.

---

**Made with ❤️ for seamless movie watching with friends.**
