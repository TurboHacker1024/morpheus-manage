const roomTitle = document.getElementById('roomTitle');
const roomSubtitle = document.getElementById('roomSubtitle');
const roomDetailStatus = document.getElementById('roomDetailStatus');

const roomInfoId = document.getElementById('roomInfoId');
const roomInfoJoined = document.getElementById('roomInfoJoined');
const roomInfoInvited = document.getElementById('roomInfoInvited');
const roomInfoBanned = document.getElementById('roomInfoBanned');
const roomInfoEncryption = document.getElementById('roomInfoEncryption');
const roomInfoStateCount = document.getElementById('roomInfoStateCount');
const roomInfoBlocked = document.getElementById('roomInfoBlocked');
const roomRefreshBtn = document.getElementById('roomRefreshBtn');

const roomBlockBtn = document.getElementById('roomBlockBtn');
const roomUnblockBtn = document.getElementById('roomUnblockBtn');
const roomBlockNote = document.getElementById('roomBlockNote');

const roomPurgeBefore = document.getElementById('roomPurgeBefore');
const roomPurgeDeleteLocal = document.getElementById('roomPurgeDeleteLocal');
const roomPurgeConfirm = document.getElementById('roomPurgeConfirm');
const roomPurgeBtn = document.getElementById('roomPurgeBtn');
const roomPurgeStatusBtn = document.getElementById('roomPurgeStatusBtn');
const roomPurgeNote = document.getElementById('roomPurgeNote');

const roomQuarantineConfirm = document.getElementById('roomQuarantineConfirm');
const roomQuarantineBtn = document.getElementById('roomQuarantineBtn');
const roomQuarantineNote = document.getElementById('roomQuarantineNote');

const roomShutdownBlock = document.getElementById('roomShutdownBlock');
const roomShutdownPurge = document.getElementById('roomShutdownPurge');
const roomShutdownForcePurge = document.getElementById('roomShutdownForcePurge');
const roomShutdownNewRoomUser = document.getElementById('roomShutdownNewRoomUser');
const roomShutdownRoomName = document.getElementById('roomShutdownRoomName');
const roomShutdownMessage = document.getElementById('roomShutdownMessage');
const roomShutdownConfirm = document.getElementById('roomShutdownConfirm');
const roomShutdownBtn = document.getElementById('roomShutdownBtn');
const roomDeleteStatusBtn = document.getElementById('roomDeleteStatusBtn');
const roomShutdownNote = document.getElementById('roomShutdownNote');

const roomUsersSearch = document.getElementById('roomUsersSearch');
const roomUsersList = document.getElementById('roomUsersList');

const roomState = {
  roomId: null,
  members: [],
  block: null,
  purgeId: null,
  deleteId: null
};

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

function setStatus(message) {
  roomDetailStatus.textContent = message;
}

function countMembership(stateEvents) {
  const counts = {
    join: 0,
    invite: 0,
    ban: 0
  };

  stateEvents.forEach((event) => {
    if (event?.type !== 'm.room.member') return;
    const membership = event?.content?.membership;
    if (membership === 'join') counts.join += 1;
    if (membership === 'invite') counts.invite += 1;
    if (membership === 'ban') counts.ban += 1;
  });

  return counts;
}

function renderMemberList(members) {
  if (!members.length) {
    roomUsersList.innerHTML = '<div class="details-empty">No members found.</div>';
    return;
  }

  roomUsersList.innerHTML = '';
  members.forEach((memberId) => {
    const item = document.createElement('div');
    item.className = 'details-item';

    const title = document.createElement('strong');
    title.textContent = memberId;
    item.appendChild(title);

    roomUsersList.appendChild(item);
  });
}

function applyMemberFilter() {
  const query = roomUsersSearch.value.trim().toLowerCase();
  if (!query) {
    renderMemberList(roomState.members);
    return;
  }

  const filtered = roomState.members.filter((memberId) => memberId.toLowerCase().includes(query));
  renderMemberList(filtered);
}

function updateDangerStates() {
  const purgePhraseOk = roomPurgeConfirm.value.trim().toUpperCase() === 'PURGE';
  const hasPurgeDate = Boolean(roomPurgeBefore.value);
  roomPurgeBtn.disabled = !(purgePhraseOk && hasPurgeDate && roomState.roomId);

  const quarantinePhraseOk = roomQuarantineConfirm.value.trim().toUpperCase() === 'QUARANTINE';
  roomQuarantineBtn.disabled = !(quarantinePhraseOk && roomState.roomId);

  const shutdownConfirmed = roomShutdownConfirm.value.trim() === roomState.roomId;
  roomShutdownBtn.disabled = !(shutdownConfirmed && roomState.roomId);
}

function toMsTimestamp(localDatetimeValue) {
  if (!localDatetimeValue) return null;
  const ts = new Date(localDatetimeValue).getTime();
  return Number.isFinite(ts) ? ts : null;
}

async function withBusy(button, busyText, callback) {
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = busyText;
  try {
    await callback();
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
    updateDangerStates();
  }
}

async function refreshBlockStatus() {
  if (!roomState.roomId) return;
  const blockData = await api(`/api/rooms/${encodeURIComponent(roomState.roomId)}/block`);
  roomState.block = Boolean(blockData?.block);
  roomInfoBlocked.textContent = roomState.block ? 'Blocked' : 'Not blocked';
  roomBlockNote.textContent = roomState.block
    ? `Room is blocked${blockData?.user_id ? ` (by ${blockData.user_id})` : ''}.`
    : 'Room is not blocked.';
}

async function updateBlockState(block) {
  if (!roomState.roomId) return;
  const confirmMessage = block
    ? `Block ${roomState.roomId}? This prevents local users from joining.`
    : `Unblock ${roomState.roomId}?`;
  if (!window.confirm(confirmMessage)) {
    return;
  }

  await withBusy(block ? roomBlockBtn : roomUnblockBtn, block ? 'Blocking...' : 'Unblocking...', async () => {
    setStatus(block ? 'Blocking room...' : 'Unblocking room...');
    await api(`/api/rooms/${encodeURIComponent(roomState.roomId)}/block`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ block })
    });
    await refreshBlockStatus();
    setStatus(block ? 'Room blocked.' : 'Room unblocked.');
  });
}

async function startPurge() {
  if (!roomState.roomId) return;
  const purgeTs = toMsTimestamp(roomPurgeBefore.value);
  if (!purgeTs) {
    throw new Error('Pick a valid purge date/time first.');
  }

  await withBusy(roomPurgeBtn, 'Starting...', async () => {
    setStatus('Starting purge task...');
    const data = await api(`/api/rooms/${encodeURIComponent(roomState.roomId)}/purge_history`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        purge_up_to_ts: purgeTs,
        delete_local_events: roomPurgeDeleteLocal.checked
      })
    });

    roomState.purgeId = data?.purge_id || null;
    roomPurgeStatusBtn.disabled = !roomState.purgeId;
    const scope = roomPurgeDeleteLocal.checked ? 'including local events' : 'excluding local events';
    const modeDetail = data?.fallback_used
      ? ` via event fallback (${data?.resolved_event_id || 'resolved event'})`
      : '';
    roomPurgeNote.textContent = roomState.purgeId
      ? `Purge started (ID: ${roomState.purgeId}, ${scope}${modeDetail}).`
      : `Purge request sent (${scope}).`;
    setStatus('Purge task started.');
  });
}

async function refreshPurgeStatus() {
  if (!roomState.purgeId) return;

  await withBusy(roomPurgeStatusBtn, 'Checking...', async () => {
    const data = await api(`/api/rooms/purge_history/${encodeURIComponent(roomState.purgeId)}`);
    const status = data?.status || 'unknown';
    const errorText = data?.error ? ` Error: ${data.error}` : '';
    roomPurgeNote.textContent = `Purge ${roomState.purgeId}: ${status}.${errorText}`;
    setStatus(`Purge status: ${status}`);
  });
}

async function quarantineRoomMedia() {
  if (!roomState.roomId) return;

  await withBusy(roomQuarantineBtn, 'Quarantining...', async () => {
    setStatus('Quarantining room media...');
    const data = await api(`/api/rooms/${encodeURIComponent(roomState.roomId)}/quarantine_media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });

    const count = Number(data?.num_quarantined || 0);
    roomQuarantineNote.textContent = count
      ? `Quarantined ${count} media items.`
      : 'Room media quarantine request completed.';
    setStatus('Room media quarantine completed.');
  });
}

function getDeleteStatusSummary(payload) {
  if (!payload) return { status: 'unknown', message: '' };

  if (payload.status) {
    return {
      status: payload.status,
      message: payload.error || ''
    };
  }

  if (Array.isArray(payload.results) && payload.results.length) {
    const latest = payload.results[0];
    return {
      status: latest?.status || 'unknown',
      message: latest?.error || ''
    };
  }

  return { status: 'unknown', message: '' };
}

async function startShutdown() {
  if (!roomState.roomId) return;

  await withBusy(roomShutdownBtn, 'Shutting down...', async () => {
    setStatus('Starting room shutdown...');
    const data = await api(`/api/rooms/${encodeURIComponent(roomState.roomId)}/shutdown`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        block: roomShutdownBlock.checked,
        purge: roomShutdownPurge.checked,
        force_purge: roomShutdownForcePurge.checked,
        new_room_user_id: roomShutdownNewRoomUser.value.trim() || undefined,
        room_name: roomShutdownRoomName.value.trim() || undefined,
        message: roomShutdownMessage.value.trim() || undefined
      })
    });

    roomState.deleteId = data?.delete_id || null;
    roomDeleteStatusBtn.disabled = !roomState.deleteId;
    roomShutdownNote.textContent = roomState.deleteId
      ? `Shutdown task started (delete_id: ${roomState.deleteId}).`
      : 'Shutdown request submitted.';
    setStatus('Room shutdown task started.');
  });
}

async function refreshDeleteStatus() {
  if (!roomState.roomId) return;
  const query = roomState.deleteId ? `?delete_id=${encodeURIComponent(roomState.deleteId)}` : '';

  await withBusy(roomDeleteStatusBtn, 'Checking...', async () => {
    const data = await api(`/api/rooms/${encodeURIComponent(roomState.roomId)}/delete_status${query}`);
    const summary = getDeleteStatusSummary(data);
    const suffix = summary.message ? ` Error: ${summary.message}` : '';
    roomShutdownNote.textContent = roomState.deleteId
      ? `Shutdown ${roomState.deleteId}: ${summary.status}.${suffix}`
      : `Shutdown status: ${summary.status}.${suffix}`;
    setStatus(`Shutdown status: ${summary.status}`);
  });
}

async function loadRoom() {
  const params = new URLSearchParams(window.location.search);
  const roomId = params.get('room_id');
  if (!roomId) {
    roomTitle.textContent = 'Missing room ID';
    roomSubtitle.textContent = 'Provide ?room_id=!room:example.com in the URL.';
    setStatus('Error');
    return;
  }

  roomTitle.textContent = 'Room controls';
  roomSubtitle.textContent = roomId;
  roomInfoId.textContent = roomId;
  roomState.roomId = roomId;
  roomShutdownConfirm.placeholder = roomId;
  updateDangerStates();

  setStatus('Loading…');

  try {
    const [details, state, members, blockData] = await Promise.all([
      api(`/api/rooms/${encodeURIComponent(roomId)}/details`),
      api(`/api/rooms/${encodeURIComponent(roomId)}/state`),
      api(`/api/rooms/${encodeURIComponent(roomId)}/members`),
      api(`/api/rooms/${encodeURIComponent(roomId)}/block`).catch(() => null)
    ]);

    const stateEvents = Array.isArray(state?.state) ? state.state : [];
    const counts = countMembership(stateEvents);
    const memberList = Array.isArray(members?.members) ? members.members : [];

    roomTitle.textContent = details?.name || details?.canonical_alias || 'Room controls';
    roomInfoJoined.textContent = String(counts.join ?? 0);
    roomInfoInvited.textContent = String(counts.invite ?? 0);
    roomInfoBanned.textContent = String(counts.ban ?? 0);
    roomInfoEncryption.textContent = details?.encryption ? 'Enabled' : 'Disabled';
    roomInfoStateCount.textContent = String(stateEvents.length);

    if (blockData) {
      roomState.block = Boolean(blockData?.block);
      roomInfoBlocked.textContent = roomState.block ? 'Blocked' : 'Not blocked';
      roomBlockNote.textContent = roomState.block
        ? `Room is blocked${blockData?.user_id ? ` (by ${blockData.user_id})` : ''}.`
        : 'Room is not blocked.';
    } else {
      roomInfoBlocked.textContent = 'Unknown';
      roomBlockNote.textContent = 'Block status endpoint unavailable on this Synapse instance.';
    }

    roomState.members = memberList;
    applyMemberFilter();

    setStatus(`Loaded ${memberList.length} members.`);
  } catch (err) {
    setStatus(`Error: ${err.message}`);
    roomUsersList.innerHTML = '<div class="details-empty">Unable to load room data.</div>';
  }
}

roomRefreshBtn.addEventListener('click', () => {
  loadRoom();
});

roomBlockBtn.addEventListener('click', async () => {
  try {
    await updateBlockState(true);
  } catch (err) {
    setStatus(`Error: ${err.message}`);
    roomBlockNote.textContent = `Error: ${err.message}`;
  }
});

roomUnblockBtn.addEventListener('click', async () => {
  try {
    await updateBlockState(false);
  } catch (err) {
    setStatus(`Error: ${err.message}`);
    roomBlockNote.textContent = `Error: ${err.message}`;
  }
});

roomPurgeBtn.addEventListener('click', async () => {
  try {
    await startPurge();
  } catch (err) {
    roomPurgeNote.textContent = `Error: ${err.message}`;
    setStatus(`Error: ${err.message}`);
  }
});

roomPurgeStatusBtn.addEventListener('click', async () => {
  try {
    await refreshPurgeStatus();
  } catch (err) {
    roomPurgeNote.textContent = `Error: ${err.message}`;
    setStatus(`Error: ${err.message}`);
  }
});

roomQuarantineBtn.addEventListener('click', async () => {
  try {
    await quarantineRoomMedia();
  } catch (err) {
    roomQuarantineNote.textContent = `Error: ${err.message}`;
    setStatus(`Error: ${err.message}`);
  }
});

roomShutdownBtn.addEventListener('click', async () => {
  try {
    await startShutdown();
  } catch (err) {
    roomShutdownNote.textContent = `Error: ${err.message}`;
    setStatus(`Error: ${err.message}`);
  }
});

roomDeleteStatusBtn.addEventListener('click', async () => {
  try {
    await refreshDeleteStatus();
  } catch (err) {
    roomShutdownNote.textContent = `Error: ${err.message}`;
    setStatus(`Error: ${err.message}`);
  }
});

roomUsersSearch.addEventListener('input', applyMemberFilter);
roomPurgeConfirm.addEventListener('input', updateDangerStates);
roomPurgeBefore.addEventListener('input', updateDangerStates);
roomQuarantineConfirm.addEventListener('input', updateDangerStates);
roomShutdownConfirm.addEventListener('input', updateDangerStates);

loadRoom();
