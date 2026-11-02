# FlexFlow

A lightweight, offline-first workspace for running live performance flow — task cards with timed checklists, a month calendar, quick notes, and an artists/stage directory.

## Why FlexFlow

- **Lightweight** — one HTML file; no framework, no build step, no dependencies, no CDN.
- **Local** — all data stays in your browser (`localStorage` + IndexedDB for video). Nothing is uploaded.
- **Secure / private** — no accounts, no tracking, no network calls except images you explicitly link. Includes URL validation against `javascript:` injection.
- **Free for life** — no subscription, no licence fee.
- **Works offline** — open the file from disk; no server required (except camera/mic/geolocation/share, which browsers require to be served over `https://` or `localhost`).

## How to use it

1. Open `FlexFlow.html` in a modern browser. To use the camera, microphone, geolocation and sharing, serve it over `https://` or `localhost`.
2. Use the five tabs:
   - **Home** — task cards and their timed checklists.
   - **Info** — the artists and stage directory.
   - **Quick Note** — capture text, photos, voice, video and more.
   - **Clock** — the clock view.
   - **Settings** — appearance, data and backup controls.
3. Create a card, then add checklist items with a date and a duration.
4. Tick item statuses as work progresses. Status colours are driven by Cambodia time.
5. Reorder cards: long-press in normal mode, or use the handle in edit mode.
6. Use the calendar: tap a date to view it, Cambodian public holidays are marked, and a starred card rings its date.
7. Add artists on the Info tab with their details, call times, rooms and contacts.
8. Back up regularly: **Settings → Backup → Export**, choosing Changes, Media or Full ZIP. Import with either Merge or Replace.

## Features

- Timed task cards with four-state status colours driven by Cambodia time.
- Auto-sort by start time, with queue re-chaining on reorder.
- Card covers from an image URL.
- Checklist notes with a line placeholder when empty.
- Star a card to ring its date.
- Month calendar with Cambodian public holidays and a holiday card.
- Quick notes with text, photo, camera, voice recording, video (30s, stored in IndexedDB), image links, location, native sharing and replay.
- Artists directory with members/ages/minors + guardian, four call times, holding rooms, contacts with `tel:` / Telegram / Messenger deep links, protocol notes and a live status board.
- Monochrome black-and-white design with AA-contrast text and keyboard-accessible controls.
- Three backup types with a hand-rolled ZIP (validated by `unzip`), merge with newest-wins, and an operation change log.

## Data and privacy

Data stays in your browser, under these keys:

- `cambodia_task_manager_v2` — task cards and checklists
- `cambodia_quick_notes_v1` — quick notes
- `cambodia_artists_v1` — artists directory
- `cambodia_change_log_v1` — operation change log
- `cambodia_media_db` — IndexedDB database for media such as video

Clearing site data deletes all of it, so export a backup first.

## Tech notes

- Single file, vanilla JavaScript, no dependencies.
- Hand-rolled ZIP writer/reader (STORE only).
- Cambodia (`Asia/Phnom_Penh`) timezone for all scheduling logic.

## License / Credits

Best regards

https://github.com/sassdahRAK/flexflow
