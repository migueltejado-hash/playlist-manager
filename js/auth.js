// Spotify Login per Authorization Code Flow mit PKCE (ohne Client Secret).
import { CONFIG } from "./config.js";

const LS = {
  token: "pm_token",
  verifier: "pm_pkce_verifier",
  state: "pm_pkce_state",
  clientId: "pm_client_id",
};

export function getClientId() {
  return (localStorage.getItem(LS.clientId) || CONFIG.CLIENT_ID).trim();
}

export function setClientId(id) {
  if (id && id.trim()) localStorage.setItem(LS.clientId, id.trim());
  else localStorage.removeItem(LS.clientId);
}

// Muss exakt so im Spotify Dashboard unter "Redirect URIs" eingetragen sein.
export function getRedirectUri() {
  return location.origin + location.pathname.replace(/index\.html$/, "");
}

function b64url(bytes) {
  let s = "";
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomString(len) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const rnd = new Uint8Array(len);
  crypto.getRandomValues(rnd);
  let out = "";
  for (let i = 0; i < len; i++) out += chars[rnd[i] % chars.length];
  return out;
}

function readToken() {
  try {
    return JSON.parse(localStorage.getItem(LS.token) || "null");
  } catch {
    return null;
  }
}

function writeToken(t) {
  localStorage.setItem(LS.token, JSON.stringify(t));
}

export function isLoggedIn() {
  const t = readToken();
  return !!(t && t.refresh_token);
}

export function logout() {
  localStorage.removeItem(LS.token);
}

export async function startLogin() {
  const verifier = randomString(96);
  const state = randomString(24);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  localStorage.setItem(LS.verifier, verifier);
  localStorage.setItem(LS.state, state);

  const p = new URLSearchParams({
    client_id: getClientId(),
    response_type: "code",
    redirect_uri: getRedirectUri(),
    code_challenge_method: "S256",
    code_challenge: b64url(digest),
    scope: CONFIG.SCOPES.join(" "),
    state,
  });
  location.assign("https://accounts.spotify.com/authorize?" + p.toString());
}

async function tokenRequest(params) {
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error_description || data.error || `Token-Fehler HTTP ${res.status}`);
    err.code = data.error;
    throw err;
  }
  return data;
}

function storeTokenResponse(data, previous) {
  writeToken({
    access_token: data.access_token,
    // Spotify liefert beim Refresh nicht immer einen neuen Refresh-Token
    refresh_token: data.refresh_token || (previous && previous.refresh_token),
    expires_at: Date.now() + (data.expires_in || 3600) * 1000,
    scope: data.scope,
  });
}

// Wird beim Seitenstart aufgerufen. Gibt true zurück, wenn ein Login abgeschlossen wurde.
export async function handleRedirectCallback() {
  const q = new URLSearchParams(location.search);
  const code = q.get("code");
  const error = q.get("error");
  if (!code && !error) return false;

  const cleanUrl = () => history.replaceState({}, "", getRedirectUri());

  if (error) {
    cleanUrl();
    throw new Error(`Spotify-Login abgebrochen: ${error}`);
  }
  const expectedState = localStorage.getItem(LS.state);
  const verifier = localStorage.getItem(LS.verifier);
  localStorage.removeItem(LS.state);
  localStorage.removeItem(LS.verifier);
  cleanUrl();

  if (!verifier || !expectedState || q.get("state") !== expectedState) {
    throw new Error(
      "Login-Antwort passt nicht zur Anfrage (State/Verifier fehlt). Bitte erneut anmelden – " +
        "auf dem iPhone den Login aus der Home-Bildschirm-App starten, nicht aus Safari."
    );
  }

  const data = await tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: getRedirectUri(),
    client_id: getClientId(),
    code_verifier: verifier,
  });
  storeTokenResponse(data, null);
  return true;
}

let refreshPromise = null;

export async function refreshToken() {
  if (refreshPromise) return refreshPromise;
  const t = readToken();
  if (!t || !t.refresh_token) throw new AuthRequiredError();
  refreshPromise = (async () => {
    try {
      const data = await tokenRequest({
        grant_type: "refresh_token",
        refresh_token: t.refresh_token,
        client_id: getClientId(),
      });
      storeTokenResponse(data, t);
    } catch (e) {
      // invalid_grant = Refresh-Token abgelaufen (Spotify: max. 6 Monate) oder widerrufen
      if (e.code === "invalid_grant") {
        logout();
        throw new AuthRequiredError();
      }
      throw e;
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

export async function getAccessToken() {
  let t = readToken();
  if (!t || !t.access_token) throw new AuthRequiredError();
  if (Date.now() > t.expires_at - 60_000) {
    await refreshToken();
    t = readToken();
  }
  return t.access_token;
}

export class AuthRequiredError extends Error {
  constructor() {
    super("Anmeldung erforderlich – bitte neu bei Spotify anmelden.");
    this.name = "AuthRequiredError";
  }
}
