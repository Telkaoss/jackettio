# Repository Guidelines

## Project Structure & Module Organization
- `src/index.js` boots the Express addon server and wires routing, rate limiting, and templating.
- `src/lib/` holds core modules: caching (`cache.js`), configuration defaults and env parsing (`config.js`), Jackett and debrid clients (`jackett.js`, `debrid/`), metadata helpers (`meta/`), and torrent utilities.
- `src/static/` serves public assets; `src/template/configure.html` is the configure page scaffold.
- Root contains deployment assets: `docker-compose*.yml`, `Dockerfile`, and `cli.sh` for scripted installs/updates.
- No dedicated test directory is present yet.

## Build, Test, and Development Commands
- Install dependencies: `npm install`.
- Run locally with env set (example): `JACKETT_URL=http://localhost:9117 JACKETT_API_KEY=key npm start`.
- Docker Compose (default stack): `docker-compose up -d` or specify a variant file (e.g., `-f docker-compose-local.yml` for local-only).
- CLI automation (needs Docker): `./cli.sh install|update|start|stop|down`.
- While no formal test suite exists, validate locally by hitting `/:userConfig?/manifest.json` and `/configure` once the server is up.

## Coding Style & Naming Conventions
- JavaScript ES modules with 2-space indentation and predominately single quotes; keep imports ordered by purpose (stdlib, deps, internal).
- Prefer small, pure helpers in `src/lib/`; keep request handlers in `src/index.js` minimal and delegate to lib modules.
- Use descriptive names for config/env keys (match patterns in `config.js`), and avoid introducing new globals outside config.
- Add inline comments sparingly, focusing on non-obvious flows (e.g., caching, rate limiting, or torrent folder handling).

## Testing Guidelines
- Add tests where possible before introducing risky changes; align filenames with the module under test (e.g., `cache.test.js` alongside `cache.js`).
- Until a harness exists, document manual checks in PRs (routes exercised, env combos tried, Docker path validated).

## Commit & Pull Request Guidelines
- Commit messages follow short, imperative summaries (e.g., “Add infoHash to stream response”); keep subject under ~72 chars.
- For PRs, include: scope/intent, related issue link, key env vars added/changed, manual test notes, and screenshots for UI/configure page updates.
- Highlight backward-compatibility considerations (config defaults, caching changes, public endpoints) and mention any migration steps.
