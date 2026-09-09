function camel(row){return Object.fromEntries(Object.entries(row).map(([k,v])=>[k.replace(/_([a-z])/g,(_,c)=>c.toUpperCase()),v]));}
export function mapMatchRow(row){return camel(row);}
export function mapHistoryRow(row){return camel(row);}
