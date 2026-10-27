// Country of an artist, seller or supplier, for the country filters (admin Artists & sellers, the studio pickers in the
// artist/seller and supplier portals): the profile's country; a price list kept in India or an Indian address wins over
// a default "UAE" (suppliers added by the studio were saved with UAE).
const PLACE = [['India', /\bindia\b|bengaluru|bangalore|chennai|mumbai|delhi|kerala|tamil ?nadu|karnataka|hyderabad|kolkata|pune/i],
  ['UAE', /\buae\b|united arab emirates|dubai|sharjah|ajman|abu dhabi|ras al khaimah|fujairah|umm al quwain|al ain/i]];
export function countryOf(s) {
  let c = String(s?.country || '').trim();
  if (/^(uae|u\.a\.e\.?|united arab emirates)$/i.test(c)) c = 'UAE';
  let from = s?.from === 'India';
  try { let v = s?.rateCard; for (let i = 0; i < 2 && typeof v === 'string'; i++) v = JSON.parse(v); if (v?.from === 'India') from = true; } catch { /* no card */ }
  const where = `${s?.city || ''} ${s?.address || ''} ${s?.emirate || ''}`;
  const guess = from ? 'India' : (PLACE.find(([, re]) => re.test(where)) || [])[0];
  if (c && !(c === 'UAE' && guess === 'India')) return c;
  return guess || (s?.emirate ? 'UAE' : 'Not stated');
}
