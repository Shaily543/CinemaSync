// Socket.IO connection
const socket = io();

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

// WebRTC Configuration
const RTCConfig = {
    iceServers: [
        { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }
    ]
};

// ============ Socket.IO Events ============

socket.on('connect', () => {
    console.log('Connected to server');
});

socket.on('user_id', (data) => {
    state.userId = data.user_id;
    console.log('Your ID:', state.userId);
});

socket.on('room_created', (data) => {
    state.roomId = data.room_id;
    showRoomInfo();
    showNotification(`Room created: ${data.room_id}`, 'success');
});

socket.on('room_joined', (data) => {
    state.roomId = data.room_id;
    showNotification('Joined room successfully', 'success');
    // Start WebRTC connection when someone joins
    if (data.users.length === 2) {
        setTimeout(() => {
            initiateWebRTC();
        }, 500);
    }
});

socket.on('user_joined', (data) => {
    showNotification(`Friend joined the room!`, 'success');
    console.log('User joined:', data.user_id);
    // Initiate WebRTC call
    setTimeout(() => {
        initiateWebRTC();
    }, 500);
});

socket.on('user_disconnected', (data) => {
    showNotification('Friend disconnected', 'error');
    closeConnection();
});

socket.on('webrtc_offer', async (data) => {
    try {
        if (!state.peerConnection) {
            createPeerConnection();
        }
        await state.peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));
        const answer = await state.peerConnection.createAnswer();
        await state.peerConnection.setLocalDescription(answer);
        socket.emit('webrtc_answer', { answer: answer, to: data.from });
    } catch (error) {
        console.error('Error handling offer:', error);
    }
});

socket.on('webrtc_answer', async (data) => {
    try {
        if (state.peerConnection) {
            await state.peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
        }
    } catch (error) {
        console.error('Error handling answer:', error);
    }
});

socket.on('webrtc_ice_candidate', async (data) => {
    try {
        if (state.peerConnection && data.candidate) {
            await state.peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
        }
    } catch (error) {
        console.error('Error adding ICE candidate:', error);
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
});

// ============ Button Event Listeners ============

createRoomBtn.addEventListener('click', () => {
    socket.emit('create_room', {});
});

toggleJoinForm.addEventListener('click', () => {
    const form = document.getElementById('joinForm');
    form.classList.toggle('hidden');
});

joinRoomBtn.addEventListener('click', () => {
    const roomId = roomIdInput.value.trim();
    if (roomId) {
        socket.emit('join_room', { room_id: roomId });
        showRoomInfo();
    } else {
        showNotification('Please enter a room ID', 'error');
    }
});

copyBtn.addEventListener('click', () => {
    const roomId = document.getElementById('displayRoomId').textContent;
    navigator.clipboard.writeText(roomId).then(() => {
        showNotification('Room ID copied to clipboard!', 'success');
    });
});

startWatchingBtn.addEventListener('click', () => {
    switchSection('watch');
    initializeVideo();
});

toggleAudio.addEventListener('click', () => {
    state.audioEnabled = !state.audioEnabled;
    if (state.localStream) {
        state.localStream.getAudioTracks().forEach(track => {
            track.enabled = state.audioEnabled;
        });
    }
    updateControlButtonStates();
});

toggleVideo.addEventListener('click', () => {
    state.videoEnabled = !state.videoEnabled;
    if (state.localStream) {
        state.localStream.getVideoTracks().forEach(track => {
            track.enabled = state.videoEnabled;
        });
    }
    updateControlButtonStates();
});

toggleScreenShare.addEventListener('click', () => {
    if (state.isScreenSharing) {
        stopScreenShare();
    } else {
        startScreenShare();
    }
});

exitBtn.addEventListener('click', () => {
    closeConnection();
    switchSection('home');
});

uploadMovieBtn.addEventListener('click', () => {
    movieInput.click();
});

movieInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
        const url = URL.createObjectURL(file);
        loadMovie(url, file.name);
    }
});

sendChatBtn.addEventListener('click', sendChatMessage);

chatInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        sendChatMessage();
    }
});

// Menu navigation
menuBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        const section = btn.dataset.section;
        menuBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        switchSection(section);
    });
});

// ============ WebRTC Functions ============

function createPeerConnection() {
    state.peerConnection = new RTCPeerConnection(RTCConfig);

    // Add local stream tracks to peer connection
    if (state.localStream) {
        state.localStream.getTracks().forEach(track => {
            state.peerConnection.addTrack(track, state.localStream);
        });
    }

    // Handle remote stream
    state.peerConnection.ontrack = (event) => {
        console.log('Received remote track:', event.track.kind);
        if (!state.remoteStream) {
            state.remoteStream = new MediaStream();
            remoteVideo.srcObject = state.remoteStream;
        }
        state.remoteStream.addTrack(event.track);
    };

    // Handle ICE candidates
    state.peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('webrtc_ice_candidate', {
                candidate: event.candidate,
                from: state.userId
            });
        }
    };

    // Connection state changes
    state.peerConnection.onconnectionstatechange = () => {
        console.log('Connection state:', state.peerConnection.connectionState);
        if (state.peerConnection.connectionState === 'disconnected' ||
            state.peerConnection.connectionState === 'failed' ||
            state.peerConnection.connectionState === 'closed') {
            closeConnection();
        }
    };

    // Create data channel for additional purposes
    state.dataChannel = state.peerConnection.createDataChannel('app', { ordered: true });
    setupDataChannel(state.dataChannel);

    // Handle incoming data channels
    state.peerConnection.ondatachannel = (event) => {
        setupDataChannel(event.channel);
    };
}

function setupDataChannel(channel) {
    channel.onopen = () => {
        console.log('Data channel opened');
    };

    channel.onclose = () => {
        console.log('Data channel closed');
    };

    channel.onmessage = (event) => {
        console.log('Data channel message:', event.data);
    };
}

async function initiateWebRTC() {
    try {
        if (!state.peerConnection) {
            createPeerConnection();
        }

        const offer = await state.peerConnection.createOffer();
        await state.peerConnection.setLocalDescription(offer);
        socket.emit('webrtc_offer', {
            offer: offer,
            from: state.userId
        });
    } catch (error) {
        console.error('Error initiating WebRTC:', error);
        showNotification('Failed to initiate video call', 'error');
    }
}

async function initializeVideo() {
    try {
        state.localStream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: {
                width: { ideal: 1280 },
                height: { ideal: 720 }
            }
        });

        localVideo.srcObject = state.localStream;
        showNotification('Camera and microphone accessed', 'success');

        // If already in a room, start WebRTC
        if (state.roomId) {
            setTimeout(() => {
                initiateWebRTC();
            }, 500);
        }
    } catch (error) {
        console.error('Error accessing media devices:', error);
        showNotification('Unable to access camera/microphone', 'error');
    }
}

async function startScreenShare() {
    try {
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

            screenTrack.onended = () => {
                stopScreenShare();
            };

            showNotification('Screen sharing started', 'success');
            updateControlButtonStates();
        }
    } catch (error) {
        console.error('Error starting screen share:', error);
        if (error.name !== 'NotAllowedError') {
            showNotification('Failed to start screen share', 'error');
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
                updateControlButtonStates();
            }
        }
    } catch (error) {
        console.error('Error stopping screen share:', error);
    }
}

function closeConnection() {
    if (state.localStream) {
        state.localStream.getTracks().forEach(track => track.stop());
        state.localStream = null;
    }

    if (state.peerConnection) {
        state.peerConnection.close();
        state.peerConnection = null;
    }

    if (state.remoteStream) {
        state.remoteStream.getTracks().forEach(track => track.stop());
        state.remoteStream = null;
    }

    localVideo.srcObject = null;
    remoteVideo.srcObject = null;
    state.isScreenSharing = false;
    showNotification('Call ended', 'success');
}

// ============ Chat Functions ============

function sendChatMessage() {
    const message = chatInput.value.trim();
    if (!message || !state.roomId) return;

    const timestamp = new Date().toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit'
    });

    socket.emit('chat_message', {
        message: message,
        timestamp: timestamp
    });

    displayChatMessage(message, 'You', timestamp, true);
    chatInput.value = '';
}

function displayChatMessage(message, userId, timestamp, isOwn = false) {
    const messageEl = document.createElement('div');
    messageEl.className = `chat-message ${isOwn ? 'own' : ''}`;

    const userLabel = isOwn ? 'You' : (userId === state.userId ? 'You' : 'Friend');

    messageEl.innerHTML = `
        <div class="message-content">
            <div class="message-author">${userLabel}</div>
            <div class="message-text">${escapeHtml(message)}</div>
            <div class="message-time">${timestamp}</div>
        </div>
    `;

    chatMessages.appendChild(messageEl);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ============ Movie Player Functions ============

function loadMovie(url, name) {
    moviePlayer.src = url;
    movieTitle.textContent = `Now Playing: ${name}`;
    
    // Sync with friend
    socket.emit('movie_control', {
        action: 'load',
        value: { url: url, name: name }
    });

    showNotification(`Loaded: ${name}`, 'success');
}

function handleRemoteMovieControl(data) {
    if (data.action === 'load') {
        moviePlayer.src = data.value.url;
        movieTitle.textContent = `Now Playing: ${data.value.name}`;
    } else if (data.action === 'play') {
        moviePlayer.play();
    } else if (data.action === 'pause') {
        moviePlayer.pause();
    } else if (data.action === 'seek') {
        moviePlayer.currentTime = data.value;
    }
}

// ============ UI Functions ============

function showRoomInfo() {
    const roomInfo = document.getElementById('roomInfo');
    const displayRoomId = document.getElementById('displayRoomId');
    displayRoomId.textContent = state.roomId;
    roomInfo.classList.remove('hidden');
}

function switchSection(sectionName) {
    // Hide all sections
    document.querySelectorAll('.section').forEach(section => {
        section.classList.remove('active');
    });

    // Show selected section
    document.getElementById(sectionName).classList.add('active');

    // Update menu buttons
    menuBtns.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.section === sectionName);
    });
}

function showNotification(message, type = 'info') {
    notification.textContent = message;
    notification.className = `notification show ${type}`;

    setTimeout(() => {
        notification.classList.remove('show');
    }, 3000);
}

function updateControlButtonStates() {
    toggleAudio.classList.toggle('active', state.audioEnabled);
    toggleVideo.classList.toggle('active', state.videoEnabled);
    toggleScreenShare.classList.toggle('active', state.isScreenSharing);
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    console.log('ShareMOV App initialized');
    switchSection('home');
});
