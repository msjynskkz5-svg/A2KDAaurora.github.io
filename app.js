// A2KDA Aurora - main app logic
// - LightPollution module
// - AuroraBrain scoring
// - App wiring (location, KP slider, panels, sky brightness override)

(function () {
  "use strict";

  // -------- Light pollution module --------
  const LightPollution = (function () {
    // Grid-based data derived from World Atlas of Artificial Night Sky Brightness (if present)
    let gridMeta = null;   // { lat_min, lon_min, resolution_deg, rows, cols, unit }
    let gridValues = null; // Array of sky brightness values
    let gridLoadAttempted = false;

    async function loadGridIfNeeded() {
      if (gridLoadAttempted) return;
      gridLoadAttempted = true;

      try {
        const res = await fetch("lightpollution_grid.json");
        if (!res.ok) {
          console.warn("Light pollution grid JSON not found, using heuristic only.");
          return;
        }
        const data = await res.json();
        if (!data.values || !Array.isArray(data.values)) {
          console.warn("Light pollution grid JSON missing 'values' array.");
          return;
        }

        gridMeta = {
          lat_min: data.lat_min,
          lon_min: data.lon_min,
          resolution_deg: data.resolution_deg,
          rows: data.rows,
          cols: data.cols,
          unit: data.unit || "mag_per_arcsec2"
        };
        gridValues = data.values;
        console.log("Light pollution grid loaded:", gridMeta);
      } catch (err) {
        console.error("Failed to load light pollution grid JSON:", err);
      }
    }

    function normalizeLightPollution(options) {
      const opts = options || {};
      const bortle = typeof opts.bortle === "number" ? opts.bortle : null;
      const skyBrightness =
        typeof opts.skyBrightness === "number" ? opts.skyBrightness : null;

      if (bortle != null) {
        const clamped = Math.min(9, Math.max(1, bortle));
        return (clamped - 1) / 8;
      }

      if (skyBrightness != null) {
        const min = 18;    // brighter (worse)
        const max = 21.5;  // darker (better)
        const v = Math.min(max, Math.max(min, skyBrightness));
        const norm = 1 - (v - min) / (max - min);
        return norm;
      }

      return 0.5;
    }

    function classifyLightPollutionValue(normalized) {
      const n = Math.min(1, Math.max(0, normalized));
      if (n < 0.33) {
        return { label: "Dark skies", code: "dark" };
      } else if (n < 0.66) {
        return { label: "Suburban skies", code: "suburban" };
      } else {
        return { label: "Urban / bright skies", code: "urban" };
      }
    }

    function sampleGrid(lat, lon) {
      if (!gridMeta || !gridValues) return null;

      const { lat_min, lon_min, resolution_deg, rows, cols } = gridMeta;
      if (
        typeof lat !== "number" ||
        typeof lon !== "number" ||
        resolution_deg <= 0
      ) {
        return null;
      }

      // Wrap lon into [-180, 180)
      let lonWrapped = ((lon + 180) % 360 + 360) % 360 - 180;

      const row = Math.floor((lat - lat_min) / resolution_deg);
      const col = Math.floor((lonWrapped - lon_min) / resolution_deg);

      if (row < 0 || row >= rows || col < 0 || col >= cols) return null;

      const idx = row * cols + col;
      const raw = gridValues[idx];

      if (raw == null || isNaN(raw)) return null;

      return { skyBrightness: Number(raw) };
    }

    async function getLightPollution(lat, lon) {
      // Try to load the grid once
      await loadGridIfNeeded();

      // 1) If grid data is available, sample it
      const sampled = sampleGrid(lat, lon);
      if (sampled && typeof sampled.skyBrightness === "number") {
        const normalized = normalizeLightPollution({
          skyBrightness: sampled.skyBrightness
        });
        const classification = classifyLightPollutionValue(normalized);
        return {
          source: "world-atlas-grid",
          normalized,
          classification,
          bortleClass: undefined,
          skyBrightness: sampled.skyBrightness
        };
      }

      // 2) Fallback heuristic based on latitude/longitude only
      let heuristicNorm = 0.5;

      if (typeof lat === "number" && typeof lon === "number") {
        const absLat = Math.abs(lat);
        if (absLat > 66) {
          heuristicNorm = 0.22;
        } else if (absLat > 58) {
          heuristicNorm = 0.32;
        } else if (absLat > 50) {
          heuristicNorm = 0.42;
        } else if (absLat > 40) {
          heuristicNorm = 0.58;
        } else {
          heuristicNorm = 0.72;
        }

        const absLon = Math.abs(lon);
        if (absLon > 150 || absLon < 20) {
          heuristicNorm -= 0.05;
        }
      }

      const normalized = Math.min(1, Math.max(0, heuristicNorm));
      const classification = classifyLightPollutionValue(normalized);

      return {
        source: "fallback",
        normalized,
        classification,
        bortleClass: undefined,
        skyBrightness: undefined
      };
    }

    return {
      normalizeLightPollution,
      classifyLightPollutionValue,
      getLightPollution
    };
  })();

  // -------- Aurora brain module --------
  const AuroraBrain = (function () {
    function kpScore(kp) {
      const k = Math.min(9, Math.max(0, Number(kp) || 0));
      return (k / 9) * 60;
    }

    function locationScore(distanceToOvalKm) {
      const maxDist = 1500;
      const d = Math.min(maxDist, Math.max(0, Number(distanceToOvalKm) || 0));
      return 30 * (1 - d / maxDist);
    }

    function lightPollutionPenalty(lightPollution, kp) {
      const lp = Math.min(1, Math.max(0, Number(lightPollution) || 0));
      const basePenalty = 30 * lp;

      const k = Math.min(9, Math.max(0, Number(kp) || 0));
      const kpReliefFactor = Math.min(1, k / 7);
      const effectivePenalty = basePenalty * (1 - kpReliefFactor * 0.7);

      return effectivePenalty;
    }

    function timeOfNightAdjustment(timeLocalHour) {
      if (typeof timeLocalHour !== "number") return 0;
      const h = ((timeLocalHour % 24) + 24) % 24;

      if (h >= 22 || h < 2) return +5;
      if ((h >= 3 && h <= 4) || (h >= 20 && h <= 21)) return +2;
      if (h >= 9 && h <= 17) return -10;
      return 0;
    }

    function computeBrain(inputs) {
      const {
        kp,
        distanceToOvalKm,
        geomagneticLatitude,
        lightPollution,
        cloudCover,
        timeLocalHour
      } = inputs;

      const debug = [];

      const sKp = kpScore(kp);
      debug.push(`KP index ${kp} contributes ${sKp.toFixed(1)} points.`);

      const sLoc = locationScore(distanceToOvalKm);
      debug.push(
        `Your position relative to the auroral oval contributes ${sLoc.toFixed(
          1
        )} points.`
      );

      const lpPenalty = lightPollutionPenalty(lightPollution, kp);
      if (lightPollution < 0.33) {
        debug.push(
          `Dark skies – only a small light pollution penalty (${lpPenalty.toFixed(
            1
          )} points).`
        );
      } else if (lightPollution < 0.66) {
        debug.push(
          `Moderate light pollution – medium penalty (${lpPenalty.toFixed(
            1
          )} points).`
        );
      } else {
        debug.push(
          `Bright urban skies – heavy light pollution penalty (${lpPenalty.toFixed(
            1
          )} points).`
        );
      }

      let score = sKp + sLoc - lpPenalty;

      if (typeof cloudCover === "number") {
        const cc = Math.min(1, Math.max(0, cloudCover));
        const cloudPenalty = 25 * cc;
        score -= cloudPenalty;
        debug.push(
          `Cloud cover reduces the score by ${cloudPenalty.toFixed(
            1
          )} points (cover: ${(cc * 100).toFixed(0)}%).`
        );
      }

      const timeAdj = timeOfNightAdjustment(timeLocalHour);
      if (timeAdj !== 0) {
        score += timeAdj;
        debug.push(
          `Local time adjustment of ${timeAdj.toFixed(
            1
          )} points based on ${timeLocalHour}:00.`
        );
      }

      score = Math.max(0, Math.min(100, score));

      let verdict;
      if (score >= 65) {
        verdict = "yes";
      } else if (score >= 35) {
        verdict = "maybe";
      } else {
        verdict = "no";
      }

      debug.push(
        `Final visibility score is ${score.toFixed(
          0
        )} / 100 → verdict: ${verdict.toUpperCase()}.`
      );

      return {
        score,
        verdict,
        debug,
        kpScore: sKp,
        locationScore: sLoc,
        lightPollutionPenalty: lpPenalty,
        geomagneticLatitude
      };
    }

    return {
      kpScore,
      locationScore,
      lightPollutionPenalty,
      timeOfNightAdjustment,
      computeBrain
    };
  })();

  // -------- App wiring --------

  function initApp() {
    const locMainEl = document.getElementById("location-main");
    const locDetailEl = document.getElementById("location-detail");
    const locMetaEl = document.getElementById("location-meta");
    const lpBadgeEl = document.querySelector("[data-role='light-pollution-badge']");
    const lpIndicatorInner = lpBadgeEl.querySelector(".lp-indicator-inner");
    const kpInputEl = document.getElementById("kp-input");
    const kpValueEl = document.getElementById("kp-value");
    const verdictContainer = document.querySelector("[data-role='aurora-verdict']");
    const verdictTextEl = document.getElementById("verdict-text");
    const verdictScoreEl = document.getElementById("verdict-score");
    const debugListEl = document.querySelector("[data-role='aurora-debug']");
    const footerTimeEl = document.getElementById("footer-time");
    const searchInputEl = document.getElementById("search-input");
    const searchButtonEl = document.getElementById("search-button");
    const gpsButtonEl = document.getElementById("gps-button");
    const lpModeOptionsEl = document.getElementById("lp-mode-options");
    const lpModeHintEl = document.getElementById("lp-mode-hint");

    // Tonight / classic panels
    const tonightTitleEl = document.getElementById("tonight-title");
    const tonightLocationSubEl = document.getElementById("tonight-location-sub");
    const tonightChanceEl = document.getElementById("tonight-chance");
    const tonightGeomagEl = document.getElementById("tonight-geomag");
    const chipAuroraEl = document.getElementById("chip-aurora");

    const state = {
      lat: null,
      lon: null,
      geomagneticLatitude: null,
      distanceToOvalKm: null,
      lightPollution: 0.5,
      autoLightPollution: 0.5,
      lpMode: "auto", // 'auto' | 'dark' | 'suburban' | 'urban'
      kp: parseFloat(kpInputEl.value) || 3.5,
      cloudCover: null,
      locationShort: "your location"
    };

    function updateFooterTime() {
      const now = new Date();
      const timeStr = now.toLocaleString(undefined, {
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit"
      });
      footerTimeEl.textContent = `Local time detected as ${timeStr}.`;
    }

    function approxGeomagneticLatitude(lat) {
      if (typeof lat !== "number") return null;
      return lat - 11;
    }

    function approxDistanceToOvalKm(geomagLat) {
      if (typeof geomagLat !== "number") return null;
      const ovalLat = 67;
      const deltaLat = Math.abs(geomagLat - ovalLat);
      return deltaLat * 111;
    }

    function setLocationDisplay(options) {
      const {
        labelMain,
        labelDetail,
        sourceLabel,
        sourceKind,
        coordsText,
        shortLabel
      } = options;

      if (labelMain) locMainEl.textContent = labelMain;
      if (labelDetail) locDetailEl.textContent = labelDetail;

      state.locationShort = shortLabel || labelMain || "your location";

      locMetaEl.innerHTML = "";
      const src = document.createElement("span");
      src.className = "meta-pill";
      src.textContent = `Source: ${sourceLabel}`;
      locMetaEl.appendChild(src);

      if (coordsText) {
        const coords = document.createElement("span");
        coords.className = "meta-pill";
        coords.textContent = coordsText;
        locMetaEl.appendChild(coords);
      }

      if (sourceKind === "ip") {
        src.style.borderColor = "rgba(234,179,8,0.9)";
      } else if (sourceKind === "gps") {
        src.style.borderColor = "rgba(34,197,94,0.9)";
      } else if (sourceKind === "search") {
        src.style.borderColor = "rgba(56,189,248,0.9)";
      } else if (sourceKind === "default") {
        src.style.borderColor = "rgba(96,165,250,0.9)";
      }

      tonightTitleEl.textContent = `Tonight at ${state.locationShort}`;
      tonightLocationSubEl.textContent =
        "Tonight’s view based on current KP and a simple sky model.";
    }

    function renderLightPollutionBadge(lpResult) {
      if (!lpBadgeEl) return;

      if (!lpResult) {
        lpBadgeEl.className = "lp-badge lp-badge-unknown";
        lpBadgeEl.title =
          "Light pollution estimate is unavailable – using a default middle-of-the-road value.";
        lpBadgeEl.querySelector(".lp-badge-label-strong").textContent =
          "Light pollution:";
        lpBadgeEl.querySelector(".lp-badge-label").textContent = "unknown";
        lpIndicatorInner.style.height = "50%";
        return;
      }

      const { normalized, classification } = lpResult;
      lpBadgeEl.className = `lp-badge lp-badge-${classification.code}`;
      lpBadgeEl.querySelector(".lp-badge-label-strong").textContent =
        "Light pollution:";
      lpBadgeEl.querySelector(".lp-badge-label").textContent =
        classification.label;
      lpBadgeEl.title = `Normalized light pollution: ${(
        normalized * 100
      ).toFixed(0)} / 100 (0 = dark, 100 = very bright)`;

      const darkHeight = 10;
      const brightHeight = 90;
      const height = darkHeight + (brightHeight - darkHeight) * normalized;
      lpIndicatorInner.style.height = `${height}%`;
    }

    function updateTonightSummary(result) {
      let label = "Low chance";
      let cls = "chance-low";

      if (result.verdict === "yes") {
        label = "Good chance";
        cls = "chance-high";
      } else if (result.verdict === "maybe") {
        label = "Low to moderate chance";
        cls = "chance-medium";
      }

      tonightChanceEl.textContent = label;
      tonightChanceEl.className = `tonight-chance ${cls}`;

      const kp = state.kp;
      let activityText = "Low";
      if (kp >= 7) activityText = "Very high";
      else if (kp >= 5) activityText = "High";
      else if (kp >= 3.5) activityText = "Moderate";

      chipAuroraEl.textContent = activityText;

      tonightGeomagEl.textContent =
        `KP index ${kp.toFixed(1)} with your latitude gives a ` +
        `${activityText.toLowerCase()} level of geomagnetic activity; ` +
        `clouds and moonlight are still placeholders here.`;
    }

    function renderAuroraVerdict(result, options) {
      const { verdict, score, debug } = result;
      const localHour =
        options && typeof options.localHour === "number"
          ? options.localHour
          : null;

      verdictContainer.dataset.state = verdict;

      // Default text based on score/verdict
      if (verdict === "yes") {
        verdictTextEl.textContent =
          "Conditions look good – you have a solid chance of seeing aurora from here. 🌌";
      } else if (verdict === "maybe") {
        verdictTextEl.textContent =
          "It’s possible, but conditions are borderline. A darker spot or higher KP would really help.";
      } else {
        verdictTextEl.textContent =
          "It’s unlikely right now. You’d need much stronger activity or darker skies.";
      }

      // Daylight override: if it's probably daytime, adjust the message
      if (localHour !== null) {
        const hour = ((localHour % 24) + 24) % 24;
        const isDaytime = hour >= 7 && hour < 17;

        if (isDaytime) {
          verdictTextEl.textContent =
            "It’s currently daylight at your location, so you won’t see the aurora until after dark.";
        }
      }

      verdictScoreEl.textContent = `Score ${score.toFixed(0)} / 100`;

      if (debugListEl) {
        debugListEl.innerHTML = "";
        debug.forEach((line) => {
          const li = document.createElement("li");
          li.textContent = line;
          debugListEl.appendChild(li);
        });

        if (localHour !== null) {
          const hour = ((localHour % 24) + 24) % 24;
          const isDaytime = hour >= 7 && hour < 17;
          if (isDaytime) {
            const li = document.createElement("li");
            li.textContent =
              "It is likely too bright to see aurora right now; detailed sunset times will be integrated in a later version.";
            debugListEl.appendChild(li);
          }
        }
      }

      updateTonightSummary(result);
    }

    function recomputeAurora() {
      if (state.lat == null || state.lon == null) {
        verdictTextEl.textContent =
          "We’re still waiting for a location before we can score your chances.";
        verdictScoreEl.textContent = "Score — / 100";
        verdictContainer.dataset.state = "";
        return;
      }

      const now = new Date();
      const localHour = now.getHours();

      const geomagLat =
        state.geomagneticLatitude != null
          ? state.geomagneticLatitude
          : approxGeomagneticLatitude(state.lat);
      const distanceKm =
        state.distanceToOvalKm != null
          ? state.distanceToOvalKm
          : approxDistanceToOvalKm(geomagLat);

      state.geomagneticLatitude = geomagLat;
      state.distanceToOvalKm = distanceKm;

      const result = AuroraBrain.computeBrain({
        kp: state.kp,
        distanceToOvalKm: distanceKm,
        geomagneticLatitude: geomagLat,
        lightPollution: state.lightPollution,
        cloudCover: state.cloudCover,
        timeLocalHour: localHour
      });

      renderAuroraVerdict(result, { localHour });
    }

    function onKpChange() {
      const val = parseFloat(kpInputEl.value) || 0;
      state.kp = val;
      kpValueEl.textContent = `KP ${val.toFixed(1)}`;
      recomputeAurora();
    }

    async function updateLightPollution(lat, lon, options) {
      try {
        const result = await LightPollution.getLightPollution(lat, lon);

        let normalized = result.normalized;
        const ctx = options && options.placeContext;

        // Simple adjustment based on place type:
        // - large-settlement: push towards bright
        // - settlement: ensure at least suburban
        // - dark-nature: clamp to dark
        if (ctx === "large-settlement") {
          normalized = Math.max(normalized, 0.8);
        } else if (ctx === "settlement") {
          normalized = Math.max(normalized, 0.6);
        } else if (ctx === "dark-nature") {
          normalized = Math.min(normalized, 0.25);
        }

        // Store auto-estimate regardless of current mode
        state.autoLightPollution = normalized;

        if (state.lpMode === "auto") {
          state.lightPollution = normalized;
          const adjusted = {
            ...result,
            normalized,
            classification: LightPollution.classifyLightPollutionValue(normalized)
          };
          renderLightPollutionBadge(adjusted);
        }

        // If we're in manual mode, we do not override the user's chosen value,
        // but we still recompute from that.
        recomputeAurora();
      } catch (err) {
        console.error("Failed to estimate light pollution", err);
        state.autoLightPollution = 0.5;
        if (state.lpMode === "auto") {
          state.lightPollution = 0.5;
          renderLightPollutionBadge(null);
        }
        recomputeAurora();
      }
    }

    function useDefaultRumLocation() {
      // Isle of Rùm default fallback: ~57.0 N, -6.33 W
      const lat = 57.0;
      const lon = -6.33;
      state.lat = lat;
      state.lon = lon;

      const coordsText = `${lat.toFixed(3)}°, ${lon.toFixed(3)}°`;

      setLocationDisplay({
        labelMain: "Isle of Rùm • Scotland, UK",
        labelDetail:
          "Using a default dark-sky location because we couldn’t determine your exact position.",
        sourceLabel: "Default fallback (Isle of Rùm)",
        sourceKind: "default",
        coordsText,
        shortLabel: "Isle of Rùm"
      });

      updateLightPollution(lat, lon, { placeContext: "dark-nature" });
    }

    function useIpLocationFallback() {
      fetch("https://ipapi.co/json/")
        .then((res) => res.json())
        .then((data) => {
          const city = data.city || "your area";
          const country = data.country_name || data.country || "your country";
          const lat = typeof data.latitude === "number" ? data.latitude : data.lat;
          const lon =
            typeof data.longitude === "number" ? data.longitude : data.lon;

          state.lat = typeof lat === "number" ? lat : null;
          state.lon = typeof lon === "number" ? lon : null;

          const coordsText =
            state.lat != null && state.lon != null
              ? `Approx. ${state.lat.toFixed(2)}°, ${state.lon.toFixed(2)}°`
              : null;

          setLocationDisplay({
            labelMain: `Near ${city} • ${country}`,
            labelDetail: "Location estimated from your network (IP).",
            sourceLabel: "IP-based (approximate)",
            sourceKind: "ip",
            coordsText,
            shortLabel: `Near ${city}`
          });

          if (state.lat != null && state.lon != null) {
            updateLightPollution(state.lat, state.lon);
          } else {
            // If we somehow didn't get usable coordinates, fall back to default.
            useDefaultRumLocation();
          }
        })
        .catch((err) => {
          console.error("IP location failed", err);
          // Ultimate fallback: default dark-sky location
          useDefaultRumLocation();
        });
    }

    function initLocationViaGps() {
      if (!navigator.geolocation) {
        useIpLocationFallback();
        return;
      }

      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const { latitude, longitude, accuracy } = pos.coords;
          state.lat = latitude;
          state.lon = longitude;

          const coordsText = `${latitude.toFixed(3)}°, ${longitude.toFixed(
            3
          )}° (±${Math.round(accuracy)} m)`;

          setLocationDisplay({
            labelMain: "Location from your device",
            labelDetail:
              "Using your device’s location services. This is typically accurate to a few hundred metres.",
            sourceLabel: "Device location (precise)",
            sourceKind: "gps",
            coordsText,
            shortLabel: "Your device location"
          });

          updateLightPollution(latitude, longitude);
        },
        (err) => {
          console.warn("Geolocation failed, falling back to IP", err);
          useIpLocationFallback();
        },
        {
          enableHighAccuracy: true,
          timeout: 8000,
          maximumAge: 600000
        }
      );
    }

    function geocodeSearch(query) {
      const url =
        "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=" +
        encodeURIComponent(query);

      searchButtonEl.disabled = true;
      fetch(url, { headers: { "Accept-Language": "en" } })
        .then((res) => res.json())
        .then((results) => {
          if (!results || !results.length) {
            alert("No results found for that place.");
            return;
          }

          const r = results[0];
          const lat = parseFloat(r.lat);
          const lon = parseFloat(r.lon);

          state.lat = lat;
          state.lon = lon;

          const name = r.display_name.split(",")[0];
          const coordsText = `${lat.toFixed(3)}°, ${lon.toFixed(3)}°`;

          setLocationDisplay({
            labelMain: name,
            labelDetail: "Location chosen via search.",
            sourceLabel: "Manual search",
            sourceKind: "search",
            coordsText,
            shortLabel: name
          });

          // Derive a simple place context from the Nominatim result
          const category = r.category || r.class || "";
          const type = r.type || "";
          const importance = typeof r.importance === "number"
            ? r.importance
            : parseFloat(r.importance || "0");

          let placeContext = null;

          if (category === "place" && (type === "city" || type === "town")) {
            if (importance && importance > 0.7) {
              placeContext = "large-settlement";
            } else {
              placeContext = "settlement";
            }
          } else if (
            category === "place" &&
            (type === "village" || type === "hamlet" || type === "suburb")
          ) {
            placeContext = "settlement";
          } else if (
            category === "natural" ||
            category === "leisure" ||
            category === "boundary"
          ) {
            if (
              type === "desert" ||
              type === "nature_reserve" ||
              type === "national_park" ||
              type === "forest" ||
              type === "heath" ||
              type === "moor" ||
              type === "peak" ||
              type === "mountain"
            ) {
              placeContext = "dark-nature";
            }
          }

          updateLightPollution(lat, lon, { placeContext });
        })
        .catch((err) => {
          console.error("Search failed", err);
          alert("Search failed – please try again or use GPS / IP.");
        })
        .finally(() => {
          searchButtonEl.disabled = false;
        });
    }

    function handleLpModeClick(e) {
      const btn = e.target.closest(".lp-mode-btn");
      if (!btn) return;

      const mode = btn.getAttribute("data-mode");
      if (!mode || !["auto", "dark", "suburban", "urban"].includes(mode)) return;

      state.lpMode = mode;

      // Update button active styles
      const buttons = lpModeOptionsEl.querySelectorAll(".lp-mode-btn");
      buttons.forEach((b) => {
        if (b === btn) {
          b.classList.add("lp-mode-btn-active");
        } else {
          b.classList.remove("lp-mode-btn-active");
        }
      });

      let norm;
      if (mode === "auto") {
        norm = state.autoLightPollution;
        state.lightPollution = norm;
        lpModeHintEl.textContent =
          "Auto is a rough guess from your location or a grid-based model. Adjust if you know your local sky.";
      } else if (mode === "dark") {
        norm = 0.2;
        state.lightPollution = norm;
        lpModeHintEl.textContent =
          "Using your chosen sky brightness: dark rural skies.";
      } else if (mode === "suburban") {
        norm = 0.5;
        state.lightPollution = norm;
        lpModeHintEl.textContent =
          "Using your chosen sky brightness: typical suburban or small-town skies.";
      } else if (mode === "urban") {
        norm = 0.85;
        state.lightPollution = norm;
        lpModeHintEl.textContent =
          "Using your chosen sky brightness: bright city or town-centre skies.";
      }

      if (typeof norm === "number") {
        const manualResult = {
          normalized: norm,
          classification: LightPollution.classifyLightPollutionValue(norm)
        };
        renderLightPollutionBadge(manualResult);
      }

      recomputeAurora();
    }

    function init() {
      updateFooterTime();
      kpInputEl.addEventListener("input", onKpChange);

      gpsButtonEl.addEventListener("click", () => {
        initLocationViaGps();
      });

      searchButtonEl.addEventListener("click", () => {
        const q = searchInputEl.value.trim();
        if (!q) return;
        geocodeSearch(q);
      });

      searchInputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          const q = searchInputEl.value.trim();
          if (!q) return;
          geocodeSearch(q);
        }
      });

      if (lpModeOptionsEl) {
        lpModeOptionsEl.addEventListener("click", handleLpModeClick);
      }

      // Default flow is GPS → IP → Isle of Rùm
      initLocationViaGps();
      onKpChange();
    }

    init();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initApp);
  } else {
    initApp();
  }
})();