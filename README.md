# Playlist Manager v1.0

Web-App (PWA) zum Verwalten, Sortieren und Importieren von Spotify-Playlists. Läuft direkt im Browser (PC und iPhone) und kommt ohne Server aus. Gehostet wird sie über GitHub Pages.
Nachfolger des Python-Tools „Spotify Universal Playlist Manager & Importer“.

## Funktionen
- Login per **PKCE** ohne Client Secret. Der Refresh-Token läuft bei Spotify nach max. 6 Monaten ab, dann einfach neu anmelden.
- Eigene und kollaborative Playlists anzeigen, mit BPM (Deezer), Jahr, Dauer, Explicit-Kennzeichen und Hinweis auf nicht verfügbare Titel
- **BPM über Deezer**: zuerst exakt über den ISRC, sonst Suche mit Abgleich von Interpret, Titel und Dauer. Die Ergebnisse werden lokal gecacht.
- Sortieren nach BPM, Jahr, Titel, Interpret oder Datum „hinzugefügt“, dazu **Mischen ohne Interpret-Wiederholung**
- **Reihenfolge speichern ohne Verlust**: Die Titel werden per Einzel-Verschiebung umsortiert, das Datum „hinzugefügt“ bleibt erhalten. Für große Playlists gibt es einen Schnellmodus.
- Titel verschieben (▲▼) und entfernen. Beim Entfernen bleiben nicht markierte Duplikate erhalten.
- **Duplikat-Finder** (gleiche URI, gleicher ISRC oder gleicher Interpret+Titel bei ähnlicher Dauer)
- Filter nach Text, BPM-Bereich und Jahr. Die gefilterte Ansicht lässt sich **als neue Playlist speichern** („Smart-Playlist“).
- Klonen, Leeren, Löschen/Entfolgen, Abspielen (Spotify-App muss offen sein)
- Export als CSV (Excel-tauglich), TXT oder JSON
- **Automatisches Backup** vor jeder Änderung, Wiederherstellen als neue Playlist, JSON-Backup importieren
- **Import** aus Text, CSV oder Spotify-Links und aus **öffentlichen Deezer-Playlists**. Jeder Treffer wird mit einer Bewertung angezeigt, bis zu 10 Alternativen stehen zur Auswahl, nicht gefundene Titel lassen sich exportieren.

## Grenzen durch Spotify (Development Mode, Stand 2026)
- Titel **fremder** Playlists sind nicht mehr lesbar. Workaround: in der Spotify-App alle Titel markieren und in eine eigene Playlist kopieren.
- Höchstens 5 freigeschaltete Nutzer, und der App-Besitzer braucht Spotify Premium.
- Tonart, Energy usw. (Audio-Features) liefert Spotify nicht mehr, deshalb kommt das BPM von Deezer.

## Einrichtung (einmalig)
1. **Spotify Dashboard** (https://developer.spotify.com/dashboard) → App → **Settings**:
   - Unter *Redirect URIs* `https://migueltejado-hash.github.io/playlist-manager/` eintragen (mit Schrägstrich am Ende) → **Save**
   - Unter *User Management* alle Spotify-Konten eintragen, die die App nutzen sollen
   - Ein Client Secret wird nicht benötigt. Das alte Secret war öffentlich sichtbar, deshalb **Rotate client secret** ausführen.
2. **GitHub**: Repo `playlist-manager` → **Add file → Upload files** → den *Inhalt* des ZIP hineinziehen. `index.html` muss im Root liegen, die Ordner `js/`, `icons/`, `tests/` und die Datei `.nojekyll` mit hochladen. Dann **Commit changes**.
3. **Settings → Pages → Source: Deploy from a branch → `main` / `/ (root)` → Save**. Nach 1–2 Minuten ist die App unter https://migueltejado-hash.github.io/playlist-manager/ erreichbar.
4. **iPhone**: in Safari öffnen → Teilen → **Zum Home-Bildschirm**. Danach nur noch diese App benutzen, auch für den Login.

## Updates
Geänderte Dateien hochladen und dabei gleiche Namen überschreiben. Der Service Worker lädt immer zuerst die neueste Version aus dem Netz, eine Versionsnummer musst du nicht hochzählen. Die App danach einmal schließen und neu öffnen.

## Datenschutz
- Token, BPM-Cache und Backups liegen nur im Browser des jeweiligen Geräts.
- Externe Aufrufe gehen nur an Spotify (Login und API) und an die Deezer-API (Interpret, Titel und ISRC für die BPM-Suche).
- Das Repo ist öffentlich: der **Code** ist sichtbar, die Daten nicht. Die Client-ID ist bei PKCE kein Geheimnis.

## Entwicklung
- Logik-Tests: `node tests/match.test.mjs`
- Lokal testen: `python3 -m http.server 8000` → http://localhost:8000/. Dafür muss zusätzlich `http://localhost:8000/` als Redirect URI im Dashboard stehen. Spotify erlaubt `localhost` eventuell nicht, dann `http://127.0.0.1:8000/` verwenden.
- Struktur: `js/auth.js` (PKCE), `js/spotify.js` (API), `js/deezer.js` (BPM), `js/match.js` (Parser/Matching/Algorithmen), `js/importer.js`, `js/store.js` (IndexedDB), `js/app.js` (UI)
