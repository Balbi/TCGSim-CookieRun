# TCGSim CookieRun

Game data submodule for CookieRun in TCG Sim.

## Scripts

- Sync card JSON data:
  - `node scripts/sync-cards.mjs`
- Download/refresh card images with resume + backoff:
  - `node scripts/download-images.mjs`
- Retry only previously failed images from state:
  - `node scripts/download-images.mjs --only-failures`
