# TabFleet marketing site

Product landing page for TabFleet. Lives at `https://abdulsamad2.github.io/tab_fleet/` via GitHub Pages (Settings → Pages → `main` / `/docs`).

## Editing content

Everything is in `index.html` — the hero copy, pricing numbers, FAQ answers, contact email/Telegram handle. No build step; edit the HTML, commit, push, done.

Common edits:

- **Pricing numbers** — search `$79`, `$199`, change inline.
- **Contact** — `sales@tabfleet.app` and `https://t.me/tabfleet` placeholders — replace with your real sales email + Telegram.
- **Version badge** — `Version 1.3.14` in the hero eyebrow.
- **Stats row** — `20+`, `< 3s`, `1-click`, `100%` under the hero.

## Adding real screenshots

Each `<img>` has a fallback that renders a dashed placeholder if the file is missing. Drop PNGs at these paths to replace them:

| Slot              | Path                                                 | Suggested capture                                           |
|-------------------|------------------------------------------------------|-------------------------------------------------------------|
| Hero              | `docs/assets/screenshots/hero.png`                   | Main window with 8+ tabs, status strip, side panel          |
| Launcher          | `docs/assets/screenshots/launcher.png`               | Proxy source + account group pickers                        |
| Tabs              | `docs/assets/screenshots/tabs.png`                   | Tab strip with groups, order chips, multi-select highlighted |
| Playbooks         | `docs/assets/screenshots/playbooks.png`              | Playbooks modal with saved playbooks list                   |
| Bulk shortcuts    | `docs/assets/screenshots/bulk-shortcuts.png`         | Right-click menu showing bulk section                       |
| Bulk (feature)    | `docs/assets/screenshots/bulk.png`                   | Multi-select highlighted on tab strip                       |
| Proxies (feature) | `docs/assets/screenshots/proxies.png`                | Status strip with proxy / cooldown                          |

Suggested size: 2000×1200 at 2x retina, optimized with `pngquant --quality 70-85`.

## Local preview

```bash
cd docs
python3 -m http.server 8080
open http://localhost:8080
```

## File map

- `index.html` — landing page (hero → features → how-it-works → use cases → shortcuts → pricing → FAQ → contact).
- `assets/styles.css` — dark theme, gradient hero, bento grid, pricing cards.
- `assets/script.js` — nav scrollspy.
- `assets/icon.svg` — favicon.
- `assets/screenshots/` — optional screenshot slots (placeholders render if missing).
