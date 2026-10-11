// Things a visitor has found and carries between visits: a blue box, a whistle, whatever the
// board or the trash can turns up. Kept in this browser. Some phone numbers need one (the
// `requires` field in assets/audio/numbers.json). Finding them is not built yet; the console
// can hand one over for testing: window.__liminal.items.give('bluebox'), as does ?give=bluebox in the URL; ?drop=whistle or ?drop=all takes things back.
const KEY = 'liminal.items';
function read() { try { const v = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; } }
function write(list) { try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (e) { /* no storage */ } }
let items = read();
// for testing before finding is built: ?give=whistle hands one over, ?drop=whistle takes it back
try {
  const q = new URLSearchParams(location.search);
  for (const id of (q.get('give') || '').split(',').filter(Boolean)) if (!items.includes(id)) items = [...items, id];
  for (const id of (q.get('drop') || '').split(',').filter(Boolean)) items = id === 'all' ? [] : items.filter((x) => x !== id);
  if (q.has('give') || q.has('drop')) write(items);
} catch (e) { /* no location */ }
export const hasItem = (id) => items.includes(id);
export const give = (id) => { if (!items.includes(id)) { items = [...items, id]; write(items); } return items; };
export const drop = (id) => { items = items.filter((x) => x !== id); write(items); return items; };
export const inventory = () => [...items];
export const ITEM_NAMES = { whistle: 'a plastic whistle', bluebox: 'a blue box' };
