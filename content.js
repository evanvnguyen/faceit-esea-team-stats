/**
 * ESEA Team Stats — content script.
 *
 * Detects FACEIT match room pages, fetches per-player stats
 * aggregated across all matches played under their team,
 * and injects a stats table at the bottom of the page.
 */
(function () {
  "use strict";

  const CONTAINER_ID = "esea-team-stats-container";
  const POLL_INTERVAL_MS = 1500;

  let lastUrl = "";
  let isLoading = false;

  /* ------------------------------------------------------------------ */
  /*  URL helpers                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Extract match ID from the current URL.
   *
   * Returns:
   *   string|null — match ID like "1-abcdef..." or null if not on a match page.
   */
  function getMatchIdFromUrl() {
    const m = window.location.pathname.match(/\/room\/(1-[a-f0-9-]+)/);
    return m ? m[1] : null;
  }

  /* ------------------------------------------------------------------ */
  /*  Data fetching & aggregation                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Find all matches a player played under a given team name.
   *
   * Args:
   *   playerId: string — player UUID.
   *   teamName: string — team name to filter by (case-insensitive).
   *   competitionId: string — championship UUID to scope stats to current season.
   *
   * Returns:
   *   Promise<Array<string>> — list of match IDs.
   */
  async function findTeamMatches(playerId, teamName, competitionId, fromTimestamp) {
    const history = await ESEA.api.fetchPlayerHistory(playerId, fromTimestamp);
    const target = teamName.toLowerCase();
    const matchIds = [];

    for (const match of history) {
      if (match.competition_id !== competitionId) continue;

      const teams = match.teams || {};
      for (const fk of ["faction1", "faction2"]) {
        const team = teams[fk] || {};
        const name = (team.nickname || team.name || "").toLowerCase();
        if (name !== target) continue;

        const players = team.players || team.roster || [];
        const isOnTeam = players.some((p) => p.player_id === playerId);
        if (isOnTeam) {
          matchIds.push(match.match_id);
        }
      }
    }

    return matchIds;
  }

  /**
   * Extract team names and one player ID per team from match data.
   *
   * Args:
   *   matchData: object — match object from the API.
   *
   * Returns:
   *   Array<{name: string, factionKey: string, samplePlayer: {player_id, nickname}}>
   */
  function extractTeams(matchData) {
    const teams = matchData.teams || {};
    const result = [];

    for (const fk of ["faction1", "faction2"]) {
      const faction = teams[fk] || {};
      if (faction.type === "bye") continue;

      const name = faction.name || faction.nickname || "Unknown";
      const roster = faction.roster || faction.players || [];
      if (roster.length === 0) continue;

      result.push({
        name,
        factionKey: fk,
        samplePlayer: { player_id: roster[0].player_id, nickname: roster[0].nickname },
      });
    }

    return result;
  }

  /**
   * Aggregate stats for all players found on a team across match stats.
   * Discovers players from the match stats themselves.
   *
   * Args:
   *   matchIds: Array<string> — match IDs (stats already cached).
   *   teamName: string — team name to match (case-insensitive).
   *
   * Returns:
   *   Array<{nickname, faceit_url, ...stats}> — rows for every player who appeared.
   */
  async function aggregateTeamPlayers(matchIds, teamName) {
    const target = teamName.toLowerCase();
    const aggMap = new Map();
    const nickMap = new Map();

    for (const matchId of matchIds) {
      const stats = await ESEA.api.fetchMatchStats(matchId);
      if (!stats) continue;

      for (const round of stats.rounds || []) {
        const matchRounds = parseInt(round.round_stats?.Rounds || "0", 10);

        for (const team of round.teams || []) {
          const name = (team.team_stats?.Team || "").toLowerCase();
          if (name !== target) continue;

          for (const p of team.players || []) {
            if (!aggMap.has(p.player_id)) {
              aggMap.set(p.player_id, {
                matches: 0,
                kills: 0,
                assists: 0,
                deaths: 0,
                doubleKills: 0,
                tripleKills: 0,
                quadroKills: 0,
                pentaKills: 0,
                oneVOneWins: 0,
                oneVTwoWins: 0,
                totalDamage: 0,
                totalRounds: 0,
                hsKillsEstimate: 0,
              });
              nickMap.set(p.player_id, p.nickname);
            }

            const agg = aggMap.get(p.player_id);
            const s = p.player_stats || {};
            agg.matches++;
            agg.kills += parseInt(s.Kills || "0", 10);
            agg.assists += parseInt(s.Assists || "0", 10);
            agg.deaths += parseInt(s.Deaths || "0", 10);
            agg.doubleKills += parseInt(s["Double Kills"] || "0", 10);
            agg.tripleKills += parseInt(s["Triple Kills"] || "0", 10);
            agg.quadroKills += parseInt(s["Quadro Kills"] || "0", 10);
            agg.pentaKills += parseInt(s["Penta Kills"] || "0", 10);
            agg.oneVOneWins += parseInt(s["1v1Wins"] || "0", 10);
            agg.oneVTwoWins += parseInt(s["1v2Wins"] || "0", 10);
            agg.totalDamage += parseInt(s.Damage || "0", 10);
            agg.totalRounds += matchRounds;

            const hsPct = parseFloat(s["Headshots %"] || "0");
            const kills = parseInt(s.Kills || "0", 10);
            agg.hsKillsEstimate += Math.round((hsPct / 100) * kills);
          }
        }
      }
    }

    const rows = [];
    for (const [pid, agg] of aggMap) {
      const nick = nickMap.get(pid);
      rows.push({
        nickname: nick,
        faceit_url: "https://www.faceit.com/en/players/" + nick,
        ...agg,
      });
    }
    return rows;
  }

  async function loadAllStats(matchId, onProgress) {
    onProgress("Getting current season stats...");
    const matchData = await ESEA.api.fetchMatch(matchId);
    const competitionId = matchData.competition_id;
    const competitionName = matchData.competition_name || "";
    currentCompetitionName = competitionName;
    const teams = extractTeams(matchData);

    const FOUR_MONTHS_SEC = 4 * 30 * 24 * 60 * 60;
    const matchStartedAt = matchData.started_at || matchData.configured_at || 0;
    const fromTimestamp = matchStartedAt > 0 ? matchStartedAt - FOUR_MONTHS_SEC : 0;

    onProgress("Getting current season stats... (finding matches)");
    const teamMatchResults = await Promise.all(
      teams.map((team) =>
        findTeamMatches(team.samplePlayer.player_id, team.name, competitionId, fromTimestamp)
      )
    );

    const allMatchIds = new Set();
    for (const ids of teamMatchResults) {
      for (const id of ids) allMatchIds.add(id);
    }

    onProgress("Getting current season stats... (" + allMatchIds.size + " matches)");
    await Promise.all(
      Array.from(allMatchIds).map((id) => ESEA.api.fetchMatchStats(id))
    );

    onProgress("Getting current season stats... (almost done)");
    const teamResults = [];
    for (let t = 0; t < teams.length; t++) {
      const rows = await aggregateTeamPlayers(teamMatchResults[t], teams[t].name);
      teamResults.push({ teamName: teams[t].name, rows });
    }

    return { competitionName, teamResults };
  }

  /* ------------------------------------------------------------------ */
  /*  UI rendering                                                       */
  /* ------------------------------------------------------------------ */

  const COLUMNS = [
    { key: "matches", label: "M", title: "Matches" },
    { key: "kills", label: "K", title: "Kills" },
    { key: "assists", label: "A", title: "Assists" },
    { key: "deaths", label: "D", title: "Deaths" },
    { key: "doubleKills", label: "2K", title: "Double Kills" },
    { key: "tripleKills", label: "3K", title: "Triple Kills" },
    { key: "quadroKills", label: "4K", title: "Quadro Kills" },
    { key: "pentaKills", label: "5K", title: "Penta Kills" },
    { key: "oneVOneWins", label: "1v1", title: "1v1 Wins" },
    { key: "oneVTwoWins", label: "1v2", title: "1v2 Wins" },
    { key: "hsp", label: "HSP", title: "Headshot %", computed: true },
    { key: "rp", label: "RP", title: "Rounds Played", computed: true },
    { key: "adr", label: "ADR", title: "Avg Damage/Round", computed: true },
    { key: "kpr", label: "KPR", title: "Kills Per Round", computed: true },
  ];

  /**
   * Compute derived stats from aggregated data.
   *
   * Args:
   *   row: object — aggregated stats for a player.
   *
   * Returns:
   *   object — same object with hsp, rp, adr, fpr added.
   */
  function computeDerived(row) {
    row.rp = row.totalRounds;
    row.hsp =
      row.kills > 0
        ? (row.hsKillsEstimate / row.kills).toFixed(2)
        : "0.00";
    row.adr =
      row.totalRounds > 0
        ? (row.totalDamage / row.totalRounds).toFixed(2)
        : "0.00";
    row.kpr =
      row.totalRounds > 0
        ? (row.kills / row.totalRounds).toFixed(2)
        : "0.00";
    return row;
  }

  /**
   * Remove all child nodes from an element.
   *
   * Args:
   *   el: HTMLElement — element to clear.
   */
  function clearElement(el) {
    while (el.firstChild) {
      el.removeChild(el.firstChild);
    }
  }

  /**
   * Render sorted rows into a tbody element.
   *
   * Args:
   *   tbody: HTMLElement — the tbody to populate.
   *   rows: Array<object> — player stat rows (already computed).
   */
  function renderRows(tbody, rows) {
    while (tbody.firstChild) tbody.removeChild(tbody.firstChild);

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const tr = document.createElement("tr");
      tr.className = i % 2 === 0 ? "esea-row-even" : "esea-row-odd";

      const aliasTd = document.createElement("td");
      aliasTd.className = "esea-col-alias";
      const link = document.createElement("a");
      link.href = row.faceit_url || "#";
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = row.nickname;
      link.className = "esea-player-link";
      aliasTd.appendChild(link);
      tr.appendChild(aliasTd);

      for (const col of COLUMNS) {
        const td = document.createElement("td");
        td.className = "esea-col-stat";
        td.textContent = row[col.key];
        tr.appendChild(td);
      }

      tbody.appendChild(tr);
    }
  }

  /**
   * Build the stats table for one team with sortable column headers.
   *
   * Args:
   *   teamName: string — team display name.
   *   rows: Array<object> — player stat rows.
   *
   * Returns:
   *   HTMLElement — the team stats section.
   */
  function buildTeamTable(teamName, rows) {
    const computedRows = rows.map((r) => computeDerived(r));
    let sortKey = null;
    let sortAsc = false;

    const section = document.createElement("div");
    section.className = "esea-team-section";

    const header = document.createElement("h3");
    header.className = "esea-team-name";
    header.textContent = teamName;
    section.appendChild(header);

    const table = document.createElement("table");
    table.className = "esea-stats-table";

    const colgroup = document.createElement("colgroup");
    const aliasCol = document.createElement("col");
    aliasCol.className = "esea-col-alias";
    colgroup.appendChild(aliasCol);
    for (let i = 0; i < COLUMNS.length; i++) {
      const col = document.createElement("col");
      col.className = "esea-col-stat";
      colgroup.appendChild(col);
    }
    table.appendChild(colgroup);

    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");

    const aliasTh = document.createElement("th");
    aliasTh.textContent = "Alias";
    aliasTh.className = "esea-col-alias esea-col-sortable";
    aliasTh.addEventListener("click", function () {
      applySort("nickname");
    });
    headerRow.appendChild(aliasTh);

    const thElements = {};
    for (const col of COLUMNS) {
      const th = document.createElement("th");
      th.title = col.title;
      th.className = "esea-col-stat esea-col-sortable";
      th.textContent = col.label;
      thElements[col.key] = th;
      th.addEventListener("click", function () {
        applySort(col.key);
      });
      headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    table.appendChild(tbody);
    section.appendChild(table);

    applySort("kills");

    function updateHeaderIndicators() {
      aliasTh.textContent = "Alias";
      aliasTh.classList.toggle("esea-sort-active", sortKey === "nickname");
      if (sortKey === "nickname") {
        aliasTh.textContent = "Alias " + (sortAsc ? "\u25B2" : "\u25BC");
      }
      for (const col of COLUMNS) {
        const th = thElements[col.key];
        th.classList.toggle("esea-sort-active", sortKey === col.key);
        th.textContent = col.label + (sortKey === col.key ? (sortAsc ? " \u25B2" : " \u25BC") : "");
      }
    }

    function applySort(key) {
      if (sortKey === key) {
        sortAsc = !sortAsc;
      } else {
        sortKey = key;
        sortAsc = key === "nickname";
      }
      const sorted = [...computedRows].sort(function (a, b) {
        const va = parseFloat(a[key]);
        const vb = parseFloat(b[key]);
        if (isNaN(va) || isNaN(vb)) {
          const sa = String(a[key] || "").toLowerCase();
          const sb = String(b[key] || "").toLowerCase();
          return sortAsc ? sa.localeCompare(sb) : sb.localeCompare(sa);
        }
        return sortAsc ? va - vb : vb - va;
      });
      renderRows(tbody, sorted);
      updateHeaderIndicators();
    }

    return section;
  }

  /**
   * Render the full stats container with all team tables.
   *
   * Args:
   *   teamResults: Array<{teamName: string, rows: Array}> — data for each team.
   */
  function renderStats(competitionName, teamResults) {
    currentCompetitionName = competitionName || "";
    const container = getOrCreateContainer(matchHeader);
    clearElement(container);

    container.appendChild(buildDropdownHeader("done", ""));

    const body = document.createElement("div");
    body.id = "esea-dropdown-body";
    body.style.display = dropdownOpen ? "" : "none";

    for (const team of teamResults) {
      body.appendChild(buildTeamTable(team.teamName, team.rows));
    }

    container.appendChild(body);
  }

  /**
   * Wait for the match header to appear in the DOM.
   *
   * Returns:
   *   Promise<HTMLElement> — resolves with the header element.
   */
  function waitForHeader() {
    return new Promise((resolve) => {
      const check = () => {
        const header = document.querySelector('[class*="HeaderWrapper-sc"]');
        if (header) return resolve(header);
        setTimeout(check, 500);
      };
      check();
    });
  }

  /**
   * Get or create the extension's container element.
   * Inserts after the match header (Header__Container).
   *
   * Args:
   *   header: HTMLElement — the match header element.
   *
   * Returns:
   *   HTMLElement — the container div.
   */
  function getOrCreateContainer(header) {
    let container = document.getElementById(CONTAINER_ID);
    if (container) return container;

    container = document.createElement("div");
    container.id = CONTAINER_ID;

    if (header && header.parentElement) {
      header.parentElement.insertBefore(container, header.nextSibling);
    } else {
      document.body.appendChild(container);
    }

    return container;
  }

  /**
   * Show a status message in the container.
   *
   * Args:
   *   msg: string — status text to display.
   *   isError: boolean — whether this is an error message.
   */
  let matchHeader = null;
  let dropdownOpen = true;
  let currentCompetitionName = "";

  /**
   * Build the dropdown header element.
   *
   * Args:
   *   state: "loading"|"done"|"error" — current state.
   *   statusMsg: string — status text (shown during loading/error).
   *
   * Returns:
   *   HTMLElement — the header button.
   */
  function buildDropdownHeader(state, statusMsg) {
    const header = document.createElement("button");
    header.className = "esea-dropdown-header";
    header.type = "button";

    const left = document.createElement("div");
    left.className = "esea-dropdown-left";

    if (state === "loading") {
      const spinner = document.createElement("div");
      spinner.className = "esea-spinner";
      left.appendChild(spinner);
    } else if (state === "done") {
      const check = document.createElement("span");
      check.className = "esea-checkmark";
      check.textContent = "\u2713";
      left.appendChild(check);
    } else if (state === "error") {
      const x = document.createElement("span");
      x.className = "esea-error-icon";
      x.textContent = "\u2717";
      left.appendChild(x);
    }

    const textWrap = document.createElement("div");
    textWrap.className = "esea-dropdown-text";

    const title = document.createElement("span");
    title.className = "esea-dropdown-title";
    title.textContent = (currentCompetitionName || "ESEA Team Statistics") + " - Season Stats";
    textWrap.appendChild(title);

    if (state === "loading" && statusMsg) {
      const status = document.createElement("span");
      status.className = "esea-dropdown-status";
      status.textContent = statusMsg;
      textWrap.appendChild(status);
    }

    left.appendChild(textWrap);
    header.appendChild(left);

    const arrow = document.createElement("span");
    arrow.className = dropdownOpen ? "esea-arrow esea-arrow-up" : "esea-arrow esea-arrow-down";
    header.appendChild(arrow);

    header.addEventListener("click", function () {
      dropdownOpen = !dropdownOpen;
      const body = document.getElementById("esea-dropdown-body");
      if (body) {
        body.style.display = dropdownOpen ? "" : "none";
      }
      arrow.className = dropdownOpen ? "esea-arrow esea-arrow-up" : "esea-arrow esea-arrow-down";
    });

    return header;
  }

  function showStatus(msg, isError) {
    const container = getOrCreateContainer(matchHeader);
    clearElement(container);

    const state = isError ? "error" : "loading";
    container.appendChild(buildDropdownHeader(state, msg));

    if (isError) {
      const body = document.createElement("div");
      body.id = "esea-dropdown-body";

      const errMsg = document.createElement("p");
      errMsg.className = "esea-status esea-error";
      errMsg.textContent = msg;
      body.appendChild(errMsg);

      const retryBtn = document.createElement("button");
      retryBtn.className = "esea-retry-btn";
      retryBtn.textContent = "Retry";
      retryBtn.addEventListener("click", function () {
        const matchId = getMatchIdFromUrl();
        if (matchId) {
          isLoading = false;
          run(matchId);
        }
      });
      body.appendChild(retryBtn);

      container.appendChild(body);
    }
  }

  /**
   * Remove the extension's container from the page.
   */
  function removeContainer() {
    const container = document.getElementById(CONTAINER_ID);
    if (container) container.remove();
  }

  /* ------------------------------------------------------------------ */
  /*  Main orchestration                                                 */
  /* ------------------------------------------------------------------ */

  /**
   * Check if the current match page is an ESEA League match.
   * Waits for the page to render, then looks for the ESEA League badge.
   *
   * Returns:
   *   Promise<boolean> — true if ESEA League badge is found.
   */
  function isEseaMatch() {
    return new Promise((resolve) => {
      let attempts = 0;
      const check = () => {
        const badge = document.querySelector('a[href*="league/ESEA"]');
        if (badge) {
          return resolve(true);
        }
        attempts++;
        if (attempts > 10) return resolve(false);
        setTimeout(check, 500);
      };
      check();
    });
  }

  /**
   * Main entry point — runs when a match page is detected.
   *
   * Args:
   *   matchId: string — the match UUID from the URL.
   */
  async function run(matchId) {
    if (isLoading) return;
    isLoading = true;

    try {
      matchHeader = await waitForHeader();

      const esea = await isEseaMatch();
      if (!esea) return;

      showStatus("Getting current season stats...", false);

      const result = await loadAllStats(matchId, (msg) => {
        showStatus(msg, false);
      });

      renderStats(result.competitionName, result.teamResults);
    } catch (err) {
      showStatus("Error: " + err.message, true);
    } finally {
      isLoading = false;
    }
  }

  /**
   * Check for URL changes and trigger data loading on match pages.
   * Handles FACEIT's SPA client-side routing.
   */
  function poll() {
    const url = window.location.href;
    if (url === lastUrl) return;
    lastUrl = url;

    const matchId = getMatchIdFromUrl();
    if (matchId) {
      run(matchId);
    } else {
      matchHeader = null;
      removeContainer();
    }
  }

  poll();
  setInterval(poll, POLL_INTERVAL_MS);

  /* ------------------------------------------------------------------ */
  /*  Player card league injection                                       */
  /* ------------------------------------------------------------------ */

  const LEAGUE_BADGE_CLASS = "esea-league-badge";
  const leagueCache = {};

  /**
   * Fetch active leagues for a player by nickname.
   *
   * Args:
   *   nickname: string — FACEIT display name.
   *
   * Returns:
   *   Promise<Array<{name: string, team: string}>> — active championships.
   */
  async function fetchPlayerLeagues(nickname) {
    if (leagueCache[nickname] !== undefined) {
      return leagueCache[nickname];
    }

    const player = await ESEA.api.fetchPlayerByNickname(nickname);
    if (!player) {
      leagueCache[nickname] = [];
      return [];
    }

    try {
      const res = await fetch(
        "/api/team-leagues/v1/users/" + player.player_id + "/profile/leagues/info",
        { headers: { accept: "application/json" }, credentials: "include" }
      );
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();

      const leagues = [];
      for (const league of data.payload || []) {
        const seasons = league.league_seasons_info || [];
        if (seasons.length === 0) continue;
        const latest = seasons[0];
        for (const team of latest.season_teams_info || []) {
          if (!team.is_active) continue;
          const standing = team.team_standing || {};
          const division = standing.division_name || "";
          const record = standing.wins + "-" + standing.losses;
          leagues.push({
            name: "S" + latest.season_number + (division ? " " + division : ""),
            team: team.premade_team_name || "",
            teamId: team.premade_team_id || "",
            record,
          });
        }
      }

      leagueCache[nickname] = leagues;
      return leagues;
    } catch (e) {
      leagueCache[nickname] = [];
      return [];
    }
  }

  /**
   * Inject league info into a player card popover.
   *
   * Args:
   *   popover: HTMLElement — the popover container element.
   */
  async function injectLeagueInfo(popover) {
    if (popover.querySelector("." + LEAGUE_BADGE_CLASS)) return;

    const nameEl = popover.querySelector('[class*="Name-sc"]');
    if (!nameEl) return;
    const nickname = nameEl.textContent.trim();
    if (!nickname) return;

    const placeholder = document.createElement("div");
    placeholder.className = LEAGUE_BADGE_CLASS;
    placeholder.textContent = "Loading leagues...";

    const statsBox = popover.querySelector('[class*="RatingsAndStats__BoxedContainer"]');
    if (statsBox) {
      statsBox.parentElement.insertBefore(placeholder, statsBox);
    } else {
      const nameContainer = nameEl.closest('[class*="NameContainer"]');
      if (nameContainer && nameContainer.parentElement) {
        nameContainer.parentElement.insertBefore(placeholder, nameContainer.nextSibling);
      } else {
        return;
      }
    }

    try {
      const leagues = await fetchPlayerLeagues(nickname);
      if (leagues.length === 0) {
        placeholder.remove();
        return;
      }

      placeholder.textContent = "";
      for (const league of leagues) {
        const row = document.createElement("div");
        row.className = "esea-league-row";
        const nameSpan = document.createElement("span");
        nameSpan.className = "esea-league-name";
        nameSpan.textContent = league.name;
        row.appendChild(nameSpan);
        if (league.team) {
          const teamLink = document.createElement("a");
          teamLink.className = "esea-league-team";
          teamLink.textContent = league.team;
          if (league.record) {
            const parts = league.record.split("-");
            const recordSpan = document.createElement("span");
            recordSpan.className = "esea-league-record";
            const wins = document.createElement("span");
            wins.className = "esea-record-wins";
            wins.textContent = parts[0];
            const dash = document.createTextNode("-");
            const losses = document.createElement("span");
            losses.className = "esea-record-losses";
            losses.textContent = parts[1];
            recordSpan.appendChild(document.createTextNode(" ("));
            recordSpan.appendChild(wins);
            recordSpan.appendChild(dash);
            recordSpan.appendChild(losses);
            recordSpan.appendChild(document.createTextNode(")"));
            teamLink.appendChild(recordSpan);
          }
          teamLink.href = league.teamId
            ? "https://www.faceit.com/en/teams/" + league.teamId
            : "#";
          teamLink.target = "_blank";
          teamLink.rel = "noopener noreferrer";
          row.appendChild(teamLink);
        }
        placeholder.appendChild(row);
      }
    } catch (e) {
      placeholder.remove();
    }
  }

  /**
   * Observe DOM for player card popovers appearing.
   */
  const cardObserver = new MutationObserver(function (mutations) {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        const popover = node.querySelector
          ? node.querySelector('[class*="PopoverStyled"]') || (node.matches && node.matches('[class*="PopoverStyled"]') ? node : null)
          : null;
        if (popover) {
          injectLeagueInfo(popover);
        }
      }
    }
  });

  cardObserver.observe(document.body, { childList: true, subtree: true });
})();
