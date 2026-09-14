// Hoardling leaderboard config — the Waddleton Supabase project's
// PUBLISHABLE key (already public on waddleton.pages.dev; RLS + the
// authenticated-only RPCs are the security boundary, not this file).
//
// BOARD OFF (2026-09-13). This parked build signed every visitor up the moment
// the title loaded (Lb.top for _lbTop) and posted each Daily run with no
// question at all, while the shipping /hoardling/ build now asks before any
// identity or score leaves the device. Rather than port the consent card into
// a parked codebase, the board is switched off: with no config, Lb.on() is
// false and every Lb path no-ops before it reaches the network. To restore it,
// port hoardkeep's consent gate (HANDOFF §3g there) FIRST, then put back
//   { url, key, board: "hoardling3d_daily" }
// — never "hoardling_daily": this build's DAILY_ROSTER diverges from the
// shipping one, so the two must not share a board.
window.HOARDLING_LB = null;
