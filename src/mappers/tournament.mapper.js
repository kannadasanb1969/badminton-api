const frontendNames = { tournament_date: 'startDate', registration_close_date: 'registrationEndDate',
  venue_name: 'venue', venue_address: 'location', format: 'fixtureFormat', gender_eligibility: 'gender' };
const camel = key => key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
function mapped(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [frontendNames[key] ?? camel(key),
    key.endsWith('_date') && value ? (value instanceof Date ? value.toISOString().slice(0,10) : String(value).slice(0,10)) : value]));
}
export function mapTournament(row, categories = [], rules = []) {
  return { ...mapped(row), endDate: null, registrationStartDate: null, entryFee: null, categories: categories.map(mapped), generalRules: rules.map(rule => rule.rule_text) };
}
