# Premium wedding guest landing page

A single-page wedding experience with a private RSVP and seating concierge. The guest-facing site is plain HTML, CSS and vanilla JavaScript. One Cloudflare Worker is the only backend and the only code allowed to communicate with GoHighLevel.

There is no React, npm, build command, database or front-end secret.

## Structure

```text
.
├── index.html
├── find-table.html
├── assets/
│   ├── css/
│   │   ├── style.css
│   │   └── find-table.css
│   ├── js/
│   │   ├── main.js
│   │   └── find-table.js
│   ├── images/
│   └── seating/seating-layout-final-calibrated.svg
├── worker/worker.js
├── .env.example
└── README.md
```

The real guest list remains in GHL. No guest CSV is used or published by this project.

## Preview the site

Opening `index.html` directly works for a quick visual check. Use a local
static server to test the seating map because the browser loads its SVG with
`fetch()`:

```bash
python3 -m http.server 8080
```

Then visit `http://localhost:8080`.

The top of `assets/js/main.js` contains the RSVP integration settings:

```js
const CONFIG = {
  demoMode: true,
  workerUrl: "https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev"
};
```

- `demoMode: true` uses a guest-data-free mock response and displays sample seating. It never calls GHL.
- Production requires a real `workerUrl` and `demoMode: false`.
- Production mode deliberately fails closed if the Worker URL is still a placeholder; it never silently falls back to demo data.

The form's hidden Wedding ID is `hart-brooks-2026`. It must equal the Worker's `WEDDING_ID`.

## QR Seating Lookup Page

The local page is `./find-table.html`. At the production project path it is
available at `/alice-and-michael/find-table.html`, and the wedding QR code must
point directly to:

```text
https://weddings.yourinvite.com.au/alice-and-michael/find-table.html
```

This is a read-only guest flow. It searches a minimal seating directory stored
in Cloudflare Workers KV, lets the guest select a matching name, and reveals
the assigned Table Number only as seating information. Searches match any
two-or-more-character fragment of a name (`me`, `melia`, and `ia` all match
`Amelia`) and visually mark the matching characters. It does not submit or
update RSVP status, dietary details, or any other contact data. The page uses
the same calibrated seating map as the RSVP result and never displays email,
phone, or internal seat-assignment details.

Production lookup calls use the same Worker base URL configured in
`assets/js/find-table.js` and send requests to `POST /search-guests` and
`POST /lookup-guest-table`. The QR routes read only from Cloudflare KV; they do
not call GHL for each search or selection. The main RSVP route remains directly
connected to GHL.

The protected seating sync reads GHL and atomically replaces one complete KV
snapshot containing only opaque lookup ID, display name, normalized search
name, and Table Number. It never stores email, phone, seat number, dietary
information, RSVP status, the GHL token, raw contacts, or public GHL contact
IDs. The browser never downloads the directory and writes nothing to
`localStorage`, IndexedDB, or a service worker.

GHL contacts must have the configured **Wedding ID** populated and should have
**Table Number** populated. The Worker always uses its own `WEDDING_ID`; public
requests cannot choose another wedding.

## 1. Prepare GoHighLevel

### Required contact custom fields

In the correct GHL sub-account, create these **Contact** custom fields with the display names written exactly as shown:

| Display name | Suggested type | Example |
|---|---|---|
| Wedding ID | Single line text | `hart-brooks-2026` |
| RSVP Status | Single line text or dropdown | `Attending`, `Declined` |
| Dietary Requirement | Single line text or dropdown | `Vegetarian` |
| Dietary Notes | Multi-line text | `Severe peanut allergy` |
| Dietary Submitted | Single line text or dropdown | `Yes` |
| Table Number | Single line text | `8` |
| Seat Number | Single line text | `4` |

No field IDs need to be copied into code. The Worker:

1. calls `GET /locations/:locationId/customFields?model=contact`;
2. resolves the seven fields by display name;
3. caches the name-to-ID mapping in memory for five minutes;
4. reports missing field names through `/health`.

For every imported guest contact, verify:

- `firstName` and `lastName` match the invitation spelling;
- **Wedding ID** is `hart-brooks-2026`;
- Table Number is populated for guests who should receive seating;
- duplicate names have a distinct email or phone.

### Client CSV requirements

Keep the client CSV private. Never add it to this repository or the public
GitHub Pages deployment.

**Required columns**

| CSV field | Why it is required |
|---|---|
| First Name | Primary guest matching |
| Last Name | Primary guest matching |
| Wedding ID | Keeps weddings separated within a shared GHL location |
| Table Number | Required seating assignment for attending guests |

**Recommended columns**

| CSV field | Why it is recommended |
|---|---|
| Email | Best duplicate-name disambiguation field |
| Phone | Fallback duplicate-name disambiguation field |
| Seat Number | Optional internal planning data; retained in GHL but never shown or returned publicly |

**Columns that may be blank before RSVPs open**

- RSVP Status
- Dietary Requirement
- Dietary Notes
- Dietary Submitted

Before import:

- export as UTF-8 CSV with one guest per row;
- trim leading/trailing spaces from names, email, Wedding ID and seating values;
- use one exact Wedding ID value for the whole client list;
- keep phone country codes where available;
- check duplicate names have an email or phone;
- remove blank rows, merged headings, formulas and explanatory notes;
- confirm every attending guest has a Table Number.

During import, map standard fields to GHL `firstName`, `lastName`, `email` and
`phone`, and map every wedding column to the matching **Contact** custom field.
Do not map wedding fields to Opportunity fields or similarly named custom
values.

### Create a Private Integration Token

In HighLevel:

1. Open **Settings → Private Integrations** at agency or sub-account level.
2. Create a new integration for the wedding RSVP Worker.
3. Limit it to the correct sub-account.
4. Grant only these scopes:

   - `contacts.readonly` — search/read matching contacts;
   - `contacts.write` — update RSVP and dietary custom fields;
   - `locations/customFields.readonly` — resolve field IDs by display name.

5. Create the token and copy it immediately. HighLevel only shows the generated value once.
6. Store it only as the Cloudflare secret `GHL_PRIVATE_INTEGRATION_TOKEN`.

HighLevel's [Private Integrations documentation](https://marketplace.gohighlevel.com/docs/Authorization/PrivateIntegrationsToken/) confirms that Private Integration Tokens are fixed, scoped access tokens sent as `Authorization: Bearer <token>`. The endpoint-to-scope mapping is in HighLevel's [official scopes reference](https://marketplace.gohighlevel.com/docs/Authorization/Scopes/).

### Find the Location ID

Open the sub-account that contains the imported contacts. The browser URL normally contains:

```text
/v2/location/LOCATION_ID/...
```

Copy the value immediately after `/location/`. In many accounts the same identifier is also visible under **Settings → Business Profile**. This is the sub-account/location ID, not the agency/company ID.

## 2. Configure and deploy the Cloudflare Worker

The Worker is the single file at `worker/worker.js`; no local package or build setup is required.

1. In Cloudflare, open **Workers & Pages → Create → Worker**.
2. Give it a name such as `wedding-rsvp`.
3. Open the code editor and replace the starter code with `worker/worker.js`.
4. Deploy it once.
5. Open the Worker **Settings → Variables and Secrets**.
6. Add `GHL_PRIVATE_INTEGRATION_TOKEN` as a **Secret**, not plaintext.
7. Add the remaining values as normal variables.

Use `.env.example` as the name checklist:

| Name | Type | Value |
|---|---|---|
| `GHL_PRIVATE_INTEGRATION_TOKEN` | Secret | Your real sub-account Private Integration Token |
| `GHL_LOCATION_ID` | Variable | The sub-account ID containing the contacts |
| `GHL_API_BASE` | Variable | `https://services.leadconnectorhq.com` |
| `GHL_API_VERSION` | Variable | `2021-07-28` for the documented integration endpoints used here |
| `WEDDING_ID` | Variable | `hart-brooks-2026` |
| `ALLOWED_ORIGIN` | Variable | Exact public origin: `https://weddings.yourinvite.com.au` |
| `DEBUG_KEY` | Optional secret | Long random value enabling protected lookup diagnostics |
| `SEATING_SYNC_KEY` | Secret | Long random value protecting the seating sync route |
| `SEATING_LOOKUP_ID_SECRET` | Secret | A different random value used to create opaque lookup IDs |
| `SEATING_LOOKUP` | KV binding | The Workers KV namespace containing the minimal seating directory |

`ALLOWED_ORIGIN` accepts comma-separated origins if both a preview and custom domain are needed:

```text
https://weddings.yourinvite.com.au,https://preview.example.com
```

Do not include a path or trailing slash. Redeploy after adding variables.

When `DEBUG_KEY` is configured, the Worker enables safe development logs and
the protected debug routes. Remove the secret after troubleshooting to disable
them. Debug output never includes the GHL token, field IDs or raw contact
payloads.

HighLevel's API is endpoint-versioned. The Worker sends `GHL_API_VERSION` as the `Version` header on every request, and `.env.example` starts with the version used by HighLevel's Private Integration examples. If the API tester for this sub-account explicitly requires a newer documented version, update this one Worker variable—never the front end.

### Configure the fast seating directory

The QR lookup requires a Workers KV namespace. This is separate from the GHL
integration used by the main RSVP form.

1. In Cloudflare, open **Storage & Databases → Workers KV** and create a
   namespace such as `wedding-seating-lookup`.
2. Open the existing Worker, then **Settings → Bindings → Add binding → KV
   namespace**.
3. Set the variable name to `SEATING_LOOKUP` and choose the namespace.
4. Add `SEATING_SYNC_KEY` and `SEATING_LOOKUP_ID_SECRET` as two different
   secrets. Each should be at least 24 characters. For example, generate each
   separately with `openssl rand -hex 32`.
5. Deploy the current `worker/worker.js`.
6. Run the initial protected sync:

```bash
curl -X POST \
  'https://wedding-rsvp-worker.andrew-94e.workers.dev/admin/sync-seating-lookup' \
  -H 'Authorization: Bearer YOUR_SEATING_SYNC_KEY'
```

The response reports counts and a timestamp only. It never returns guest
records. A sync builds and validates the complete snapshot before its single KV
write, so a failed refresh preserves the last working directory.

Run the sync after changing Wedding ID, guest names, or table assignments and
again before guests arrive. The Worker also includes an optional scheduled
handler; adding a Cloudflare Cron Trigger will refresh through the same safe
sync process automatically. Workers KV is eventually consistent, so allow
about 60 seconds for a new snapshot to become visible everywhere.

The public page warms the Worker and KV snapshot while it loads, before a guest
starts typing. A cold name search is therefore one edge lookup rather than a
live GHL search. Consider a Cloudflare rate-limiting rule for the two public QR
POST routes if the URL will be widely shared; do not use `ALLOWED_ORIGIN` as an
authentication mechanism.

### Check `/health`

Visit:

```text
https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/health
```

A ready integration returns HTTP 200 with:

```json
{
  "success": true,
  "status": "ok",
  "configured": true,
  "worker": "running",
  "checks": {
    "environment": { "passed": true, "missingVariables": [] },
    "token": { "present": true },
    "location": { "idPresent": true }
  },
  "integration": {
    "apiResponded": true,
    "authenticated": true,
    "customFields": {
      "allResolved": true,
      "requiredCount": 7,
      "resolvedCount": 7,
      "missing": []
    }
  }
}
```

`/health` bypasses the five-minute field cache so launch checks use the current
GHL configuration. If configuration is incomplete, it names missing Worker
variables or missing custom-field display names. It never returns environment
values, the token, contact data, field IDs or raw GHL responses.

Common health states:

- `missing_worker_variables` — add the listed Cloudflare variables.
- `authentication_failed` — check the token, sub-account and three scopes.
- `missing_custom_fields` — create or rename the listed Contact fields.
- `request_rejected` / `unprocessable_request` — check Location ID and API Version.
- `rate_limited` — wait briefly and retry.

### Protected preflight diagnostics

All debug routes require the `DEBUG_KEY` secret and the matching `debugKey`
query parameter.

Check one known guest's hydrated contact shape:

```text
https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/debug-contact-shape?email=amelia.hart%40example.com&debugKey=YOUR_DEBUG_KEY
```

This returns the contact's standard matching fields plus one safe diagnostic
entry for each required custom field:

- display name;
- whether its ID resolved;
- whether a value was detected;
- a short value preview when safe.

Dietary Notes are detected but never previewed.

Check a bounded sample for one Wedding ID:

```text
https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/debug-wedding-data?weddingId=hart-brooks-2026&debugKey=YOUR_DEBUG_KEY
```

This checks at most 20 recent contacts in the configured location. It returns
aggregate counts only—never guest names or a guest list. `numberMissingWeddingId`
applies to the whole bounded location sample; table, seat, email and phone counts
apply only to sampled contacts matching the requested Wedding ID.

The earlier `/debug-search` route remains available for focused matching
diagnostics. Remove `DEBUG_KEY` after preflight and troubleshooting.

## 3. Connect production

In `assets/js/main.js`:

```js
demoMode: false,
workerUrl: "https://wedding-rsvp.YOUR-SUBDOMAIN.workers.dev",
```

The browser then posts only this shape to `POST /submit-rsvp`:

```json
{
  "firstName": "Sarah",
  "lastName": "Nguyen",
  "email": "sarah@example.com",
  "phone": "+61400000000",
  "attending": "yes",
  "dietaryRequirement": "Gluten-free",
  "dietaryNotes": "Coeliac",
  "weddingId": "hart-brooks-2026"
}
```

The Worker searches contacts in `GHL_LOCATION_ID`, enforces exact first name, last name and Wedding ID matching, then uses email or phone only when duplicate names remain. It updates:

- RSVP Status → `Attending` or `Declined`;
- Dietary Requirement;
- Dietary Notes;
- Dietary Submitted → `Yes`.

For an attending match it returns only that contact's first name and available
Table Number. Seat Number may remain in GHL and protected diagnostics, but the
public RSVP response never includes it. For a decline it returns no seating.
Candidate contacts, guest suggestions and the guest list are never returned.

Table-only Worker response:

```json
{
  "success": true,
  "status": "matched",
  "attending": true,
  "firstName": "Sarah",
  "tableNumber": "8"
}
```

The Worker handles GHL 400, 401, 422 and rate-limit responses internally. Raw API errors are never shown to guests.

### Seating map contract

`assets/seating/seating-layout-final-calibrated.svg` is fetched and injected
inline only after a successful attending RSVP. Each semantic
`.guest-table[data-table]` group contains one `.table-highlight` shape. There
are no `.table-hit-area` elements; the calibrator and live page both use the
single highlight geometry. The live page disables hover, focus and click
behavior so only the assigned table is highlighted.

GHL **Table Number** values must match the SVG `data-table` values. For example,
GHL `8` matches:

```html
<g class="guest-table" data-table="8">…</g>
```

Values such as `Table 8` are normalized to `8` by the front end. Keep the GHL
value as the plain table number wherever possible. Before launch, complete
attending RSVPs for at least two tables in different areas of the room and
confirm the correct champagne/gold highlight appears on each.

## 4. Test with the imported sample contacts

Keep `demoMode: false` and use deliberately chosen records already in the GHL test sub-account:

1. **Unique attending guest:** set Wedding ID and Table Number; submit the exact name and confirm the table-only seating card and matching map highlight.
2. **Declining guest:** submit `No`; confirm GHL says `Declined` and the page shows no seating.
3. **Duplicate name:** use two contacts with the same first and last name and no email/phone on the first submission; confirm the form asks for one, then submit the matching contact detail.
4. **Wrong contact detail:** use the duplicate name with an email/phone belonging to neither contact; confirm the calm not-found state.
5. **No match:** use a name absent from GHL; confirm no guest names or suggestions appear.
6. **Dietary detail:** select `Other`; confirm notes are required and all three dietary fields update.
7. **Wedding boundary:** temporarily give a same-name contact a different Wedding ID; confirm it cannot match.

Check the matching contact in GHL after each submission. This Worker does not send email or SMS; any notifications belong in separate GHL workflows/automations.

## 5. Repeatable client launch checklist

1. Create or verify all seven required GHL **Contact** custom fields with exact display names.
2. Clean the private client CSV using the required/recommended rules above.
3. Import one guest per row into the correct GHL sub-account.
4. Verify every CSV column mapped to the intended standard or Contact custom field.
5. Open `/health` and require `configured: true`, `apiResponded: true`, `authenticated: true`, and seven resolved fields.
6. Add `DEBUG_KEY` temporarily and run `/debug-contact-shape` for one known guest.
7. Run `/debug-wedding-data` for the client's Wedding ID and resolve every launch-blocking warning.
8. Submit real attending RSVPs for tables in different areas of the room; confirm the GHL update, table-only response and correct map highlights.
9. Submit one decline and confirm no seating is returned.
10. Remove `DEBUG_KEY` from Cloudflare after troubleshooting and redeploy the variable change.

## 6. Deploy the static site to GitHub Pages

1. Push the project to a GitHub repository.
2. Open **Settings → Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**.
4. Choose the default branch and `/(root)`, then save.
5. Set the Worker `ALLOWED_ORIGIN` to
   `https://weddings.yourinvite.com.au` and redeploy that variable change.
6. Keep the Worker URL in `assets/js/main.js` and
   `assets/js/find-table.js` set to
   `https://wedding-rsvp-worker.andrew-94e.workers.dev`.

The production pages are:

```text
https://weddings.yourinvite.com.au/alice-and-michael/
https://weddings.yourinvite.com.au/alice-and-michael/find-table.html
```

Do not add a `CNAME` file to this wedding repository. The custom domain belongs
to the existing GitHub Pages user-site repository and is inherited by this
project site. Before publishing the QR code, confirm the user-site repository
has a valid certificate for `weddings.yourinvite.com.au`, **Enforce HTTPS** is
enabled, and neither production URL redirects back to HTTP. Local page and
asset references use explicit `./...` paths, so they continue to resolve beneath
`/alice-and-michael/` without a rebuild. See GitHub's
[official Pages publishing instructions](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)
and [HTTPS troubleshooting guide](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/troubleshooting-custom-domains-and-github-pages).

## Security checklist

- Never put a GHL token in `index.html`, `assets/js/main.js`, `.env.example` or GitHub.
- Never commit `.env`, `.dev.vars`, real contact exports or guest CSVs.
- Keep `ALLOWED_ORIGIN` exact; do not use `*`.
- Use a sub-account Private Integration Token with only the three required scopes.
- Rotate the token in HighLevel if it is ever exposed.
- Confirm `/health` is ready before switching off demo mode.
- Test duplicate names and the wrong Wedding ID before launch.

The `.gitignore` already excludes local secret files and Wrangler state while explicitly allowing the placeholder-only `.env.example`.
