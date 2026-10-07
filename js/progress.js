// js/progress.js
// Local, anonymous per-browser progress tracking -- no login, no backend
// schema. Keyed by the same anonymous id js/tracking.js already generates
// (so it's the one stable identifier the whole site uses), and stored in
// localStorage as a single JSON blob per anonymous id:
//
//   apgov_progress_<anonId> = {
//     lessonScores: { "week-1": { percent: 65, flagged: true } },
//     unitScores:   { "unit-1": { percent: 65, flagged: true } },
//     unitMissed:   { "unit-1": ["week-2-q4", "week-3-q9"] },
//     attempts:     [{ id, type, score, total, percent, at }, ...],
//   }
//
// lessonScores/unitScores hold only the MOST RECENT attempt's result per
// lesson/unit -- if a student retakes one and passes, the flag clears.
// Only the single worst-scoring flagged quiz overall is ever recommended
// (see getWorstFlagged) -- not every flagged one.
// unitMissed holds question ids currently considered "still shaky" on
// whole-unit quizzes; a right answer later removes a question from this
// set, a wrong answer (re-)adds it.
//
// attempts is the one place that keeps a *history* rather than a current
// state: every finished quiz appends an entry, newest last, capped at
// ATTEMPT_LOG_LIMIT so the blob can't grow without bound. This is what
// history.html and insights.html read. It only starts filling from the
// day it ships -- earlier attempts were never recorded anywhere, so
// there is nothing to backfill.
//
// Depends on js/tracking.js being loaded first (for getAnonId()).

(function () {
  const LESSON_FLAG_THRESHOLD = 0.7; // below this percent, flag the lesson/unit
  const ATTEMPT_LOG_LIMIT = 50; // keep the newest N attempts; older ones fall off
  const MASTERY_THRESHOLD = 0.9; // at or above this, a topic counts as mastered

  function storageKey() {
    const anonId = window.APGovTracking.getAnonId();
    return `apgov_progress_${anonId}`;
  }

  function load() {
    try {
      const raw = localStorage.getItem(storageKey());
      const parsed = raw ? JSON.parse(raw) : {};
      return {
        lessonScores: parsed.lessonScores || {},
        unitScores: parsed.unitScores || {},
        unitMissed: parsed.unitMissed || {},
        attempts: Array.isArray(parsed.attempts) ? parsed.attempts : [],
      };
    } catch (err) {
      console.error("Reading progress data failed:", err);
      return { lessonScores: {}, unitScores: {}, unitMissed: {}, attempts: [] };
    }
  }

  function save(data) {
    try {
      localStorage.setItem(storageKey(), JSON.stringify(data));
    } catch (err) {
      console.error("Saving progress data failed:", err);
    }
    // If the student is logged in, js/auth.js also saves this copy to
    // their account. Does nothing when logged out or on pages without it.
    if (window.KovrioAuth) window.KovrioAuth.queueUpload(data);
  }

  // Used only by js/auth.js when syncing with an account. _writeAll skips
  // the upload because auth.js uploads the merged copy itself.
  function readAll() {
    return load();
  }

  function writeAll(data) {
    try {
      localStorage.setItem(storageKey(), JSON.stringify(data));
    } catch (err) {
      console.error("Saving progress data failed:", err);
    }
  }

  function clearLocal() {
    try {
      localStorage.removeItem(storageKey());
    } catch (err) {
      console.error("Clearing progress data failed:", err);
    }
  }

  // Appends one finished attempt to the history log, trimming the oldest
  // entries past the cap. Mutates `data` -- the caller still saves.
  function appendAttempt(data, id, type, score, total) {
    data.attempts.push({
      id,
      type, // "lesson" | "unit"
      score,
      total,
      percent: score / total,
      at: new Date().toISOString(),
    });
    if (data.attempts.length > ATTEMPT_LOG_LIMIT) {
      data.attempts = data.attempts.slice(-ATTEMPT_LOG_LIMIT);
    }
  }

  // Call after any single-lesson quiz attempt (legacy full-length or the
  // new 10-question lesson quiz) to update that lesson's flag status.
  // Also appends to the attempt history log that history.html reads.
  function recordLessonScore(lessonId, score, total) {
    if (!lessonId || total === 0) return;
    const data = load();
    const percent = score / total;
    data.lessonScores[lessonId] = {
      percent,
      flagged: percent < LESSON_FLAG_THRESHOLD,
    };
    appendAttempt(data, lessonId, "lesson", score, total);
    save(data);
  }

  // Call after a whole-unit quiz attempt to update that unit's flag status.
  // Also appends to the attempt history log that history.html reads.
  function recordUnitScore(unitId, score, total) {
    if (!unitId || total === 0) return;
    const data = load();
    const percent = score / total;
    data.unitScores[unitId] = {
      percent,
      flagged: percent < LESSON_FLAG_THRESHOLD,
    };
    appendAttempt(data, unitId, "unit", score, total);
    save(data);
  }

  // Returns the single flagged lesson or whole-unit quiz the student
  // scored lowest on, or null if nothing is currently flagged.
  //   { type: "lesson", id: "week-1", percent: 0.5 }
  //   { type: "unit", id: "unit-1", percent: 0.6 }
  // `scope` (optional) restricts candidates -- used by the unit page so it
  // only recommends things relevant to that unit:
  //   { lessonIds: [...], unitId: "unit-1" }
  function getWorstFlagged(scope) {
    const data = load();
    const candidates = [];

    Object.keys(data.lessonScores).forEach((lessonId) => {
      const entry = data.lessonScores[lessonId];
      if (!entry.flagged) return;
      if (scope && scope.lessonIds && !scope.lessonIds.includes(lessonId)) return;
      candidates.push({ type: "lesson", id: lessonId, percent: entry.percent });
    });

    Object.keys(data.unitScores).forEach((unitId) => {
      const entry = data.unitScores[unitId];
      if (!entry.flagged) return;
      if (scope && scope.unitId && scope.unitId !== unitId) return;
      candidates.push({ type: "unit", id: unitId, percent: entry.percent });
    });

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.percent - b.percent);
    return candidates[0];
  }

  // Call after a whole-unit quiz attempt. `results` is
  // [{ id, correct }, ...] for every question in that attempt.
  function recordUnitAttempt(unitId, results) {
    if (!unitId) return;
    const data = load();
    const missed = new Set(data.unitMissed[unitId] || []);
    results.forEach(({ id, correct }) => {
      if (correct) {
        missed.delete(id);
      } else {
        missed.add(id);
      }
    });
    data.unitMissed[unitId] = Array.from(missed);
    save(data);
  }

  // Question ids currently considered still-missed for this unit.
  function getUnitMissedIds(unitId) {
    const data = load();
    return data.unitMissed[unitId] || [];
  }

  // Newest-first list of finished attempts, at most `limit` of them.
  // Entries are raw -- resolving an id to a display name is the caller's
  // job (it needs js/subjects.js, which progress.js deliberately doesn't
  // depend on).
  function getRecentAttempts(limit) {
    const data = load();
    const newestFirst = data.attempts.slice().reverse();
    return typeof limit === "number" ? newestFirst.slice(0, limit) : newestFirst;
  }

  // Every lesson with a recorded score, newest result per lesson, sorted
  // strongest first. Used by insights.html to pick out bests and worsts.
  //   [{ id, percent, mastered, flagged }, ...]
  function getLessonRankings() {
    const data = load();
    return Object.keys(data.lessonScores)
      .map((id) => {
        const entry = data.lessonScores[id];
        return {
          id,
          percent: entry.percent,
          mastered: entry.percent >= MASTERY_THRESHOLD,
          flagged: !!entry.flagged,
        };
      })
      .sort((a, b) => b.percent - a.percent);
  }

  // Same shape, for whole-unit quizzes.
  function getUnitRankings() {
    const data = load();
    return Object.keys(data.unitScores)
      .map((id) => {
        const entry = data.unitScores[id];
        return {
          id,
          percent: entry.percent,
          mastered: entry.percent >= MASTERY_THRESHOLD,
          flagged: !!entry.flagged,
        };
      })
      .sort((a, b) => b.percent - a.percent);
  }

  window.APGovProgress = {
    recordLessonScore,
    recordUnitScore,
    getWorstFlagged,
    recordUnitAttempt,
    getUnitMissedIds,
    getRecentAttempts,
    getLessonRankings,
    getUnitRankings,
    MASTERY_THRESHOLD,
    _readAll: readAll,
    _writeAll: writeAll,
    _clearLocal: clearLocal,
  };
})();
