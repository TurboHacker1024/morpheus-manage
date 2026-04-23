const shellState = {
  authStatus: null,
  lastApiActivityAt: null,
  refreshTimer: null
};

const nativeFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  const response = await nativeFetch(...args);

  try {
    const input = args[0];
    const requestUrl = new URL(
      typeof input === 'string' ? input : input?.url || '',
      window.location.origin
    );
    const isTrackedApiCall =
      requestUrl.origin === window.location.origin &&
      requestUrl.pathname.startsWith('/api/') &&
      !requestUrl.pathname.startsWith('/api/auth/');

    if (response.ok && isTrackedApiCall) {
      recordShellRefresh();
    }
  } catch (err) {
    // Ignore URL parsing issues for non-standard fetch inputs.
  }

  return response;
};

async function authApi(path, options = {}) {
  const config = {
    headers: {
      'Content-Type': 'application/json'
    },
    credentials: 'same-origin',
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
    throw new Error(data?.error || data?.details?.error || `Request failed (${response.status})`);
  }

  return data;
}

function getSessionLabel(status) {
  if (!status?.authenticated) return 'Signed out';
  if (status?.session?.user_id) return status.session.user_id;
  return status.auth_mode === 'env_token' ? 'Preconfigured fallback token' : 'Matrix admin session';
}

function formatRefreshTime(timestamp) {
  if (!timestamp) return 'Waiting for live data';

  const elapsedMs = Math.max(0, Date.now() - timestamp);
  if (elapsedMs < 15 * 1000) return 'Just now';
  if (elapsedMs < 60 * 1000) return `${Math.round(elapsedMs / 1000)}s ago`;
  if (elapsedMs < 60 * 60 * 1000) return `${Math.round(elapsedMs / 60000)}m ago`;

  return new Date(timestamp).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit'
  });
}

function getHeaderServerLabel(status) {
  return status?.session?.server_name || status?.server_name || 'No server selected';
}

function recordShellRefresh() {
  shellState.lastApiActivityAt = Date.now();
  renderWorkspaceHeader();
}

function ensureRefreshTimer() {
  if (shellState.refreshTimer) return;
  shellState.refreshTimer = window.setInterval(() => {
    if (!document.querySelector('.workspace-header-last-refresh')) return;
    renderWorkspaceHeader();
  }, 30000);
}

function getPrimaryActionConfig() {
  const target = document.body.dataset.shellPrimaryActionTarget || '';
  const label = document.body.dataset.shellPrimaryActionLabel || '';
  const kind = document.body.dataset.shellPrimaryActionKind || 'click';

  if (!label) return null;

  return {
    target,
    label,
    kind
  };
}

function wirePrimaryAction(button, config) {
  if (!button || !config) return;

  button.textContent = config.label;
  button.className = 'btn primary workspace-primary-action';

  const handleClick = () => {
    if (config.kind === 'reload') {
      window.location.reload();
      return;
    }

    const target = document.getElementById(config.target);
    if (target) {
      target.click();
    }
  };

  button.onclick = handleClick;

  if (config.kind === 'reload') {
    button.disabled = false;
    return;
  }

  button.disabled = !document.getElementById(config.target);
}

function ensureWorkspaceHeaderStructure() {
  const header = document.querySelector('.workspace-header');
  if (!header) return null;

  const existingSide = header.querySelector('.workspace-header-side');
  if (existingSide) {
    return {
      header,
      side: existingSide,
      status: existingSide.querySelector('.status') || header.querySelector('.status')
    };
  }

  const headerMain = header.firstElementChild;
  if (headerMain) {
    headerMain.classList.add('workspace-header-main');
  }

  const status = header.querySelector('.status');
  const side = document.createElement('div');
  side.className = 'workspace-header-side';

  const context = document.createElement('div');
  context.className = 'workspace-context';

  const meta = document.createElement('div');
  meta.className = 'workspace-meta';

  const makeChip = (label, extraClass = '') => {
    const chip = document.createElement('div');
    chip.className = `workspace-meta-chip${extraClass ? ` ${extraClass}` : ''}`;

    const chipLabel = document.createElement('span');
    chipLabel.className = 'workspace-meta-label';
    chipLabel.textContent = label;

    const chipValue = document.createElement('strong');
    chipValue.className = 'workspace-meta-value';

    chip.appendChild(chipLabel);
    chip.appendChild(chipValue);
    meta.appendChild(chip);

    return chipValue;
  };

  makeChip('Active server', 'workspace-header-server');
  makeChip('Last refresh', 'workspace-header-last-refresh');

  const actions = document.createElement('div');
  actions.className = 'workspace-header-actions';

  const primaryActionButton = document.createElement('button');
  primaryActionButton.type = 'button';
  actions.appendChild(primaryActionButton);

  context.appendChild(meta);
  context.appendChild(actions);
  side.appendChild(context);

  if (status) {
    side.appendChild(status);
  }

  header.appendChild(side);

  return {
    header,
    side,
    status
  };
}

function renderWorkspaceHeader() {
  const headerParts = ensureWorkspaceHeaderStructure();
  if (!headerParts) return;

  const { side } = headerParts;
  const status = shellState.authStatus;
  const primaryActionConfig = getPrimaryActionConfig();

  const serverValue = side.querySelector('.workspace-header-server .workspace-meta-value');
  const refreshValue = side.querySelector('.workspace-header-last-refresh .workspace-meta-value');
  const actions = side.querySelector('.workspace-header-actions');

  if (serverValue) {
    serverValue.textContent = getHeaderServerLabel(status);
  }

  if (refreshValue) {
    refreshValue.textContent = formatRefreshTime(shellState.lastApiActivityAt);
    if (shellState.lastApiActivityAt) {
      refreshValue.title = new Date(shellState.lastApiActivityAt).toLocaleString();
    } else {
      refreshValue.removeAttribute('title');
    }
  }

  if (actions) {
    const button = actions.querySelector('button');
    if (primaryActionConfig) {
      actions.hidden = false;
      wirePrimaryAction(button, primaryActionConfig);
    } else {
      actions.hidden = true;
    }
  }

  ensureRefreshTimer();
}

async function loadAuthPanel() {
  const sidePane = document.querySelector('.side-pane');
  const paneFooter = sidePane?.querySelector('.pane-footer') || null;

  try {
    const status = await authApi('/api/auth/status');
    shellState.authStatus = status;

    if (!status?.authenticated) {
      const next = window.location.pathname + window.location.search;
      window.location.assign(`/login.html?next=${encodeURIComponent(next)}`);
      return;
    }

    renderWorkspaceHeader();

    if (!sidePane || !paneFooter) return;

    const existingPanel = sidePane.querySelector('.session-panel');
    if (existingPanel) {
      existingPanel.remove();
    }

    const panel = document.createElement('div');
    panel.className = 'session-panel';

    const heading = document.createElement('span');
    heading.className = 'session-mode';
    heading.textContent = 'Active environment';

    const server = document.createElement('strong');
    server.className = 'session-server';
    server.textContent = getHeaderServerLabel(status);

    const details = document.createElement('div');
    details.className = 'session-details';

    const makeDetail = (labelText, valueText) => {
      const detail = document.createElement('div');
      detail.className = 'session-detail';

      const label = document.createElement('span');
      label.className = 'session-detail-label';
      label.textContent = labelText;

      const value = document.createElement('strong');
      value.className = 'session-detail-value';
      value.textContent = valueText;

      detail.appendChild(label);
      detail.appendChild(value);
      details.appendChild(detail);
    };

    makeDetail('Account', getSessionLabel(status));

    const logoutBtn = document.createElement('button');
    logoutBtn.type = 'button';
    logoutBtn.className = 'btn ghost session-logout';
    logoutBtn.textContent = 'Log out';
    logoutBtn.addEventListener('click', async () => {
      logoutBtn.disabled = true;
      logoutBtn.textContent = 'Signing out...';
      try {
        await authApi('/api/auth/logout', { method: 'POST' });
      } finally {
        window.location.assign('/login.html');
      }
    });

    panel.appendChild(heading);
    panel.appendChild(server);
    panel.appendChild(details);
    panel.appendChild(logoutBtn);

    if (paneFooter) {
      sidePane.insertBefore(panel, paneFooter);
    } else {
      sidePane.appendChild(panel);
    }
  } catch (err) {
    const next = window.location.pathname + window.location.search;
    window.location.assign(`/login.html?next=${encodeURIComponent(next)}`);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', loadAuthPanel);
} else {
  loadAuthPanel();
}
