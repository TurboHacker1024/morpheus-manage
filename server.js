const path = require('path');
const fs = require('fs');
const express = require('express');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 4173);

const SYNAPSE_BASE_URL = process.env.SYNAPSE_BASE_URL;
const SYNAPSE_ADMIN_TOKEN = process.env.SYNAPSE_ADMIN_TOKEN;
const SYNAPSE_SERVER_NAME = process.env.SYNAPSE_SERVER_NAME;

if (!SYNAPSE_BASE_URL || !SYNAPSE_ADMIN_TOKEN || !SYNAPSE_SERVER_NAME) {
  console.error('Missing required env vars. See .env.example for SYNAPSE_BASE_URL, SYNAPSE_ADMIN_TOKEN, SYNAPSE_SERVER_NAME.');
  process.exit(1);
}

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

const USERS_FETCH_LIMIT = 100;
const ROOMS_FETCH_LIMIT = 100;
const ROOM_ACTIVITY_TTL_MS = 15 * 60 * 1000;
const ROOM_ACTIVITY_STALE_MS = 60 * 60 * 1000;
const ROOM_ACTIVITY_BATCH = 10;
const ROOM_ACTIVITY_CACHE_FILE = path.join(__dirname, 'cache', 'rooms.json');
const ACTION_LOG_FILE = path.join(__dirname, 'cache', 'actions.json');
const ACTION_LOG_MAX_ENTRIES = Math.max(200, Number(process.env.ACTION_LOG_MAX_ENTRIES || 5000));
const ACTION_PERSIST_DEBOUNCE_MS = 250;
const SYNAPSE_HEALTH_CACHE_TTL_MS = 15 * 1000;

let roomActivityCache = new Map();
let roomCacheLoaded = false;
let roomRefreshInProgress = false;
let roomRefreshQueue = new Set();
let actionLogEntries = [];
let actionLogLoaded = false;
let actionPersistTimer = null;
let roomCachePersistedAt = null;
let actionLogPersistedAt = null;
let lastRoomsListFetchAt = null;
let lastRoomsListFetchDurationMs = null;
let lastRoomsListFetchError = null;
let lastRoomRefreshStartedAt = null;
let lastRoomRefreshFinishedAt = null;
let lastRoomRefreshError = null;
let synapseHealthSnapshot = {
  checked_at: null,
  ok: null,
  latency_ms: null,
  version: null,
  error: null
};

function getLocalpart(userId) {
  if (!userId) return '';
  const trimmed = userId.startsWith('@') ? userId.slice(1) : userId;
  const parts = trimmed.split(':');
  return parts[0] || trimmed;
}

function getDisplaySortKey(user) {
  const display = (user.displayname || '').trim();
  if (display) {
    return display.toLowerCase();
  }
  const localpart = getLocalpart(user.name || '');
  return localpart.toLowerCase();
}

function userMatchesSearch(user, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;

  const haystack = [
    user?.displayname || '',
    user?.name || '',
    getLocalpart(user?.name || ''),
    user?.admin ? 'admin' : 'user',
    user?.deactivated ? 'deactivated' : '',
    user?.locked ? 'locked' : 'active'
  ]
    .join(' ')
    .toLowerCase();

  return haystack.includes(q);
}

function sortUsers(users, { key, dir }) {
  const direction = dir === 'b' ? -1 : 1;
  const sorted = [...users];

  sorted.sort((a, b) => {
    let compare = 0;
    switch (key) {
      case 'admin': {
        compare = Number(Boolean(a.admin)) - Number(Boolean(b.admin));
        break;
      }
      case 'deactivated': {
        compare = Number(Boolean(a.deactivated)) - Number(Boolean(b.deactivated));
        break;
      }
      case 'displayname':
      case 'name':
      default: {
        const aKey = getDisplaySortKey(a);
        const bKey = getDisplaySortKey(b);
        compare = aKey.localeCompare(bKey, undefined, { sensitivity: 'base' });
        break;
      }
    }

    if (compare === 0) {
      const aFallback = (a.name || '').toLowerCase();
      const bFallback = (b.name || '').toLowerCase();
      compare = aFallback.localeCompare(bFallback, undefined, { sensitivity: 'base' });
    }

    return compare * direction;
  });

  return sorted;
}

function getRoomName(room) {
  return (room?.name || room?.canonical_alias || room?.room_id || '').trim();
}

function getRoomMembers(room) {
  return Number(
    room?.joined_members ??
      room?.joined_local_members ??
      room?.num_joined_members ??
      room?.member_count ??
      0
  );
}

function getRoomHomeserver(room) {
  const roomId = room?.room_id || '';
  const parts = roomId.split(':');
  return parts.length > 1 ? parts.slice(1).join(':') : '';
}

function roomMatchesSearch(room, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;

  const haystack = [
    getRoomName(room),
    room?.room_id || '',
    room?.canonical_alias || '',
    getRoomHomeserver(room)
  ]
    .join(' ')
    .toLowerCase();

  return haystack.includes(q);
}

function getRoomLastActive(room) {
  return (
    room?.last_event_ts ??
    room?.last_activity_ts ??
    room?.last_active_ts ??
    room?.last_activity ??
    0
  );
}

function sortRooms(rooms, { key, dir }) {
  const direction = dir === 'b' ? -1 : 1;
  const sorted = [...rooms];

  sorted.sort((a, b) => {
    let compare = 0;
    switch (key) {
      case 'members': {
        compare = getRoomMembers(a) - getRoomMembers(b);
        break;
      }
      case 'homeserver': {
        const aServer = getRoomHomeserver(a).toLowerCase();
        const bServer = getRoomHomeserver(b).toLowerCase();
        compare = aServer.localeCompare(bServer, undefined, { sensitivity: 'base' });
        break;
      }
      case 'last_active': {
        compare = getRoomLastActive(a) - getRoomLastActive(b);
        break;
      }
      case 'name':
      default: {
        const aName = getRoomName(a).toLowerCase();
        const bName = getRoomName(b).toLowerCase();
        compare = aName.localeCompare(bName, undefined, { sensitivity: 'base' });
        break;
      }
    }

    if (compare === 0) {
      const aFallback = (a?.room_id || '').toLowerCase();
      const bFallback = (b?.room_id || '').toLowerCase();
      compare = aFallback.localeCompare(bFallback, undefined, { sensitivity: 'base' });
    }

    return compare * direction;
  });

  return sorted;
}

function parseMxcUri(mxc) {
  const value = String(mxc || '');
  if (!value.startsWith('mxc://')) {
    return null;
  }
  const mxcPath = value.slice('mxc://'.length);
  const slashIndex = mxcPath.indexOf('/');
  if (slashIndex <= 0) {
    return null;
  }
  return {
    server: mxcPath.slice(0, slashIndex),
    mediaId: mxcPath.slice(slashIndex + 1)
  };
}

function buildAvatarThumbnailPath(mxc, size = 48) {
  const parsed = parseMxcUri(mxc);
  if (!parsed) return null;
  const width = Math.max(1, Number(size) || 48);
  const height = width;
  return `/api/media/thumbnail?mxc=${encodeURIComponent(mxc)}&width=${width}&height=${height}&method=crop`;
}

function buildAvatarDownloadPath(mxc) {
  const parsed = parseMxcUri(mxc);
  if (!parsed) return null;
  return `/api/media/download?mxc=${encodeURIComponent(mxc)}`;
}

function createActionId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function getClientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.ip || req.socket?.remoteAddress || 'unknown';
}

function truncateString(value, max = 220) {
  if (typeof value !== 'string') return value;
  if (value.length <= max) return value;
  return `${value.slice(0, max)}...`;
}

function sanitizeForLog(value, depth = 0) {
  if (value === null || value === undefined) {
    return value;
  }

  if (depth > 4) {
    return '[max-depth]';
  }

  if (typeof value === 'string') {
    return truncateString(value);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (Array.isArray(value)) {
    const limited = value.slice(0, 25).map((item) => sanitizeForLog(item, depth + 1));
    if (value.length > 25) {
      limited.push(`[+${value.length - 25} more]`);
    }
    return limited;
  }

  if (typeof value === 'object') {
    const output = {};
    const entries = Object.entries(value).slice(0, 50);
    for (const [key, nestedValue] of entries) {
      if (/(password|token|secret|access_token|authorization|new_password)/i.test(key)) {
        output[key] = '[redacted]';
      } else {
        output[key] = sanitizeForLog(nestedValue, depth + 1);
      }
    }
    if (Object.keys(value).length > 50) {
      output._truncated = `[+${Object.keys(value).length - 50} more keys]`;
    }
    return output;
  }

  return String(value);
}

function serializeErrorForLog(err) {
  if (!err) return null;
  return {
    message: truncateString(err.message || 'Unknown error'),
    status: err.status || null,
    details: sanitizeForLog(err.data || null)
  };
}

function loadActionLog() {
  if (actionLogLoaded) return;
  actionLogLoaded = true;
  try {
    if (!fs.existsSync(ACTION_LOG_FILE)) {
      actionLogEntries = [];
      return;
    }
    const raw = fs.readFileSync(ACTION_LOG_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    actionLogEntries = entries.slice(0, ACTION_LOG_MAX_ENTRIES);
  } catch (err) {
    console.warn('Failed to load action log cache', err.message);
    actionLogEntries = [];
  }
}

function persistActionLog() {
  try {
    const dir = path.dirname(ACTION_LOG_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const payload = {
      updated_at: Date.now(),
      entries: actionLogEntries
    };
    fs.writeFileSync(ACTION_LOG_FILE, JSON.stringify(payload, null, 2), 'utf8');
    actionLogPersistedAt = Date.now();
  } catch (err) {
    console.warn('Failed to persist action log cache', err.message);
  }
}

function scheduleActionPersist() {
  if (actionPersistTimer) return;
  actionPersistTimer = setTimeout(() => {
    actionPersistTimer = null;
    persistActionLog();
  }, ACTION_PERSIST_DEBOUNCE_MS);
}

function logAdminAction({
  req = null,
  action,
  title,
  module = 'system',
  risk = 'safe',
  status = 'success',
  targetType = null,
  targetId = null,
  request = null,
  result = null,
  error = null,
  startedAt = null,
  httpStatus = null
}) {
  if (!action || !title) return;
  loadActionLog();

  const now = Date.now();
  const durationMs = typeof startedAt === 'number' ? Math.max(0, now - startedAt) : null;

  const entry = {
    id: createActionId(),
    at: new Date(now).toISOString(),
    ts: now,
    action,
    title,
    module,
    risk,
    status,
    duration_ms: durationMs,
    target: targetType || targetId ? { type: targetType, id: targetId } : null,
    actor: req
      ? {
          ip: getClientIp(req),
          user_agent: truncateString(req.get('user-agent') || 'Unknown', 120)
        }
      : {
          ip: 'system',
          user_agent: 'server'
        },
    http: req
      ? {
          method: req.method,
          path: req.path,
          status_code: httpStatus || (status === 'error' ? error?.status || 500 : 200)
        }
      : null,
    details: {
      request: sanitizeForLog(request),
      result: sanitizeForLog(result),
      error: serializeErrorForLog(error)
    }
  };

  actionLogEntries.unshift(entry);
  if (actionLogEntries.length > ACTION_LOG_MAX_ENTRIES) {
    actionLogEntries = actionLogEntries.slice(0, ACTION_LOG_MAX_ENTRIES);
  }
  scheduleActionPersist();
}

function getActionEntryTitle(updateBody) {
  const keys = Object.keys(updateBody || {});
  if (keys.length === 1 && keys[0] === 'displayname') {
    return 'Rename user';
  }
  if (keys.length === 1 && keys[0] === 'password') {
    return 'Reset user password';
  }
  if (keys.length === 1 && keys[0] === 'admin') {
    return updateBody.admin ? 'Grant admin privileges' : 'Remove admin privileges';
  }
  if (keys.length === 1 && keys[0] === 'locked') {
    return updateBody.locked ? 'Lock user' : 'Unlock user';
  }
  return 'Update user';
}

function loadRoomCache() {
  if (roomCacheLoaded) return;
  roomCacheLoaded = true;
  try {
    if (!fs.existsSync(ROOM_ACTIVITY_CACHE_FILE)) {
      return;
    }
    const raw = fs.readFileSync(ROOM_ACTIVITY_CACHE_FILE, 'utf8');
    const data = JSON.parse(raw);
    const rooms = data?.rooms || {};
    Object.entries(rooms).forEach(([roomId, entry]) => {
      if (entry?.last_active_ts) {
        roomActivityCache.set(roomId, {
          last_active_ts: entry.last_active_ts,
          cached_at: entry.cached_at || null
        });
      }
    });
  } catch (err) {
    console.warn('Failed to load room cache', err.message);
  }
}

function persistRoomCache() {
  try {
    const dir = path.dirname(ROOM_ACTIVITY_CACHE_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const rooms = {};
    roomActivityCache.forEach((value, key) => {
      rooms[key] = value;
    });
    const payload = {
      updated_at: Date.now(),
      rooms
    };
    fs.writeFileSync(ROOM_ACTIVITY_CACHE_FILE, JSON.stringify(payload, null, 2), 'utf8');
    roomCachePersistedAt = Date.now();
  } catch (err) {
    console.warn('Failed to persist room cache', err.message);
  }
}

function setRoomLastActive(roomId, lastActive) {
  if (!roomId || !lastActive) return;
  roomActivityCache.set(roomId, {
    last_active_ts: lastActive,
    cached_at: Date.now()
  });
}

function queueRoomRefresh(roomIds) {
  roomIds.forEach((id) => roomRefreshQueue.add(id));
  if (!roomRefreshInProgress && roomRefreshQueue.size) {
    void processRoomRefreshQueue();
  }
}

async function processRoomRefreshQueue() {
  if (roomRefreshInProgress) return;
  roomRefreshInProgress = true;
  lastRoomRefreshStartedAt = Date.now();
  lastRoomRefreshError = null;
  try {
    while (roomRefreshQueue.size) {
      const batch = Array.from(roomRefreshQueue).slice(0, ROOM_ACTIVITY_BATCH);
      batch.forEach((id) => roomRefreshQueue.delete(id));
      await Promise.all(
        batch.map(async (roomId) => {
          const lastActive = await fetchRoomLastActive(roomId);
          if (lastActive) {
            setRoomLastActive(roomId, lastActive);
          }
        })
      );
      persistRoomCache();
    }
    lastRoomRefreshFinishedAt = Date.now();
  } catch (err) {
    lastRoomRefreshError = err.message || 'Room refresh queue failed';
    lastRoomRefreshFinishedAt = Date.now();
    console.warn('Room refresh queue failed', err.message);
  } finally {
    roomRefreshInProgress = false;
  }
}

async function fetchUsersWithFilter({ guests, deactivated }) {
  const allUsers = [];
  let from = '0';

  while (true) {
    const data = await synapseRequest('GET', '/_synapse/admin/v2/users', null, {
      from,
      limit: USERS_FETCH_LIMIT,
      guests,
      locked: 'true',
      ...(deactivated !== undefined ? { deactivated } : {})
    });

    const users = data?.users || [];
    allUsers.push(...users);

    if (!data?.next_token) {
      break;
    }

    from = String(data.next_token);
  }

  return allUsers;
}

async function fetchAllUsers({ guests, includeDeactivated }) {
  const [active, deactivated] = await Promise.all([
    fetchUsersWithFilter({ guests, deactivated: 'false' }),
    fetchUsersWithFilter({ guests, deactivated: 'true' })
  ]);

  const merged = new Map();
  [...active, ...deactivated].forEach((user) => {
    if (user?.name) {
      merged.set(user.name, user);
    }
  });

  return Array.from(merged.values());
}

async function fetchRoomLastActive(roomId) {
  try {
    const data = await synapseRequest(
      'GET',
      `/_synapse/admin/v1/rooms/${encodeURIComponent(roomId)}/timestamp_to_event`,
      null,
      {
        ts: Date.now(),
        dir: 'b'
      }
    );
    return data?.origin_server_ts || null;
  } catch (err) {
    return null;
  }
}

async function fetchAllRooms() {
  const allRooms = [];
  let from = '0';

  while (true) {
    const data = await synapseRequest('GET', '/_synapse/admin/v1/rooms', null, {
      from,
      limit: ROOMS_FETCH_LIMIT
    });

    const rooms = data?.rooms || [];
    allRooms.push(...rooms);

    const nextBatch = data?.next_batch ?? data?.next_token ?? null;
    if (!nextBatch) {
      break;
    }

    from = String(nextBatch);
  }

  return allRooms;
}

function buildSynapseUrl(endpoint, query) {
  const base = SYNAPSE_BASE_URL.endsWith('/') ? SYNAPSE_BASE_URL : `${SYNAPSE_BASE_URL}/`;
  const pathPart = endpoint.replace(/^\/+/, '');
  const url = new URL(pathPart, base);

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }
  }

  return url.toString();
}

async function synapseRequest(method, endpoint, body, query) {
  const url = buildSynapseUrl(endpoint, query);
  const headers = {
    Authorization: `Bearer ${SYNAPSE_ADMIN_TOKEN}`,
    'Content-Type': 'application/json'
  };

  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

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
    const error = new Error(data?.error || `Synapse error ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

function toTimestamp(value) {
  if (value === undefined || value === null || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return numeric;
}

function summarizeActionSet(entries) {
  const summary = {
    total: entries.length,
    success: 0,
    error: 0,
    safe: 0,
    guarded: 0,
    destructive: 0,
    module_counts: {}
  };

  entries.forEach((entry) => {
    if (entry.status === 'error') {
      summary.error += 1;
    } else {
      summary.success += 1;
    }

    if (entry.risk === 'destructive') {
      summary.destructive += 1;
    } else if (entry.risk === 'guarded') {
      summary.guarded += 1;
    } else {
      summary.safe += 1;
    }

    const moduleName = entry.module || 'other';
    summary.module_counts[moduleName] = (summary.module_counts[moduleName] || 0) + 1;
  });

  return summary;
}

async function getSynapseHealthSnapshot(force = false) {
  const now = Date.now();
  const isFresh =
    synapseHealthSnapshot.checked_at &&
    now - Number(synapseHealthSnapshot.checked_at) < SYNAPSE_HEALTH_CACHE_TTL_MS;

  if (!force && isFresh) {
    return synapseHealthSnapshot;
  }

  const startedAt = Date.now();
  try {
    const data = await synapseRequest('GET', '/_synapse/admin/v1/server_version');
    synapseHealthSnapshot = {
      checked_at: Date.now(),
      ok: true,
      latency_ms: Date.now() - startedAt,
      version: data?.server_version || null,
      error: null
    };
  } catch (err) {
    synapseHealthSnapshot = {
      checked_at: Date.now(),
      ok: false,
      latency_ms: Date.now() - startedAt,
      version: null,
      error: err.message || 'Synapse health check failed'
    };
  }

  return synapseHealthSnapshot;
}

function getFileStats(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return {
        exists: false,
        size_bytes: 0,
        mtime_ms: null
      };
    }
    const stat = fs.statSync(filePath);
    return {
      exists: true,
      size_bytes: Number(stat.size || 0),
      mtime_ms: stat.mtimeMs ? Math.round(stat.mtimeMs) : null
    };
  } catch (err) {
    return {
      exists: false,
      size_bytes: 0,
      mtime_ms: null
    };
  }
}

app.get('/api/config', (req, res) => {
  res.json({
    server_name: SYNAPSE_SERVER_NAME,
    base_url: SYNAPSE_BASE_URL
  });
});

app.get('/api/actions', (req, res) => {
  loadActionLog();
  const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50)));
  const offset = Math.max(0, Number(req.query.offset || 0));
  const moduleFilter = String(req.query.module || '').trim().toLowerCase();
  const statusFilter = String(req.query.status || '').trim().toLowerCase();
  const riskFilter = String(req.query.risk || '').trim().toLowerCase();
  const actionFilter = String(req.query.action || '').trim().toLowerCase();
  const search = String(req.query.q || '').trim().toLowerCase();
  const since = toTimestamp(req.query.since);
  const until = toTimestamp(req.query.until);

  let filtered = [...actionLogEntries];

  if (moduleFilter && moduleFilter !== 'all') {
    filtered = filtered.filter((entry) => String(entry.module || '').toLowerCase() === moduleFilter);
  }

  if (statusFilter && statusFilter !== 'all') {
    filtered = filtered.filter((entry) => String(entry.status || '').toLowerCase() === statusFilter);
  }

  if (riskFilter && riskFilter !== 'all') {
    filtered = filtered.filter((entry) => String(entry.risk || '').toLowerCase() === riskFilter);
  }

  if (actionFilter && actionFilter !== 'all') {
    filtered = filtered.filter((entry) => String(entry.action || '').toLowerCase() === actionFilter);
  }

  if (since) {
    filtered = filtered.filter((entry) => Number(entry.ts || 0) >= since);
  }

  if (until) {
    filtered = filtered.filter((entry) => Number(entry.ts || 0) <= until);
  }

  if (search) {
    filtered = filtered.filter((entry) => {
      const haystack = [
        entry.title,
        entry.action,
        entry.module,
        entry?.target?.id,
        entry?.target?.type,
        entry?.actor?.ip,
        entry?.details?.request ? JSON.stringify(entry.details.request) : null,
        entry?.details?.error?.message
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(search);
    });
  }

  const page = filtered.slice(offset, offset + limit);
  const nextOffset = offset + limit < filtered.length ? offset + limit : null;

  res.json({
    actions: page,
    total: filtered.length,
    next_offset: nextOffset,
    filtered_summary: summarizeActionSet(filtered),
    global_summary: summarizeActionSet(actionLogEntries)
  });
});

app.get('/api/system/status', async (req, res, next) => {
  try {
    loadRoomCache();
    loadActionLog();

    const now = Date.now();
    const forceHealth = String(req.query.force || 'false') === 'true';
    const health = await getSynapseHealthSnapshot(forceHealth);

    const roomEntries = Array.from(roomActivityCache.values());
    let staleEntries = 0;
    let ttlExpiredEntries = 0;
    let oldestCachedAt = null;
    let newestCachedAt = null;

    roomEntries.forEach((entry) => {
      const cachedAt = Number(entry?.cached_at || 0);
      if (!cachedAt) return;
      if (now - cachedAt > ROOM_ACTIVITY_STALE_MS) staleEntries += 1;
      if (now - cachedAt > ROOM_ACTIVITY_TTL_MS) ttlExpiredEntries += 1;
      if (!oldestCachedAt || cachedAt < oldestCachedAt) oldestCachedAt = cachedAt;
      if (!newestCachedAt || cachedAt > newestCachedAt) newestCachedAt = cachedAt;
    });

    const latestAction = actionLogEntries[0] || null;
    const latestErrorAction = actionLogEntries.find((entry) => entry?.status === 'error') || null;
    const roomCacheFile = getFileStats(ROOM_ACTIVITY_CACHE_FILE);
    const actionLogFile = getFileStats(ACTION_LOG_FILE);
    const memory = process.memoryUsage();

    res.json({
      generated_at: now,
      server: {
        name: SYNAPSE_SERVER_NAME,
        base_url: SYNAPSE_BASE_URL,
        version: health.version || null,
        api_healthy: Boolean(health.ok),
        api_latency_ms: health.latency_ms,
        health_checked_at: health.checked_at,
        health_error: health.error || null
      },
      rooms_cache: {
        entries: roomEntries.length,
        stale_entries: staleEntries,
        ttl_expired_entries: ttlExpiredEntries,
        oldest_cached_at: oldestCachedAt,
        newest_cached_at: newestCachedAt,
        refresh_queue_depth: roomRefreshQueue.size,
        refresh_in_progress: roomRefreshInProgress,
        last_queue_refresh_started_at: lastRoomRefreshStartedAt,
        last_queue_refresh_finished_at: lastRoomRefreshFinishedAt,
        last_queue_refresh_error: lastRoomRefreshError,
        last_rooms_fetch_at: lastRoomsListFetchAt,
        last_rooms_fetch_duration_ms: lastRoomsListFetchDurationMs,
        last_rooms_fetch_error: lastRoomsListFetchError,
        last_cache_persist_at: roomCachePersistedAt,
        cache_file: roomCacheFile
      },
      actions_log: {
        entries: actionLogEntries.length,
        max_entries: ACTION_LOG_MAX_ENTRIES,
        last_action_at: latestAction?.ts || null,
        last_action_title: latestAction?.title || null,
        last_error_at: latestErrorAction?.ts || null,
        last_error_title: latestErrorAction?.title || null,
        last_error_message: latestErrorAction?.details?.error?.message || null,
        last_cache_persist_at: actionLogPersistedAt,
        cache_file: actionLogFile
      },
      process: {
        pid: process.pid,
        node_version: process.version,
        uptime_seconds: Math.round(process.uptime()),
        memory: {
          rss_bytes: Number(memory?.rss || 0),
          heap_used_bytes: Number(memory?.heapUsed || 0),
          heap_total_bytes: Number(memory?.heapTotal || 0)
        }
      }
    });
  } catch (err) {
    next(err);
  }
});

app.get('/api/media/thumbnail', async (req, res, next) => {
  try {
    const mxc = String(req.query?.mxc || '');
    const width = Number(req.query?.width || 48);
    const height = Number(req.query?.height || 48);
    const method = String(req.query?.method || 'crop');

    const parsed = parseMxcUri(mxc);
    if (!parsed) {
      return res.status(400).json({ error: 'mxc query parameter is required (mxc://server/mediaId).' });
    }

    const endpoint = `/_matrix/media/v3/thumbnail/${encodeURIComponent(parsed.server)}/${encodeURIComponent(parsed.mediaId)}`;
    const url = buildSynapseUrl(endpoint, {
      width: Math.max(1, width),
      height: Math.max(1, height),
      method: method === 'scale' ? 'scale' : 'crop'
    });

    const upstream = await fetch(url, {
      headers: {
        Authorization: `Bearer ${SYNAPSE_ADMIN_TOKEN}`
      }
    });

    if (!upstream.ok) {
      // Some deployments don't generate thumbnails for every media item.
      // If thumbnail lookup fails, fall back to direct media download.
      if (upstream.status === 404) {
        const fallbackUrl = buildSynapseUrl(
          `/_matrix/media/v3/download/${encodeURIComponent(parsed.server)}/${encodeURIComponent(parsed.mediaId)}`
        );
        const fallback = await fetch(fallbackUrl, {
          headers: {
            Authorization: `Bearer ${SYNAPSE_ADMIN_TOKEN}`
          }
        });
        if (fallback.ok) {
          const contentType = fallback.headers.get('content-type') || 'application/octet-stream';
          const cacheControl = fallback.headers.get('cache-control') || 'public, max-age=3600';
          const arrayBuffer = await fallback.arrayBuffer();
          const body = Buffer.from(arrayBuffer);
          res.set('Content-Type', contentType);
          res.set('Cache-Control', cacheControl);
          return res.send(body);
        }
      }

      const text = await upstream.text();
      let details = null;
      try {
        details = JSON.parse(text);
      } catch (err) {
        details = text || null;
      }

      return res.status(upstream.status).json({
        error: 'Unable to fetch media thumbnail.',
        details
      });
    }

    const contentType = upstream.headers.get('content-type') || 'image/jpeg';
    const cacheControl = upstream.headers.get('cache-control') || 'public, max-age=3600';
    const arrayBuffer = await upstream.arrayBuffer();
    const body = Buffer.from(arrayBuffer);

    res.set('Content-Type', contentType);
    res.set('Cache-Control', cacheControl);
    res.send(body);
  } catch (err) {
    next(err);
  }
});

app.get('/api/media/download', async (req, res, next) => {
  try {
    const mxc = String(req.query?.mxc || '');
    const parsed = parseMxcUri(mxc);
    if (!parsed) {
      return res.status(400).json({ error: 'mxc query parameter is required (mxc://server/mediaId).' });
    }

    const url = buildSynapseUrl(
      `/_matrix/media/v3/download/${encodeURIComponent(parsed.server)}/${encodeURIComponent(parsed.mediaId)}`
    );
    const upstream = await fetch(url, {
      headers: {
        Authorization: `Bearer ${SYNAPSE_ADMIN_TOKEN}`
      }
    });

    if (!upstream.ok) {
      const text = await upstream.text();
      let details = null;
      try {
        details = JSON.parse(text);
      } catch (err) {
        details = text || null;
      }
      return res.status(upstream.status).json({
        error: 'Unable to fetch media download.',
        details
      });
    }

    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    const cacheControl = upstream.headers.get('cache-control') || 'public, max-age=3600';
    const arrayBuffer = await upstream.arrayBuffer();
    const body = Buffer.from(arrayBuffer);

    res.set('Content-Type', contentType);
    res.set('Cache-Control', cacheControl);
    res.send(body);
  } catch (err) {
    next(err);
  }
});

app.get('/api/users', async (req, res, next) => {
  try {
    const {
      from = '0',
      limit = '25',
      guests = 'false',
      deactivated = 'false',
      order_by = 'name',
      dir = 'f',
      q = ''
    } = req.query;

    const pageSize = Math.max(1, Number(limit) || 25);
    const offset = Math.max(0, Number(from) || 0);
    const includeDeactivated = String(deactivated) === 'true';

    let users = await fetchAllUsers({
      guests,
      includeDeactivated
    });

    if (!includeDeactivated) {
      users = users.filter((user) => !user.deactivated);
    }

    if (String(q).trim()) {
      users = users.filter((user) => userMatchesSearch(user, q));
    }

    const sorted = sortUsers(users, {
      key: String(order_by),
      dir: String(dir)
    });

    const page = sorted.slice(offset, offset + pageSize).map((user) => ({
      ...user,
      avatar_thumbnail_url: buildAvatarThumbnailPath(user?.avatar_url, 48),
      avatar_download_url: buildAvatarDownloadPath(user?.avatar_url)
    }));
    const nextToken = offset + pageSize < sorted.length ? String(offset + pageSize) : null;

    res.json({
      users: page,
      next_token: nextToken,
      total: sorted.length
    });
  } catch (err) {
    next(err);
  }
});

app.get('/api/rooms', async (req, res, next) => {
  const startedAt = Date.now();
  try {
    const { from = '0', limit = '25', order_by = 'name', dir = 'f', q = '' } = req.query;
    const pageSize = Math.max(1, Number(limit) || 25);
    const offset = Math.max(0, Number(from) || 0);

    loadRoomCache();
    const rooms = await fetchAllRooms();
    const now = Date.now();
    const refreshNeeded = [];

    rooms.forEach((room) => {
      const roomId = room?.room_id;
      if (!roomId) return;
      const cached = roomActivityCache.get(roomId);
      if (cached?.last_active_ts) {
        room.last_active_ts = cached.last_active_ts;
        room.last_active_cached_at = cached.cached_at || null;
        room.last_active_stale = cached.cached_at ? now - cached.cached_at > ROOM_ACTIVITY_STALE_MS : false;
        if (!cached.cached_at || now - cached.cached_at > ROOM_ACTIVITY_TTL_MS) {
          refreshNeeded.push(roomId);
        }
      } else {
        refreshNeeded.push(roomId);
      }
    });

    if (refreshNeeded.length) {
      queueRoomRefresh(refreshNeeded);
    }
    const filteredRooms = String(q).trim() ? rooms.filter((room) => roomMatchesSearch(room, q)) : rooms;
    const sorted = sortRooms(filteredRooms, { key: String(order_by), dir: String(dir) });
    const page = sorted.slice(offset, offset + pageSize);
    const nextToken = offset + pageSize < sorted.length ? String(offset + pageSize) : null;

    res.json({
      rooms: page,
      next_token: nextToken,
      total: sorted.length
    });
    lastRoomsListFetchAt = Date.now();
    lastRoomsListFetchDurationMs = Date.now() - startedAt;
    lastRoomsListFetchError = null;
  } catch (err) {
    lastRoomsListFetchAt = Date.now();
    lastRoomsListFetchDurationMs = Date.now() - startedAt;
    lastRoomsListFetchError = err.message || 'Failed to load rooms list';
    next(err);
  }
});

app.post('/api/users', async (req, res, next) => {
  const startedAt = Date.now();
  try {
    const { user_id, localpart, password, admin, displayname } = req.body || {};
    const resolvedUserId = user_id || (localpart ? `@${localpart}:${SYNAPSE_SERVER_NAME}` : null);

    if (!resolvedUserId) {
      logAdminAction({
        req,
        action: 'user.create',
        title: 'Create user',
        module: 'users',
        risk: 'guarded',
        status: 'error',
        targetType: 'user',
        targetId: null,
        request: {
          has_user_id: Boolean(user_id),
          has_localpart: Boolean(localpart)
        },
        error: { message: 'Provide user_id or localpart.', status: 400 },
        startedAt,
        httpStatus: 400
      });
      return res.status(400).json({ error: 'Provide user_id or localpart.' });
    }

    const body = {
      deactivated: false
    };

    if (password) {
      body.password = password;
    }

    if (typeof admin === 'boolean') {
      body.admin = admin;
    }

    if (displayname !== undefined && displayname !== '') {
      body.displayname = displayname;
    }

    const data = await synapseRequest(
      'PUT',
      `/_synapse/admin/v2/users/${encodeURIComponent(resolvedUserId)}`,
      body
    );

    logAdminAction({
      req,
      action: 'user.create',
      title: 'Create user',
      module: 'users',
      risk: 'guarded',
      status: 'success',
      targetType: 'user',
      targetId: resolvedUserId,
      request: {
        localpart: localpart || null,
        admin: typeof admin === 'boolean' ? admin : null,
        has_password: Boolean(password),
        has_displayname: displayname !== undefined && displayname !== ''
      },
      result: {
        user_id: data?.name || resolvedUserId,
        admin: Boolean(data?.admin),
        deactivated: Boolean(data?.deactivated)
      },
      startedAt
    });

    res.json(data || { ok: true });
  } catch (err) {
    const { user_id, localpart, password, admin, displayname } = req.body || {};
    const resolvedUserId = user_id || (localpart ? `@${localpart}:${SYNAPSE_SERVER_NAME}` : null);
    logAdminAction({
      req,
      action: 'user.create',
      title: 'Create user',
      module: 'users',
      risk: 'guarded',
      status: 'error',
      targetType: 'user',
      targetId: resolvedUserId,
      request: {
        localpart: localpart || null,
        admin: typeof admin === 'boolean' ? admin : null,
        has_password: Boolean(password),
        has_displayname: displayname !== undefined && displayname !== ''
      },
      error: err,
      startedAt
    });
    next(err);
  }
});

app.post('/api/users/:userId/deactivate', async (req, res, next) => {
  const startedAt = Date.now();
  try {
    const userId = req.params.userId;
    const erase = Boolean(req.body?.erase);

    const data = await synapseRequest(
      'POST',
      `/_synapse/admin/v1/deactivate/${encodeURIComponent(userId)}`,
      { erase }
    );

    logAdminAction({
      req,
      action: 'user.deactivate',
      title: 'Deactivate user',
      module: 'users',
      risk: 'destructive',
      status: 'success',
      targetType: 'user',
      targetId: userId,
      request: { erase },
      result: {
        id_server_unbind_result: data?.id_server_unbind_result || null
      },
      startedAt
    });

    res.json(data || { ok: true });
  } catch (err) {
    logAdminAction({
      req,
      action: 'user.deactivate',
      title: 'Deactivate user',
      module: 'users',
      risk: 'destructive',
      status: 'error',
      targetType: 'user',
      targetId: req.params.userId,
      request: {
        erase: Boolean(req.body?.erase)
      },
      error: err,
      startedAt
    });
    next(err);
  }
});

app.post('/api/users/:userId/update', async (req, res, next) => {
  const startedAt = Date.now();
  try {
    const userId = req.params.userId;
    const { displayname, password, admin, locked } = req.body || {};

    const body = {};

    if (displayname !== undefined) {
      body.displayname = displayname;
    }

    if (password) {
      body.password = password;
    }

    if (typeof admin === 'boolean') {
      body.admin = admin;
    }

    if (typeof locked === 'boolean') {
      body.locked = locked;
    }

    if (!Object.keys(body).length) {
      logAdminAction({
        req,
        action: 'user.update',
        title: 'Update user',
        module: 'users',
        risk: 'guarded',
        status: 'error',
        targetType: 'user',
        targetId: userId,
        request: {
          has_displayname: displayname !== undefined,
          has_password: Boolean(password),
          admin: typeof admin === 'boolean' ? admin : null,
          locked: typeof locked === 'boolean' ? locked : null
        },
        error: { message: 'No update fields provided.', status: 400 },
        startedAt,
        httpStatus: 400
      });
      return res.status(400).json({ error: 'No update fields provided.' });
    }

    const data = await synapseRequest(
      'PUT',
      `/_synapse/admin/v2/users/${encodeURIComponent(userId)}`,
      body
    );

    const actionTitle = getActionEntryTitle(body);
    const actionName = body.locked !== undefined ? 'user.lock_state' : 'user.update';
    const risk = body.password ? 'guarded' : body.locked ? 'destructive' : 'guarded';

    logAdminAction({
      req,
      action: actionName,
      title: actionTitle,
      module: 'users',
      risk,
      status: 'success',
      targetType: 'user',
      targetId: userId,
      request: {
        has_displayname: body.displayname !== undefined,
        has_password: Boolean(body.password),
        admin: typeof body.admin === 'boolean' ? body.admin : null,
        locked: typeof body.locked === 'boolean' ? body.locked : null
      },
      result: {
        user_id: data?.name || userId,
        admin: typeof data?.admin === 'boolean' ? data.admin : null,
        deactivated: typeof data?.deactivated === 'boolean' ? data.deactivated : null,
        locked: typeof data?.locked === 'boolean' ? data.locked : null
      },
      startedAt
    });

    res.json(data || { ok: true });
  } catch (err) {
    const { displayname, password, admin, locked } = req.body || {};
    logAdminAction({
      req,
      action: locked !== undefined ? 'user.lock_state' : 'user.update',
      title: locked ? 'Lock user' : locked === false ? 'Unlock user' : 'Update user',
      module: 'users',
      risk: locked !== undefined ? 'destructive' : 'guarded',
      status: 'error',
      targetType: 'user',
      targetId: req.params.userId,
      request: {
        has_displayname: displayname !== undefined,
        has_password: Boolean(password),
        admin: typeof admin === 'boolean' ? admin : null,
        locked: typeof locked === 'boolean' ? locked : null
      },
      error: err,
      startedAt
    });
    next(err);
  }
});

app.get('/api/users/:userId/whois', async (req, res, next) => {
  try {
    const userId = req.params.userId;
    const data = await synapseRequest(
      'GET',
      `/_synapse/admin/v1/whois/${encodeURIComponent(userId)}`
    );
    res.json(data || {});
  } catch (err) {
    next(err);
  }
});

app.get('/api/users/:userId/devices', async (req, res, next) => {
  try {
    const userId = req.params.userId;
    const data = await synapseRequest(
      'GET',
      `/_synapse/admin/v2/users/${encodeURIComponent(userId)}/devices`
    );
    res.json(data || {});
  } catch (err) {
    next(err);
  }
});

app.post('/api/users/:userId/revoke_session', async (req, res, next) => {
  const startedAt = Date.now();
  try {
    const userId = req.params.userId;
    const deviceId = req.body?.device_id;

    if (!deviceId) {
      logAdminAction({
        req,
        action: 'session.revoke',
        title: 'Revoke user session',
        module: 'users',
        risk: 'guarded',
        status: 'error',
        targetType: 'session',
        targetId: userId,
        request: {
          device_id: null
        },
        error: { message: 'device_id is required.', status: 400 },
        startedAt,
        httpStatus: 400
      });
      return res.status(400).json({ error: 'device_id is required.' });
    }

    await synapseRequest(
      'POST',
      `/_synapse/admin/v2/users/${encodeURIComponent(userId)}/delete_devices`,
      { devices: [deviceId] }
    );

    const after = await synapseRequest(
      'GET',
      `/_synapse/admin/v2/users/${encodeURIComponent(userId)}/devices`
    );
    const remaining = Array.isArray(after?.devices) ? after.devices : [];
    const stillPresent = remaining.some((device) => device?.device_id === deviceId);

    logAdminAction({
      req,
      action: 'session.revoke',
      title: 'Revoke user session',
      module: 'users',
      risk: 'guarded',
      status: stillPresent ? 'error' : 'success',
      targetType: 'session',
      targetId: `${userId}:${deviceId}`,
      request: {
        user_id: userId,
        device_id: deviceId
      },
      result: {
        still_present: stillPresent
      },
      error: stillPresent ? { message: 'Device still present after revoke request', status: 409 } : null,
      startedAt,
      httpStatus: stillPresent ? 409 : 200
    });

    res.json({
      ok: !stillPresent,
      user_id: userId,
      device_id: deviceId,
      still_present: stillPresent
    });
  } catch (err) {
    logAdminAction({
      req,
      action: 'session.revoke',
      title: 'Revoke user session',
      module: 'users',
      risk: 'guarded',
      status: 'error',
      targetType: 'session',
      targetId: `${req.params.userId}:${req.body?.device_id || 'unknown'}`,
      request: {
        user_id: req.params.userId,
        device_id: req.body?.device_id || null
      },
      error: err,
      startedAt
    });
    next(err);
  }
});

app.post('/api/users/:userId/revoke_all_sessions', async (req, res, next) => {
  const startedAt = Date.now();
  try {
    const userId = req.params.userId;
    const devicesData = await synapseRequest(
      'GET',
      `/_synapse/admin/v2/users/${encodeURIComponent(userId)}/devices`
    );
    const devices = Array.isArray(devicesData?.devices) ? devicesData.devices : [];
    const deviceIds = devices.map((device) => device?.device_id).filter(Boolean);

    const results = await Promise.allSettled(
      deviceIds.map((deviceId) =>
        synapseRequest(
          'POST',
          `/_synapse/admin/v2/users/${encodeURIComponent(userId)}/delete_devices`,
          { devices: [deviceId] }
        )
      )
    );

    const failed = [];
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        failed.push({
          device_id: deviceIds[index],
          error: result.reason?.message || 'Failed to revoke'
        });
      }
    });

    const after = await synapseRequest(
      'GET',
      `/_synapse/admin/v2/users/${encodeURIComponent(userId)}/devices`
    );
    const remainingDevices = Array.isArray(after?.devices) ? after.devices : [];
    const remainingSet = new Set(remainingDevices.map((device) => device?.device_id).filter(Boolean));
    const unresolved = deviceIds.filter((id) => remainingSet.has(id));

    const failedCount = failed.length + unresolved.length;
    const revokedCount = deviceIds.length - failed.length - unresolved.length;

    logAdminAction({
      req,
      action: 'session.revoke_all',
      title: 'Revoke all sessions',
      module: 'users',
      risk: 'destructive',
      status: failedCount ? 'error' : 'success',
      targetType: 'user',
      targetId: userId,
      request: {
        user_id: userId,
        requested_count: deviceIds.length
      },
      result: {
        requested_count: deviceIds.length,
        revoked_count: revokedCount,
        failed_count: failedCount
      },
      error: failedCount
        ? {
            message: `${failedCount} session revoke actions failed`,
            status: 409,
            details: {
              failed_devices: failed.map((item) => item.device_id),
              unresolved_devices: unresolved
            }
          }
        : null,
      startedAt,
      httpStatus: failedCount ? 409 : 200
    });

    res.json({
      ok: failed.length === 0 && unresolved.length === 0,
      user_id: userId,
      requested_count: deviceIds.length,
      revoked_count: revokedCount,
      failed_count: failedCount,
      failures: [
        ...failed,
        ...unresolved.map((deviceId) => ({
          device_id: deviceId,
          error: 'Device still present after revoke request'
        }))
      ]
    });
  } catch (err) {
    logAdminAction({
      req,
      action: 'session.revoke_all',
      title: 'Revoke all sessions',
      module: 'users',
      risk: 'destructive',
      status: 'error',
      targetType: 'user',
      targetId: req.params.userId,
      request: {
        user_id: req.params.userId
      },
      error: err,
      startedAt
    });
    next(err);
  }
});

app.get('/api/users/:userId/joined_rooms', async (req, res, next) => {
  try {
    const userId = req.params.userId;
    const data = await synapseRequest(
      'GET',
      `/_synapse/admin/v1/users/${encodeURIComponent(userId)}/joined_rooms`
    );
    res.json(data || {});
  } catch (err) {
    next(err);
  }
});

app.get('/api/users/:userId/info', async (req, res, next) => {
  try {
    const userId = req.params.userId;

    const [userInfo, devices, rooms, whois] = await Promise.all([
      synapseRequest('GET', `/_synapse/admin/v2/users/${encodeURIComponent(userId)}`),
      synapseRequest('GET', `/_synapse/admin/v2/users/${encodeURIComponent(userId)}/devices`),
      synapseRequest('GET', `/_synapse/admin/v1/users/${encodeURIComponent(userId)}/joined_rooms`),
      synapseRequest('GET', `/_synapse/admin/v1/whois/${encodeURIComponent(userId)}`)
    ]);

    const threepids = Array.isArray(userInfo?.threepids) ? userInfo.threepids : [];
    const email3pids = threepids.filter((pid) => pid?.medium === 'email');
    const signupEmail = email3pids[0]?.address || null;

    let lastActive = userInfo?.last_seen_ts || null;
    if (!lastActive) {
      const devicesMap = whois?.devices || {};
      let latest = null;
      Object.values(devicesMap).forEach((device) => {
        const sessions = device?.sessions || [];
        sessions.forEach((session) => {
          const connections = session?.connections || [];
          connections.forEach((connection) => {
            if (connection?.last_seen) {
              const seen = connection.last_seen > 1e12 ? connection.last_seen : connection.last_seen * 1000;
              if (!latest || seen > latest) {
                latest = seen;
              }
            }
          });
        });
      });
      lastActive = latest;
    }

    res.json({
      mxid: userInfo?.name || userId,
      threepids,
      signup_email: signupEmail,
      last_active: lastActive,
      devices_count: Array.isArray(devices?.devices) ? devices.devices.length : 0,
      rooms_count: Array.isArray(rooms?.joined_rooms) ? rooms.joined_rooms.length : 0
    });
  } catch (err) {
    next(err);
  }
});

app.post('/api/rooms/details', async (req, res, next) => {
  try {
    const roomIds = Array.isArray(req.body?.room_ids) ? req.body.room_ids : [];

    if (!roomIds.length) {
      return res.json({ rooms: [] });
    }

    const rooms = await Promise.all(
      roomIds.map(async (roomId) => {
        try {
          const info = await synapseRequest(
            'GET',
            `/_synapse/admin/v1/rooms/${encodeURIComponent(roomId)}`
          );
          return {
            room_id: roomId,
            name: info?.name || info?.canonical_alias || null,
            canonical_alias: info?.canonical_alias || null
          };
        } catch (err) {
          return {
            room_id: roomId,
            name: null,
            canonical_alias: null,
            error: err.message || 'Unable to load room details'
          };
        }
      })
    );

    res.json({ rooms });
  } catch (err) {
    next(err);
  }
});

app.get('/api/rooms/:roomId/members', async (req, res, next) => {
  try {
    const roomId = req.params.roomId;
    const data = await synapseRequest(
      'GET',
      `/_synapse/admin/v1/rooms/${encodeURIComponent(roomId)}/members`
    );
    res.json(data || {});
  } catch (err) {
    next(err);
  }
});

app.get('/api/rooms/:roomId/details', async (req, res, next) => {
  try {
    const roomId = req.params.roomId;
    const data = await synapseRequest(
      'GET',
      `/_synapse/admin/v1/rooms/${encodeURIComponent(roomId)}`
    );
    res.json(data || {});
  } catch (err) {
    next(err);
  }
});

app.get('/api/rooms/:roomId/state', async (req, res, next) => {
  try {
    const roomId = req.params.roomId;
    const data = await synapseRequest(
      'GET',
      `/_synapse/admin/v1/rooms/${encodeURIComponent(roomId)}/state`
    );
    res.json(data || {});
  } catch (err) {
    next(err);
  }
});

app.post('/api/rooms/:roomId/kick', async (req, res, next) => {
  const startedAt = Date.now();
  try {
    const roomId = req.params.roomId;
    const { user_id, reason } = req.body || {};

    if (!user_id) {
      logAdminAction({
        req,
        action: 'room.kick_member',
        title: 'Kick user from room',
        module: 'rooms',
        risk: 'destructive',
        status: 'error',
        targetType: 'room',
        targetId: roomId,
        request: {
          user_id: null
        },
        error: { message: 'user_id is required.', status: 400 },
        startedAt,
        httpStatus: 400
      });
      return res.status(400).json({ error: 'user_id is required.' });
    }

    const data = await synapseRequest(
      'POST',
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/kick`,
      {
        user_id,
        reason: reason || undefined
      }
    );

    logAdminAction({
      req,
      action: 'room.kick_member',
      title: 'Kick user from room',
      module: 'rooms',
      risk: 'destructive',
      status: 'success',
      targetType: 'room_member',
      targetId: `${roomId}:${user_id}`,
      request: {
        room_id: roomId,
        user_id,
        has_reason: Boolean(reason)
      },
      result: {
        kicked: true
      },
      startedAt
    });

    res.json(data || { ok: true });
  } catch (err) {
    logAdminAction({
      req,
      action: 'room.kick_member',
      title: 'Kick user from room',
      module: 'rooms',
      risk: 'destructive',
      status: 'error',
      targetType: 'room_member',
      targetId: `${req.params.roomId}:${req.body?.user_id || 'unknown'}`,
      request: {
        room_id: req.params.roomId,
        user_id: req.body?.user_id || null,
        has_reason: Boolean(req.body?.reason)
      },
      error: err,
      startedAt
    });
    next(err);
  }
});

app.post('/api/rooms/:roomId/power_level', async (req, res, next) => {
  const startedAt = Date.now();
  try {
    const roomId = req.params.roomId;
    const { user_id, level } = req.body || {};

    if (!user_id || typeof level !== 'number') {
      logAdminAction({
        req,
        action: 'room.set_power_level',
        title: 'Change room power level',
        module: 'rooms',
        risk: 'guarded',
        status: 'error',
        targetType: 'room_member',
        targetId: `${roomId}:${user_id || 'unknown'}`,
        request: {
          room_id: roomId,
          user_id: user_id || null,
          level: typeof level === 'number' ? level : null
        },
        error: { message: 'user_id and numeric level are required.', status: 400 },
        startedAt,
        httpStatus: 400
      });
      return res.status(400).json({ error: 'user_id and numeric level are required.' });
    }

    let content = null;

    try {
      content = await synapseRequest(
        'GET',
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.power_levels`
      );
    } catch (err) {
      const state = await synapseRequest(
        'GET',
        `/_synapse/admin/v1/rooms/${encodeURIComponent(roomId)}/state`
      );
      const events = Array.isArray(state?.state) ? state.state : [];
      const powerEvent = events.find((event) => event?.type === 'm.room.power_levels' && event?.state_key === '');
      content = powerEvent?.content || {};
    }

    const users = { ...(content?.users || {}) };
    users[user_id] = level;

    const updated = {
      ...content,
      users
    };

    const data = await synapseRequest(
      'PUT',
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.power_levels`,
      updated
    );

    logAdminAction({
      req,
      action: 'room.set_power_level',
      title: 'Change room power level',
      module: 'rooms',
      risk: 'guarded',
      status: 'success',
      targetType: 'room_member',
      targetId: `${roomId}:${user_id}`,
      request: {
        room_id: roomId,
        user_id,
        level
      },
      result: {
        updated: true
      },
      startedAt
    });

    res.json(data || { ok: true });
  } catch (err) {
    logAdminAction({
      req,
      action: 'room.set_power_level',
      title: 'Change room power level',
      module: 'rooms',
      risk: 'guarded',
      status: 'error',
      targetType: 'room_member',
      targetId: `${req.params.roomId}:${req.body?.user_id || 'unknown'}`,
      request: {
        room_id: req.params.roomId,
        user_id: req.body?.user_id || null,
        level: typeof req.body?.level === 'number' ? req.body.level : null
      },
      error: err,
      startedAt
    });
    next(err);
  }
});

app.post('/api/rooms/:roomId/redact_user', async (req, res, next) => {
  const startedAt = Date.now();
  try {
    const roomId = req.params.roomId;
    const { user_id, reason, limit } = req.body || {};

    if (!user_id) {
      logAdminAction({
        req,
        action: 'room.redact_user_messages',
        title: 'Redact user messages from room',
        module: 'rooms',
        risk: 'destructive',
        status: 'error',
        targetType: 'room_member',
        targetId: `${roomId}:unknown`,
        request: {
          room_id: roomId,
          user_id: null
        },
        error: { message: 'user_id is required.', status: 400 },
        startedAt,
        httpStatus: 400
      });
      return res.status(400).json({ error: 'user_id is required.' });
    }

    const body = {
      rooms: [roomId]
    };

    if (reason) {
      body.reason = reason;
    }

    if (typeof limit === 'number') {
      body.limit = limit;
    }

    const data = await synapseRequest(
      'POST',
      `/_synapse/admin/v1/users/${encodeURIComponent(user_id)}/redact`,
      body
    );

    logAdminAction({
      req,
      action: 'room.redact_user_messages',
      title: 'Redact user messages from room',
      module: 'rooms',
      risk: 'destructive',
      status: 'success',
      targetType: 'room_member',
      targetId: `${roomId}:${user_id}`,
      request: {
        room_id: roomId,
        user_id,
        has_reason: Boolean(reason),
        limit: typeof limit === 'number' ? limit : null
      },
      result: {
        redaction_task: data || null
      },
      startedAt
    });

    res.json(data || { ok: true });
  } catch (err) {
    logAdminAction({
      req,
      action: 'room.redact_user_messages',
      title: 'Redact user messages from room',
      module: 'rooms',
      risk: 'destructive',
      status: 'error',
      targetType: 'room_member',
      targetId: `${req.params.roomId}:${req.body?.user_id || 'unknown'}`,
      request: {
        room_id: req.params.roomId,
        user_id: req.body?.user_id || null,
        has_reason: Boolean(req.body?.reason),
        limit: typeof req.body?.limit === 'number' ? req.body.limit : null
      },
      error: err,
      startedAt
    });
    next(err);
  }
});

app.get('/api/rooms/:roomId/storage', async (req, res, next) => {
  try {
    const roomId = req.params.roomId;
    const data = await synapseRequest(
      'GET',
      '/_synapse/admin/v1/statistics/database/rooms'
    );
    const rooms = Array.isArray(data?.rooms) ? data.rooms : [];
    const match = rooms.find((room) => room.room_id === roomId);
    res.json({
      estimated_size: match?.estimated_size ?? null,
      available: Boolean(match?.estimated_size)
    });
  } catch (err) {
    res.json({
      estimated_size: null,
      available: false
    });
  }
});

app.post('/api/users/:userId/reactivate', async (req, res, next) => {
  const startedAt = Date.now();
  try {
    const userId = req.params.userId;
    const password = req.body?.password;

    const body = {
      deactivated: false
    };

    if (password) {
      body.password = password;
    }

    const data = await synapseRequest(
      'PUT',
      `/_synapse/admin/v2/users/${encodeURIComponent(userId)}`,
      body
    );

    logAdminAction({
      req,
      action: 'user.reactivate',
      title: 'Reactivate user',
      module: 'users',
      risk: 'guarded',
      status: 'success',
      targetType: 'user',
      targetId: userId,
      request: {
        has_password: Boolean(password)
      },
      result: {
        user_id: data?.name || userId,
        deactivated: Boolean(data?.deactivated)
      },
      startedAt
    });

    res.json(data || { ok: true });
  } catch (err) {
    logAdminAction({
      req,
      action: 'user.reactivate',
      title: 'Reactivate user',
      module: 'users',
      risk: 'guarded',
      status: 'error',
      targetType: 'user',
      targetId: req.params.userId,
      request: {
        has_password: Boolean(req.body?.password)
      },
      error: err,
      startedAt
    });
    next(err);
  }
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({
    error: err.message || 'Unexpected error',
    details: err.data || null
  });
});

function flushCaches() {
  persistRoomCache();
  if (actionPersistTimer) {
    clearTimeout(actionPersistTimer);
    actionPersistTimer = null;
  }
  persistActionLog();
}

process.on('SIGINT', () => {
  flushCaches();
  process.exit(0);
});

process.on('SIGTERM', () => {
  flushCaches();
  process.exit(0);
});

app.listen(PORT, () => {
  loadActionLog();
  logAdminAction({
    action: 'system.server_start',
    title: 'Admin UI server started',
    module: 'system',
    risk: 'safe',
    status: 'success',
    result: {
      port: PORT,
      server_name: SYNAPSE_SERVER_NAME
    }
  });
  console.log(`Synapse Admin UI running at http://localhost:${PORT}`);
});
