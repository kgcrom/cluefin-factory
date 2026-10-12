/** 15:30 close plus the closing auction settling; before this today's candle is partial. */
export const SETTLED_MINUTES = 15 * 60 + 40;

/** Today's date and minutes past midnight in KST. */
export function kstClock(now = new Date()) {
  const kst = new Date(now.getTime() + 9 * 3_600_000);
  return {
    date: kst.toISOString().slice(0, 10).replaceAll('-', ''),
    minutes: kst.getUTCHours() * 60 + kst.getUTCMinutes(),
  };
}
