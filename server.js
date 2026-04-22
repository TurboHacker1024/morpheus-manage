const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const express = require('express');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 4173);
app.set('trust proxy', 1);

const DEFAULT_SYNAPSE_BASE_URL = normalizeSynapseBaseUrl(process.env.SYNAPSE_BASE_URL || '');
const SYNAPSE_ADMIN_TOKEN = String(process.env.SYNAPSE_ADMIN_TOKEN || '').trim() || null;
const DEFAULT_SYNAPSE_SERVER_NAME = normalizeSynapseServerName(
  process.env.SYNAPSE_SERVER_NAME || '',
  DEFAULT_SYNAPSE_BASE_URL
);

app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '12mb' }));
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
const MAX_AVATAR_UPLOAD_BYTES = Math.max(
  256 * 1024,
  Number(process.env.MAX_AVATAR_UPLOAD_BYTES || 5 * 1024 * 1024)
);
const MEDIA_QUERY_MAX_LIMIT = Math.max(100, Number(process.env.MEDIA_QUERY_MAX_LIMIT || 500));
const AUTH_COOKIE_NAME = 'morpheus_manage_session';
const AUTH_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LOGIN_FLOW_CACHE_TTL_MS = 60 * 1000;
const ENV_TOKEN_STATUS_TTL_MS = 60 * 1000;
const requestContext = new AsyncLocalStorage();

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
let synapseHealthSnapshots = new Map();
let authSessions = new Map();
let loginFlowsCache = new Map();
let envTokenStatusCache = {
  checked_at: null,
  ok: false,
  error: null,
  user_id: null,
  base_url: null,
  server_name: null
};

function normalizeSynapseBaseUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;

  try {
    const url = new URL(withScheme);
    if (!['http:', 'https:'].includes(url.protocol)) {
      return null;
    }

    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';

    const pathname = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
    return `${url.origin}${pathname}`;
  } catch (err) {
    return null;
  }
}

function deriveServerNameFromBaseUrl(baseUrl) {
  const normalizedBaseUrl = normalizeSynapseBaseUrl(baseUrl);
  if (!normalizedBaseUrl) return null;

  try {
    return new URL(normalizedBaseUrl).host || null;
  } catch (err) {
    return null;
  }
}

function normalizeSynapseServerName(value, baseUrl = null) {
  const raw = String(value || '').trim();
  if (raw) return raw;
  return deriveServerNameFromBaseUrl(baseUrl);
}

function extractServerNameFromUserId(userId) {
  const raw = String(userId || '').trim();
  if (!raw.startsWith('@')) return null;
  const separatorIndex = raw.indexOf(':');
  if (separatorIndex < 0 || separatorIndex === raw.length - 1) return null;
  return raw.slice(separatorIndex + 1).trim() || null;
}

function getConfiguredSynapseDefaults() {
  if (!DEFAULT_SYNAPSE_BASE_URL) return null;
  return {
    baseUrl: DEFAULT_SYNAPSE_BASE_URL,
    serverName: DEFAULT_SYNAPSE_SERVER_NAME || deriveServerNameFromBaseUrl(DEFAULT_SYNAPSE_BASE_URL)
  };
}

function getEnvFallbackConfig() {
  const defaults = getConfiguredSynapseDefaults();
  if (!defaults || !SYNAPSE_ADMIN_TOKEN) return null;
  return {
    ...defaults,
    accessToken: SYNAPSE_ADMIN_TOKEN
  };
}

function getContextValue(key) {
  return requestContext.getStore()?.[key] ?? null;
}

function getCurrentBaseUrl() {
  return getContextValue('baseUrl') || getConfiguredSynapseDefaults()?.baseUrl || null;
}

function getCurrentServerName() {
  const contextServerName = getContextValue('serverName');
  if (contextServerName) return contextServerName;

  const contextBaseUrl = getContextValue('baseUrl');
  if (contextBaseUrl) {
    return deriveServerNameFromBaseUrl(contextBaseUrl);
  }

  return getConfiguredSynapseDefaults()?.serverName || null;
}

function getCurrentAccessToken() {
  return getContextValue('accessToken') || getEnvFallbackConfig()?.accessToken || null;
}

function parseCookies(headerValue) {
  const cookies = {};
  const source = String(headerValue || '').trim();
  if (!source) return cookies;

  source.split(';').forEach((segment) => {
    const separatorIndex = segment.indexOf('=');
    if (separatorIndex <= 0) return;
    const key = decodeURIComponent(segment.slice(0, separatorIndex).trim());
    const value = decodeURIComponent(segment.slice(separatorIndex + 1).trim());
    cookies[key] = value;
  });

  return cookies;
}

function isSecureRequest(req) {
  if (req.secure) return true;
  const forwardedProto = String(req.get('x-forwarded-proto') || '').toLowerCase();
  return forwardedProto.split(',').map((value) => value.trim()).includes('https');
}

function buildCookieValue(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path || '/'}`);

  if (options.httpOnly !== false) parts.push('HttpOnly');
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  if (options.secure) parts.push('Secure');

  return parts.join('; ');
}

function writeSessionCookie(req, res, sessionId) {
  res.setHeader(
    'Set-Cookie',
    buildCookieValue(AUTH_COOKIE_NAME, sessionId, {
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
      secure: isSecureRequest(req),
      maxAge: Math.floor(AUTH_SESSION_TTL_MS / 1000)
    })
  );
}

function clearSessionCookie(req, res) {
  res.setHeader(
    'Set-Cookie',
    buildCookieValue(AUTH_COOKIE_NAME, '', {
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
      secure: isSecureRequest(req),
      maxAge: 0
    })
  );
}

function pruneExpiredAuthSessions() {
  const now = Date.now();
  authSessions.forEach((session, sessionId) => {
    if (!session?.expires_at || session.expires_at <= now) {
      authSessions.delete(sessionId);
    }
  });
}

function createAuthSession({
  mode,
  accessToken = null,
  userId = null,
  displayName = null,
  baseUrl = null,
  serverName = null
}) {
  const now = Date.now();
  const sessionId = crypto.randomBytes(32).toString('hex');
  const session = {
    id: sessionId,
    mode,
    access_token: accessToken,
    user_id: userId,
    display_name: displayName,
    base_url: normalizeSynapseBaseUrl(baseUrl),
    server_name: normalizeSynapseServerName(serverName, baseUrl),
    created_at: now,
    last_used_at: now,
    expires_at: now + AUTH_SESSION_TTL_MS
  };
  authSessions.set(sessionId, session);
  return session;
}

function replaceAuthSession(req, res, sessionData) {
  if (req.auth?.sessionId) {
    deleteAuthSession(req.auth.sessionId);
  }
  const session = createAuthSession(sessionData);
  writeSessionCookie(req, res, session.id);
  return session;
}

function deleteAuthSession(sessionId) {
  if (!sessionId) return null;
  const session = authSessions.get(sessionId) || null;
  authSessions.delete(sessionId);
  return session;
}

function getAuthSessionFromRequest(req) {
  pruneExpiredAuthSessions();

  const cookies = parseCookies(req.headers.cookie);
  const sessionId = cookies[AUTH_COOKIE_NAME];
  if (!sessionId) return null;

  const session = authSessions.get(sessionId);
  if (!session) return null;
  if (!session.expires_at || session.expires_at <= Date.now()) {
    authSessions.delete(sessionId);
    return null;
  }

  session.last_used_at = Date.now();
  return session;
}

function resolveRequestAuth(req) {
  const session = getAuthSessionFromRequest(req);
  if (!session) {
    return {
      authenticated: false,
      mode: null,
      accessToken: null,
      baseUrl: null,
      serverName: null,
      sessionId: null,
      userId: null,
      displayName: null
    };
  }

  const envConfig = getEnvFallbackConfig();
  const accessToken = session.mode === 'env_token' ? envConfig?.accessToken || null : session.access_token || null;
  const baseUrl =
    session.mode === 'env_token'
      ? normalizeSynapseBaseUrl(session.base_url || envConfig?.baseUrl)
      : normalizeSynapseBaseUrl(session.base_url);
  const serverName = normalizeSynapseServerName(
    session.server_name || extractServerNameFromUserId(session.user_id),
    baseUrl || envConfig?.baseUrl || null
  );

  if (!accessToken || !baseUrl) {
    authSessions.delete(session.id);
    return {
      authenticated: false,
      mode: null,
      accessToken: null,
      baseUrl: null,
      serverName: null,
      sessionId: null,
      userId: null,
      displayName: null
    };
  }

  return {
    authenticated: true,
    mode: session.mode,
    accessToken,
    baseUrl,
    serverName,
    sessionId: session.id,
    userId: session.user_id || null,
    displayName: session.display_name || null
  };
}

function sanitizeNextPath(value) {
  const raw = String(value || '').trim();
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/index.html';
  if (raw === '/login.html') return '/index.html';
  return raw;
}

function buildLoginRedirectPath(nextPath) {
  const sanitized = sanitizeNextPath(nextPath);
  if (!sanitized || sanitized === '/index.html') return '/login.html';
  return `/login.html?next=${encodeURIComponent(sanitized)}`;
}

function isProtectedHtmlRequest(pathname) {
  return pathname === '/' || pathname.endsWith('.html');
}

function getExplicitSynapseConfigFromRequest(req) {
  const rawBaseUrl =
    req.body?.homeserver ||
    req.body?.base_url ||
    req.query?.homeserver ||
    req.query?.base_url ||
    '';
  const rawServerName = req.body?.server_name || req.query?.server_name || '';
  const baseUrl = normalizeSynapseBaseUrl(rawBaseUrl);
  if (!baseUrl) return null;

  return {
    baseUrl,
    serverName: normalizeSynapseServerName(rawServerName, baseUrl)
  };
}

function resolveSynapseConfigForRequest(
  req,
  { allowSession = true, allowExplicit = true, allowDefaults = true } = {}
) {
  if (allowSession && req.auth?.authenticated && req.auth.baseUrl) {
    return {
      baseUrl: req.auth.baseUrl,
      serverName: req.auth.serverName || deriveServerNameFromBaseUrl(req.auth.baseUrl)
    };
  }

  if (allowExplicit) {
    const explicitConfig = getExplicitSynapseConfigFromRequest(req);
    if (explicitConfig) {
      return explicitConfig;
    }
  }

  if (allowDefaults) {
    return getConfiguredSynapseDefaults();
  }

  return null;
}

async function fetchMatrixLoginFlows(force = false, options = {}) {
  const baseUrl = normalizeSynapseBaseUrl(options.baseUrl || getCurrentBaseUrl());
  if (!baseUrl) {
    const error = new Error('No homeserver URL was provided.');
    error.status = 400;
    throw error;
  }

  const now = Date.now();
  const cached = loginFlowsCache.get(baseUrl) || null;
  const cacheIsFresh =
    !force &&
    cached?.fetched_at &&
    now - Number(cached.fetched_at) < LOGIN_FLOW_CACHE_TTL_MS;

  if (cacheIsFresh && ((cached?.flows || []).length || cached?.error)) {
    if (cached?.error) {
      throw cached.error;
    }
    return cached.flows;
  }

  try {
    const data = await synapseRequest('GET', '/_matrix/client/v3/login', null, null, {
      accessToken: null,
      baseUrl
    });
    const flows = Array.isArray(data?.flows) ? data.flows : [];
    loginFlowsCache.set(baseUrl, {
      fetched_at: now,
      flows,
      error: null
    });
    return flows;
  } catch (err) {
    loginFlowsCache.set(baseUrl, {
      fetched_at: now,
      flows: [],
      error: err
    });
    throw err;
  }
}

async function getEnvTokenStatus(force = false) {
  const envConfig = getEnvFallbackConfig();
  if (!envConfig) {
    return {
      checked_at: Date.now(),
      ok: false,
      error: 'No preconfigured fallback admin token is available.',
      user_id: null,
      base_url: null,
      server_name: null
    };
  }

  const now = Date.now();
  const cacheIsFresh =
    !force &&
    envTokenStatusCache.base_url === envConfig.baseUrl &&
    envTokenStatusCache.checked_at &&
    now - Number(envTokenStatusCache.checked_at) < ENV_TOKEN_STATUS_TTL_MS;

  if (cacheIsFresh) {
    return envTokenStatusCache;
  }

  try {
    await synapseRequest('GET', '/_synapse/admin/v1/server_version', null, null, {
      accessToken: envConfig.accessToken,
      baseUrl: envConfig.baseUrl
    });

    let userId = null;
    try {
      const whoami = await synapseRequest('GET', '/_matrix/client/v3/account/whoami', null, null, {
        accessToken: envConfig.accessToken,
        baseUrl: envConfig.baseUrl
      });
      userId = String(whoami?.user_id || '').trim() || null;
    } catch (err) {
      userId = null;
    }

    envTokenStatusCache = {
      checked_at: Date.now(),
      ok: true,
      error: null,
      user_id: userId,
      base_url: envConfig.baseUrl,
      server_name: extractServerNameFromUserId(userId) || envConfig.serverName || null
    };
  } catch (err) {
    envTokenStatusCache = {
      checked_at: Date.now(),
      ok: false,
      error: err.message || 'Fallback admin token check failed.',
      user_id: null,
      base_url: envConfig.baseUrl,
      server_name: envConfig.serverName || null
    };
  }

  return envTokenStatusCache;
}

async function tryAutoAuthenticateWithEnvToken(req, res) {
  const envConfig = getEnvFallbackConfig();
  if (req.auth?.authenticated || !envConfig) {
    return false;
  }

  const envStatus = await getEnvTokenStatus();
  if (!envStatus.ok) {
    return false;
  }

  const session = replaceAuthSession(req, res, {
    mode: 'env_token',
    accessToken: null,
    userId: envStatus.user_id || null,
    displayName: 'Configured admin token',
    baseUrl: envStatus.base_url || envConfig.baseUrl,
    serverName: envStatus.server_name || envConfig.serverName || null
  });

  req.auth = {
    authenticated: true,
    mode: session.mode,
    accessToken: envConfig.accessToken,
    baseUrl: session.base_url || envStatus.base_url || null,
    serverName: session.server_name || envStatus.server_name || null,
    sessionId: session.id,
    userId: session.user_id || null,
    displayName: session.display_name || null
  };

  return true;
}

function getLocalpart(userId) {
  if (!userId) return '';
  const trimmed = userId.startsWith('@') ? userId.slice(1) : userId;
  const parts = trimmed.split(':');
  return parts[0] || trimmed;
}

function extractRoomMemberIds(payload) {
  if (!payload) return [];

  if (Array.isArray(payload.members)) {
    return payload.members
      .map((member) => (typeof member === 'string' ? member : member?.user_id))
      .filter(Boolean);
  }

  if (Array.isArray(payload.joined)) {
    return payload.joined
      .map((member) => (typeof member === 'string' ? member : member?.user_id))
      .filter(Boolean);
  }

  if (payload.joined && typeof payload.joined === 'object') {
    return Object.keys(payload.joined);
  }

  return [];
}

function isAlreadyJoinedError(err) {
  const text = String(err?.data?.error || err?.message || '').toLowerCase();
  if (!text) return false;
  return text.includes('already in room') || text.includes('already joined');
}

function isNoEventToPurgeError(err) {
  const text = String(err?.data?.error || err?.message || '').toLowerCase();
  return err?.status === 404 && text.includes('no event to be purged');
}

async function joinRoomAsModeratorUser(roomId, userId) {
  const encodedRoomId = encodeURIComponent(roomId);
  const attempts = [];
  const methods = [
    {
      key: 'admin_v1_join',
      endpoint: `/_synapse/admin/v1/join/${encodedRoomId}`,
      body: { user_id: userId }
    },
    {
      key: 'client_v3_join',
      endpoint: `/_matrix/client/v3/join/${encodedRoomId}`,
      body: {}
    },
    {
      key: 'client_r0_join',
      endpoint: `/_matrix/client/r0/join/${encodedRoomId}`,
      body: {}
    }
  ];

  for (const method of methods) {
    try {
      await synapseRequest('POST', method.endpoint, method.body);
      return {
        method: method.key,
        attempts
      };
    } catch (err) {
      if (isAlreadyJoinedError(err)) {
        return {
          method: method.key,
          already_joined: true,
          attempts
        };
      }

      attempts.push({
        method: method.key,
        status: err.status || null,
        message: err.message || 'Join failed.',
        details: sanitizeForLog(err.data || null)
      });

      if (err.status !== 404) {
        err.joinAttempts = attempts;
        throw err;
      }
    }
  }

  const notFoundError = new Error('No supported join endpoint was found on this Synapse instance.');
  notFoundError.status = 404;
  notFoundError.data = { attempts };
  throw notFoundError;
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

function buildMxcUri(server, mediaId) {
  const origin = String(server || '').trim();
  const id = String(mediaId || '').trim();
  if (!origin || !id) return null;
  return `mxc://${origin}/${id}`;
}

function parseSortDirection(value, fallback = 'f') {
  return String(value || '').toLowerCase() === 'b' ? 'b' : fallback;
}

function parsePositiveInteger(value, fallback, min = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.floor(numeric));
}

function parseBooleanInput(value, fallback = false) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parsePagedQuery(req, defaults = {}) {
  const defaultLimit = parsePositiveInteger(defaults.limit, 50, 1);
  const maxLimit = parsePositiveInteger(defaults.maxLimit, MEDIA_QUERY_MAX_LIMIT, 1);
  const defaultFrom = parsePositiveInteger(defaults.from, 0, 0);
  const from = parsePositiveInteger(req.query?.from, defaultFrom, 0);
  const limit = Math.min(maxLimit, parsePositiveInteger(req.query?.limit, defaultLimit, 1));
  return { from, limit };
}

function normalizeOrderBy(value, allowed, fallback) {
  const normalized = String(value || '').trim().toLowerCase();
  return allowed.includes(normalized) ? normalized : fallback;
}

function filterSearchTerm(items, query, mapper) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return items;
  return items.filter((item) => String(mapper(item) || '').toLowerCase().includes(q));
}

function getMediaPreviewPayload(mxc) {
  return {
    mxc: mxc || null,
    thumbnail_url: mxc ? buildAvatarThumbnailPath(mxc, 128) : null,
    download_url: mxc ? buildAvatarDownloadPath(mxc) : null
  };
}

function parseMediaReference(value, fallbackOrigin = null) {
  if (!value) return null;

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;

    if (trimmed.startsWith('mxc://')) {
      const parsed = parseMxcUri(trimmed);
      if (!parsed) return null;
      return {
        origin: parsed.server,
        media_id: parsed.mediaId,
        mxc: trimmed
      };
    }

    if (trimmed.includes('/')) {
      const slashIndex = trimmed.indexOf('/');
      const origin = trimmed.slice(0, slashIndex);
      const mediaId = trimmed.slice(slashIndex + 1);
      if (origin && mediaId) {
        return {
          origin,
          media_id: mediaId,
          mxc: buildMxcUri(origin, mediaId)
        };
      }
    }

    if (fallbackOrigin) {
      return {
        origin: fallbackOrigin,
        media_id: trimmed,
        mxc: buildMxcUri(fallbackOrigin, trimmed)
      };
    }

    return null;
  }

  if (typeof value === 'object') {
    const mxcValue = value.mxc || value.mxc_uri || value.content_uri || null;
    if (typeof mxcValue === 'string' && mxcValue.startsWith('mxc://')) {
      const parsed = parseMxcUri(mxcValue);
      if (parsed) {
        return {
          origin: parsed.server,
          media_id: parsed.mediaId,
          mxc: mxcValue
        };
      }
    }

    const origin = value.origin || value.server_name || fallbackOrigin || null;
    const mediaId = value.media_id || value.id || null;
    if (origin && mediaId) {
      return {
        origin,
        media_id: mediaId,
        mxc: buildMxcUri(origin, mediaId)
      };
    }
  }

  return null;
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

function buildSynapseUrl(endpoint, query, options = {}) {
  const baseUrl = normalizeSynapseBaseUrl(options.baseUrl || getCurrentBaseUrl());
  if (!baseUrl) {
    const error = new Error('No homeserver URL is configured for this request.');
    error.status = 400;
    throw error;
  }

  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
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

async function synapseRequest(method, endpoint, body, query, options = {}) {
  const url = buildSynapseUrl(endpoint, query, options);
  const headers = {
    'Content-Type': 'application/json'
  };
  const hasExplicitToken = Object.prototype.hasOwnProperty.call(options, 'accessToken');
  const accessToken = hasExplicitToken ? options.accessToken : getCurrentAccessToken();

  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }

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

function isSupportedAvatarContentType(contentType) {
  const value = String(contentType || '').toLowerCase().trim();
  return value.startsWith('image/');
}

function decodeBase64Payload(payload) {
  const value = String(payload || '').trim();
  if (!value) return null;
  const commaIndex = value.indexOf(',');
  const normalized = commaIndex >= 0 ? value.slice(commaIndex + 1) : value;
  return Buffer.from(normalized, 'base64');
}

async function uploadSynapseMedia(buffer, contentType, filename) {
  const uploadUrl = buildSynapseUrl(
    '/_matrix/media/v3/upload',
    {
      filename: filename || 'avatar'
    }
  );
  const accessToken = getCurrentAccessToken();

  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      'Content-Type': contentType || 'application/octet-stream'
    },
    body: buffer
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
    const error = new Error(data?.error || `Media upload failed (${response.status})`);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  const contentUri = data?.content_uri || data?.content_uri?.toString?.();
  if (!contentUri || typeof contentUri !== 'string' || !contentUri.startsWith('mxc://')) {
    const error = new Error('Upload succeeded but no content_uri returned.');
    error.status = 500;
    error.data = data;
    throw error;
  }

  return contentUri;
}

function buildAvatarPayload(avatarUrl) {
  return {
    avatar_url: avatarUrl || null,
    avatar_thumbnail_url: buildAvatarThumbnailPath(avatarUrl, 48),
    avatar_download_url: buildAvatarDownloadPath(avatarUrl)
  };
}

function parseMaybeJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    return text;
  }
}

function getMediaEndpointCandidates(parsed, kind) {
  const server = encodeURIComponent(parsed.server);
  const mediaId = encodeURIComponent(parsed.mediaId);

  if (kind === 'thumbnail') {
    return [
      `/_matrix/client/v1/media/thumbnail/${server}/${mediaId}`,
      `/_matrix/media/v3/thumbnail/${server}/${mediaId}`,
      `/_matrix/media/r0/thumbnail/${server}/${mediaId}`
    ];
  }

  return [
    `/_matrix/client/v1/media/download/${server}/${mediaId}`,
    `/_matrix/media/v3/download/${server}/${mediaId}`,
    `/_matrix/media/r0/download/${server}/${mediaId}`
  ];
}

async function tryFetchSynapseMedia({ parsed, kind, query = null }) {
  const attempts = [];
  const candidates = getMediaEndpointCandidates(parsed, kind);
  const accessToken = getCurrentAccessToken();

  for (const endpoint of candidates) {
    const url = buildSynapseUrl(endpoint, query);
    try {
      const upstream = await fetch(url, {
        headers: accessToken
          ? {
              Authorization: `Bearer ${accessToken}`
            }
          : undefined
      });

      if (upstream.ok) {
        return { upstream, attempts, resolved_url: url };
      }

      const text = await upstream.text();
      attempts.push({
        url,
        status: upstream.status,
        details: parseMaybeJson(text)
      });
    } catch (err) {
      attempts.push({
        url,
        status: 0,
        details: err.message || 'Network error'
      });
    }
  }

  const lastStatus = attempts.length ? attempts[attempts.length - 1].status : 502;
  return {
    upstream: null,
    attempts,
    status: Number(lastStatus) || 502
  };
}

async function sendProxiedMediaResponse(res, upstream, fallbackType) {
  const contentType = upstream.headers.get('content-type') || fallbackType || 'application/octet-stream';
  const cacheControl = upstream.headers.get('cache-control') || 'public, max-age=3600';
  const arrayBuffer = await upstream.arrayBuffer();
  const body = Buffer.from(arrayBuffer);

  res.set('Content-Type', contentType);
  res.set('Cache-Control', cacheControl);
  res.send(body);
}

async function fetchMediaMetadata(origin, mediaId, options = {}) {
  const { allowNotFound = false } = options;
  try {
    const data = await synapseRequest(
      'GET',
      `/_synapse/admin/v1/media/${encodeURIComponent(origin)}/${encodeURIComponent(mediaId)}`
    );
    return data || {};
  } catch (err) {
    if (allowNotFound && err.status === 404) {
      return null;
    }
    throw err;
  }
}

function buildMediaItem(origin, mediaId, metadata) {
  const mxc = buildMxcUri(origin, mediaId);
  const currentServerName = getCurrentServerName();
  return {
    origin: origin || null,
    media_id: mediaId || null,
    ...getMediaPreviewPayload(mxc),
    is_local: String(origin || '').toLowerCase() === String(currentServerName || '').toLowerCase(),
    media_type: metadata?.media_type || null,
    media_length: Number(metadata?.media_length || 0),
    upload_name: metadata?.upload_name || null,
    created_ts: Number(metadata?.created_ts || 0) || null,
    last_access_ts: Number(metadata?.last_access_ts || 0) || null,
    quarantined_by: metadata?.quarantined_by || null,
    safe_from_quarantine: Boolean(metadata?.safe_from_quarantine)
  };
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
  const baseUrl = normalizeSynapseBaseUrl(getCurrentBaseUrl());
  if (!baseUrl) {
    return {
      checked_at: Date.now(),
      ok: false,
      latency_ms: null,
      version: null,
      error: 'No homeserver URL is configured for this session.'
    };
  }

  const now = Date.now();
  const cached = synapseHealthSnapshots.get(baseUrl) || null;
  const isFresh =
    cached?.checked_at &&
    now - Number(cached.checked_at) < SYNAPSE_HEALTH_CACHE_TTL_MS;

  if (!force && isFresh) {
    return cached;
  }

  const startedAt = Date.now();
  try {
    const data = await synapseRequest('GET', '/_synapse/admin/v1/server_version');
    const snapshot = {
      checked_at: Date.now(),
      ok: true,
      latency_ms: Date.now() - startedAt,
      version: data?.server_version || null,
      error: null
    };
    synapseHealthSnapshots.set(baseUrl, snapshot);
    return snapshot;
  } catch (err) {
    const snapshot = {
      checked_at: Date.now(),
      ok: false,
      latency_ms: Date.now() - startedAt,
      version: null,
      error: err.message || 'Synapse health check failed'
    };
    synapseHealthSnapshots.set(baseUrl, snapshot);
    return snapshot;
  }
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

app.use((req, res, next) => {
  req.auth = resolveRequestAuth(req);
  next();
});

app.use((req, res, next) => {
  void (async () => {
    const pathname = req.path || '/';

    if (
      !req.auth?.authenticated &&
      pathname !== '/login' &&
      pathname !== '/login.html' &&
      !pathname.startsWith('/api/') &&
      isProtectedHtmlRequest(pathname)
    ) {
      await tryAutoAuthenticateWithEnvToken(req, res);
    }

    if (pathname === '/login') {
      if (req.auth?.authenticated) {
        return res.redirect(sanitizeNextPath(req.query?.next || '/index.html'));
      }
      return res.redirect(buildLoginRedirectPath(req.query?.next || '/index.html'));
    }

    if (pathname === '/login.html') {
      if (req.auth?.authenticated) {
        return res.redirect(sanitizeNextPath(req.query?.next || '/index.html'));
      }
      return next();
    }

    if (pathname.startsWith('/api/auth/')) {
      return next();
    }

    if (pathname.startsWith('/api/')) {
      if (!req.auth?.authenticated) {
        return res.status(401).json({
          error: 'Authentication required.',
          login_required: true,
          login_url: buildLoginRedirectPath(req.originalUrl || '/index.html')
        });
      }

      return requestContext.run(
        {
          accessToken: req.auth.accessToken,
          baseUrl: req.auth.baseUrl,
          serverName: req.auth.serverName,
          mode: req.auth.mode,
          sessionId: req.auth.sessionId,
          userId: req.auth.userId
        },
        () => next()
      );
    }

    if (!req.auth?.authenticated && isProtectedHtmlRequest(pathname)) {
      return res.redirect(buildLoginRedirectPath(req.originalUrl || pathname));
    }

    if (pathname === '/') {
      return res.redirect('/index.html');
    }

    next();
  })().catch(next);
});

app.get('/api/auth/status', async (req, res) => {
  const synapseConfig = resolveSynapseConfigForRequest(req, {
    allowSession: true,
    allowExplicit: !req.auth?.authenticated,
    allowDefaults: true
  });
  let flows = [];
  let flowError = null;
  const envStatus = await getEnvTokenStatus();

  if (synapseConfig?.baseUrl) {
    try {
      flows = await fetchMatrixLoginFlows(false, { baseUrl: synapseConfig.baseUrl });
    } catch (err) {
      flowError = err.message || 'Unable to fetch login flows.';
    }
  }

  const passwordSupported = flows.some((flow) => flow?.type === 'm.login.password');
  const ssoSupported = flows.some((flow) => flow?.type === 'm.login.sso');

  res.json({
    authenticated: Boolean(req.auth?.authenticated),
    auth_mode: req.auth?.mode || null,
    server_name: synapseConfig?.serverName || null,
    base_url: synapseConfig?.baseUrl || null,
    env_fallback_available: envStatus.ok,
    env_fallback_configured: Boolean(getEnvFallbackConfig()),
    env_fallback_error: envStatus.ok ? null : envStatus.error,
    session: req.auth?.authenticated
      ? {
          user_id: req.auth.userId || null,
          display_name: req.auth.displayName || null,
          base_url: req.auth.baseUrl || null,
          server_name: req.auth.serverName || null
        }
      : null,
    login: {
      password_supported: synapseConfig?.baseUrl ? passwordSupported : null,
      sso_supported: ssoSupported,
      flows: flows.map((flow) => flow?.type).filter(Boolean),
      error: flowError,
      homeserver_required: !synapseConfig?.baseUrl
    }
  });
});

app.post('/api/auth/login', async (req, res, next) => {
  const startedAt = Date.now();
  let loginFlowProbeError = null;
  try {
    const synapseConfig = resolveSynapseConfigForRequest(req, {
      allowSession: false,
      allowExplicit: true,
      allowDefaults: true
    });
    const user = String(req.body?.user || '').trim();
    const password = String(req.body?.password || '');

    if (!synapseConfig?.baseUrl) {
      const error = new Error('Provide a homeserver URL before signing in.');
      error.status = 400;
      throw error;
    }

    if (!user || !password) {
      const error = new Error('Provide a Matrix user ID or localpart and a password.');
      error.status = 400;
      throw error;
    }

    let flows = [];

    try {
      flows = await fetchMatrixLoginFlows(false, { baseUrl: synapseConfig.baseUrl });
    } catch (err) {
      loginFlowProbeError = err;
    }

    if (!loginFlowProbeError && !flows.some((flow) => flow?.type === 'm.login.password')) {
      const error = new Error('This homeserver does not advertise password login.');
      error.status = 400;
      throw error;
    }

    const loginData = await synapseRequest(
      'POST',
      '/_matrix/client/v3/login',
      {
        type: 'm.login.password',
        identifier: {
          type: 'm.id.user',
          user
        },
        password,
        initial_device_display_name: 'Morpheus Manage'
      },
      null,
      {
        accessToken: null,
        baseUrl: synapseConfig.baseUrl
      }
    );

    const accessToken = String(loginData?.access_token || '').trim();
    const userId = String(loginData?.user_id || '').trim();
    const resolvedServerName =
      extractServerNameFromUserId(userId) || synapseConfig.serverName || deriveServerNameFromBaseUrl(synapseConfig.baseUrl);

    if (!accessToken || !userId) {
      const error = new Error('Login succeeded but no access token was returned.');
      error.status = 502;
      throw error;
    }

    const adminInfo = await synapseRequest(
      'GET',
      `/_synapse/admin/v2/users/${encodeURIComponent(userId)}`,
      null,
      null,
      {
        accessToken,
        baseUrl: synapseConfig.baseUrl
      }
    );

    if (!adminInfo?.admin) {
      const error = new Error('This Matrix account is not a Synapse administrator.');
      error.status = 403;
      throw error;
    }

    replaceAuthSession(req, res, {
      mode: 'matrix_login',
      accessToken,
      userId,
      displayName: adminInfo?.displayname || null,
      baseUrl: synapseConfig.baseUrl,
      serverName: resolvedServerName
    });

    logAdminAction({
      req,
      action: 'auth.login',
      title: 'Sign in with Matrix admin account',
      module: 'system',
      risk: 'guarded',
      status: 'success',
      targetType: 'user',
      targetId: userId,
      request: {
        user,
        homeserver: synapseConfig.baseUrl,
        login_flow_probe_error: loginFlowProbeError?.message || null
      },
      result: {
        user_id: userId,
        auth_mode: 'matrix_login',
        base_url: synapseConfig.baseUrl,
        server_name: resolvedServerName
      },
      startedAt
    });

    res.json({
      ok: true,
      auth_mode: 'matrix_login',
      session: {
        user_id: userId,
        display_name: adminInfo?.displayname || null,
        base_url: synapseConfig.baseUrl,
        server_name: resolvedServerName
      }
    });
  } catch (err) {
    const requestConfig = resolveSynapseConfigForRequest(req, {
      allowSession: false,
      allowExplicit: true,
      allowDefaults: true
    });
    logAdminAction({
      req,
      action: 'auth.login',
      title: 'Sign in with Matrix admin account',
      module: 'system',
      risk: 'guarded',
      status: 'error',
      targetType: 'user',
      targetId: String(req.body?.user || '').trim() || null,
      request: {
        user: String(req.body?.user || '').trim() || null,
        homeserver: requestConfig?.baseUrl || null,
        login_flow_probe_error: loginFlowProbeError?.message || null
      },
      error: err,
      startedAt
    });
    next(err);
  }
});

app.post('/api/auth/use-env', async (req, res, next) => {
  const startedAt = Date.now();
  try {
    const envStatus = await getEnvTokenStatus(true);
    if (!envStatus.ok) {
      const error = new Error(envStatus.error || 'Fallback admin token check failed.');
      error.status = 400;
      throw error;
    }

    const envUserId = envStatus.user_id || null;

    replaceAuthSession(req, res, {
      mode: 'env_token',
      accessToken: null,
      userId: envUserId,
      displayName: 'Configured admin token',
      baseUrl: envStatus.base_url || null,
      serverName: envStatus.server_name || null
    });

    logAdminAction({
      req,
      action: 'auth.use_env_token',
      title: 'Use configured admin token',
      module: 'system',
      risk: 'guarded',
      status: 'success',
      targetType: 'session',
      targetId: 'env_token',
      result: {
        auth_mode: 'env_token',
        user_id: envUserId,
        base_url: envStatus.base_url || null,
        server_name: envStatus.server_name || null
      },
      startedAt
    });

    res.json({
      ok: true,
      auth_mode: 'env_token',
      session: {
        user_id: envUserId,
        display_name: 'Configured admin token',
        base_url: envStatus.base_url || null,
        server_name: envStatus.server_name || null
      }
    });
  } catch (err) {
    logAdminAction({
      req,
      action: 'auth.use_env_token',
      title: 'Use configured admin token',
      module: 'system',
      risk: 'guarded',
      status: 'error',
      targetType: 'session',
      targetId: 'env_token',
      error: err,
      startedAt
    });
    next(err);
  }
});

app.post('/api/auth/logout', async (req, res, next) => {
  const startedAt = Date.now();
  const existingSession = req.auth?.sessionId ? authSessions.get(req.auth.sessionId) || null : null;

  try {
    if (existingSession?.mode === 'matrix_login' && existingSession.access_token) {
      try {
        await synapseRequest('POST', '/_matrix/client/v3/logout', {}, null, {
          accessToken: existingSession.access_token,
          baseUrl: existingSession.base_url || req.auth?.baseUrl || null
        });
      } catch (err) {
        // Best-effort logout. The local session is still cleared below.
      }
    }

    if (req.auth?.sessionId) {
      deleteAuthSession(req.auth.sessionId);
    }
    clearSessionCookie(req, res);

    logAdminAction({
      req,
      action: 'auth.logout',
      title: 'Sign out admin session',
      module: 'system',
      risk: 'safe',
      status: 'success',
      targetType: 'session',
      targetId: req.auth?.sessionId || null,
      result: {
        auth_mode: existingSession?.mode || null,
        user_id: existingSession?.user_id || null
      },
      startedAt
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.get('/api/config', async (req, res) => {
  const envStatus = await getEnvTokenStatus();

  res.json({
    server_name: req.auth?.serverName || null,
    base_url: req.auth?.baseUrl || null,
    auth: {
      mode: req.auth?.mode || null,
      env_fallback_available: envStatus.ok,
      env_fallback_configured: Boolean(getEnvFallbackConfig()),
      env_fallback_error: envStatus.ok ? null : envStatus.error
    }
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
    const currentServerName = getCurrentServerName();
    const currentBaseUrl = getCurrentBaseUrl();

    res.json({
      generated_at: now,
      server: {
        name: currentServerName,
        base_url: currentBaseUrl,
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

    const thumbnailQuery = {
      width: Math.max(1, width),
      height: Math.max(1, height),
      method: method === 'scale' ? 'scale' : 'crop'
    };

    const thumbnailResult = await tryFetchSynapseMedia({
      parsed,
      kind: 'thumbnail',
      query: thumbnailQuery
    });

    if (thumbnailResult.upstream) {
      return sendProxiedMediaResponse(res, thumbnailResult.upstream, 'image/jpeg');
    }

    // If thumbnails aren't available, fall back to the original media.
    const downloadResult = await tryFetchSynapseMedia({
      parsed,
      kind: 'download'
    });
    if (downloadResult.upstream) {
      return sendProxiedMediaResponse(res, downloadResult.upstream, 'application/octet-stream');
    }

    return res.status(downloadResult.status || thumbnailResult.status || 502).json({
      error: 'Unable to fetch media thumbnail.',
      details: {
        thumbnail_attempts: thumbnailResult.attempts,
        download_attempts: downloadResult.attempts
      }
    });
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

    const result = await tryFetchSynapseMedia({
      parsed,
      kind: 'download'
    });
    if (!result.upstream) {
      return res.status(result.status || 502).json({
        error: 'Unable to fetch media download.',
        details: {
          attempts: result.attempts
        }
      });
    }

    await sendProxiedMediaResponse(res, result.upstream, 'application/octet-stream');
  } catch (err) {
    next(err);
  }
});

app.get('/api/media/storage/users', async (req, res, next) => {
  try {
    const { from, limit } = parsePagedQuery(req, { from: 0, limit: 25, maxLimit: MEDIA_QUERY_MAX_LIMIT });
    const orderBy = normalizeOrderBy(
      req.query?.order_by,
      ['user_id', 'displayname', 'media_length', 'media_count'],
      'media_length'
    );
    const dir = parseSortDirection(req.query?.dir, 'b');
    const fromTs = toTimestamp(req.query?.from_ts);
    const untilTs = toTimestamp(req.query?.until_ts);
    const searchTerm = String(req.query?.search_term || req.query?.q || '').trim();

    const data = await synapseRequest('GET', '/_synapse/admin/v1/statistics/users/media', null, {
      from,
      limit,
      order_by: orderBy,
      dir,
      from_ts: fromTs || undefined,
      until_ts: untilTs || undefined,
      search_term: searchTerm || undefined
    });

    const users = Array.isArray(data?.users) ? data.users : [];
    const totalMediaCount = users.reduce((acc, user) => acc + Number(user?.media_count || 0), 0);
    const totalMediaLength = users.reduce((acc, user) => acc + Number(user?.media_length || 0), 0);

    res.json({
      from,
      limit,
      total: Number(data?.total ?? users.length),
      next_token: data?.next_token ?? data?.next_batch ?? null,
      order_by: orderBy,
      dir,
      users: users.map((user) => ({
        user_id: user?.user_id || null,
        displayname: user?.displayname || null,
        media_count: Number(user?.media_count || 0),
        media_length: Number(user?.media_length || 0)
      })),
      page_summary: {
        media_count: totalMediaCount,
        media_length: totalMediaLength
      }
    });
  } catch (err) {
    next(err);
  }
});

app.get('/api/media/users/:userId/media', async (req, res, next) => {
  try {
    const userId = req.params.userId;
    const currentServerName = getCurrentServerName();
    const { from, limit } = parsePagedQuery(req, { from: 0, limit: 25, maxLimit: MEDIA_QUERY_MAX_LIMIT });
    const orderBy = normalizeOrderBy(
      req.query?.order_by,
      ['created_ts', 'last_access_ts', 'media_length', 'media_type', 'upload_name', 'media_id'],
      'created_ts'
    );
    const dir = parseSortDirection(req.query?.dir, 'b');
    const query = String(req.query?.q || '').trim();

    const data = await synapseRequest(
      'GET',
      `/_synapse/admin/v1/users/${encodeURIComponent(userId)}/media`,
      null,
      {
        from,
        limit,
        order_by: orderBy,
        dir
      }
    );

    let media = Array.isArray(data?.media) ? data.media : [];
    if (query) {
      media = filterSearchTerm(media, query, (item) =>
        [
          item?.media_id,
          item?.upload_name,
          item?.media_type,
          buildMxcUri(currentServerName, item?.media_id)
        ]
          .filter(Boolean)
          .join(' ')
      );
    }

    res.json({
      user_id: userId,
      from,
      limit,
      total: Number(data?.total ?? media.length),
      next_token: data?.next_token ?? data?.next_batch ?? null,
      order_by: orderBy,
      dir,
      search_applied_to_page_only: Boolean(query),
      media: media.map((item) => {
        const mediaId = String(item?.media_id || '');
        const mxc = buildMxcUri(currentServerName, mediaId);
        return {
          media_id: mediaId || null,
          ...getMediaPreviewPayload(mxc),
          media_type: item?.media_type || null,
          media_length: Number(item?.media_length || 0),
          upload_name: item?.upload_name || null,
          created_ts: Number(item?.created_ts || 0) || null,
          last_access_ts: Number(item?.last_access_ts || 0) || null,
          quarantined_by: item?.quarantined_by || null,
          safe_from_quarantine: Boolean(item?.safe_from_quarantine),
          origin: currentServerName,
          is_local: true
        };
      })
    });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/media/users/:userId/media', async (req, res, next) => {
  const startedAt = Date.now();
  try {
    const userId = req.params.userId;
    const beforeTs = toTimestamp(req.body?.before_ts ?? req.query?.before_ts);
    const sizeGtRaw = req.body?.size_gt ?? req.query?.size_gt;
    const keepProfilesRaw = req.body?.keep_profiles ?? req.query?.keep_profiles;
    const sizeGt = Number.isFinite(Number(sizeGtRaw)) ? Math.max(0, Number(sizeGtRaw)) : undefined;
    const keepProfiles =
      keepProfilesRaw === undefined ? undefined : ['1', 'true', 'yes'].includes(String(keepProfilesRaw).toLowerCase());

    const result = await synapseRequest(
      'DELETE',
      `/_synapse/admin/v1/users/${encodeURIComponent(userId)}/media`,
      null,
      {
        before_ts: beforeTs || undefined,
        size_gt: sizeGt,
        keep_profiles: keepProfiles
      }
    );

    logAdminAction({
      req,
      action: 'media.delete_user_media',
      title: 'Delete user media',
      module: 'media',
      risk: 'destructive',
      status: 'success',
      targetType: 'user',
      targetId: userId,
      request: {
        user_id: userId,
        before_ts: beforeTs || null,
        size_gt: sizeGt ?? null,
        keep_profiles: keepProfiles ?? null
      },
      result: {
        deleted_media: Number(result?.deleted_media || 0),
        total: Number(result?.total || 0)
      },
      startedAt
    });

    res.json(result || { ok: true });
  } catch (err) {
    logAdminAction({
      req,
      action: 'media.delete_user_media',
      title: 'Delete user media',
      module: 'media',
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

app.get('/api/media/rooms/:roomId/inventory', async (req, res, next) => {
  try {
    const roomId = req.params.roomId;
    const currentServerName = getCurrentServerName();
    const source = normalizeOrderBy(req.query?.source, ['all', 'local', 'remote'], 'all');
    const includeDetails = String(req.query?.include_details || 'true').toLowerCase() !== 'false';
    const query = String(req.query?.q || '').trim();
    const { from, limit } = parsePagedQuery(req, { from: 0, limit: 50, maxLimit: 250 });

    const data = await synapseRequest(
      'GET',
      `/_synapse/admin/v1/room/${encodeURIComponent(roomId)}/media`
    );

    const localMedia = Array.isArray(data?.local) ? data.local : [];
    const remoteMedia = Array.isArray(data?.remote) ? data.remote : [];
    const inventory = [];

    localMedia.forEach((item) => {
      const parsed = parseMediaReference(item, currentServerName);
      if (!parsed) return;
      inventory.push({
        ...parsed,
        is_local: true
      });
    });

    remoteMedia.forEach((item) => {
      const parsed = parseMediaReference(item, null);
      if (!parsed) return;
      inventory.push({
        ...parsed,
        is_local: false
      });
    });

    const deduped = new Map();
    inventory.forEach((entry) => {
      const key = `${entry.origin}/${entry.media_id}`;
      if (!deduped.has(key)) {
        deduped.set(key, entry);
      }
    });

    let entries = Array.from(deduped.values());

    if (source === 'local') {
      entries = entries.filter((entry) => entry.is_local);
    } else if (source === 'remote') {
      entries = entries.filter((entry) => !entry.is_local);
    }

    if (query) {
      entries = filterSearchTerm(entries, query, (entry) =>
        [entry.mxc, entry.origin, entry.media_id].filter(Boolean).join(' ')
      );
    }

    entries.sort((a, b) => {
      const left = String(a.mxc || '').toLowerCase();
      const right = String(b.mxc || '').toLowerCase();
      return left.localeCompare(right, undefined, { sensitivity: 'base' });
    });

    const total = entries.length;
    const pageEntries = entries.slice(from, from + limit);

    let media = pageEntries.map((entry) => ({
      origin: entry.origin,
      media_id: entry.media_id,
      is_local: entry.is_local,
      ...getMediaPreviewPayload(entry.mxc)
    }));

    if (includeDetails && media.length) {
      media = await Promise.all(
        media.map(async (item) => {
          try {
            const metadata = await fetchMediaMetadata(item.origin, item.media_id, { allowNotFound: true });
            if (!metadata) {
              return {
                ...item,
                metadata_available: false,
                metadata_error: 'Not found in media store metadata endpoint'
              };
            }
            return {
              ...item,
              metadata_available: true,
              media_type: metadata?.media_type || null,
              media_length: Number(metadata?.media_length || 0),
              upload_name: metadata?.upload_name || null,
              created_ts: Number(metadata?.created_ts || 0) || null,
              last_access_ts: Number(metadata?.last_access_ts || 0) || null,
              quarantined_by: metadata?.quarantined_by || null,
              safe_from_quarantine: Boolean(metadata?.safe_from_quarantine)
            };
          } catch (err) {
            return {
              ...item,
              metadata_available: false,
              metadata_error: err.message || 'Unable to load metadata'
            };
          }
        })
      );
    }

    const nextOffset = from + media.length;
    res.json({
      room_id: roomId,
      source,
      from,
      limit,
      total,
      next_token: nextOffset < total ? String(nextOffset) : null,
      local_count: localMedia.length,
      remote_count: remoteMedia.length,
      media
    });
  } catch (err) {
    next(err);
  }
});

app.get('/api/media/item', async (req, res, next) => {
  try {
    const mxc = String(req.query?.mxc || '');
    const parsed = parseMxcUri(mxc);
    if (!parsed) {
      return res.status(400).json({ error: 'mxc query parameter is required.' });
    }

    const metadata = await fetchMediaMetadata(parsed.server, parsed.mediaId, { allowNotFound: true });
    if (!metadata) {
      return res.status(404).json({
        error: 'Media metadata not found.',
        item: {
          origin: parsed.server,
          media_id: parsed.mediaId,
          ...getMediaPreviewPayload(mxc)
        }
      });
    }

    res.json({
      item: buildMediaItem(parsed.server, parsed.mediaId, metadata)
    });
  } catch (err) {
    next(err);
  }
});

app.post('/api/media/item/quarantine', async (req, res, next) => {
  const startedAt = Date.now();
  try {
    const mxc = String(req.body?.mxc || '').trim();
    const parsed = parseMxcUri(mxc);
    if (!parsed) {
      return res.status(400).json({ error: 'mxc is required in the request body.' });
    }

    const result = await synapseRequest(
      'POST',
      `/_synapse/admin/v1/media/quarantine/${encodeURIComponent(parsed.server)}/${encodeURIComponent(parsed.mediaId)}`
    );

    logAdminAction({
      req,
      action: 'media.quarantine_item',
      title: 'Quarantine media item',
      module: 'media',
      risk: 'destructive',
      status: 'success',
      targetType: 'media',
      targetId: mxc,
      request: {
        mxc
      },
      result: {
        ok: true
      },
      startedAt
    });

    res.json(result || { ok: true, quarantined: true, mxc });
  } catch (err) {
    logAdminAction({
      req,
      action: 'media.quarantine_item',
      title: 'Quarantine media item',
      module: 'media',
      risk: 'destructive',
      status: 'error',
      targetType: 'media',
      targetId: req.body?.mxc || null,
      request: {
        mxc: req.body?.mxc || null
      },
      error: err,
      startedAt
    });
    next(err);
  }
});

app.post('/api/media/item/unquarantine', async (req, res, next) => {
  const startedAt = Date.now();
  try {
    const mxc = String(req.body?.mxc || '').trim();
    const parsed = parseMxcUri(mxc);
    if (!parsed) {
      return res.status(400).json({ error: 'mxc is required in the request body.' });
    }

    const result = await synapseRequest(
      'POST',
      `/_synapse/admin/v1/media/unquarantine/${encodeURIComponent(parsed.server)}/${encodeURIComponent(parsed.mediaId)}`
    );

    logAdminAction({
      req,
      action: 'media.unquarantine_item',
      title: 'Unquarantine media item',
      module: 'media',
      risk: 'guarded',
      status: 'success',
      targetType: 'media',
      targetId: mxc,
      request: {
        mxc
      },
      result: {
        ok: true
      },
      startedAt
    });

    res.json(result || { ok: true, quarantined: false, mxc });
  } catch (err) {
    logAdminAction({
      req,
      action: 'media.unquarantine_item',
      title: 'Unquarantine media item',
      module: 'media',
      risk: 'guarded',
      status: 'error',
      targetType: 'media',
      targetId: req.body?.mxc || null,
      request: {
        mxc: req.body?.mxc || null
      },
      error: err,
      startedAt
    });
    next(err);
  }
});

app.post('/api/media/item/delete', async (req, res, next) => {
  const startedAt = Date.now();
  try {
    const mxc = String(req.body?.mxc || '').trim();
    const currentServerName = getCurrentServerName();
    const parsed = parseMxcUri(mxc);
    if (!parsed) {
      return res.status(400).json({ error: 'mxc is required in the request body.' });
    }

    if (String(parsed.server).toLowerCase() !== String(currentServerName).toLowerCase()) {
      return res.status(400).json({
        error: `Deleting remote media is not supported here. Only local media (${currentServerName}) can be deleted.`
      });
    }

    const result = await synapseRequest(
      'DELETE',
      `/_synapse/admin/v1/media/${encodeURIComponent(parsed.server)}/${encodeURIComponent(parsed.mediaId)}`
    );

    logAdminAction({
      req,
      action: 'media.delete_item',
      title: 'Delete media item',
      module: 'media',
      risk: 'destructive',
      status: 'success',
      targetType: 'media',
      targetId: mxc,
      request: {
        mxc
      },
      result: {
        deleted: true
      },
      startedAt
    });

    res.json(result || { ok: true, deleted: true, mxc });
  } catch (err) {
    logAdminAction({
      req,
      action: 'media.delete_item',
      title: 'Delete media item',
      module: 'media',
      risk: 'destructive',
      status: 'error',
      targetType: 'media',
      targetId: req.body?.mxc || null,
      request: {
        mxc: req.body?.mxc || null
      },
      error: err,
      startedAt
    });
    next(err);
  }
});

app.get('/api/reports', async (req, res, next) => {
  try {
    const { from, limit } = parsePagedQuery(req, { from: 0, limit: 25, maxLimit: MEDIA_QUERY_MAX_LIMIT });
    const dir = parseSortDirection(req.query?.dir, 'b');
    const userId = String(req.query?.user_id || '').trim();
    const roomId = String(req.query?.room_id || '').trim();
    const senderUserId = String(req.query?.event_sender_user_id || '').trim();
    const q = String(req.query?.q || '').trim();

    const data = await synapseRequest('GET', '/_synapse/admin/v1/event_reports', null, {
      from,
      limit,
      dir,
      user_id: userId || undefined,
      room_id: roomId || undefined,
      event_sender_user_id: senderUserId || undefined
    });

    let eventReports = Array.isArray(data?.event_reports) ? data.event_reports : [];
    if (q) {
      eventReports = filterSearchTerm(eventReports, q, (report) =>
        [
          report?.room_id,
          report?.event_id,
          report?.user_id,
          report?.sender,
          report?.reason
        ]
          .filter(Boolean)
          .join(' ')
      );
    }

    res.json({
      from,
      limit,
      total: Number(data?.total ?? eventReports.length),
      next_token: data?.next_token ?? data?.next_batch ?? null,
      dir,
      search_applied_to_page_only: Boolean(q),
      event_reports: eventReports
    });
  } catch (err) {
    next(err);
  }
});

app.get('/api/reports/:reportId', async (req, res, next) => {
  try {
    const reportId = Number(req.params.reportId);
    if (!Number.isFinite(reportId) || reportId < 0) {
      return res.status(400).json({ error: 'reportId must be a non-negative integer.' });
    }
    const data = await synapseRequest('GET', `/_synapse/admin/v1/event_reports/${reportId}`);
    res.json(data || {});
  } catch (err) {
    next(err);
  }
});

app.post('/api/reports/:reportId/resolve', async (req, res, next) => {
  const startedAt = Date.now();
  try {
    const reportId = Number(req.params.reportId);
    if (!Number.isFinite(reportId) || reportId < 0) {
      return res.status(400).json({ error: 'reportId must be a non-negative integer.' });
    }

    const result = await synapseRequest('DELETE', `/_synapse/admin/v1/event_reports/${reportId}`);

    logAdminAction({
      req,
      action: 'report.resolve',
      title: 'Resolve event report',
      module: 'media',
      risk: 'guarded',
      status: 'success',
      targetType: 'report',
      targetId: String(reportId),
      request: {
        report_id: reportId
      },
      result: {
        deleted: true
      },
      startedAt
    });

    res.json(result || { ok: true, resolved: true, report_id: reportId });
  } catch (err) {
    logAdminAction({
      req,
      action: 'report.resolve',
      title: 'Resolve event report',
      module: 'media',
      risk: 'guarded',
      status: 'error',
      targetType: 'report',
      targetId: req.params.reportId,
      request: {
        report_id: req.params.reportId
      },
      error: err,
      startedAt
    });
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
    const currentServerName = getCurrentServerName();
    const resolvedUserId = user_id || (localpart ? `@${localpart}:${currentServerName}` : null);

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
    const currentServerName = getCurrentServerName();
    const resolvedUserId = user_id || (localpart ? `@${localpart}:${currentServerName}` : null);
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

app.post('/api/users/:userId/avatar/remove', async (req, res, next) => {
  const startedAt = Date.now();
  try {
    const userId = req.params.userId;

    await synapseRequest(
      'PUT',
      `/_synapse/admin/v2/users/${encodeURIComponent(userId)}`,
      { avatar_url: '' }
    );

    logAdminAction({
      req,
      action: 'user.avatar_remove',
      title: 'Remove user avatar',
      module: 'users',
      risk: 'guarded',
      status: 'success',
      targetType: 'user',
      targetId: userId,
      request: {
        user_id: userId
      },
      result: {
        avatar_removed: true
      },
      startedAt
    });

    res.json({
      ok: true,
      user_id: userId,
      ...buildAvatarPayload(null)
    });
  } catch (err) {
    logAdminAction({
      req,
      action: 'user.avatar_remove',
      title: 'Remove user avatar',
      module: 'users',
      risk: 'guarded',
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

app.post('/api/users/:userId/avatar', async (req, res, next) => {
  const startedAt = Date.now();
  try {
    const userId = req.params.userId;
    const {
      avatar_url: avatarUrlInput,
      image_base64: imageBase64,
      content_type: contentType,
      filename
    } = req.body || {};

    let avatarUrl = typeof avatarUrlInput === 'string' ? avatarUrlInput.trim() : '';

    if (!avatarUrl) {
      if (!imageBase64) {
        logAdminAction({
          req,
          action: 'user.avatar_set',
          title: 'Set user avatar',
          module: 'users',
          risk: 'guarded',
          status: 'error',
          targetType: 'user',
          targetId: userId,
          request: {
            user_id: userId,
            has_avatar_url: Boolean(avatarUrlInput),
            has_image_payload: Boolean(imageBase64)
          },
          error: { message: 'Provide avatar_url or image_base64 payload.', status: 400 },
          startedAt,
          httpStatus: 400
        });
        return res.status(400).json({ error: 'Provide avatar_url or image_base64 payload.' });
      }

      if (!isSupportedAvatarContentType(contentType)) {
        logAdminAction({
          req,
          action: 'user.avatar_set',
          title: 'Set user avatar',
          module: 'users',
          risk: 'guarded',
          status: 'error',
          targetType: 'user',
          targetId: userId,
          request: {
            user_id: userId,
            content_type: contentType || null
          },
          error: { message: 'content_type must be an image MIME type.', status: 400 },
          startedAt,
          httpStatus: 400
        });
        return res.status(400).json({ error: 'content_type must be an image MIME type.' });
      }

      const decoded = decodeBase64Payload(imageBase64);
      if (!decoded || !decoded.length) {
        logAdminAction({
          req,
          action: 'user.avatar_set',
          title: 'Set user avatar',
          module: 'users',
          risk: 'guarded',
          status: 'error',
          targetType: 'user',
          targetId: userId,
          request: {
            user_id: userId,
            content_type: contentType || null
          },
          error: { message: 'Invalid image_base64 payload.', status: 400 },
          startedAt,
          httpStatus: 400
        });
        return res.status(400).json({ error: 'Invalid image_base64 payload.' });
      }

      if (decoded.length > MAX_AVATAR_UPLOAD_BYTES) {
        logAdminAction({
          req,
          action: 'user.avatar_set',
          title: 'Set user avatar',
          module: 'users',
          risk: 'guarded',
          status: 'error',
          targetType: 'user',
          targetId: userId,
          request: {
            user_id: userId,
            content_type: contentType || null,
            file_size: decoded.length
          },
          error: {
            message: `Avatar file exceeds limit of ${MAX_AVATAR_UPLOAD_BYTES} bytes.`,
            status: 400
          },
          startedAt,
          httpStatus: 400
        });
        return res.status(400).json({
          error: `Avatar file exceeds limit of ${MAX_AVATAR_UPLOAD_BYTES} bytes.`
        });
      }

      avatarUrl = await uploadSynapseMedia(decoded, contentType, filename || 'avatar');
    }

    if (!avatarUrl.startsWith('mxc://')) {
      logAdminAction({
        req,
        action: 'user.avatar_set',
        title: 'Set user avatar',
        module: 'users',
        risk: 'guarded',
        status: 'error',
        targetType: 'user',
        targetId: userId,
        request: {
          user_id: userId,
          avatar_url: avatarUrl
        },
        error: { message: 'avatar_url must be an mxc:// URI.', status: 400 },
        startedAt,
        httpStatus: 400
      });
      return res.status(400).json({ error: 'avatar_url must be an mxc:// URI.' });
    }

    await synapseRequest(
      'PUT',
      `/_synapse/admin/v2/users/${encodeURIComponent(userId)}`,
      { avatar_url: avatarUrl }
    );

    logAdminAction({
      req,
      action: 'user.avatar_set',
      title: 'Set user avatar',
      module: 'users',
      risk: 'guarded',
      status: 'success',
      targetType: 'user',
      targetId: userId,
      request: {
        user_id: userId,
        has_uploaded_file: Boolean(imageBase64),
        filename: filename || null,
        content_type: contentType || null,
        avatar_url: avatarUrl
      },
      result: {
        avatar_url: avatarUrl
      },
      startedAt
    });

    res.json({
      ok: true,
      user_id: userId,
      ...buildAvatarPayload(avatarUrl)
    });
  } catch (err) {
    logAdminAction({
      req,
      action: 'user.avatar_set',
      title: 'Set user avatar',
      module: 'users',
      risk: 'guarded',
      status: 'error',
      targetType: 'user',
      targetId: req.params.userId,
      request: {
        user_id: req.params.userId,
        has_uploaded_file: Boolean(req.body?.image_base64),
        filename: req.body?.filename || null,
        content_type: req.body?.content_type || null
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

app.post('/api/rooms/:roomId/join_moderator', async (req, res, next) => {
  const startedAt = Date.now();
  const roomId = req.params.roomId;
  let adminUserId = null;
  const stepResults = [];

  try {
    const whoami = await synapseRequest('GET', '/_matrix/client/v3/account/whoami');
    adminUserId = String(whoami?.user_id || '').trim();

    if (!adminUserId) {
      const err = new Error('Unable to resolve the admin user from this access token.');
      err.status = 500;
      throw err;
    }

    try {
      await synapseRequest(
        'POST',
        `/_synapse/admin/v1/rooms/${encodeURIComponent(roomId)}/make_room_admin`,
        { user_id: adminUserId }
      );
      stepResults.push({
        step: 'make_room_admin',
        status: 'ok',
        message: 'Requested moderator bootstrap for this account.'
      });
    } catch (err) {
      stepResults.push({
        step: 'make_room_admin',
        status: 'error',
        message: err.message || 'Failed to run make_room_admin.',
        details: sanitizeForLog(err.data || null)
      });
    }

    let joinError = null;

    try {
      const joinResult = await joinRoomAsModeratorUser(roomId, adminUserId);
      stepResults.push({
        step: 'join',
        status: 'ok',
        method: joinResult.method,
        message: joinResult.already_joined
          ? 'Moderator account is already in this room.'
          : 'Moderator account joined the room.'
      });
      if (Array.isArray(joinResult.attempts) && joinResult.attempts.length) {
        stepResults.push({
          step: 'join_fallback_attempts',
          status: 'info',
          attempts: joinResult.attempts
        });
      }
    } catch (err) {
      joinError = err;
      stepResults.push({
        step: 'join',
        status: 'error',
        message: err.message || 'Join request failed.',
        details: sanitizeForLog(err.data || null)
      });
      if (Array.isArray(err.joinAttempts) && err.joinAttempts.length) {
        stepResults.push({
          step: 'join_fallback_attempts',
          status: 'error',
          attempts: err.joinAttempts
        });
      }
    }

    const members = await synapseRequest(
      'GET',
      `/_synapse/admin/v1/rooms/${encodeURIComponent(roomId)}/members`
    );
    const memberIds = extractRoomMemberIds(members);
    const joined = memberIds.includes(adminUserId);

    if (!joined) {
      const responseError = joinError || new Error('Moderator account is still not joined to this room.');
      responseError.status = responseError.status || 409;
      responseError.data = responseError.data || {
        error:
          'Join attempt did not succeed. This can happen when no local user has enough room power to invite/elevate this account.'
      };
      throw responseError;
    }

    logAdminAction({
      req,
      action: 'room.join_moderator',
      title: 'Join moderator to room',
      module: 'rooms',
      risk: 'guarded',
      status: 'success',
      targetType: 'room_member',
      targetId: `${roomId}:${adminUserId}`,
      request: {
        room_id: roomId
      },
      result: {
        user_id: adminUserId,
        joined: true,
        steps: stepResults
      },
      startedAt
    });

    res.json({
      ok: true,
      room_id: roomId,
      user_id: adminUserId,
      joined: true,
      steps: stepResults,
      message: `Joined ${adminUserId} to the room.`
    });
  } catch (err) {
    logAdminAction({
      req,
      action: 'room.join_moderator',
      title: 'Join moderator to room',
      module: 'rooms',
      risk: 'guarded',
      status: 'error',
      targetType: 'room_member',
      targetId: `${roomId}:${adminUserId || 'unknown'}`,
      request: {
        room_id: roomId
      },
      result: {
        steps: stepResults
      },
      error: err,
      startedAt
    });
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

app.get('/api/rooms/:roomId/block', async (req, res, next) => {
  try {
    const roomId = req.params.roomId;
    const data = await synapseRequest(
      'GET',
      `/_synapse/admin/v1/rooms/${encodeURIComponent(roomId)}/block`
    );
    res.json({
      block: Boolean(data?.block),
      user_id: data?.user_id || null
    });
  } catch (err) {
    next(err);
  }
});

app.put('/api/rooms/:roomId/block', async (req, res, next) => {
  const startedAt = Date.now();
  try {
    const roomId = req.params.roomId;
    const block = parseBooleanInput(req.body?.block, true);
    const data = await synapseRequest(
      'PUT',
      `/_synapse/admin/v1/rooms/${encodeURIComponent(roomId)}/block`,
      { block }
    );

    logAdminAction({
      req,
      action: block ? 'room.block' : 'room.unblock',
      title: block ? 'Block room' : 'Unblock room',
      module: 'rooms',
      risk: 'destructive',
      status: 'success',
      targetType: 'room',
      targetId: roomId,
      request: {
        room_id: roomId,
        block
      },
      result: {
        block: Boolean(data?.block)
      },
      startedAt
    });

    res.json({
      block: Boolean(data?.block),
      user_id: data?.user_id || null
    });
  } catch (err) {
    logAdminAction({
      req,
      action: parseBooleanInput(req.body?.block, true) ? 'room.block' : 'room.unblock',
      title: parseBooleanInput(req.body?.block, true) ? 'Block room' : 'Unblock room',
      module: 'rooms',
      risk: 'destructive',
      status: 'error',
      targetType: 'room',
      targetId: req.params.roomId,
      request: {
        room_id: req.params.roomId,
        block: parseBooleanInput(req.body?.block, true)
      },
      error: err,
      startedAt
    });
    next(err);
  }
});

app.post('/api/rooms/:roomId/purge_history', async (req, res, next) => {
  const startedAt = Date.now();
  try {
    const roomId = req.params.roomId;
    const purgeUpToEventId = String(req.body?.purge_up_to_event_id || '').trim();
    const purgeUpToTsRaw = req.body?.purge_up_to_ts;
    const purgeUpToTs =
      purgeUpToTsRaw !== undefined && purgeUpToTsRaw !== null && purgeUpToTsRaw !== ''
        ? Number(purgeUpToTsRaw)
        : null;

    if (!purgeUpToEventId && !Number.isFinite(purgeUpToTs)) {
      const error = new Error('Provide purge_up_to_ts (ms timestamp) or purge_up_to_event_id.');
      error.status = 400;
      throw error;
    }

    const body = {
      delete_local_events: parseBooleanInput(req.body?.delete_local_events, false)
    };

    if (purgeUpToEventId) {
      body.purge_up_to_event_id = purgeUpToEventId;
    }
    if (Number.isFinite(purgeUpToTs)) {
      body.purge_up_to_ts = Math.max(0, Math.floor(purgeUpToTs));
    }

    const purgeEndpoint = `/_synapse/admin/v1/purge_history/${encodeURIComponent(roomId)}`;
    let data = null;
    const purgeRequestMeta = {
      mode: body.purge_up_to_event_id ? 'event_id' : 'timestamp',
      fallback_used: false,
      resolved_event_id: null,
      resolved_event_ts: null
    };

    try {
      data = await synapseRequest('POST', purgeEndpoint, body);
    } catch (err) {
      const canTryTimestampFallback =
        !body.purge_up_to_event_id && Number.isFinite(body.purge_up_to_ts) && isNoEventToPurgeError(err);

      if (!canTryTimestampFallback) {
        throw err;
      }

      const lookup = await synapseRequest(
        'GET',
        `/_synapse/admin/v1/rooms/${encodeURIComponent(roomId)}/timestamp_to_event`,
        null,
        {
          ts: body.purge_up_to_ts,
          dir: 'b'
        }
      );

      const resolvedEventId = String(lookup?.event_id || '').trim();
      if (!resolvedEventId) {
        const noEventError = new Error(
          'No purgeable event found before this cutoff on this homeserver. Try a later cutoff time.'
        );
        noEventError.status = 404;
        noEventError.data = {
          errcode: 'M_NOT_FOUND',
          error: 'No purgeable event found before this cutoff on this homeserver.',
          purge_up_to_ts: body.purge_up_to_ts
        };
        throw noEventError;
      }

      purgeRequestMeta.fallback_used = true;
      purgeRequestMeta.mode = 'timestamp_to_event_id_fallback';
      purgeRequestMeta.resolved_event_id = resolvedEventId;
      purgeRequestMeta.resolved_event_ts = Number(lookup?.origin_server_ts || 0) || null;

      data = await synapseRequest('POST', purgeEndpoint, {
        delete_local_events: body.delete_local_events,
        purge_up_to_event_id: resolvedEventId
      });
    }

    logAdminAction({
      req,
      action: 'room.purge_history',
      title: 'Start room history purge',
      module: 'rooms',
      risk: 'destructive',
      status: 'success',
      targetType: 'room',
      targetId: roomId,
      request: {
        room_id: roomId,
        purge_up_to_event_id: body.purge_up_to_event_id || null,
        purge_up_to_ts: body.purge_up_to_ts || null,
        delete_local_events: body.delete_local_events,
        mode: purgeRequestMeta.mode,
        fallback_used: purgeRequestMeta.fallback_used
      },
      result: {
        purge_id: data?.purge_id || null,
        resolved_event_id: purgeRequestMeta.resolved_event_id,
        resolved_event_ts: purgeRequestMeta.resolved_event_ts
      },
      startedAt
    });

    res.json({
      ...(data || {}),
      mode: purgeRequestMeta.mode,
      fallback_used: purgeRequestMeta.fallback_used,
      resolved_event_id: purgeRequestMeta.resolved_event_id,
      resolved_event_ts: purgeRequestMeta.resolved_event_ts
    });
  } catch (err) {
    logAdminAction({
      req,
      action: 'room.purge_history',
      title: 'Start room history purge',
      module: 'rooms',
      risk: 'destructive',
      status: 'error',
      targetType: 'room',
      targetId: req.params.roomId,
      request: {
        room_id: req.params.roomId,
        purge_up_to_event_id: req.body?.purge_up_to_event_id || null,
        purge_up_to_ts: req.body?.purge_up_to_ts ?? null,
        delete_local_events: parseBooleanInput(req.body?.delete_local_events, false)
      },
      error: err,
      startedAt
    });
    next(err);
  }
});

app.get('/api/rooms/purge_history/:purgeId', async (req, res, next) => {
  try {
    const purgeId = req.params.purgeId;
    const data = await synapseRequest(
      'GET',
      `/_synapse/admin/v1/purge_history_status/${encodeURIComponent(purgeId)}`
    );
    res.json(data || {});
  } catch (err) {
    next(err);
  }
});

app.post('/api/rooms/:roomId/quarantine_media', async (req, res, next) => {
  const startedAt = Date.now();
  try {
    const roomId = req.params.roomId;
    const data = await synapseRequest(
      'POST',
      `/_synapse/admin/v1/room/${encodeURIComponent(roomId)}/media/quarantine`
    );

    logAdminAction({
      req,
      action: 'room.quarantine_media',
      title: 'Quarantine room media',
      module: 'rooms',
      risk: 'destructive',
      status: 'success',
      targetType: 'room',
      targetId: roomId,
      request: {
        room_id: roomId
      },
      result: {
        num_quarantined: Number(data?.num_quarantined || 0)
      },
      startedAt
    });

    res.json(data || { ok: true });
  } catch (err) {
    logAdminAction({
      req,
      action: 'room.quarantine_media',
      title: 'Quarantine room media',
      module: 'rooms',
      risk: 'destructive',
      status: 'error',
      targetType: 'room',
      targetId: req.params.roomId,
      request: {
        room_id: req.params.roomId
      },
      error: err,
      startedAt
    });
    next(err);
  }
});

app.post('/api/rooms/:roomId/shutdown', async (req, res, next) => {
  const startedAt = Date.now();
  try {
    const roomId = req.params.roomId;
    const body = {
      block: parseBooleanInput(req.body?.block, true),
      purge: parseBooleanInput(req.body?.purge, true),
      force_purge: parseBooleanInput(req.body?.force_purge, false)
    };

    const newRoomUserId = String(req.body?.new_room_user_id || '').trim();
    const roomName = String(req.body?.room_name || '').trim();
    const message = String(req.body?.message || '').trim();

    if (newRoomUserId) body.new_room_user_id = newRoomUserId;
    if (roomName) body.room_name = roomName;
    if (message) body.message = message;

    const data = await synapseRequest(
      'DELETE',
      `/_synapse/admin/v2/rooms/${encodeURIComponent(roomId)}`,
      body
    );

    logAdminAction({
      req,
      action: 'room.shutdown',
      title: 'Shutdown room',
      module: 'rooms',
      risk: 'destructive',
      status: 'success',
      targetType: 'room',
      targetId: roomId,
      request: {
        room_id: roomId,
        block: body.block,
        purge: body.purge,
        force_purge: body.force_purge,
        new_room_user_id: body.new_room_user_id || null,
        room_name: body.room_name || null,
        has_message: Boolean(body.message)
      },
      result: {
        delete_id: data?.delete_id || null
      },
      startedAt
    });

    res.json(data || {});
  } catch (err) {
    logAdminAction({
      req,
      action: 'room.shutdown',
      title: 'Shutdown room',
      module: 'rooms',
      risk: 'destructive',
      status: 'error',
      targetType: 'room',
      targetId: req.params.roomId,
      request: {
        room_id: req.params.roomId,
        block: parseBooleanInput(req.body?.block, true),
        purge: parseBooleanInput(req.body?.purge, true),
        force_purge: parseBooleanInput(req.body?.force_purge, false),
        new_room_user_id: req.body?.new_room_user_id || null
      },
      error: err,
      startedAt
    });
    next(err);
  }
});

app.get('/api/rooms/:roomId/delete_status', async (req, res, next) => {
  try {
    const roomId = req.params.roomId;
    const deleteId = String(req.query?.delete_id || '').trim();

    const endpoint = deleteId
      ? `/_synapse/admin/v2/rooms/delete_status/${encodeURIComponent(deleteId)}`
      : `/_synapse/admin/v2/rooms/${encodeURIComponent(roomId)}/delete_status`;

    const data = await synapseRequest('GET', endpoint);
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

app.use(express.static(path.join(__dirname, 'public')));

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
      default_server_name: DEFAULT_SYNAPSE_SERVER_NAME || null
    }
  });
  console.log(`Synapse Admin UI running at http://localhost:${PORT}`);
});
