# FlexFlow

A lightweight, offline-first workspace for running live performance flow — task cards with timed checklists, a month calendar, quick notes, and an artists/stage directory.

## Why FlexFlow

- **Lightweight** — the app itself is still one HTML file; no framework, no build step, no dependencies, no CDN. A small PWA support layer (`manifest.webmanifest`, `sw.js`, `icons/`) is now checked in alongside it, so the project is no longer literally a single file.
- **Local** — all data stays in your browser (`localStorage` + IndexedDB for video). Nothing is uploaded.
- **Secure / private** — no accounts, no tracking, no network calls except images you explicitly link. Includes URL validation against `javascript:` injection.
- **Free for life** — no subscription, no licence fee.
- **Works offline** — install it once (over `https://` or `localhost`) and let the service worker serve the cached shell when the network is gone; the first load must be online. Opening the file from disk still runs the app, but `file://` never installs or registers a service worker. Camera, mic, geolocation and sharing also need `https://` or `localhost`.

## How to use it

1. Open `FlexFlow.html` in a modern browser. To install it as an app and to use the camera, microphone, geolocation and sharing, serve it over `https://` or `localhost` (see [Install and offline](#install-and-offline)).
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
9. Move data to another device with **Settings → Save transfer file** on the sender, then choose **Share** or **Save (.zip)** in the review sheet, and **Settings → Import transfer file** on the receiver (see [Transfer between devices](#transfer-between-devices)).

## Install and offline

FlexFlow is installable on Android, iOS/iPadOS and desktop. Install and the service worker both need the page to be served over `https://` (or `http://localhost`); opening `FlexFlow.html` straight from disk still runs the whole app, but the PWA features stay off.

- **Android / Chrome** — open the app over `https://`, then accept the browser's **Install app** prompt or use **Settings → App → Install** in FlexFlow. Chrome's menu also offers **Add to Home screen**.
- **iPhone / iPad (Safari)** — Safari has no install prompt. Open the app, tap **Share**, then **Add to Home Screen**. (The Settings → App row shows this reminder instead of an install button.)
- **Desktop (Chrome, Edge and similar)** — click the install icon in the address bar, or use the browser menu's **Install** entry; the app then opens in its own window.

Once installed, `sw.js` precaches the app shell under the cache name `flexflow-shell-v1` and serves those cached responses when the network is gone. The first load has to be online so the shell can be cached; after that, the app and the assets it cached keep working offline. Your work never leaves the device: task data stays in `localStorage`, media stays in IndexedDB, and nothing depends on the network. `file://` does not install the app and never registers the service worker.

**Caveat (iOS):** Safari may evict site data for a home-screen app or site you have not opened for a while. Installing the app and allowing persistent storage (FlexFlow requests it through `navigator.storage.persist()` where supported) lowers the risk, but it is not a guarantee — export a backup regularly, especially before a long break.

## Transfer between devices

Phone-to-phone transfer uses the operating system's share sheet or a file import — there is no pairing step:

1. On the sender, open **Settings → Save transfer file**. In the review sheet choose **Share** to hand the `.zip` to the OS share sheet (Quick Share on Android, AirDrop on Apple devices, Messages, Files, email…). If the browser cannot share files, the Share button is hidden and **Save (.zip)** is the primary action. Either way you get a real `.zip` you can send yourself.
2. On the receiver, open **Settings → Import transfer file** and pick the `.zip`. Accept it, download the required backup of the current device, choose **Merge** or **Replace**, then confirm. Nothing is written until that final confirm.

Bluetooth was deliberately removed: a browser can never host a BLE advertisement or receive connection, and iOS has no Web Bluetooth, so phone-to-phone Bluetooth transfer is impossible for a web app. The share sheet and file import replace it, and the transfer is always a file you can see and keep.

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

- The app is `FlexFlow.html` plus new PWA support files: `manifest.webmanifest`, `sw.js` and `icons/` (192/512 any-purpose, 512 maskable, 180 apple-touch-icon). It is therefore no longer literally one file, but there is still no build step, no dependencies and no CDN.
- `sw.js` caches the shell (`flexflow-shell-v1`), uses stale-while-revalidate for assets, and only handles same-origin `GET` requests.
- Hand-rolled ZIP writer/reader (STORE only).
- Cambodia (`Asia/Phnom_Penh`) timezone for all scheduling logic.

## License / Credits

Best regards

https://github.com/sassdahRAK/flexflow
