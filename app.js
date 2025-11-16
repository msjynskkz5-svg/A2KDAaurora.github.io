// A2KDA Aurora - main app logic
// - LightPollution module
// - AuroraBrain scoring
// - Simple solar darkness model
// - Darkness-aware score adjustment
// - App wiring (location, KP slider, panels, sky brightness override, hourly chart)

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

  // -------- Aurora brain module (pre-darkness) --------
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

    // Dialled-back time-of-night tweak: small bonus around local midnight only.
    function timeOfNightAdjustment(timeLocalHour) {
      if (typeof timeLocalHour !== "number") return 0;
      const h = ((timeLocalHour % 24) + 24) % 24;

      if (h >= 22 || h < 2) return +3; // around local midnight
      if ((h >= 3 && h <= 4) || (h >= 20 && h <= 21)) return +1; // shoulders
      return 0; // no explicit daytime penalty here – handled by darkness model
    }

    // Computes a "base" score ignoring detailed darkness.
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
      debug.push(
        `Base visibility score before darkness adjustment: ${score.toFixed(
          0
        )} / 100.`
      );

      return {
        score,
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

  // -------- Simple solar darkness model --------

  function toRad(deg) {
    return (deg * Math.PI) / 180;
  }

  function toDeg(rad) {
    return (rad * 180) / Math.PI;
  }

  function dayOfYear(date) {
    const start = new Date(date.getFullYear(), 0, 1);
    const diff = date - start;
    return Math.floor(diff / 86400000) + 1;
  }

  function wrapHour(h) {
    let v = h % 24;
    if (v < 0) v += 24;
    return v;
  }

  function isHourBetween(h, start, end) {
    if (start == null || end == null) return false;
    h = wrapHour(h);
    start = wrapHour(start);
    end = wrapHour(end);
    if (start === end) return false;
    if (start < end) {
      return h >= start && h < end;
    } else {
      return h >= start || h < end;
    }
  }

  function formatHourLocal(h) {
    if (h == null || !isFinite(h)) return "";
    const wh = wrapHour(h);
    const hour = Math.floor(wh);
    const minutes = Math.round((wh - hour) * 60);
    const hh = hour.toString().padStart(2, "0");
    const mm = minutes.toString().padStart(2, "0");
    return `${hh}:${mm}`;
  }

  function computeDarknessInfo(lat, lon, date) {
    if (typeof lat !== "number" || typeof lon !== "number") return null;
    if (!isFinite(lat) || !isFinite(lon)) return null;

    const d = date || new Date();
    const N = dayOfYear(d);
    const latRad = toRad(lat);
    const decl = toRad(
      23.45 * Math.sin(toRad((360 * (284 + N)) / 365))
    );

    // Approximate solar noon using longitude and local timezone
    const tzOffsetHours = -d.getTimezoneOffset() / 60; // e.g. +1 for CET
    const centralMeridian = tzOffsetHours * 15; // degrees
    const solarNoon = 12 + (centralMeridian - lon) / 15; // local clock hours

    function hourAngleForAltitude(h0Deg) {
      const h0 = toRad(h0Deg);
      const cosH =
        (Math.sin(h0) - Math.sin(latRad) * Math.sin(decl)) /
        (Math.cos(latRad) * Math.cos(decl));

      if (cosH < -1) {
        // Sun always above this altitude (relative to this threshold)
        return { alwaysAbove: true, exists: false };
      }
      if (cosH > 1) {
        // Sun always below this altitude
        return { alwaysBelow: true, exists: false };
      }

      const H = Math.acos(cosH);
      const Hdeg = toDeg(H);
      return { exists: true, Hdeg };
    }

    // Sunrise / sunset (~ upper limb, includes refraction)
    const sun0 = hourAngleForAltitude(-0.833);
    let sunrise = null;
    let sunset = null;
    let hasDay = false;
    let alwaysDaylight = false;
    let alwaysNight = false;

    if (sun0.exists) {
      const Hsun = sun0.Hdeg;
      sunrise = wrapHour(solarNoon - Hsun / 15);
      sunset = wrapHour(solarNoon + Hsun / 15);
      hasDay = true;
    } else if (sun0.alwaysAbove) {
      alwaysDaylight = true;
    } else if (sun0.alwaysBelow) {
      alwaysNight = true;
    }

    // Astronomical darkness (Sun 18° below horizon)
    const astro = hourAngleForAltitude(-18);
    let astroDawn = null;
    let astroDusk = null;
    let hasAstronomicalNight = false;
    let neverDark = false;
    let alwaysAstronomicalDark = false;

    if (astro.exists) {
      const Hastro = astro.Hdeg;
      astroDawn = wrapHour(solarNoon - Hastro / 15);
      astroDusk = wrapHour(solarNoon + Hastro / 15);
      hasAstronomicalNight = true;
    } else if (astro.alwaysAbove) {
      // Sun never 18° below horizon → no full astronomical night
      neverDark = true;
    } else if (astro.alwaysBelow) {
      // Sun always deeper than 18° → essentially full darkness
      alwaysAstronomicalDark = true;
    }

    const hourNow = d.getHours() + d.getMinutes() / 60;
    let isDaylightNow = false;

    if (hasDay) {
      isDaylightNow = isHourBetween(hourNow, sunrise, sunset);
    } else if (alwaysDaylight) {
      isDaylightNow = true;
    }

    let isDarkNow = false;
    if (alwaysAstronomicalDark) {
      isDarkNow = true;
    } else if (hasAstronomicalNight) {
      isDarkNow = isHourBetween(hourNow, astroDusk, astroDawn);
    }

    return {
      date: d,
      sunrise,
      sunset,
      astroDawn,
      astroDusk,
      hasDay,
      alwaysDaylight,
      alwaysNight,
      hasAstronomicalNight,
      neverDark,
      alwaysAstronomicalDark,
      isDaylightNow,
      isDarkNow
    };
  }

  // Darkness → scale factor + explanation, based on the *current* time context in the object.
  function computeDarknessFactorAndNote(darkness) {
    if (!darkness) {
      return {
        factor: 1,
        note:
          "Darkness model unavailable – leaving the score unchanged for day/night."
      };
    }

    const {
      alwaysAstronomicalDark,
      alwaysNight,
      neverDark,
      hasAstronomicalNight,
      hasDay,
      isDaylightNow,
      isDarkNow
    } = darkness;

    // Fully dark all the time (polar night / always-under-18°)
    if (alwaysAstronomicalDark || (alwaysNight && !neverDark)) {
      return {
        factor: 1,
        note:
          "No darkness penalty – the sky is effectively dark throughout this date at your latitude."
      };
    }

    // Never fully dark (midnight sun regime)
    if (neverDark) {
      return {
        factor: 0.5,
        note:
          "Score scaled to 50% because the sky never reaches full astronomical darkness at this time of year."
      };
    }

    // Normal case with a proper dark window
    if (hasAstronomicalNight) {
      if (isDarkNow) {
        return {
          factor: 1,
          note:
            "No darkness penalty – you are within the main dark window for your location."
        };
      }
      if (isDaylightNow) {
        return {
          factor: 0.25,
          note:
            "Score scaled to 25% because it is currently daylight outside the main dark window."
        };
      }
      // Twilight: not fully dark, not fully day
      return {
        factor: 0.6,
        note:
          "Score scaled to 60% because you are in twilight just outside the main dark window."
      };
    }

    // Fallback: we only know coarse day/night, no astronomical night
    if (hasDay) {
      if (isDaylightNow) {
        return {
          factor: 0.3,
          note: "Score scaled to 30% because it is currently daylight."
        };
      }
      return {
        factor: 0.6,
        note:
          "Score scaled to 60% based on partial darkness, without a clear astronomical-night window."
      };
    }

    return {
      factor: 1,
      note:
        "Darkness model did not give clear day/night flags – leaving the score unchanged."
    };
  }

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
    const hourlyBarEl = document.getElementById("hourly-bar");
    const nextDarkSubtitleEl = document.getElementById("next-dark-subtitle");

    // Tonight / classic panels
    const tonightTitleEl = document.getElementById("tonight-title");
    const tonightLocationSubEl = document.getElementById("tonight-location-sub");
    const tonightChanceEl = document.getElementById("tonight-chance");
    const tonightGeomagEl = document.getElementById("tonight-geomag");
    const chipAuroraEl = document.getElementById("chip-aurora");
    const chipDarknessEl = document.getElementById("chip-darkness");
    const detailDarknessEl = document.getElementById("detail-darkness");

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
      locationShort: "your location",
      darkness: null
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

    function updateDarknessUI(darkness) {
      if (!chipDarknessEl || !detailDarknessEl || !darkness) return;

      if (darkness.alwaysAstronomicalDark || (darkness.alwaysNight && !darkness.neverDark)) {
        chipDarknessEl.textContent = "Dark all day at this time of year.";
        detailDarknessEl.textContent =
          "At your latitude and on this date the Sun stays well below the horizon, so the sky is effectively dark all day. Aurora visibility will be limited mainly by weather and light pollution.";
        if (nextDarkSubtitleEl) {
          nextDarkSubtitleEl.textContent =
            "Viewing chance across representative hours – the sky stays fully dark at this time of year.";
        }
      } else if (darkness.neverDark) {
        chipDarknessEl.textContent = "Sky never gets fully dark tonight.";
        detailDarknessEl.textContent =
          "The Sun never reaches full astronomical darkness (18° below the horizon) at this time of year. Very bright aurora may still be visible in the darkest hours.";
        if (nextDarkSubtitleEl) {
          nextDarkSubtitleEl.textContent =
            "Late-night hours at this latitude; the sky stays in bright twilight rather than full darkness.";
        }
      } else if (darkness.hasAstronomicalNight) {
        const start = formatHourLocal(darkness.astroDusk);
        const end = formatHourLocal(darkness.astroDawn);
        chipDarknessEl.textContent = `Dark enough from about ${start}–${end}.`;

        const sunriseStr =
          darkness.sunrise != null ? formatHourLocal(darkness.sunrise) : null;
        const sunsetStr =
          darkness.sunset != null ? formatHourLocal(darkness.sunset) : null;
        let extra = "";
        if (sunsetStr && sunriseStr) {
          extra = ` (sunset ${sunsetStr}, sunrise ${sunriseStr})`;
        }

        detailDarknessEl.textContent =
          `We approximate astronomical-night when the Sun is 18° below the horizon. For today that gives a dark window from about ${start}–${end}${extra}. Times are approximate.`;

        if (nextDarkSubtitleEl) {
          nextDarkSubtitleEl.textContent =
            `Approximate aurora visibility score across the main dark window tonight (${start}–${end}).`;
        }
      } else if (darkness.hasDay) {
        const sunriseStr = formatHourLocal(darkness.sunrise);
        const sunsetStr = formatHourLocal(darkness.sunset);
        chipDarknessEl.textContent = `Roughly dark between sunset ${sunsetStr} and sunrise ${sunriseStr}.`;
        detailDarknessEl.textContent =
          "We estimate sunrise and sunset with a simple solar model based on your latitude, longitude and date. In a future version we’ll refine twilight handling further.";
        if (nextDarkSubtitleEl) {
          nextDarkSubtitleEl.textContent =
            "Aurora visibility score across the next few hours, using a simple solar darkness model.";
        }
      } else {
        chipDarknessEl.textContent = "Darkness timings unavailable.";
        detailDarknessEl.textContent =
          "We couldn’t estimate darkness timings for this location and date.";
        if (nextDarkSubtitleEl) {
          nextDarkSubtitleEl.textContent =
            "Prototype bar chart – darkness timings are unavailable for this location.";
        }
      }
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

    function renderAuroraVerdict(result, context) {
      const { verdict, score, debug } = result;
      const localHour =
        context && typeof context.localHour === "number"
          ? context.localHour
          : null;
      const darkness = context && context.darkness ? context.darkness : null;

      let isDaytime = false;
      if (darkness) {
        isDaytime = !!darkness.isDaylightNow;
      } else if (localHour !== null) {
        const hour = ((localHour % 24) + 24) % 24;
        isDaytime = hour >= 7 && hour < 17;
      }

      verdictContainer.dataset.state = verdict;

      // Base text from final score/verdict
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

      // Daylight override, using solar model where possible
      if (isDaytime) {
        let msg =
          "It’s currently daylight at your location, so you won’t see the aurora until after dark.";
        if (darkness && (darkness.hasAstronomicalNight || darkness.alwaysAstronomicalDark)) {
          if (darkness.alwaysAstronomicalDark) {
            msg += " The sky stays fully dark throughout this date at your latitude.";
          } else {
            const start = formatHourLocal(darkness.astroDusk);
            const end = formatHourLocal(darkness.astroDawn);
            msg += ` Tonight it should be dark enough roughly between ${start} and ${end}.`;
          }
        }
        verdictTextEl.textContent = msg;
      }

      verdictScoreEl.textContent = `Score ${score.toFixed(0)} / 100`;

      if (debugListEl) {
        debugListEl.innerHTML = "";
        (debug || []).forEach((line) => {
          const li = document.createElement("li");
          li.textContent = line;
          debugListEl.appendChild(li);
        });

        if (darkness) {
          if (isDaytime) {
            const li = document.createElement("li");
            if (darkness.hasAstronomicalNight || darkness.alwaysAstronomicalDark) {
              if (darkness.alwaysAstronomicalDark) {
                li.textContent =
                  "The Sun is above the horizon right now, but remains well below -18° at night – the sky is fully dark when the Sun is down.";
              } else {
                const start = formatHourLocal(darkness.astroDusk);
                const end = formatHourLocal(darkness.astroDawn);
                li.textContent =
                  `It is too bright to see aurora at the moment; your main dark window is roughly ${start}–${end}.`;
              }
            } else if (darkness.neverDark) {
              li.textContent =
                "Even at night the Sun doesn’t reach full astronomical darkness at this latitude and date, so the sky stays in twilight.";
            } else {
              li.textContent =
                "It is currently daylight; we’ll refine twilight and darkness windows further in a later version.";
            }
            debugListEl.appendChild(li);
          } else if (darkness.hasAstronomicalNight && darkness.isDarkNow) {
            const li = document.createElement("li");
            const start = formatHourLocal(darkness.astroDusk);
            const end = formatHourLocal(darkness.astroDawn);
            li.textContent =
              `You are within the main dark window (${start}–${end}) for your location.`;
            debugListEl.appendChild(li);
          } else if (darkness.neverDark) {
            const li = document.createElement("li");
            li.textContent =
              "The sky never gets fully dark at this latitude at this time of year; aurora will compete with bright twilight.";
            debugListEl.appendChild(li);
          }
        }
      }

      updateTonightSummary(result);
    }

    // -------- Hourly chart: uses darkness + brain --------
    function renderHourlyChart(darkness, baseInputs) {
      if (!hourlyBarEl) return;

      hourlyBarEl.innerHTML = "";

      if (!state.lat || !state.lon || !darkness) {
        // If we don't have enough info, show a simple placeholder.
        for (let i = 0; i < 8; i++) {
          const block = document.createElement("div");
          block.className = "hour-block";
          block.innerHTML = `
            <div class="hour-block-time">--:--</div>
            <div class="hour-block-bar">
              <div class="hour-block-bar-inner" style="height: 50%;"></div>
            </div>
            <div class="hour-block-meta">Waiting for location…</div>
          `;
          hourlyBarEl.appendChild(block);
        }
        return;
      }

      const now = new Date();
      const hourNow = now.getHours() + now.getMinutes() / 60;

      const hours = [];
      if (
        darkness.hasAstronomicalNight &&
        darkness.astroDusk != null &&
        darkness.astroDawn != null
      ) {
        // If we're already in the dark window, start from the next full hour (from "now").
        // Otherwise, start from the beginning of the dark window.
        const inDarkNow = isHourBetween(
          hourNow,
          darkness.astroDusk,
          darkness.astroDawn
        );

        let startHour;
        if (inDarkNow) {
          startHour = wrapHour(Math.ceil(hourNow));
        } else {
          // "Next dark hours" – use the beginning of the main dark window.
          startHour = wrapHour(Math.round(darkness.astroDusk));
        }

        for (let i = 0; i < 8; i++) {
          hours.push(wrapHour(startHour + i));
        }
      } else if (darkness.alwaysAstronomicalDark || darkness.alwaysNight) {
        // Always dark: show the next 8 hours from now
        let startHour = Math.floor(hourNow);
        for (let i = 0; i < 8; i++) {
          hours.push(wrapHour(startHour + i));
        }
      } else {
        // No full darkness: still show the next 8 hours, but label accordingly
        let startHour = Math.floor(hourNow);
        for (let i = 0; i < 8; i++) {
          hours.push(wrapHour(startHour + i));
        }
      }

      hours.forEach((h) => {
        const localHour = h;
        const timeLabel = formatHourLocal(localHour);

        const inputs = {
          kp: baseInputs.kp,
          distanceToOvalKm: baseInputs.distanceToOvalKm,
          geomagneticLatitude: baseInputs.geomagneticLatitude,
          lightPollution: baseInputs.lightPollution,
          cloudCover: baseInputs.cloudCover,
          timeLocalHour: localHour
        };

        const baseResult = AuroraBrain.computeBrain(inputs);
        let score = baseResult.score;

        // Build a darkness context for this specific hour
        let isDayHour = false;
        if (darkness.hasDay && darkness.sunrise != null && darkness.sunset != null) {
          isDayHour = isHourBetween(localHour, darkness.sunrise, darkness.sunset);
        } else if (darkness.alwaysDaylight) {
          isDayHour = true;
        }

        let isDarkHour = false;
        if (darkness.alwaysAstronomicalDark) {
          isDarkHour = true;
        } else if (
          darkness.hasAstronomicalNight &&
          darkness.astroDusk != null &&
          darkness.astroDawn != null
        ) {
          isDarkHour = isHourBetween(localHour, darkness.astroDusk, darkness.astroDawn);
        }

        const darknessForHour = {
          ...darkness,
          isDaylightNow: isDayHour,
          isDarkNow: isDarkHour
        };

        const df = computeDarknessFactorAndNote(darknessForHour);
        const factor = df.factor;
        score = Math.max(0, Math.min(100, score * factor));

        const scoreRounded = Math.round(score);
        const barHeight = Math.max(8, Math.min(100, scoreRounded));

        const skyIcon = isDayHour ? "☀︎" : "🌙";
        const metaText = `${scoreRounded}% · ☁︎ · ${skyIcon}`;

        const block = document.createElement("div");
        block.className = "hour-block";
        block.innerHTML = `
          <div class="hour-block-time">${timeLabel}</div>
          <div class="hour-block-bar">
            <div class="hour-block-bar-inner" style="height: ${100 - barHeight}%;"></div>
          </div>
          <div class="hour-block-meta">${metaText}</div>
        `;
        hourlyBarEl.appendChild(block);
      });
    }

    function recomputeAurora() {
      if (state.lat == null || state.lon == null) {
        verdictTextEl.textContent =
          "We’re still waiting for a location before we can score your chances.";
        verdictScoreEl.textContent = "Score — / 100";
        verdictContainer.dataset.state = "";
        if (hourlyBarEl) {
          hourlyBarEl.innerHTML = "";
        }
        return;
      }

      const now = new Date();
      const localHour = now.getHours() + now.getMinutes() / 60;

      // Update simple solar darkness info
      const darkness = computeDarknessInfo(state.lat, state.lon, now);
      state.darkness = darkness;
      if (darkness) {
        updateDarknessUI(darkness);
      }

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

      const baseInputs = {
        kp: state.kp,
        distanceToOvalKm: distanceKm,
        geomagneticLatitude: geomagLat,
        lightPollution: state.lightPollution,
        cloudCover: state.cloudCover
      };

      // Hourly chart uses the same "base brain + darkness factor per hour"
      renderHourlyChart(darkness, baseInputs);

      // Main brain: compute base score, then apply darkness factor for *now*
      const baseResult = AuroraBrain.computeBrain({
        ...baseInputs,
        timeLocalHour: localHour
      });

      let darknessFactor = 1;
      let darknessNote = null;
      if (darkness) {
        const df = computeDarknessFactorAndNote(darkness);
        darknessFactor = df.factor;
        darknessNote = df.note;
      }

      let adjustedScore = baseResult.score * darknessFactor;
      adjustedScore = Math.max(0, Math.min(100, adjustedScore));

      const debug = baseResult.debug ? baseResult.debug.slice() : [];
      if (darknessNote) {
        debug.push(darknessNote);
      } else {
        debug.push(
          `Darkness model did not apply a penalty (factor ${darknessFactor.toFixed(
            2
          )}).`
        );
      }
      if (darknessFactor !== 1) {
        debug.push(
          `Score after darkness adjustment: ${adjustedScore.toFixed(0)} / 100.`
        );
      } else {
        debug.push(
          `Score unchanged by darkness (factor 1.00): ${adjustedScore.toFixed(
            0
          )} / 100.`
        );
      }

      // Final verdict thresholds on the darkness-adjusted score
      let verdict;
      if (adjustedScore >= 65) {
        verdict = "yes";
      } else if (adjustedScore >= 35) {
        verdict = "maybe";
      } else {
        verdict = "no";
      }
      debug.push(
        `Final visibility verdict after darkness adjustment: ${verdict.toUpperCase()}.`
      );

      const result = {
        ...baseResult,
        score: adjustedScore,
        verdict,
        darknessFactor,
        debug
      };

      renderAuroraVerdict(result, { localHour, darkness });
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
        labelMain: "Isle of Rùm \u2022 Scotland, UK",
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
            labelMain: `Near ${city} \u2022 ${country}`,
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
