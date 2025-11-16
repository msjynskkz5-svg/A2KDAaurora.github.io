# Aurora App – v0.1 Overview

## 1. Goal

Build a mobile-friendly web app that helps both **beginners** and **experts** quickly understand:

- **Will I likely see the aurora tonight from *here*?**
- **When is the best time window?**
- **How do local conditions (clouds, moon, darkness) affect my chances?**

The app should:

- Use **publicly available data** only.
- Be **free to host** (static hosting).
- Present **simple, confidence-inspiring visuals** for beginners, with room to grow into expert views later.

---

## 2. Current Platform & Architecture

- **Front end:** Plain React (via CDN) + vanilla JS, no build tools.
- **Hosting:** GitHub Pages (static site).
- **Files:**
  - `index.html` – loads React + `app.js` + `styles.css`.
  - `styles.css` – mobile-first styling (dark theme, card layout).
  - `app.js` – all app logic (data fetching, scoring, React components).

The app runs entirely in the browser. No backend or database.

---

## 3. Data Sources (v0.1)

### 3.1 Location

**Auto detection (on first load or when user chooses “Use device GPS / IP”):**

1. **Device GPS** via `navigator.geolocation`
   - If successful:
     - `source = "gps"`
     - Label: _“Location from your device GPS”_.
2. If GPS fails/denied → **IP-based geolocation**
   - Uses a public IP geolocation API (e.g. `ipapi.co/json`).
   - `source = "ip"`
   - Label: _“Location estimated from your network (IP)”_.
3. If that fails → **Default dark-sky location**
   - **Isle of Rùm, Scotland** (International Dark Sky Sanctuary).
   - `source = "manual"`, `sourceHint = "rum-default"`
   - Label: _“Default dark-sky location (Isle of Rùm, Scotland)”_.

**Manual location:**

- User can search for places via **Open-Meteo Geocoding API**.
- When user selects a place:
  - It becomes the active location.
  - Stored in `localStorage` as `a2kda_location`.
  - Label: _“Location from your manually chosen place”_.
- On subsequent visits:
  - If `a2kda_location` exists, it is used instead of GPS/IP.

---

### 3.2 Weather (clouds, darkness)

**Provider:** Open-Meteo Forecast API

- Request parameters (per current implementation):
  - `hourly=cloud_cover,is_day`
  - `daily=sunrise,sunset`
  - `forecast_days=1`
  - `timezone=auto`
- Used for:
  - **Hourly cloud cover** (%).
  - **Hourly `is_day` flag** to filter out daylight.
  - **Sunrise/sunset** for “darkness” summary text.

---

### 3.3 Space Weather (aurora activity proxy)

**Provider:** NOAA SWPC solar wind products

- Magnetic data:
  - `mag-5-minute.json` (includes `bz_gsm`, `bt`).
- Plasma data:
  - `plasma-5-minute.json` (includes `speed`).

From the **most recent records**:

- Extract:
  - **Bz (GSM)** – key for magnetic reconnection.
  - **Solar wind speed**.
- Classify **aurora activity** into:
  - `High`, `Moderate`, `Low`, or `Unknown`.
- Map to a **base auroral strength** (0–10 internal scale).

This is intentionally simple and will be refined later.

---

## 4. Current “Brain” – Scoring Logic (v0.1)

For each **upcoming dark hour** (next ~8 hours):

1. Start with **base auroral strength** from space weather:
   - High activity → ~8
   - Moderate → ~6
   - Low/Unknown → ~3

2. Adjust for **cloud cover** using a simple reduction:
   - `score = baseStrength * (1 - cloudCoverPercent / 100)`
   - Clamp to `[0, 10]`.

3. Convert numeric score into a **category**:
   - `score ≥ 8` → **Excellent**
   - `5 ≤ score < 8` → **Good**
   - `3 ≤ score < 5` → **Low**
   - `< 3` → **VeryUnlikely**

4. **Best time window**:
   - Find the highest scoring hour.
   - Define a window from the **first** to the **last** hour where score ≥ `max(4, bestScore - 2)`.

5. **Summaries**:
   - **Headline**:
     - “Excellent/Good/Low chance tonight” or “Aurora very unlikely tonight”.
   - **Darkness text**:
     - “Sunset HH:MM – Sunrise HH:MM” (local time).
   - **Cloud text**:
     - Based on average cloud cover across the dark-hour set:
       - Mostly clear / Patchy cloud / Cloudy.
   - **Aurora activity text**:
     - From the space-weather classification.

6. **Direction**:
   - Currently fixed as:
     - “North or North–Northwest”.
   - This is a placeholder for future magnetic latitude / oval-aware logic.

---

## 5. Beginner “Tonight” Screen – v0.1 UI

Main pieces:

1. **Location selector panel**
   - Shows:
     - Current location name + country.
     - Source label (GPS / IP / manual / Rum default).
   - Controls:
     - Text input + “Search” → manual location via geocoding API.
     - “Use device GPS / IP” button → resets to auto detection.
   - Manual choice is persisted in `localStorage`.

2. **Data status banner**
   - Explains missing or partial data, e.g.:
     - Weather unavailable → clouds not included.
     - Space weather unavailable → assume low auroral activity.
     - Using IP-based / Rum location.
     - Light pollution + moon altitude not yet included.
   - Only shown when there’s something important to say.

3. **Tonight card**
   - Title: “Tonight at [Location]”.
   - Large coloured headline:
     - “Excellent/Good/Low chance” or “Very unlikely”.
   - Best time window (if available).
   - Simple direction (“Look North or North–Northwest”).
   - One-sentence explanation combining aurora activity + clouds.
   - Chips summarising:
     - Aurora activity (High/Moderate/Low/Unknown).
     - Clouds summary.
     - Moon data status.
     - Darkness window.
     - Light pollution status (currently “not yet included”).

4. **“Next dark hours” timeline**
   - Only includes hours where `is_day == 0`.
   - For each hour:
     - **Local time** (user’s timezone).
     - **Vertical bar**:
       - Height proportional to viewing score (0–10).
       - Colour by category:
         - VeryUnlikely → blue-grey
         - Low → amber
         - Good → teal
         - Excellent → green
     - **Cloud icon + %** (single line, no wrapping):
       - 0–10% → `✨`
       - 10–40% → `☁️`
       - 40–80% → `☁️☁️`
       - 80–100% → `🌧`
     - **Moon phase icon** (per-hour):
       - Derived from approximate phase calculation:
         - 🌑, 🌒, 🌓, 🌔, 🌕, 🌖, 🌗, 🌘

   - Header explains meaning:
     - “Next dark hours – bar: viewing chance • ☁: cloud cover • 🌙: moon phase”.

5. **Conditions grid**
   - Simple two-column grid summarising:
     - Aurora activity
     - Clouds
     - Moon
     - Darkness
     - Light pollution (placeholder)

6. **Tip**
   - Beginner-friendly advice, e.g. dark adaptation and avoiding bright screens.

---

## 6. Current Limitations & Known Next Steps

1. **Aurora “brain” is intentionally simple**
   - Uses only Bz + solar wind speed + local cloud cover.
   - No explicit Kp, no auroral oval modelling yet.

2. **Moon handling**
   - Shows **phase only** per hour.
   - Does **not yet** compute:
     - Moon altitude / whether it’s above horizon.
     - Moon brightness in sky (illumination + altitude).

3. **Light pollution**
   - Not yet implemented.
   - Placeholder text: “Light pollution not yet included.”

4. **Expert mode**
   - No separate expert UI yet.
   - No direct numeric KP index, Bz time series, or magnetometer data displayed.

5. **Caching & performance**
   - Static app; relies on browser cache and standard fetch behaviour.
   - Heavy users may see some latency from multiple external API hits.

---

## 7. Planned Next Steps

1. **Light pollution integration**
   - Use public light-pollution maps / Bortle-style estimates per coordinate.
   - Fold into viewing score and beginner-friendly “sky quality” labels.

2. **Refine scoring thresholds**
   - Calibrate “Excellent/Good/Low/Very unlikely” against:
     - Better auroral proxies (e.g. Kp, regional indices, oval models).
     - Location-specific adjustments (magnetic latitude, etc.).

3. **Moon altitude & brightness**
   - Compute moon altitude/azimuth per hour.
   - Distinguish between:
     - Moon below horizon (ideal),
     - Low moon vs high bright moon in the sky.

4. **Expert view (later)**
   - Additional screen/tab with:
     - Raw / detailed aurora indices.
     - Time series graphs (Bz, solar wind speed).
     - Map-based oval / visibility band.
