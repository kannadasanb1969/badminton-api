# Tournament API

The API uses the existing tournaments, tournament_categories and tournament_rules
schema. No migrations are required. GET returns camelCase tournaments with nested
categories and generalRules (an ordered string array).

Public tournament fields are startDate, registrationEndDate, venue, location and
fixtureFormat; categories return gender. Requests also accept the legacy names
tournamentDate, registrationCloseDate, venueName, venueAddress, format and
category.genderEligibility. Frontend names take precedence when both are supplied.
The schema has no endDate or registrationStartDate: these request fields are
accepted but ignored, and responses explicitly return null. They are not saved.

Migration `20260926_tournament_prize_and_fee.sql` adds registrationFee (numeric,
0 = free; legacy alias entryFee is still accepted on write), prizeType
(NONE/TROPHY/CASH/BOTH), winnerTrophyName, runnerUpTrophyName,
thirdPlaceTrophyName, winnerCashAmount, runnerUpCashAmount,
thirdPlaceCashAmount and thirdPlaceEnabled. All are nullable/defaulted so
existing rows keep loading unchanged (prizeType defaults 'NONE',
registrationFee defaults 0, thirdPlaceEnabled defaults false). Trophy/cash
fields are normalized to null server-side for any category prizeType doesn't
select, and third-place fields are normalized to null whenever
thirdPlaceEnabled is false, so a form's stale/hidden values can never persist.
The legacy free-text `prizes` column is unchanged and still returned as-is for
tournaments created before this migration; it is no longer written by new
creates/edits, which use the structured fields above instead.

Creation requires organizerId referencing an active ORGANIZER. PUT and submit
require organizerId (the owning organizer), or adminUserId (an active ADMIN).
Approve, reject and publish require adminUserId. These IDs are checked against
users but are not proof of caller identity; replacing them with authenticated
session identity is required in the later authorization phase.

Workflow: DRAFT/REJECTED -> submit -> PENDING_ADMIN_APPROVAL -> approve -> APPROVED
-> publish -> PUBLISHED. Rejection is allowed only while pending, with an optional
reason. Approving or rejecting requires a separate ADMIN. Generic PUT cannot
change workflow fields and is allowed only while DRAFT or REJECTED.

PUT categories updates entries identified by category id and appends entries
without an id. Omitted existing categories are retained to preserve stable IDs
and future references. PUT generalRules replaces the string list transactionally.
No tournament DELETE exists. Nested insert failures roll back the entire creation.

The React frontend is absent from this workspace. The API now matches the supplied
frontend field contract; multi-day tournaments, registration opening dates and fees
remain unsupported persisted data and are represented by null.
