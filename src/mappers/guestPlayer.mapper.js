// UTC keeps derived values consistent across Worker locations.
export function mapGuestPlayerRow(row, today = new Date()) {
  if (!row) return null;
  const dob = row.dob instanceof Date
    ? row.dob.toISOString().slice(0, 10)
    : row.dob ? String(row.dob).slice(0, 10) : null;
  let age = null;
  if (dob) {
    const [year, month, day] = dob.split("-").map(Number);
    const birthdayPending = today.getUTCMonth() + 1 < month ||
      (today.getUTCMonth() + 1 === month && today.getUTCDate() < day);
    age = today.getUTCFullYear() - year - (birthdayPending ? 1 : 0);
  }
  return {
    id: row.id,
    guestCode: row.guest_code,
    fullName: row.full_name,
    gender: row.gender ?? null,
    dob,
    age,
    mobile: row.mobile,
    location: row.location ?? null,
    playingSince: row.playing_since ?? null,
    experienceYears: row.playing_since == null ? null : today.getUTCFullYear() - row.playing_since,
    regularPlayer: row.regular_player,
    courtAcademy: row.court_academy ?? null,
    profileStatus: row.profile_status,
    linkedPlayerId: row.linked_player_id ?? null,
    claimedAt: row.claimed_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
