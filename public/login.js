const loginForm = document.getElementById('loginForm');
const loginHomeserver = document.getElementById('loginHomeserver');
const loginUser = document.getElementById('loginUser');
const loginPassword = document.getElementById('loginPassword');
const loginSubmitBtn = document.getElementById('loginSubmitBtn');
const loginStatus = document.getElementById('loginStatus');
const loginServerName = document.getElementById('loginServerName');
const loginBaseUrl = document.getElementById('loginBaseUrl');
const loginFlowStatus = document.getElementById('loginFlowStatus');
const envFallbackBtn = document.getElementById('envFallbackBtn');
const envFallbackNote = document.getElementById('envFallbackNote');

const LAST_HOMESERVER_STORAGE_KEY = 'morpheus_manage_last_homeserver';
const params = new URLSearchParams(window.location.search);
const nextPath = params.get('next') || '/index.html';

let matrixLoginEnabled = false;
let envFallbackAvailable = false;
let busy = false;
let statusRequestId = 0;
let statusReloadTimer = null;

async function api(path, options = {}) {
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

function setStatus(message, tone = 'muted') {
  loginStatus.textContent = message;
  loginStatus.dataset.tone = tone;
}

function getRedirectTarget() {
  if (!nextPath.startsWith('/') || nextPath.startsWith('//')) {
    return '/index.html';
  }
  return nextPath;
}

function redirectToTarget() {
  window.location.assign(getRedirectTarget());
}

function getHomeserverValue() {
  return loginHomeserver.value.trim();
}

function rememberHomeserver(value) {
  const homeserver = String(value || '').trim();
  if (!homeserver) return;

  try {
    window.localStorage.setItem(LAST_HOMESERVER_STORAGE_KEY, homeserver);
  } catch (err) {
    // Ignore storage failures in private browsing or locked-down environments.
  }
}

function getRememberedHomeserver() {
  try {
    return window.localStorage.getItem(LAST_HOMESERVER_STORAGE_KEY) || '';
  } catch (err) {
    return '';
  }
}

function renderHomeserverSummary(baseUrl, serverName) {
  loginBaseUrl.textContent = baseUrl || 'Enter a homeserver URL below';
  loginServerName.textContent = serverName || 'that server';
}

function refreshControls() {
  const hasHomeserver = Boolean(getHomeserverValue());
  loginHomeserver.disabled = busy;
  loginUser.disabled = busy;
  loginPassword.disabled = busy;
  loginSubmitBtn.disabled = busy || !matrixLoginEnabled || !hasHomeserver;
  envFallbackBtn.disabled = busy || !envFallbackAvailable;
}

function renderFallbackState({ available, configured, error, baseUrl }) {
  envFallbackAvailable = Boolean(available);

  if (envFallbackAvailable) {
    envFallbackBtn.classList.remove('hidden');
    envFallbackNote.textContent = baseUrl
      ? `A verified preconfigured fallback token is available for ${baseUrl}.`
      : 'A verified preconfigured fallback token is available on this installation.';
    return;
  }

  envFallbackBtn.classList.add('hidden');

  if (configured) {
    envFallbackNote.textContent = error
      ? `A preconfigured fallback token exists, but the server rejected it: ${error}`
      : 'A preconfigured fallback token exists, but it is not currently usable.';
    return;
  }

  envFallbackNote.textContent =
    'No preconfigured fallback token is configured on this installation. The homeserver field above is all you need.';
}

async function loadStatus() {
  const requestId = ++statusRequestId;
  const homeserver = getHomeserverValue();

  renderHomeserverSummary(homeserver || null, homeserver ? 'that homeserver' : 'that server');
  loginFlowStatus.textContent = homeserver ? 'Checking...' : 'Pending';
  setStatus(
    homeserver ? 'Checking homeserver sign-in options...' : 'Enter the homeserver URL you want to manage.',
    homeserver ? 'muted' : 'warning'
  );

  try {
    const query = homeserver ? `?homeserver=${encodeURIComponent(homeserver)}` : '';
    const data = await api(`/api/auth/status${query}`);

    if (requestId !== statusRequestId) {
      return;
    }

    if (data?.authenticated) {
      rememberHomeserver(data?.session?.base_url || data?.base_url || homeserver);
      redirectToTarget();
      return;
    }

    if (!homeserver && data?.base_url) {
      loginHomeserver.value = data.base_url;
    }

    const resolvedBaseUrl = data?.base_url || getHomeserverValue() || null;
    const resolvedServerName = data?.server_name || (resolvedBaseUrl ? 'that homeserver' : 'that server');
    const passwordSupported =
      data?.login?.password_supported === null || data?.login?.password_supported === undefined
        ? null
        : Boolean(data.login.password_supported);
    const ssoSupported = Boolean(data?.login?.sso_supported);
    const flowError = data?.login?.error || null;

    renderHomeserverSummary(resolvedBaseUrl, resolvedServerName);
    renderFallbackState({
      available: data?.env_fallback_available,
      configured: data?.env_fallback_configured,
      error: data?.env_fallback_error,
      baseUrl: data?.session?.base_url || data?.base_url || null
    });

    if (!resolvedBaseUrl) {
      loginFlowStatus.textContent = 'Enter homeserver';
      matrixLoginEnabled = false;
      setStatus('Enter the homeserver URL you want to manage.', 'warning');
    } else if (flowError) {
      loginFlowStatus.textContent = 'Unknown';
      matrixLoginEnabled = true;
      setStatus(
        envFallbackAvailable
          ? `Unable to query login flows: ${flowError}. You can still try signing in manually or use the preconfigured fallback token below.`
          : `Unable to query login flows: ${flowError}. You can still try signing in manually.`,
        'warning'
      );
    } else if (passwordSupported === false) {
      loginFlowStatus.textContent = ssoSupported ? 'SSO only' : 'Unavailable';
      matrixLoginEnabled = false;
      setStatus(
        envFallbackAvailable
          ? `${
              ssoSupported
                ? 'This homeserver is advertising SSO-style sign-in instead of password login.'
                : 'This homeserver is not advertising password login.'
            } You can still use the preconfigured fallback token below.`
          : ssoSupported
            ? 'This homeserver is advertising SSO-style sign-in instead of password login.'
            : 'This homeserver is not advertising password login.',
        'warning'
      );
    } else {
      loginFlowStatus.textContent = passwordSupported ? 'Supported' : 'Unknown';
      matrixLoginEnabled = true;
      setStatus(
        envFallbackAvailable
          ? 'Sign in with a Synapse admin account, or use the preconfigured fallback token below.'
          : 'Sign in with a Synapse admin account.',
        'muted'
      );
    }
  } catch (err) {
    if (requestId !== statusRequestId) {
      return;
    }

    matrixLoginEnabled = Boolean(getHomeserverValue());
    envFallbackAvailable = false;
    loginFlowStatus.textContent = getHomeserverValue() ? 'Unknown' : 'Pending';
    renderFallbackState({
      available: false,
      configured: false,
      error: null,
      baseUrl: null
    });
    setStatus(`Unable to load sign-in options: ${err.message}. You can still try signing in manually.`, 'warning');
  } finally {
    if (requestId === statusRequestId) {
      refreshControls();
    }
  }
}

function scheduleStatusReload() {
  if (statusReloadTimer) {
    clearTimeout(statusReloadTimer);
  }

  statusReloadTimer = setTimeout(() => {
    statusReloadTimer = null;
    void loadStatus();
  }, 350);
}

loginHomeserver.addEventListener('input', () => {
  refreshControls();
  scheduleStatusReload();
});

loginHomeserver.addEventListener('blur', () => {
  if (statusReloadTimer) {
    clearTimeout(statusReloadTimer);
    statusReloadTimer = null;
  }
  void loadStatus();
});

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  const homeserver = getHomeserverValue();
  const user = loginUser.value.trim();
  const password = loginPassword.value;

  if (!homeserver) {
    setStatus('Enter the homeserver URL you want to manage.', 'warning');
    refreshControls();
    return;
  }

  if (!user || !password) {
    setStatus('Enter both a Matrix user ID/localpart and a password.', 'warning');
    return;
  }

  busy = true;
  refreshControls();
  setStatus('Signing in with Matrix credentials...');

  try {
    const data = await api('/api/auth/login', {
      method: 'POST',
      body: {
        homeserver,
        user,
        password
      }
    });
    rememberHomeserver(data?.session?.base_url || homeserver);
    redirectToTarget();
  } catch (err) {
    busy = false;
    setStatus(err.message, 'danger');
    refreshControls();
  }
});

envFallbackBtn.addEventListener('click', async () => {
  busy = true;
  refreshControls();
  setStatus('Switching to preconfigured fallback token...');

  try {
    const data = await api('/api/auth/use-env', {
      method: 'POST'
    });
    rememberHomeserver(data?.session?.base_url || getHomeserverValue());
    redirectToTarget();
  } catch (err) {
    busy = false;
    setStatus(err.message, 'danger');
    refreshControls();
  }
});

const rememberedHomeserver = getRememberedHomeserver();
if (rememberedHomeserver) {
  loginHomeserver.value = rememberedHomeserver;
}

refreshControls();
void loadStatus();
