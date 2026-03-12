const userHeading = document.getElementById('userHeading');
const userSubtitle = document.getElementById('userSubtitle');
const detailsStatus = document.getElementById('detailsStatus');
const logList = document.getElementById('logList');
const deviceList = document.getElementById('deviceList');
const roomList = document.getElementById('roomList');
const logRange = document.getElementById('logRange');

const state = {
  userId: null,
  logs: []
};

function setStatus(message) {
  detailsStatus.textContent = message;
}

function formatTime(ts) {
  if (!ts) return 'Unknown time';
  const ms = ts > 1e12 ? ts : ts * 1000;
  return new Date(ms).toLocaleString();
}

function renderEmpty(target, message) {
  target.innerHTML = `<div class="details-empty">${message}</div>`;
}

function renderLogs() {
  if (!state.logs.length) {
    renderEmpty(logList, 'No recent sign-in activity.');
    return;
  }

  const rangeDays = Number(logRange.value);
  const now = Date.now();
  const windowStart = now - rangeDays * 24 * 60 * 60 * 1000;
  const visible = state.logs.filter((entry) => entry.lastSeen >= windowStart);

  if (!visible.length) {
    renderEmpty(logList, 'No activity in this time range.');
    return;
  }

  logList.innerHTML = '';
  visible.forEach((entry) => {
    const card = document.createElement('div');
    card.className = 'details-item';
    const title = document.createElement('strong');
    title.textContent = entry.ip || 'Unknown IP';
    const meta = document.createElement('div');
    meta.className = 'details-meta';
    meta.textContent = `${formatTime(entry.lastSeen)} · ${entry.deviceId || 'Unknown device'}`;
    const agent = document.createElement('div');
    agent.className = 'details-meta';
    agent.textContent = entry.userAgent || 'Unknown user agent';
    card.appendChild(title);
    card.appendChild(meta);
    card.appendChild(agent);
    logList.appendChild(card);
  });
}

function renderDevices(devices) {
  if (!devices.length) {
    renderEmpty(deviceList, 'No devices found.');
    return;
  }

  deviceList.innerHTML = '';
  devices.forEach((device) => {
    const card = document.createElement('div');
    card.className = 'details-item';
    const title = document.createElement('strong');
    title.textContent = device.display_name || device.device_id || 'Unknown device';
    const meta = document.createElement('div');
    meta.className = 'details-meta';
    meta.textContent = `Device ID: ${device.device_id || 'Unknown'}`;
    const seen = document.createElement('div');
    seen.className = 'details-meta';
    const lastSeenTs = device.last_seen_ts || device.last_seen;
    seen.textContent = `Last seen: ${formatTime(lastSeenTs)} · ${device.last_seen_ip || 'Unknown IP'}`;
    card.appendChild(title);
    card.appendChild(meta);
    card.appendChild(seen);
    deviceList.appendChild(card);
  });
}

function renderRooms(rooms) {
  if (!rooms.length) {
    renderEmpty(roomList, 'No joined rooms.');
    return;
  }

  roomList.innerHTML = '';
  rooms.forEach((room) => {
    const card = document.createElement('div');
    card.className = 'details-item';
    const title = document.createElement('strong');
    title.textContent = room.name || room.canonical_alias || 'Unnamed room';
    const meta = document.createElement('div');
    meta.className = 'details-meta';
    meta.textContent = `Room ID: ${room.room_id}`;
    card.appendChild(title);
    card.appendChild(meta);
    roomList.appendChild(card);
  });
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const text = await response.text();
  let data = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch (err) {
      data = { raw: text };
    }
  }

  if (!response.ok) {
    const message = data?.error || data?.details?.error || `Request failed (${response.status})`;
    throw new Error(message);
  }

  return data;
}

function extractLogs(whois) {
  const devices = whois?.devices || {};
  const logs = [];

  Object.entries(devices).forEach(([deviceId, device]) => {
    const sessions = device.sessions || [];
    sessions.forEach((session) => {
      const connections = session.connections || [];
      connections.forEach((connection) => {
        const lastSeen = connection.last_seen || session.last_seen;
        logs.push({
          deviceId,
          ip: connection.ip,
          lastSeen: lastSeen ? (lastSeen > 1e12 ? lastSeen : lastSeen * 1000) : null,
          userAgent: connection.user_agent || session.user_agent || ''
        });
      });
    });
  });

  logs.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  return logs;
}

async function loadDetails() {
  const params = new URLSearchParams(window.location.search);
  const userId = params.get('user_id');
  state.userId = userId;

  if (!userId) {
    userHeading.textContent = 'Missing user ID';
    userSubtitle.textContent = 'Provide ?user_id=@user:example.com in the URL.';
    setStatus('Error');
    renderEmpty(logList, 'No data.');
    renderEmpty(deviceList, 'No data.');
    renderEmpty(roomList, 'No data.');
    return;
  }

  userHeading.textContent = userId;
  userSubtitle.textContent = 'Advanced account activity for this user.';
  setStatus('Loading data…');

  try {
    const [whois, devices, rooms] = await Promise.all([
      api(`/api/users/${encodeURIComponent(userId)}/whois`),
      api(`/api/users/${encodeURIComponent(userId)}/devices`),
      api(`/api/users/${encodeURIComponent(userId)}/joined_rooms`)
    ]);

    const roomDetails = await api('/api/rooms/details', {
      method: 'POST',
      body: JSON.stringify({
        room_ids: rooms?.joined_rooms || []
      }),
      headers: {
        'Content-Type': 'application/json'
      }
    });

    state.logs = extractLogs(whois);
    renderLogs();
    renderDevices(devices?.devices || []);
    renderRooms(roomDetails?.rooms || []);
    setStatus('Loaded');
  } catch (err) {
    setStatus(`Error: ${err.message}`);
    renderEmpty(logList, 'Unable to load logs.');
    renderEmpty(deviceList, 'Unable to load devices.');
    renderEmpty(roomList, 'Unable to load rooms.');
  }
}

logRange.addEventListener('change', () => {
  renderLogs();
});

loadDetails();
