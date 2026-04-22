/**
 * FACEIT API client with rate limiting and caching for the ESEA Team Stats extension.
 */
(function () {
  "use strict";

  const BASE = "https://open.faceit.com/data/v4";
  const THROTTLE_MS = 0;
  const HISTORY_PAGE_SIZE = 100;
  const API_KEY = "e180425f-e352-4a19-965c-6302ec597d88";

  const statsCache = {};
  let queue = Promise.resolve();

  /**
   * Queue a fetch so requests are spaced THROTTLE_MS apart.
   *
   * Args:
   *   url: string — full URL to fetch.
   *
   * Returns:
   *   Promise<object> — parsed JSON response.
   *
   * Raises:
   *   Error — on non-2xx HTTP status.
   */
  function throttledFetch(url) {
    const request = queue.then(async () => {
      const res = await fetch(url, {
        headers: { Authorization: "Bearer " + API_KEY },
      });
      if (!res.ok) {
        throw new Error("HTTP " + res.status + " for " + url);
      }
      return res.json();
    });

    queue = request
      .then(() => new Promise((r) => setTimeout(r, THROTTLE_MS)))
      .catch(() => new Promise((r) => setTimeout(r, THROTTLE_MS)));

    return request;
  }

  /**
   * Fetch a single match by ID.
   *
   * Args:
   *   matchId: string — the match UUID (e.g. "1-abcdef...").
   *
   * Returns:
   *   Promise<object> — match object with teams, results, etc.
   */
  async function fetchMatch(matchId) {
    return throttledFetch(BASE + "/matches/" + matchId);
  }

  /**
   * Fetch full match history for a player (paginated).
   *
   * Args:
   *   playerId: string — the player UUID.
   *
   * Returns:
   *   Promise<Array<object>> — all match history items.
   */
  async function fetchPlayerHistory(playerId, fromTimestamp) {
    const all = [];
    let offset = 0;

    while (true) {
      let url =
        BASE +
        "/players/" +
        playerId +
        "/history?game=cs2&offset=" +
        offset +
        "&limit=" +
        HISTORY_PAGE_SIZE;
      if (fromTimestamp) {
        url += "&from=" + fromTimestamp;
      }
      try {
        const data = await throttledFetch(url);
        const items = data.items || [];
        all.push(...items);
        if (items.length < HISTORY_PAGE_SIZE) break;
        offset += HISTORY_PAGE_SIZE;
      } catch (e) {
        break;
      }
    }

    return all;
  }

  /**
   * Fetch per-player stats for a match. Results are cached.
   *
   * Args:
   *   matchId: string — the match UUID.
   *
   * Returns:
   *   Promise<object|null> — stats object with rounds[], or null on 404.
   */
  async function fetchMatchStats(matchId) {
    if (statsCache[matchId] !== undefined) {
      return statsCache[matchId];
    }

    try {
      const data = await throttledFetch(BASE + "/matches/" + matchId + "/stats");
      statsCache[matchId] = data;
      return data;
    } catch (e) {
      statsCache[matchId] = null;
      return null;
    }
  }

  /**
   * Fetch team subscriptions for a championship.
   * Stops early if all target teams are found.
   *
   * Args:
   *   championshipId: string — the championship UUID.
   *   targetNames: Set<string>|null — lowercase team names to find. Stops when all found.
   *
   * Returns:
   *   Promise<Array<object>> — matching subscription items with team rosters.
   */
  async function fetchChampionshipSubscriptions(championshipId, targetNames) {
    const found = [];
    const remaining = targetNames ? new Set(targetNames) : null;
    let offset = 0;
    const limit = 100;

    while (true) {
      const url =
        BASE +
        "/championships/" +
        championshipId +
        "/subscriptions?offset=" +
        offset +
        "&limit=" +
        limit;
      const data = await throttledFetch(url);
      const items = data.items || [];

      for (const item of items) {
        const name = (item.team?.name || "").toLowerCase();
        if (!remaining || remaining.has(name)) {
          found.push(item);
          if (remaining) remaining.delete(name);
        }
      }

      if (remaining && remaining.size === 0) break;
      if (items.length < limit) break;
      offset += limit;
    }

    return found;
  }

  window.ESEA = window.ESEA || {};
  window.ESEA.api = {
    fetchMatch,
    fetchPlayerHistory,
    fetchMatchStats,
    fetchChampionshipSubscriptions,
  };
})();
