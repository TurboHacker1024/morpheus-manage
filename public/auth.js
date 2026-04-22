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
  if (status.auth_mode === 'env_token') {
    return status?.session?.user_id
      ? `Preconfigured token as ${status.session.user_id}`
      : 'Preconfigured fallback token';
  }
  return status?.session?.user_id || 'Matrix admin session';
}

async function loadAuthPanel() {
  const sidePane = document.querySelector('.side-pane');
  if (!sidePane) return;

  const paneFooter = sidePane.querySelector('.pane-footer');
  if (!paneFooter) return;

  try {
    const status = await authApi('/api/auth/status');

    if (!status?.authenticated) {
      const next = window.location.pathname + window.location.search;
      window.location.assign(`/login.html?next=${encodeURIComponent(next)}`);
      return;
    }

    const panel = document.createElement('div');
    panel.className = 'session-panel';

    const copy = document.createElement('div');
    copy.className = 'session-copy';

    const mode = document.createElement('span');
    mode.className = 'session-mode';
    mode.textContent = status.auth_mode === 'env_token' ? 'Preconfigured fallback session' : 'Matrix admin session';

    const label = document.createElement('strong');
    label.className = 'session-label';
    label.textContent = getSessionLabel(status);

    copy.appendChild(mode);
    copy.appendChild(label);

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

    panel.appendChild(copy);
    panel.appendChild(logoutBtn);
    sidePane.insertBefore(panel, paneFooter);
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
