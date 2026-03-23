const FEED_PAGE_SIZE = 30;
const AUTO_REFRESH_MS = 12000;

const dashboardStatus = document.getElementById('dashboardStatus');
const actionFeed = document.getElementById('actionFeed');
const actionSearch = document.getElementById('actionSearch');
const actionModule = document.getElementById('actionModule');
const actionStatusFilter = document.getElementById('actionStatusFilter');
const actionRiskFilter = document.getElementById('actionRiskFilter');
const actionTimeRange = document.getElementById('actionTimeRange');
const actionRefreshBtn = document.getElementById('actionRefreshBtn');
const actionLoadMoreBtn = document.getElementById('actionLoadMoreBtn');
const actionAutoRefresh = document.getElementById('actionAutoRefresh');
const actionAutoRefreshLabel = document.getElementById('actionAutoRefreshLabel');

const kpiTotal = document.getElementById('kpiTotal');
const kpiSuccess = document.getElementById('kpiSuccess');
const kpiErrors = document.getElementById('kpiErrors');
const kpiDestructive = document.getElementById('kpiDestructive');

const systemRefreshBtn = document.getElementById('systemRefreshBtn');
const systemHealthPill = document.getElementById('systemHealthPill');
const systemHealthText = document.getElementById('systemHealthText');
const systemServerName = document.getElementById('systemServerName');
const systemSynapseVersion = document.getElementById('systemSynapseVersion');
const systemApiLatency = document.getElementById('systemApiLatency');
const systemHealthChecked = document.getElementById('systemHealthChecked');
const systemHealthError = document.getElementById('systemHealthError');
const systemRoomCacheEntries = document.getElementById('systemRoomCacheEntries');
const systemRoomCacheStale = document.getElementById('systemRoomCacheStale');
const systemRoomCacheTtlExpired = document.getElementById('systemRoomCacheTtlExpired');
const systemQueueDepth = document.getElementById('systemQueueDepth');
const systemQueueState = document.getElementById('systemQueueState');
const systemQueueLastRun = document.getElementById('systemQueueLastRun');
const systemRoomCachePersist = document.getElementById('systemRoomCachePersist');
const systemRoomsFetch = document.getElementById('systemRoomsFetch');
const systemRoomsFetchDuration = document.getElementById('systemRoomsFetchDuration');
const systemRoomsFetchError = document.getElementById('systemRoomsFetchError');
const systemPid = document.getElementById('systemPid');
const systemNodeVersion = document.getElementById('systemNodeVersion');
const systemProcessUptime = document.getElementById('systemProcessUptime');
const systemMemoryRss = document.getElementById('systemMemoryRss');
const systemMemoryHeap = document.getElementById('systemMemoryHeap');
const systemFeedCount = document.getElementById('systemFeedCount');
const systemActionEntries = document.getElementById('systemActionEntries');
const systemActionPersist = document.getElementById('systemActionPersist');
const systemLastAction = document.getElementById('systemLastAction');
const systemLastError = document.getElementById('systemLastError');

const feedState = {
  items: [],
  nextOffset: null,
  loading: false,
  autoRefreshTimer: null
};

let systemStatusLoading = false;
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

function setStatus(text) {
  dashboardStatus.textContent = text;
}

function toRelativeTime(ts) {
  if (!ts) return 'Unknown';
  const ms = Number(ts);
  if (!Number.isFinite(ms) || ms <= 0) return 'Unknown';

  const delta = Date.now() - ms;
  if (delta < 1000) return 'just now';

  const ranges = [
    { label: 'day', ms: 24 * 60 * 60 * 1000 },
    { label: 'hour', ms: 60 * 60 * 1000 },
    { label: 'minute', ms: 60 * 1000 },
    { label: 'second', ms: 1000 }
  ];

  for (const range of ranges) {
    if (delta >= range.ms) {
      const value = Math.floor(delta / range.ms);
      return `${value} ${range.label}${value === 1 ? '' : 's'} ago`;
    }
  }

  return 'just now';
}

function formatDateTime(ts) {
  if (!ts) return 'Unknown';
  const ms = Number(ts);
  if (!Number.isFinite(ms) || ms <= 0) return 'Unknown';
  return new Date(ms).toLocaleString();
}

function formatDurationMs(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms < 0) return 'Unknown';
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remSeconds = seconds % 60;
  return remSeconds ? `${minutes}m ${remSeconds}s` : `${minutes}m`;
}

function formatUptime(secondsValue) {
  const seconds = Number(secondsValue);
  if (!Number.isFinite(seconds) || seconds < 0) return 'Unknown';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatBytes(bytesValue) {
  const bytes = Number(bytesValue);
  if (!Number.isFinite(bytes) || bytes < 0) return 'Unknown';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const idx = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** idx;
  return `${value.toFixed(value >= 10 || idx === 0 ? 0 : 1)} ${units[idx]}`;
}

function truncate(value, max) {
  if (!value || value.length <= max) return value || '';
  return `${value.slice(0, max)}...`;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function setText(element, value, fallback = 'Unknown') {
  if (!element) return;
  const rendered = value === null || value === undefined || value === '' ? fallback : String(value);
  element.textContent = rendered;
}

function getTimeRangeSince(rangeKey) {
  const now = Date.now();
  switch (rangeKey) {
    case '1h':
      return now - 60 * 60 * 1000;
    case '24h':
      return now - 24 * 60 * 60 * 1000;
    case '7d':
      return now - 7 * 24 * 60 * 60 * 1000;
    case '30d':
      return now - 30 * 24 * 60 * 60 * 1000;
    default:
      return null;
  }
}

function getRiskClassName(risk) {
  switch (risk) {
    case 'destructive':
      return 'risk-destructive';
    case 'guarded':
      return 'risk-guarded';
    default:
      return 'risk-safe';
  }
}

function updateSummary(filteredSummary, globalSummary) {
  const filtered = filteredSummary || {};
  const global = globalSummary || {};
  kpiTotal.textContent = String(filtered.total || 0);
  kpiSuccess.textContent = String(filtered.success || 0);
  kpiErrors.textContent = String(filtered.error || 0);
  kpiDestructive.textContent = String(filtered.destructive || 0);
  systemFeedCount.textContent = String(global.total || filtered.total || 0);
}

function renderActionFeed(items) {
  if (!items.length) {
    actionFeed.innerHTML = '<div class="details-empty">No actions match the current filters.</div>';
    return;
  }

  actionFeed.innerHTML = '';

  items.forEach((entry) => {
    const element = document.createElement('article');
    const statusClass = entry.status === 'error' ? 'is-error' : 'is-success';
    element.className = `action-entry ${statusClass} ${getRiskClassName(entry.risk)}`;

    const statusLabel = entry.status === 'error' ? 'Error' : 'Success';
    const riskLabel = entry.risk || 'safe';

    const method = entry?.http?.method || '-';
    const path = entry?.http?.path || '-';
    const duration = typeof entry?.duration_ms === 'number' ? `${entry.duration_ms}ms` : '-';
    const target = entry?.target?.id || 'None';
    const actorIp = entry?.actor?.ip || 'unknown';

    const requestDetails = entry?.details?.request ? JSON.stringify(entry.details.request, null, 2) : '';
    const resultDetails = entry?.details?.result ? JSON.stringify(entry.details.result, null, 2) : '';
    const errorDetails = entry?.details?.error ? JSON.stringify(entry.details.error, null, 2) : '';

    element.innerHTML = `
      <div class="action-entry-head">
        <strong>${escapeHtml(entry.title)}</strong>
        <div class="action-entry-badges">
          <span class="badge ${entry.status === 'error' ? 'danger' : ''}">${escapeHtml(statusLabel)}</span>
          <span class="badge muted">${escapeHtml(riskLabel)}</span>
          <span class="badge muted">${escapeHtml(entry.module || 'system')}</span>
        </div>
      </div>
      <div class="action-entry-meta">
        <span>${escapeHtml(formatDateTime(entry.ts))} (${escapeHtml(toRelativeTime(entry.ts))})</span>
        <span>${escapeHtml(method)} ${escapeHtml(path)}</span>
        <span>Duration: ${escapeHtml(duration)}</span>
      </div>
      <div class="action-entry-meta">
        <span>Target: ${escapeHtml(target)}</span>
        <span>Actor IP: ${escapeHtml(actorIp)}</span>
        <span>Action key: ${escapeHtml(entry.action)}</span>
      </div>
      <details class="action-entry-details">
        <summary>Show request/result details</summary>
        ${requestDetails ? `<p>Request</p><pre>${escapeHtml(requestDetails)}</pre>` : ''}
        ${resultDetails ? `<p>Result</p><pre>${escapeHtml(resultDetails)}</pre>` : ''}
        ${errorDetails ? `<p>Error</p><pre>${escapeHtml(errorDetails)}</pre>` : ''}
      </details>
    `;
    actionFeed.appendChild(element);
  });
}

function getCurrentFilters() {
  return {
    q: actionSearch.value.trim(),
    module: actionModule.value,
    status: actionStatusFilter.value,
    risk: actionRiskFilter.value,
    since: getTimeRangeSince(actionTimeRange.value)
  };
}

function buildActionsQuery({ offset }) {
  const params = new URLSearchParams();
  const filters = getCurrentFilters();
  params.set('offset', String(offset));
  params.set('limit', String(FEED_PAGE_SIZE));

  if (filters.q) params.set('q', filters.q);
  if (filters.module !== 'all') params.set('module', filters.module);
  if (filters.status !== 'all') params.set('status', filters.status);
  if (filters.risk !== 'all') params.set('risk', filters.risk);
  if (filters.since) params.set('since', String(filters.since));

  return `/api/actions?${params.toString()}`;
}

function renderSystemStatus(data) {
  const server = data?.server || {};
  const cache = data?.rooms_cache || {};
  const actions = data?.actions_log || {};
  const processInfo = data?.process || {};

  const healthy = server.api_healthy;
  if (healthy) {
    systemHealthPill.textContent = 'Healthy';
    systemHealthPill.className = 'health-pill healthy';
  } else if (healthy === false) {
    systemHealthPill.textContent = 'Degraded';
    systemHealthPill.className = 'health-pill degraded';
  } else {
    systemHealthPill.textContent = 'Unknown';
    systemHealthPill.className = 'health-pill unknown';
  }

  const healthSummary = healthy
    ? `Synapse API reachable (${formatDurationMs(server.api_latency_ms)})`
    : `Synapse API unavailable${server.health_error ? `: ${truncate(server.health_error, 64)}` : ''}`;
  setText(systemHealthText, healthSummary, 'Waiting for health check...');

  setText(systemServerName, server.name || 'unknown');
  setText(systemSynapseVersion, server.version || 'Unknown');
  setText(systemApiLatency, formatDurationMs(server.api_latency_ms));
  setText(systemHealthChecked, `${formatDateTime(server.health_checked_at)} (${toRelativeTime(server.health_checked_at)})`);
  setText(systemHealthError, server.health_error || 'None');

  setText(systemRoomCacheEntries, cache.entries ?? 0);
  setText(systemRoomCacheStale, cache.stale_entries ?? 0);
  setText(systemRoomCacheTtlExpired, cache.ttl_expired_entries ?? 0);
  setText(systemQueueDepth, cache.refresh_queue_depth ?? 0);
  setText(systemQueueState, cache.refresh_in_progress ? 'Running' : 'Idle');
  setText(systemQueueLastRun, `${formatDateTime(cache.last_queue_refresh_finished_at)} (${toRelativeTime(cache.last_queue_refresh_finished_at)})`);
  setText(systemRoomCachePersist, `${formatDateTime(cache.last_cache_persist_at)} (${toRelativeTime(cache.last_cache_persist_at)})`);
  setText(systemRoomsFetch, `${formatDateTime(cache.last_rooms_fetch_at)} (${toRelativeTime(cache.last_rooms_fetch_at)})`);
  setText(systemRoomsFetchDuration, formatDurationMs(cache.last_rooms_fetch_duration_ms));
  setText(systemRoomsFetchError, cache.last_rooms_fetch_error || 'None');

  setText(systemPid, processInfo.pid || '-');
  setText(systemNodeVersion, processInfo.node_version || '-');
  setText(systemProcessUptime, formatUptime(processInfo.uptime_seconds));
  setText(systemMemoryRss, formatBytes(processInfo?.memory?.rss_bytes));
  setText(
    systemMemoryHeap,
    `${formatBytes(processInfo?.memory?.heap_used_bytes)} / ${formatBytes(processInfo?.memory?.heap_total_bytes)}`
  );

  setText(systemActionEntries, actions.entries ?? 0);
  setText(systemActionPersist, `${formatDateTime(actions.last_cache_persist_at)} (${toRelativeTime(actions.last_cache_persist_at)})`);
  setText(
    systemLastAction,
    actions.last_action_title
      ? `${actions.last_action_title} (${toRelativeTime(actions.last_action_at)})`
      : 'None'
  );
  setText(
    systemLastError,
    actions.last_error_title
      ? truncate(`${actions.last_error_title}: ${actions.last_error_message || 'Unknown error'}`, 92)
      : 'None'
  );
}

async function loadActions({ append = false } = {}) {
  if (feedState.loading) return;
  feedState.loading = true;
  actionRefreshBtn.disabled = true;
  actionLoadMoreBtn.disabled = true;
  setStatus(append ? 'Loading older actions...' : 'Loading action feed...');

  try {
    const offset = append ? feedState.nextOffset || 0 : 0;
    const data = await api(buildActionsQuery({ offset }));
    const incoming = Array.isArray(data?.actions) ? data.actions : [];

    if (append) {
      feedState.items = [...feedState.items, ...incoming];
    } else {
      feedState.items = incoming;
    }

    feedState.nextOffset = data?.next_offset ?? null;
    updateSummary(data?.filtered_summary, data?.global_summary);
    renderActionFeed(feedState.items);
    actionLoadMoreBtn.disabled = feedState.nextOffset === null;
    setStatus(`Loaded ${feedState.items.length} action records`);
  } catch (err) {
    setStatus(`Error loading feed: ${err.message}`);
    if (!feedState.items.length) {
      actionFeed.innerHTML = '<div class="details-empty">Unable to load recent actions.</div>';
    }
  } finally {
    feedState.loading = false;
    actionRefreshBtn.disabled = false;
  }
}

async function loadSystemStatus({ force = false } = {}) {
  if (systemStatusLoading) return;
  systemStatusLoading = true;
  if (systemRefreshBtn) {
    systemRefreshBtn.disabled = true;
  }

  try {
    const suffix = force ? '?force=true' : '';
    const data = await api(`/api/system/status${suffix}`);
    renderSystemStatus(data);
  } catch (err) {
    setStatus(`System status error: ${err.message}`);
    if (systemHealthPill) {
      systemHealthPill.textContent = 'Degraded';
      systemHealthPill.className = 'health-pill degraded';
    }
    setText(systemHealthText, truncate(err.message, 84));
  } finally {
    systemStatusLoading = false;
    if (systemRefreshBtn) {
      systemRefreshBtn.disabled = false;
    }
  }
}

function refreshWithCurrentFilters() {
  void loadActions({ append: false });
}

function setAutoRefresh(isOn) {
  actionAutoRefresh.dataset.state = isOn ? 'on' : 'off';
  actionAutoRefresh.setAttribute('aria-pressed', isOn ? 'true' : 'false');
  actionAutoRefreshLabel.textContent = 'Auto refresh';
  actionAutoRefresh.setAttribute('aria-label', isOn ? 'Auto refresh on' : 'Auto refresh off');

  if (feedState.autoRefreshTimer) {
    clearInterval(feedState.autoRefreshTimer);
    feedState.autoRefreshTimer = null;
  }

  if (isOn) {
    feedState.autoRefreshTimer = setInterval(() => {
      void loadActions({ append: false });
      void loadSystemStatus({ force: false });
    }, AUTO_REFRESH_MS);
  }
}

async function loadConfig() {
  const config = await api('/api/config');
  setText(systemServerName, config.server_name || 'unknown');
}

actionRefreshBtn.addEventListener('click', () => {
  refreshWithCurrentFilters();
  void loadSystemStatus({ force: true });
});

actionLoadMoreBtn.addEventListener('click', () => {
  if (feedState.nextOffset === null) return;
  void loadActions({ append: true });
});

actionAutoRefresh.addEventListener('click', () => {
  const isOn = actionAutoRefresh.dataset.state === 'on';
  setAutoRefresh(!isOn);
});

if (systemRefreshBtn) {
  systemRefreshBtn.addEventListener('click', () => {
    void loadSystemStatus({ force: true });
  });
}

[actionModule, actionStatusFilter, actionRiskFilter, actionTimeRange].forEach((element) => {
  element.addEventListener('change', () => {
    refreshWithCurrentFilters();
  });
});

actionSearch.addEventListener('input', () => {
  if (searchDebounce) {
    clearTimeout(searchDebounce);
  }
  searchDebounce = setTimeout(() => {
    refreshWithCurrentFilters();
  }, 280);
});

(async () => {
  try {
    await loadConfig();
    setAutoRefresh(true);
    await Promise.all([loadActions({ append: false }), loadSystemStatus({ force: true })]);
  } catch (err) {
    setStatus(`Error: ${err.message}`);
  }
})();
