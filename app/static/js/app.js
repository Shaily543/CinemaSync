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
    shouldInitiate: false,
    iceCandidateBuffer: [],
    remoteDescriptionSet: false,
};

// DOM References
const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
const screenShareVideo = document.getElementById('screenShareVideo');
const screenSharePlaceholder = document.getElementById('screenSharePlaceholder');
const screenShareStatus = document.getElementById('screenShareStatus');
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
const menuBtns = document.querySelectorAll('.menu-btn');

// WebRTC Configuration — Metered.ca TURN servers
const RTCConfig = {
    iceServers: [
        { urls: 'stun:stun.relay.metered.ca:80' },
        { urls: 'turn:global.relay.metered.ca:80', username: 'd5f9f06374ccf9b5ccbdb2e3', credential: 'cFWWPyg281+1HfGS' },
        { urls: 'turn:global.relay.metered.ca:80?transport=tcp', username: 'd5f9f06374ccf9b5ccbdb2e3', credential: 'cFWWPyg281+1HfGS' },
        { urls: 'turn:global.relay.metered.ca:443', username: 'd5f9f06374ccf9b5ccbdb2e3', credential: 'cFWWPyg281+1HfGS' },
        { urls: 'turns:global.relay.metered.ca:443?transport=tcp', username: 'd5f9f06374ccf9b5ccbdb2e3', credential: 'cFWWPyg281+1HfGS' },
    ]
};

// ============ Debug Status ============

function logStatus(msg) {
    console.log('[CinemaSync]', msg);
    if (!chatMessages) return;
    const el = document.createElement('div');
    el.className = 'chat-message system-msg';
    el.innerHTML = `<div class="message-content">
        <div class="message-author">⚙ SYSTEM</div>
        <div class="message-text">${msg}</div>
    </div>`;
    chatMessages.appendChild(el);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ============ ICE Candidate Buffering ============

async function addBufferedCandidates() {
    if (state.iceCandidateBuffer.length > 0 && state.peerConnection) {
        logStatus('🧊 Flushing ' + state.iceCandidateBuffer.length + ' buffered ICE candidates');
        for (const candidate of state.iceCandidateBuffer) {
            try {
                await state.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (e) {
                console.warn('Buffered ICE candidate error:', e.message);
            }
        }
        state.iceCandidateBuffer = [];
    }
}

// ============ Socket.IO Events ============

socket.on('connect', () => {
    logStatus('🟢 Connected to server');
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
    state.shouldInitiate = false;
    showRoomInfo();
    showNotification('Room created: ' + data.room_id, 'success');
    logStatus('🏠 Room created: ' + data.room_id + ' (you are the host)');
});

socket.on('room_joined', (data) => {
    state.roomId = data.room_id;
    showRoomInfo();
    showNotification('Joined room successfully', 'success');
    logStatus('🚪 Joined room ' + data.room_id + ' (' + data.users.length + ' users)');
    if (data.users.length >= 2) {
        state.shouldInitiate = true;
        logStatus('📋 You will initiate the call after clicking Start Watching');
    }
});

socket.on('user_joined', (data) => {
    showNotification('Friend joined the room!', 'success');
    logStatus('👋 Friend joined! Waiting for their offer...');
});

socket.on('user_disconnected', (data) => {
    showNotification('Friend disconnected', 'error');
    logStatus('🔴 Friend disconnected');
    cleanupPeerConnection();
    hideScreenShare();
});

// ─── WebRTC Signaling ───

socket.on('webrtc_offer', async (data) => {
    logStatus('📥 Received WebRTC offer');
    try {
        state.iceCandidateBuffer = [];
        state.remoteDescriptionSet = false;

        if (!state.localStream) {
            logStatus('⏳ Starting camera to answer...');
            await startCamera();
        }

        createPeerConnection();
        await state.peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));
        state.remoteDescriptionSet = true;
        logStatus('✅ Remote offer set');
        await addBufferedCandidates();

        const answer = await state.peerConnection.createAnswer();
        await state.peerConnection.setLocalDescription(answer);
        socket.emit('webrtc_answer', { answer: answer, from: state.userId });
        logStatus('📤 Answer sent!');
    } catch (err) {
        logStatus('❌ Error handling offer: ' + err.message);
        console.error('Offer error:', err);
    }
});

socket.on('webrtc_answer', async (data) => {
    logStatus('📥 Received WebRTC answer');
    try {
        if (!state.peerConnection) {
            logStatus('⚠ No peer connection — ignoring answer');
            return;
        }
        const sigState = state.peerConnection.signalingState;
        if (sigState !== 'have-local-offer') {
            logStatus('⚠ Wrong signaling state: ' + sigState);
            return;
        }
        await state.peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
        state.remoteDescriptionSet = true;
        logStatus('✅ Remote answer set — ICE connecting...');
        await addBufferedCandidates();
    } catch (err) {
        logStatus('❌ Error setting answer: ' + err.message);
        console.error('Answer error:', err);
    }
});

socket.on('webrtc_ice_candidate', async (data) => {
    if (!data.candidate) return;
    if (!state.remoteDescriptionSet || !state.peerConnection) {
        state.iceCandidateBuffer.push(data.candidate);
        logStatus('🧊 Buffered ICE candidate (waiting for remote desc)');
        return;
    }
    try {
        await state.peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
        logStatus('🧊 Added ICE candidate from peer');
    } catch (err) {
        logStatus('⚠ ICE candidate error: ' + err.message);
    }
});

// ─── Screen share notifications via Socket.IO ───

socket.on('screen_share_started', (data) => {
    logStatus('🖥️ Friend started screen sharing!');
    showNotification('Friend is sharing their screen', 'success');
    showScreenShareFromRemote();
});

socket.on('screen_share_stopped', (data) => {
    logStatus('🖥️ Friend stopped screen sharing');
    showNotification('Friend stopped sharing', 'success');
    hideScreenShare();
});

socket.on('chat_message', (data) => {
    displayChatMessage(data.message, data.user_id, data.timestamp);
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
        state.isVideoReady = true;
        return false;
    }
}

function createPeerConnection() {
    if (state.peerConnection) {
        try { state.peerConnection.close(); } catch (e) { /* ok */ }
    }

    state.peerConnection = new RTCPeerConnection(RTCConfig);
    logStatus('🔧 PeerConnection created with ' + RTCConfig.iceServers.length + ' ICE servers');

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
        if (event.streams && event.streams[0]) {
            if (remoteVideo.srcObject !== event.streams[0]) {
                remoteVideo.srcObject = event.streams[0];
                state.remoteStream = event.streams[0];
                logStatus('📺 Remote stream attached');
                remoteVideo.onloadedmetadata = () => {
                    remoteVideo.play()
                        .then(() => logStatus('▶ Remote video playing!'))
                        .catch(err => {
                            remoteVideo.muted = true;
                            remoteVideo.play()
                                .then(() => setTimeout(() => { remoteVideo.muted = false; }, 1000))
                                .catch(e => logStatus('❌ Cannot play: ' + e.message));
                        });
                };
            }
        }
    };

    // ICE candidates
    state.peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('webrtc_ice_candidate', {
                candidate: event.candidate,
                from: state.userId
            });
        }
    };

    state.peerConnection.onicegatheringstatechange = () => {
        logStatus('🧊 ICE gathering: ' + state.peerConnection.iceGatheringState);
    };

    state.peerConnection.oniceconnectionstatechange = () => {
        const s = state.peerConnection.iceConnectionState;
        logStatus('🧊 ICE connection: ' + s);
        if (s === 'connected' || s === 'completed') {
            showNotification('🎉 Video call connected!', 'success');
        } else if (s === 'failed') {
            logStatus('❌ ICE FAILED — try refreshing both browsers');
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
    channel.binaryType = 'arraybuffer';
    channel.onopen = () => logStatus('📦 Data channel open');
    channel.onclose = () => logStatus('📦 Data channel closed');
    channel.onmessage = (e) => console.log('DC message:', e.data);
}

async function initiateWebRTC() {
    try {
        state.remoteDescriptionSet = false;
        state.iceCandidateBuffer = [];
        createPeerConnection();
        const offer = await state.peerConnection.createOffer();
        await state.peerConnection.setLocalDescription(offer);
        logStatus('📤 Offer sent to room!');
        socket.emit('webrtc_offer', { offer: offer, from: state.userId });
    } catch (err) {
        logStatus('❌ Error creating offer: ' + err.message);
        console.error('Offer error:', err);
    }
}

async function initializeVideo() {
    logStatus('📹 Starting camera...');
    await startCamera();

    if (state.shouldInitiate && state.roomId) {
        logStatus('🚀 I am the joiner — creating WebRTC offer in 2s...');
        setTimeout(() => initiateWebRTC(), 2000);
    } else if (state.roomId) {
        logStatus('⏳ I am the host — waiting for joiner...');
    }
}

// ============ Screen Sharing ============

async function startScreenShare() {
    try {
        if (!state.peerConnection) {
            showNotification('Start a call first!', 'error');
            return;
        }

        const screenStream = await navigator.mediaDevices.getDisplayMedia({
            video: { cursor: 'always' },
            audio: false
        });

        const screenTrack = screenStream.getVideoTracks()[0];

        // Replace video track in the peer connection
        const sender = state.peerConnection.getSenders().find(s => s.track && s.track.kind === 'video');
        if (sender) {
            await sender.replaceTrack(screenTrack);
        }

        // Show screen share in the center panel (your own view)
        screenShareVideo.srcObject = screenStream;
        screenShareVideo.classList.add('active');
        screenSharePlaceholder.classList.add('hidden');
        screenShareStatus.textContent = '🖥️ You are sharing your screen';
        screenShareVideo.play().catch(() => { });

        state.isScreenSharing = true;
        updateControlButtonStates();

        // Notify peer
        socket.emit('screen_share_started', { from: state.userId });
        logStatus('🖥️ Screen sharing started');
        showNotification('Screen sharing started', 'success');

        // Handle when user stops sharing via browser UI
        screenTrack.onended = () => {
            stopScreenShare();
        };
    } catch (err) {
        if (err.name !== 'NotAllowedError') {
            showNotification('Screen share failed: ' + err.message, 'error');
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
            }
        }

        state.isScreenSharing = false;
        updateControlButtonStates();

        // Hide screen share display
        hideScreenShare();

        // Notify peer
        socket.emit('screen_share_stopped', { from: state.userId });
        logStatus('🖥️ Screen sharing stopped');
        showNotification('Screen sharing stopped', 'success');
    } catch (err) {
        console.error('Stop screenshare:', err);
    }
}

function showScreenShareFromRemote() {
    // When the remote peer shares their screen, their video track changes
    // Show the remote video also in the center screen share display (larger view)
    if (state.remoteStream) {
        screenShareVideo.srcObject = state.remoteStream;
        screenShareVideo.classList.add('active');
        screenSharePlaceholder.classList.add('hidden');
        screenShareStatus.textContent = '🖥️ Friend is sharing their screen';
        screenShareVideo.play().catch(() => { });
    }
}

function hideScreenShare() {
    screenShareVideo.classList.remove('active');
    screenShareVideo.srcObject = null;
    screenSharePlaceholder.classList.remove('hidden');
    screenShareStatus.textContent = 'No one is sharing';
}

// ============ Connection Cleanup ============

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
    state.remoteDescriptionSet = false;
    state.iceCandidateBuffer = [];
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
    hideScreenShare();
    showNotification('Call ended', 'success');
}

// ============ Button Listeners ============

createRoomBtn.addEventListener('click', () => socket.emit('create_room', {}));

toggleJoinForm.addEventListener('click', () => {
    document.getElementById('joinForm').classList.toggle('hidden');
});

joinRoomBtn.addEventListener('click', () => {
    const roomId = roomIdInput.value.trim();
    if (roomId) socket.emit('join_room', { room_id: roomId });
    else showNotification('Please enter a room ID', 'error');
});

copyBtn.addEventListener('click', () => {
    const roomId = document.getElementById('displayRoomId').textContent;
    navigator.clipboard.writeText(roomId).then(() => showNotification('Room ID copied!', 'success'));
});

startWatchingBtn.addEventListener('click', () => {
    switchSection('watch');
    initializeVideo();
});

toggleAudio.addEventListener('click', () => {
    state.audioEnabled = !state.audioEnabled;
    if (state.localStream) state.localStream.getAudioTracks().forEach(t => t.enabled = state.audioEnabled);
    updateControlButtonStates();
});

toggleVideo.addEventListener('click', () => {
    state.videoEnabled = !state.videoEnabled;
    if (state.localStream) state.localStream.getVideoTracks().forEach(t => t.enabled = state.videoEnabled);
    updateControlButtonStates();
});

toggleScreenShare.addEventListener('click', () => {
    state.isScreenSharing ? stopScreenShare() : startScreenShare();
});

exitBtn.addEventListener('click', () => { closeConnection(); switchSection('home'); });

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

// ============ UI ============

function showRoomInfo() {
    document.getElementById('displayRoomId').textContent = state.roomId;
    document.getElementById('roomInfo').classList.remove('hidden');
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
    console.log('CinemaSync initialized');
    switchSection('home');
});
