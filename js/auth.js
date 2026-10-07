// js/auth.js
// Optional accounts. The site still works with no login at all -- progress
// lives in this browser's localStorage like before. Logging in adds one
// thing: your progress is also saved to your Kovrio account (Supabase
// table `user_progress`), so it follows you to any device.
//
// How syncing works:
//   - localStorage stays the "working copy" every page reads from, so
//     pages don't have to wait on the network to render.
//   - Every time progress.js saves, it calls queueUpload() and the new
//     copy is pushed to your account a moment later.
//   - On every page load (and right after logging in), we pull your
//     account's copy, merge it with this browser's copy, and save the
//     merged result to both places. If the merge changed what's in this
//     browser, the page reloads once so it shows the merged progress.
//
// Security lives in the database (see supabase/accounts.sql), not here.
// Anything in this file can be edited by a user in DevTools, so nothing
// here is trusted to keep data private -- Row Level Security does that.
//
// Depends on js/tracking.js (creates the Supabase client) and
// js/progress.js (reads/writes the local copy) being loaded first.

(function () {
  const client = window.KovrioSupabase || null;
  const ATTEMPT_LOG_LIMIT = 50; // must match js/progress.js
  const RELOAD_GUARD_KEY = "kovrio_sync_reloaded";

  let currentUser = null;
  let pendingData = null;
  let uploadTimer = null;

  // ---- Merging two copies of progress ----------------------------------

  function normalize(data) {
    const d = data || {};
    return {
      lessonScores: d.lessonScores || {},
      unitScores: d.unitScores || {},
      unitMissed: d.unitMissed || {},
      attempts: Array.isArray(d.attempts) ? d.attempts : [],
    };
  }

  // Newest attempt time for one lesson/unit id, or "" if none is logged.
  function lastAttemptAt(data, id) {
    let latest = "";
    data.attempts.forEach((a) => {
      if (a.id === id && a.at > latest) latest = a.at;
    });
    return latest;
  }

  // For one id present in both copies, keep the copy whose most recent
  // attempt is newer. Ties (or no history) keep this browser's copy.
  function pickNewer(local, cloud, map, id) {
    const localAt = lastAttemptAt(local, id);
    const cloudAt = lastAttemptAt(cloud, id);
    return cloudAt > localAt ? cloud[map][id] : local[map][id];
  }

  function mergeMap(local, cloud, map) {
    const out = {};
    const ids = new Set([...Object.keys(local[map]), ...Object.keys(cloud[map])]);
    ids.forEach((id) => {
      if (!(id in cloud[map])) out[id] = local[map][id];
      else if (!(id in local[map])) out[id] = cloud[map][id];
      else out[id] = pickNewer(local, cloud, map, id);
    });
    return out;
  }

  function mergeProgress(localRaw, cloudRaw) {
    const local = normalize(localRaw);
    const cloud = normalize(cloudRaw);

    // Attempt history: keep every attempt from both copies (no duplicates),
    // oldest first, capped like progress.js caps it.
    const seen = new Set();
    const attempts = [...local.attempts, ...cloud.attempts]
      .filter((a) => {
        const key = `${a.id}|${a.at}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
      .slice(-ATTEMPT_LOG_LIMIT);

    return {
      lessonScores: mergeMap(local, cloud, "lessonScores"),
      unitScores: mergeMap(local, cloud, "unitScores"),
      unitMissed: mergeMap(local, cloud, "unitMissed"),
      attempts,
    };
  }

  // JSON with sorted keys, so two copies with the same content compare
  // equal even if their keys were saved in a different order.
  function stable(value) {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (value && typeof value === "object") {
      return `{${Object.keys(value)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${stable(value[k])}`)
        .join(",")}}`;
    }
    return JSON.stringify(value);
  }

  // ---- Talking to the account ------------------------------------------

  async function pushNow() {
    clearTimeout(uploadTimer);
    if (!client || !currentUser || !pendingData) return;
    const data = pendingData;
    pendingData = null;
    const { error } = await client.from("user_progress").upsert({
      user_id: currentUser.id,
      data,
      updated_at: new Date().toISOString(),
    });
    if (error) console.error("Saving progress to your account failed:", error.message);
  }

  // Called by progress.js after every local save.
  function queueUpload(data) {
    if (!client || !currentUser) return;
    pendingData = data;
    clearTimeout(uploadTimer);
    uploadTimer = setTimeout(pushNow, 300);
  }

  // Pull the account's copy, merge, save the result to both places.
  // Returns true if this browser's copy changed.
  async function pullAndMerge() {
    if (!client || !currentUser || !window.APGovProgress) return false;
    const { data: row, error } = await client
      .from("user_progress")
      .select("data")
      .eq("user_id", currentUser.id)
      .maybeSingle();
    if (error) {
      console.error("Loading progress from your account failed:", error.message);
      return false;
    }

    const local = window.APGovProgress._readAll();
    const merged = mergeProgress(local, row ? row.data : null);
    const mergedText = stable(merged);
    const localChanged = mergedText !== stable(normalize(local));
    const cloudChanged = !row || mergedText !== stable(normalize(row.data));

    if (localChanged) window.APGovProgress._writeAll(merged);
    if (cloudChanged) {
      pendingData = merged;
      await pushNow();
    }
    return localChanged;
  }

  // Wipes this browser's copy (used on log out / delete) so the next
  // person on a shared school computer starts clean.
  function clearThisBrowser() {
    if (window.APGovProgress) window.APGovProgress._clearLocal();
    try {
      localStorage.removeItem("anonId");
    } catch (err) {
      console.error("Clearing local data failed:", err);
    }
  }

  // ---- Public actions (used by account.html) ---------------------------

  async function signUp(email, password) {
    if (!client) throw new Error("Accounts are unavailable right now. Try again later.");
    const { data, error } = await client.auth.signUp({
      email,
      password,
      // Where the confirmation link sends people, if confirmation is ever
      // turned on. Must be listed under Supabase -> Auth -> URL Configuration.
      options: { emailRedirectTo: `${location.origin}/account.html` },
    });
    if (error) throw error;
    // If email confirmation is on in Supabase, there's no session yet.
    if (!data.session) return { needsConfirmation: true };
    currentUser = data.session.user;
    await pullAndMerge();
    return { needsConfirmation: false };
  }

  async function signIn(email, password) {
    if (!client) throw new Error("Accounts are unavailable right now. Try again later.");
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    currentUser = data.user;
    await pullAndMerge();
  }

  // Sends the student to Google's sign-in page. Google sends them back
  // logged in, and init() below picks up the session from the
  // URL and syncs their progress. Works only once the Google provider is
  // turned on in Supabase.
  // `next` is the page to land on afterwards (defaults to the home page).
  // prompt=select_account makes Google always show its account picker, so
  // students can tap whichever Google account is already on their device.
  async function signInWithGoogle(next) {
    if (!client) throw new Error("Accounts are unavailable right now. Try again later.");
    const { error } = await client.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${location.origin}${safeNext(next)}`,
        queryParams: { prompt: "select_account" },
      },
    });
    if (error) throw error;
  }

  async function signOut() {
    await pushNow(); // don't lose a save that's still waiting to upload
    if (client) await client.auth.signOut();
    currentUser = null;
    clearThisBrowser();
  }

  // Sets a new password on the logged-in account. Works for Google-only
  // accounts too, which then gain email + password sign-in.
  async function setPassword(password) {
    if (!client || !currentUser) throw new Error("You're not logged in.");
    const { error } = await client.auth.updateUser({ password });
    if (error) throw error;
  }

  async function deleteAccount() {
    if (!client || !currentUser) throw new Error("You're not logged in.");
    clearTimeout(uploadTimer);
    pendingData = null;
    const { error } = await client.rpc("delete_my_account");
    if (error) throw error;
    // The account is gone, so this mostly just clears the saved session.
    await client.auth.signOut().catch(() => {});
    currentUser = null;
    clearThisBrowser();
  }

  function getUser() {
    return currentUser;
  }

  // ---- Login gate ------------------------------------------------------
  // Pages marked <html class="auth-gate"> require a login. Logged-out
  // visitors get sent to the sign-in screen (account.html), which sends
  // them back to the page they wanted afterwards. Logged-in visitors stay
  // logged in on that browser until they log out, so they go straight in.
  //
  // This is a convenience, NOT security: anyone can delete this code in
  // DevTools. What protects students' data is Row Level Security in the
  // database. All someone gains by skipping the gate is the free quizzes.

  const gated = document.documentElement.classList.contains("auth-gate");

  function openGate() {
    document.documentElement.classList.remove("auth-gate");
  }

  // Only ever redirect to a page on this site, never an outside URL that
  // someone slipped into ?next= (a classic phishing trick).
  function safeNext(next) {
    if (typeof next === "string" && /^\/[A-Za-z0-9_\-./?=&%]*$/.test(next) && !next.startsWith("//")) {
      return next;
    }
    return "/index.html";
  }

  function sendToLogin() {
    const next = encodeURIComponent(location.pathname + location.search);
    location.replace(`account.html?next=${next}`);
  }

  // Any [data-logout] button (the "Log out" in the nav) logs out and goes
  // to the sign-in screen.
  document.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-logout]");
    if (!btn) return;
    btn.disabled = true;
    try {
      await signOut();
    } finally {
      location.replace("account.html");
    }
  });

  // ---- Startup ---------------------------------------------------------

  async function init() {
    // If Supabase couldn't load (ad blocker, school filter), let them in
    // rather than locking them out of the whole site.
    if (!client) return openGate();
    const { data } = await client.auth.getSession();
    currentUser = data.session ? data.session.user : null;
    if (!currentUser) {
      if (gated) return sendToLogin();
      return openGate();
    }
    openGate();

    const changed = await pullAndMerge();
    // Reload at most once per tab, so a sync problem can never loop.
    if (changed && !sessionStorage.getItem(RELOAD_GUARD_KEY)) {
      sessionStorage.setItem(RELOAD_GUARD_KEY, "1");
      location.reload();
    }
  }

  const ready = init().catch((err) => {
    console.error("Account check failed:", err);
    openGate();
  });

  window.KovrioAuth = {
    ready,
    getUser,
    signUp,
    signIn,
    signInWithGoogle,
    signOut,
    setPassword,
    deleteAccount,
    queueUpload,
    safeNext,
  };
})();
