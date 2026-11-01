// Zentrale Konfiguration.
// Die Client-ID ist bei PKCE KEIN Geheimnis und darf im öffentlichen Repo stehen.
// Ein Client Secret wird NICHT benötigt und darf hier NIE eingetragen werden.
export const CONFIG = {
  CLIENT_ID: "44ffbebc609f4f77a99a874d07f9ea4d",
  SCOPES: [
    "playlist-read-private",
    "playlist-read-collaborative",
    "playlist-modify-public",
    "playlist-modify-private",
    "user-read-playback-state",
    "user-modify-playback-state",
    "user-library-read",
    "user-library-modify",
  ],
  APP_VERSION: "1.0.0",
  // Deezer: max. 50 Requests / 5 s -> mit 160 ms Abstand bleiben wir sicher darunter
  DEEZER_MIN_INTERVAL_MS: 160,
  // "Nicht gefunden"-Ergebnisse nach X Tagen erneut versuchen
  META_NOTFOUND_RETRY_DAYS: 30,
  // Ab so vielen Einzelschritten wird beim Speichern der Sortierung der Schnellmodus angeboten
  REORDER_FAST_THRESHOLD: 250,
  MAX_BACKUPS: 60,
};
