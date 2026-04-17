const roomsTable = document.getElementById('roomsTable');
const roomStatus = document.getElementById('roomStatus');
const roomPrev = document.getElementById('roomPrev');
const roomNext = document.getElementById('roomNext');
const roomPageLabel = document.getElementById('roomPageLabel');
const roomPageSize = document.getElementById('roomPageSize');
const roomSearch = document.getElementById('roomSearch');
const roomRefresh = document.getElementById('roomRefresh');
const roomMembersModal = document.getElementById('roomMembersModal');
const roomMembersTitle = document.getElementById('roomMembersTitle');
const roomMembersList = document.getElementById('roomMembersList');
const roomMembersClose = document.getElementById('roomMembersClose');
const roomMembersSearch = document.getElementById('roomMembersSearch');

const state = {
  from: '0',
  limit: 10,
  page: 1,
  nextToken: null,
  pageTokens: ['0'],
  query: ''
};

const sortState = {
  key: 'last_active',
  dir: 'desc'
};

const membersState = {
  roomId: null,
  members: []
};
let searchDebounce = null;

async function api(path) {
  const response = await fetch(path);
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
  roomStatus.textContent = message;
}

function renderHeader() {
  roomsTable.innerHTML = '';
  const header = document.createElement('div');
  header.className = 'table-row header';
  const columns = [
    { label: 'Room', key: 'name' },
    { label: 'Homeserver', key: 'homeserver' },
    { label: 'Users', key: 'members' },
    { label: 'Last active', key: 'last_active' },
    { label: 'Controls', key: 'controls', sortable: false }
  ];

  columns.forEach((col) => {
    const span = document.createElement('span');
    span.textContent = col.label;
    if (col.sortable !== false) {
      span.classList.add('sortable');
      span.dataset.sortKey = col.key;
      span.dataset.sortDir = sortState.key === col.key ? sortState.dir : 'asc';
      span.dataset.sortActive = sortState.key === col.key ? 'true' : 'false';
    }
    header.appendChild(span);
  });

  roomsTable.appendChild(header);

  header.querySelectorAll('.sortable').forEach((span) => {
    span.addEventListener('click', () => {
      const key = span.dataset.sortKey;
      if (sortState.key === key) {
        sortState.dir = sortState.dir === 'asc' ? 'desc' : 'asc';
      } else {
        sortState.key = key;
        sortState.dir = 'asc';
      }
      resetPaging();
      loadRooms();
    });
  });
}

function renderEmpty(message) {
  roomsTable.innerHTML = `<div class="table-row"><span>${message}</span></div>`;
}

function formatDate(ts) {
  if (!ts) return 'Unknown';
  const ms = ts > 1e12 ? ts : ts * 1000;
  return new Date(ms).toLocaleDateString();
}

function getRoomName(room) {
  return room.name || room.canonical_alias || room.room_id || 'Unnamed room';
}

function getRoomId(room) {
  return room.room_id || '—';
}

function getRoomHomeserver(room) {
  const roomId = room.room_id || '';
  const parts = roomId.split(':');
  return parts.length > 1 ? parts.slice(1).join(':') : '—';
}

function getRoomMembers(room) {
  return (
    room.joined_members ??
    room.joined_local_members ??
    room.num_joined_members ??
    room.member_count ??
    0
  );
}

function getLastActive(room) {
  return room.last_event_ts ?? room.last_activity_ts ?? room.last_active_ts ?? room.last_activity ?? null;
}

function renderRooms(rooms) {
  renderHeader();

  rooms.forEach((room) => {
    const row = document.createElement('div');
    row.className = 'table-row';

    const roomCell = document.createElement('div');
    const roomMeta = document.createElement('div');
    roomMeta.className = 'room-meta';
    const roomName = document.createElement('div');
    roomName.className = 'display-name';
    roomName.textContent = getRoomName(room);
    const roomId = document.createElement('div');
    roomId.className = 'room-id';
    roomId.textContent = getRoomId(room);
    roomMeta.appendChild(roomName);
    roomMeta.appendChild(roomId);
    roomCell.appendChild(roomMeta);

    const serverCell = document.createElement('div');
    serverCell.textContent = getRoomHomeserver(room);
    serverCell.className = 'room-metric';

    const membersCell = document.createElement('div');
    const membersButton = document.createElement('button');
    membersButton.type = 'button';
    membersButton.className = 'room-member-btn';
    membersButton.textContent = String(getRoomMembers(room));
    membersButton.addEventListener('click', () => openMembersModal(room));
    membersCell.className = 'room-metric';
    membersCell.appendChild(membersButton);

    const lastActiveCell = document.createElement('div');
    lastActiveCell.textContent = formatDate(getLastActive(room));
    lastActiveCell.className = 'room-metric';
    if (room.last_active_stale) {
      lastActiveCell.classList.add('stale');
    }

    const actionCell = document.createElement('div');
    const moderateButton = document.createElement('button');
    moderateButton.className = 'btn ghost room-action-btn';
    moderateButton.type = 'button';
    moderateButton.textContent = 'Controls';
    moderateButton.addEventListener('click', () => {
      const url = `/room.html?room_id=${encodeURIComponent(room.room_id)}`;
      window.location.assign(url);
    });
    actionCell.appendChild(moderateButton);

    row.appendChild(roomCell);
    row.appendChild(serverCell);
    row.appendChild(membersCell);
    row.appendChild(lastActiveCell);
    row.appendChild(actionCell);
    roomsTable.appendChild(row);
  });
}

function mapSortKey(key) {
  switch (key) {
    case 'members':
      return 'members';
    case 'homeserver':
      return 'homeserver';
    case 'last_active':
      return 'last_active';
    case 'name':
    default:
      return 'name';
  }
}

function resetPaging() {
  state.page = 1;
  state.from = '0';
  state.nextToken = null;
  state.pageTokens = ['0'];
}

function renderMemberList(members) {
  if (!members.length) {
    roomMembersList.innerHTML = '<div class="details-empty">No members found.</div>';
    return;
  }
  roomMembersList.innerHTML = '';
  members.forEach((member) => {
    const item = document.createElement('div');
    item.className = 'details-item';
    const title = document.createElement('strong');

    if (typeof member === 'string') {
      title.textContent = member;
    } else {
      title.textContent = member?.name || member?.user_id || 'Unknown';
    }

    item.appendChild(title);

    if (member && typeof member !== 'string' && member.user_id) {
      const meta = document.createElement('div');
      meta.className = 'details-meta';
      meta.textContent = member.user_id;
      item.appendChild(meta);
    }

    roomMembersList.appendChild(item);
  });
}

function openMembersModal(room) {
  roomMembersModal.classList.remove('hidden');
  roomMembersModal.setAttribute('aria-hidden', 'false');
  roomMembersTitle.textContent = getRoomName(room);
  roomMembersSearch.value = '';
  roomMembersList.innerHTML = '<div class="details-empty">Loading members…</div>';
  membersState.roomId = room.room_id;
  membersState.members = [];

  api(`/api/rooms/${encodeURIComponent(room.room_id)}/members`)
    .then((data) => {
      const members = Array.isArray(data?.members) ? data.members : [];
      membersState.members = members;
      applyMemberFilter();
    })
    .catch((err) => {
      roomMembersList.innerHTML = '<div class="details-empty">Unable to load members.</div>';
      setStatus(`Error: ${err.message}`);
    });
}

function applyMemberFilter() {
  const query = roomMembersSearch.value.trim().toLowerCase();
  if (!query) {
    renderMemberList(membersState.members);
    return;
  }
  const filtered = membersState.members.filter((member) => {
    if (typeof member === 'string') {
      return member.toLowerCase().includes(query);
    }
    const name = member?.name || '';
    const userId = member?.user_id || '';
    return name.toLowerCase().includes(query) || userId.toLowerCase().includes(query);
  });
  renderMemberList(filtered);
}

roomMembersClose.addEventListener('click', () => {
  roomMembersModal.classList.add('hidden');
  roomMembersModal.setAttribute('aria-hidden', 'true');
});

roomMembersSearch.addEventListener('input', () => {
  applyMemberFilter();
});

async function loadRooms() {
  setStatus('Loading rooms…');
  renderEmpty('Loading rooms…');

  const orderBy = mapSortKey(sortState.key);
  const dir = sortState.dir === 'asc' ? 'f' : 'b';
  const query = state.query ? `&q=${encodeURIComponent(state.query)}` : '';
  const data = await api(
    `/api/rooms?from=${encodeURIComponent(state.from)}&limit=${state.limit}&order_by=${orderBy}&dir=${dir}${query}`
  );

  const rooms = data?.rooms || [];

  if (!rooms.length) {
    renderEmpty('No rooms found.');
  } else {
    renderRooms(rooms);
  }

  state.nextToken = data?.next_token ?? null;
  roomPageLabel.textContent = `Page ${state.page}`;
  roomPrev.disabled = state.page <= 1;
  roomNext.disabled = !state.nextToken;
  const total = Number(data?.total ?? rooms.length);
  setStatus(`Loaded ${rooms.length} rooms (${total} matched)`);
}

roomPrev.addEventListener('click', async () => {
  if (state.page <= 1) return;
  state.page -= 1;
  state.pageTokens.pop();
  state.from = state.pageTokens[state.pageTokens.length - 1] || '0';
  await loadRooms();
});

roomNext.addEventListener('click', async () => {
  if (!state.nextToken) return;
  state.page += 1;
  state.from = state.nextToken;
  state.pageTokens.push(state.nextToken);
  await loadRooms();
});

roomRefresh.addEventListener('click', async () => {
  await loadRooms();
});

roomPageSize.addEventListener('change', async (event) => {
  state.limit = Number(event.target.value);
  resetPaging();
  await loadRooms();
});

if (roomSearch) {
  roomSearch.addEventListener('input', () => {
    if (searchDebounce) {
      clearTimeout(searchDebounce);
    }
    searchDebounce = setTimeout(async () => {
      state.query = roomSearch.value.trim();
      resetPaging();
      await loadRooms();
    }, 260);
  });
}

loadRooms().catch((err) => {
  setStatus(`Error: ${err.message}`);
  renderEmpty('Unable to load rooms.');
});
