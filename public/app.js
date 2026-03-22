const state = {
  from: '0',
  limit: 10,
  page: 1,
  nextToken: null,
  users: [],
  pageTokens: ['0']
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
const createForm = document.getElementById('createForm');
const createNote = document.getElementById('createNote');
const showDisabledToggle = document.getElementById('showDisabledToggle');
const showDisabledLabel = document.getElementById('showDisabledLabel');
const deactivateModal = document.getElementById('deactivateModal');
const deactivateTarget = document.getElementById('deactivateTarget');
const deactivateConfirm = document.getElementById('deactivateConfirm');
const deactivateConfirmBtn = document.getElementById('deactivateConfirmBtn');
const deactivateCancel = document.getElementById('deactivateCancel');
const reactivateModal = document.getElementById('reactivateModal');
const reactivateTarget = document.getElementById('reactivateTarget');
const reactivatePassword = document.getElementById('reactivatePassword');
const reactivateConfirm = document.getElementById('reactivateConfirm');
const reactivateConfirmBtn = document.getElementById('reactivateConfirmBtn');
const reactivateCancel = document.getElementById('reactivateCancel');
const renameModal = document.getElementById('renameModal');
const renameTarget = document.getElementById('renameTarget');
const renameDisplayName = document.getElementById('renameDisplayName');
const renameConfirm = document.getElementById('renameConfirm');
const renameConfirmBtn = document.getElementById('renameConfirmBtn');
const renameCancel = document.getElementById('renameCancel');
const passwordModal = document.getElementById('passwordModal');
const passwordTarget = document.getElementById('passwordTarget');
const passwordValue = document.getElementById('passwordValue');
const passwordConfirm = document.getElementById('passwordConfirm');
const passwordConfirmBtn = document.getElementById('passwordConfirmBtn');
const passwordCancel = document.getElementById('passwordCancel');
const adminModal = document.getElementById('adminModal');
const adminTarget = document.getElementById('adminTarget');
const adminToggle = document.getElementById('adminToggle');
const adminConfirm = document.getElementById('adminConfirm');
const adminConfirmBtn = document.getElementById('adminConfirmBtn');
const adminCancel = document.getElementById('adminCancel');
const adminStatusText = document.getElementById('adminStatusText');
const lockModal = document.getElementById('lockModal');
const lockTitle = document.getElementById('lockTitle');
const lockDescription = document.getElementById('lockDescription');
const lockTarget = document.getElementById('lockTarget');
const lockConfirm = document.getElementById('lockConfirm');
const lockConfirmBtn = document.getElementById('lockConfirmBtn');
const lockCancel = document.getElementById('lockCancel');
const infoModal = document.getElementById('infoModal');
const infoClose = document.getElementById('infoClose');
const infoMxid = document.getElementById('infoMxid');
const infoThreepid = document.getElementById('infoThreepid');
const infoEmail = document.getElementById('infoEmail');
const infoLastActive = document.getElementById('infoLastActive');
const infoDevices = document.getElementById('infoDevices');
const infoRooms = document.getElementById('infoRooms');

let pendingDeactivateUser = null;
let pendingReactivateUser = null;
let pendingRenameUser = null;
let pendingPasswordUser = null;
let pendingAdminUser = null;
let pendingAdminCurrent = false;
let pendingLockUser = null;
let pendingLockState = true;
let openMenuPanel = null;
let sortState = {
  key: 'user',
  dir: 'asc'
};

async function api(path, options = {}) {
  const config = {
    headers: {
      'Content-Type': 'application/json'
    },
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

function setStatus(message, tone = 'muted') {
  statusEl.textContent = message;
  statusEl.dataset.tone = tone;
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

  columns.forEach((col) => {
    const span = document.createElement('span');
    span.textContent = col.label;
    if (col.sortable) {
      span.classList.add('sortable');
      span.dataset.sortKey = col.key;
      span.dataset.sortDir = sortState.key === col.key ? sortState.dir : 'asc';
      span.dataset.sortActive = sortState.key === col.key ? 'true' : 'false';
    }
    header.appendChild(span);
  });
  usersTable.appendChild(header);
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
    userCell.className = 'user-cell';
    const avatar = buildAvatarElement(user);
    const userMeta = document.createElement('div');
    userMeta.className = 'user-meta';
    const displayName = document.createElement('div');
    displayName.className = 'display-name';
    displayName.textContent = user.displayname || 'No display name';
    const userId = document.createElement('div');
    userId.className = 'user-id';
    userId.textContent = user.name;
    userMeta.appendChild(displayName);
    userMeta.appendChild(userId);
    userCell.appendChild(avatar);
    userCell.appendChild(userMeta);

    const adminCell = document.createElement('div');
    adminCell.innerHTML = user.admin ? '<span class="badge">Admin</span>' : '<span class="badge muted">User</span>';

    const statusCell = document.createElement('div');
    if (user.deactivated) {
      statusCell.innerHTML = '<span class="badge muted">Deactivated</span>';
    } else if (user.locked) {
      statusCell.innerHTML = '<span class="badge warning">Locked</span>';
    } else {
      statusCell.innerHTML = '<span class="badge">Active</span>';
    }

    const actionCell = document.createElement('div');
    const actionRow = document.createElement('div');
    actionRow.className = 'action-row';

    const actionTop = document.createElement('div');
    actionTop.className = 'action-top';

    const infoButton = document.createElement('button');
    infoButton.className = 'info-btn';
    infoButton.type = 'button';
    infoButton.textContent = 'i';
    infoButton.setAttribute('aria-label', 'User info');
    infoButton.addEventListener('click', () => openInfoModal(user.name));

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
      const item = document.createElement('button');
      item.type = 'button';
      item.className = `menu-item${isDanger ? ' danger' : ''}`;
      item.textContent = label;
      item.addEventListener('click', () => {
        closeMenuPanel();
        onClick();
      });
      menuPanel.appendChild(item);
    };

    addMenuItem('Rename', () => openRenameModal(user));
    addMenuItem('Reset password', () => openPasswordModal(user));
    addMenuItem(user.admin ? 'Remove admin' : 'Make admin', () => openAdminModal(user));

    if (user.deactivated) {
      addMenuItem('Re-enable user', () => openReactivateModal(user.name));
    }

    addMenuItem('Review activity', () => {
      const url = `/user.html?user_id=${encodeURIComponent(user.name)}`;
      window.location.assign(url);
    });

    if (user.locked) {
      addMenuItem('Unlock user', () => openLockModal(user.name, false));
    } else {
      addMenuItem('Lock user', () => openLockModal(user.name, true), true);
    }

    if (!user.deactivated) {
      addMenuItem('Deactivate user', () => openDeactivateModal(user.name), true);
    }

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

    actionTop.appendChild(infoButton);
    actionTop.appendChild(menuWrapper);

    actionRow.appendChild(actionTop);
    actionCell.appendChild(actionRow);

    row.appendChild(userCell);
    row.appendChild(adminCell);
    row.appendChild(statusCell);
    row.appendChild(actionCell);
    usersTable.appendChild(row);
  });

  const headerRow = usersTable.querySelector('.table-row.header');
  if (headerRow) {
    headerRow.querySelectorAll('.sortable').forEach((span) => {
      span.addEventListener('click', () => {
        const key = span.dataset.sortKey;
        if (!key) return;
        if (sortState.key === key) {
          sortState.dir = sortState.dir === 'asc' ? 'desc' : 'asc';
        } else {
          sortState.key = key;
          sortState.dir = 'asc';
        }
        resetPaging();
        loadUsers();
      });
    });
  }
}

function getUserFallback(user) {
  const raw = (user.displayname || user.name || '').trim();
  if (!raw) return '?';
  const normalized = raw.startsWith('@') ? raw.slice(1) : raw;
  return normalized.charAt(0).toUpperCase();
}

function getAvatarSrc(user) {
  const avatarUrl = user?.avatar_url || '';
  if (!avatarUrl) return null;

  if (avatarUrl.startsWith('mxc://')) {
    return `/api/media/thumbnail?mxc=${encodeURIComponent(avatarUrl)}&width=48&height=48&method=crop`;
  }

  if (avatarUrl.startsWith('http://') || avatarUrl.startsWith('https://')) {
    return avatarUrl;
  }

  return null;
}

function buildAvatarElement(user) {
  const avatar = document.createElement('div');
  avatar.className = 'user-avatar';
  const fallback = getUserFallback(user);
  avatar.textContent = fallback;

  const src = getAvatarSrc(user);
  if (!src) {
    return avatar;
  }

  const image = document.createElement('img');
  image.alt = `${user.displayname || user.name || 'User'} avatar`;
  image.loading = 'lazy';
  image.decoding = 'async';
  image.referrerPolicy = 'no-referrer';

  image.addEventListener('load', () => {
    avatar.classList.add('has-image');
    avatar.textContent = '';
    avatar.appendChild(image);
  });

  image.addEventListener('error', () => {
    avatar.classList.remove('has-image');
  });

  image.src = src;

  return avatar;
}

async function loadConfig() {
  const config = await api('/api/config');
  const serverName = config.server_name || 'unknown';
  if (serverNameEl) {
    serverNameEl.textContent = serverName;
  }
  if (serverNameInlineEl) {
    serverNameInlineEl.textContent = serverName;
  }
  setStatus(`Connected to ${config.base_url}`);
}

async function loadUsers() {
  setStatus('Loading users…');
  renderEmpty('Loading users…');

  const showDisabled = showDisabledToggle?.dataset.state === 'on';
  const deactivatedParam = showDisabled ? 'true' : 'false';
  const orderBy = mapSortKey(sortState.key);
  const dir = sortState.dir === 'asc' ? 'f' : 'b';
  const data = await api(
    `/api/users?from=${encodeURIComponent(state.from)}&limit=${state.limit}&guests=false&deactivated=${deactivatedParam}&order_by=${orderBy}&dir=${dir}`
  );
  const users = data?.users || [];
  state.users = users;
  const visibleUsers = users;

  if (!visibleUsers.length) {
    renderEmpty('No users found.');
  } else {
    renderUsers(visibleUsers);
  }

  state.nextToken = data?.next_token ?? null;
  pageLabel.textContent = `Page ${state.page}`;
  prevBtn.disabled = state.page <= 1;
  nextBtn.disabled = !state.nextToken;
  setStatus(`Loaded ${visibleUsers.length} users`);
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

async function handleDeactivate(userId) {
  setStatus(`Deactivating ${userId}…`);
  await api(`/api/users/${encodeURIComponent(userId)}/deactivate`, {
    method: 'POST',
    body: { erase: false }
  });

  await loadUsers();
}

async function handleUserUpdate(userId, body) {
  await api(`/api/users/${encodeURIComponent(userId)}/update`, {
    method: 'POST',
    body
  });
}

function openDeactivateModal(userId) {
  pendingDeactivateUser = userId;
  deactivateTarget.textContent = `Target: ${userId}`;
  deactivateConfirm.value = '';
  deactivateConfirmBtn.disabled = true;
  deactivateModal.classList.remove('hidden');
  deactivateModal.setAttribute('aria-hidden', 'false');
  deactivateConfirm.focus();
}

function closeDeactivateModal() {
  deactivateModal.classList.add('hidden');
  deactivateModal.setAttribute('aria-hidden', 'true');
  pendingDeactivateUser = null;
  deactivateConfirm.value = '';
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
  const triggerRect = trigger.getBoundingClientRect();
  const panelRect = panel.getBoundingClientRect();

  let top = triggerRect.bottom + 6;
  if (top + panelRect.height > window.innerHeight - 8) {
    top = Math.max(8, triggerRect.top - panelRect.height - 6);
  }

  let left = triggerRect.right - panelRect.width;
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

deactivateConfirm.addEventListener('input', (event) => {
  const input = event.target.value.trim();
  deactivateConfirmBtn.disabled = input !== pendingDeactivateUser;
});

deactivateCancel.addEventListener('click', () => {
  closeDeactivateModal();
});

deactivateConfirmBtn.addEventListener('click', async () => {
  if (!pendingDeactivateUser) return;
  try {
    deactivateConfirmBtn.disabled = true;
    await handleDeactivate(pendingDeactivateUser);
  } catch (err) {
    setStatus(`Error: ${err.message}`);
  } finally {
    closeDeactivateModal();
  }
});

function openReactivateModal(userId) {
  pendingReactivateUser = userId;
  reactivateTarget.textContent = `Target: ${userId}`;
  reactivateConfirm.value = '';
  reactivatePassword.value = '';
  reactivateConfirmBtn.disabled = true;
  reactivateModal.classList.remove('hidden');
  reactivateModal.setAttribute('aria-hidden', 'false');
  reactivatePassword.focus();
}

function closeReactivateModal() {
  reactivateModal.classList.add('hidden');
  reactivateModal.setAttribute('aria-hidden', 'true');
  pendingReactivateUser = null;
  reactivateConfirm.value = '';
  reactivatePassword.value = '';
}

reactivateConfirm.addEventListener('input', (event) => {
  const input = event.target.value.trim();
  reactivateConfirmBtn.disabled = input !== pendingReactivateUser;
});

reactivateCancel.addEventListener('click', () => {
  closeReactivateModal();
});

reactivateConfirmBtn.addEventListener('click', async () => {
  if (!pendingReactivateUser) return;
  try {
    reactivateConfirmBtn.disabled = true;
    setStatus(`Re-enabling ${pendingReactivateUser}…`);
    await api(`/api/users/${encodeURIComponent(pendingReactivateUser)}/reactivate`, {
      method: 'POST',
      body: {
        password: reactivatePassword.value || undefined
      }
    });
    await loadUsers();
  } catch (err) {
    setStatus(`Error: ${err.message}`);
  } finally {
    closeReactivateModal();
  }
});

function openRenameModal(user) {
  pendingRenameUser = user.name;
  renameTarget.textContent = `Target: ${user.name}`;
  renameDisplayName.value = user.displayname || '';
  renameConfirm.value = '';
  renameConfirmBtn.disabled = true;
  renameModal.classList.remove('hidden');
  renameModal.setAttribute('aria-hidden', 'false');
  renameDisplayName.focus();
}

function closeRenameModal() {
  renameModal.classList.add('hidden');
  renameModal.setAttribute('aria-hidden', 'true');
  pendingRenameUser = null;
  renameDisplayName.value = '';
  renameConfirm.value = '';
}

renameConfirm.addEventListener('input', () => {
  const input = renameConfirm.value.trim();
  const nameValue = renameDisplayName.value.trim();
  renameConfirmBtn.disabled = input !== pendingRenameUser || !nameValue;
});

renameDisplayName.addEventListener('input', () => {
  const input = renameConfirm.value.trim();
  const nameValue = renameDisplayName.value.trim();
  renameConfirmBtn.disabled = input !== pendingRenameUser || !nameValue;
});

renameCancel.addEventListener('click', () => {
  closeRenameModal();
});

renameConfirmBtn.addEventListener('click', async () => {
  if (!pendingRenameUser) return;
  try {
    renameConfirmBtn.disabled = true;
    setStatus(`Renaming ${pendingRenameUser}…`);
    await handleUserUpdate(pendingRenameUser, { displayname: renameDisplayName.value.trim() });
    await loadUsers();
  } catch (err) {
    setStatus(`Error: ${err.message}`);
  } finally {
    closeRenameModal();
  }
});

function openPasswordModal(user) {
  pendingPasswordUser = user.name;
  passwordTarget.textContent = `Target: ${user.name}`;
  passwordValue.value = '';
  passwordConfirm.value = '';
  passwordConfirmBtn.disabled = true;
  passwordModal.classList.remove('hidden');
  passwordModal.setAttribute('aria-hidden', 'false');
  passwordValue.focus();
}

function closePasswordModal() {
  passwordModal.classList.add('hidden');
  passwordModal.setAttribute('aria-hidden', 'true');
  pendingPasswordUser = null;
  passwordValue.value = '';
  passwordConfirm.value = '';
}

passwordConfirm.addEventListener('input', () => {
  const input = passwordConfirm.value.trim();
  const pwd = passwordValue.value.trim();
  passwordConfirmBtn.disabled = input !== pendingPasswordUser || !pwd;
});

passwordValue.addEventListener('input', () => {
  const input = passwordConfirm.value.trim();
  const pwd = passwordValue.value.trim();
  passwordConfirmBtn.disabled = input !== pendingPasswordUser || !pwd;
});

passwordCancel.addEventListener('click', () => {
  closePasswordModal();
});

passwordConfirmBtn.addEventListener('click', async () => {
  if (!pendingPasswordUser) return;
  try {
    passwordConfirmBtn.disabled = true;
    setStatus(`Resetting password for ${pendingPasswordUser}…`);
    await handleUserUpdate(pendingPasswordUser, { password: passwordValue.value });
    await loadUsers();
  } catch (err) {
    setStatus(`Error: ${err.message}`);
  } finally {
    closePasswordModal();
  }
});

function openAdminModal(user) {
  pendingAdminUser = user.name;
  pendingAdminCurrent = Boolean(user.admin);
  adminToggle.checked = pendingAdminCurrent;
  adminTarget.textContent = `Target: ${user.name}`;
  adminStatusText.textContent = `Current role: ${pendingAdminCurrent ? 'Admin' : 'User'}.`;
  adminConfirm.value = '';
  adminConfirmBtn.disabled = true;
  adminModal.classList.remove('hidden');
  adminModal.setAttribute('aria-hidden', 'false');
  adminToggle.focus();
}

function closeAdminModal() {
  adminModal.classList.add('hidden');
  adminModal.setAttribute('aria-hidden', 'true');
  pendingAdminUser = null;
  pendingAdminCurrent = false;
  adminConfirm.value = '';
}

function updateAdminConfirmState() {
  const matches = adminConfirm.value.trim() === pendingAdminUser;
  const changed = adminToggle.checked !== pendingAdminCurrent;
  adminConfirmBtn.disabled = !matches || !changed;
}

adminConfirm.addEventListener('input', updateAdminConfirmState);
adminToggle.addEventListener('change', updateAdminConfirmState);

adminCancel.addEventListener('click', () => {
  closeAdminModal();
});

adminConfirmBtn.addEventListener('click', async () => {
  if (!pendingAdminUser) return;
  try {
    adminConfirmBtn.disabled = true;
    setStatus(`Updating admin status for ${pendingAdminUser}…`);
    await handleUserUpdate(pendingAdminUser, { admin: adminToggle.checked });
    await loadUsers();
  } catch (err) {
    setStatus(`Error: ${err.message}`);
  } finally {
    closeAdminModal();
  }
});

function openLockModal(userId, shouldLock) {
  pendingLockUser = userId;
  pendingLockState = shouldLock;
  lockTitle.textContent = shouldLock ? 'Lock this user?' : 'Unlock this user?';
  lockDescription.textContent = shouldLock
    ? 'Locking prevents new logins without deactivating the account or removing room membership.'
    : 'Unlocking restores login access without changing passwords or room membership.';
  lockTarget.textContent = `Target: ${userId}`;
  lockConfirm.value = '';
  lockConfirmBtn.disabled = true;
  lockConfirmBtn.textContent = shouldLock ? 'Lock user' : 'Unlock user';
  lockModal.classList.remove('hidden');
  lockModal.setAttribute('aria-hidden', 'false');
  lockConfirm.focus();
}

function closeLockModal() {
  lockModal.classList.add('hidden');
  lockModal.setAttribute('aria-hidden', 'true');
  pendingLockUser = null;
  lockConfirm.value = '';
}

lockConfirm.addEventListener('input', () => {
  const input = lockConfirm.value.trim();
  lockConfirmBtn.disabled = input !== pendingLockUser;
});

lockCancel.addEventListener('click', () => {
  closeLockModal();
});

lockConfirmBtn.addEventListener('click', async () => {
  if (!pendingLockUser) return;
  try {
    lockConfirmBtn.disabled = true;
    setStatus(`${pendingLockState ? 'Locking' : 'Unlocking'} ${pendingLockUser}…`);
    await handleUserUpdate(pendingLockUser, { locked: pendingLockState });
    await loadUsers();
  } catch (err) {
    setStatus(`Error: ${err.message}`);
  } finally {
    closeLockModal();
  }
});

function formatShortDate(ts) {
  if (!ts) return 'Unknown';
  const ms = ts > 1e12 ? ts : ts * 1000;
  return new Date(ms).toLocaleDateString();
}

function openInfoModal(userId) {
  infoModal.classList.remove('hidden');
  infoModal.setAttribute('aria-hidden', 'false');
  infoMxid.textContent = userId;
  infoThreepid.textContent = 'Loading…';
  infoEmail.textContent = 'Loading…';
  infoLastActive.textContent = 'Loading…';
  infoDevices.textContent = 'Loading…';
  infoRooms.textContent = 'Loading…';

  api(`/api/users/${encodeURIComponent(userId)}/info`)
    .then((data) => {
      infoMxid.textContent = data?.mxid || userId;
      const threepids = Array.isArray(data?.threepids) ? data.threepids : [];
      if (threepids.length) {
        infoThreepid.textContent = threepids.map((pid) => `${pid.medium}:${pid.address}`).join(', ');
      } else {
        infoThreepid.textContent = 'None';
      }
      infoEmail.textContent = data?.signup_email || 'None';
      infoLastActive.textContent = formatShortDate(data?.last_active);
      infoDevices.textContent = String(data?.devices_count ?? 0);
      infoRooms.textContent = String(data?.rooms_count ?? 0);
    })
    .catch((err) => {
      infoThreepid.textContent = 'Unable to load';
      infoEmail.textContent = 'Unable to load';
      infoLastActive.textContent = 'Unable to load';
      infoDevices.textContent = 'Unable to load';
      infoRooms.textContent = 'Unable to load';
      setStatus(`Error: ${err.message}`);
    });
}

infoClose.addEventListener('click', () => {
  infoModal.classList.add('hidden');
  infoModal.setAttribute('aria-hidden', 'true');
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

createForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  createNote.textContent = '';

  const localpart = document.getElementById('localpart').value.trim();
  const password = document.getElementById('password').value;
  const displayname = document.getElementById('displayname').value.trim();
  const admin = document.getElementById('isAdmin').checked;

  if (!localpart) {
    createNote.textContent = 'Localpart is required.';
    return;
  }

  try {
    await api('/api/users', {
      method: 'POST',
      body: {
        localpart,
        password: password || undefined,
        admin,
        displayname: displayname || undefined
      }
    });

    createNote.textContent = `Created @${localpart}.`;
    createForm.reset();
    await loadUsers();
  } catch (err) {
    createNote.textContent = err.message;
  }
});

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
  if (showDisabledLabel) {
    showDisabledLabel.textContent = isOn ? 'Hide disabled users' : 'Show disabled users';
  }
  resetPaging();
  await loadUsers();
});

(async () => {
  try {
    await loadConfig();
    await loadUsers();
  } catch (err) {
    setStatus(`Error: ${err.message}`);
    renderEmpty('Unable to load users. Check server logs.');
  }
})();
