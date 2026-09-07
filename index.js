/**
 * Cloud Functions for the NCAA Football Schedule Tracker.
 *
 * Data source: College Football Data API (https://collegefootballdata.com)
 * Get a free API key at https://collegefootballdata.com/key and store it as
 * a Firebase secret named CFBD_API_KEY (see SETUP.md).
 *
 * Entry points:
 *   - addTeam        (callable)   runs the instant a user adds a team;
 *                                 also does a best-effort first news fetch
 *   - removeTeam     (callable)   deletes a team's documents
 *   - claimSession   (callable)   merges a signed-out guest's tracked teams
 *                                 into their account the first time they sign in
 *   - nightlyRefresh (scheduled)  refreshes every tracked team's schedule,
 *                                 across every session/account, nightly
 *   - refreshNews    (scheduled)  refreshes cached Google News headlines for
 *                                 every distinct tracked school, every 6 hours
 *
 * Data is namespaced per "session" (sessions/{id}/teams/... and
 * sessions/{id}/schedules/...) so different visitors/accounts each see only
 * their own tracked teams. For a signed-in user, {id} is always their
 * Firebase Auth uid (enforced server-side, see resolveSessionId) so their
 * list follows them across devices; for a signed-out visitor, {id} is a
 * random id the browser generates and keeps in localStorage, isolating that
 * browser's list from everyone else's, same as before login existed.
 *
 * News headlines are NOT session-scoped — newsCache/{teamId} holds one
 * shared, public set of headlines per school, since the news itself doesn't
 * differ between the people tracking that team.
 */

const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {onSchedule} = require("firebase-functions/v2/scheduler");
const {setGlobalOptions} = require("firebase-functions/v2");
const {defineSecret} = require("firebase-functions/params");
const {initializeApp} = require("firebase-admin/app");
const {getFirestore, FieldValue} = require("firebase-admin/firestore");
const logger = require("firebase-functions/logger");
const {XMLParser} = require("fast-xml-parser");

initializeApp();
const db = getFirestore();

const CFBD_API_KEY = defineSecret("CFBD_API_KEY");
setGlobalOptions({region: "us-central1", maxInstances: 5});

const CFBD_BASE = "https://api.collegefootballdata.com";

// ---------- helpers ----------

/** CFB "season year" — the sport runs Aug through Jan, so treat Jul as the
 * start of a new season year and Jan-Jun as still-belonging to last year's
 * season (bowls/playoff). */
function currentSeasonYear() {
  const now = new Date();
  const month = now.getUTCMonth() + 1;
  return month >= 7 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
}

function slugify(name) {
  return String(name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
}

async function cfbdFetch(path, params, apiKey) {
  const url = new URL(CFBD_BASE + path);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  });
  const res = await fetch(url, {
    headers: {Authorization: `Bearer ${apiKey}`, Accept: "application/json"},
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`CFBD ${path} failed: ${res.status} ${body}`);
  }
  return res.json();
}

/** Look up a school in an already-fetched FBS team list by (fuzzy) name match
 * so users can type "Georgia Tech", "georgia tech", or "Yellow Jackets" and
 * still land on the right, canonically-spelled school. */
function findTeamInList(schoolQuery, teams) {
  const q = schoolQuery.trim().toLowerCase();
  return (
    teams.find((t) => t.school.toLowerCase() === q) ||
    teams.find((t) => (t.mascot || "").toLowerCase() === q) ||
    teams.find((t) => `${t.school} ${t.mascot || ""}`.toLowerCase() === q) ||
    teams.find((t) => t.school.toLowerCase().includes(q) || q.includes(t.school.toLowerCase())) ||
    null
  );
}

/** Build a lowercase-school-name -> logo URL lookup from a /teams/fbs list,
 * used to attach an opponent's logo to each schedule row (Google-style). */
function buildLogoLookup(teams) {
  const map = new Map();
  teams.forEach((t) => {
    if (t.logos && t.logos[0]) map.set(t.school.toLowerCase(), t.logos[0]);
  });
  return map;
}

/** Fetch the most recent week's poll rankings for a season and build a
 * lowercase-school-name -> rank lookup (e.g. so "13 Alabama" can be shown
 * next to a ranked team or opponent). Prefers the AP Top 25 poll, falling
 * back to the CFP committee rankings or whatever poll is available late/early
 * in the season. Returns an empty map (never throws) if no polls are out yet
 * or the request fails, since rankings are a nice-to-have, not core data. */
async function fetchRankingsMap(year, apiKey) {
  let weeks;
  try {
    weeks = await cfbdFetch("/rankings", {year}, apiKey);
  } catch (err) {
    logger.error(`fetchRankingsMap: /rankings failed for ${year}`, err);
    return new Map();
  }
  if (!weeks || !weeks.length) return new Map();
  const latest = weeks[weeks.length - 1];
  const polls = latest.polls || [];
  const poll =
    polls.find((p) => p.poll === "AP Top 25") ||
    polls.find((p) => p.poll === "Playoff Committee Rankings") ||
    polls[0];
  const map = new Map();
  if (poll && poll.ranks) {
    poll.ranks.forEach((r) => map.set(r.school.toLowerCase(), r.rank));
  }
  return map;
}

function fmtTime(startDate, tbd) {
  if (tbd) return "TBA";
  const d = new Date(startDate);
  const t = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  }).format(d);
  return `${t} ET`;
}

function fmtDate(startDate) {
  const d = new Date(startDate);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Fetch + assemble one team's full-season schedule, including TV/streaming
 * outlet (from /games/media), each opponent's logo + AP rank (when known),
 * and inserted bye-week rows. `logoLookup` and `rankMap` are optional
 * pre-built Maps (see buildLogoLookup/fetchRankingsMap) — pass them in so
 * callers refreshing many teams at once don't refetch /teams/fbs or
 * /rankings once per team. */
async function buildSchedule(school, year, apiKey, logoLookup, rankMap) {
  const [games, media, winProbs] = await Promise.all([
    cfbdFetch("/games", {year, team: school, seasonType: "both"}, apiKey),
    cfbdFetch("/games/media", {year, team: school, seasonType: "both"}, apiKey),
    // Pregame win probability is a nice-to-have, not core data (and isn't
    // published yet for very early-season games) — never let it fail the
    // whole schedule fetch.
    cfbdFetch("/metrics/wp/pregame", {year, team: school, seasonType: "both"}, apiKey)
        .catch((err) => {
          logger.error(`buildSchedule: win probability fetch failed for ${school}`, err);
          return [];
        }),
  ]);

  const mediaByGameId = {};
  media.forEach((m) => {
    if (!mediaByGameId[m.id]) mediaByGameId[m.id] = [];
    mediaByGameId[m.id].push(m.outlet);
  });

  const winProbByGameId = {};
  winProbs.forEach((wp) => { winProbByGameId[wp.gameId] = wp; });

  const rows = games
      .filter((g) => g.season === year)
      .sort((a, b) => a.week - b.week)
      .map((g) => {
        const isHome = g.homeTeam.toLowerCase() === school.toLowerCase();
        const opponent = isHome ? g.awayTeam : g.homeTeam;
        const teamPts = isHome ? g.homePoints : g.awayPoints;
        const oppPts = isHome ? g.awayPoints : g.homePoints;

        let result = "";
        let score = "";
        if (g.completed && teamPts !== null && oppPts !== null) {
          result = teamPts > oppPts ? "W" : teamPts < oppPts ? "L" : "T";
          score = `${teamPts}-${oppPts}`;
        }

        const outlets = mediaByGameId[g.id];
        const opponentLogo = (logoLookup && logoLookup.get(opponent.toLowerCase())) || null;
        const opponentRank = (rankMap && rankMap.get(opponent.toLowerCase())) || null;
        const wp = winProbByGameId[g.id];
        // wp.homeWinProbability is always from the home team's perspective —
        // flip it when this team is the away side so winProb always means
        // "this team's" chance to win.
        const winProb = wp ? (isHome ? wp.homeWinProbability : 1 - wp.homeWinProbability) : null;
        return {
          id: String(g.id),
          week: g.week,
          date: fmtDate(g.startDate),
          kickoff: g.startDate, // raw ISO timestamp — lets the frontend do its own countdown math
          tbd: !!g.startTimeTBD,
          opponent,
          opponentLogo,
          opponentRank,
          winProb,
          site: g.neutralSite ? "N" : isHome ? "H" : "A",
          place: g.venue || "",
          time: fmtTime(g.startDate, g.startTimeTBD),
          tv: outlets && outlets.length ? [...new Set(outlets)].join("/") : "TBA",
          result,
          score,
          bye: false,
        };
      });

  // Fill in open/bye weeks that fall between the team's first and last game.
  if (rows.length) {
    const weeks = rows.map((r) => r.week);
    const minW = Math.min(...weeks);
    const maxW = Math.max(...weeks);
    const haveWeek = new Set(weeks);
    for (let w = minW; w <= maxW; w++) {
      if (!haveWeek.has(w)) {
        rows.push({
          id: `bye-${w}`,
          week: w,
          date: "",
          opponent: "Open date",
          site: "-",
          place: "",
          time: "",
          tv: "",
          result: "",
          score: "",
          bye: true,
        });
      }
    }
    rows.sort((a, b) => a.week - b.week);
  }

  return rows;
}

// ---------- news (Google News RSS, no API key needed) ----------

const newsXmlParser = new XMLParser({ignoreAttributes: false, attributeNamePrefix: "@_"});

/** Strip a redundant " - Source Name" suffix Google News often appends to
 * titles, since we already show the source separately. */
function cleanNewsTitle(title, source) {
  if (!title) return "";
  if (!source) return title;
  const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return title.replace(new RegExp(`\\s*-\\s*${escaped}$`), "").trim();
}

/** Fetch and parse a Google News RSS feed for an arbitrary search query —
 * free, no API key. Used for both a school's own news and the shared
 * national "College Football" feed. */
async function fetchNewsForQuery(query) {
  const url = "https://news.google.com/rss/search?" + new URLSearchParams({
    q: query,
    hl: "en-US",
    gl: "US",
    ceid: "US:en",
  });
  const res = await fetch(url, {headers: {"User-Agent": "Mozilla/5.0 (compatible; CFBScheduleTracker/1.0)"}});
  if (!res.ok) throw new Error(`Google News RSS failed: ${res.status}`);
  const xml = await res.text();
  const parsed = newsXmlParser.parse(xml);
  const rawItems = (parsed && parsed.rss && parsed.rss.channel && parsed.rss.channel.item) || [];
  const items = Array.isArray(rawItems) ? rawItems : [rawItems];

  return items.slice(0, 6).map((it) => {
    const source = (it.source && (it.source["#text"] || it.source)) || "";
    return {
      title: cleanNewsTitle(typeof it.title === "string" ? it.title : String(it.title || ""), source),
      url: typeof it.link === "string" ? it.link : "",
      source: typeof source === "string" ? source : "",
      publishedAt: it.pubDate || "",
    };
  }).filter((a) => a.title && a.url);
}

/** Fetch + cache one school's headlines. Best-effort: throws are caught by
 * callers so a news hiccup never blocks adding a team or a scheduled run. */
async function refreshNewsForSchool(school) {
  const articles = await fetchNewsForQuery(`${school} football`);
  await db.collection("newsCache").doc(slugify(school)).set({
    school,
    articles,
    updatedAt: FieldValue.serverTimestamp(),
  });
}

/** Fetch + cache national college-football headlines (not tied to any one
 * school), stored under a fixed doc id ("_national") in the same shared
 * newsCache collection every visitor already reads from. Powers the
 * "News for You" national slice on the homepage. */
async function refreshNationalNews() {
  const articles = await fetchNewsForQuery("college football");
  await db.collection("newsCache").doc("_national").set({
    label: "College Football",
    articles,
    updatedAt: FieldValue.serverTimestamp(),
  });
}

// ---------- callable: runs the moment a user adds a team ----------

/** A session/user ID is either a Firebase Auth uid or a client-generated
 * UUID (crypto.randomUUID()) — this just sanity-checks the shape so nobody
 * can pass a weird path segment in. */
function isValidSessionId(id) {
  return typeof id === "string" && /^[a-zA-Z0-9_-]{8,100}$/.test(id);
}

/** Decides which sessions/{id} a request may read/write. Signed-in users
 * ALWAYS get their own Firebase Auth uid, regardless of what (if anything)
 * the client passes — so one signed-in user can never write into another
 * user's synced account. Signed-out visitors fall back to the client-
 * supplied random session id (their private, per-browser guest list). */
function resolveSessionId(request) {
  if (request.auth && request.auth.uid) return request.auth.uid;
  const sessionId = (request.data && request.data.sessionId) || "";
  if (!isValidSessionId(sessionId)) {
    throw new HttpsError("invalid-argument", "Missing or invalid session.");
  }
  return sessionId;
}

exports.addTeam = onCall({secrets: [CFBD_API_KEY]}, async (request) => {
  const school = ((request.data && request.data.school) || "").trim();
  if (!school) {
    throw new HttpsError("invalid-argument", "Provide a team or school name.");
  }
  const sessionId = resolveSessionId(request);
  const year = (request.data && request.data.year) || currentSeasonYear();
  const apiKey = CFBD_API_KEY.value();

  let team;
  let games;
  let rank = null;
  try {
    const teamsList = await cfbdFetch("/teams/fbs", {year}, apiKey);
    team = findTeamInList(school, teamsList);
    if (!team) {
      throw new HttpsError("not-found", `Couldn't find an FBS team matching "${school}".`);
    }
    const [rankMap] = await Promise.all([fetchRankingsMap(year, apiKey)]);
    const logoLookup = buildLogoLookup(teamsList);
    rank = rankMap.get(team.school.toLowerCase()) || null;
    games = await buildSchedule(team.school, year, apiKey, logoLookup, rankMap);
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    logger.error("addTeam failed", err);
    throw new HttpsError("unavailable", "Couldn't reach the schedule data source. Try again in a moment.");
  }

  const teamId = slugify(team.school);
  const sessionRef = db.collection("sessions").doc(sessionId);

  await sessionRef.collection("teams").doc(teamId).set({
    school: team.school,
    mascot: team.mascot || null,
    conference: team.conference || null,
    color: team.color || "#1B2333",
    logo: (team.logos && team.logos[0]) || null,
    rank,
    year,
    // A big, ever-increasing number so a newly added team naturally sorts
    // after any tab a user has drag-reordered (those get small integer
    // indices — see reorderTeams — which will always be far smaller).
    order: Date.now(),
    addedAt: FieldValue.serverTimestamp(),
  });
  await sessionRef.collection("schedules").doc(teamId).set({
    games,
    updatedAt: FieldValue.serverTimestamp(),
  });

  try {
    await refreshNewsForSchool(team.school);
  } catch (err) {
    logger.error(`addTeam: news fetch failed for ${team.school}`, err);
  }
  try {
    await refreshNationalNews();
  } catch (err) {
    logger.error("addTeam: national news fetch failed", err);
  }

  return {
    teamId,
    school: team.school,
    mascot: team.mascot,
    color: team.color,
    rank,
    gameCount: games.length,
  };
});

// ---------- callable: remove a tracked team ----------

exports.removeTeam = onCall(async (request) => {
  const teamId = request.data && request.data.teamId;
  if (!teamId) throw new HttpsError("invalid-argument", "Missing teamId.");
  const sessionId = resolveSessionId(request);
  const sessionRef = db.collection("sessions").doc(sessionId);
  await sessionRef.collection("teams").doc(teamId).delete();
  await sessionRef.collection("schedules").doc(teamId).delete();
  return {ok: true};
});

// ---------- callable: persist a drag-reordered tab order ----------

/** Rewrites every listed team's `order` field to its position in the array
 * (0, 1, 2, ...), so drag-reordering tabs on one device sticks — including
 * across devices for a signed-in account. `order` is compared against the
 * newer team's `Date.now()`-based default in the frontend's sort, so a
 * freshly added team always lands after anything already reordered. */
exports.reorderTeams = onCall(async (request) => {
  const order = (request.data && request.data.order) || [];
  if (!Array.isArray(order) || !order.length || order.some((id) => typeof id !== "string")) {
    throw new HttpsError("invalid-argument", "Provide an ordered array of teamIds.");
  }
  const sessionId = resolveSessionId(request);
  const sessionRef = db.collection("sessions").doc(sessionId);
  const batch = db.batch();
  order.forEach((teamId, i) => {
    batch.set(sessionRef.collection("teams").doc(teamId), {order: i}, {merge: true});
  });
  await batch.commit();
  return {ok: true};
});

// ---------- callable: merge a guest's teams into a newly signed-in account ----------

exports.claimSession = onCall(async (request) => {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Sign in before claiming a session.");
  }
  const guestSessionId = (request.data && request.data.guestSessionId) || "";
  if (!isValidSessionId(guestSessionId)) {
    throw new HttpsError("invalid-argument", "Missing or invalid guest session.");
  }
  if (guestSessionId === request.auth.uid) return {merged: 0}; // nothing to do

  const guestRef = db.collection("sessions").doc(guestSessionId);
  const accountRef = db.collection("sessions").doc(request.auth.uid);

  const guestTeams = await guestRef.collection("teams").get();
  let merged = 0;
  for (const doc of guestTeams.docs) {
    const accountTeamRef = accountRef.collection("teams").doc(doc.id);
    const existing = await accountTeamRef.get();
    if (existing.exists) continue; // never clobber a team already in the account
    await accountTeamRef.set(doc.data());
    const guestSchedule = await guestRef.collection("schedules").doc(doc.id).get();
    if (guestSchedule.exists) {
      await accountRef.collection("schedules").doc(doc.id).set(guestSchedule.data());
    }
    merged++;
  }
  return {merged};
});

// ---------- scheduled: refresh every tracked team's schedule nightly ----------

exports.nightlyRefresh = onSchedule(
    {
      schedule: "0 9 * * *", // 09:00 UTC ≈ 4-5am US Eastern, depending on DST
      timeZone: "Etc/UTC",
      secrets: [CFBD_API_KEY],
    },
    async () => {
      const apiKey = CFBD_API_KEY.value();
      // collectionGroup finds every "teams" subcollection across every
      // session, so one nightly run refreshes every browser's tracked teams.
      const snap = await db.collectionGroup("teams").get();
      logger.info(`nightlyRefresh: refreshing ${snap.size} team(s) across all sessions`);

      // Teams are almost always all tracked for the same current season, but
      // fetch /teams/fbs + /rankings once per distinct year seen (not once
      // per team) so a mixed-year edge case still works without hammering
      // the API.
      const yearData = new Map(); // year -> {logoLookup, rankMap}
      async function getYearData(year) {
        if (!yearData.has(year)) {
          const teamsList = await cfbdFetch("/teams/fbs", {year}, apiKey);
          const [rankMap] = await Promise.all([fetchRankingsMap(year, apiKey)]);
          yearData.set(year, {logoLookup: buildLogoLookup(teamsList), rankMap});
        }
        return yearData.get(year);
      }

      for (const doc of snap.docs) {
        const data = doc.data();
        const sessionRef = doc.ref.parent.parent; // sessions/{sessionId}
        const year = data.year || currentSeasonYear();
        try {
          const {logoLookup, rankMap} = await getYearData(year);
          const games = await buildSchedule(data.school, year, apiKey, logoLookup, rankMap);
          await sessionRef.collection("schedules").doc(doc.id).set({
            games,
            updatedAt: FieldValue.serverTimestamp(),
          });
          const rank = rankMap.get((data.school || "").toLowerCase()) || null;
          await doc.ref.update({rank});
        } catch (err) {
          logger.error(`nightlyRefresh: failed for ${data.school} (session ${sessionRef.id})`, err);
        }
      }
    },
);

// ---------- scheduled: refresh cached news for every tracked school ----------

exports.refreshNews = onSchedule(
    {
      schedule: "0 */6 * * *", // every 6 hours — news moves faster than schedules
      timeZone: "Etc/UTC",
    },
    async () => {
      const snap = await db.collectionGroup("teams").get();
      const schools = new Set(snap.docs.map((doc) => doc.data().school).filter(Boolean));
      logger.info(`refreshNews: refreshing ${schools.size} distinct school(s)`);

      try {
        await refreshNationalNews();
      } catch (err) {
        logger.error("refreshNews: national news failed", err);
      }

      for (const school of schools) {
        try {
          await refreshNewsForSchool(school);
        } catch (err) {
          logger.error(`refreshNews: failed for ${school}`, err);
        }
      }
    },
);
