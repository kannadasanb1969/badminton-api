# Owner fee reminders over the Meta WhatsApp Cloud API (Phase 8.2)

The reminder engine (who owes what, daily guard, history) is unchanged. `WHATSAPP_MODE` only chooses **how the finished reminder is delivered**.

```
Owner app -> /api/owner/reminders/* -> reminder engine -> Phase 8.1 daily guard
          -> provider (dry-run | meta) -> Meta Cloud API -> member's WhatsApp
```

## Modes

| `WHATSAPP_MODE` | Behaviour | History status |
|---|---|---|
| `dry-run` (default; `dry_run` also accepted) | Builds and records the reminder. Nothing is delivered. | `DRY_RUN` |
| `meta` | Sends an approved **template** message through the Meta Cloud API. | `SENT` (Meta accepted it and returned a message id) or `FAILED` |
| anything else | Not supported: sending is blocked. | none |

`SENT` means **Meta accepted the request and returned a message id**. It does not mean delivered or read; that needs webhooks (recommended as Phase 8.3).
If the server is not fully configured, sending is refused up front (HTTP 409, nothing recorded).

## Environment variables (names only; values are never committed, logged or returned)

| Variable | Required in `meta` mode | Secret? | Notes |
|---|---|---|---|
| `WHATSAPP_MODE` | yes | no | set to `meta` |
| `META_WHATSAPP_ACCESS_TOKEN` | yes | **YES** | newly generated token. Used only in the `Authorization` header |
| `META_WHATSAPP_PHONE_NUMBER_ID` | yes | no | the sender's **Phone Number ID** (digits), not the phone number |
| `META_WHATSAPP_TEMPLATE_NAME` | yes | no | the **approved** template's name (lower-case, digits, `_`) |
| `META_WHATSAPP_TEMPLATE_LANGUAGE` | yes | no | the template's language code, e.g. `en` or `en_US` |
| `META_WHATSAPP_GRAPH_API_VERSION` | yes | no | e.g. `v21.0` |
| `META_WHATSAPP_BUSINESS_ACCOUNT_ID` | no | no | not needed to send; reserved for template management / webhooks |
| `META_WHATSAPP_DISPLAY_PHONE_NUMBER` | no | no | the sender number as Meta shows it, digits with country code. Display/audit only |
| `WHATSAPP_SENDER_NUMBER` | dry-run only | no | ignored in `meta` mode |

Local development: put them in `badminton-api/.dev.vars` (gitignored). `npm run dev` loads that file.
Deployed Worker (later, not part of this phase): `wrangler secret put META_WHATSAPP_ACCESS_TOKEN`, and plain vars for the rest.

## Template the Owner backend fills

Create this in WhatsApp Manager -> Message templates (category **Utility**, language must equal `META_WHATSAPP_TEMPLATE_LANGUAGE`):

```
Hello {{1}}, this is a fee reminder from {{2}}. Pending fees: {{3}}. Total pending: {{4}}. Please ignore this message if payment has already been completed recently. Thank you.
```

| Variable | Content | Example |
|---|---|---|
| `{{1}}` | member name | `Kumar` |
| `{{2}}` | academy name | `Emulator Test Academy` |
| `{{3}}` | **one line**, items oldest month first, separated by `; `. Long lists are shortened to `... and N more` | `October 2026 - Morning Regular - ₹900; November 2026 - Evening Coaching - ₹1,500` |
| `{{4}}` | exact total of the remaining balances | `₹2,400` |

Positional variables, body only (no header/footer/buttons). Meta forbids newlines/tabs/4+ spaces inside a variable, so `{{3}}` is a single line.
Sample values for the approval form: the examples above.
The wording shown in the app preview is the engine's text; WhatsApp sends the template's wording with the same facts.

## Recipient number

Stored member mobiles stay 10-digit. Only at the provider boundary: `8939594019` and `+918939594019` both become `918939594019`.
An explicitly international number (`+1415...`) is kept as is. Ambiguous or invalid values are rejected, never guessed.
A Meta **test** sender can only message numbers added to its allowed recipient list in the Meta dashboard.

## Failure handling

Every failure is stored as `FAILED` with a safe code, never `SENT`, and frees the member's slot so the Owner can retry the same day:
`META_AUTH_FAILED` (401/403/code 190), `META_RATE_LIMITED` (429, 130429...), `META_SERVER_ERROR` (5xx), `META_TIMEOUT` (10 s),
`META_NETWORK_ERROR`, `META_MALFORMED_RESPONSE` (no message id), `META_RECIPIENT_NOT_ALLOWED` (131030), `META_RECIPIENT_UNREACHABLE`,
`META_TEMPLATE_NOT_FOUND` (132001), `META_TEMPLATE_PARAMS` (132000...), `META_REQUEST_REJECTED`, `INVALID_RECIPIENT`.
Provider failures never touch fees, payments or any other financial record.

## Secret handling rules

* The token is read from the environment into a private field, sent only as `Authorization: Bearer ...`, and redacted from anything that comes back from Meta.
* It is never logged, returned by an API, stored in the database, or put in an error message. Tests assert this with a sentinel token.
* A token that was ever pasted into chat, a screenshot or a commit is compromised: generate a new one.
