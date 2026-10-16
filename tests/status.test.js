const test = require('node:test');
const assert = require('node:assert/strict');

function addMonths(dateStr, months) {
  const [y,m,d] = dateStr.split('-').map(Number);
  const targetMonth = m - 1 + months;
  const targetYear = y + Math.floor(targetMonth / 12);
  const month = ((targetMonth % 12) + 12) % 12;
  const last = new Date(Date.UTC(targetYear, month + 1, 0)).getUTCDate();
  return `${targetYear}-${String(month + 1).padStart(2,'0')}-${String(Math.min(d,last)).padStart(2,'0')}`;
}
function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0,10);
}
function expiryAfterMonths(startDate, months) { return addDays(addMonths(startDate, months), -1); }
function statusFor(start, expiry, today) {
  if (start > today) return 'UPCOMING';
  if (expiry < today) return 'EXPIRED';
  const diff = (Date.parse(expiry+'T00:00:00Z') - Date.parse(today+'T00:00:00Z')) / 86400000;
  return diff <= 6 ? 'EXPIRING SOON' : 'ACTIVE';
}
test('one-month membership end date is inclusive', () => assert.equal(expiryAfterMonths('2026-10-16',1),'2026-11-15'));
test('month-end date clamps safely', () => assert.equal(expiryAfterMonths('2026-01-31',1),'2026-02-27'));
test('expiry date is inclusive', () => assert.equal(statusFor('2026-10-01','2026-10-16','2026-10-16'),'EXPIRING SOON'));
test('expired date is expired', () => assert.equal(statusFor('2026-09-01','2026-10-15','2026-10-16'),'EXPIRED'));
test('future start is upcoming', () => assert.equal(statusFor('2026-10-20','2026-11-19','2026-10-16'),'UPCOMING'));
test('more than six days remaining is active', () => assert.equal(statusFor('2026-09-01','2026-10-30','2026-10-16'),'ACTIVE'));
