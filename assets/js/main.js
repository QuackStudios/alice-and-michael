(() => {
  "use strict";

  const documentRoot = document.documentElement;
  documentRoot.classList.toggle(
    "is-aligning-initial-hash",
    Boolean(window.location.hash)
  );

  const CONFIG = {
  demoMode: false,
  workerUrl: "https://wedding-rsvp-worker.andrew-94e.workers.dev"
};
  const SEATING_MAP_URL = "./assets/seating/seating-layout-final-calibrated.svg";
  const YOUR_TABLE_CALLOUT_VERSION = "manual-polygon-arrow-v1";
  const DEBUG_YOUR_TABLE_CALLOUT = false;

  const header = document.querySelector("[data-header]");
  const menuButton = document.querySelector("[data-menu-button]");
  const menu = document.querySelector("[data-menu]");
  const desktopMenu = window.matchMedia("(min-width: 62rem)");
  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  function isMenuOpen() {
    return menuButton?.getAttribute("aria-expanded") === "true";
  }

  function setMenu(open, { restoreFocus = false } = {}) {
    if (!menuButton || !menu) return;
    menuButton.setAttribute("aria-expanded", String(open));
    menuButton.querySelector(".menu-button__label").textContent = open ? "Close" : "Menu";
    menu.classList.toggle("is-open", open);
    menu.setAttribute("aria-hidden", String(!open && !desktopMenu.matches));
    header?.classList.toggle("menu-active", open);
    document.body.classList.toggle("menu-open", open);

    if (open || (restoreFocus && !desktopMenu.matches)) {
      menuButton.focus({ preventScroll: true });
    }
  }

  menuButton?.addEventListener("click", () => {
    const willOpen = !isMenuOpen();
    setMenu(willOpen, { restoreFocus: !willOpen });
  });

  menu?.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => {
      if (isMenuOpen()) setMenu(false, { restoreFocus: true });
    });
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && isMenuOpen()) {
      setMenu(false, { restoreFocus: true });
      return;
    }

    if (event.key !== "Tab" || !isMenuOpen() || !header || !menuButton || !menu) return;

    const focusableItems = [
      header.querySelector(".wordmark"),
      menuButton,
      ...menu.querySelectorAll("a")
    ].filter(Boolean);
    const firstItem = focusableItems[0];
    const lastItem = focusableItems[focusableItems.length - 1];

    if (event.shiftKey && document.activeElement === firstItem) {
      event.preventDefault();
      lastItem.focus();
    } else if (!event.shiftKey && document.activeElement === lastItem) {
      event.preventDefault();
      firstItem.focus();
    } else if (!focusableItems.includes(document.activeElement)) {
      event.preventDefault();
      menuButton.focus();
    }
  });

  function syncMenuForViewport() {
    if (desktopMenu.matches && isMenuOpen()) {
      setMenu(false);
      return;
    }

    menu?.setAttribute("aria-hidden", String(!desktopMenu.matches));
  }

  desktopMenu.addEventListener?.("change", syncMenuForViewport);
  syncMenuForViewport();

  let scrollFrame;
  function updateOnScroll() {
    const scrollY = window.scrollY;
    header?.classList.toggle("is-scrolled", scrollY > 40);

    if (!prefersReducedMotion.matches) {
      const heroImage = document.querySelector("[data-parallax] img");
      if (heroImage && scrollY < window.innerHeight * 1.2) {
        heroImage.style.transform = `translate3d(0, ${scrollY * 0.075}px, 0)`;
      }
    }
    scrollFrame = null;
  }

  window.addEventListener("scroll", () => {
    if (!scrollFrame) scrollFrame = window.requestAnimationFrame(updateOnScroll);
  }, { passive: true });
  updateOnScroll();

  function alignInitialHash() {
    if (!window.location.hash) {
      documentRoot.classList.remove("is-aligning-initial-hash");
      return;
    }

    let targetId;
    try {
      targetId = decodeURIComponent(window.location.hash.slice(1));
    } catch {
      documentRoot.classList.remove("is-aligning-initial-hash");
      return;
    }

    const target = document.getElementById(targetId);
    if (!target) {
      documentRoot.classList.remove("is-aligning-initial-hash");
      return;
    }

    const anchorOffset = Number.parseFloat(
      window.getComputedStyle(target).scrollMarginTop
    ) || 0;
    const targetTop = target.getBoundingClientRect().top + window.scrollY - anchorOffset;
    const previousScrollBehavior = documentRoot.style.scrollBehavior;

    documentRoot.style.scrollBehavior = "auto";
    window.scrollTo({
      top: Math.max(0, targetTop),
      left: 0,
      behavior: "auto"
    });
    window.requestAnimationFrame(() => {
      documentRoot.style.scrollBehavior = previousScrollBehavior;
      documentRoot.classList.remove("is-aligning-initial-hash");
    });
  }

  window.addEventListener("load", () => {
    if (!window.location.hash) return;

    const fontsReady = document.fonts?.ready || Promise.resolve();
    fontsReady.then(() => {
      window.setTimeout(alignInitialHash, 100);
    });
  });

  const revealItems = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window && !prefersReducedMotion.matches) {
    const revealObserver = new IntersectionObserver((entries, observer) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      });
    }, { rootMargin: "0px 0px -9% 0px", threshold: 0.08 });

    revealItems.forEach((item) => revealObserver.observe(item));
  } else {
    revealItems.forEach((item) => item.classList.add("is-visible"));
  }

  const form = document.querySelector("[data-rsvp-form]");
  if (!form) return;

  const dietaryStep = form.querySelector("[data-dietary-step]");
  const dietarySelect = form.elements.dietaryRequirement;
  const dietaryNotesField = form.querySelector("[data-dietary-notes]");
  const dietaryNotes = form.elements.dietaryNotes;
  const notesLabel = form.querySelector("[data-notes-label]");
  const submitButton = form.querySelector("[data-submit]");
  const submitLabel = form.querySelector("[data-submit-label]");
  const formMessage = form.querySelector("[data-form-message]");
  const result = document.querySelector("[data-rsvp-result]");
  const panel = form.closest(".rsvp-panel");
  let seatingMapLoadPromise = null;
  let activeSeatingTable = null;
  let hasLoggedManualCalloutVersion = false;

  function updateDietaryVisibility() {
    const attending = form.elements.attending.value;
    dietaryStep.hidden = attending !== "yes";

    if (attending !== "yes") {
      dietarySelect.value = "No dietary requirements";
      dietaryNotes.value = "";
      dietaryNotesField.hidden = true;
      dietaryNotes.required = false;
      return;
    }

    const needsNotes = dietarySelect.value !== "No dietary requirements";
    dietaryNotesField.hidden = !needsNotes;
    dietaryNotes.required = dietarySelect.value === "Other";
    notesLabel.textContent = dietarySelect.value === "Other"
      ? "Please specify your requirement"
      : "Anything our kitchen should know?";
  }

  form.querySelectorAll('input[name="attending"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      radio.closest("fieldset")?.classList.remove("is-invalid");
      updateDietaryVisibility();
    });
  });

  dietarySelect.addEventListener("change", updateDietaryVisibility);

  form.querySelectorAll("input, textarea, select").forEach((control) => {
    control.addEventListener("input", () => {
      control.closest(".field")?.classList.remove("is-invalid");
      hideFormMessage();
    });
  });

  function hideFormMessage() {
    formMessage.hidden = true;
    formMessage.textContent = "";
  }

  function showFormMessage(message) {
    formMessage.textContent = message;
    formMessage.hidden = false;
  }

  function validateForm() {
    let valid = true;
    const firstName = form.elements.firstName;
    const lastName = form.elements.lastName;
    const email = form.elements.email;
    const attendanceFieldset = form.querySelector("fieldset");

    [firstName, lastName].forEach((input) => {
      const field = input.closest(".field");
      const isValid = input.value.trim().length >= 1;
      field.classList.toggle("is-invalid", !isValid);
      if (!isValid) valid = false;
    });

    const emailValid = !email.value.trim() || email.validity.valid;
    email.closest(".field").classList.toggle("is-invalid", !emailValid);
    if (!emailValid) valid = false;

    const attendingValid = Boolean(form.elements.attending.value);
    attendanceFieldset.classList.toggle("is-invalid", !attendingValid);
    if (!attendingValid) valid = false;

    const otherValid = !dietaryNotes.required || dietaryNotes.value.trim().length > 0;
    dietaryNotes.closest(".field").classList.toggle("is-invalid", !otherValid);
    if (!otherValid) valid = false;

    if (!valid) {
      const firstInvalid = form.querySelector(".is-invalid input, .is-invalid textarea");
      firstInvalid?.focus({ preventScroll: true });
      firstInvalid?.closest(".field, fieldset")?.scrollIntoView({
        behavior: prefersReducedMotion.matches ? "auto" : "smooth",
        block: "center"
      });
    }

    return valid;
  }

  function getPayload() {
    const data = new FormData(form);
    const attending = String(data.get("attending") || "").trim().toLowerCase();

    return {
      weddingId: String(data.get("weddingId") || "").trim(),
      firstName: String(data.get("firstName") || "").trim(),
      lastName: String(data.get("lastName") || "").trim(),
      email: String(data.get("email") || "").trim(),
      phone: String(data.get("phone") || "").trim(),
      attending,
      dietaryRequirement: attending === "yes"
        ? String(data.get("dietaryRequirement") || "No dietary requirements")
        : "No dietary requirements",
      dietaryNotes: attending === "yes"
        ? String(data.get("dietaryNotes") || "").trim()
        : ""
    };
  }

  function setLoading(loading) {
    submitButton.disabled = loading;
    submitButton.classList.toggle("is-loading", loading);
    submitButton.setAttribute("aria-busy", String(loading));
    submitLabel.textContent = loading ? "Finding your invitation" : "Send my response";
  }

  async function sendRsvp(payload) {
    // Preview mode contains no guest list and never calls GHL.
    if (CONFIG.demoMode) {
      await new Promise((resolve) => window.setTimeout(resolve, 950));
      const isAttending = payload.attending === "yes";

      return {
        success: true,
        status: "matched",
        attending: isAttending,
        firstName: payload.firstName,
        tableNumber: isAttending ? "8" : null,
        demo: true
      };
    }

    if (!CONFIG.workerUrl || CONFIG.workerUrl.includes("YOUR-WORKER")) {
      const error = new Error("The RSVP service has not been connected yet. Please contact the couple.");
      error.status = "configuration_error";
      throw error;
    }

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15000);

    try {
      const response = await fetch(`${CONFIG.workerUrl.replace(/\/$/, "")}/submit-rsvp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      let body;
      try {
        body = await response.json();
      } catch {
        throw new Error("We couldn’t read the concierge response. Please try again.");
      }

      if (!response.ok || !body.success) {
        const error = new Error(body.message || "We couldn’t save your RSVP just now.");
        error.status = body.status || "error";
        throw error;
      }

      return body;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function showResult(response) {
    const firstName = response.firstName || form.elements.firstName.value.trim();
    const resultTitle = result.querySelector("[data-result-title]");
    const resultMessage = result.querySelector("[data-result-message]");
    const resultEyebrow = result.querySelector("[data-result-eyebrow]");
    const seatingCard = result.querySelector("[data-seating-card]");
    const tableNumberElement = result.querySelector("[data-table-number]");
    const tableNumber = normalizeTableNumber(response.tableNumber);

    resultEyebrow.textContent = response.attending ? "Response received" : "With our thanks";
    resultTitle.textContent = `Thank you, ${firstName}.`;

    if (response.attending) {
      if (tableNumber) {
        resultMessage.textContent = `You’re seated at Table ${tableNumber}.`;
      } else {
        resultMessage.textContent = "Your RSVP has been received. Seating details will be confirmed soon.";
      }

      seatingCard.hidden = !tableNumber;
      if (tableNumber) tableNumberElement.textContent = tableNumber;
      if (tableNumber) {
        showSeatingMap(tableNumber);
      } else {
        hideSeatingMap();
      }
    } else {
      resultMessage.textContent = "We’ll miss celebrating with you, but we’re grateful you let us know and will be thinking of you on the day.";
      seatingCard.hidden = true;
      hideSeatingMap();
    }

    form.hidden = true;
    result.hidden = false;
    panel?.scrollIntoView({
      behavior: prefersReducedMotion.matches ? "auto" : "smooth",
      block: "center"
    });
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
    const seatingMap = document.querySelector("[data-seating-map-canvas] svg");
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
    seatingMap.setAttribute("aria-label", `Seating layout with Table ${normalizedTable} highlighted`);
    addYouAreHereCallout(seatingMap, matchedTable);

    return true;
  }

  function addYouAreHereCallout(svg, tableElement) {
    const oldLayer = svg.querySelector("#you-are-here-layer");
    if (oldLayer) oldLayer.remove();
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
    const bubbleToTableLength =
      Math.hypot(bubbleToTableX, bubbleToTableY) || 1;
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
    const tableToBubbleLength =
      Math.hypot(tableToBubbleX, tableToBubbleY) || 1;
    const tableDirectionX = tableToBubbleX / tableToBubbleLength;
    const tableDirectionY = tableToBubbleY / tableToBubbleLength;
    const tipX =
      geometry.cx + tableDirectionX * geometry.radius * 0.92;
    const tipY =
      geometry.cy + tableDirectionY * geometry.radius * 0.92;

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

    callout.append(
      arrowHalo,
      arrow,
      arrowHead,
      bubble,
      text
    );

    if (DEBUG_YOUR_TABLE_CALLOUT) {
      callout.append(
        createSvgElement(namespace, "circle", {
          cx: formatSvgNumber(startX),
          cy: formatSvgNumber(startY),
          r: "1.8",
          fill: "#2f80ed"
        }),
        createSvgElement(namespace, "circle", {
          cx: formatSvgNumber(baseX),
          cy: formatSvgNumber(baseY),
          r: "1.8",
          fill: "#8e44ad"
        }),
        createSvgElement(namespace, "circle", {
          cx: formatSvgNumber(tipX),
          cy: formatSvgNumber(tipY),
          r: "1.8",
          fill: "#d33f49"
        })
      );
    }

    calloutLayer.appendChild(callout);
    svg.appendChild(calloutLayer);
    if (!hasLoggedManualCalloutVersion) {
      console.log("Your table callout: manual polygon arrow v1");
      hasLoggedManualCalloutVersion = true;
    }
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
    const mapSection = result.querySelector("[data-seating-map-section]");
    const mapViewport = result.querySelector("[data-seating-map]");
    const mapStatus = result.querySelector("[data-seating-map-status]");
    if (!normalizedTable || !mapSection || !mapViewport || !mapStatus) {
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
        mapStatus.textContent = `Your table is Table ${normalizedTable}. A visual map is not available for this table yet.`;
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
      mapStatus.textContent = `Your table is Table ${normalizedTable}. A visual map is not available for this table yet.`;
    }
  }

  function hideSeatingMap() {
    activeSeatingTable = null;

    const mapSection = result.querySelector("[data-seating-map-section]");
    const mapViewport = result.querySelector("[data-seating-map]");
    const mapStatus = result.querySelector("[data-seating-map-status]");
    mapSection?.setAttribute("hidden", "");
    mapViewport?.setAttribute("hidden", "");

    if (mapStatus) {
      mapStatus.hidden = true;
      mapStatus.textContent = "";
      mapStatus.classList.remove("is-loading");
    }

    const svg = result.querySelector("[data-seating-map-canvas] svg");
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
    const targetScrollLeft = Math.max(
      0,
      highlightCentre - viewport.clientWidth / 2
    );

    viewport.scrollTo({
      left: targetScrollLeft,
      behavior: prefersReducedMotion.matches ? "auto" : "smooth"
    });
  }

  function loadSeatingMap() {
    const canvas = result.querySelector("[data-seating-map-canvas]");
    const existingSvg = canvas?.querySelector("svg");
    if (existingSvg) return Promise.resolve(existingSvg);
    if (!canvas) return Promise.reject(new Error("Seating map container is unavailable."));

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
          parsedSvg.querySelectorAll("script, foreignObject").forEach((element) => element.remove());
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
          canvas.replaceChildren(inlineSvg);
          return inlineSvg;
        })
        .catch((error) => {
          seatingMapLoadPromise = null;
          throw error;
        });
    }

    return seatingMapLoadPromise;
  }

  function handleSubmissionError(error) {
    if (error.name === "AbortError") {
      showFormMessage("The concierge is taking a little longer than expected. Please check your connection and try once more.");
      return;
    }

    if (error.status === "multiple_matches") {
      showFormMessage(error.message || "We found more than one guest with that name. Please add your email or phone number.");
      const contact = form.elements.email.value.trim() ? form.elements.phone : form.elements.email;
      contact.focus();
      return;
    }

    if (error.status === "not_found") {
      showFormMessage(error.message || "We couldn’t find your invitation. Please check the spelling exactly as printed, or contact us below and we’ll help.");
      return;
    }

    showFormMessage(error.message || "Something went awry while saving your response. Please try again in a moment.");
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    hideFormMessage();
    if (!validateForm()) return;

    setLoading(true);
    try {
      const response = await sendRsvp(getPayload());
      showResult(response);
    } catch (error) {
      handleSubmissionError(error);
    } finally {
      setLoading(false);
    }
  });

  result.querySelector("[data-edit-response]")?.addEventListener("click", () => {
    result.hidden = true;
    form.hidden = false;
    hideFormMessage();
    form.elements.firstName.focus();
  });
})();
