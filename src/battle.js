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
  //
  // The old version scored damage only and gave EVERY status move a flat
  // 12-20. That made status a coin flip: it would Toxic an already-poisoned
  // target, set up on the turn it was about to be knocked out, and Thunder
  // Wave a Ground type. It also meant a wall and a sweeper played identically.
  //
  // This version scores against the actual board state: current HP on both
  // sides, existing status, stat boosts, the speed race, immunities and a real
  // damage estimate. `depth` (from the ascension tier) raises how much of that
  // context it is allowed to use, so early trainers stay beatable.
  var STATUS_MOVES = {
    thunderwave: { kind: 'status', status: 'par' },
    willowisp:   { kind: 'status', status: 'brn' },
    toxic:       { kind: 'status', status: 'tox' },
    glare:       { kind: 'status', status: 'par' },
    sleeppowder: { kind: 'status', status: 'slp' },
    spore:       { kind: 'status', status: 'slp' },
    hypnosis:    { kind: 'status', status: 'slp' },
    yawn:        { kind: 'status', status: 'slp' },
    darkvoid:    { kind: 'status', status: 'slp' }
  };
  var RECOVERY_MOVES = {
    recover: 1, roost: 1, softboiled: 1, moonlight: 1, morningsun: 1, synthesis: 1,
    slackoff: 1, milkdrink: 1, shoreup: 1, rest: 1, strengthsap: 1, wish: 1
  };
  var SETUP_MOVES = {
    swordsdance: 2, nastyplot: 2, dragondance: 2, calmmind: 1, bulkup: 1, quiverdance: 2,
    shellsmash: 3, irondefense: 1, agility: 1, rockpolish: 1, growth: 1, workup: 1,
    honeclaws: 1, curse: 1, bellydrum: 3, tailglow: 3, victorydance: 2
  };
  var HAZARD_MOVES = { stealthrock: 1, spikes: 1, toxicspikes: 1, stickyweb: 1 };
  var PIVOT_MOVES = { uturn: 1, voltswitch: 1, flipturn: 1, partingshot: 1 };

  // Status immunity by type -- Thunder Wave into a Ground type is a wasted
  // turn the old AI took happily.
  //
  // TWO separate immunities have to be checked, and missing either one wastes
  // a turn:
  //   1. STATUS immunity  -- a Fire type cannot be burned, a Steel type cannot
  //                          be poisoned, an Electric type cannot be paralysed.
  //   2. TYPE immunity    -- Thunder Wave is an Electric MOVE, so a Ground type
  //                          is immune to it even though Ground types can be
  //                          paralysed by Glare or Stun Spore just fine.
  function statusLands(status, foeTypes, moveType) {
    var t = (foeTypes || []).map(function (x) { return String(x).toLowerCase(); });
    if (status === 'par' && t.indexOf('electric') >= 0) return false;
    if (status === 'brn' && t.indexOf('fire') >= 0) return false;
    if ((status === 'tox' || status === 'psn') &&
        (t.indexOf('poison') >= 0 || t.indexOf('steel') >= 0)) return false;
    // Powder moves don't affect Grass types (or Overcoat holders, which we
    // can't see from here).
    if (status === 'slp' && t.indexOf('grass') >= 0) return false;
    // A status move still has a type, and a type-immune target ignores it.
    // Normal/Fighting moves have no immunity worth modelling here, but
    // Electric->Ground and Psychic->Dark are exactly the cases that matter.
    if (moveType && moveType !== 'Normal' && C.typeMod(moveType, foeTypes || []) === 0) return false;
    return true;
  }

  // ctx = { myHp, foeHp, foeStatus, myStatus, boosts, faster, myTypes, foeTypes,
  //         role, depth, hasRecovery }
  function scoreAIMove(d, ctx) {
    var eff = C.typeMod(d.type, ctx.foeTypes);
    var stab = ctx.myTypes.indexOf(d.type) >= 0 ? 1.5 : 1;
    var acc = d.accuracy === true ? 1 : d.accuracy / 100;
    var depth = ctx.depth || 0;
    // Tie-breaking jitter. A Daily is a shared, scoreable puzzle, so the AI's
    // decisions must be reproducible for everyone on that day: the caller
    // passes a seeded `rand` derived from the run seed + battle slot. Free
    // Play passes nothing and keeps real randomness.
    var jitter = ctx.rand ? ctx.rand() : Math.random();

    if (d.category !== 'Status') {
      if (eff === 0) return 0;
      var power = (d.basePower || 0);
      if (d.multihit) power *= (typeof d.multihit === 'number' ? d.multihit : 3);
      var score = power * eff * stab * acc;
      // A boosted attacker hits harder; reflect that so it keeps attacking
      // instead of setting up forever.
      var atkBoost = ctx.boosts ? Math.max(ctx.boosts.atk || 0, ctx.boosts.spa || 0) : 0;
      if (atkBoost > 0) score *= (1 + atkBoost * 0.25);
      // Estimated kill: if this looks lethal, take it over anything clever.
      if (depth >= 1 && ctx.foeHp <= 0.35 && score > 90) score *= 1.6;
      // Priority is how you finish a faster, nearly-dead opponent.
      if (d.priority > 0 && ctx.foeHp <= 0.3) score *= 1.5;
      if (depth >= 2 && !ctx.faster && ctx.myHp <= 0.25 && d.priority > 0) score *= 1.4;
      return score + jitter * 5;
    }

    // ---- status moves, scored on the actual board ----
    var id = d.id;
    var base;

    var inflict = STATUS_MOVES[id];
    if (inflict) {
      // Never re-apply a status the target already has.
      if (ctx.foeStatus) return 0;
      if (!statusLands(inflict.status, ctx.foeTypes, d.type)) return 0;
      base = inflict.status === 'slp' ? 150 : 105;
      // Paralysis is worth much more when it flips the speed race.
      if (inflict.status === 'par' && !ctx.faster) base += 45;
      // Poison/burn want a healthy target with time left to rot.
      if ((inflict.status === 'tox' || inflict.status === 'brn') && ctx.foeHp > 0.6) base += 30;
      if (ctx.foeHp < 0.35) base *= 0.4;   // it's about to faint anyway
      base *= acc;
    } else if (RECOVERY_MOVES[id]) {
      // Only heal when there is damage worth healing, and never at full HP.
      if (ctx.myHp > 0.85) return 0;
      base = (1 - ctx.myHp) * 240;
      if (ctx.myHp < 0.4) base += 60;
      // Healing in front of a faster attacker that out-damages the heal is a
      // losing loop; the deeper AI notices.
      if (depth >= 2 && !ctx.faster && ctx.myHp < 0.25) base *= 0.5;
    } else if (SETUP_MOVES[id]) {
      // Set up from a healthy position, not on the brink.
      var stages = SETUP_MOVES[id];
      var cur = ctx.boosts ? Math.max(ctx.boosts.atk || 0, ctx.boosts.spa || 0,
                                      ctx.boosts.spe || 0) : 0;
      if (cur >= 4) return 0;                        // already maxed out
      if (ctx.myHp < 0.5) return depth >= 1 ? 0 : 20;
      base = 90 * stages / (1 + cur);                // diminishing returns
      if (ctx.myHp > 0.85 && ctx.faster) base += 40;
      if (depth >= 2 && ctx.foeHp <= 0.3) base *= 0.3;  // just KO it instead
    } else if (HAZARD_MOVES[id]) {
      // Hazards are a turn-one play, worthless once the fight is decided.
      if (ctx.hazardsUp) return 0;
      base = ctx.turn <= 2 ? 95 : 35;
      if (ctx.foeHp < 0.4) base *= 0.3;
    } else if (PIVOT_MOVES[id]) {
      base = ctx.myHp < 0.4 ? 70 : 30;
    } else if (id === 'protect' || id === 'detect') {
      base = ctx.myStatus === 'tox' ? 10 : 45;
    } else if (id === 'taunt') {
      base = 60;
    } else if (id === 'trickroom') {
      base = ctx.faster ? 10 : 80;
    } else if (id === 'sunnyday' || id === 'raindance' || id === 'sandstorm' || id === 'snowscape') {
      base = ctx.weather ? 5 : 55;
    } else {
      // Unknown status move: the old flat guess, but lower than any scored
      // option so it's a fallback rather than a default.
      base = 10 + jitter * 8;
    }
    return base + jitter * 6;
  }

  function chooseAIMove(request, myTypes, foeTypes, ctx) {
    if (!request || !request.active || !request.active[0]) return 'default';
    var moves = request.active[0].moves || [];
    ctx = ctx || {};
    var full = {
      myTypes: myTypes || [], foeTypes: foeTypes || [],
      myHp: ctx.myHp == null ? 1 : ctx.myHp,
      foeHp: ctx.foeHp == null ? 1 : ctx.foeHp,
      myStatus: ctx.myStatus || '', foeStatus: ctx.foeStatus || '',
      boosts: ctx.boosts || null, faster: !!ctx.faster,
      depth: ctx.depth || 0, turn: ctx.turn || 1,
      hazardsUp: !!ctx.hazardsUp, weather: ctx.weather || '',
      rand: ctx.rand || null
    };
    var best = null, bestScore = -1;
    for (var i = 0; i < moves.length; i++) {
      var mv = moves[i];
      if (mv.disabled || mv.pp === 0) continue;
      var d = Dex.moves.get(mv.id || mv.move);
      if (!d || !d.exists) continue;
      var score = scoreAIMove(d, full);
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
      pendingRequest: null, lastRequest: null, awaitingPlayer: false,
      playerHp: 1, enemyHp: 1,
      playerTypes: playerMons[0].types.slice(),
      enemyTypes: enemyMons[0].types.slice(),
      // Persistence is injected per side (p1 exists before p2 on the staged
      // start), and the tutorial capture guard is a separate concern. Tracking
      // them independently means an early p1-only pass can never mark the whole
      // injection done and skip the p2 loop (and the damage cap it installs).
      injected: false, p1Injected: false, p2Injected: false
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
    // Two SEPARATE concerns, installed on independent passes:
    //   1. persistent HP/status/PP -- per side. The staged start writes
    //      >player p1 first (so the starting HP is correct on the first
    //      |switch|) and >player p2 last, so p2 does not exist yet on the
    //      first pass. p1 and p2 are therefore injected on separate passes,
    //      and the whole injection is only "done" once BOTH sides exist.
    //   2. the tutorial capture target protection -- a damage cap on the
    //      enemy Pikachu that makes it un-KO-able during the teaching
    //      encounter.
    // The old version set state.injected = true as soon as p1 existed, which
    // made every later call return early -- the p2 loop (and the damage cap
    // inside it) never ran, so a single strong move could faint Pikachu.
    function injectPersistence() {
      var b = stream.battle;
      if (!b) return;
      try {
        if (!state.p1Injected && b.p1 && b.p1.pokemon.length) {
          state.p1Injected = true;
          stampSide(b.p1, 'p');
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
        }
        // enemy persistent HP
        if (!state.p2Injected && b.p2 && b.p2.pokemon.length) {
          state.p2Injected = true;
          stampSide(b.p2, 'e');
          for (var k = 0; k < b.p2.pokemon.length; k++) {
            var el = b.p2.pokemon[k], em = monOf(el);
            if (!em) continue;
            if (em.hpPct < 1) el.hp = Math.max(1, Math.round(el.maxhp * em.hpPct));
            if (em.status) { try { el.setStatus(em.status, null, null, true); } catch (e) { el.status = em.status; } }
          }
        }
      } catch (e) { console.warn('[battle] inject failed', e); }
      state.injected = state.p1Injected && state.p2Injected;
      // The capture guard is installed the moment the enemy object exists,
      // even if p1's persistence was already injected on an earlier pass. It
      // is idempotent (a guarded Pokemon keeps the cap for the battle).
      if (cfg.isTutorialCapture) installTutorialCaptureGuard();
      if (cfg.isTutorialSafe) installTutorialPlayerGuard();
    }

    // The teaching encounter's safety net. The player must be able to weaken
    // the capture target without ever knocking it out: an ordinary strong
    // move (Overheat), a critical hit, an OHKO move and residual chip (burn,
    // poison, weather) all have to leave it alive and weakened.
    //
    // Capping incoming damage at the floor (15% of max HP) BEFORE the
    // simulator can queue a faint is the only single chokepoint that covers
    // every route -- every HP reduction in @pkmn/sim funnels through
    // Pokemon.damage(), so this override catches ordinary moves, crits, OHKO
    // moves and residual alike. Repairing a faint after the engine has
    // already queued it is too late (faintQueued is processed before the next
    // request).
    //
    // Scoped to isTutorialCapture battles and matched on the active enemy's
    // RUN-mon id, so it never applies to later Pikachu battles, trainer
    // battles, non-tutorial encounters or the caught Pokemon afterwards.
    function installTutorialCaptureGuard() {
      var b = stream.battle;
      if (!b || !b.p2 || !b.p2.pokemon.length) return;
      for (var k = 0; k < b.p2.pokemon.length; k++) {
        var el = b.p2.pokemon[k];
        if (el.__tutorialCaptureGuard) continue;
        // Identify the target via the mapped RUN mon where possible. The
        // simulator Pokemon object carries no `id` of its own (the species id
        // lives on el.species.id), so the old `el.id === 'pikachu'` check
        // matched nothing and the cap was never installed even when this code
        // ran. Prefer the run-mon id, fall back to the species id.
        var em = monOf(el);
        var targetId = String(
          (em && em.id) || (el.species && el.species.id) || el.id || ''
        ).toLowerCase();
        if (targetId !== 'pikachu') continue;
        el.__tutorialCaptureGuard = true;
        var originalDamage = el.damage;
        el.damage = function (damage, source, effect) {
          var floor = Math.max(1, Math.round(this.maxhp * 0.15));
          var incoming = Number(damage);
          var safeDamage = Number.isFinite(incoming)
            ? Math.min(Math.max(0, incoming), Math.max(0, this.hp - floor))
            : 0;
          return originalDamage.call(this, safeDamage, source, effect);
        };
      }
    }

    // Section 1 opponents now use real legal moves instead of Splash, so the
    // battles feel like battles. Keep the tutorial promise separately: an
    // unlucky crit or damage roll must not delete the player's Pokemon while
    // the UI is still teaching required actions. The cap is scoped to the
    // guided first section only (cfg.isTutorialSafe from app.js).
    function installTutorialPlayerGuard() {
      var b = stream.battle;
      if (!b || !b.p1 || !b.p1.pokemon.length) return;
      for (var k = 0; k < b.p1.pokemon.length; k++) {
        var el = b.p1.pokemon[k];
        if (el.__tutorialPlayerGuard) continue;
        el.__tutorialPlayerGuard = true;
        var originalDamage = el.damage;
        el.damage = function (damage, source, effect) {
          var floor = Math.max(1, Math.round(this.maxhp * 0.12));
          var incoming = Number(damage);
          var safeDamage = Number.isFinite(incoming)
            ? Math.min(Math.max(0, incoming), Math.max(0, this.hp - floor))
            : 0;
          return originalDamage.call(this, safeDamage, source, effect);
        };
      }
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
            if (mon.pp && mon.pp[ms.id] != null) mon.pp[ms.id] = ms.pp;
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

    // Board state the AI scores against. Read fresh every request -- HP,
    // status and boosts all move between turns. `rand` is the deterministic
    // jitter source for Daily battles (null in Free Play -> Math.random).
    function aiContext() {
      var b = stream.battle;
      var me = liveEnemy(), foe = livePlayer();
      var ctx = { depth: cfg.aiDepth || 0, turn: (b && b.turn) || 1, rand: cfg.rand || null };
      if (!me || !foe) return ctx;
      try {
        ctx.myHp = me.maxhp ? me.hp / me.maxhp : 1;
        ctx.foeHp = foe.maxhp ? foe.hp / foe.maxhp : 1;
        ctx.myStatus = me.status || '';
        ctx.foeStatus = foe.status || '';
        ctx.boosts = me.boosts || null;
        // The speed race decides whether setup/recovery is safe at all.
        ctx.faster = me.getStat('spe') >= foe.getStat('spe');
        ctx.weather = (b && b.field && b.field.weather) || '';
        ctx.hazardsUp = !!(b && b.p1 && b.p1.sideConditions &&
          Object.keys(b.p1.sideConditions).length);
      } catch (e) { /* a partially-built battle just gets the shallow context */ }
      return ctx;
    }

    // ---- ASCENSION: field effects + elite modifiers -----------------------
    // Applied ONCE, on the first turn, after both sides are on the field.
    // Everything here goes through the engine's own APIs so the protocol
    // reports it and the 3D UI renders it like any other effect.
    var ascensionApplied = false;
    function applyAscension() {
      if (ascensionApplied) return;
      var b = stream.battle;
      if (!b || !b.p1 || !b.p2) return;
      var me = liveEnemy(), foe = livePlayer();
      if (!me || !foe) return;
      ascensionApplied = true;
      try {
        var field = cfg.fieldEffect;
        if (field) {
          if (field.kind === 'weather') b.field.setWeather(field.id, me);
          else if (field.kind === 'terrain') b.field.setTerrain(field.id, me);
          else if (field.kind === 'hazard') b.p1.addSideCondition(field.id, me);
          else if (field.kind === 'room') b.field.addPseudoWeather(field.id, me);
        }
        // Each elite enemy announces itself and takes its single boost.
        (enemyMons || []).forEach(function (mon) {
          if (!mon || !mon.elite) return;
          if (monOf(me) !== mon) return;      // only the active one, on switch-in
          b.add('-message', mon.name + ' is ' + mon.elite.label + '!');
          if (mon.elite.boosts) b.boost(mon.elite.boosts, me, me);
        });
        b.sendUpdates();
      } catch (e) { console.warn('[battle] ascension effects failed', e); }
    }

    // A newly switched-in elite gets its modifier when it arrives, not only
    // the lead. Tracked separately so it fires once per Pokemon.
    var elitedIn = {};
    function applyEliteOnSwitch() {
      var b = stream.battle;
      if (!b) return;
      var me = liveEnemy();
      if (!me) return;
      var mon = monOf(me);
      if (!mon || !mon.elite || elitedIn[mon.uid]) return;
      elitedIn[mon.uid] = true;
      if (!ascensionApplied) return;   // the lead is handled by applyAscension
      try {
        b.add('-message', mon.name + ' is ' + mon.elite.label + '!');
        if (mon.elite.boosts) b.boost(mon.elite.boosts, me, me);
        b.sendUpdates();
      } catch (e) { console.warn('[battle] elite switch-in failed', e); }
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
        // Prefer the run mon's types when available so a regional variant
        // (e.g. Sneasel-Hisui = Fighting/Poison) is never reported as the
        // base forme's typing for AI / catch / effectiveness.
        var liveSide = ident.indexOf('p1') === 0
          ? (stream.battle && stream.battle.p1 && stream.battle.p1.active[0])
          : (stream.battle && stream.battle.p2 && stream.battle.p2.active[0]);
        var sideMon = monOf(liveSide);
        var types = (sideMon && sideMon.types && sideMon.types.length)
          ? sideMon.types.slice()
          : (sp.exists ? sp.types.slice() : ['Normal']);
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
          // Ascension effects must land AFTER both sides are on the field but
          // BEFORE the player's first choice, which is exactly here.
          applyAscension();
          applyEliteOnSwitch();
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
              state.awaitingPlayer = !req.wait && !req.teamPreview;
              if (req.teamPreview) { state.awaitingPlayer = false; streams.p1.write('default'); continue; }
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
              streams.p2.write(chooseAIMove(req, state.enemyTypes, state.playerTypes, aiContext()));
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
    // A Daily is a shared, scoreable puzzle, so its BATTLES have to be
    // reproducible too -- not just which Pokemon appear. Passing a seed makes
    // every crit, miss and damage roll identical for everyone on that day.
    // Free Play passes nothing and keeps the engine's own randomness.
    var startMsg = { formatid: format };
    if (cfg.battleSeed) startMsg.seed = cfg.battleSeed;
    streams.omniscient.write('>start ' + JSON.stringify(startMsg));
    streams.omniscient.write('>player p1 ' + JSON.stringify({ name: p1Name, team: Teams.pack(p1Team) }));
    injectPersistence();
    if (cfg.isTutorialSafe) installTutorialPlayerGuard();
    streams.omniscient.write('>player p2 ' + JSON.stringify({ name: p2Name, team: Teams.pack(p2Team) }));
    // The enemy side now exists: arm the tutorial capture guard immediately
    // rather than waiting for the first streamed chunk to drive
    // injectPersistence(). A move can resolve before that chunk is read, and
    // the damage cap must be in place before any damage routes through the
    // enemy. Idempotent if the chunk-driven pass has already run.
    if (cfg.isTutorialCapture) installTutorialCaptureGuard();
    if (cfg.isTutorialSafe) installTutorialPlayerGuard();

    // ---- public API -------------------------------------------------------
    var api = {
      state: state,
      get battle() { return stream.battle; },

      // mega: null | 'mega' | 'megax' | 'megay'  (from the battle UI toggle)
      chooseMove: function (idx, mega) {
        if (state.ended) return;
        state.awaitingPlayer = false;
        state.pendingRequest = null;
        var cmd = 'move ' + (idx + 1);
        if (mega) cmd += ' ' + mega;
        streams.p1.write(cmd);
      },
      chooseSwitch: function (partyIdx) {
        if (state.ended) return;
        state.awaitingPlayer = false;
        state.pendingRequest = null;
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
        state.awaitingPlayer = false;
        state.pendingRequest = null;
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
      // Prefer the run object's mon.id (and mon.types) over the engine's
      // species string so a regional variant never reports as its base forme.
      enemyInfo: function () {
        var el = liveEnemy();
        var mon = monOf(el);
        if (!el) {
          var fallback = mon || enemyMons[0] || {};
          return {
            hpPct: state.enemyHp, status: '',
            id: fallback.id || '',
            types: (fallback.types && fallback.types.slice()) || state.enemyTypes
          };
        }
        return {
          hpPct: el.maxhp ? el.hp / el.maxhp : 0,
          status: el.status || '',
          id: (mon && mon.id) || PS.toID(el.species ? el.species.id : el.baseSpecies),
          types: (mon && mon.types && mon.types.slice()) || state.enemyTypes
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
      activeEnemyMon: function () { return monOf(liveEnemy()); },
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
        state.awaitingPlayer = false;
        state.pendingRequest = null;
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
        state.awaitingPlayer = false;
        state.pendingRequest = null;
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

  window.RogueBattle = { startBattle: startBattle, IDLE_MOVE: IDLE_MOVE, parseHp: parseHp,
                         // exposed for tests: score one move against a board state
                         _scoreAIMove: scoreAIMove, _chooseAIMove: chooseAIMove };
})();
