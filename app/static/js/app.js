// Socket.IO connection
const socket = io({ transports: ['websocket', 'polling'] });

// Global state
const state = {
    userId: null,
    roomId: null,
    peerConnection: null,
    localStream: null,
    dataChannel: null,
    remoteStream: null,
    audioEnabled: true,
    videoEnabled: true,
    isScreenSharing: false,
    isVideoReady: false,
    shouldInitiate: false,     // true = I should create the offer (I'm the joiner)
};

// DOM References
const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
const moviePlayer = document.getElementById('moviePlayer');
const movieTitle = document.getElementById('movieTitle');
const chatMessages = document.getElementById('chatMessages');
const chatInput = document.getElementById('chatInput');
const sendChatBtn = document.getElementById('sendChatBtn');
const notification = document.getElementById('notification');

// Buttons
const createRoomBtn = document.getElementById('createRoomBtn');
const toggleJoinForm = document.getElementById('toggleJoinForm');
const joinRoomBtn = document.getElementById('joinRoomBtn');
const roomIdInput = document.getElementById('roomIdInput');
const copyBtn = document.getElementById('copyBtn');
const startWatchingBtn = document.getElementById('startWatchingBtn');
const toggleAudio = document.getElementById('toggleAudio');
const toggleVideo = document.getElementById('toggleVideo');
const toggleScreenShare = document.getElementById('toggleScreenShare');
const exitBtn = document.getElementById('exitBtn');
const uploadMovieBtn = document.getElementById('uploadMovieBtn');
const movieInput = document.getElementById('movieInput');

// Menu buttons
const menuBtns = document.querySelectorAll('.menu-btn');

// WebRTC Configuration — fetched dynamically from Metered.ca
let RTCConfig = {
    iceServers: [
        { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    ]
};

async function fetchTurnConfig() {
    try {
        const resp = await fetch(
            'https://sharemov.metered.live/api/v1/turn/credentials?apiKey=4044f18d121a9c5c6fa9994ed405c05d1874'
        );
        const iceServers = await resp.json();
        // Add STUN as first choice (fastest), TURN servers as fallback
        iceServers.unshift({ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] });
        RTCConfig = { iceServers: iceServers };
        logStatus('🔑 Got ' + iceServers.length + ' ICE servers (STUN + TURN)');
    } catch (err) {
        logStatus('⚠ Could not fetch TURN config: ' + err.message);
    }
}

// ============ Debugging — visible in chat panel ============

function logStatus(msg) {
    console.log('[ShareMOV]', msg);
    if (!chatMessages) return;
    const el = document.createElement('div');
    el.className = 'chat-message';
    el.innerHTML = `<div class="message-content" style="background:rgba(99,102,241,0.12);border-color:#6366f1;font-size:11px;">
        <div class="message-author" style="color:#818cf8;">⚙ SYSTEM</div>
        <div class="message-text" style="color:#cbd5e1;">${msg}</div>
    </div>`;
    chatMessages.appendChild(el);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ============ Socket.IO Events ============

socket.on('connect', () => {
    logStatus('🟢 Connected to server (transport: ' + socket.io.engine.transport.name + ')');
    // Log when transport upgrades
    socket.io.engine.on('upgrade', (transport) => {
        logStatus('🔄 Transport upgraded to: ' + transport.name);
    });
});

socket.on('disconnect', (reason) => {
    logStatus('🔴 Disconnected: ' + reason);
});

socket.on('user_id', (data) => {
    state.userId = data.user_id;
    logStatus('Your ID: ' + state.userId);
});

socket.on('room_created', (data) => {
    state.roomId = data.room_id;
    state.shouldInitiate = false;  // Creator waits for offers
    showRoomInfo();
    showNotification('Room created: ' + data.room_id, 'success');
    logStatus('🏠 Room created: ' + data.room_id + ' (you are the host)');
});

socket.on('room_joined', (data) => {
    state.roomId = data.room_id;
    showRoomInfo();
    showNotification('Joined room successfully', 'success');
    logStatus('🚪 Joined room ' + data.room_id + ' (' + data.users.length + ' users)');

    // I'm the JOINER — I should create the offer when my camera is ready
    if (data.users.length >= 2) {
        state.shouldInitiate = true;
        logStatus('📋 You will initiate the call when camera starts');
    }
});

socket.on('user_joined', (data) => {
    showNotification('Friend joined the room!', 'success');
    logStatus('👋 Friend joined! (' + data.users.length + ' in room) — waiting for their offer...');
    // Host does NOT initiate — waits for joiner's offer
});

socket.on('user_disconnected', (data) => {
    showNotification('Friend disconnected', 'error');
    logStatus('🔴 Friend disconnected');
    cleanupPeerConnection();
});

// ─── WebRTC Signaling ───

socket.on('webrtc_offer', async (data) => {
    logStatus('📥 Received offer from: ' + data.from);
    try {
        // If camera not ready, start it now
        if (!state.localStream) {
            logStatus('⏳ Starting camera to answer...');
            await startCamera();
        }

        createPeerConnection();
        await state.peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));
        logStatus('✅ Remote offer set');

        const answer = await state.peerConnection.createAnswer();
        await state.peerConnection.setLocalDescription(answer);
        logStatus('📤 Sending answer...');

        socket.emit('webrtc_answer', { answer: answer, from: state.userId });
    } catch (err) {
        logStatus('❌ Error answering offer: ' + err.message);
        console.error('Offer error:', err);
    }
});

socket.on('webrtc_answer', async (data) => {
    logStatus('📥 Received answer from: ' + data.from);
    try {
        if (!state.peerConnection) {
            logStatus('⚠ No peer connection for answer');
            return;
        }
        if (state.peerConnection.signalingState !== 'have-local-offer') {
            logStatus('⚠ Wrong state for answer: ' + state.peerConnection.signalingState);
            return;
        }
        await state.peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
        logStatus('✅ Remote answer set — ICE connecting...');
    } catch (err) {
        logStatus('❌ Error setting answer: ' + err.message);
        console.error('Answer error:', err);
    }
});

socket.on('webrtc_ice_candidate', async (data) => {
    try {
        if (state.peerConnection && data.candidate) {
            await state.peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
            logStatus('🧊 Received ICE candidate from peer');
        }
    } catch (err) {
        console.warn('ICE candidate error (usually OK):', err.message);
    }
});

socket.on('chat_message', (data) => {
    displayChatMessage(data.message, data.user_id, data.timestamp);
});

socket.on('movie_control', (data) => {
    handleRemoteMovieControl(data);
});

socket.on('error', (data) => {
    showNotification(data.message, 'error');
    logStatus('❌ Error: ' + data.message);
});

// ============ WebRTC Core ============

async function startCamera() {
    try {
        state.localStream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: { width: { ideal: 1280 }, height: { ideal: 720 } }
        });
        localVideo.srcObject = state.localStream;
        state.isVideoReady = true;
        logStatus('✅ Camera & microphone started');
        return true;
    } catch (err) {
        logStatus('❌ Camera failed: ' + err.message);
        showNotification('Camera error: ' + err.message, 'error');
        state.isVideoReady = true;  // still mark ready so we can receive video
        return false;
    }
}

function createPeerConnection() {
    if (state.peerConnection) {
        try { state.peerConnection.close(); } catch (e) { /* ok */ }
    }

    state.peerConnection = new RTCPeerConnection(RTCConfig);
    logStatus('🔧 PeerConnection created');

    // Add local tracks
    if (state.localStream) {
        const tracks = state.localStream.getTracks();
        tracks.forEach(track => {
            state.peerConnection.addTrack(track, state.localStream);
        });
        logStatus('📡 Added ' + tracks.length + ' local tracks');
    }

    // Receive remote tracks
    state.peerConnection.ontrack = (event) => {
        logStatus('📺 Received remote ' + event.track.kind + ' track!');

        const stream = (event.streams && event.streams[0]) ? event.streams[0] : null;

        if (stream) {
            if (remoteVideo.srcObject !== stream) {
                remoteVideo.srcObject = stream;
                state.remoteStream = stream;
                logStatus('📺 Remote stream attached');

                // Play when browser has loaded the stream metadata
                remoteVideo.onloadedmetadata = () => {
                    logStatus('📺 Stream metadata loaded — starting playback');
                    remoteVideo.play()
                        .then(() => logStatus('▶ Remote video IS PLAYING!'))
                        .catch(err => {
                            logStatus('⚠ Autoplay blocked — trying muted...');
                            remoteVideo.muted = true;
                            remoteVideo.play()
                                .then(() => {
                                    logStatus('▶ Playing muted — click video to unmute');
                                    // Unmute after a short delay (user already interacted)
                                    setTimeout(() => { remoteVideo.muted = false; }, 1000);
                                })
                                .catch(err2 => logStatus('❌ Cannot play: ' + err2.message));
                        });
                };
            }
        } else {
            // Fallback: manually build stream
            if (!state.remoteStream) {
                state.remoteStream = new MediaStream();
                remoteVideo.srcObject = state.remoteStream;
            }
            state.remoteStream.addTrack(event.track);
            logStatus('📺 Track added (fallback)');
        }
    };

    // ICE candidates → send to peer via signaling server
    state.peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('webrtc_ice_candidate', {
                candidate: event.candidate,
                from: state.userId
            });
        }
    };

    // ICE connection state tracking
    state.peerConnection.oniceconnectionstatechange = () => {
        const s = state.peerConnection.iceConnectionState;
        logStatus('🧊 ICE: ' + s);
        if (s === 'connected' || s === 'completed') {
            showNotification('🎉 Video call connected!', 'success');
        } else if (s === 'failed') {
            logStatus('❌ ICE FAILED — TURN server may be needed or broken');
            showNotification('Connection failed', 'error');
        }
    };

    state.peerConnection.onconnectionstatechange = () => {
        logStatus('🔗 Connection: ' + state.peerConnection.connectionState);
    };

    // Data channel
    state.dataChannel = state.peerConnection.createDataChannel('app', { ordered: true });
    setupDataChannel(state.dataChannel);
    state.peerConnection.ondatachannel = (e) => setupDataChannel(e.channel);
}

function setupDataChannel(channel) {
    channel.onopen = () => logStatus('📦 Data channel open');
    channel.onclose = () => logStatus('📦 Data channel closed');
    channel.onmessage = (e) => console.log('DC message:', e.data);
}

async function initiateWebRTC() {
    try {
        createPeerConnection();

        const offer = await state.peerConnection.createOffer();
        await state.peerConnection.setLocalDescription(offer);
        logStatus('📤 Sending offer to room...');

        socket.emit('webrtc_offer', {
            offer: offer,
            from: state.userId
        });
    } catch (err) {
        logStatus('❌ Error creating offer: ' + err.message);
        console.error('Offer error:', err);
        showNotification('Failed to start call', 'error');
    }
}

async function initializeVideo() {
    logStatus('📹 Fetching TURN server config...');
    await fetchTurnConfig();
    logStatus('📹 Starting camera...');
    await startCamera();

    if (state.shouldInitiate && state.roomId) {
        // I'm the joiner — I create the offer
        logStatus('🚀 I am the joiner — creating WebRTC offer in 1s...');
        setTimeout(() => {
            initiateWebRTC();
        }, 1000);
    } else if (state.roomId) {
        logStatus('⏳ I am the host — waiting for joiner to send offer...');
    }
}

async function startScreenShare() {
    try {
        if (!state.peerConnection) {
            showNotification('No active call — connect first!', 'error');
            return;
        }
        const screenStream = await navigator.mediaDevices.getDisplayMedia({
            video: { cursor: 'always' },
            audio: false
        });
        const screenTrack = screenStream.getVideoTracks()[0];
        const sender = state.peerConnection.getSenders().find(s => s.track && s.track.kind === 'video');
        if (sender) {
            await sender.replaceTrack(screenTrack);
            state.isScreenSharing = true;
            localVideo.srcObject = screenStream;
            screenTrack.onended = () => stopScreenShare();
            showNotification('Screen sharing started', 'success');
            logStatus('🖥️ Screen sharing ON');
            updateControlButtonStates();
        }
    } catch (err) {
        if (err.name !== 'NotAllowedError') {
            showNotification('Screen share failed', 'error');
        }
    }
}

async function stopScreenShare() {
    try {
        if (state.localStream && state.peerConnection) {
            const videoTrack = state.localStream.getVideoTracks()[0];
            const sender = state.peerConnection.getSenders().find(s => s.track && s.track.kind === 'video');
            if (sender && videoTrack) {
                await sender.replaceTrack(videoTrack);
                localVideo.srcObject = state.localStream;
                state.isScreenSharing = false;
                showNotification('Screen sharing stopped', 'success');
                logStatus('🖥️ Screen sharing OFF');
                updateControlButtonStates();
            }
        }
    } catch (err) {
        console.error('Stop screenshare error:', err);
    }
}

function cleanupPeerConnection() {
    if (state.peerConnection) {
        try { state.peerConnection.close(); } catch (e) { /* ok */ }
        state.peerConnection = null;
    }
    if (state.remoteStream) {
        state.remoteStream.getTracks().forEach(t => t.stop());
        state.remoteStream = null;
    }
    remoteVideo.srcObject = null;
}

function closeConnection() {
    if (state.localStream) {
        state.localStream.getTracks().forEach(t => t.stop());
        state.localStream = null;
    }
    cleanupPeerConnection();
    localVideo.srcObject = null;
    state.isScreenSharing = false;
    state.isVideoReady = false;
    state.shouldInitiate = false;
    showNotification('Call ended', 'success');
}

// ============ Button Listeners ============

createRoomBtn.addEventListener('click', () => socket.emit('create_room', {}));

toggleJoinForm.addEventListener('click', () => {
    document.getElementById('joinForm').classList.toggle('hidden');
});

joinRoomBtn.addEventListener('click', () => {
    const roomId = roomIdInput.value.trim();
    if (roomId) {
        socket.emit('join_room', { room_id: roomId });
    } else {
        showNotification('Please enter a room ID', 'error');
    }
});

copyBtn.addEventListener('click', () => {
    const roomId = document.getElementById('displayRoomId').textContent;
    navigator.clipboard.writeText(roomId).then(() => {
        showNotification('Room ID copied!', 'success');
    });
});

startWatchingBtn.addEventListener('click', () => {
    switchSection('watch');
    initializeVideo();
});

toggleAudio.addEventListener('click', () => {
    state.audioEnabled = !state.audioEnabled;
    if (state.localStream) {
        state.localStream.getAudioTracks().forEach(t => t.enabled = state.audioEnabled);
    }
    updateControlButtonStates();
});

toggleVideo.addEventListener('click', () => {
    state.videoEnabled = !state.videoEnabled;
    if (state.localStream) {
        state.localStream.getVideoTracks().forEach(t => t.enabled = state.videoEnabled);
    }
    updateControlButtonStates();
});

toggleScreenShare.addEventListener('click', () => {
    state.isScreenSharing ? stopScreenShare() : startScreenShare();
});

exitBtn.addEventListener('click', () => {
    closeConnection();
    switchSection('home');
});

uploadMovieBtn.addEventListener('click', () => movieInput.click());

movieInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
        loadMovie(URL.createObjectURL(file), file.name);
    }
});

sendChatBtn.addEventListener('click', sendChatMessage);
chatInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') sendChatMessage(); });

menuBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        menuBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        switchSection(btn.dataset.section);
    });
});

// ============ Chat ============

function sendChatMessage() {
    const message = chatInput.value.trim();
    if (!message || !state.roomId) return;
    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    socket.emit('chat_message', { message, timestamp });
    displayChatMessage(message, 'You', timestamp, true);
    chatInput.value = '';
}

function displayChatMessage(message, userId, timestamp, isOwn = false) {
    const el = document.createElement('div');
    el.className = 'chat-message ' + (isOwn ? 'own' : '');
    const label = isOwn ? 'You' : (userId === state.userId ? 'You' : 'Friend');
    el.innerHTML = `<div class="message-content">
        <div class="message-author">${label}</div>
        <div class="message-text">${escapeHtml(message)}</div>
        <div class="message-time">${timestamp}</div>
    </div>`;
    chatMessages.appendChild(el);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ============ Movie Player ============

let isSyncingMovie = false;
let movieSyncSetup = false;

function loadMovie(url, name) {
    moviePlayer.src = url;
    movieTitle.textContent = 'Now Playing: ' + name;
    socket.emit('movie_control', { action: 'load', value: { name } });
    showNotification('Loaded: ' + name, 'success');
    logStatus('🎬 Movie loaded: ' + name);
    logStatus('💡 TIP: Use Screen Share to let your friend see the movie!');
    if (!movieSyncSetup) { setupMovieSyncEvents(); movieSyncSetup = true; }
}

function setupMovieSyncEvents() {
    moviePlayer.addEventListener('play', () => {
        if (!isSyncingMovie) socket.emit('movie_control', { action: 'play', value: moviePlayer.currentTime });
    });
    moviePlayer.addEventListener('pause', () => {
        if (!isSyncingMovie) socket.emit('movie_control', { action: 'pause', value: moviePlayer.currentTime });
    });
    moviePlayer.addEventListener('seeked', () => {
        if (!isSyncingMovie) socket.emit('movie_control', { action: 'seek', value: moviePlayer.currentTime });
    });
}

function handleRemoteMovieControl(data) {
    isSyncingMovie = true;
    if (data.action === 'load') {
        movieTitle.textContent = 'Friend is watching: ' + data.value.name;
        showNotification('Friend loaded: ' + data.value.name + ' — Load same file OR ask them to Screen Share!', 'success');
        logStatus('🎬 Friend loaded: ' + data.value.name);
    } else if (data.action === 'play') {
        moviePlayer.currentTime = data.value;
        moviePlayer.play();
    } else if (data.action === 'pause') {
        moviePlayer.currentTime = data.value;
        moviePlayer.pause();
    } else if (data.action === 'seek') {
        moviePlayer.currentTime = data.value;
    }
    setTimeout(() => { isSyncingMovie = false; }, 500);
}

// ============ UI ============

function showRoomInfo() {
    const roomInfo = document.getElementById('roomInfo');
    document.getElementById('displayRoomId').textContent = state.roomId;
    roomInfo.classList.remove('hidden');
}

function switchSection(name) {
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    document.getElementById(name).classList.add('active');
    menuBtns.forEach(b => b.classList.toggle('active', b.dataset.section === name));
}

function showNotification(message, type = 'info') {
    notification.textContent = message;
    notification.className = 'notification show ' + type;
    setTimeout(() => notification.classList.remove('show'), 3000);
}

function updateControlButtonStates() {
    toggleAudio.classList.toggle('active', state.audioEnabled);
    toggleVideo.classList.toggle('active', state.videoEnabled);
    toggleScreenShare.classList.toggle('active', state.isScreenSharing);
}

function escapeHtml(text) {
    const d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
}

document.addEventListener('DOMContentLoaded', () => {
    console.log('ShareMOV initialized');
    switchSection('home');
});
