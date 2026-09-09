# Tournament API

The API uses the existing tournaments, tournament_categories and tournament_rules
schema. No migrations are required. GET returns camelCase tournaments with nested
categories and generalRules (an ordered string array).

Public tournament fields are startDate, registrationEndDate, venue, location and
fixtureFormat; categories return gender. Requests also accept the legacy names
tournamentDate, registrationCloseDate, venueName, venueAddress, format and
category.genderEligibility. Frontend names take precedence when both are supplied.
The schema has no endDate, registrationStartDate or entryFee: these request fields
are accepted but ignored, and responses explicitly return null. They are not saved.

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
