# Q2 Friendly Frontend API Contract

## 1. Base URL

Local Worker: `http://localhost:8787` (when running the existing Wrangler dev command).

Routes are mounted under `/api/friendly-matches` in `src/index.js`.

## 2. Authentication

Protected management routes use `Authorization: Bearer <accessToken>`. The token is verified by the existing backend auth helper. `GET /api/friendly-matches` and `GET /api/friendly-matches/:id` are currently public routes.

## 3. Create Friendly Match

`POST /api/friendly-matches`

The route passes the JSON body to the service. Actual validation fields are:

```ts
interface CreateFriendlyMatchRequest {
  title: string;                 // required, non-empty
  description?: string | null;   // optional
  eventType: 'SINGLES' | 'DOUBLES';
  format: 'LEAGUE' | 'KNOCKOUT';
  maxPlayers: number;            // integer, 6..16; DOUBLES must be even and >= 8
}
```

The creator is derived from the authenticated PLAYER profile. `creatorPlayerId` is not required and is ignored if supplied by a client.

Success status: `201`.

Success envelope:

```ts
interface CreateFriendlyMatchResponse {
  success: true;
  data: FriendlyMatch;
}
```

## 4. List Friendly Matches

`GET /api/friendly-matches`

Success status: `200`.

```ts
interface FriendlyMatchListResponse {
  success: true;
  data: FriendlyMatch[];
}
```

Rows include the Friendly fields plus `participant_count`, `isCreator`, `isParticipant`, `hasPendingJoinRequest`, and `canJoin` for the authenticated player (all state fields are false when unauthenticated).

Creator display name is NOT AVAILABLE IN LIST RESPONSE.

## 5. Friendly Match Details

`GET /api/friendly-matches/:id`

Success status: `200`.

```ts
interface FriendlyMatchDetailsResponse {
  success: true;
  data: FriendlyMatch;
}
```

The details response includes the Friendly root row plus `participant_count`, `isCreator`, `isParticipant`, `hasPendingJoinRequest`, and `canJoin`. It does not include creator display identity or the participant list.

## 6. Join Friendly Match

`POST /api/friendly-matches/:id/join`

Request body: empty JSON object is sufficient; the player is derived from the Bearer identity.

Success status: `201`.

```ts
interface JoinFriendlyMatchResponse {
  success: true;
  data: {
    id: string;
    friendly_match_id: string;
    player_id: string;
    status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
    created_at: string;
    updated_at: string;
  };
}
```

The player must be an authenticated active PLAYER. Current errors include: `401` authentication required, `403` PLAYER/profile authorization, `404` Friendly match not found, `409` match not open, creator cannot join through a request, already a participant, or active request already exists.

## 7. Creator detection

A list/details row exposes `isCreator`, derived from the authenticated PLAYER profile. The frontend can use `isCreator` directly.

## 8. Join-state detection

List/details rows expose `isParticipant`, `hasPendingJoinRequest`, and `canJoin` for the authenticated PLAYER. When unauthenticated, these state fields are false.

## 9. Error responses

```ts
interface FriendlyErrorResponse {
  success: false;
  message: string;
}
```

## Q2 Friendly Frontend Batch 2 Contracts

### A. Get join requests

`GET /api/friendly-matches/:id/join-requests`

Requires an authenticated creator. Success status: `200`.

```ts
interface FriendlyJoinRequestsResponse {
  success: true;
  data: FriendlyJoinRequest[];
}

interface FriendlyJoinRequest {
  id: string;
  friendly_match_id: string;
  player_id: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  created_at: string;
  updated_at: string;
  full_name: string;
  player_code: string;
}
```

The live response does not include player mobile.

### B. Approve a join request

`POST /api/friendly-matches/:id/join-requests/:requestId/approve`

Request body is exactly:

```json
{}
```

Requires an authenticated creator. Success status: `200`.

```ts
interface ApproveFriendlyJoinRequestResponse {
  success: true;
  data: FriendlyJoinRequestDecision;
}

interface FriendlyJoinRequestDecision {
  id: string;
  friendly_match_id: string;
  player_id: string;
  status: 'APPROVED' | 'REJECTED';
  created_at: string;
  updated_at: string;
}
```

The approve response does not include `full_name`, `player_code`, or mobile.

### C. Reject a join request

`POST /api/friendly-matches/:id/join-requests/:requestId/reject`

Request body is exactly:

```json
{}
```

Requires an authenticated creator. Success status: `200`.

```ts
interface RejectFriendlyJoinRequestResponse {
  success: true;
  data: FriendlyJoinRequestDecision;
}
```

The reject response has the same fields as the approve response, with `status: 'REJECTED'`.

### D. Get participants

`GET /api/friendly-matches/:id/participants`

This route is readable without creator-management authorization. Success status: `200`.

```ts
interface FriendlyParticipantsResponse {
  success: true;
  data: FriendlyParticipant[];
}

interface FriendlyParticipant {
  id: string;
  friendly_match_id: string;
  player_id: string;
  created_at: string;
  full_name: string;
  player_code: string;
}
```

The participant response does not include a participant status field or mobile. Approved participants are represented by rows in this response.

### Batch 2 authorization and count behavior

Non-creators receive the following error envelope when attempting to approve or reject:

```json
{
  "success": false,
  "message": "Only the friendly match creator may manage it"
}
```

The HTTP status is `403`.

After approval, `participant_count` in both the list and details responses is a JSON number, and reflects the approved participant immediately.

## 10. Exact TypeScript interface suggestions

```ts
interface FriendlyMatch {
  id: string;
  friendly_match_code: string;
  title: string;
  description: string | null;
  creator_player_id: string;
  event_type: 'SINGLES' | 'DOUBLES';
  format: 'LEAGUE' | 'KNOCKOUT';
  max_players: number;
  status: 'DRAFT' | 'OPEN' | 'ACTIVE' | 'COMPLETED' | 'CLEANUP_PENDING' | 'DELETED';
  created_at: string;
  updated_at: string;
}
```

## 11. Later Q2 Friendly APIs

## Batch 3 Exact Contracts — Doubles Team Setup

### GET teams

`GET /api/friendly-matches/:id/teams`

Auth: authenticated PLAYER who is the Friendly creator.

Request body: `NO REQUEST BODY`.

Success status: `200`.

```json
{
  "success": true,
  "data": [
    {
      "id": "string",
      "friendly_match_id": "string",
      "team_code": "string",
      "created_at": "string",
      "updated_at": "string",
      "members": [
        {
          "id": "string",
          "name": "string",
          "code": "string"
        }
      ]
    }
  ]
}
```

```ts
interface FriendlyTeamsResponse {
  success: true;
  data: FriendlyTeam[];
}

interface FriendlyTeam {
  id: string;
  friendly_match_id: string;
  team_code: string;
  created_at: string;
  updated_at: string;
  members: FriendlyTeamMember[];
}

interface FriendlyTeamMember {
  id: string;
  name: string;
  code: string;
}
```

### POST teams

`POST /api/friendly-matches/:id/teams`

Auth: authenticated PLAYER who is the Friendly creator.

Request body:

```json
{
  "playerIds": ["player-id-1", "player-id-2"]
}
```

Exactly two approved, currently unpaired player IDs are required.

Success status: `201`.

Success data is the created team row:

```json
{
  "id": "string",
  "friendly_match_id": "string",
  "team_code": "string",
  "created_at": "string",
  "updated_at": "string"
}
```

Errors include status `400` with `{"success":false,"message":"Exactly two playerIds are required"}`, status `400` with `{"success":false,"message":"Both players must be approved and unpaired"}`, and status `403` with `{"success":false,"message":"Only the friendly match creator may manage it"}`.

### DELETE team

`DELETE /api/friendly-matches/:id/teams/:teamId`

Auth: authenticated PLAYER who is the Friendly creator.

Request body: `NO REQUEST BODY`.

Success status: `200`.

Success data is the deleted team row with fields `id`, `friendly_match_id`, `team_code`, `created_at`, and `updated_at`. Deleting the team also deletes its member rows; those players become unpaired and can be used in a later team operation.

### POST shuffle remaining

`POST /api/friendly-matches/:id/shuffle-partners`

Auth: authenticated PLAYER who is the Friendly creator.

Request body:

```json
{}
```

Success status: `200`.

Success data is an array of the newly created team rows. Existing teams are not returned as newly created rows and are preserved.

If the number of unpaired approved players is odd, the response is status `400` with `{"success":false,"message":"Unpaired player count must be even"}`.

### Team setup derivation and locking

The participants response contains `player_id`, `full_name`, and `player_code`. Each team response contains member `id`, where member `id` is the player ID, plus `name` and `code`. A participant is paired when its `player_id` appears in any team member `id`; otherwise it is unpaired.

There is no dedicated setup-lock boolean. After a fixture exists, team create, team delete, and shuffle return status `409` with `{"success":false,"message":"Pairing is locked after fixture generation"}`. `POST /api/friendly-matches/:id/fixtures/reset` removes an unstarted fixture and restores team editing. Fixture reset is rejected with status `409` and `{"success":false,"message":"Fixture cannot be reset after matches started"}` when a fixture match has started.

## Batch 4 Exact Contracts — Fixtures

### Generate fixtures

`POST /api/friendly-matches/:id/fixtures`

Authenticated creator only. Request body:

```json
{}
```

Success status: `201`. The response data is a fixture row with `id`, `friendly_match_id`, `fixture_code`, `format`, `status`, `created_at`, and `updated_at`.

### Read fixtures

`GET /api/friendly-matches/:id/fixtures`

Request body: `NO REQUEST BODY`. Success status: `200`.

```ts
interface FriendlyFixtureResponse { success: true; data: { fixture: FriendlyFixture; matches: FriendlyGameMatch[] } }
interface FriendlyFixture { id: string; friendly_match_id: string; fixture_code: string; format: 'LEAGUE' | 'KNOCKOUT'; status: 'DRAFT' | 'PUBLISHED'; created_at: string; updated_at: string }
interface FriendlyGameMatch {
  id: string; friendly_match_id: string; fixture_id: string; match_code: string;
  round_number: number; match_number: number; status: 'SCHEDULED' | 'LIVE' | 'COMPLETED';
  participant1_id: string | null; participant1_type: 'PLAYER' | 'TEAM' | null;
  participant2_id: string | null; participant2_type: 'PLAYER' | 'TEAM' | null;
  participant1_score: number; participant2_score: number; winning_points: number | null;
  source_match_1_id: string | null; source_match_2_id: string | null;
  next_match_id: string | null; next_match_slot: 1 | 2 | null;
  started_at: string | null; completed_at: string | null; created_at: string; updated_at: string;
}
```

### Reset fixtures

`POST /api/friendly-matches/:id/fixtures/reset`

Authenticated creator only. Request body:

```json
{}
```

An unstarted fixture is removed while participants and teams remain. Started fixtures return HTTP `409`:

```json
{"success":false,"message":"Fixture cannot be reset after matches started"}
```

Duplicate generation returns HTTP `409`:

```json
{"success":false,"message":"Fixture already exists"}
```

Doubles with unpaired approved players returns the backend error `All approved players must be paired`. Singles requires 6–16 approved participants; Doubles requires 8–16 approved players, an even count, and valid teams.

### Rendering rules

For knockout fixtures, group by `round_number` and order by `match_number`. Resolved sides have non-null participant IDs; display type comes from `participant*_type`. Unresolved sides have null participant IDs. Bracket linkage comes from `source_match_1_id`, `source_match_2_id`, `next_match_id`, and `next_match_slot`.

The response has no dedicated BYE flag. The frontend cannot safely distinguish a true BYE from a generic unresolved future slot using the current fixture contract.

For league fixtures, use the flat `matches` array ordered by `round_number` and `match_number`. Resolve PLAYER names through participants using `player_id`; resolve TEAM names through teams using team `id` and `team_code`. League fixtures do not use knockout source/next linkage.

Registered backend paths include:

- `GET /api/friendly-matches/:id/join-requests`
- `POST /api/friendly-matches/:id/join-requests/:requestId/approve`
- `POST /api/friendly-matches/:id/join-requests/:requestId/reject`
- `GET /api/friendly-matches/:id/participants`
- `GET /api/friendly-matches/:id/teams`
- `POST /api/friendly-matches/:id/teams`
- `DELETE /api/friendly-matches/:id/teams/:teamId`
- `POST /api/friendly-matches/:id/shuffle-partners`
- `POST /api/friendly-matches/:id/fixtures`
- `GET /api/friendly-matches/:id/fixtures`
- `POST /api/friendly-matches/:id/fixtures/reset`
- `POST /api/friendly-matches/:friendlyId/matches/:matchId/start`
- `POST /api/friendly-matches/:friendlyId/matches/:matchId/score`
- `POST /api/friendly-matches/:friendlyId/matches/:matchId/complete`
- `GET /api/friendly-matches/:id/result`
- `GET /api/friendly-matches/:id/standings`
- `POST /api/friendly-matches/:id/close`
- `POST /api/friendly-matches/:id/cleanup`
