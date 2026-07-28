// ============================================================================
// battle.js — wraps @pkmn/sim for roguelike battles.
//  * Injects persistent HP / status / PP from run state into the live battle.
//  * Extracts state back out when the battle ends (attrition).
//  * Adds a hidden "Celebrate" slot so throwing a ball / using an item
//    consumes the player's turn while the wild Pokemon still acts.
// ============================================================================
(function () {
  var PS = window.PS;
  var Dex = PS.Dex, Teams = PS.Teams, BS = PS.BattleStreams;
  var C = window.Core;

  var IDLE_MOVE = 'celebrate';

  function parseHp(str) {
    if (!str || String(str).indexOf('fnt') >= 0) return 0;
    var m = String(str).match(/^(\d+)(?:\/(\d+))?/);
    if (!m) return 1;
    if (!m[2]) return Math.max(0, Math.min(1, +m[1] / 100));
    return Math.max(0, +m[1] / (+m[2] || 1));
  }

  // ---- Heuristic AI for the opposing side --------------------------------
  function chooseAIMove(request, myTypes, foeTypes, foeHpFrac) {
    if (!request || !request.active || !request.active[0]) return 'default';
    var moves = request.active[0].moves || [];
    var best = null, bestScore = -1;
    for (var i = 0; i < moves.length; i++) {
      var mv = moves[i];
      if (mv.disabled || mv.pp === 0) continue;
      var d = Dex.moves.get(mv.id || mv.move);
      var score;
      if (d.category === 'Status') {
        score = 12 + Math.random() * 8;
      } else {
        var eff = C.typeMod(d.type, foeTypes);
        var stab = myTypes.indexOf(d.type) >= 0 ? 1.5 : 1;
        var acc = d.accuracy === true ? 1 : d.accuracy / 100;
        score = (d.basePower || 0) * eff * stab * acc;
        if (eff === 0) score = 0;
        score += Math.random() * 5;
      }
      if (score > bestScore) { bestScore = score; best = i + 1; }
    }
    return best ? 'move ' + best : 'default';
  }

  // ------------------------------------------------------------------------
  // startBattle(cfg) where cfg = {
  //   playerMons:[mon...], enemyMons:[mon...], leadIndex, isWild,
  //   handlers:{ onLog, onRequest, onEnd, onError }
  // }
  // ------------------------------------------------------------------------
  function startBattle(cfg) {
    var handlers = cfg.handlers || {};
    var playerMons = cfg.playerMons, enemyMons = cfg.enemyMons;

    // Build packed teams; add the hidden idle move to every player mon so a
    // "use item / throw ball" action always has a legal slot to burn.
    function buildSet(mon, hidden) {
      var set = C.toSet(mon);
      if (hidden && set.moves.indexOf(IDLE_MOVE) < 0 && set.moves.length < 4) {
        // only pad if there's room; otherwise we inject the slot at runtime
      }
      return set;
    }
    var p1Team = playerMons.map(function (m) { return buildSet(m, true); });
    var p2Team = enemyMons.map(function (m) { return buildSet(m, false); });

    var stream = new BS.BattleStream();
    var streams = BS.getPlayerStreams(stream);

    var state = {
      ended: false, turn: 0, escaped: false, caught: false,
      pendingRequest: null, lastRequest: null,
      playerHp: 1, enemyHp: 1,
      playerTypes: playerMons[0].types.slice(),
      enemyTypes: enemyMons[0].types.slice(),
      injected: false
    };

    // ---- IDENTITY MAPPING -------------------------------------------------
    // Showdown REORDERS side.pokemon so the active Pokemon is always index 0.
    // Never map by index. Instead we stamp a stable tag onto each live
    // Pokemon once, and resolve back to our run objects through that tag.
    var byTag = {};                       // tag -> our mon object
    playerMons.forEach(function (m, i) { byTag['p' + i] = m; });
    enemyMons.forEach(function (m, i) { byTag['e' + i] = m; });

    function stampSide(side, prefix) {
      if (!side || !side.pokemon) return false;
      var did = false;
      for (var i = 0; i < side.pokemon.length; i++) {
        var live = side.pokemon[i];
        if (live.__tag) continue;
        // team order holds on the first pass; afterwards __tag rides the object
        live.__tag = prefix + i;
        did = true;
      }
      return did;
    }
    // p2 does not exist yet when we inject persistence (we deliberately write
    // >player p2 last so the starting HP is correct), so tagging must be
    // re-attempted. Cheap and idempotent -- call it before any tag lookup.
    function ensureTags() {
      var b = stream.battle;
      if (!b) return;
      stampSide(b.p1, 'p');
      stampSide(b.p2, 'e');
    }
    function monOf(live) {
      if (!live) return null;
      if (!live.__tag) ensureTags();
      return live.__tag ? byTag[live.__tag] : null;
    }

    // ---- inject persisted HP/status/PP once the battle object exists -----
    function injectPersistence() {
      var b = stream.battle;
      if (!b || state.injected) return;
      if (!b.p1 || !b.p1.pokemon.length) return;
      state.injected = true;
      try {
        stampSide(b.p1, 'p');
        stampSide(b.p2, 'e');
        for (var i = 0; i < b.p1.pokemon.length; i++) {
          var live = b.p1.pokemon[i], mon = monOf(live);
          if (!mon) continue;
          var mx = live.maxhp;
          live.hp = Math.max(0, Math.min(mx, Math.round(mx * mon.hpPct)));
          if (live.hp === 0) { live.fainted = true; live.faintQueued = false; }
          if (mon.status) { try { live.setStatus(mon.status, null, null, true); } catch (e) { live.status = mon.status; } }
          for (var j = 0; j < live.moveSlots.length; j++) {
            var ms = live.moveSlots[j];
            if (mon.pp && mon.pp[ms.id] != null) {
              ms.pp = Math.max(0, Math.min(ms.maxpp, mon.pp[ms.id]));
              if (live.baseMoveSlots[j]) live.baseMoveSlots[j].pp = ms.pp;
            }
          }
          // hidden idle slot for item/ball turns
          if (!live.moveSlots.some(function (s) { return s.id === IDLE_MOVE; })) {
            var slot = { id: IDLE_MOVE, move: 'Celebrate', pp: 64, maxpp: 64, target: 'self', disabled: false, used: false, virtual: true };
            live.moveSlots.push(slot);
            live.baseMoveSlots.push(Object.assign({}, slot));
          }
        }
        // enemy persistent HP
        for (var k = 0; b.p2 && k < b.p2.pokemon.length; k++) {
          var el = b.p2.pokemon[k], em = monOf(el);
          if (!em) continue;
          if (em.hpPct < 1) el.hp = Math.max(1, Math.round(el.maxhp * em.hpPct));
          if (em.status) { try { el.setStatus(em.status, null, null, true); } catch (e) { el.status = em.status; } }
        }
      } catch (e) { console.warn('[battle] inject failed', e); }
    }

    // ---- pull live state back into run mons ------------------------------
    function syncOut() {
      var b = stream.battle;
      if (!b) return;
      ensureTags();
      try {
        for (var i = 0; i < b.p1.pokemon.length; i++) {
          var live = b.p1.pokemon[i], mon = monOf(live);
          if (!mon) continue;
          mon.hpPct = live.maxhp ? Math.max(0, live.hp / live.maxhp) : 0;
          mon.status = live.status || '';
          for (var j = 0; j < live.baseMoveSlots.length; j++) {
            var ms = live.baseMoveSlots[j];
            if (ms.id === IDLE_MOVE) continue;
            if (mon.pp[ms.id] != null) mon.pp[ms.id] = ms.pp;
          }
        }
        for (var k = 0; b.p2 && k < b.p2.pokemon.length; k++) {
          var el = b.p2.pokemon[k], em = monOf(el);
          if (!em) continue;
          em.hpPct = el.maxhp ? Math.max(0, el.hp / el.maxhp) : 0;
          em.status = el.status || '';
          // PP too -- a caught Pokemon must keep the PP it had when captured.
          for (var m = 0; m < el.baseMoveSlots.length; m++) {
            var es = el.baseMoveSlots[m];
            if (es.id === IDLE_MOVE) continue;
            if (em.pp && em.pp[es.id] != null) em.pp[es.id] = es.pp;
          }
        }
      } catch (e) { console.warn('[battle] sync failed', e); }
    }

    function liveEnemy() {
      var b = stream.battle;
      if (!b || !b.p2 || !b.p2.active[0]) return null;
      return b.p2.active[0];
    }
    function livePlayer() {
      var b = stream.battle;
      if (!b || !b.p1 || !b.p1.active[0]) return null;
      return b.p1.active[0];
    }
    // Who should be credited for the damage currently being applied?
    // Prefer the Pokemon that actually used the move this turn (tracked from
    // |move|p1a: X|...), falling back to whoever is on the field.
    var lastAttacker = null;
    // Move a Choice item was locked into before we skipped a turn (see passTurn).
    var choiceRestore = null;
    // Showdown decides which moves a Choice item disables from `lastMove`, so
    // the hidden skip would otherwise lock the Pokemon into Celebrate.
    var lastMoveRestore = null;
    var wasSkipDisabled = false;
    // The volatile keeps its locked move on the effect state, which Showdown
    // exposes both as volatiles.choicelock.move and via getVolatile state.
    function lockedMoveOf(cl) {
      if (!cl) return null;
      return cl.move || (cl.effectState && cl.effectState.move) || null;
    }
    function setLockedMove(cl, id) {
      if (!cl) return;
      if ('move' in cl) cl.move = id;
      if (cl.effectState) cl.effectState.move = id;
    }
    // Rewrite a request's move `disabled` flags to match the real Choice lock.
    function fixChoiceFlags(req) {
      try {
        if (!req || !req.active || !req.active[0] || !req.active[0].moves) return;
        var live = livePlayer();
        if (!live) return;
        var cl = live.volatiles && live.volatiles.choicelock;
        var locked = cl ? lockedMoveOf(cl) : null;
        var moves = req.active[0].moves;
        for (var i = 0; i < moves.length; i++) {
          var id = moves[i].id || moves[i].move;
          if (id === IDLE_MOVE) continue;         // hidden slot, never shown
          if (locked) {
            moves[i].disabled = (id !== locked);
          } else if (wasSkipDisabled) {
            // After using an item/throwing a ball (passTurn), the engine may
            // incorrectly mark moves as disabled because it thinks the player
            // last used Celebrate. Re-enable them unless they're disabled for
            // a legitimate reason (PP = 0 or explicitly marked as such).
            if (moves[i].disabled && moves[i].pp > 0) {
              moves[i].disabled = false;
            }
          }
        }
      } catch (e) {}
    }

    function restoreChoiceLock() {
      var live = livePlayer();
      if (!live) { choiceRestore = null; lastMoveRestore = null; return; }
      // undo "you last used Celebrate"
      try {
        if (live.lastMove && live.lastMove.id === IDLE_MOVE) {
          live.lastMove = lastMoveRestore;
          if (live.moveThisTurn === IDLE_MOVE) live.moveThisTurn = '';
        }
      } catch (e) {}
      lastMoveRestore = null;
      if (!live.volatiles) { choiceRestore = null; wasSkipDisabled = false; return; }
      var cl = live.volatiles.choicelock;
      if (cl) {
        var cur = lockedMoveOf(cl);
        // After the skip the engine re-locks onto our hidden move. Put the real
        // move back, or drop the lock entirely if there wasn't one before.
        if (cur === IDLE_MOVE || cur == null) {
          if (choiceRestore) setLockedMove(cl, choiceRestore);
          else delete live.volatiles.choicelock;
        }
      } else if (choiceRestore) {
        // we removed it for the skip -- put it back
        try {
          live.addVolatile('choicelock');
          var nc = live.volatiles.choicelock;
          if (nc) setLockedMove(nc, choiceRestore);
        } catch (e) {}
      }
      choiceRestore = null;
    }
    function attributionMon() {
      if (lastAttacker && byTag[lastAttacker]) return byTag[lastAttacker];
      return monOf(livePlayer());
    }

    // ---- log parsing ------------------------------------------------------
    function trackLine(line) {
      if (!line || line[0] !== '|') return;
      var p = line.slice(1).split('|');
      var cmd = p[0];
      if (cmd === 'turn') { state.turn = +p[1] || state.turn + 1; lastAttacker = null; }
      else if (cmd === 'move') {
        if ((p[1] || '').indexOf('p1') === 0) {
          var mv = livePlayer();
          lastAttacker = mv && mv.__tag ? mv.__tag : null;
        } else lastAttacker = null;
      }
      else if (cmd === 'switch' || cmd === 'drag' || cmd === 'replace') {
        var ident = p[1] || '', name = (p[2] || '').split(',')[0].trim();
        var sp = Dex.species.get(name);
        var types = sp.exists ? sp.types.slice() : ['Normal'];
        if (ident.indexOf('p1') === 0) { state.playerTypes = types; state.playerHp = parseHp(p[3]); }
        else { state.enemyTypes = types; state.enemyHp = parseHp(p[3]); }
      } else if (cmd === '-damage' || cmd === '-heal' || cmd === '-sethp') {
        var isP1 = (p[1] || '').indexOf('p1') === 0;
        var nf = parseHp(p[2]);
        if (isP1) state.playerHp = nf;
        else {
          // credit damage dealt to the player's active Pokemon (for MVP),
          // but only for real damage, not self-inflicted enemy chip.
          if (cmd === '-damage') {
            var drop = Math.max(0, state.enemyHp - nf);
            // Credit only damage caused by the player's active Pokemon.
            // "[from] <effect>" without "[of]" means passive/self damage
            // (weather, poison, recoil, Life Orb) -> nobody gets credit.
            var fromSelf = /\[from\]/.test(line) && !/\[of\]/.test(line);
            if (drop > 0 && !fromSelf && handlers.onDamage) {
              var el = liveEnemy();
              var attacker = attributionMon();
              if (attacker) handlers.onDamage(drop * (el ? el.maxhp : 100), attacker);
            }
          }
          state.enemyHp = nf;
        }
      } else if (cmd === 'faint') {
        if ((p[1] || '').indexOf('p1') !== 0 && handlers.onKO) {
          var koMon = attributionMon();
          if (koMon) handlers.onKO(koMon);
        }
        if ((p[1] || '').indexOf('p1') === 0) state.playerHp = 0; else state.enemyHp = 0;
      } else if (cmd === 'win' || cmd === 'tie') {
        if (state.ended) return;
        state.ended = true;
        syncOut();
        var win = cmd === 'win' && p[1] === (p1Name);
        if (handlers.onEnd) handlers.onEnd({ result: cmd === 'tie' ? 'tie' : (win ? 'win' : 'loss') });
      }
    }

    // ---- streams ----------------------------------------------------------
    (async function () {
      try {
        for await (var chunk of streams.omniscient) {
          injectPersistence();
          if (handlers.onLog) handlers.onLog(chunk);
          var lines = String(chunk).split('\n');
          for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            if (line.indexOf('|split|') === 0) { line = lines[i + 3] || lines[i + 1] || ''; i += 3; }
            trackLine(line);
          }
        }
      } catch (e) { if (handlers.onError) handlers.onError(e); }
    })();

    (async function () {
      try {
        for await (var chunk of streams.p1) {
          var lines = String(chunk).split('\n');
          for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            if (line.indexOf('|request|') === 0) {
              var body = line.slice(9);
              if (!body || body === 'null') continue;
              var req = null;
              try { req = JSON.parse(body); } catch (e) { continue; }
              injectPersistence();
              restoreChoiceLock();
              // The engine serialises `request` BEFORE we can undo the skip,
              // so its `disabled` flags still reflect "last move = Celebrate".
              // Recompute them from the (now restored) Choice lock.
              fixChoiceFlags(req);
              wasSkipDisabled = false;
              state.pendingRequest = req;
              state.lastRequest = req;
              if (req.teamPreview) { streams.p1.write('default'); continue; }
              if (handlers.onRequest) handlers.onRequest(req);
            } else if (line.indexOf('|error|') === 0) {
              console.warn('[battle] p1 error:', line);
              if (handlers.onRequest && state.lastRequest) handlers.onRequest(state.lastRequest);
            }
          }
        }
      } catch (e) { if (handlers.onError) handlers.onError(e); }
    })();

    (async function () {
      try {
        for await (var chunk of streams.p2) {
          var lines = String(chunk).split('\n');
          for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            if (line.indexOf('|request|') !== 0) continue;
            var body = line.slice(9);
            if (!body || body === 'null') continue;
            var req = null;
            try { req = JSON.parse(body); } catch (e) { continue; }
            if (req.teamPreview) { streams.p2.write('default'); continue; }
            if (req.forceSwitch) {
              // send out next healthy mon
              var side = req.side || {};
              var pk = side.pokemon || [];
              var target = 0;
              for (var s = 0; s < pk.length; s++) {
                if (!pk[s].active && pk[s].condition && pk[s].condition.indexOf('fnt') < 0) { target = s + 1; break; }
              }
              streams.p2.write(target ? 'switch ' + target : 'pass');
              continue;
            }
            if (req.active) {
              streams.p2.write(chooseAIMove(req, state.enemyTypes, state.playerTypes, state.playerHp));
            }
          }
        }
      } catch (e) { if (handlers.onError) handlers.onError(e); }
    })();

    var format = 'gen9customgame@@@+Unobtainable,+Past,+Future,!Team Preview';
    var p1Name = 'Player', p2Name = cfg.isWild ? 'Wild' : (cfg.trainerName || 'Trainer');

    // STAGED START -- important for the HP bar.
    // The battle only actually begins once BOTH players are set, and that is
    // when the |switch| messages (which carry the starting HP) are emitted.
    // So we write >start and >player p1 first, inject our persisted HP/status/PP
    // while the battle is still paused, and only then write >player p2.
    // Result: the very first |switch| already reports the correct HP, so the
    // bar renders accurately instead of starting at 100%.
    streams.omniscient.write('>start ' + JSON.stringify({ formatid: format }));
    streams.omniscient.write('>player p1 ' + JSON.stringify({ name: p1Name, team: Teams.pack(p1Team) }));
    injectPersistence();
    streams.omniscient.write('>player p2 ' + JSON.stringify({ name: p2Name, team: Teams.pack(p2Team) }));

    // ---- public API -------------------------------------------------------
    var api = {
      state: state,
      get battle() { return stream.battle; },

      // mega: null | 'mega' | 'megax' | 'megay'  (from the battle UI toggle)
      chooseMove: function (idx, mega) {
        if (state.ended) return;
        var cmd = 'move ' + (idx + 1);
        if (mega) cmd += ' ' + mega;
        streams.p1.write(cmd);
      },
      chooseSwitch: function (partyIdx) {
        if (state.ended) return;
        streams.p1.write('switch ' + (api.partyIndexToRequestSlot(partyIdx) + 1));
      },
      // SKIP THE PLAYER'S TURN (ball throw / item use).
      //
      // Showdown has no "pass" action in singles, so we still need *an* action
      // for the engine to advance the turn -- we use a hidden, zero-effect
      // slot. Everything it emits is filtered out of the log by app.js, so the
      // player only ever sees "You used a Potion!" followed by the foe's move.
      //
      // Choice items are the tricky part: they lock every other move, which
      // includes our hidden slot, and the write would fail with
      // "[Unavailable choice] ... is disabled". So we lift the lock for this
      // one action and restore it afterwards.
      passTurn: function () {
        if (state.ended) return;
        var b = stream.battle;
        var live = b && b.p1.active[0];
        if (!live) return;
        var slot = -1;
        for (var i = 0; i < live.moveSlots.length; i++) if (live.moveSlots[i].id === IDLE_MOVE) slot = i;
        if (slot < 0) {
          live.moveSlots.push({ id: IDLE_MOVE, move: 'Celebrate', pp: 64, maxpp: 64, target: 'self', disabled: false, used: false, virtual: true });
          slot = live.moveSlots.length - 1;
        }
        live.moveSlots[slot].pp = 64;
        live.moveSlots[slot].disabled = false;

        // lift a Choice lock for this skip only
        choiceRestore = null;
        wasSkipDisabled = true;
        lastMoveRestore = live.lastMove || null;
        try {
          if (live.volatiles && live.volatiles.choicelock) {
            choiceRestore = lockedMoveOf(live.volatiles.choicelock);
            delete live.volatiles.choicelock;
          }
        } catch (e) {}

        streams.p1.write('move ' + (slot + 1));
      },
      // Live info about the wild target, for the catch formula.
      enemyInfo: function () {
        var el = liveEnemy();
        if (!el) return { hpPct: state.enemyHp, status: '', id: enemyMons[state.enemyActiveIdx].id, types: state.enemyTypes };
        return {
          hpPct: el.maxhp ? el.hp / el.maxhp : 0,
          status: el.status || '',
          id: PS.toID(el.species ? el.species.id : el.baseSpecies),
          types: state.enemyTypes
        };
      },
      playerInfo: function () {
        var b = stream.battle, live = b && b.p1.active[0];
        if (!live) return { hpPct: state.playerHp, status: '' };
        return { hpPct: live.maxhp ? live.hp / live.maxhp : 0, status: live.status || '' };
      },
      // The run-object for whoever is currently on the field. Always use this
      // instead of an index -- side.pokemon gets reordered by the engine.
      activeMon: function () { return monOf(livePlayer()); },
      // Index of the active Pokemon inside OUR party array (not the engine's).
      activeIndex: function () {
        var mon = monOf(livePlayer());
        var i = playerMons.indexOf(mon);
        return i < 0 ? 0 : i;
      },
      // Which of OUR party members are legally switchable right now, based on
      // the engine's own request payload (authoritative -- it knows who is
      // fainted and who is already out). Returns [{partyIndex, mon, slot}].
      switchableFromRequest: function (req) {
        var out = [];
        var b = stream.battle;
        var side = req && req.side;
        if (!side || !side.pokemon || !b || !b.p1) return out;
        for (var i = 0; i < side.pokemon.length; i++) {
          var entry = side.pokemon[i];
          if (entry.active) continue;
          if (entry.condition && String(entry.condition).indexOf('fnt') >= 0) continue;
          var live = b.p1.pokemon[i];
          var mon = monOf(live);
          if (!mon) continue;
          var pi = playerMons.indexOf(mon);
          if (pi < 0) continue;
          out.push({ partyIndex: pi, mon: mon, slot: i });
        }
        return out;
      },
      // Switch using an engine request slot directly (no translation).
      chooseSwitchSlot: function (slot) {
        if (state.ended) return;
        streams.p1.write('switch ' + (slot + 1));
      },
      // Map an engine switch-request slot to our party index and back.
      requestSlotToPartyIndex: function (slot) {
        var b = stream.battle;
        if (!b || !b.p1 || !b.p1.pokemon[slot]) return slot;
        var mon = monOf(b.p1.pokemon[slot]);
        var i = playerMons.indexOf(mon);
        return i < 0 ? slot : i;
      },
      partyIndexToRequestSlot: function (partyIdx) {
        var b = stream.battle;
        var mon = playerMons[partyIdx];
        if (!b || !b.p1 || !mon) return partyIdx;
        for (var i = 0; i < b.p1.pokemon.length; i++) {
          if (monOf(b.p1.pokemon[i]) === mon) return i;
        }
        return partyIdx;
      },
      // End the battle early (successful catch or flee).
      finish: function (result) {
        if (state.ended) return;
        state.ended = true;
        syncOut();
        if (handlers.onEnd) handlers.onEnd({ result: result });
        api.destroy();
      },
      sync: syncOut,
      destroy: function () {
        state.ended = true;
        try { streams.omniscient.writeEnd && streams.omniscient.writeEnd(); } catch (e) {}
        try { streams.p1.writeEnd && streams.p1.writeEnd(); } catch (e) {}
        try { streams.p2.writeEnd && streams.p2.writeEnd(); } catch (e) {}
      }
    };
    return api;
  }

  window.RogueBattle = { startBattle: startBattle, IDLE_MOVE: IDLE_MOVE, parseHp: parseHp };
})();
