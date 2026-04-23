const loginForm = document.getElementById('loginForm');
const loginHomeserver = document.getElementById('loginHomeserver');
const loginUser = document.getElementById('loginUser');
const loginPassword = document.getElementById('loginPassword');
const loginSubmitBtn = document.getElementById('loginSubmitBtn');
const loginStatus = document.getElementById('loginStatus');
const loginBaseUrl = document.getElementById('loginBaseUrl');
const loginFlowStatus = document.getElementById('loginFlowStatus');
const loginFallback = document.getElementById('loginFallback');
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

function renderHomeserverSummary(baseUrl) {
  loginBaseUrl.textContent = baseUrl || 'Enter a homeserver';
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
  const showFallbackSection = Boolean(available || configured);

  loginFallback.classList.toggle('hidden', !showFallbackSection);
  envFallbackBtn.classList.toggle('hidden', !envFallbackAvailable);
  envFallbackNote.classList.add('hidden');
  envFallbackNote.textContent = '';

  if (envFallbackAvailable) {
    envFallbackBtn.textContent = baseUrl ? `Use fallback token for ${baseUrl}` : 'Use fallback token';
    return;
  }

  if (configured) {
    envFallbackNote.classList.remove('hidden');
    envFallbackNote.textContent = error
      ? `Fallback token unavailable: ${error}`
      : 'Fallback token is configured but unavailable.';
  }
}

async function loadStatus() {
  const requestId = ++statusRequestId;
  const homeserver = getHomeserverValue();

  renderHomeserverSummary(homeserver || null);
  loginFlowStatus.textContent = homeserver ? 'Checking...' : 'Pending';
  setStatus(
    homeserver ? 'Checking sign-in options...' : 'Enter a homeserver.',
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
    const passwordSupported =
      data?.login?.password_supported === null || data?.login?.password_supported === undefined
        ? null
        : Boolean(data.login.password_supported);
    const ssoSupported = Boolean(data?.login?.sso_supported);
    const flowError = data?.login?.error || null;

    renderHomeserverSummary(resolvedBaseUrl);
    renderFallbackState({
      available: data?.env_fallback_available,
      configured: data?.env_fallback_configured,
      error: data?.env_fallback_error,
      baseUrl: data?.session?.base_url || data?.base_url || null
    });

    if (!resolvedBaseUrl) {
      loginFlowStatus.textContent = 'Enter homeserver';
      matrixLoginEnabled = false;
      setStatus('Enter a homeserver.', 'warning');
    } else if (flowError) {
      loginFlowStatus.textContent = 'Unknown';
      matrixLoginEnabled = true;
      setStatus(`Couldn't verify login flow: ${flowError}`, 'warning');
    } else if (passwordSupported === false) {
      loginFlowStatus.textContent = ssoSupported ? 'SSO only' : 'Unavailable';
      matrixLoginEnabled = false;
      setStatus(
        ssoSupported ? 'Password login is unavailable on this homeserver.' : 'Password login is unavailable.',
        'warning'
      );
    } else {
      loginFlowStatus.textContent = passwordSupported ? 'Supported' : 'Unknown';
      matrixLoginEnabled = true;
      setStatus('Ready to sign in.', 'muted');
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
    setStatus(`Couldn't load sign-in options: ${err.message}`, 'warning');
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
    setStatus('Enter a homeserver.', 'warning');
    refreshControls();
    return;
  }

  if (!user || !password) {
    setStatus('Enter both account and password.', 'warning');
    return;
  }

  busy = true;
  refreshControls();
  setStatus('Signing in...');

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
  setStatus('Using fallback token...');

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
