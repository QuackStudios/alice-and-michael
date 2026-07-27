(() => {
  "use strict";

  const CONFIG = Object.freeze({
    workerUrl: "https://wedding-rsvp-worker.andrew-94e.workers.dev",
    debounceMilliseconds: 80,
    requestTimeoutMilliseconds: 12000,
    searchCacheTtlMilliseconds: 5 * 60 * 1000,
    searchCacheMaximumEntries: 30
  });
  const SEATING_MAP_URL = "./assets/seating/seating-layout-final-calibrated.svg";
  const YOUR_TABLE_CALLOUT_VERSION = "manual-polygon-arrow-v1";
  const NETWORK_ERROR_MESSAGE =
    "Something went wrong. Please try again or ask the welcome team for help.";
  const SERVICE_UNAVAILABLE_MESSAGE =
    "The table lookup is temporarily unavailable. Please ask the welcome team for help.";
  const NO_MATCH_MESSAGE =
    "No matching guests found. Please check the spelling or ask the welcome team for help.";
  const NO_TABLE_MESSAGE =
    "We found your name, but your table is not available yet. Please ask the welcome team for help.";
  const NOT_FOUND_MESSAGE =
    "We couldn’t find that guest. Please check the spelling or ask the welcome team for help.";

  const searchView = document.querySelector("[data-search-view]");
  const resultView = document.querySelector("[data-result-view]");
  const searchForm = document.querySelector("[data-search-form]");
  const nameInput = document.querySelector("[data-name-input]");
  const clearButton = document.querySelector("[data-clear-search]");
  const searchStatus = document.querySelector("[data-search-status]");
  const searchResults = document.querySelector("[data-search-results]");
  const displayNameElement = document.querySelector("[data-display-name]");
  const tableMessage = document.querySelector("[data-table-message]");
  const searchAgainButton = document.querySelector("[data-search-again]");
  const mapSection = document.querySelector("[data-seating-map-section]");
  const mapViewport = document.querySelector("[data-seating-map]");
  const mapCanvas = document.querySelector("[data-seating-map-canvas]");
  const mapStatus = document.querySelector("[data-seating-map-status]");
  const mapTableNumberElement = document.querySelector("[data-map-table-number]");
  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  if (
    !searchView ||
    !resultView ||
    !searchForm ||
    !nameInput ||
    !clearButton ||
    !searchStatus ||
    !searchResults ||
    !displayNameElement ||
    !tableMessage ||
    !searchAgainButton ||
    !mapSection ||
    !mapViewport ||
    !mapCanvas ||
    !mapStatus ||
    !mapTableNumberElement
  ) {
    return;
  }

  let searchTimer = null;
  let searchSequence = 0;
  let activeSearchController = null;
  let activeLookupController = null;
  let seatingMapLoadPromise = null;
  let activeSeatingTable = null;
  // Exact-query results live only in this page session; no guest directory is
  // written to localStorage, IndexedDB, or any other persistent browser store.
  const searchResultCache = new Map();

  searchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    scheduleSearch(0);
  });

  nameInput.addEventListener("input", () => {
    clearButton.hidden = !nameInput.value;
    scheduleSearch(CONFIG.debounceMilliseconds);
  });

  nameInput.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown") return;
    const firstResult = searchResults.querySelector("button");
    if (!firstResult) return;
    event.preventDefault();
    firstResult.focus();
  });

  clearButton.addEventListener("click", () => {
    resetSearchInput();
    nameInput.focus();
  });

  searchAgainButton.addEventListener("click", () => {
    resetLookup();
  });

  warmLookupService();

  function scheduleSearch(delay) {
    window.clearTimeout(searchTimer);
    searchTimer = null;
    cancelActiveSearch();
    const query = normalizeQuery(nameInput.value);

    if (query.length < 2) {
      searchSequence += 1;
      clearSearchFeedback();
      return;
    }

    const sequence = ++searchSequence;
    const cachedMatches = getCachedSearchMatches(query);
    if (cachedMatches !== null) {
      if (cachedMatches.length) {
        hideSearchStatus();
        renderMatches(cachedMatches, query);
      } else {
        clearResultOptions();
        setSearchStatus(NO_MATCH_MESSAGE);
      }
      return;
    }

    searchTimer = window.setTimeout(() => {
      searchTimer = null;
      searchGuests(query, sequence);
    }, delay);
  }

  async function searchGuests(query, sequence) {
    const controller = new AbortController();
    activeSearchController = controller;
    setSearchStatus("Searching for your name…", { loading: true });
    clearResultOptions();

    try {
      const body = await postToWorker("/search-guests", { query }, controller);
      if (sequence !== searchSequence || controller !== activeSearchController) return;

      const matches = normalizeMatches(body.matches);
      cacheSearchMatches(query, matches);
      if (!matches.length) {
        setSearchStatus(NO_MATCH_MESSAGE);
        return;
      }

      hideSearchStatus();
      renderMatches(matches, query);
    } catch (error) {
      if (sequence !== searchSequence || controller !== activeSearchController) return;
      if (error.name === "AbortError" && !controller.didTimeout) return;
      setSearchStatus(publicSearchErrorMessage(error), { error: true });
    } finally {
      if (controller === activeSearchController) activeSearchController = null;
    }
  }

  function normalizeMatches(value) {
    if (!Array.isArray(value)) return [];

    const seenContactIds = new Set();
    return value
      .filter((match) => {
        if (!match || typeof match !== "object") return false;
        const contactId = String(match.contactId || "").trim();
        const displayName = String(match.displayName || "").trim();
        if (!contactId || !displayName || seenContactIds.has(contactId)) return false;
        seenContactIds.add(contactId);
        return true;
      })
      .slice(0, 10)
      .map((match) => ({
        contactId: String(match.contactId).trim(),
        displayName: String(match.displayName).trim()
      }));
  }

  function getCachedSearchMatches(query) {
    const entry = searchResultCache.get(query);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      searchResultCache.delete(query);
      return null;
    }

    searchResultCache.delete(query);
    searchResultCache.set(query, entry);
    return entry.matches;
  }

  function cacheSearchMatches(query, matches) {
    searchResultCache.delete(query);
    searchResultCache.set(query, {
      expiresAt: Date.now() + CONFIG.searchCacheTtlMilliseconds,
      matches: matches.map(({ contactId, displayName }) => ({ contactId, displayName }))
    });

    while (searchResultCache.size > CONFIG.searchCacheMaximumEntries) {
      searchResultCache.delete(searchResultCache.keys().next().value);
    }
  }

  function renderMatches(matches, query) {
    const fragment = document.createDocumentFragment();

    matches.forEach((match, index) => {
      const button = document.createElement("button");
      const name = document.createElement("span");
      const arrow = document.createElement("span");

      button.type = "button";
      button.className = "lookup-result-option";
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", "false");
      button.setAttribute("aria-label", match.displayName);
      button.dataset.contactId = match.contactId;
      appendHighlightedName(name, match.displayName, query);
      arrow.textContent = "→";
      arrow.setAttribute("aria-hidden", "true");
      button.append(name, arrow);

      button.addEventListener("click", () => {
        selectGuest(match);
      });
      button.addEventListener("keydown", (event) => {
        handleResultKeydown(event, index);
      });
      fragment.appendChild(button);
    });

    searchResults.replaceChildren(fragment);
    searchResults.hidden = false;
    nameInput.setAttribute("aria-expanded", "true");

    // Download and parse the static room plan while the guest chooses their
    // name, so the result screen can appear without a second visible wait.
    loadSeatingMap().catch(() => {});
  }

  function appendHighlightedName(container, displayName, query) {
    const source = String(displayName || "");
    const normalizedQuery = normalizeQuery(query);
    const mapped = foldTextWithOffsets(source);
    if (!source || !normalizedQuery || !mapped.folded.includes(normalizedQuery)) {
      container.textContent = source;
      return;
    }

    const ranges = [];
    let searchFrom = 0;
    while (searchFrom < mapped.folded.length) {
      const matchIndex = mapped.folded.indexOf(normalizedQuery, searchFrom);
      if (matchIndex < 0) break;
      const firstOffset = mapped.offsets[matchIndex];
      const lastOffset = mapped.offsets[matchIndex + normalizedQuery.length - 1];
      if (firstOffset && lastOffset) {
        ranges.push({ start: firstOffset.start, end: lastOffset.end });
      }
      searchFrom = matchIndex + normalizedQuery.length;
    }

    if (!ranges.length) {
      container.textContent = source;
      return;
    }

    const fragment = document.createDocumentFragment();
    let cursor = 0;
    ranges.forEach((range) => {
      if (range.start > cursor) {
        fragment.appendChild(document.createTextNode(source.slice(cursor, range.start)));
      }
      const mark = document.createElement("mark");
      mark.className = "lookup-name-match";
      mark.textContent = source.slice(range.start, range.end);
      fragment.appendChild(mark);
      cursor = range.end;
    });
    if (cursor < source.length) {
      fragment.appendChild(document.createTextNode(source.slice(cursor)));
    }
    container.replaceChildren(fragment);
  }

  function foldTextWithOffsets(value) {
    const source = String(value || "");
    const offsets = [];
    let folded = "";
    let segments;

    if (typeof Intl.Segmenter === "function") {
      segments = [...new Intl.Segmenter("en-AU", { granularity: "grapheme" })
        .segment(source)]
        .map((entry) => ({ segment: entry.segment, index: entry.index }));
    } else {
      segments = [];
      let index = 0;
      for (const segment of source) {
        segments.push({ segment, index });
        index += segment.length;
      }
    }

    segments.forEach(({ segment, index }) => {
      const normalized = segment
        .normalize("NFKD")
        .replace(/\p{M}+/gu, "")
        .toLocaleLowerCase("en-AU");
      for (let offset = 0; offset < normalized.length; offset += 1) {
        folded += normalized[offset];
        offsets.push({ start: index, end: index + segment.length });
      }
    });

    return { folded, offsets };
  }

  function warmLookupService() {
    if (!CONFIG.workerUrl || CONFIG.workerUrl.includes("YOUR-WORKER")) return;

    fetch(`${CONFIG.workerUrl.replace(/\/$/, "")}/search-guests`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ warm: true })
    }).catch(() => {
      // The visible search request will show a guest-friendly error if needed.
    });
  }

  function handleResultKeydown(event, index) {
    const buttons = [...searchResults.querySelectorAll("button")];
    if (!buttons.length) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      buttons[(index + 1) % buttons.length].focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (index === 0) {
        nameInput.focus();
      } else {
        buttons[index - 1].focus();
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      nameInput.focus();
    }
  }

  async function selectGuest(match) {
    if (activeLookupController) return;

    cancelActiveSearch();
    const controller = new AbortController();
    activeLookupController = controller;
    setResultButtonsDisabled(true);
    setSearchStatus(`Finding ${match.displayName}’s table…`, { loading: true });

    try {
      const body = await postToWorker(
        "/lookup-guest-table",
        { contactId: match.contactId },
        controller
      );
      if (controller !== activeLookupController) return;

      const tableNumber = normalizeTableNumber(body.tableNumber);
      if (!tableNumber) {
        setSearchStatus(NO_TABLE_MESSAGE, { error: true });
        return;
      }

      showTableResult({
        displayName: String(body.displayName || match.displayName).trim(),
        tableNumber
      });
    } catch (error) {
      if (controller !== activeLookupController) return;
      if (error.name === "AbortError" && !controller.didTimeout) return;
      setSearchStatus(publicLookupErrorMessage(error), { error: true });
    } finally {
      if (controller === activeLookupController) activeLookupController = null;
      setResultButtonsDisabled(false);
    }
  }

  async function postToWorker(path, payload, controller) {
    if (!CONFIG.workerUrl || CONFIG.workerUrl.includes("YOUR-WORKER")) {
      throw new LookupError("configuration_error", NETWORK_ERROR_MESSAGE);
    }

    const timeout = window.setTimeout(() => {
      controller.didTimeout = true;
      controller.abort();
    }, CONFIG.requestTimeoutMilliseconds);

    try {
      const response = await fetch(`${CONFIG.workerUrl.replace(/\/$/, "")}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      let body;
      try {
        body = await response.json();
      } catch {
        throw new LookupError("invalid_response", NETWORK_ERROR_MESSAGE);
      }

      if (
        response.status === 404 &&
        !body?.code &&
        body?.status === "not_found"
      ) {
        throw new LookupError("route_unavailable", SERVICE_UNAVAILABLE_MESSAGE);
      }

      if (!response.ok || !body?.success) {
        throw new LookupError(
          body?.code || body?.status || "request_failed",
          body?.message || NETWORK_ERROR_MESSAGE
        );
      }

      return body;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function LookupError(code, message) {
    this.name = "LookupError";
    this.code = code;
    this.message = message;
  }
  LookupError.prototype = Object.create(Error.prototype);
  LookupError.prototype.constructor = LookupError;

  function publicSearchErrorMessage(error) {
    if (error?.code === "route_unavailable") return SERVICE_UNAVAILABLE_MESSAGE;
    return NETWORK_ERROR_MESSAGE;
  }

  function publicLookupErrorMessage(error) {
    if (error?.code === "route_unavailable") return SERVICE_UNAVAILABLE_MESSAGE;
    if (error?.code === "table_not_found") return NO_TABLE_MESSAGE;
    if (error?.code === "not_found") return NOT_FOUND_MESSAGE;
    return NETWORK_ERROR_MESSAGE;
  }

  function setSearchStatus(message, { loading = false, error = false } = {}) {
    const fragment = document.createDocumentFragment();
    if (loading) {
      const spinner = document.createElement("span");
      spinner.className = "lookup-spinner";
      spinner.setAttribute("aria-hidden", "true");
      fragment.appendChild(spinner);
    }
    fragment.appendChild(document.createTextNode(message));
    searchStatus.replaceChildren(fragment);
    searchStatus.classList.toggle("is-error", error);
    searchStatus.hidden = false;
  }

  function hideSearchStatus() {
    searchStatus.hidden = true;
    searchStatus.classList.remove("is-error");
    searchStatus.replaceChildren();
  }

  function clearResultOptions() {
    searchResults.replaceChildren();
    searchResults.hidden = true;
    nameInput.setAttribute("aria-expanded", "false");
  }

  function clearSearchFeedback() {
    hideSearchStatus();
    clearResultOptions();
  }

  function resetSearchInput() {
    window.clearTimeout(searchTimer);
    searchTimer = null;
    searchSequence += 1;
    cancelActiveSearch();
    cancelActiveLookup();
    nameInput.value = "";
    clearButton.hidden = true;
    clearSearchFeedback();
  }

  function cancelActiveSearch() {
    activeSearchController?.abort();
    activeSearchController = null;
  }

  function cancelActiveLookup() {
    activeLookupController?.abort();
    activeLookupController = null;
    setResultButtonsDisabled(false);
  }

  function setResultButtonsDisabled(disabled) {
    searchResults.querySelectorAll("button").forEach((button) => {
      button.disabled = disabled;
    });
    nameInput.disabled = disabled;
    clearButton.disabled = disabled;
  }

  function showTableResult({ displayName, tableNumber }) {
    nameInput.blur();
    displayNameElement.textContent = displayName || "Guest";
    tableMessage.textContent = `You’re seated at Table ${tableNumber}.`;
    mapTableNumberElement.textContent = tableNumber;
    searchView.hidden = true;
    resultView.hidden = false;
    showSeatingMap(tableNumber);

    window.requestAnimationFrame(() => {
      tableMessage.focus({ preventScroll: true });
      resultView.scrollIntoView({
        behavior: prefersReducedMotion.matches ? "auto" : "smooth",
        block: "start"
      });
    });
  }

  function resetLookup() {
    resetSearchInput();
    hideSeatingMap();
    displayNameElement.textContent = "";
    tableMessage.textContent = "";
    mapTableNumberElement.textContent = "—";
    resultView.hidden = true;
    searchView.hidden = false;

    window.requestAnimationFrame(() => {
      searchView.scrollIntoView({
        behavior: prefersReducedMotion.matches ? "auto" : "smooth",
        block: "start"
      });
      nameInput.focus({ preventScroll: true });
    });
  }

  function normalizeQuery(value) {
    return String(value || "")
      .trim()
      .replace(/\s+/g, " ")
      .normalize("NFKD")
      .replace(/\p{M}+/gu, "")
      .toLocaleLowerCase("en-AU")
      .slice(0, 160);
  }

  function normalizeTableNumber(value) {
    if (value == null) return null;

    const normalized = String(value)
      .trim()
      .replace(/^table[\s:#-]*/i, "")
      .trim();

    if (!normalized) return null;
    return /^\d+$/.test(normalized)
      ? String(Number.parseInt(normalized, 10))
      : normalized;
  }

  function highlightSeatingTable(tableNumber) {
    const seatingMap = mapCanvas.querySelector("svg");
    const normalizedTable = normalizeTableNumber(tableNumber);
    if (!seatingMap) return false;

    seatingMap.querySelector("#you-are-here-layer")?.remove();
    if (!normalizedTable) return false;

    const tables = [...seatingMap.querySelectorAll(".guest-table[data-table]")];
    tables.forEach((table) => {
      table.classList.remove("is-highlighted", "is-dimmed");
    });

    const matchedTable = tables.find(
      (table) => normalizeTableNumber(table.dataset.table) === normalizedTable
    );
    if (!matchedTable) return false;

    matchedTable.classList.add("is-highlighted");
    tables.forEach((table) => {
      if (table !== matchedTable) table.classList.add("is-dimmed");
    });
    seatingMap.setAttribute(
      "aria-label",
      `Seating layout with Table ${normalizedTable} highlighted`
    );
    addYouAreHereCallout(seatingMap, matchedTable);

    return true;
  }

  function addYouAreHereCallout(svg, tableElement) {
    svg.querySelector("#you-are-here-layer")?.remove();
    if (!tableElement) return false;

    const highlight = tableElement.querySelector(".table-highlight");
    const geometry = getSeatingHighlightGeometry(highlight);
    const viewBox = svg.viewBox?.baseVal;
    if (!geometry || !viewBox?.width || !viewBox?.height) return false;

    const namespace = "http://www.w3.org/2000/svg";
    const margin = 12;
    const bubbleWidth = 92;
    const bubbleHeight = 28;
    const horizontalGap = 23;
    const verticalGap = 40;
    const minX = viewBox.x + margin;
    const maxX = viewBox.x + viewBox.width - margin;
    const minY = viewBox.y + margin;
    const maxY = viewBox.y + viewBox.height - margin;
    const spaceLeft = geometry.cx - geometry.radius - minX;
    const spaceRight = maxX - geometry.cx - geometry.radius;
    const spaceAbove = geometry.cy - geometry.radius - minY;
    const spaceBelow = maxY - geometry.cy - geometry.radius;
    const horizontalRoom = bubbleWidth + horizontalGap;
    const verticalRoom = bubbleHeight + verticalGap;
    const preferLeft =
      (spaceRight < horizontalRoom && spaceLeft >= horizontalRoom) ||
      geometry.cx > viewBox.x + viewBox.width * 0.7;
    const preferredAboveY =
      geometry.cy - geometry.radius - verticalGap - bubbleHeight;
    const placeBelow =
      spaceAbove < verticalRoom && spaceBelow >= verticalRoom;

    let bubbleX = preferLeft
      ? geometry.cx - geometry.radius - horizontalGap - bubbleWidth
      : geometry.cx + geometry.radius + horizontalGap;
    let bubbleY = placeBelow
      ? geometry.cy + geometry.radius + verticalGap
      : preferredAboveY;

    bubbleX = clampNumber(bubbleX, minX, maxX - bubbleWidth);
    bubbleY = clampNumber(bubbleY, minY, maxY - bubbleHeight);

    const bubbleCx = bubbleX + bubbleWidth / 2;
    const bubbleCy = bubbleY + bubbleHeight / 2;
    const bubbleToTableX = geometry.cx - bubbleCx;
    const bubbleToTableY = geometry.cy - bubbleCy;
    const bubbleToTableLength = Math.hypot(bubbleToTableX, bubbleToTableY) || 1;
    const bubbleDirectionX = bubbleToTableX / bubbleToTableLength;
    const bubbleDirectionY = bubbleToTableY / bubbleToTableLength;
    const distanceToBubbleEdge = Math.min(
      Math.abs(bubbleDirectionX) > 0.0001
        ? bubbleWidth / 2 / Math.abs(bubbleDirectionX)
        : Number.POSITIVE_INFINITY,
      Math.abs(bubbleDirectionY) > 0.0001
        ? bubbleHeight / 2 / Math.abs(bubbleDirectionY)
        : Number.POSITIVE_INFINITY
    );
    const startX = bubbleCx + bubbleDirectionX * distanceToBubbleEdge;
    const startY = bubbleCy + bubbleDirectionY * distanceToBubbleEdge;

    const tableToBubbleX = bubbleCx - geometry.cx;
    const tableToBubbleY = bubbleCy - geometry.cy;
    const tableToBubbleLength = Math.hypot(tableToBubbleX, tableToBubbleY) || 1;
    const tableDirectionX = tableToBubbleX / tableToBubbleLength;
    const tableDirectionY = tableToBubbleY / tableToBubbleLength;
    const tipX = geometry.cx + tableDirectionX * geometry.radius * 0.92;
    const tipY = geometry.cy + tableDirectionY * geometry.radius * 0.92;

    const arrowX = tipX - startX;
    const arrowY = tipY - startY;
    const arrowLength = Math.hypot(arrowX, arrowY) || 1;
    const arrowDirectionX = arrowX / arrowLength;
    const arrowDirectionY = arrowY / arrowLength;
    const perpendicularX = -arrowDirectionY;
    const perpendicularY = arrowDirectionX;
    const headLength = 12;
    const headWidth = 10;
    const baseX = tipX - arrowDirectionX * headLength;
    const baseY = tipY - arrowDirectionY * headLength;
    const firstBaseX = baseX + perpendicularX * headWidth / 2;
    const firstBaseY = baseY + perpendicularY * headWidth / 2;
    const secondBaseX = baseX - perpendicularX * headWidth / 2;
    const secondBaseY = baseY - perpendicularY * headWidth / 2;
    const arrowHeadPoints = [
      `${formatSvgNumber(tipX)},${formatSvgNumber(tipY)}`,
      `${formatSvgNumber(firstBaseX)},${formatSvgNumber(firstBaseY)}`,
      `${formatSvgNumber(secondBaseX)},${formatSvgNumber(secondBaseY)}`
    ].join(" ");

    const calloutLayer = createSvgElement(namespace, "g", {
      id: "you-are-here-layer",
      "data-callout-version": YOUR_TABLE_CALLOUT_VERSION,
      "data-table": tableElement.dataset.table || "",
      "data-horizontal-placement": preferLeft ? "left" : "right",
      "data-vertical-placement": placeBelow ? "below" : "above",
      "pointer-events": "none",
      "aria-hidden": "true"
    });
    const callout = createSvgElement(namespace, "g", {
      class: "you-are-here-callout"
    });
    const arrowHalo = createSvgElement(namespace, "line", {
      class: "you-are-here-arrow-halo",
      x1: formatSvgNumber(startX),
      y1: formatSvgNumber(startY),
      x2: formatSvgNumber(baseX),
      y2: formatSvgNumber(baseY)
    });
    const arrow = createSvgElement(namespace, "line", {
      class: "you-are-here-arrow",
      x1: formatSvgNumber(startX),
      y1: formatSvgNumber(startY),
      x2: formatSvgNumber(baseX),
      y2: formatSvgNumber(baseY)
    });
    const arrowHead = createSvgElement(namespace, "polygon", {
      class: "you-are-here-arrow-head",
      points: arrowHeadPoints
    });
    const bubble = createSvgElement(namespace, "rect", {
      class: "you-are-here-bubble",
      x: formatSvgNumber(bubbleX),
      y: formatSvgNumber(bubbleY),
      width: String(bubbleWidth),
      height: String(bubbleHeight),
      rx: "7",
      ry: "7"
    });
    const text = createSvgElement(namespace, "text", {
      class: "you-are-here-text",
      x: formatSvgNumber(bubbleX + bubbleWidth / 2),
      y: formatSvgNumber(bubbleY + bubbleHeight / 2),
      "dominant-baseline": "middle",
      "text-anchor": "middle"
    });
    text.textContent = "YOUR TABLE";

    callout.append(arrowHalo, arrow, arrowHead, bubble, text);
    calloutLayer.appendChild(callout);
    svg.appendChild(calloutLayer);
    return true;
  }

  function getSeatingHighlightGeometry(highlight) {
    if (!highlight) return null;
    const elementName = highlight.localName.toLowerCase();

    if (elementName === "circle") {
      const cx = Number(highlight.getAttribute("cx"));
      const cy = Number(highlight.getAttribute("cy"));
      const radius = Number(highlight.getAttribute("r"));
      if ([cx, cy, radius].every(Number.isFinite)) {
        return { cx, cy, radius };
      }
    }

    if (elementName === "rect") {
      const x = Number(highlight.getAttribute("x"));
      const y = Number(highlight.getAttribute("y"));
      const width = Number(highlight.getAttribute("width"));
      const height = Number(highlight.getAttribute("height"));
      if ([x, y, width, height].every(Number.isFinite)) {
        return {
          cx: x + width / 2,
          cy: y + height / 2,
          radius: Math.max(width, height) / 2
        };
      }
    }

    return null;
  }

  function createSvgElement(namespace, name, attributes) {
    const element = document.createElementNS(namespace, name);
    Object.entries(attributes).forEach(([attribute, value]) => {
      element.setAttribute(attribute, value);
    });
    return element;
  }

  function clampNumber(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function formatSvgNumber(value) {
    return String(Math.round(value * 100) / 100);
  }

  async function showSeatingMap(tableNumber) {
    const normalizedTable = normalizeTableNumber(tableNumber);
    if (!normalizedTable) {
      hideSeatingMap();
      return;
    }

    activeSeatingTable = normalizedTable;
    mapSection.hidden = false;
    mapViewport.hidden = true;
    mapStatus.textContent = "Preparing your table map…";
    mapStatus.hidden = false;
    mapStatus.classList.add("is-loading");

    try {
      await loadSeatingMap();
      if (activeSeatingTable !== normalizedTable) return;

      const tableFound = highlightSeatingTable(normalizedTable);
      mapStatus.classList.remove("is-loading");

      if (!tableFound) {
        mapViewport.hidden = true;
        mapStatus.textContent =
          `Your table is Table ${normalizedTable}. A visual map is not available for this table yet.`;
        return;
      }

      mapStatus.hidden = true;
      mapStatus.textContent = "";
      mapViewport.hidden = false;
      window.requestAnimationFrame(() => {
        centreSeatingMapOnHighlightedTable(mapViewport);
      });
    } catch {
      if (activeSeatingTable !== normalizedTable) return;
      mapViewport.hidden = true;
      mapStatus.classList.remove("is-loading");
      mapStatus.textContent =
        `Your table is Table ${normalizedTable}. A visual map is not available for this table yet.`;
    }
  }

  function hideSeatingMap() {
    activeSeatingTable = null;
    mapViewport.hidden = true;
    mapStatus.hidden = true;
    mapStatus.textContent = "";
    mapStatus.classList.remove("is-loading");

    const svg = mapCanvas.querySelector("svg");
    svg?.querySelector("#you-are-here-layer")?.remove();
    svg?.querySelectorAll(".guest-table").forEach((table) => {
      table.classList.remove("is-highlighted", "is-dimmed");
    });
  }

  function centreSeatingMapOnHighlightedTable(viewport) {
    const highlight = viewport.querySelector(
      ".guest-table.is-highlighted .table-highlight"
    );
    if (!highlight) return;

    const viewportBounds = viewport.getBoundingClientRect();
    const highlightBounds = highlight.getBoundingClientRect();
    const highlightCentre =
      highlightBounds.left -
      viewportBounds.left +
      viewport.scrollLeft +
      highlightBounds.width / 2;
    const targetScrollLeft = Math.max(0, highlightCentre - viewport.clientWidth / 2);

    viewport.scrollTo({
      left: targetScrollLeft,
      behavior: prefersReducedMotion.matches ? "auto" : "smooth"
    });
  }

  function loadSeatingMap() {
    const existingSvg = mapCanvas.querySelector("svg");
    if (existingSvg) return Promise.resolve(existingSvg);

    if (!seatingMapLoadPromise) {
      seatingMapLoadPromise = fetch(SEATING_MAP_URL, {
        headers: { "Accept": "image/svg+xml" }
      })
        .then((response) => {
          if (!response.ok) throw new Error("Seating map could not be loaded.");
          return response.text();
        })
        .then((markup) => {
          const parsed = new DOMParser().parseFromString(markup, "image/svg+xml");
          const parsedSvg = parsed.documentElement;
          if (
            parsed.querySelector("parsererror") ||
            parsedSvg.localName.toLowerCase() !== "svg"
          ) {
            throw new Error("Seating map is not valid SVG.");
          }

          parsedSvg.querySelector("#interactive-table-styles")?.remove();
          parsedSvg.querySelectorAll("script, foreignObject").forEach((element) => {
            element.remove();
          });
          [parsedSvg, ...parsedSvg.querySelectorAll("*")].forEach((element) => {
            [...element.attributes].forEach((attribute) => {
              if (/^on/i.test(attribute.name)) element.removeAttribute(attribute.name);
            });
          });

          if (!parsedSvg.hasAttribute("viewBox")) {
            const sourceWidth = Number.parseFloat(parsedSvg.getAttribute("width"));
            const sourceHeight = Number.parseFloat(parsedSvg.getAttribute("height"));
            if (Number.isFinite(sourceWidth) && Number.isFinite(sourceHeight)) {
              parsedSvg.setAttribute("viewBox", `0 0 ${sourceWidth} ${sourceHeight}`);
            }
          }
          parsedSvg.removeAttribute("width");
          parsedSvg.removeAttribute("height");
          parsedSvg.classList.add("seating-map__svg");
          parsedSvg.setAttribute("role", "img");
          parsedSvg.setAttribute("aria-label", "Wedding reception seating layout");
          parsedSvg.setAttribute("preserveAspectRatio", "xMidYMid meet");
          parsedSvg.style.width = "100%";
          parsedSvg.style.maxWidth = "100%";
          parsedSvg.style.height = "auto";
          parsedSvg.style.display = "block";

          parsedSvg.querySelectorAll(".guest-table").forEach((table) => {
            table.removeAttribute("role");
            table.removeAttribute("tabindex");
            table.removeAttribute("aria-pressed");
            table.removeAttribute("aria-selected");
            table.removeAttribute("data-active");
            table.setAttribute("focusable", "false");
            table.setAttribute("aria-hidden", "true");
          });

          const inlineSvg = document.importNode(parsedSvg, true);
          mapCanvas.replaceChildren(inlineSvg);
          return inlineSvg;
        })
        .catch((error) => {
          seatingMapLoadPromise = null;
          throw error;
        });
    }

    return seatingMapLoadPromise;
  }
})();
