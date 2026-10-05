// js/account.js
// The account page: log in, create an account, log out, delete account.
// All the real work happens in js/auth.js -- this file just wires up the
// buttons and shows messages.

(function () {
  const $ = (id) => document.getElementById(id);
  const auth = window.KovrioAuth;
  const next = auth ? auth.safeNext(new URLSearchParams(location.search).get("next")) : "/index.html";

  function goToApp() {
    location.replace(next.replace(/^\//, ""));
  }

  // Turn Supabase's error messages into something a student understands.
  function friendly(err) {
    const msg = (err && err.message) || "";
    if (/invalid login credentials/i.test(msg)) return "Wrong email or password.";
    if (/already registered|already exists/i.test(msg)) {
      return "There's already an account with that email. Try logging in instead.";
    }
    if (/rate limit|too many/i.test(msg)) return "Too many tries. Wait a few minutes and try again.";
    if (/provider is not enabled|unsupported provider/i.test(msg)) {
      return "Google sign-in isn't turned on yet. Use email for now.";
    }
    if (/password/i.test(msg)) return "That password doesn't work. Use at least 8 characters.";
    if (/email/i.test(msg)) return "That email doesn't look right. Check it and try again.";
    if (/failed to fetch|network/i.test(msg)) return "Couldn't reach Kovrio. Check your internet and try again.";
    return msg || "Something went wrong. Try again.";
  }

  function showMessage(el, text, isError) {
    el.textContent = text;
    el.classList.toggle("is-error", !!isError);
    el.classList.remove("hidden");
  }

  function setBusy(busy) {
    ["google-button", "login-button", "signup-button", "logout-button", "delete-button"].forEach((id) => {
      const btn = $(id);
      if (btn) btn.disabled = busy;
    });
  }

  function render() {
    $("account-loading").classList.add("hidden");
    const user = auth && auth.getUser();
    $("logged-out").classList.toggle("hidden", !!user);
    $("logged-in").classList.toggle("hidden", !user);
    if (user) $("account-email").textContent = user.email;
    $("account-title").textContent = user ? "Your account" : "Welcome to Kovrio";
  }

  // Checks the form before bothering the server. (The server checks again --
  // this is only so students get a quick, clear message.)
  function readForm() {
    const email = $("auth-email").value.trim();
    const password = $("auth-password").value;
    if (!email || !email.includes("@")) throw new Error("Enter your email.");
    if (password.length < 8) throw new Error("Use at least 8 characters for your password.");
    return { email, password };
  }

  async function handle(action) {
    const msg = $("auth-message");
    msg.classList.add("hidden");
    let form;
    try {
      form = readForm();
    } catch (err) {
      showMessage(msg, err.message, true);
      return;
    }
    setBusy(true);
    try {
      if (action === "signup") {
        const result = await auth.signUp(form.email, form.password);
        if (result.needsConfirmation) {
          showMessage(msg, "Almost done: check your email and click the link to confirm your account.", false);
          return;
        }
      } else {
        await auth.signIn(form.email, form.password);
      }
      $("auth-password").value = "";
      goToApp();
    } catch (err) {
      showMessage(msg, friendly(err), true);
    } finally {
      setBusy(false);
    }
  }

  async function init() {
    if (!auth) {
      $("account-loading").textContent = "Accounts are unavailable right now. Try again later.";
      return;
    }
    await auth.ready;
    // Already logged in and arrived from a locked page? Go straight back.
    if (auth.getUser() && new URLSearchParams(location.search).has("next")) {
      goToApp();
      return;
    }
    render();

    $("auth-form").addEventListener("submit", (e) => {
      e.preventDefault();
      handle("login");
    });
    $("signup-button").addEventListener("click", () => handle("signup"));

    $("google-button").addEventListener("click", async () => {
      setBusy(true);
      try {
        await auth.signInWithGoogle(next); // leaves the page on success
      } catch (err) {
        showMessage($("auth-message"), friendly(err), true);
        setBusy(false);
      }
    });

    $("logout-button").addEventListener("click", async () => {
      setBusy(true);
      try {
        await auth.signOut();
      } finally {
        setBusy(false);
        render();
      }
    });

    $("delete-button").addEventListener("click", async () => {
      const typed = window.prompt('This deletes your account and saved progress forever. Type DELETE to confirm.');
      if (typed !== "DELETE") return;
      setBusy(true);
      try {
        await auth.deleteAccount();
        render();
      } catch (err) {
        showMessage($("delete-message"), friendly(err), true);
      } finally {
        setBusy(false);
      }
    });
  }

  init();
})();
