const frontendNames = { tournament_date: 'startDate', registration_close_date: 'registrationEndDate',
  venue_name: 'venue', venue_address: 'location', format: 'fixtureFormat', gender_eligibility: 'gender' };
const camel = key => key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
function mapped(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [frontendNames[key] ?? camel(key),
    key.endsWith('_date') && value ? (value instanceof Date ? value.toISOString().slice(0,10) : String(value).slice(0,10)) : value]));
}
export function mapTournament(row, categories = [], rules = []) {
  const counts={registeredPlayerCount:0,registeredEntryCount:0,registeredTeamCount:0};
  const mappedCategories=categories.map(c=>({...mapped(c),registeredPlayerCount:c.registeredPlayerCount??0,registeredEntryCount:c.registeredEntryCount??0,registeredTeamCount:c.registeredTeamCount??0}));
  return { ...mapped(row), ...counts, endDate: null, registrationStartDate: null, entryFee: null, categories: mappedCategories, generalRules: rules.map(rule => rule.rule_text) };
}
