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

  const playerCache = {};

  /**
   * Look up a player by nickname.
   *
   * Args:
   *   nickname: string — FACEIT display name.
   *
   * Returns:
   *   Promise<object|null> — player object, or null on error.
   */
  async function fetchPlayerByNickname(nickname) {
    if (playerCache[nickname] !== undefined) {
      return playerCache[nickname];
    }
    try {
      const data = await throttledFetch(
        BASE + "/players?nickname=" + encodeURIComponent(nickname)
      );
      playerCache[nickname] = data;
      return data;
    } catch (e) {
      playerCache[nickname] = null;
      return null;
    }
  }

  window.ESEA = window.ESEA || {};
  window.ESEA.api = {
    fetchMatch,
    fetchPlayerHistory,
    fetchMatchStats,
    fetchPlayerByNickname,
  };
})();
