const mediaStatus = document.getElementById('mediaStatus');
const serverNameEl = document.getElementById('serverName');
const mediaView = document.body?.dataset?.mediaView || 'storage';

const storageTable = document.getElementById('storageTable');
const storagePrev = document.getElementById('storagePrev');
const storageNext = document.getElementById('storageNext');
const storagePageLabel = document.getElementById('storagePageLabel');
const storageRefresh = document.getElementById('storageRefresh');
const storageSearch = document.getElementById('storageSearch');
const storageTimeRange = document.getElementById('storageTimeRange');
const storagePageSize = document.getElementById('storagePageSize');
const storageKpiUsers = document.getElementById('storageKpiUsers');
const storageKpiLoaded = document.getElementById('storageKpiLoaded');
const storageKpiMediaCount = document.getElementById('storageKpiMediaCount');
const storageKpiMediaBytes = document.getElementById('storageKpiMediaBytes');

const userMediaSubtitle = document.getElementById('userMediaSubtitle');
const userMediaTable = document.getElementById('userMediaTable');
const userMediaPrev = document.getElementById('userMediaPrev');
const userMediaNext = document.getElementById('userMediaNext');
const userMediaPageLabel = document.getElementById('userMediaPageLabel');
const userMediaRefresh = document.getElementById('userMediaRefresh');
const userMediaSearch = document.getElementById('userMediaSearch');
const userMediaSort = document.getElementById('userMediaSort');
const userMediaDir = document.getElementById('userMediaDir');
const userMediaPageSize = document.getElementById('userMediaPageSize');

const roomMediaSubtitle = document.getElementById('roomMediaSubtitle');
const roomMediaTable = document.getElementById('roomMediaTable');
const roomMediaPrev = document.getElementById('roomMediaPrev');
const roomMediaNext = document.getElementById('roomMediaNext');
const roomMediaPageLabel = document.getElementById('roomMediaPageLabel');
const roomMediaRoomId = document.getElementById('roomMediaRoomId');
const roomMediaSource = document.getElementById('roomMediaSource');
const roomMediaSearch = document.getElementById('roomMediaSearch');
const roomMediaPageSize = document.getElementById('roomMediaPageSize');
const roomMediaLoad = document.getElementById('roomMediaLoad');

const reportTable = document.getElementById('reportTable');
const reportPrev = document.getElementById('reportPrev');
const reportNext = document.getElementById('reportNext');
const reportPageLabel = document.getElementById('reportPageLabel');
const reportRefresh = document.getElementById('reportRefresh');
const reportSearch = document.getElementById('reportSearch');
const reportRoomFilter = document.getElementById('reportRoomFilter');
const reportUserFilter = document.getElementById('reportUserFilter');
const reportSenderFilter = document.getElementById('reportSenderFilter');
const reportPageSize = document.getElementById('reportPageSize');

const mediaPreviewModal = document.getElementById('mediaPreviewModal');
const mediaPreviewTitle = document.getElementById('mediaPreviewTitle');
const mediaPreviewSubtitle = document.getElementById('mediaPreviewSubtitle');
const mediaPreviewShell = document.getElementById('mediaPreviewShell');
const mediaPreviewInfo = document.getElementById('mediaPreviewInfo');
const mediaPreviewQuarantineBtn = document.getElementById('mediaPreviewQuarantineBtn');
const mediaPreviewDeleteBtn = document.getElementById('mediaPreviewDeleteBtn');
const mediaPreviewClose = document.getElementById('mediaPreviewClose');

const reportModal = document.getElementById('reportModal');
const reportModalTitle = document.getElementById('reportModalTitle');
const reportModalInfo = document.getElementById('reportModalInfo');
const reportModalJson = document.getElementById('reportModalJson');
const reportModalResolveBtn = document.getElementById('reportModalResolveBtn');
const reportModalLockBtn = document.getElementById('reportModalLockBtn');
const reportModalClose = document.getElementById('reportModalClose');

const storageState = { from: '0', limit: 25, page: 1, nextToken: null, pageTokens: ['0'], query: '', timeRange: 'all', sortKey: 'media_length', sortDir: 'desc', rows: [], total: 0 };
const userMediaState = { userId: '', userDisplayName: '', from: '0', limit: 25, page: 1, nextToken: null, pageTokens: ['0'], query: '', orderBy: 'created_ts', dir: 'b', rows: [] };
const roomMediaState = { roomId: '', from: '0', limit: 25, page: 1, nextToken: null, pageTokens: ['0'], source: 'all', query: '', rows: [], localCount: 0, remoteCount: 0, total: 0 };
const reportState = { from: '0', limit: 25, page: 1, nextToken: null, pageTokens: ['0'], query: '', roomId: '', reporter: '', sender: '', rows: [] };
const previewState = { item: null };
const reportModalState = { report: null };
const searchTimers = {};

async function api(path, options = {}) {
  const config = { headers: { 'Content-Type': 'application/json' }, ...options };
  if (options.body && typeof options.body !== 'string') config.body = JSON.stringify(options.body);
  const response = await fetch(path, config);
  const text = await response.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = { raw: text }; } }
  if (!response.ok) throw new Error(data?.error || data?.details?.error || `Request failed (${response.status})`);
  return data;
}

function setStatus(message) { mediaStatus.textContent = message; }
function resetPager(state) { state.from = '0'; state.page = 1; state.nextToken = null; state.pageTokens = ['0']; }
function setPager(state, prev, next, label) { label.textContent = `Page ${state.page}`; prev.disabled = state.page <= 1; next.disabled = !state.nextToken; }

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value; let index = 0;
  while (size >= 1024 && index < units.length - 1) { size /= 1024; index += 1; }
  return `${size.toFixed(size >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatDateTime(ts) {
  if (!ts) return 'Unknown';
  const ms = Number(ts) > 1e12 ? Number(ts) : Number(ts) * 1000;
  if (!Number.isFinite(ms) || ms <= 0) return 'Unknown';
  return new Date(ms).toLocaleString();
}

function toFromTs(range) {
  const now = Date.now();
  if (range === '24h') return now - 24 * 60 * 60 * 1000;
  if (range === '7d') return now - 7 * 24 * 60 * 60 * 1000;
  if (range === '30d') return now - 30 * 24 * 60 * 60 * 1000;
  return null;
}

function buildHeader(container, columns, onSort) {
  container.innerHTML = '';
  const header = document.createElement('div');
  header.className = 'table-row header';
  for (const col of columns) {
    const span = document.createElement('span');
    span.textContent = col.label;
    if (col.sortable) {
      span.classList.add('sortable');
      span.dataset.sortKey = col.key;
      span.dataset.sortDir = col.dir || 'asc';
      span.dataset.sortActive = col.active ? 'true' : 'false';
    }
    header.appendChild(span);
  }
  container.appendChild(header);
  if (onSort) {
    header.querySelectorAll('.sortable').forEach((item) => item.addEventListener('click', () => onSort(item.dataset.sortKey)));
  }
}

function renderEmpty(container, message) { container.innerHTML = `<div class="table-row"><span>${message}</span></div>`; }

function createBadge(label, mode = 'default') {
  const el = document.createElement('span');
  el.className = 'badge';
  if (mode === 'muted') el.classList.add('muted');
  if (mode === 'warning') el.classList.add('warning');
  if (mode === 'danger') el.classList.add('danger');
  el.textContent = label;
  return el;
}

function mapStorageSortOrder(key) { return key === 'user' ? 'displayname' : key; }
function getStorageSortDir() { return storageState.sortDir === 'desc' ? 'b' : 'f'; }

function buildUserMediaUrl(userId, displayName = '') {
  const params = new URLSearchParams();
  params.set('user_id', userId);
  if (displayName) params.set('label', displayName);
  return `/media-users.html?${params.toString()}`;
}

async function loadStorageDashboard() {
  setStatus('Loading storage dashboard...');
  renderEmpty(storageTable, 'Loading...');
  const params = new URLSearchParams({ from: storageState.from, limit: String(storageState.limit), order_by: mapStorageSortOrder(storageState.sortKey), dir: getStorageSortDir() });
  if (storageState.query) params.set('search_term', storageState.query);
  const fromTs = toFromTs(storageState.timeRange); if (fromTs) params.set('from_ts', String(fromTs));
  const data = await api(`/api/media/storage/users?${params.toString()}`);
  storageState.rows = Array.isArray(data?.users) ? data.users : [];
  storageState.total = Number(data?.total || storageState.rows.length);
  storageState.nextToken = data?.next_token ?? null;
  renderStorageTable();
  setPager(storageState, storagePrev, storageNext, storagePageLabel);
  const summary = data?.page_summary || {};
  storageKpiUsers.textContent = String(storageState.total);
  storageKpiLoaded.textContent = String(storageState.rows.length);
  storageKpiMediaCount.textContent = String(Number(summary.media_count || 0));
  storageKpiMediaBytes.textContent = formatBytes(summary.media_length || 0);
  setStatus(`Loaded ${storageState.rows.length} storage rows (${storageState.total} matched)`);
}

function renderStorageTable() {
  buildHeader(storageTable, [
    { label: 'User', key: 'user', sortable: true, active: storageState.sortKey === 'user', dir: storageState.sortDir },
    { label: 'Media items', key: 'media_count', sortable: true, active: storageState.sortKey === 'media_count', dir: storageState.sortDir },
    { label: 'Storage', key: 'media_length', sortable: true, active: storageState.sortKey === 'media_length', dir: storageState.sortDir },
    { label: 'Action' }
  ], (key) => {
    if (storageState.sortKey === key) storageState.sortDir = storageState.sortDir === 'asc' ? 'desc' : 'asc';
    else { storageState.sortKey = key; storageState.sortDir = key === 'user' ? 'asc' : 'desc'; }
    resetPager(storageState);
    loadStorageDashboard().catch((err) => setStatus(`Error: ${err.message}`));
  });

  if (!storageState.rows.length) { renderEmpty(storageTable, 'No storage records found.'); return; }
  for (const row of storageState.rows) {
    const tr = document.createElement('div'); tr.className = 'table-row';
    const userCell = document.createElement('div'); userCell.className = 'user-meta';
    const name = document.createElement('div'); name.className = 'display-name'; name.textContent = row.displayname || row.user_id || 'Unknown user';
    const mxid = document.createElement('div'); mxid.className = 'user-id'; mxid.textContent = row.user_id || 'Unknown user';
    userCell.appendChild(name); userCell.appendChild(mxid);

    const count = document.createElement('div'); count.className = 'room-metric'; count.textContent = String(Number(row.media_count || 0));
    const size = document.createElement('div'); size.className = 'room-metric'; size.textContent = formatBytes(row.media_length || 0);

    const action = document.createElement('div');
    const browse = document.createElement('button'); browse.type = 'button'; browse.className = 'btn ghost'; browse.textContent = 'Browse media';
    browse.addEventListener('click', () => selectUserMediaTarget(row.user_id, row.displayname || row.user_id, true));
    action.appendChild(browse);

    tr.appendChild(userCell); tr.appendChild(count); tr.appendChild(size); tr.appendChild(action);
    storageTable.appendChild(tr);
  }
}
function selectUserMediaTarget(userId, displayName = '', scroll = false) {
  if (!userId) return;

  if (mediaView !== 'users') {
    window.location.assign(buildUserMediaUrl(userId, displayName));
    return;
  }

  userMediaState.userId = userId || '';
  userMediaState.userDisplayName = displayName || userId || '';
  resetPager(userMediaState);
  userMediaSubtitle.textContent = userMediaState.userId
    ? `Showing uploaded media for ${userMediaState.userDisplayName} (${userMediaState.userId}).`
    : 'Select a user from storage dashboard to inspect uploads.';
  loadUserMedia().catch((err) => setStatus(`Error: ${err.message}`));
  if (scroll) document.getElementById('userMediaSection')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function loadUserMedia() {
  if (!userMediaState.userId) {
    renderEmpty(userMediaTable, 'Select a user in the storage dashboard first.');
    setPager(userMediaState, userMediaPrev, userMediaNext, userMediaPageLabel);
    return;
  }

  setStatus(`Loading media for ${userMediaState.userId}...`);
  renderEmpty(userMediaTable, 'Loading user media...');

  const params = new URLSearchParams({
    from: userMediaState.from,
    limit: String(userMediaState.limit),
    order_by: userMediaState.orderBy,
    dir: userMediaState.dir
  });
  if (userMediaState.query) params.set('q', userMediaState.query);

  const data = await api(`/api/media/users/${encodeURIComponent(userMediaState.userId)}/media?${params.toString()}`);
  userMediaState.rows = Array.isArray(data?.media) ? data.media : [];
  userMediaState.nextToken = data?.next_token ?? null;
  renderUserMediaTable();
  setPager(userMediaState, userMediaPrev, userMediaNext, userMediaPageLabel);
  setStatus(`Loaded ${userMediaState.rows.length} media items for ${userMediaState.userId}`);
}

function buildMediaActionCell(item) {
  const actionCell = document.createElement('div');
  actionCell.className = 'media-action-group';

  const previewBtn = document.createElement('button');
  previewBtn.type = 'button';
  previewBtn.className = 'btn ghost';
  previewBtn.textContent = 'Preview';
  previewBtn.addEventListener('click', () => openMediaPreview(item));

  const quarantineBtn = document.createElement('button');
  quarantineBtn.type = 'button';
  quarantineBtn.className = `btn ghost${item.quarantined_by ? '' : ' danger-outline'}`;
  quarantineBtn.textContent = item.quarantined_by ? 'Unquarantine' : 'Quarantine';
  quarantineBtn.addEventListener('click', async () => {
    await toggleMediaQuarantine(item);
  });

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'btn ghost danger-outline';
  deleteBtn.textContent = 'Delete';
  deleteBtn.disabled = !item.is_local;
  deleteBtn.addEventListener('click', async () => {
    await deleteMediaItem(item);
  });

  actionCell.appendChild(previewBtn);
  actionCell.appendChild(quarantineBtn);
  actionCell.appendChild(deleteBtn);
  return actionCell;
}

function renderUserMediaTable() {
  buildHeader(userMediaTable, [
    { label: 'Media' },
    { label: 'Type' },
    { label: 'Size' },
    { label: 'Created' },
    { label: 'Status' },
    { label: 'Action' }
  ]);
  if (!userMediaState.rows.length) {
    renderEmpty(userMediaTable, 'No media files found for this user.');
    return;
  }

  for (const item of userMediaState.rows) {
    const tr = document.createElement('div');
    tr.className = 'table-row';
    if (item.quarantined_by) tr.classList.add('disabled');

    const mediaCell = document.createElement('div');
    mediaCell.className = 'room-meta';
    const title = document.createElement('div');
    title.className = 'display-name';
    title.textContent = item.upload_name || item.media_id || 'Unnamed upload';
    const meta = document.createElement('div');
    meta.className = 'room-id';
    meta.textContent = item.mxc || item.media_id || 'Unknown media ID';
    mediaCell.appendChild(title);
    mediaCell.appendChild(meta);

    const typeCell = document.createElement('div'); typeCell.className = 'room-metric'; typeCell.textContent = item.media_type || 'Unknown';
    const sizeCell = document.createElement('div'); sizeCell.className = 'room-metric'; sizeCell.textContent = formatBytes(item.media_length || 0);
    const createdCell = document.createElement('div'); createdCell.className = 'room-metric'; createdCell.textContent = formatDateTime(item.created_ts);
    const statusCell = document.createElement('div');
    statusCell.appendChild(item.quarantined_by ? createBadge('Quarantined', 'danger') : createBadge('Available', 'muted'));

    tr.appendChild(mediaCell);
    tr.appendChild(typeCell);
    tr.appendChild(sizeCell);
    tr.appendChild(createdCell);
    tr.appendChild(statusCell);
    tr.appendChild(buildMediaActionCell(item));
    userMediaTable.appendChild(tr);
  }
}

async function loadRoomInventory() {
  if (!roomMediaState.roomId) {
    renderEmpty(roomMediaTable, 'Enter a room ID and load inventory.');
    setPager(roomMediaState, roomMediaPrev, roomMediaNext, roomMediaPageLabel);
    return;
  }

  setStatus(`Loading room media inventory for ${roomMediaState.roomId}...`);
  renderEmpty(roomMediaTable, 'Loading room inventory...');

  const params = new URLSearchParams({
    from: roomMediaState.from,
    limit: String(roomMediaState.limit),
    source: roomMediaState.source,
    include_details: 'true'
  });
  if (roomMediaState.query) params.set('q', roomMediaState.query);

  const data = await api(`/api/media/rooms/${encodeURIComponent(roomMediaState.roomId)}/inventory?${params.toString()}`);
  roomMediaState.rows = Array.isArray(data?.media) ? data.media : [];
  roomMediaState.localCount = Number(data?.local_count || 0);
  roomMediaState.remoteCount = Number(data?.remote_count || 0);
  roomMediaState.total = Number(data?.total || roomMediaState.rows.length);
  roomMediaState.nextToken = data?.next_token ?? null;

  renderRoomMediaTable();
  setPager(roomMediaState, roomMediaPrev, roomMediaNext, roomMediaPageLabel);
  roomMediaSubtitle.textContent = `Inventory for ${roomMediaState.roomId} (local: ${roomMediaState.localCount}, remote: ${roomMediaState.remoteCount}, matched: ${roomMediaState.total}).`;
  setStatus(`Loaded ${roomMediaState.rows.length} room media items`);
}

function renderRoomMediaTable() {
  buildHeader(roomMediaTable, [
    { label: 'Media' },
    { label: 'Type' },
    { label: 'Size' },
    { label: 'Created' },
    { label: 'Status' },
    { label: 'Action' }
  ]);
  if (!roomMediaState.rows.length) {
    renderEmpty(roomMediaTable, 'No media inventory records found.');
    return;
  }

  for (const item of roomMediaState.rows) {
    const tr = document.createElement('div');
    tr.className = 'table-row';
    if (item.quarantined_by) tr.classList.add('disabled');

    const mediaCell = document.createElement('div'); mediaCell.className = 'room-meta';
    const title = document.createElement('div'); title.className = 'display-name';
    title.textContent = item.upload_name || item.media_id || 'Media item';
    const meta = document.createElement('div'); meta.className = 'room-id';
    meta.textContent = `${item.mxc || item.media_id || 'unknown'}${item.origin ? `  (${item.origin})` : ''}`;
    mediaCell.appendChild(title); mediaCell.appendChild(meta);

    const typeCell = document.createElement('div'); typeCell.className = 'room-metric'; typeCell.textContent = item.media_type || (item.metadata_available === false ? 'Unknown' : 'Pending');
    const sizeCell = document.createElement('div'); sizeCell.className = 'room-metric'; sizeCell.textContent = item.media_length ? formatBytes(item.media_length) : 'Unknown';
    const createdCell = document.createElement('div'); createdCell.className = 'room-metric'; createdCell.textContent = formatDateTime(item.created_ts);

    const statusCell = document.createElement('div');
    if (item.quarantined_by) statusCell.appendChild(createBadge('Quarantined', 'danger'));
    else if (item.is_local) statusCell.appendChild(createBadge('Local', 'muted'));
    else statusCell.appendChild(createBadge('Remote', 'warning'));

    tr.appendChild(mediaCell);
    tr.appendChild(typeCell);
    tr.appendChild(sizeCell);
    tr.appendChild(createdCell);
    tr.appendChild(statusCell);
    tr.appendChild(buildMediaActionCell(item));
    roomMediaTable.appendChild(tr);
  }
}

async function toggleMediaQuarantine(item) {
  if (!item?.mxc) return;
  const isQuarantined = Boolean(item.quarantined_by);
  const actionLabel = isQuarantined ? 'unquarantine' : 'quarantine';
  if (!window.confirm(`${isQuarantined ? 'Unquarantine' : 'Quarantine'} media item ${item.mxc}?`)) return;
  setStatus(`${isQuarantined ? 'Unquarantining' : 'Quarantining'} ${item.mxc}...`);
  await api(`/api/media/item/${actionLabel}`, { method: 'POST', body: { mxc: item.mxc } });
  await refreshMediaSections();
  if (previewState.item?.mxc === item.mxc) await refreshPreviewItem();
  setStatus(`${isQuarantined ? 'Unquarantined' : 'Quarantined'} ${item.mxc}`);
}

async function deleteMediaItem(item) {
  if (!item?.mxc) return;
  if (!item.is_local) {
    setStatus('Only local media can be deleted.');
    return;
  }
  if (!window.confirm(`Delete local media ${item.mxc}? This cannot be undone.`)) return;
  setStatus(`Deleting media ${item.mxc}...`);
  await api('/api/media/item/delete', { method: 'POST', body: { mxc: item.mxc } });
  if (previewState.item?.mxc === item.mxc) closeMediaPreviewModal();
  await refreshMediaSections();
  setStatus(`Deleted ${item.mxc}`);
}
function closeMediaPreviewModal() {
  mediaPreviewModal.classList.add('hidden');
  mediaPreviewModal.setAttribute('aria-hidden', 'true');
  previewState.item = null;
}

function renderPreviewContent(item) {
  mediaPreviewShell.innerHTML = '';
  const mediaType = String(item?.media_type || '').toLowerCase();
  const src = item?.download_url;
  if (!src) {
    const fallback = document.createElement('div');
    fallback.className = 'details-empty';
    fallback.textContent = 'No preview URL available.';
    mediaPreviewShell.appendChild(fallback);
    return;
  }
  if (mediaType.startsWith('image/')) {
    const img = document.createElement('img');
    img.className = 'avatar-preview-image';
    img.src = src;
    img.alt = item.upload_name || item.media_id || 'Media preview';
    mediaPreviewShell.appendChild(img);
    return;
  }
  if (mediaType.startsWith('video/')) {
    const video = document.createElement('video');
    video.className = 'media-preview-video';
    video.controls = true;
    video.src = src;
    mediaPreviewShell.appendChild(video);
    return;
  }
  if (mediaType.startsWith('audio/')) {
    const audio = document.createElement('audio');
    audio.className = 'media-preview-audio';
    audio.controls = true;
    audio.src = src;
    mediaPreviewShell.appendChild(audio);
    return;
  }
  const link = document.createElement('a');
  link.className = 'btn ghost';
  link.href = src;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = 'Open download';
  mediaPreviewShell.appendChild(link);
}

function renderPreviewInfo(item) {
  mediaPreviewInfo.innerHTML = '';
  const fields = [
    ['MXC', item?.mxc || 'Unknown'],
    ['Media ID', item?.media_id || 'Unknown'],
    ['Origin', item?.origin || 'Unknown'],
    ['Type', item?.media_type || 'Unknown'],
    ['Size', formatBytes(item?.media_length || 0)],
    ['Created', formatDateTime(item?.created_ts)],
    ['Last access', formatDateTime(item?.last_access_ts)],
    ['Status', item?.quarantined_by ? `Quarantined by ${item.quarantined_by}` : 'Available']
  ];

  for (const [labelText, valueText] of fields) {
    const line = document.createElement('div');
    line.className = 'info-item';
    const label = document.createElement('span');
    const value = document.createElement('strong');
    label.textContent = labelText;
    value.textContent = valueText;
    line.appendChild(label);
    line.appendChild(value);
    mediaPreviewInfo.appendChild(line);
  }

  mediaPreviewQuarantineBtn.textContent = item?.quarantined_by ? 'Unquarantine' : 'Quarantine';
  mediaPreviewDeleteBtn.disabled = !item?.is_local;
}

async function refreshPreviewItem() {
  if (!previewState.item?.mxc) return;
  const data = await api(`/api/media/item?mxc=${encodeURIComponent(previewState.item.mxc)}`);
  previewState.item = data?.item || previewState.item;
  renderPreviewContent(previewState.item);
  renderPreviewInfo(previewState.item);
}

function openMediaPreview(item) {
  previewState.item = { ...item };
  mediaPreviewTitle.textContent = item.upload_name || item.media_id || 'Media preview';
  mediaPreviewSubtitle.textContent = item.mxc || '';
  renderPreviewContent(item);
  renderPreviewInfo(item);
  mediaPreviewModal.classList.remove('hidden');
  mediaPreviewModal.setAttribute('aria-hidden', 'false');
  if (!item.media_type || !item.media_length || !item.created_ts) {
    refreshPreviewItem().catch(() => {});
  }
}

function closeReportModal() {
  reportModal.classList.add('hidden');
  reportModal.setAttribute('aria-hidden', 'true');
  reportModalState.report = null;
}

function renderReportModal(report) {
  reportModalTitle.textContent = `Report #${report.report_id}`;
  reportModalInfo.innerHTML = '';
  const fields = [
    ['Received', formatDateTime(report.received_ts)],
    ['Room', report.room_id || 'Unknown'],
    ['Event', report.event_id || 'Unknown'],
    ['Reporter', report.user_id || 'Unknown'],
    ['Sender', report.sender || 'Unknown'],
    ['Score', String(report.score ?? 'n/a')],
    ['Reason', report.reason || 'No reason provided']
  ];

  for (const [labelText, valueText] of fields) {
    const line = document.createElement('div');
    line.className = 'info-item';
    const label = document.createElement('span');
    const value = document.createElement('strong');
    label.textContent = labelText;
    value.textContent = valueText;
    line.appendChild(label);
    line.appendChild(value);
    reportModalInfo.appendChild(line);
  }

  reportModalJson.textContent = JSON.stringify(report?.event_json || report?.event || report || {}, null, 2);
  reportModalResolveBtn.disabled = !report?.report_id;
  reportModalLockBtn.disabled = !report?.sender;
}

async function openReportModal(reportId) {
  setStatus(`Loading report #${reportId}...`);
  const report = await api(`/api/reports/${encodeURIComponent(reportId)}`);
  reportModalState.report = report;
  renderReportModal(report);
  reportModal.classList.remove('hidden');
  reportModal.setAttribute('aria-hidden', 'false');
  setStatus(`Loaded report #${reportId}`);
}

async function resolveReport(reportId) {
  if (!window.confirm(`Resolve report #${reportId}? It will be removed from the queue.`)) return;
  setStatus(`Resolving report #${reportId}...`);
  await api(`/api/reports/${encodeURIComponent(reportId)}/resolve`, { method: 'POST' });
  if (reportModalState.report?.report_id === reportId) closeReportModal();
  await loadReports();
  setStatus(`Resolved report #${reportId}`);
}

async function lockSender(sender) {
  if (!sender) return;
  if (!window.confirm(`Lock user ${sender}? This blocks sign-ins until unlocked.`)) return;
  setStatus(`Locking ${sender}...`);
  await api(`/api/users/${encodeURIComponent(sender)}/update`, { method: 'POST', body: { locked: true } });
  setStatus(`Locked ${sender}`);
}

async function loadReports() {
  setStatus('Loading reported content queue...');
  renderEmpty(reportTable, 'Loading reports...');
  const params = new URLSearchParams({ from: reportState.from, limit: String(reportState.limit), dir: 'b' });
  if (reportState.query) params.set('q', reportState.query);
  if (reportState.roomId) params.set('room_id', reportState.roomId);
  if (reportState.reporter) params.set('user_id', reportState.reporter);
  if (reportState.sender) params.set('event_sender_user_id', reportState.sender);

  const data = await api(`/api/reports?${params.toString()}`);
  reportState.rows = Array.isArray(data?.event_reports) ? data.event_reports : [];
  reportState.nextToken = data?.next_token ?? null;

  buildHeader(reportTable, [{ label: 'Received' }, { label: 'Context' }, { label: 'Reason' }, { label: 'Action' }]);
  if (!reportState.rows.length) {
    renderEmpty(reportTable, 'No reports currently in queue.');
  } else {
    for (const report of reportState.rows) {
      const tr = document.createElement('div');
      tr.className = 'table-row';

      const left = document.createElement('div');
      left.className = 'room-meta';
      const leftTitle = document.createElement('div');
      leftTitle.className = 'display-name';
      leftTitle.textContent = formatDateTime(report.received_ts);
      const leftMeta = document.createElement('div');
      leftMeta.className = 'room-id';
      leftMeta.textContent = `Report #${report.report_id} • Score ${report.score ?? 'n/a'}`;
      left.appendChild(leftTitle);
      left.appendChild(leftMeta);

      const context = document.createElement('div');
      context.className = 'room-meta';
      const contextTitle = document.createElement('div');
      contextTitle.className = 'display-name';
      contextTitle.textContent = report.room_id || 'Unknown room';
      const contextMeta = document.createElement('div');
      contextMeta.className = 'room-id';
      contextMeta.textContent = `Reporter: ${report.user_id || 'Unknown'} • Sender: ${report.sender || 'Unknown'}`;
      context.appendChild(contextTitle);
      context.appendChild(contextMeta);

      const reason = document.createElement('div');
      reason.className = 'room-meta';
      const reasonTitle = document.createElement('div');
      reasonTitle.className = 'display-name';
      reasonTitle.textContent = report.reason || 'No reason provided';
      const reasonMeta = document.createElement('div');
      reasonMeta.className = 'room-id';
      reasonMeta.textContent = `Event: ${report.event_id || 'Unknown event'}`;
      reason.appendChild(reasonTitle);
      reason.appendChild(reasonMeta);

      const action = document.createElement('div'); action.className = 'media-action-group';
      const view = document.createElement('button'); view.className = 'btn ghost'; view.textContent = 'View'; view.addEventListener('click', () => openReportModal(report.report_id));
      const resolve = document.createElement('button'); resolve.className = 'btn ghost'; resolve.textContent = 'Resolve'; resolve.addEventListener('click', () => resolveReport(report.report_id));
      const lock = document.createElement('button'); lock.className = 'btn ghost danger-outline'; lock.textContent = 'Lock sender'; lock.disabled = !report.sender; lock.addEventListener('click', () => lockSender(report.sender));
      action.appendChild(view); action.appendChild(resolve); action.appendChild(lock);
      tr.appendChild(left); tr.appendChild(context); tr.appendChild(reason); tr.appendChild(action);
      reportTable.appendChild(tr);
    }
  }

  setPager(reportState, reportPrev, reportNext, reportPageLabel);
  setStatus(`Loaded ${reportState.rows.length} reports`);
}

function setDebouncedInput(inputEl, key, callback, delay = 260) {
  inputEl.addEventListener('input', () => {
    if (searchTimers[key]) clearTimeout(searchTimers[key]);
    searchTimers[key] = setTimeout(callback, delay);
  });
}

async function refreshMediaSections() {
  if (userMediaState.userId) await loadUserMedia();
  if (roomMediaState.roomId) await loadRoomInventory();
}

storagePrev.addEventListener('click', async () => { if (storageState.page <= 1) return; storageState.page -= 1; storageState.pageTokens.pop(); storageState.from = storageState.pageTokens[storageState.pageTokens.length - 1] || '0'; await loadStorageDashboard(); });
storageNext.addEventListener('click', async () => { if (!storageState.nextToken) return; storageState.page += 1; storageState.from = storageState.nextToken; storageState.pageTokens.push(storageState.nextToken); await loadStorageDashboard(); });
storageRefresh.addEventListener('click', async () => { await loadStorageDashboard(); });
storagePageSize.addEventListener('change', async () => { storageState.limit = Number(storagePageSize.value); resetPager(storageState); await loadStorageDashboard(); });
storageTimeRange.addEventListener('change', async () => { storageState.timeRange = storageTimeRange.value; resetPager(storageState); await loadStorageDashboard(); });
setDebouncedInput(storageSearch, 'storage', async () => { storageState.query = storageSearch.value.trim(); resetPager(storageState); await loadStorageDashboard(); });

userMediaPrev.addEventListener('click', async () => { if (userMediaState.page <= 1) return; userMediaState.page -= 1; userMediaState.pageTokens.pop(); userMediaState.from = userMediaState.pageTokens[userMediaState.pageTokens.length - 1] || '0'; await loadUserMedia(); });
userMediaNext.addEventListener('click', async () => { if (!userMediaState.nextToken) return; userMediaState.page += 1; userMediaState.from = userMediaState.nextToken; userMediaState.pageTokens.push(userMediaState.nextToken); await loadUserMedia(); });
userMediaRefresh.addEventListener('click', async () => { await loadUserMedia(); });
userMediaSort.addEventListener('change', async () => { userMediaState.orderBy = userMediaSort.value; resetPager(userMediaState); await loadUserMedia(); });
userMediaDir.addEventListener('change', async () => { userMediaState.dir = userMediaDir.value; resetPager(userMediaState); await loadUserMedia(); });
userMediaPageSize.addEventListener('change', async () => { userMediaState.limit = Number(userMediaPageSize.value); resetPager(userMediaState); await loadUserMedia(); });
setDebouncedInput(userMediaSearch, 'userMedia', async () => { userMediaState.query = userMediaSearch.value.trim(); resetPager(userMediaState); await loadUserMedia(); });

roomMediaLoad.addEventListener('click', async () => { roomMediaState.roomId = roomMediaRoomId.value.trim(); roomMediaState.source = roomMediaSource.value; roomMediaState.query = roomMediaSearch.value.trim(); roomMediaState.limit = Number(roomMediaPageSize.value); resetPager(roomMediaState); await loadRoomInventory(); });
roomMediaPrev.addEventListener('click', async () => { if (roomMediaState.page <= 1) return; roomMediaState.page -= 1; roomMediaState.pageTokens.pop(); roomMediaState.from = roomMediaState.pageTokens[roomMediaState.pageTokens.length - 1] || '0'; await loadRoomInventory(); });
roomMediaNext.addEventListener('click', async () => { if (!roomMediaState.nextToken) return; roomMediaState.page += 1; roomMediaState.from = roomMediaState.nextToken; roomMediaState.pageTokens.push(roomMediaState.nextToken); await loadRoomInventory(); });
roomMediaSource.addEventListener('change', async () => { roomMediaState.source = roomMediaSource.value; resetPager(roomMediaState); await loadRoomInventory(); });
roomMediaPageSize.addEventListener('change', async () => { roomMediaState.limit = Number(roomMediaPageSize.value); resetPager(roomMediaState); await loadRoomInventory(); });
setDebouncedInput(roomMediaSearch, 'roomMedia', async () => { roomMediaState.query = roomMediaSearch.value.trim(); resetPager(roomMediaState); await loadRoomInventory(); });

reportPrev.addEventListener('click', async () => { if (reportState.page <= 1) return; reportState.page -= 1; reportState.pageTokens.pop(); reportState.from = reportState.pageTokens[reportState.pageTokens.length - 1] || '0'; await loadReports(); });
reportNext.addEventListener('click', async () => { if (!reportState.nextToken) return; reportState.page += 1; reportState.from = reportState.nextToken; reportState.pageTokens.push(reportState.nextToken); await loadReports(); });
reportRefresh.addEventListener('click', async () => { reportState.query = reportSearch.value.trim(); reportState.roomId = reportRoomFilter.value.trim(); reportState.reporter = reportUserFilter.value.trim(); reportState.sender = reportSenderFilter.value.trim(); reportState.limit = Number(reportPageSize.value); resetPager(reportState); await loadReports(); });
reportPageSize.addEventListener('change', async () => { reportState.limit = Number(reportPageSize.value); resetPager(reportState); await loadReports(); });
setDebouncedInput(reportSearch, 'report', async () => { reportState.query = reportSearch.value.trim(); resetPager(reportState); await loadReports(); });
[reportRoomFilter, reportUserFilter, reportSenderFilter].forEach((inputEl) => setDebouncedInput(inputEl, inputEl.id, async () => { reportState.roomId = reportRoomFilter.value.trim(); reportState.reporter = reportUserFilter.value.trim(); reportState.sender = reportSenderFilter.value.trim(); resetPager(reportState); await loadReports(); }));

mediaPreviewClose.addEventListener('click', closeMediaPreviewModal);
mediaPreviewModal.addEventListener('click', (event) => { if (event.target === mediaPreviewModal) closeMediaPreviewModal(); });
mediaPreviewQuarantineBtn.addEventListener('click', async () => { if (previewState.item) await toggleMediaQuarantine(previewState.item); });
mediaPreviewDeleteBtn.addEventListener('click', async () => { if (previewState.item) await deleteMediaItem(previewState.item); });

reportModalClose.addEventListener('click', closeReportModal);
reportModal.addEventListener('click', (event) => { if (event.target === reportModal) closeReportModal(); });
reportModalResolveBtn.addEventListener('click', async () => { if (reportModalState.report?.report_id) await resolveReport(reportModalState.report.report_id); });
reportModalLockBtn.addEventListener('click', async () => { if (reportModalState.report?.sender) await lockSender(reportModalState.report.sender); });

async function loadConfig() {
  const data = await api('/api/config');
  serverNameEl.textContent = data?.server_name || 'unknown';
  setStatus(`Connected to ${data?.base_url || data?.server_name || 'server'}`);
}

function applyInitialTargetsFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const initialUserId = params.get('user_id');
  if (!initialUserId) return;

  const userId = initialUserId.trim();
  if (!userId) return;

  const label = (params.get('label') || '').trim();
  userMediaState.userId = userId;
  userMediaState.userDisplayName = label || userId;
  userMediaSubtitle.textContent = `Showing uploaded media for ${userMediaState.userDisplayName} (${userMediaState.userId}).`;
}

(async () => {
  try {
    applyInitialTargetsFromUrl();
    await loadConfig();
    await Promise.all([loadStorageDashboard(), loadReports()]);

    if (userMediaState.userId) {
      await loadUserMedia();
    } else {
      renderEmpty(userMediaTable, 'Select a user in the storage dashboard first.');
    }

    renderEmpty(roomMediaTable, 'Enter a room ID and load inventory.');
    setPager(userMediaState, userMediaPrev, userMediaNext, userMediaPageLabel);
    setPager(roomMediaState, roomMediaPrev, roomMediaNext, roomMediaPageLabel);
  } catch (err) {
    setStatus(`Error: ${err.message}`);
    renderEmpty(storageTable, 'Unable to load storage dashboard.');
    renderEmpty(reportTable, 'Unable to load reports.');
  }
})();
