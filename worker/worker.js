/**
 * Wedding RSVP concierge — the project's only backend.
 *
 * Required Worker variables/secrets:
 *   GHL_PRIVATE_INTEGRATION_TOKEN  Secret: the sub-account Private Integration Token
 *   GHL_LOCATION_ID                Variable: the GHL location/sub-account ID
 *   GHL_API_BASE                   Variable: https://services.leadconnectorhq.com
 *   GHL_API_VERSION                Variable: the Version header enabled for the account
 *   WEDDING_ID                     Variable: hart-brooks-2026 for this test
 *   ALLOWED_ORIGIN                 Variable: the exact public front-end origin
 *   DEBUG_KEY                      Optional secret: enables protected diagnostics/logs
 *   SEATING_SYNC_KEY               Secret: protects the GHL-to-KV seating sync
 *   SEATING_LOOKUP_ID_SECRET       Secret: creates stable opaque public lookup IDs
 *   SEATING_LOOKUP                 KV binding: minimal QR seating directory
 *
 * GHL custom field IDs are intentionally NOT configured here. The Worker lists
 * the location's contact custom fields, resolves the seven required display
 * names, and caches that mapping in the current Worker isolate for five minutes.
 */

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=UTF-8",
  "Cache-Control": "no-store"
};

const REQUIRED_ENVIRONMENT = [
  "GHL_PRIVATE_INTEGRATION_TOKEN",
  "GHL_LOCATION_ID",
  "GHL_API_BASE",
  "GHL_API_VERSION",
  "WEDDING_ID",
  "ALLOWED_ORIGIN"
];

const REQUIRED_FIELD_NAMES = [
  "Wedding ID",
  "RSVP Status",
  "Dietary Requirement",
  "Dietary Notes",
  "Dietary Submitted",
  "Table Number",
  "Seat Number"
];

const ALLOWED_DIETARY_REQUIREMENTS = new Set([
  "No dietary requirements",
  "Vegetarian",
  "Vegan",
  "Gluten-free",
  "Dairy-free",
  "Nut allergy",
  "Shellfish allergy",
  "Halal",
  "Kosher",
  "Other"
]);

const MAX_BODY_BYTES = 16_384;
const FIELD_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CONTACTS_TO_HYDRATE = 20;
const MAX_GUEST_SEARCH_RESULTS = 10;
const MAX_CONTACT_ID_LENGTH = 200;
const SEATING_DIRECTORY_SCHEMA_VERSION = 1;
const SEATING_DIRECTORY_KV_CACHE_TTL_SECONDS = 60;
const SEATING_DIRECTORY_MEMORY_TTL_MS = 30 * 1000;
const SEATING_SYNC_PAGE_LIMIT = 100;
const SEATING_SYNC_MAX_CONTACTS = 4_500;
const SEATING_SYNC_MAX_PAGES = Math.ceil(
  SEATING_SYNC_MAX_CONTACTS / SEATING_SYNC_PAGE_LIMIT
) + 1;
const MINIMUM_SEATING_SYNC_KEY_LENGTH = 24;
const WEDDING_DATA_SAMPLE_LIMIT = 20;
const CONTACT_HYDRATION_CONCURRENCY = 5;

let fieldCache = {
  cacheKey: "",
  expiresAt: 0,
  registry: null
};

let seatingDirectoryCache = {
  cacheKey: "",
  expiresAt: 0,
  directory: null
};
let seatingDirectoryLoadPromise = null;
let seatingDirectoryLoadKey = "";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === "OPTIONS") {
      if (!isAllowedOrigin(request, env)) {
        return json({ success: false, status: "forbidden", message: "Origin not allowed." }, 403, cors);
      }
      return new Response(null, { status: 204, headers: cors });
    }

    if (url.pathname === "/health" && request.method === "GET") {
      return handleHealth(env, cors);
    }

    const protectedDebugRoutes = new Set([
      "/debug-search",
      "/debug-contact-shape",
      "/debug-wedding-data"
    ]);

    if (request.method === "GET" && protectedDebugRoutes.has(url.pathname)) {
      const accessError = debugAccessError(request, url, env, cors);
      if (accessError) return accessError;

      if (url.pathname === "/debug-search") {
        return handleDebugSearch(url, env, cors);
      }
      if (url.pathname === "/debug-contact-shape") {
        return handleDebugContactShape(url, env, cors);
      }
      return handleDebugWeddingData(url, env, cors);
    }

    if (
      url.pathname === "/admin/sync-seating-lookup" &&
      request.method === "POST"
    ) {
      const accessError = seatingSyncAccessError(request, env, cors);
      if (accessError) return accessError;
      return handleSeatingDirectorySync(env, cors);
    }

    if (url.pathname === "/submit-rsvp" && request.method === "POST") {
      if (!isAllowedOrigin(request, env)) {
        return json({ success: false, status: "forbidden", message: "Origin not allowed." }, 403, cors);
      }
      return handleRsvp(request, env, cors);
    }

    if (url.pathname === "/search-guests" && request.method === "POST") {
      if (!isAllowedOrigin(request, env)) {
        return json({ success: false, status: "forbidden", message: "Origin not allowed." }, 403, cors);
      }
      return handleGuestSearch(request, env, cors);
    }

    if (url.pathname === "/lookup-guest-table" && request.method === "POST") {
      if (!isAllowedOrigin(request, env)) {
        return json({ success: false, status: "forbidden", message: "Origin not allowed." }, 403, cors);
      }
      return handleGuestTableLookup(request, env, cors);
    }

    return json({ success: false, status: "not_found", message: "Not found." }, 404, cors);
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      syncSeatingDirectory(env).catch((error) => {
        console.error("Scheduled seating sync error:", safeErrorLabel(error));
      })
    );
  }
};

async function handleHealth(env, cors) {
  const missingVariables = missingEnvironmentVariables(env);
  const tokenPresent = Boolean(String(env.GHL_PRIVATE_INTEGRATION_TOKEN || "").trim());
  const locationIdPresent = Boolean(String(env.GHL_LOCATION_ID || "").trim());
  const base = {
    success: true,
    service: "wedding-rsvp-concierge",
    worker: "running",
    timestamp: new Date().toISOString(),
    checks: {
      environment: {
        passed: missingVariables.length === 0,
        missingVariables
      },
      token: {
        present: tokenPresent
      },
      location: {
        idPresent: locationIdPresent
      }
    }
  };

  if (missingVariables.length) {
    return json({
      ...base,
      status: "configuration_error",
      configured: false,
      integration: {
        status: "missing_worker_variables",
        apiResponded: false,
        authenticated: null,
        customFields: buildFieldResolutionSummary(null)
      }
    }, 503, cors);
  }

  try {
    // Health is a launch preflight, so bypass the warm-isolate field cache.
    const fields = await getCustomFieldRegistry(env, true);
    const configured = fields.missing.length === 0;

    return json({
      ...base,
      status: configured ? "ok" : "configuration_error",
      configured,
      integration: {
        status: configured ? "connected" : "missing_custom_fields",
        apiResponded: true,
        authenticated: true,
        customFields: buildFieldResolutionSummary(fields)
      }
    }, configured ? 200 : 503, cors);
  } catch (error) {
    const ghlResponded = error instanceof GhlApiError;
    return json({
      ...base,
      status: "integration_error",
      configured: false,
      integration: {
        ...healthErrorDetails(error),
        apiResponded: ghlResponded,
        authenticated:
          error instanceof GhlApiError && error.status === 401
            ? false
            : null,
        customFields: buildFieldResolutionSummary(null)
      }
    }, 503, cors);
  }
}

async function handleDebugSearch(url, env, cors) {
  try {
    assertEnvironment(env);

    const email = normalizeEmail(url.searchParams.get("email"));
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json({
        success: false,
        status: "invalid_request",
        message: "Provide a valid email query parameter."
      }, 400, cors);
    }

    const fields = await getCustomFieldRegistry(env);
    const contacts = await searchAndHydrateContacts(env, email, "debug_email");
    const exactEmailContacts = contacts.filter(
      (contact) => normalizeEmail(contact.email) === email
    );

    const weddingField = fields.byName["Wedding ID"];
    const tableField = fields.byName["Table Number"];
    const seatField = fields.byName["Seat Number"];
    const candidates = exactEmailContacts.map((contact) => {
      const weddingValue = getCustomFieldValue(contact, weddingField);
      const tableValue = getCustomFieldValue(contact, tableField);
      const seatValue = getCustomFieldValue(contact, seatField);

      return {
        ...safeCandidateIdentity(contact),
        weddingIdFieldDetected: weddingValue != null && String(weddingValue).trim() !== "",
        weddingIdMatched:
          weddingValue != null &&
          normalizeIdentifier(weddingValue) === normalizeIdentifier(env.WEDDING_ID),
        tableFieldDetected: tableValue != null && String(tableValue).trim() !== "",
        seatFieldDetected: seatValue != null && String(seatValue).trim() !== ""
      };
    });

    return json({
      success: true,
      status: "debug_complete",
      ghlResponded: true,
      searchResultsReturned: contacts.length,
      contactsFound: candidates.length,
      customFieldIdsResolved: fields.missing.length === 0,
      missingCustomFields: fields.missing,
      candidates
    }, 200, cors);
  } catch (error) {
    console.error("RSVP debug error:", safeErrorLabel(error));
    return json({
      success: false,
      status: "server_error",
      ghlResponded: false,
      message: healthErrorDetails(error).message
    }, 502, cors);
  }
}

async function handleDebugContactShape(url, env, cors) {
  try {
    assertEnvironment(env);

    const email = normalizeEmail(url.searchParams.get("email"));
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json({
        success: false,
        status: "invalid_request",
        message: "Provide a valid email query parameter."
      }, 400, cors);
    }

    const fields = await getCustomFieldRegistry(env);
    const contacts = await searchAndHydrateContacts(env, email, "debug_contact_shape");
    const exactMatches = contacts.filter(
      (contact) => normalizeEmail(contact.email) === email
    );

    if (exactMatches.length === 0) {
      return json({
        success: true,
        status: "not_found",
        contactFound: false,
        matchesFound: 0,
        customFields: REQUIRED_FIELD_NAMES.map((displayName) =>
          debugFieldSummary(null, displayName, fields)
        )
      }, 200, cors);
    }

    const contact = exactMatches[0];
    return json({
      success: true,
      status: "debug_complete",
      contactFound: true,
      matchesFound: exactMatches.length,
      multipleMatchesDetected: exactMatches.length > 1,
      firstName: cleanText(contact.firstName, 80),
      lastName: cleanText(contact.lastName, 80),
      email: normalizeEmail(contact.email),
      phone: cleanText(contact.phone, 40),
      customFields: REQUIRED_FIELD_NAMES.map((displayName) =>
        debugFieldSummary(contact, displayName, fields)
      )
    }, 200, cors);
  } catch (error) {
    console.error("RSVP contact-shape debug error:", safeErrorLabel(error));
    return json({
      success: false,
      status: "server_error",
      contactFound: false,
      message: healthErrorDetails(error).message
    }, 502, cors);
  }
}

async function handleDebugWeddingData(url, env, cors) {
  try {
    assertEnvironment(env);

    const weddingId = cleanText(url.searchParams.get("weddingId"), 120);
    if (!weddingId) {
      return json({
        success: false,
        status: "invalid_request",
        message: "Provide a weddingId query parameter."
      }, 400, cors);
    }

    const fields = await getCustomFieldRegistry(env);
    if (fields.missing.length) {
      return json({
        success: false,
        status: "configuration_error",
        message: "Required GHL custom fields are missing.",
        missingCustomFields: fields.missing
      }, 503, cors);
    }

    const sample = await getBoundedLocationContactSample(env);
    const weddingField = fields.byName["Wedding ID"];
    const tableField = fields.byName["Table Number"];
    const seatField = fields.byName["Seat Number"];
    let numberMissingWeddingId = 0;

    const weddingContacts = sample.filter((contact) => {
      const value = getCustomFieldValue(contact, weddingField);
      if (!hasDetectedValue(value)) {
        numberMissingWeddingId += 1;
        return false;
      }
      return normalizeIdentifier(value) === normalizeIdentifier(weddingId);
    });

    const numberMissingTableNumber = countMissingField(weddingContacts, tableField);
    const numberMissingSeatNumber = countMissingField(weddingContacts, seatField);
    const numberMissingEmail = weddingContacts.filter(
      (contact) => !normalizeEmail(contact.email)
    ).length;
    const numberMissingPhone = weddingContacts.filter(
      (contact) => !normalizePhone(contact.phone)
    ).length;
    const numberWithTableNumber = weddingContacts.length - numberMissingTableNumber;
    const numberWithSeatNumber = weddingContacts.length - numberMissingSeatNumber;
    const warnings = buildWeddingDataWarnings({
      sampleCount: sample.length,
      contactsFound: weddingContacts.length,
      numberMissingWeddingId,
      numberMissingTableNumber,
      numberMissingSeatNumber,
      numberMissingEmail,
      numberMissingPhone
    });

    return json({
      success: true,
      status: warnings.length ? "warnings" : "ready",
      weddingId,
      contactsFound: weddingContacts.length,
      sampleCount: sample.length,
      sampleLimit: WEDDING_DATA_SAMPLE_LIMIT,
      numberMissingWeddingId,
      numberMissingTableNumber,
      numberMissingSeatNumber,
      numberMissingEmail,
      numberMissingPhone,
      numberWithTableNumber,
      numberWithSeatNumber,
      warnings
    }, 200, cors);
  } catch (error) {
    console.error("RSVP wedding-data debug error:", safeErrorLabel(error));
    return json({
      success: false,
      status: "server_error",
      message: healthErrorDetails(error).message
    }, 502, cors);
  }
}

async function handleGuestSearch(request, env, cors) {
  try {
    const parsed = await readJsonBody(request);
    if (!parsed.ok) {
      return lookupError(
        "invalid_request",
        "Please send a valid name search.",
        parsed.httpStatus,
        cors
      );
    }

    const raw = parsed.value;
    if (
      raw &&
      typeof raw === "object" &&
      !Array.isArray(raw) &&
      raw.warm === true
    ) {
      await getSeatingDirectory(env);
      return json({ success: true, ready: true, matches: [] }, 200, cors);
    }

    const query = raw && typeof raw === "object" && !Array.isArray(raw) &&
      typeof raw.query === "string"
      ? normalizeLookupText(raw.query)
      : "";

    if (query.length < 2) {
      return lookupError(
        "invalid_request",
        "Please type at least 2 characters of your name.",
        400,
        cors
      );
    }

    const directory = await getSeatingDirectory(env);
    const matches = searchSeatingDirectory(directory, query);

    return json({ success: true, matches }, 200, cors);
  } catch (error) {
    console.error("Guest seating search error:", safeErrorLabel(error));
    return lookupError(
      "service_error",
      "Something went wrong. Please try again or ask the welcome team for help.",
      lookupSafeHttpStatus(error),
      cors
    );
  }
}

async function handleGuestTableLookup(request, env, cors) {
  try {
    const parsed = await readJsonBody(request);
    if (!parsed.ok) {
      return lookupError(
        "invalid_request",
        "Please send a valid guest selection.",
        parsed.httpStatus,
        cors
      );
    }

    const raw = parsed.value;
    const lookupId = raw && typeof raw === "object" && !Array.isArray(raw)
      ? normalizeContactId(raw.contactId)
      : "";

    if (!lookupId) {
      return lookupError(
        "invalid_request",
        "Please select a guest from the search results.",
        400,
        cors
      );
    }

    const directory = await getSeatingDirectory(env);
    const guest = directory.guests.find((entry) => entry.lookupId === lookupId);

    if (!guest) {
      return lookupError(
        "not_found",
        "We couldn’t find that guest. Please check the spelling or ask the welcome team for help.",
        404,
        cors
      );
    }

    if (!guest.tableNumber) {
      return lookupError(
        "table_not_found",
        "We found your name, but your table is not available yet. Please ask the welcome team for help.",
        200,
        cors
      );
    }

    return json({
      success: true,
      displayName: guest.displayName,
      tableNumber: guest.tableNumber
    }, 200, cors);
  } catch (error) {
    console.error("Guest table lookup error:", safeErrorLabel(error));
    return lookupError(
      "service_error",
      "Something went wrong. Please try again or ask the welcome team for help.",
      lookupSafeHttpStatus(error),
      cors
    );
  }
}

async function handleSeatingDirectorySync(env, cors) {
  try {
    const result = await syncSeatingDirectory(env);
    return json({
      success: true,
      status: "synced",
      syncedAt: result.syncedAt,
      scannedContacts: result.scannedContacts,
      guestCount: result.guestCount,
      withTableCount: result.withTableCount,
      withoutTableCount: result.withoutTableCount,
      pagesRead: result.pagesRead
    }, 200, cors);
  } catch (error) {
    console.error("Seating directory sync error:", safeErrorLabel(error));
    return json({
      success: false,
      status: "sync_failed",
      message: "The seating directory could not be refreshed. The previous directory was preserved."
    }, lookupSafeHttpStatus(error), cors);
  }
}

async function syncSeatingDirectory(env) {
  assertEnvironment(env);
  assertSeatingSyncConfiguration(env);

  const fields = await getCustomFieldRegistry(env);
  const weddingField = requireLookupField(fields, "Wedding ID");
  const tableField = requireLookupField(fields, "Table Number");
  const source = await listAllGhlContactsForSeating(env);
  const lookupKey = await importSeatingLookupIdKey(env);
  const guests = [];
  const seenLookupIds = new Set();

  for (const contact of source.contacts) {
    if (!contactBelongsToConfiguredWedding(contact, weddingField, env)) continue;

    const ghlContactId = normalizeContactId(contact?.id);
    const displayName = guestDisplayName(contact);
    const searchName = normalizeLookupText(displayName);
    if (!ghlContactId || !displayName || !searchName) continue;

    const lookupId = await createOpaqueSeatingLookupId(
      lookupKey,
      env,
      ghlContactId
    );
    if (seenLookupIds.has(lookupId)) {
      throw new SeatingDirectoryError("duplicate_lookup_id");
    }
    seenLookupIds.add(lookupId);

    guests.push({
      lookupId,
      displayName,
      searchName,
      tableNumber: publicTableNumber(getCustomFieldValue(contact, tableField))
    });
  }

  if (!guests.length) {
    throw new SeatingDirectoryError("no_wedding_guests");
  }

  guests.sort((left, right) => (
    left.displayName.localeCompare(right.displayName, "en-AU", { sensitivity: "base" }) ||
    left.lookupId.localeCompare(right.lookupId)
  ));

  const syncedAt = new Date().toISOString();
  const withTableCount = guests.filter((guest) => guest.tableNumber).length;
  const snapshot = validateSeatingDirectory({
    schemaVersion: SEATING_DIRECTORY_SCHEMA_VERSION,
    locationId: cleanText(env.GHL_LOCATION_ID, MAX_CONTACT_ID_LENGTH),
    weddingId: normalizeIdentifier(env.WEDDING_ID),
    syncedAt,
    guestCount: guests.length,
    withTableCount,
    guests
  }, env);
  const cacheKey = seatingDirectoryKvKey(env);

  // This is the only write. A failed scan or validation never replaces the
  // previous complete directory.
  await env.SEATING_LOOKUP.put(cacheKey, JSON.stringify(snapshot));
  setSeatingDirectoryMemoryCache(cacheKey, snapshot);

  return {
    syncedAt,
    scannedContacts: source.contacts.length,
    guestCount: guests.length,
    withTableCount,
    withoutTableCount: guests.length - withTableCount,
    pagesRead: source.pagesRead
  };
}

async function listAllGhlContactsForSeating(env) {
  const contactsById = new Map();
  const seenPageSignatures = new Set();
  const seenCursors = new Set();
  let startAfterId = "";
  let startAfter = "";
  let pagesRead = 0;
  let complete = false;

  for (let page = 0; page < SEATING_SYNC_MAX_PAGES; page += 1) {
    const params = new URLSearchParams({
      locationId: env.GHL_LOCATION_ID,
      limit: String(SEATING_SYNC_PAGE_LIMIT)
    });
    if (startAfterId) params.set("startAfterId", startAfterId);
    if (startAfter) params.set("startAfter", startAfter);

    const result = await ghlRequest(env, `/contacts/?${params.toString()}`, {
      method: "GET",
      debugSearchStrategy: "seating_directory_sync"
    });
    if (!hasContactCollection(result)) {
      throw new SeatingDirectoryError("invalid_contact_page");
    }

    const pageContacts = extractContacts(result);
    pagesRead += 1;
    if (!pageContacts.length) {
      complete = true;
      break;
    }

    const pageIds = pageContacts
      .map((contact) => normalizeContactId(contact?.id))
      .filter(Boolean);
    const pageSignature = `${pageContacts.length}:${pageIds.join(",")}`;
    if (seenPageSignatures.has(pageSignature)) {
      throw new SeatingDirectoryError("repeated_contact_page");
    }
    seenPageSignatures.add(pageSignature);

    for (const contact of pageContacts) {
      const contactId = normalizeContactId(contact?.id);
      if (contactId && !contactsById.has(contactId)) {
        contactsById.set(contactId, contact);
      }
    }

    const reportedTotal = extractContactTotal(result);
    if (
      contactsById.size > SEATING_SYNC_MAX_CONTACTS ||
      (reportedTotal !== null && reportedTotal > SEATING_SYNC_MAX_CONTACTS)
    ) {
      throw new SeatingDirectoryError("contact_limit_exceeded");
    }

    if (
      pageContacts.length < SEATING_SYNC_PAGE_LIMIT ||
      (reportedTotal !== null && contactsById.size >= reportedTotal)
    ) {
      complete = true;
      break;
    }

    const cursor = nextLegacyContactCursor(result, pageContacts.at(-1));
    if (!cursor.startAfterId && !cursor.startAfter) {
      throw new SeatingDirectoryError("missing_contact_cursor");
    }
    const cursorKey = `${cursor.startAfterId}|${cursor.startAfter}`;
    if (seenCursors.has(cursorKey)) {
      throw new SeatingDirectoryError("repeated_contact_cursor");
    }
    seenCursors.add(cursorKey);
    startAfterId = cursor.startAfterId;
    startAfter = cursor.startAfter;
  }

  if (!complete) {
    throw new SeatingDirectoryError("contact_page_limit_exceeded");
  }

  return {
    contacts: [...contactsById.values()],
    pagesRead
  };
}

function hasContactCollection(result) {
  return (
    Array.isArray(result?.contacts) ||
    Array.isArray(result?.data?.contacts) ||
    Array.isArray(result?.items)
  );
}

function extractContactTotal(result) {
  const candidates = [
    result?.total,
    result?.meta?.total,
    result?.data?.total,
    result?.data?.meta?.total
  ];

  for (const value of candidates) {
    if (value == null || value === "") continue;
    const total = Number(value);
    if (Number.isInteger(total) && total >= 0) return total;
  }
  return null;
}

function nextLegacyContactCursor(result, lastContact) {
  const meta = result?.meta || result?.data?.meta || {};
  let nextPageUrl = "";
  if (typeof meta.nextPageUrl === "string") nextPageUrl = meta.nextPageUrl;
  if (!nextPageUrl && typeof result?.nextPageUrl === "string") {
    nextPageUrl = result.nextPageUrl;
  }

  let urlCursorId = "";
  let urlCursorAfter = "";
  if (nextPageUrl) {
    try {
      const nextUrl = new URL(nextPageUrl, "https://cursor.invalid");
      urlCursorId = nextUrl.searchParams.get("startAfterId") || "";
      urlCursorAfter = nextUrl.searchParams.get("startAfter") || "";
    } catch {
      // Fall through to the documented cursor fields and final record.
    }
  }

  const fallbackTimestamp = Date.parse(
    lastContact?.dateAdded || lastContact?.dateUpdated || ""
  );
  return {
    startAfterId: cleanText(
      meta.startAfterId || result?.startAfterId || urlCursorId || lastContact?.id,
      MAX_CONTACT_ID_LENGTH
    ) || normalizeContactId(lastContact?.id),
    startAfter: cleanText(
      meta.startAfter ||
        result?.startAfter ||
        urlCursorAfter ||
        (Number.isFinite(fallbackTimestamp) ? fallbackTimestamp : ""),
      40
    )
  };
}

async function importSeatingLookupIdKey(env) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(String(env.SEATING_LOOKUP_ID_SECRET)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

async function createOpaqueSeatingLookupId(key, env, ghlContactId) {
  const input = [
    cleanText(env.GHL_LOCATION_ID, MAX_CONTACT_ID_LENGTH),
    normalizeIdentifier(env.WEDDING_ID),
    ghlContactId
  ].join("|");
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(input)
  );
  const bytes = new Uint8Array(signature).slice(0, 18);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `g_${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

async function getSeatingDirectory(env) {
  assertSeatingDirectoryReadConfiguration(env);
  const cacheKey = seatingDirectoryKvKey(env);
  const now = Date.now();

  if (
    seatingDirectoryCache.directory &&
    seatingDirectoryCache.cacheKey === cacheKey &&
    seatingDirectoryCache.expiresAt > now
  ) {
    return seatingDirectoryCache.directory;
  }

  if (seatingDirectoryLoadPromise && seatingDirectoryLoadKey === cacheKey) {
    return seatingDirectoryLoadPromise;
  }

  const lastKnownDirectory = seatingDirectoryCache.cacheKey === cacheKey
    ? seatingDirectoryCache.directory
    : null;
  seatingDirectoryLoadKey = cacheKey;
  seatingDirectoryLoadPromise = (async () => {
    try {
      const stored = await env.SEATING_LOOKUP.get(cacheKey, {
        type: "json",
        cacheTtl: SEATING_DIRECTORY_KV_CACHE_TTL_SECONDS
      });
      if (!stored) {
        if (lastKnownDirectory) return lastKnownDirectory;
        throw new SeatingDirectoryError("directory_not_ready");
      }

      const directory = validateSeatingDirectory(stored, env);
      setSeatingDirectoryMemoryCache(cacheKey, directory);
      return directory;
    } catch (error) {
      if (lastKnownDirectory) return lastKnownDirectory;
      if (error instanceof SeatingDirectoryError) throw error;
      throw new SeatingDirectoryError("directory_read_failed");
    }
  })();

  try {
    return await seatingDirectoryLoadPromise;
  } finally {
    if (seatingDirectoryLoadKey === cacheKey) {
      seatingDirectoryLoadPromise = null;
      seatingDirectoryLoadKey = "";
    }
  }
}

function setSeatingDirectoryMemoryCache(cacheKey, directory) {
  seatingDirectoryCache = {
    cacheKey,
    expiresAt: Date.now() + SEATING_DIRECTORY_MEMORY_TTL_MS,
    directory
  };
}

function validateSeatingDirectory(value, env) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SeatingDirectoryError("invalid_directory");
  }

  const allowedRootKeys = new Set([
    "schemaVersion",
    "locationId",
    "weddingId",
    "syncedAt",
    "guestCount",
    "withTableCount",
    "guests"
  ]);
  if (Object.keys(value).some((key) => !allowedRootKeys.has(key))) {
    throw new SeatingDirectoryError("unexpected_directory_field");
  }
  if (value.schemaVersion !== SEATING_DIRECTORY_SCHEMA_VERSION) {
    throw new SeatingDirectoryError("unsupported_directory_schema");
  }
  if (
    cleanText(value.locationId, MAX_CONTACT_ID_LENGTH) !==
      cleanText(env.GHL_LOCATION_ID, MAX_CONTACT_ID_LENGTH) ||
    normalizeIdentifier(value.weddingId) !== normalizeIdentifier(env.WEDDING_ID)
  ) {
    throw new SeatingDirectoryError("directory_namespace_mismatch");
  }
  if (!Number.isFinite(Date.parse(value.syncedAt)) || !Array.isArray(value.guests)) {
    throw new SeatingDirectoryError("invalid_directory_metadata");
  }
  if (value.guests.length > SEATING_SYNC_MAX_CONTACTS) {
    throw new SeatingDirectoryError("directory_guest_limit_exceeded");
  }

  const allowedGuestKeys = new Set([
    "lookupId",
    "displayName",
    "searchName",
    "tableNumber"
  ]);
  const seenLookupIds = new Set();
  const guests = value.guests.map((guest) => {
    if (!guest || typeof guest !== "object" || Array.isArray(guest)) {
      throw new SeatingDirectoryError("invalid_directory_guest");
    }
    if (Object.keys(guest).some((key) => !allowedGuestKeys.has(key))) {
      throw new SeatingDirectoryError("unexpected_guest_field");
    }

    const lookupId = normalizeContactId(guest.lookupId);
    const displayName = cleanText(guest.displayName, 160);
    const searchName = normalizeLookupText(guest.searchName);
    const tableNumber = guest.tableNumber === ""
      ? ""
      : publicTableNumber(guest.tableNumber);
    if (
      !/^g_[A-Za-z0-9_-]{20,64}$/.test(lookupId) ||
      !displayName ||
      searchName !== normalizeLookupText(displayName) ||
      seenLookupIds.has(lookupId)
    ) {
      throw new SeatingDirectoryError("invalid_directory_guest");
    }
    seenLookupIds.add(lookupId);
    return { lookupId, displayName, searchName, tableNumber };
  });
  const withTableCount = guests.filter((guest) => guest.tableNumber).length;
  if (
    value.guestCount !== guests.length ||
    value.withTableCount !== withTableCount
  ) {
    throw new SeatingDirectoryError("directory_count_mismatch");
  }

  return {
    schemaVersion: SEATING_DIRECTORY_SCHEMA_VERSION,
    locationId: cleanText(env.GHL_LOCATION_ID, MAX_CONTACT_ID_LENGTH),
    weddingId: normalizeIdentifier(env.WEDDING_ID),
    syncedAt: new Date(value.syncedAt).toISOString(),
    guestCount: guests.length,
    withTableCount,
    guests
  };
}

function searchSeatingDirectory(directory, query) {
  return directory.guests
    .map((guest) => {
      const matchIndex = guest.searchName.indexOf(query);
      if (matchIndex < 0) return null;
      const words = guest.searchName.split(" ");
      let rank = 4;
      if (guest.searchName === query || words.some((word) => word === query)) {
        rank = 0;
      } else if (guest.searchName.startsWith(query)) {
        rank = 1;
      } else if (words.some((word) => word.startsWith(query))) {
        rank = 2;
      } else {
        rank = 3;
      }
      return { guest, matchIndex, rank };
    })
    .filter(Boolean)
    .sort((left, right) => (
      left.rank - right.rank ||
      left.matchIndex - right.matchIndex ||
      left.guest.displayName.length - right.guest.displayName.length ||
      left.guest.displayName.localeCompare(
        right.guest.displayName,
        "en-AU",
        { sensitivity: "base" }
      )
    ))
    .slice(0, MAX_GUEST_SEARCH_RESULTS)
    .map(({ guest }) => ({
      contactId: guest.lookupId,
      displayName: guest.displayName
    }));
}

function seatingDirectoryKvKey(env) {
  return [
    "seating-directory",
    `v${SEATING_DIRECTORY_SCHEMA_VERSION}`,
    encodeURIComponent(cleanText(env.GHL_LOCATION_ID, MAX_CONTACT_ID_LENGTH)),
    encodeURIComponent(normalizeIdentifier(env.WEDDING_ID))
  ].join(":");
}

function assertSeatingDirectoryReadConfiguration(env) {
  if (
    !cleanText(env.GHL_LOCATION_ID, MAX_CONTACT_ID_LENGTH) ||
    !normalizeIdentifier(env.WEDDING_ID) ||
    !env.SEATING_LOOKUP ||
    typeof env.SEATING_LOOKUP.get !== "function"
  ) {
    throw new SeatingDirectoryError("directory_not_configured");
  }
}

function assertSeatingSyncConfiguration(env) {
  assertSeatingDirectoryReadConfiguration(env);
  if (
    typeof env.SEATING_LOOKUP.put !== "function" ||
    String(env.SEATING_SYNC_KEY || "").length < MINIMUM_SEATING_SYNC_KEY_LENGTH ||
    String(env.SEATING_LOOKUP_ID_SECRET || "").length < MINIMUM_SEATING_SYNC_KEY_LENGTH
  ) {
    throw new SeatingDirectoryError("sync_not_configured");
  }
}

function seatingSyncAccessError(request, env, cors) {
  try {
    assertSeatingSyncConfiguration(env);
  } catch {
    return json({
      success: false,
      status: "sync_not_configured",
      message: "Seating sync is not configured."
    }, 503, cors);
  }

  const authorization = request.headers.get("authorization") || "";
  const expected = `Bearer ${String(env.SEATING_SYNC_KEY)}`;
  if (!constantTimeStringEqual(authorization, expected)) {
    return json({
      success: false,
      status: "unauthorized",
      message: "A valid seating sync key is required."
    }, 401, cors);
  }
  return null;
}

function constantTimeStringEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function handleRsvp(request, env, cors) {
  try {
    assertEnvironment(env);

    const parsed = await readJsonBody(request);
    if (!parsed.ok) {
      return json({
        success: false,
        status: "invalid_request",
        message: parsed.message
      }, parsed.httpStatus, cors);
    }

    const input = validateAndNormalizeInput(parsed.value, env);
    if (!input.ok) {
      return json({
        success: false,
        status: "invalid_request",
        message: input.message
      }, 400, cors);
    }

    debugLog(env, "rsvp_received", {
      firstName: input.value.firstName,
      lastName: input.value.lastName,
      email: input.value.email,
      phone: input.value.phone,
      weddingId: input.value.weddingId,
      locationIdPresent: Boolean(env.GHL_LOCATION_ID)
    });

    const fields = await getCustomFieldRegistry(env);
    debugLog(env, "custom_fields_resolved", {
      resolved: fields.missing.length === 0,
      weddingIdField: Boolean(fields.byName["Wedding ID"]),
      tableField: Boolean(fields.byName["Table Number"]),
      seatField: Boolean(fields.byName["Seat Number"])
    });

    if (fields.missing.length) {
      throw new IntegrationConfigurationError(
        `Missing required GHL custom fields: ${fields.missing.join(", ")}`
      );
    }

    const candidates = await searchGhlContacts(env, input.value, fields);
    if (candidates.length === 0) {
      return json({
        success: false,
        status: "not_found",
        message: "We couldn’t find your invitation. Please check your details or contact the couple."
      }, 200, cors);
    }

    const match = disambiguateByEmailOrPhone(candidates, input.value);
    if (match.status === "multiple_matches") {
      return json({
        success: false,
        status: "multiple_matches",
        message: "We found more than one guest with that name. Please add your email or phone number."
      }, 409, cors);
    }

    if (match.status === "not_found") {
      return json({
        success: false,
        status: "not_found",
        message: "We couldn’t find your invitation. Please check your details or contact the couple."
      }, 200, cors);
    }

    await updateGhlContact(env, match.contact.id, input.value, fields);

    const response = {
      success: true,
      status: "matched",
      attending: input.value.attending === "yes",
      firstName: input.value.firstName
    };

    const seating = getTableAndSeat(match.contact, fields);
    debugLog(env, "seating_fields", {
      tableFound: seating.tableNumber != null,
      seatFound: seating.seatNumber != null
    });

    if (input.value.attending === "yes") {
      if (seating.tableNumber != null) {
        response.tableNumber = seating.tableNumber;
      }
    }

    return json(response, 200, cors);
  } catch (error) {
    // Never log the request body, names, contact records, or raw GHL response.
    console.error("RSVP integration error:", safeErrorLabel(error));

    return json({
      success: false,
      status: "server_error",
      message: guestSafeServiceMessage(error)
    }, guestSafeHttpStatus(error), cors);
  }
}

/**
 * Resolve custom fields by display name. Module-level state is reused while a
 * Cloudflare Worker isolate is warm; a fresh isolate simply fetches them again.
 */
async function getCustomFieldRegistry(env, forceRefresh = false) {
  const cacheKey = [
    env.GHL_LOCATION_ID,
    normalizedApiBase(env.GHL_API_BASE),
    env.GHL_API_VERSION
  ].join("|");
  const now = Date.now();

  if (
    !forceRefresh &&
    fieldCache.registry &&
    fieldCache.cacheKey === cacheKey &&
    fieldCache.expiresAt > now
  ) {
    return fieldCache.registry;
  }

  const result = await ghlRequest(
    env,
    `/locations/${encodeURIComponent(env.GHL_LOCATION_ID)}/customFields?model=contact`,
    { method: "GET" }
  );

  const customFields = Array.isArray(result.customFields)
    ? result.customFields
    : Array.isArray(result.data?.customFields)
      ? result.data.customFields
      : [];

  const byNormalizedName = new Map();
  for (const field of customFields) {
    if (String(field.model || "contact").toLowerCase() !== "contact") continue;
    const normalizedName = normalizeFieldName(field.name);
    if (normalizedName && field.id) byNormalizedName.set(normalizedName, field);
  }

  const byName = {};
  for (const requiredName of REQUIRED_FIELD_NAMES) {
    const match = byNormalizedName.get(normalizeFieldName(requiredName));
    if (match) {
      byName[requiredName] = {
        id: match.id,
        fieldKey: match.fieldKey || match.key || null,
        dataType: match.dataType || null
      };
    }
  }

  const registry = {
    byName,
    missing: REQUIRED_FIELD_NAMES.filter((name) => !byName[name])
  };

  fieldCache = {
    cacheKey,
    expiresAt: now + FIELD_CACHE_TTL_MS,
    registry
  };

  return registry;
}

function requireLookupField(fields, displayName) {
  const field = fields?.byName?.[displayName];
  if (!field?.id) {
    throw new IntegrationConfigurationError(
      `Missing required GHL custom field: ${displayName}`
    );
  }
  return field;
}

function buildFieldResolutionSummary(fields) {
  const resolvedFields = fields?.byName || {};
  const fieldChecks = REQUIRED_FIELD_NAMES.map((displayName) => ({
    displayName,
    fieldIdResolved: Boolean(resolvedFields[displayName]?.id)
  }));
  const missing = fields?.missing || REQUIRED_FIELD_NAMES.slice();

  return {
    allResolved: missing.length === 0,
    requiredCount: REQUIRED_FIELD_NAMES.length,
    resolvedCount: fieldChecks.filter((field) => field.fieldIdResolved).length,
    fields: fieldChecks,
    missing,
    cacheTtlSeconds: FIELD_CACHE_TTL_MS / 1000
  };
}

/**
 * Search in descending-confidence order. Every stage is manually filtered
 * after full contact hydration, so loose GHL query results cannot create a
 * false match.
 */
async function searchGhlContacts(env, guest, fields) {
  if (guest.email) {
    const emailContacts = await searchAndHydrateContacts(env, guest.email, "email");
    const emailMatches = filterGuestCandidates(emailContacts, guest, fields, "email", env);
    if (emailMatches.length) return emailMatches;
  }

  if (guest.phone) {
    const phoneContacts = [];
    for (const term of phoneSearchTerms(guest.phone)) {
      const result = await searchAndHydrateContacts(env, term, "phone");
      phoneContacts.push(...result);
      if (result.some((contact) => phonesEquivalent(contact.phone, guest.phone))) break;
    }
    const phoneMatches = filterGuestCandidates(
      deduplicateContacts(phoneContacts),
      guest,
      fields,
      "phone",
      env
    );
    if (phoneMatches.length) return phoneMatches;
  }

  const nameQuery = normalizedGuestNameQuery(guest);
  const nameContacts = await searchAndHydrateContacts(env, nameQuery, "name");
  return filterGuestCandidates(nameContacts, guest, fields, "name", env);
}

/**
 * Current GHL search first; the documented legacy query endpoint is retained
 * as a compatibility fallback because some locations return no records for
 * the advanced endpoint's free-text query.
 */
async function searchAndHydrateContacts(env, query, strategy) {
  let contacts = [];
  let advancedFailed = false;

  try {
    const result = await ghlRequest(env, "/contacts/search", {
      method: "POST",
      debugSearchStrategy: strategy,
      body: JSON.stringify({
        locationId: env.GHL_LOCATION_ID,
        page: 1,
        pageLimit: 100,
        query,
        sort: [{ field: "dateAdded", direction: "desc" }]
      })
    });
    contacts = extractContacts(result);
    debugSearchCandidates(env, strategy, "advanced", contacts);
  } catch (error) {
    if (!(error instanceof GhlApiError) || ![400, 404, 422].includes(error.status)) {
      throw error;
    }
    advancedFailed = true;
    debugLog(env, "ghl_search_fallback", { strategy, advancedStatus: error.status });
  }

  if (
    contacts.length === 0 ||
    advancedFailed ||
    !hasPlausibleSearchMatch(contacts, query, strategy)
  ) {
    const params = new URLSearchParams({
      locationId: env.GHL_LOCATION_ID,
      query,
      limit: "100"
    });
    const result = await ghlRequest(env, `/contacts/?${params.toString()}`, {
      method: "GET",
      debugSearchStrategy: `${strategy}_legacy`
    });
    const legacyContacts = extractContacts(result);
    debugSearchCandidates(env, strategy, "legacy", legacyContacts);
    contacts = deduplicateContacts([...contacts, ...legacyContacts]);
  }

  return hydrateContacts(env, contacts);
}

async function getBoundedLocationContactSample(env) {
  let contacts = [];

  try {
    const result = await ghlRequest(env, "/contacts/search", {
      method: "POST",
      debugSearchStrategy: "wedding_data_sample",
      body: JSON.stringify({
        locationId: env.GHL_LOCATION_ID,
        page: 1,
        pageLimit: WEDDING_DATA_SAMPLE_LIMIT,
        filters: [],
        sort: [{ field: "dateAdded", direction: "desc" }]
      })
    });
    contacts = extractContacts(result);
  } catch (error) {
    if (!(error instanceof GhlApiError) || ![400, 404, 422].includes(error.status)) {
      throw error;
    }
    debugLog(env, "wedding_data_sample_fallback", { advancedStatus: error.status });
  }

  if (contacts.length === 0) {
    const params = new URLSearchParams({
      locationId: env.GHL_LOCATION_ID,
      limit: String(WEDDING_DATA_SAMPLE_LIMIT)
    });
    const result = await ghlRequest(env, `/contacts/?${params.toString()}`, {
      method: "GET",
      debugSearchStrategy: "wedding_data_sample_legacy"
    });
    contacts = extractContacts(result);
  }

  return hydrateContacts(env, contacts, WEDDING_DATA_SAMPLE_LIMIT);
}

function hasPlausibleSearchMatch(contacts, query, strategy) {
  if (
    strategy === "email" ||
    strategy === "debug_email" ||
    strategy === "debug_contact_shape"
  ) {
    return contacts.some(
      (contact) => normalizeEmail(contact.email) === normalizeEmail(query)
    );
  }
  if (strategy === "phone") {
    return contacts.some((contact) => phonesEquivalent(contact.phone, query));
  }
  const normalizedQuery = normalizeName(query);
  return contacts.some((contact) => {
    const fullName = contact.name || `${contact.firstName || ""} ${contact.lastName || ""}`;
    return normalizeName(fullName) === normalizedQuery;
  });
}

async function hydrateContacts(env, contacts, limit = MAX_CONTACTS_TO_HYDRATE) {
  const unique = deduplicateContacts(contacts).slice(0, limit);
  const hydrated = [];

  for (let index = 0; index < unique.length; index += CONTACT_HYDRATION_CONCURRENCY) {
    const batch = unique.slice(index, index + CONTACT_HYDRATION_CONCURRENCY);
    const results = await Promise.all(batch.map((summary) => hydrateContact(env, summary)));
    hydrated.push(...results);
  }

  return hydrated;
}

async function hydrateContact(env, summary) {
  if (!summary?.id) return summary;

  try {
    const detail = await ghlRequest(
      env,
      `/contacts/${encodeURIComponent(summary.id)}`,
      { method: "GET" }
    );
    const contact = detail.contact || detail.data?.contact || detail;
    return {
      ...summary,
      ...contact,
      customFields:
        contact.customFields ??
        contact.customFieldValues ??
        summary.customFields ??
        summary.customFieldValues ??
        []
    };
  } catch (error) {
    // A usable search record is better than discarding the candidate when
    // a location's contact-detail endpoint is temporarily inconsistent.
    if (error instanceof GhlApiError && [404, 422].includes(error.status)) {
      debugLog(env, "contact_hydration_skipped", { contactIdPresent: true, status: error.status });
      return summary;
    }
    throw error;
  }
}

function contactBelongsToConfiguredWedding(contact, weddingField, env) {
  const contactLocationId = cleanText(
    contact?.locationId ?? contact?.location_id,
    MAX_CONTACT_ID_LENGTH
  );
  const expectedLocationId = cleanText(env.GHL_LOCATION_ID, MAX_CONTACT_ID_LENGTH);
  if (contactLocationId && contactLocationId !== expectedLocationId) return false;

  const weddingValue = getCustomFieldValue(contact, weddingField);
  return (
    hasDetectedValue(weddingValue) &&
    normalizeIdentifier(weddingValue) === normalizeIdentifier(env.WEDDING_ID)
  );
}

function guestDisplayName(contact) {
  const firstName = cleanText(contact?.firstName, 80);
  const lastName = cleanText(contact?.lastName, 80);
  return cleanText(`${firstName} ${lastName}`, 160) || cleanText(contact?.name, 160);
}

function publicTableNumber(value) {
  if (Array.isArray(value)) {
    return value.length === 1 ? publicTableNumber(value[0]) : "";
  }
  if (typeof value !== "string" && typeof value !== "number") return "";
  return cleanText(value, 40);
}

function filterGuestCandidates(contacts, guest, fields, strategy, env) {
  const weddingField = fields.byName["Wedding ID"];
  const expectedWeddingId = normalizeIdentifier(guest.weddingId);
  const normalizedFirstName = normalizeName(guest.firstName);
  const normalizedLastName = normalizeName(guest.lastName);
  const normalizedFullName = normalizeName(normalizedGuestNameQuery(guest));

  const matches = contacts.filter((contact) => {
    // Search summaries do not always repeat locationId. Reject only an
    // explicit different location, never an omitted location.
    const locationMatches = !contact.locationId || contact.locationId === env.GHL_LOCATION_ID;
    const contactFirstName = normalizeName(contact.firstName);
    const contactLastName = normalizeName(contact.lastName);
    const contactFullName = normalizedContactFullName(contact);
    const nameMatches = normalizedLastName
      ? contactFirstName === normalizedFirstName && contactLastName === normalizedLastName
      : contactFirstName === normalizedFirstName ||
        contactLastName === normalizedFirstName ||
        contactFullName === normalizedFullName;
    const emailMatches = !guest.email || normalizeEmail(contact.email) === normalizeEmail(guest.email);
    const phoneMatches = !guest.phone || phonesEquivalent(contact.phone, guest.phone);
    const weddingValue = getCustomFieldValue(contact, weddingField);
    const weddingIdPresent = weddingValue != null && String(weddingValue).trim() !== "";
    const weddingIdMatches =
      weddingIdPresent &&
      normalizeIdentifier(weddingValue) === expectedWeddingId;

    debugLog(env, "candidate_match", {
      strategy,
      firstName: cleanText(contact.firstName, 80),
      lastName: cleanText(contact.lastName, 80),
      email: normalizeEmail(contact.email),
      weddingIdPresent,
      weddingIdMatched: weddingIdMatches
    });

    const strategyIdentityMatches =
      strategy === "email"
        ? emailMatches
        : strategy === "phone"
          ? phoneMatches
          : true;

    return (
      locationMatches &&
      nameMatches &&
      strategyIdentityMatches &&
      weddingIdMatches
    );
  });

  const uniqueMatches = deduplicateContacts(matches);
  if (normalizedLastName) return uniqueMatches;

  // A free-form value such as "Aunt Ha" is stronger than a match against
  // only one name field. If it resolves to a full name, discard weaker
  // first-name or last-name matches before email/phone disambiguation.
  const exactFullNameMatches = uniqueMatches.filter(
    (contact) => normalizedContactFullName(contact) === normalizedFullName
  );
  return exactFullNameMatches.length ? exactFullNameMatches : uniqueMatches;
}

function normalizedGuestNameQuery(guest) {
  return cleanText(`${guest.firstName || ""} ${guest.lastName || ""}`, 160);
}

function normalizedContactFullName(contact) {
  const fieldName = cleanText(
    `${contact?.firstName || ""} ${contact?.lastName || ""}`,
    160
  );
  return normalizeName(fieldName || contact?.name);
}

function extractContacts(result) {
  if (Array.isArray(result?.contacts)) return result.contacts;
  if (Array.isArray(result?.data?.contacts)) return result.data.contacts;
  if (Array.isArray(result?.items)) return result.items;
  if (result?.contact && typeof result.contact === "object") return [result.contact];
  if (result?.data?.contact && typeof result.data.contact === "object") return [result.data.contact];
  return [];
}

function deduplicateContacts(contacts) {
  const byIdentity = new Map();
  for (const contact of contacts) {
    if (!contact || typeof contact !== "object") continue;
    const key = contact.id || [
      normalizeEmail(contact.email),
      normalizePhone(contact.phone),
      normalizeName(contact.firstName),
      normalizeName(contact.lastName)
    ].join("|");
    if (!byIdentity.has(key)) byIdentity.set(key, contact);
  }
  return [...byIdentity.values()];
}

function debugSearchCandidates(env, strategy, endpoint, contacts) {
  debugLog(env, "ghl_search_results", {
    strategy,
    endpoint,
    contactsReturned: contacts.length,
    candidates: contacts.slice(0, MAX_CONTACTS_TO_HYDRATE).map(safeCandidateIdentity)
  });
}

function disambiguateByEmailOrPhone(contacts, guest) {
  if (contacts.length === 1) {
    return { status: "matched", contact: contacts[0] };
  }

  const email = normalizeEmail(guest.email);
  const phone = normalizePhone(guest.phone);
  if (!email && !phone) return { status: "multiple_matches" };

  const narrowed = contacts.filter((contact) => {
    const emailMatches = email && normalizeEmail(contact.email) === email;
    const contactPhone = normalizePhone(contact.phone);
    const phoneMatches = phone && (
      contactPhone === phone ||
      (phone.length >= 8 && contactPhone.endsWith(phone.slice(-8)))
    );
    return Boolean(emailMatches || phoneMatches);
  });

  if (narrowed.length === 1) {
    return { status: "matched", contact: narrowed[0] };
  }
  return { status: narrowed.length > 1 ? "multiple_matches" : "not_found" };
}

async function updateGhlContact(env, contactId, guest, fields) {
  const values = [
    ["RSVP Status", guest.attending === "yes" ? "Attending" : "Declined"],
    ["Dietary Requirement", guest.dietaryRequirement],
    ["Dietary Notes", guest.dietaryNotes],
    ["Dietary Submitted", "Yes"]
  ];

  await ghlRequest(env, `/contacts/${encodeURIComponent(contactId)}`, {
    method: "PUT",
    body: JSON.stringify({
      customFields: values.map(([name, fieldValue]) => ({
        id: fields.byName[name].id,
        fieldValue
      }))
    })
  });
}

function getTableAndSeat(contact, fields) {
  const tableNumber = getCustomFieldValue(contact, fields.byName["Table Number"]);
  const seatNumber = getCustomFieldValue(contact, fields.byName["Seat Number"]);

  return {
    tableNumber: tableNumber == null || tableNumber === "" ? null : String(tableNumber),
    seatNumber: seatNumber == null || seatNumber === "" ? null : String(seatNumber)
  };
}

function getCustomFieldValue(contact, fieldDefinition) {
  if (!contact || !fieldDefinition) return null;

  const fieldId = typeof fieldDefinition === "string"
    ? fieldDefinition
    : fieldDefinition.id;
  const fieldKey = typeof fieldDefinition === "object"
    ? fieldDefinition.fieldKey
    : null;
  const containers = [
    contact.customFields,
    contact.customFieldValues,
    contact.custom_fields
  ].filter(Boolean);

  for (const container of containers) {
    if (Array.isArray(container)) {
      const field = container.find((item) => {
        if (!item || typeof item !== "object") return false;
        const identifier = item.id ?? item._id ?? item.fieldId ?? item.key ?? item.fieldKey;
        return identifier === fieldId || (fieldKey && identifier === fieldKey);
      });
      if (field) return unwrapCustomFieldValue(field);
      continue;
    }

    if (typeof container === "object") {
      if (fieldId && Object.prototype.hasOwnProperty.call(container, fieldId)) {
        return unwrapCustomFieldValue(container[fieldId]);
      }
      if (fieldKey && Object.prototype.hasOwnProperty.call(container, fieldKey)) {
        return unwrapCustomFieldValue(container[fieldKey]);
      }

      const field = Object.values(container).find((item) => {
        if (!item || typeof item !== "object") return false;
        const identifier = item.id ?? item._id ?? item.fieldId ?? item.key ?? item.fieldKey;
        return identifier === fieldId || (fieldKey && identifier === fieldKey);
      });
      if (field) return unwrapCustomFieldValue(field);
    }
  }

  return null;
}

function unwrapCustomFieldValue(field) {
  if (field == null || typeof field !== "object") return field;
  return (
    field.fieldValue ??
    field.field_value ??
    field.value ??
    field.values ??
    null
  );
}

function debugFieldSummary(contact, displayName, fields) {
  const fieldDefinition = fields.byName[displayName];
  const value = getCustomFieldValue(contact, fieldDefinition);
  const valueDetected = hasDetectedValue(value);
  const previewSafe = displayName !== "Dietary Notes";

  return {
    displayName,
    fieldIdResolved: Boolean(fieldDefinition?.id),
    valueDetected,
    valuePreview: valueDetected && previewSafe ? safeValuePreview(value) : null,
    valuePreviewRedacted: valueDetected && !previewSafe
  };
}

function hasDetectedValue(value) {
  if (value == null) return false;
  if (Array.isArray(value)) return value.some(hasDetectedValue);
  if (typeof value === "string") return value.trim() !== "";
  return true;
}

function safeValuePreview(value) {
  if (Array.isArray(value)) {
    return value.map((item) => cleanText(item, 40)).filter(Boolean).join(", ").slice(0, 80);
  }
  if (typeof value === "object") return "[complex value detected]";
  return cleanText(value, 80);
}

function countMissingField(contacts, fieldDefinition) {
  return contacts.filter(
    (contact) => !hasDetectedValue(getCustomFieldValue(contact, fieldDefinition))
  ).length;
}

function buildWeddingDataWarnings(metrics) {
  const warnings = [];

  if (metrics.sampleCount === 0) {
    warnings.push("No contacts were available in the bounded location sample.");
    return warnings;
  }
  if (metrics.sampleCount >= WEDDING_DATA_SAMPLE_LIMIT) {
    warnings.push(
      `Results are limited to the ${WEDDING_DATA_SAMPLE_LIMIT} most recent contacts in this location.`
    );
  }
  if (metrics.contactsFound === 0) {
    warnings.push("No sampled contacts matched this Wedding ID.");
  }
  if (metrics.numberMissingWeddingId > 0) {
    warnings.push(
      `${metrics.numberMissingWeddingId} sampled contact(s) have no Wedding ID and should be reviewed.`
    );
  }
  if (metrics.numberMissingTableNumber > 0) {
    warnings.push(
      `${metrics.numberMissingTableNumber} matching contact(s) are missing the required Table Number.`
    );
  }
  if (metrics.numberMissingSeatNumber > 0) {
    warnings.push(
      `${metrics.numberMissingSeatNumber} matching contact(s) have no Seat Number; this is allowed because the public RSVP experience is table-only.`
    );
  }
  if (metrics.numberMissingEmail > 0) {
    warnings.push(
      `${metrics.numberMissingEmail} matching contact(s) have no email, reducing duplicate-name matching options.`
    );
  }
  if (metrics.numberMissingPhone > 0) {
    warnings.push(
      `${metrics.numberMissingPhone} matching contact(s) have no phone, reducing duplicate-name matching options.`
    );
  }

  return warnings;
}

/**
 * Central GHL request helper. The token stays in the Worker secret and is sent
 * as a Bearer token. Known API failures become typed errors without retaining
 * or returning response bodies that might include contact data.
 */
async function ghlRequest(env, path, options, attempt = 0) {
  const { debugSearchStrategy, ...fetchOptions } = options;
  const response = await fetch(`${normalizedApiBase(env.GHL_API_BASE)}${path}`, {
    ...fetchOptions,
    headers: {
      "Authorization": `Bearer ${env.GHL_PRIVATE_INTEGRATION_TOKEN}`,
      "Accept": "application/json",
      "Content-Type": "application/json",
      "Version": env.GHL_API_VERSION,
      ...(fetchOptions.headers || {})
    }
  });

  if (debugSearchStrategy) {
    debugLog(env, "ghl_search_response", {
      strategy: debugSearchStrategy,
      status: response.status
    });
  }

  if (response.status === 429 && attempt === 0) {
    const retryAfterSeconds = Number(response.headers.get("retry-after") || 1);
    await delay(Math.min(Math.max(retryAfterSeconds, 1), 2) * 1000);
    return ghlRequest(env, path, options, 1);
  }

  if (!response.ok) {
    throw new GhlApiError(response.status);
  }

  if (response.status === 204) return {};
  try {
    return await response.json();
  } catch {
    throw new GhlApiError(502, "invalid_json");
  }
}

async function readJsonBody(request) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_BODY_BYTES) {
    return { ok: false, httpStatus: 413, message: "The RSVP request was too large." };
  }
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    return { ok: false, httpStatus: 415, message: "Expected a JSON request." };
  }

  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
      return { ok: false, httpStatus: 413, message: "The RSVP request was too large." };
    }
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, httpStatus: 400, message: "The RSVP details were not valid." };
  }
}

function validateAndNormalizeInput(raw, env) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, message: "Please provide your RSVP details." };
  }

  const firstName = cleanText(raw.firstName, 80);
  const lastName = cleanText(raw.lastName, 80);
  const email = cleanText(raw.email, 254).toLowerCase();
  const phone = cleanText(raw.phone, 40);
  const weddingId = cleanText(raw.weddingId, 100);
  const attending = normaliseAttendance(raw.attending);
  const dietaryRequirement = cleanText(raw.dietaryRequirement, 100) || "No dietary requirements";
  const dietaryNotes = cleanText(raw.dietaryNotes, 500);

  if (!firstName) {
    return { ok: false, message: "First name is required." };
  }
  if (!attending) {
    return { ok: false, message: "Please select whether you are attending." };
  }
  if (weddingId !== env.WEDDING_ID) {
    return { ok: false, message: "This invitation is not recognised." };
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, message: "Please check the email address." };
  }
  if (!ALLOWED_DIETARY_REQUIREMENTS.has(dietaryRequirement)) {
    return { ok: false, message: "Please select a listed dietary requirement." };
  }
  if (dietaryRequirement === "Other" && !dietaryNotes) {
    return { ok: false, message: "Please specify the dietary requirement." };
  }

  return {
    ok: true,
    value: {
      firstName,
      lastName,
      email,
      phone,
      attending,
      weddingId,
      dietaryRequirement,
      dietaryNotes
    }
  };
}

/**
 * Convert the front-end's canonical yes/no strings and reasonable legacy
 * variants into one internal representation. Null means genuinely unknown.
 */
function normaliseAttendance(value) {
  if (value === true) return "yes";
  if (value === false) return "no";
  if (typeof value !== "string") return null;

  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  const attendingValues = new Set([
    "yes",
    "true",
    "1",
    "accept",
    "accepts",
    "accepted",
    "attending",
    "joyfully_accepts"
  ]);

  const decliningValues = new Set([
    "no",
    "false",
    "0",
    "decline",
    "declines",
    "declined",
    "not_attending",
    "regretfully_declines"
  ]);

  if (attendingValues.has(normalized)) return "yes";
  if (decliningValues.has(normalized)) return "no";
  return null;
}

function healthErrorDetails(error) {
  if (error instanceof GhlApiError) {
    if (error.status === 400) {
      return { status: "request_rejected", message: "GHL rejected the field-list request. Check the Location ID and API Version." };
    }
    if (error.status === 401) {
      return { status: "authentication_failed", message: "GHL rejected the Private Integration Token or its scopes." };
    }
    if (error.status === 422) {
      return { status: "unprocessable_request", message: "GHL could not process the field-list request. Check the Location ID and API Version." };
    }
    if (error.status === 429) {
      return { status: "rate_limited", message: "GHL is rate limiting this Worker. Wait briefly and retry." };
    }
    return { status: "ghl_unavailable", message: "GHL did not return a usable response." };
  }
  return { status: "worker_error", message: "The Worker could not complete its integration check." };
}

function guestSafeServiceMessage(error) {
  if (error instanceof GhlApiError && error.status === 429) {
    return "Our RSVP concierge is receiving a lot of replies just now. Please wait a moment and try again.";
  }
  return "We couldn’t save your RSVP just now. Please try again shortly, or contact the couple if the problem continues.";
}

function guestSafeHttpStatus(error) {
  if (error instanceof GhlApiError && error.status === 429) return 503;
  if (error instanceof IntegrationConfigurationError) return 503;
  return 502;
}

function lookupSafeHttpStatus(error) {
  if (error instanceof GhlApiError && error.status === 429) return 503;
  if (error instanceof IntegrationConfigurationError) return 503;
  if (error instanceof SeatingDirectoryError) return 503;
  return 502;
}

function lookupError(code, message, httpStatus, cors) {
  return json({ success: false, code, message }, httpStatus, cors);
}

function safeErrorLabel(error) {
  if (error instanceof GhlApiError) return `GHL_${error.status}_${error.reason}`;
  if (error instanceof IntegrationConfigurationError) return "INTEGRATION_CONFIGURATION";
  if (error instanceof SeatingDirectoryError) {
    return `SEATING_DIRECTORY_${error.reason}`;
  }
  return "UNEXPECTED_WORKER_ERROR";
}

class GhlApiError extends Error {
  constructor(status, reason = "request_failed") {
    super(`GHL API request failed (${status}).`);
    this.name = "GhlApiError";
    this.status = status;
    this.reason = reason;
  }
}

class IntegrationConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "IntegrationConfigurationError";
  }
}

class SeatingDirectoryError extends Error {
  constructor(reason) {
    super("The seating directory is unavailable.");
    this.name = "SeatingDirectoryError";
    this.reason = String(reason || "unknown").toUpperCase();
  }
}

function missingEnvironmentVariables(env) {
  return REQUIRED_ENVIRONMENT.filter((key) => !String(env[key] || "").trim());
}

function assertEnvironment(env) {
  const missing = missingEnvironmentVariables(env);
  if (missing.length) {
    throw new IntegrationConfigurationError(`Missing Worker variables: ${missing.join(", ")}`);
  }
}

function cleanText(value, maxLength) {
  if (value == null) return "";
  return String(value).trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function normalizeName(value) {
  return cleanText(value, 100).toLocaleLowerCase("en-AU").normalize("NFKC");
}

function normalizeLookupText(value) {
  return cleanText(value, 160)
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase("en-AU");
}

function normalizeContactId(value) {
  if (typeof value !== "string") return "";
  const contactId = value.trim();
  if (
    !contactId ||
    contactId.length > MAX_CONTACT_ID_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(contactId)
  ) {
    return "";
  }
  return contactId;
}

function normalizeEmail(value) {
  return cleanText(value, 254).toLowerCase();
}

function normalizePhone(value) {
  return cleanText(value, 40).replace(/\D/g, "").replace(/^00/, "");
}

function phoneSearchTerms(value) {
  const raw = cleanText(value, 40);
  const digits = normalizePhone(value);
  const terms = new Set([raw, digits]);

  if (digits) terms.add(`+${digits}`);
  if (digits.startsWith("61") && digits.length >= 10) {
    terms.add(`0${digits.slice(2)}`);
    terms.add(digits.slice(2));
  } else if (digits.startsWith("0") && digits.length >= 9) {
    terms.add(`61${digits.slice(1)}`);
    terms.add(`+61${digits.slice(1)}`);
  }

  return [...terms].filter(Boolean);
}

function phonesEquivalent(left, right) {
  const leftVariants = phoneComparisonVariants(left);
  const rightVariants = phoneComparisonVariants(right);
  if (!leftVariants.size || !rightVariants.size) return false;

  for (const value of leftVariants) {
    if (rightVariants.has(value)) return true;
  }

  const leftDigits = normalizePhone(left);
  const rightDigits = normalizePhone(right);
  return (
    leftDigits.length >= 8 &&
    rightDigits.length >= 8 &&
    leftDigits.slice(-8) === rightDigits.slice(-8)
  );
}

function phoneComparisonVariants(value) {
  let digits = normalizePhone(value);
  if (digits.startsWith("610")) digits = `61${digits.slice(3)}`;
  const variants = new Set();
  if (!digits) return variants;

  variants.add(digits);
  if (digits.startsWith("61") && digits.length >= 10) {
    variants.add(digits.slice(2));
    variants.add(`0${digits.slice(2)}`);
  } else if (digits.startsWith("0") && digits.length >= 9) {
    variants.add(digits.slice(1));
    variants.add(`61${digits.slice(1)}`);
  }
  return variants;
}

function normalizeIdentifier(value) {
  return cleanText(value, 120).toLowerCase();
}

function normalizeFieldName(value) {
  return cleanText(value, 120).toLowerCase();
}

function safeCandidateIdentity(contact) {
  return {
    firstName: cleanText(contact?.firstName, 80),
    lastName: cleanText(contact?.lastName, 80),
    email: normalizeEmail(contact?.email)
  };
}

function debugLog(env, event, details) {
  if (!env.DEBUG_KEY) return;
  console.log(`[wedding-rsvp:${event}]`, JSON.stringify(details));
}

function normalizedApiBase(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function debugAccessError(request, url, env, cors) {
  if (!env.DEBUG_KEY) {
    return json({ success: false, status: "not_found", message: "Not found." }, 404, cors);
  }
  if (!isAllowedOrigin(request, env)) {
    return json({ success: false, status: "forbidden", message: "Origin not allowed." }, 403, cors);
  }
  if (url.searchParams.get("debugKey") !== env.DEBUG_KEY) {
    return json({ success: false, status: "forbidden", message: "Invalid debug key." }, 403, cors);
  }
  return null;
}

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGIN || "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

function isAllowedOrigin(request, env) {
  const origin = request.headers.get("origin");
  if (!origin) return true; // Allows curl/monitoring; browsers still enforce CORS.
  return allowedOrigins(env).includes(origin.replace(/\/$/, ""));
}

function corsHeaders(request, env) {
  const origin = request.headers.get("origin");
  const headers = {
    ...JSON_HEADERS,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };

  if (origin && isAllowedOrigin(request, env)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function json(payload, status = 200, headers = JSON_HEADERS) {
  return new Response(JSON.stringify(payload), { status, headers });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
