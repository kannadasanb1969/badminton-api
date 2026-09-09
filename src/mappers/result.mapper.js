const camel=r=>Object.fromEntries(Object.entries(r).map(([k,v])=>[k.replace(/_([a-z])/g,(_,c)=>c.toUpperCase()),v]));
export const mapResultRow=camel; export const mapMedalRow=camel;
