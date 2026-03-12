const roomTitle = document.getElementById('roomTitle');
const roomSubtitle = document.getElementById('roomSubtitle');
const roomDetailStatus = document.getElementById('roomDetailStatus');
const roomInfoId = document.getElementById('roomInfoId');
const roomInfoJoined = document.getElementById('roomInfoJoined');
const roomInfoInvited = document.getElementById('roomInfoInvited');
const roomInfoBanned = document.getElementById('roomInfoBanned');
const roomInfoEncryption = document.getElementById('roomInfoEncryption');
const roomInfoStateCount = document.getElementById('roomInfoStateCount');
const roomUsersList = document.getElementById('roomUsersList');
const roomKickModal = document.getElementById('roomKickModal');
const roomKickTarget = document.getElementById('roomKickTarget');
const roomKickConfirm = document.getElementById('roomKickConfirm');
const roomKickConfirmBtn = document.getElementById('roomKickConfirmBtn');
const roomKickCancel = document.getElementById('roomKickCancel');
const roomPowerModal = document.getElementById('roomPowerModal');
const roomPowerTarget = document.getElementById('roomPowerTarget');
const roomPowerValue = document.getElementById('roomPowerValue');
const roomPowerConfirm = document.getElementById('roomPowerConfirm');
const roomPowerConfirmBtn = document.getElementById('roomPowerConfirmBtn');
const roomPowerCancel = document.getElementById('roomPowerCancel');
const roomRedactModal = document.getElementById('roomRedactModal');
const roomRedactTarget = document.getElementById('roomRedactTarget');
const roomRedactPhrase = document.getElementById('roomRedactPhrase');
const roomRedactConfirm = document.getElementById('roomRedactConfirm');
const roomRedactConfirmBtn = document.getElementById('roomRedactConfirmBtn');
const roomRedactCancel = document.getElementById('roomRedactCancel');

const roomState = {
  roomId: null,
  members: []
};

let openMenuPanel = null;
let pendingUserId = null;

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

function renderUsers(members) {
  if (!members.length) {
    roomUsersList.innerHTML = '<div class="details-empty">No members found.</div>';
    return;
  }
  roomUsersList.innerHTML = '';
  members.forEach((member) => {
    const userId = typeof member === 'string' ? member : member?.user_id || 'Unknown';
    const item = document.createElement('div');
    item.className = 'details-item room-user-row';

    const title = document.createElement('strong');
    title.textContent = userId;

    const menuWrapper = document.createElement('div');
    menuWrapper.className = 'menu';

    const menuButton = document.createElement('button');
    menuButton.className = 'btn ghost menu-trigger';
    menuButton.type = 'button';
    menuButton.textContent = '⋯';
    menuButton.setAttribute('aria-label', 'User actions');

    const menuPanel = document.createElement('div');
    menuPanel.className = 'menu-panel';

    const addMenuItem = (label, onClick, isDanger = false) => {
      const itemButton = document.createElement('button');
      itemButton.type = 'button';
      itemButton.className = `menu-item${isDanger ? ' danger' : ''}`;
      itemButton.textContent = label;
      itemButton.addEventListener('click', () => {
        closeMenuPanel();
        onClick();
      });
      menuPanel.appendChild(itemButton);
    };

    addMenuItem('Kick from room', () => openKickModal(userId));
    addMenuItem('Change power level', () => openPowerModal(userId));
    addMenuItem('Remove messages', () => openRedactModal(userId), true);

    menuButton.addEventListener('click', (event) => {
      event.stopPropagation();
      if (openMenuPanel && openMenuPanel !== menuPanel) {
        closeMenuPanel();
      }
      const isOpen = menuPanel.classList.toggle('open');
      if (isOpen) {
        positionMenuPanel(menuPanel, menuButton);
        openMenuPanel = menuPanel;
      } else {
        openMenuPanel = null;
      }
    });

    menuWrapper.appendChild(menuButton);
    menuWrapper.appendChild(menuPanel);

    item.appendChild(title);
    item.appendChild(menuWrapper);
    roomUsersList.appendChild(item);
  });
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

function closeMenuPanel() {
  if (openMenuPanel) {
    openMenuPanel.classList.remove('open');
    openMenuPanel.style.position = '';
    openMenuPanel.style.top = '';
    openMenuPanel.style.left = '';
    openMenuPanel.style.right = '';
    openMenuPanel = null;
  }
}

function positionMenuPanel(panel, trigger) {
  const rect = trigger.getBoundingClientRect();
  const panelRect = panel.getBoundingClientRect();

  let top = rect.bottom + 6;
  if (top + panelRect.height > window.innerHeight - 8) {
    top = Math.max(8, rect.top - panelRect.height - 6);
  }

  let left = rect.right - panelRect.width;
  if (left < 8) {
    left = 8;
  }
  if (left + panelRect.width > window.innerWidth - 8) {
    left = Math.max(8, window.innerWidth - panelRect.width - 8);
  }

  panel.style.position = 'fixed';
  panel.style.top = `${top}px`;
  panel.style.left = `${left}px`;
  panel.style.right = 'auto';
}

function openKickModal(userId) {
  pendingUserId = userId;
  roomKickTarget.textContent = `Target: ${userId}`;
  roomKickConfirm.value = '';
  roomKickConfirmBtn.disabled = true;
  roomKickModal.classList.remove('hidden');
  roomKickModal.setAttribute('aria-hidden', 'false');
  roomKickConfirm.focus();
}

function closeKickModal() {
  roomKickModal.classList.add('hidden');
  roomKickModal.setAttribute('aria-hidden', 'true');
  pendingUserId = null;
  roomKickConfirm.value = '';
}

roomKickConfirm.addEventListener('input', () => {
  roomKickConfirmBtn.disabled = roomKickConfirm.value.trim() !== pendingUserId;
});

roomKickCancel.addEventListener('click', () => {
  closeKickModal();
});

roomKickConfirmBtn.addEventListener('click', async () => {
  if (!pendingUserId || !roomState.roomId) return;
  try {
    roomKickConfirmBtn.disabled = true;
    await api(`/api/rooms/${encodeURIComponent(roomState.roomId)}/kick`, {
      method: 'POST',
      body: JSON.stringify({ user_id: pendingUserId }),
      headers: { 'Content-Type': 'application/json' }
    });
    await loadRoom();
  } catch (err) {
    setStatus(`Error: ${err.message}`);
  } finally {
    closeKickModal();
  }
});

function openPowerModal(userId) {
  pendingUserId = userId;
  roomPowerTarget.textContent = `Target: ${userId}`;
  roomPowerValue.value = '';
  roomPowerConfirm.value = '';
  roomPowerConfirmBtn.disabled = true;
  roomPowerModal.classList.remove('hidden');
  roomPowerModal.setAttribute('aria-hidden', 'false');
  roomPowerValue.focus();
}

function closePowerModal() {
  roomPowerModal.classList.add('hidden');
  roomPowerModal.setAttribute('aria-hidden', 'true');
  pendingUserId = null;
  roomPowerValue.value = '';
  roomPowerConfirm.value = '';
}

function updatePowerConfirmState() {
  const userOk = roomPowerConfirm.value.trim() === pendingUserId;
  const levelOk = roomPowerValue.value !== '';
  roomPowerConfirmBtn.disabled = !(userOk && levelOk);
}

roomPowerValue.addEventListener('input', updatePowerConfirmState);
roomPowerConfirm.addEventListener('input', updatePowerConfirmState);

roomPowerCancel.addEventListener('click', () => {
  closePowerModal();
});

roomPowerConfirmBtn.addEventListener('click', async () => {
  if (!pendingUserId || !roomState.roomId) return;
  try {
    roomPowerConfirmBtn.disabled = true;
    const level = Number(roomPowerValue.value);
    await api(`/api/rooms/${encodeURIComponent(roomState.roomId)}/power_level`, {
      method: 'POST',
      body: JSON.stringify({ user_id: pendingUserId, level }),
      headers: { 'Content-Type': 'application/json' }
    });
    await loadRoom();
  } catch (err) {
    setStatus(`Error: ${err.message}`);
  } finally {
    closePowerModal();
  }
});

function openRedactModal(userId) {
  pendingUserId = userId;
  roomRedactTarget.textContent = `Target: ${userId}`;
  roomRedactPhrase.value = '';
  roomRedactConfirm.value = '';
  roomRedactConfirmBtn.disabled = true;
  roomRedactModal.classList.remove('hidden');
  roomRedactModal.setAttribute('aria-hidden', 'false');
  roomRedactPhrase.focus();
}

function closeRedactModal() {
  roomRedactModal.classList.add('hidden');
  roomRedactModal.setAttribute('aria-hidden', 'true');
  pendingUserId = null;
  roomRedactPhrase.value = '';
  roomRedactConfirm.value = '';
}

function updateRedactConfirmState() {
  const phraseOk = roomRedactPhrase.value.trim().toUpperCase() === 'REDACT';
  const userOk = roomRedactConfirm.value.trim() === pendingUserId;
  roomRedactConfirmBtn.disabled = !(phraseOk && userOk);
}

roomRedactPhrase.addEventListener('input', updateRedactConfirmState);
roomRedactConfirm.addEventListener('input', updateRedactConfirmState);

roomRedactCancel.addEventListener('click', () => {
  closeRedactModal();
});

roomRedactConfirmBtn.addEventListener('click', async () => {
  if (!pendingUserId || !roomState.roomId) return;
  try {
    roomRedactConfirmBtn.disabled = true;
    await api(`/api/rooms/${encodeURIComponent(roomState.roomId)}/redact_user`, {
      method: 'POST',
      body: JSON.stringify({ user_id: pendingUserId }),
      headers: { 'Content-Type': 'application/json' }
    });
    await loadRoom();
  } catch (err) {
    setStatus(`Error: ${err.message}`);
  } finally {
    closeRedactModal();
  }
});

document.addEventListener('click', (event) => {
  if (!event.target.closest('.menu')) {
    closeMenuPanel();
  }
});

window.addEventListener('resize', () => {
  closeMenuPanel();
});

window.addEventListener(
  'scroll',
  () => {
    closeMenuPanel();
  },
  true
);

async function loadRoom() {
  const params = new URLSearchParams(window.location.search);
  const roomId = params.get('room_id');
  if (!roomId) {
    roomTitle.textContent = 'Missing room ID';
    roomSubtitle.textContent = 'Provide ?room_id=!room:example.com in the URL.';
    setStatus('Error');
    return;
  }

  roomTitle.textContent = 'Room moderation';
  roomSubtitle.textContent = roomId;
  roomInfoId.textContent = roomId;
  roomState.roomId = roomId;

  setStatus('Loading…');

  try {
    const [details, state, members] = await Promise.all([
      api(`/api/rooms/${encodeURIComponent(roomId)}/details`),
      api(`/api/rooms/${encodeURIComponent(roomId)}/state`),
      api(`/api/rooms/${encodeURIComponent(roomId)}/members`)
    ]);

    const counts = countMembership(Array.isArray(state?.state) ? state.state : state);
    const stateEvents = Array.isArray(state?.state) ? state.state : Array.isArray(state) ? state : [];
    roomInfoStateCount.textContent = String(stateEvents.length);

    roomTitle.textContent = details?.name || details?.canonical_alias || 'Room moderation';
    roomInfoJoined.textContent = String(counts.join ?? 0);
    roomInfoInvited.textContent = String(counts.invite ?? 0);
    roomInfoBanned.textContent = String(counts.ban ?? 0);

    if (details?.encryption) {
      roomInfoEncryption.textContent = 'Enabled';
    } else {
      roomInfoEncryption.textContent = 'Disabled';
    }

    const memberList = Array.isArray(members?.members) ? members.members : [];
    roomState.members = memberList;
    renderUsers(memberList);

    setStatus('Loaded');
  } catch (err) {
    setStatus(`Error: ${err.message}`);
    roomUsersList.innerHTML = '<div class="details-empty">Unable to load users.</div>';
  }
}

loadRoom();
