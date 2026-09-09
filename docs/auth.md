# Development authentication

`npm run dev` and `npm start` set AUTH_MODE=development through Wrangler's CLI.
Restart the dev process after updating these scripts. The OTP provider is disabled
unless this mode is explicitly enabled, and is always disabled when ENVIRONMENT
or NODE_ENV is production. Deployment configuration has not been changed.

Request an OTP with POST /api/auth/request-otp and {"mobile":"9999999999"}.
POST /api/auth/verify-otp or /api/auth/login accepts
{"mobile":"9999999999","otp":"123456","role":"PLAYER"} and returns
{success:true,data:{user,playerProfile}}. There is no OTP-less login bypass.
The fixed development OTP is defined only in auth.service.js. Hashes use salted
PBKDF2. Requests expire in five minutes and allow five failed attempts; requesting
a replacement cancels outstanding requests. Successful verification consumes it.

Only PLAYER users can self-register. ORGANIZER and ADMIN must be provisioned.
Inactive users cannot authenticate. Profiles are returned only through an existing
unambiguous user_id link; mobile alone does not assign ownership. Guest claiming
is not implemented.

Users are unique by mobile and role. GET /api/users/mobile/:mobile accepts an
optional ?role=PLAYER parameter, required when multiple roles share the mobile.
User output uses displayName and isActive from the actual schema.

No React frontend was present to verify its old login contract. Clients must
request and supply an OTP; user information is nested in data.user. No session,
JWT, refresh-token issuance, or endpoint authorization is implemented in this phase.
These identity responses are not bearer credentials. User lookup endpoints remain
public as requested; production access control and a real OTP provider remain
follow-up work.
