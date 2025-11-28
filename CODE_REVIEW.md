# Code review summary

## Observations
- `app.js` now keeps the KP change handler aligned with surrounding functions and removes a stray inline reminder comment, improving readability around the control wiring. [See `onKpChange` and `init` near the KP slider.]

## Bugs / Reliability Risks
- **IP fallback can drop valid coordinates** because the IPAPI response fields are only accepted when they are already numbers. When latitude/longitude arrive as strings (a common API response shape), the code sets `state.lat`/`state.lon` to `null`, leading to the Isle of Rùm fallback even though usable coordinates were returned. Parse numeric strings before falling back. 【F:app.js†L1827-L1860】
- **Place search may fail with HTTP 403 from Nominatim** because the request omits the mandatory `User-Agent` identifying the application; OSM’s usage policy rejects anonymous requests. Add a descriptive UA (and ideally referer) so geocoding keeps working. 【F:app.js†L1912-L1934】

## Suggested follow-ups
- Add a lightweight formatter or lint step (e.g., Prettier/ESLint) to prevent indentation regressions like the one corrected in `onKpChange` and to catch stray inline notes before release.
- Consider adding user-facing error handling for external fetches (NOAA KP, geocoding) so the UI can surface outages instead of relying on console errors.
- Expand service worker caching to include any new assets (e.g., light pollution grid) if offline support is expected for those features.
