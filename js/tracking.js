// js/tracking.js
// Lightweight, anonymous usage tracking -- no login required.
//
// Why this exists: a raw "click counter" only tells you how many quizzes
// were taken, not how many different people took them. This tags each
// browser with a random ID (saved in localStorage, generated once) so we
// can count *distinct* people, not just clicks.

(function () {
  const SUPABASE_URL = "https://xkfdaguserrydqldvxug.supabase.co";
  const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhrZmRhZ3VzZXJyeWRxbGR2eHVnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgzODM4NjksImV4cCI6MjEwMzk1OTg2OX0.ObUbS5ov3-SYGyRFRf8kSOWYAmEpgPih_YUFyukcEBY";

  // supabase-js UMD build exposes a global `supabase` object with
  // .createClient -- loaded via the CDN <script> tag in quiz.html, before
  // this file. If that CDN script is blocked (ad blocker, offline, etc.),
  // `window.supabase` won't exist -- fall back to a no-op client so the
  // rest of the site (which depends on window.APGovTracking existing)
  // keeps working.
  let client = null;
  try {
    client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  } catch (err) {
    console.error("Usage tracking unavailable (Supabase client failed to load):", err);
  }

  // Shared with js/auth.js so the whole site uses ONE Supabase client
  // (two clients would fight over the saved login session).
  window.KovrioSupabase = client;

  function getAnonId() {
    let anonId = localStorage.getItem("anonId");
    if (!anonId) {
      anonId = crypto.randomUUID();
      localStorage.setItem("anonId", anonId);
    }
    return anonId;
  }

  // Call this once a quiz is finished. weekId is like "week-1".
  async function logAttempt(weekId, score, total) {
    if (!client) return;
    const anonId = getAnonId();
    try {
      await client.from("Attempts").insert({
        anon_id: anonId,
        question_id: weekId, // holds the week id, e.g. "week-1" (see README note on the table)
        was_correct: score === total, // true only on a perfect run -- simple signal, not per-question
      });
    } catch (err) {
      // Tracking failing should never break the quiz itself.
      console.error("Usage tracking failed:", err);
    }
  }

  window.APGovTracking = { logAttempt, getAnonId };
})();
