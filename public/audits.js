const state = {
  from: '0',
  limit: 10,
  page: 1,
  nextToken: null,
  pageTokens: ['0']
};

let sortState = {
  key: 'user',
  dir: 'asc'
};

const sessionsState = {
  userId: null,
  displayName: '',
  sessions: []
};

const statusEl = document.getElementById('status');
const serverNameEl = document.getElementById('serverName');
const serverNameInlineEl = document.getElementById('serverNameInline');
const usersTable = document.getElementById('usersTable');
const pageLabel = document.getElementById('pageLabel');
const prevBtn = document.getElementById('prevBtn');
const nextBtn = document.getElementById('nextBtn');
const refreshBtn = document.getElementById('refreshBtn');
const pageSize = document.getElementById('pageSize');
const showDisabledToggle = document.getElementById('showDisabledToggle');
const showDisabledLabel = document.getElementById('showDisabledLabel');

const sessionsModal = document.getElementById('sessionsModal');
const sessionsTitle = document.getElementById('sessionsTitle');
const sessionsSubtitle = document.getElementById('sessionsSubtitle');
const sessionsWarning = document.getElementById('sessionsWarning');
const sessionsList = document.getElementById('sessionsList');
const sessionsRefresh = document.getElementById('sessionsRefresh');
const revokeAllBtn = document.getElementById('revokeAllBtn');
const sessionsClose = document.getElementById('sessionsClose');
const revokeAllConfirmPanel = document.getElementById('revokeAllConfirmPanel');
const revokeAllPhrase = document.getElementById('revokeAllPhrase');
const revokeAllUserConfirm = document.getElementById('revokeAllUserConfirm');
const revokeAllCancel = document.getElementById('revokeAllCancel');
const revokeAllConfirmBtn = document.getElementById('revokeAllConfirmBtn');

async function api(path, options = {}) {
  const config = {
    headers: { 'Content-Type': 'application/json' },
    ...options
  };

  if (options.body && typeof options.body !== 'string') {
    config.body = JSON.stringify(options.body);
  }

  const response = await fetch(path, config);
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
  statusEl.textContent = message;
}

function mapSortKey(key) {
  switch (key) {
    case 'admin':
      return 'admin';
    case 'status':
      return 'deactivated';
    case 'user':
    default:
      return 'displayname';
  }
}

function resetPaging() {
  state.page = 1;
  state.from = '0';
  state.nextToken = null;
  state.pageTokens = ['0'];
}

function formatDateTime(ts) {
  if (!ts) return 'Unknown';
  const ms = ts > 1e12 ? ts : ts * 1000;
  return new Date(ms).toLocaleString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function renderHeader() {
  usersTable.innerHTML = '';
  const header = document.createElement('div');
  header.className = 'table-row header';
  const columns = [
    { label: 'User', key: 'user', sortable: true },
    { label: 'Admin', key: 'admin', sortable: true },
    { label: 'Status', key: 'status', sortable: true },
    { label: 'Action', key: 'action', sortable: false }
  ];

  columns.forEach((column) => {
    const span = document.createElement('span');
    span.textContent = column.label;
    if (column.sortable) {
      span.classList.add('sortable');
      span.dataset.sortKey = column.key;
      span.dataset.sortDir = sortState.key === column.key ? sortState.dir : 'asc';
      span.dataset.sortActive = sortState.key === column.key ? 'true' : 'false';
    }
    header.appendChild(span);
  });

  usersTable.appendChild(header);

  header.querySelectorAll('.sortable').forEach((item) => {
    item.addEventListener('click', () => {
      const key = item.dataset.sortKey;
      if (!key) return;
      if (sortState.key === key) {
        sortState.dir = sortState.dir === 'asc' ? 'desc' : 'asc';
      } else {
        sortState = { key, dir: 'asc' };
      }
      resetPaging();
      void loadUsers();
    });
  });
}

function renderEmpty(message) {
  usersTable.innerHTML = `<div class="table-row"><span>${message}</span></div>`;
}

function renderUsers(users) {
  renderHeader();

  users.forEach((user) => {
    const row = document.createElement('div');
    row.className = 'table-row';

    if (user.deactivated) {
      row.classList.add('disabled');
    } else if (user.locked) {
      row.classList.add('locked');
    }

    const userCell = document.createElement('div');
    userCell.innerHTML = `
      <div class="user-meta">
        <div class="display-name">${user.displayname || 'No display name'}</div>
        <div class="user-id">${user.name}</div>
      </div>
    `;

    const adminCell = document.createElement('div');
    adminCell.innerHTML = user.admin
      ? '<span class="badge">Admin</span>'
      : '<span class="badge muted">User</span>';

    const statusCell = document.createElement('div');
    if (user.deactivated) {
      statusCell.innerHTML = '<span class="badge muted">Deactivated</span>';
    } else if (user.locked) {
      statusCell.innerHTML = '<span class="badge warning">Locked</span>';
    } else {
      statusCell.innerHTML = '<span class="badge">Active</span>';
    }

    const actionCell = document.createElement('div');
    const sessionsButton = document.createElement('button');
    sessionsButton.type = 'button';
    sessionsButton.className = 'btn ghost';
    sessionsButton.textContent = 'Sessions';
    sessionsButton.addEventListener('click', () => {
      void openSessionsModal(user);
    });
    actionCell.appendChild(sessionsButton);

    row.appendChild(userCell);
    row.appendChild(adminCell);
    row.appendChild(statusCell);
    row.appendChild(actionCell);
    usersTable.appendChild(row);
  });
}

function closeSessionsModal() {
  sessionsModal.classList.add('hidden');
  sessionsModal.setAttribute('aria-hidden', 'true');
  closeRevokeAllConfirm();
  sessionsState.userId = null;
  sessionsState.displayName = '';
  sessionsState.sessions = [];
}

function updateRevokeAllConfirmState() {
  const phraseOk = revokeAllPhrase.value.trim().toUpperCase() === 'REVOKE';
  const userOk = revokeAllUserConfirm.value.trim() === sessionsState.userId;
  revokeAllConfirmBtn.disabled = !(phraseOk && userOk);
}

function openRevokeAllConfirm() {
  if (!sessionsState.userId || !sessionsState.sessions.length) {
    return;
  }
  revokeAllConfirmPanel.classList.remove('hidden');
  revokeAllPhrase.value = '';
  revokeAllUserConfirm.value = '';
  revokeAllConfirmBtn.disabled = true;
  revokeAllUserConfirm.placeholder = sessionsState.userId;
  revokeAllPhrase.focus();
}

function closeRevokeAllConfirm() {
  revokeAllConfirmPanel.classList.add('hidden');
  revokeAllPhrase.value = '';
  revokeAllUserConfirm.value = '';
  revokeAllConfirmBtn.disabled = true;
}

function renderSessionsList() {
  const sessions = sessionsState.sessions;

  if (!sessions.length) {
    closeRevokeAllConfirm();
    sessionsList.innerHTML = '<div class="details-empty">No active sessions found for this user.</div>';
    revokeAllBtn.disabled = true;
    return;
  }

  revokeAllBtn.disabled = false;
  sessionsList.innerHTML = '';

  sessions.forEach((session) => {
    const sessionItem = document.createElement('div');
    sessionItem.className = 'details-item session-item';

    const sessionMain = document.createElement('div');
    sessionMain.className = 'session-main';

    const sessionTitle = document.createElement('strong');
    sessionTitle.textContent = session.display_name || session.device_id || 'Unknown device';

    const sessionMeta1 = document.createElement('div');
    sessionMeta1.className = 'details-meta';
    sessionMeta1.textContent = `Device ID: ${session.device_id || 'Unknown'}`;

    const sessionMeta2 = document.createElement('div');
    sessionMeta2.className = 'details-meta';
    sessionMeta2.textContent = `Last seen: ${formatDateTime(session.last_seen_ts || session.last_seen)} | IP: ${session.last_seen_ip || 'Unknown'}`;

    sessionMain.appendChild(sessionTitle);
    sessionMain.appendChild(sessionMeta1);
    sessionMain.appendChild(sessionMeta2);

    const revokeBtn = document.createElement('button');
    revokeBtn.type = 'button';
    revokeBtn.className = 'btn ghost danger-outline';
    revokeBtn.textContent = 'Revoke';
    revokeBtn.disabled = !session.device_id;
    revokeBtn.addEventListener('click', async () => {
      if (!session.device_id || !sessionsState.userId) {
        return;
      }

      const shouldRevoke = window.confirm(
        `Revoke session ${session.device_id} for ${sessionsState.userId}?`
      );
      if (!shouldRevoke) {
        return;
      }

      try {
        revokeBtn.disabled = true;
        setStatus(`Revoking session ${session.device_id}...`);
        const result = await api(`/api/users/${encodeURIComponent(sessionsState.userId)}/revoke_session`, {
          method: 'POST',
          body: { device_id: session.device_id }
        });
        await refreshSessionsAfterSingleRevoke(session.device_id);
        if (result?.still_present) {
          setStatus(`Session ${session.device_id} still present after revoke. Try again shortly.`);
        } else {
          setStatus(`Revoked session ${session.device_id}`);
        }
      } catch (err) {
        setStatus(`Error: ${err.message}`);
        revokeBtn.disabled = false;
      }
    });

    sessionItem.appendChild(sessionMain);
    sessionItem.appendChild(revokeBtn);
    sessionsList.appendChild(sessionItem);
  });
}

async function refreshSessionsAfterSingleRevoke(deviceId) {
  await loadSessionsForModal(sessionsState.userId);
  const stillPresent = sessionsState.sessions.some((session) => session?.device_id === deviceId);
  if (stillPresent) {
    await sleep(700);
    await loadSessionsForModal(sessionsState.userId);
  }
}

async function loadSessionsForModal(userId) {
  sessionsList.innerHTML = '<div class="details-empty">Loading sessions...</div>';
  revokeAllBtn.disabled = true;
  sessionsRefresh.disabled = true;

  try {
    const data = await api(`/api/users/${encodeURIComponent(userId)}/devices?_ts=${Date.now()}`);
    const devices = Array.isArray(data?.devices) ? data.devices : [];

    devices.sort((a, b) => {
      const aTs = Number(a?.last_seen_ts || a?.last_seen || 0);
      const bTs = Number(b?.last_seen_ts || b?.last_seen || 0);
      return bTs - aTs;
    });

    sessionsState.sessions = devices;
    renderSessionsList();
  } finally {
    sessionsRefresh.disabled = false;
  }
}

async function openSessionsModal(user) {
  sessionsState.userId = user.name;
  sessionsState.displayName = user.displayname || 'No display name';
  sessionsState.sessions = [];

  sessionsTitle.textContent = `${sessionsState.displayName}`;
  sessionsSubtitle.textContent = `Session list for ${sessionsState.userId}`;
  sessionsWarning.textContent = 'Revoke removes a single session. Revoke all logs out every device for this user.';
  closeRevokeAllConfirm();
  sessionsModal.classList.remove('hidden');
  sessionsModal.setAttribute('aria-hidden', 'false');

  try {
    await loadSessionsForModal(sessionsState.userId);
  } catch (err) {
    sessionsList.innerHTML = '<div class="details-empty">Unable to load sessions.</div>';
    setStatus(`Error: ${err.message}`);
  }
}

async function revokeAllSessions() {
  if (!sessionsState.userId || !sessionsState.sessions.length) {
    return;
  }

  try {
    revokeAllBtn.disabled = true;
    revokeAllConfirmBtn.disabled = true;
    sessionsRefresh.disabled = true;
    setStatus(`Revoking all sessions for ${sessionsState.userId}...`);

    const result = await api(`/api/users/${encodeURIComponent(sessionsState.userId)}/revoke_all_sessions`, {
      method: 'POST'
    });

    await loadSessionsForModal(sessionsState.userId);

    if (result?.failed_count) {
      setStatus(`Revoked ${result.revoked_count} sessions, ${result.failed_count} failed.`);
    } else {
      setStatus(`Revoked all sessions for ${sessionsState.userId}`);
    }
    closeRevokeAllConfirm();
  } catch (err) {
    setStatus(`Error: ${err.message}`);
  } finally {
    sessionsRefresh.disabled = false;
  }
}

async function loadConfig() {
  const config = await api('/api/config');
  const serverName = config.server_name || 'unknown';
  serverNameEl.textContent = serverName;
  serverNameInlineEl.textContent = serverName;
  setStatus(`Connected to ${config.base_url}`);
}

async function loadUsers() {
  setStatus('Loading users...');
  renderEmpty('Loading users...');

  const showDisabled = showDisabledToggle.dataset.state === 'on';
  const deactivatedParam = showDisabled ? 'true' : 'false';
  const orderBy = mapSortKey(sortState.key);
  const dir = sortState.dir === 'asc' ? 'f' : 'b';
  const data = await api(
    `/api/users?from=${encodeURIComponent(state.from)}&limit=${state.limit}&guests=false&deactivated=${deactivatedParam}&order_by=${orderBy}&dir=${dir}`
  );

  const users = data?.users || [];
  if (!users.length) {
    renderEmpty('No users found.');
  } else {
    renderUsers(users);
  }

  state.nextToken = data?.next_token ?? null;
  pageLabel.textContent = `Page ${state.page}`;
  prevBtn.disabled = state.page <= 1;
  nextBtn.disabled = !state.nextToken;
  setStatus(`Loaded ${users.length} users`);
}

prevBtn.addEventListener('click', async () => {
  if (state.page <= 1) return;
  state.page -= 1;
  state.pageTokens.pop();
  state.from = state.pageTokens[state.pageTokens.length - 1] || '0';
  await loadUsers();
});

nextBtn.addEventListener('click', async () => {
  if (!state.nextToken) return;
  state.page += 1;
  state.from = state.nextToken;
  state.pageTokens.push(state.nextToken);
  await loadUsers();
});

refreshBtn.addEventListener('click', async () => {
  await loadUsers();
});

pageSize.addEventListener('change', async (event) => {
  state.limit = Number(event.target.value);
  resetPaging();
  await loadUsers();
});

showDisabledToggle.addEventListener('click', async () => {
  const isOn = showDisabledToggle.dataset.state === 'on';
  const nextState = isOn ? 'off' : 'on';
  showDisabledToggle.dataset.state = nextState;
  showDisabledToggle.setAttribute('aria-pressed', nextState === 'on' ? 'true' : 'false');
  showDisabledLabel.textContent = isOn ? 'Hide disabled users' : 'Show disabled users';
  resetPaging();
  await loadUsers();
});

revokeAllBtn.addEventListener('click', () => {
  openRevokeAllConfirm();
});

revokeAllPhrase.addEventListener('input', updateRevokeAllConfirmState);
revokeAllUserConfirm.addEventListener('input', updateRevokeAllConfirmState);

revokeAllCancel.addEventListener('click', () => {
  closeRevokeAllConfirm();
});

revokeAllConfirmBtn.addEventListener('click', async () => {
  await revokeAllSessions();
});

sessionsRefresh.addEventListener('click', async () => {
  if (!sessionsState.userId) return;
  try {
    setStatus(`Refreshing sessions for ${sessionsState.userId}...`);
    await loadSessionsForModal(sessionsState.userId);
    setStatus(`Loaded ${sessionsState.sessions.length} sessions`);
  } catch (err) {
    setStatus(`Error: ${err.message}`);
  }
});

sessionsClose.addEventListener('click', () => {
  closeSessionsModal();
});

sessionsModal.addEventListener('click', (event) => {
  if (event.target === sessionsModal) {
    closeSessionsModal();
  }
});

(async () => {
  try {
    await loadConfig();
    await loadUsers();
  } catch (err) {
    setStatus(`Error: ${err.message}`);
    renderEmpty('Unable to load users.');
  }
})();
