// Hoardling leaderboard config — the Waddleton Supabase project's
// PUBLISHABLE key (already public on waddleton.pages.dev; RLS + the
// authenticated-only RPCs are the security boundary, not this file).
window.HOARDLING_LB = {
  "url": "https://wwdpvmaqumdygyiirlns.supabase.co",
  "key": "sb_publishable_uGWMFqWOrum9T9x5QrEEFg_N7gsIQwE",
  // NOT "hoardling_daily". This build's DAILY_ROSTER diverges from the shipping
  // /hoardling/ build, so submitting here ranked two different games on one
  // board: players on this build never faced the two hardest raider types, and
  // their scores competed with players who did. flush() also submits with
  // cfg.board rather than a board stored per queued entry, so the offline queue
  // is namespaced too.
  "board": "hoardling3d_daily"
};
