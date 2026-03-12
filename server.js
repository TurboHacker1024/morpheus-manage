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

const USERS_FETCH_LIMIT = 100;
const ROOMS_FETCH_LIMIT = 100;
const ROOM_ACTIVITY_TTL_MS = 15 * 60 * 1000;
const ROOM_ACTIVITY_STALE_MS = 60 * 60 * 1000;
const ROOM_ACTIVITY_BATCH = 10;
const ROOM_ACTIVITY_CACHE_FILE = path.join(__dirname, 'cache', 'rooms.json');

let roomActivityCache = new Map();
let roomCacheLoaded = false;
let roomRefreshInProgress = false;
let roomRefreshQueue = new Set();

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

app.get('/api/config', (req, res) => {
  res.json({
    server_name: SYNAPSE_SERVER_NAME,
    base_url: SYNAPSE_BASE_URL
  });
});

app.get('/api/users', async (req, res, next) => {
  try {
    const {
      from = '0',
      limit = '25',
      guests = 'false',
      deactivated = 'false',
      order_by = 'name',
      dir = 'f'
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

    const sorted = sortUsers(users, {
      key: String(order_by),
      dir: String(dir)
    });

    const page = sorted.slice(offset, offset + pageSize);
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
  try {
    const { from = '0', limit = '25', order_by = 'name', dir = 'f' } = req.query;
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
    const sorted = sortRooms(rooms, { key: String(order_by), dir: String(dir) });
    const page = sorted.slice(offset, offset + pageSize);
    const nextToken = offset + pageSize < sorted.length ? String(offset + pageSize) : null;

    res.json({
      rooms: page,
      next_token: nextToken,
      total: sorted.length
    });
  } catch (err) {
    next(err);
  }
});

app.post('/api/users', async (req, res, next) => {
  try {
    const { user_id, localpart, password, admin, displayname } = req.body || {};
    const resolvedUserId = user_id || (localpart ? `@${localpart}:${SYNAPSE_SERVER_NAME}` : null);

    if (!resolvedUserId) {
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

    res.json(data || { ok: true });
  } catch (err) {
    next(err);
  }
});

app.post('/api/users/:userId/deactivate', async (req, res, next) => {
  try {
    const userId = req.params.userId;
    const erase = Boolean(req.body?.erase);

    const data = await synapseRequest(
      'POST',
      `/_synapse/admin/v1/deactivate/${encodeURIComponent(userId)}`,
      { erase }
    );

    res.json(data || { ok: true });
  } catch (err) {
    next(err);
  }
});

app.post('/api/users/:userId/update', async (req, res, next) => {
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
      return res.status(400).json({ error: 'No update fields provided.' });
    }

    const data = await synapseRequest(
      'PUT',
      `/_synapse/admin/v2/users/${encodeURIComponent(userId)}`,
      body
    );

    res.json(data || { ok: true });
  } catch (err) {
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
  try {
    const roomId = req.params.roomId;
    const { user_id, reason } = req.body || {};

    if (!user_id) {
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

    res.json(data || { ok: true });
  } catch (err) {
    next(err);
  }
});

app.post('/api/rooms/:roomId/power_level', async (req, res, next) => {
  try {
    const roomId = req.params.roomId;
    const { user_id, level } = req.body || {};

    if (!user_id || typeof level !== 'number') {
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

    res.json(data || { ok: true });
  } catch (err) {
    next(err);
  }
});

app.post('/api/rooms/:roomId/redact_user', async (req, res, next) => {
  try {
    const roomId = req.params.roomId;
    const { user_id, reason, limit } = req.body || {};

    if (!user_id) {
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

    res.json(data || { ok: true });
  } catch (err) {
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

    res.json(data || { ok: true });
  } catch (err) {
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

app.listen(PORT, () => {
  console.log(`Synapse Admin UI running at http://localhost:${PORT}`);
});
