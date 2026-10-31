# TabFleet documentation site

Static single-page docs served from this `docs/` folder via GitHub Pages.

## Enabling GitHub Pages

1. Push this folder to the `main` branch.
2. Repo → **Settings → Pages**.
3. Under **Build and deployment**:
   - **Source**: Deploy from a branch
   - **Branch**: `main` · Folder: `/docs`
4. Save. The site goes live at `https://abdulsamad2.github.io/tab_fleet/` within a minute.

## Adding real screenshots

Each `<figure>` in `index.html` uses an `<img>` that falls back to a dashed placeholder when the image is missing. To replace a placeholder with a real screenshot:

| Placeholder slot    | Drop a PNG at                             | What to capture                                   |
|---------------------|-------------------------------------------|---------------------------------------------------|
| Hero                | `docs/assets/screenshots/hero.png`        | Main browser view with 6+ tabs + status strip     |
| Launcher            | `docs/assets/screenshots/launcher.png`    | Launcher with proxy source + account group filled |
| Playbooks modal     | `docs/assets/screenshots/playbooks.png`   | Playbooks panel with Event URL + saved playbooks  |

Suggested dimensions: 2000×1200 at 2x retina, saved as optimised PNG (`pngquant --speed 1 --quality 70-85`).

Add more slots simply by duplicating a `<figure>` in `index.html` and referencing a new file under `docs/assets/screenshots/`.

## Local preview

```bash
cd docs
python3 -m http.server 8080
open http://localhost:8080
```

## Files

- `index.html` — all content on one page.
- `assets/styles.css` — dark theme matching TabFleet's visual language.
- `assets/script.js` — scrollspy + mobile sidebar toggle.
- `assets/icon.svg` — favicon.
- `assets/screenshots/` — screenshot slots (optional; placeholders render if empty).
