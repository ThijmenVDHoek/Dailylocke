// ============================================================================
// nuzlocke.js — run state for the Nuzlocke simulator.
//
// STRUCTURE
//   A run is an endless sequence of SECTIONS.
//   A section = 3 wild battles + 1 trainer battle.
//   Between every battle the player picks: Next Battle | Poke Mart.
//
// RULES
//   * HP / PP / status persist across every battle.
//   * A fainted Pokemon is permanently removed from the party (no revives).
//   * Only the FIRST wild encounter of a section may be caught (dupes clause:
//     if you already own that species, the encounter re-rolls).
//   * Max 6 party members; catching at 6 forces a replacement.
//   * Run ends when the party is empty. Score = battles won. MVP = most damage.
// ============================================================================
(function () {
  var C = window.Core;
  var Dex = window.PS.Dex;

  var MAX_PARTY = 6;
  var BATTLES_PER_SECTION = 4;   // 3 wild + 1 trainer

  function newRun(seed) {
    return {
      seed: seed,
      rand: C.mulberry32(seed ^ 0x9e3779b9),
      section: 1,
      battleInSection: 0,        // 0..3 (index of the NEXT battle)
      party: [],
      graveyard: [],             // {name,id,section,killedBy}
      bag: {},
      money: 2000,
      battlesWon: 0,
      trainersBeaten: 0,
      caught: 0,
      damageDealt: {},           // uid -> total damage dealt (for MVP)
      knockouts: {},             // uid -> KOs
      monMeta: {},               // uid -> {name,id} kept even after death
      catchUsedThisSection: false,
      // rolling stats for the end-of-section summary
      sectionStats: { money: 0, won: 0, caught: null, lost: [], damage: 0, kos: 0, startedAt: 1 },
      encounterSeen: false,      // has the section's first wild appeared yet
      seenSpecies: {},
      log: [],
      over: false,
      _shopSeq: 0
    };
  }

  // ------------------------------------------------------------- HELPERS ---
  // Owned in the bag, or held by a party member.
  function ownsItem(run, id) {
    if (run.bag[id]) return true;
    for (var i = 0; i < run.party.length; i++) {
      if (run.party[i].item === id) return true;
    }
    return false;
  }

  function addItem(run, id, n) { run.bag[id] = (run.bag[id] || 0) + (n || 1); }
  function useItem(run, id) {
    if (!run.bag[id]) return false;
    run.bag[id]--; if (run.bag[id] <= 0) delete run.bag[id];
    return true;
  }
  function alive(run) { return run.party.filter(function (m) { return !C.isFainted(m); }); }
  function logMsg(run, t) { run.log.push(t); if (run.log.length > 300) run.log.shift(); }

  function trackMon(run, mon) {
    run.monMeta[mon.uid] = { name: mon.name, id: mon.id, shiny: mon.shiny };
    if (run.damageDealt[mon.uid] == null) run.damageDealt[mon.uid] = 0;
    if (run.knockouts[mon.uid] == null) run.knockouts[mon.uid] = 0;
  }

  // Permanently remove every fainted Pokemon from the party.
  function buryFainted(run, killedByName) {
    var dead = [];
    for (var i = run.party.length - 1; i >= 0; i--) {
      if (C.isFainted(run.party[i])) {
        var m = run.party.splice(i, 1)[0];
        run.graveyard.push({
          name: m.name, id: m.id, section: run.section,
          killedBy: killedByName || 'unknown',
          damage: Math.round(run.damageDealt[m.uid] || 0),
          shiny: m.shiny
        });
        dead.push(m);
      }
    }
    dead.forEach(function (m) { logMsg(run, m.name + ' fainted and is gone forever.'); });
    return dead;
  }

  function nextIsTrainer(run) { return run.battleInSection === BATTLES_PER_SECTION - 1; }

  function resetSectionStats(run) {
    run.sectionStats = { money: 0, won: 0, caught: null, lost: [], damage: 0, kos: 0,
                         startedAt: run.section };
  }
  function advanceBattle(run) {
    run.battleInSection++;
    if (run.battleInSection >= BATTLES_PER_SECTION) {
      run.battleInSection = 0;
      run.section++;
      run.catchUsedThisSection = false;
      run.encounterSeen = false;
      return true;   // new section started
    }
    return false;
  }

  // ---------------------------------------------------------- DIFFICULTY ---
  // Endless scaling. Section 1 is gentle; by section 10+ it's brutal.
  function tier(run, isTrainer) {
    var s = run.section;
    var t = Math.min(1, (s - 1) / 14);              // 0..1 over 14 sections
    // Section 1 wilds are deliberately weak so the run doesn't end instantly.
    var minBST = Math.round(200 + t * 320);          // 200 -> 520
    var maxBST = Math.round(330 + t * 350);          // 330 -> 680
    if (isTrainer) { minBST += 50; maxBST = Math.min(780, maxBST + 70); }
    return {
      minBST: minBST,
      maxBST: maxBST,
      // enemies stay untrained early, then ramp to full investment
      evs: Math.min(252, Math.round(Math.max(0, (s - 1)) * 26)),
      allowLegend: s >= 6 && isTrainer,
      itemChance: isTrainer ? Math.min(0.95, 0.25 + s * 0.09) : Math.min(0.55, Math.max(0, s - 1) * 0.07),
      teamSize: isTrainer ? Math.max(1, Math.min(6, Math.floor((s + 2) / 2))) : 1,
      perfectIV: true
    };
  }

  // The player's Pokemon are always competitively trained: max EVs in their
  // best attacking stat + speed, with a matching nature. This gives the player
  // a real edge early and keeps late-game fights winnable.
  function trainPlayerMon(mon) {
    var sp = Dex.species.get(mon.id);
    var physical = sp.baseStats.atk >= sp.baseStats.spa;
    // 32/32/2 is the Champions spread that replaces the classic 252/252/4.
    mon.sp = { hp: 2, atk: 0, def: 0, spa: 0, spd: 0, spe: 32 };
    if (physical) mon.sp.atk = 32; else mon.sp.spa = 32;
    C.syncEVs(mon);
    mon.nature = physical ? 'Adamant' : 'Modest';
    return mon;
  }

  function candidatePool(run, tr, opts) {
    opts = opts || {};
    var pool = opts.fullyEvolved ? C.fePool() : C.speciesPool();
    var out = pool.filter(function (id) {
      var b = C.bst(id);
      if (b < tr.minBST || b > tr.maxBST) return false;
      if (!tr.allowLegend && C.isLegendary(id)) return false;
      if (opts.excludeSpecies && opts.excludeSpecies[id]) return false;
      return true;
    });
    if (!out.length) {
      out = pool.filter(function (id) {
        return !C.isLegendary(id) && C.bst(id) >= tr.minBST - 80;
      });
    }
    return out.length ? out : pool;
  }

  // Helper: deterministic RNG from an arbitrary string key, so the world
  // (encounters, trainer teams, shinies) is stable per seed and does NOT
  // consume the battler RNG that drives catch shakes.
  function drand(key) { return C.mulberry32(C.hashString(key)); }

  // Wild encounter. Applies the dupes clause when this is the catchable one.
  // Deterministic per seed+section+battle, so every player using the same
  // seed sees the same species (and same shiny rolls) at the same point.
  function pickWild(run, opts) {
    opts = opts || {};
    var tr = tier(run, false);
    var ex = null;
    if (opts.dupesClause) {
      ex = {};
      run.party.forEach(function (m) { ex[m.id] = 1; });
      Object.keys(run.seenSpecies).forEach(function (id) { ex[id] = 1; });
    }
    // Try up to 8 deterministic picks to respect dupes clause.
    for (var attempt = 0; attempt < 8; attempt++) {
      var seedKey = run.seed + '|wild|' + run.section + '|' + run.battleInSection + '|' + attempt;
      var r = drand(seedKey);
      var cands = candidatePool(run, tr, { excludeSpecies: attempt === 0 ? ex : null });
      if (!cands.length) cands = candidatePool(run, tr, {});
      var pick = C.pick(cands, r);
      if (!ex || !ex[pick] || attempt === 7) return pick;
    }
    var c2 = candidatePool(run, tr, { excludeSpecies: ex });
    if (!c2.length) c2 = candidatePool(run, tr, {});
    return C.pick(c2, drand(run.seed + '|wild|fallback|' + run.section + '|' + run.battleInSection));
  }

  // Shiny odds for anything the player can OWN: wild encounters (catchable or
  // not) and the three starters. Trainer-owned Pokemon are never shiny --
  // they cannot be caught, so a shiny there would only be a tease.
  var SHINY_ODDS = 1 / 512;
  // Legacy helper kept for starter generation (which uses its own RNG) and
  // for old save compatibility; new wild shinies use deterministic roll.
  function rollShiny(run) { return run.rand() < SHINY_ODDS; }
  function rollShinyDeterministic(run, speciesId) {
    var r = drand(run.seed + '|shiny|' + run.section + '|' + run.battleInSection + '|' + speciesId);
    return r() < SHINY_ODDS;
  }

  async function makeWild(run, speciesId) {
    var tr = tier(run, false);
    var mon = await C.makeMon(speciesId);
    applyTraining(run, mon, tr, false, speciesId);
    if (rollShinyDeterministic(run, speciesId)) mon.shiny = true;
    return mon;
  }

  function applyTraining(run, mon, tr, isTrainer, speciesHint) {
    var s = Dex.species.get(mon.id);
    var physical = s.baseStats.atk >= s.baseStats.spa;
    var ev = tr.evs;
    mon.evs = { hp: Math.min(252, Math.round(ev * 0.7)), atk: 0, def: 0, spa: 0, spd: 0, spe: ev };
    if (physical) mon.evs.atk = ev; else mon.evs.spa = ev;
    mon.nature = physical ? 'Adamant' : 'Modest';
    var key = run.seed + '|trainItem|' + run.section + '|' + run.battleInSection + '|' + mon.id + '|' + (speciesHint || '') + '|' + (isTrainer ? 't' : 'w');
    var r = drand(key);
    if (r() < tr.itemChance) {
      var pool = isTrainer
        ? ['leftovers', 'lifeorb', 'choicescarf', 'choiceband', 'choicespecs', 'focussash',
           'assaultvest', 'sitrusberry', 'lumberry', 'expertbelt', 'rockyhelmet', 'weaknesspolicy']
        : ['sitrusberry', 'lumberry', 'leftovers', 'focussash', 'quickclaw'];
      var it = C.pick(pool, r);
      if (it === 'choiceband' && s.baseStats.atk < s.baseStats.spa) it = 'choicespecs';
      if (it === 'choicespecs' && s.baseStats.spa < s.baseStats.atk) it = 'choiceband';
      mon.item = it;
    }
  }

  // ------------------------------------------------------------ TRAINERS ---
  // Showdown sprite IDs, display names and themes stay in one record.
  // Selection below is deterministic per seed/section and avoids consecutive repeats.
  var TRAINER_CLASSES = [
    ['Youngster Joey','Youngster','youngster',null], ['Lass Anna','Lass','lass',null], ['Bug Catcher Rick','Bug Catcher','bugcatcher','Bug'],
    ['Hiker Grant','Hiker','hiker','Rock'], ['Swimmer Marina','Swimmer','swimmer','Water'], ['Camper Liam','Camper','camper',null],
    ['Picnicker May','Picnicker','picnicker',null], ['Fisherman Wade','Fisherman','fisherman','Water'], ['Bird Keeper Ash','Bird Keeper','birdkeeper','Flying'],
    ['School Kid Noah','School Kid','schoolkid',null], ['Beauty Olivia','Beauty','beauty',null], ['Guitarist Dex','Guitarist','guitarist','Electric'],
    ['Black Belt Ken','Black Belt','blackbelt','Fighting'], ['Psychic Mira','Psychic','psychic','Psychic'], ['Ranger Kai','Pokémon Ranger','ranger',null],
    ['Scientist Ada','Scientist','scientist','Steel'], ['Poké Maniac Roy','Poké Maniac','pokemaniac',null], ['Ace Trainer Nova','Ace Trainer','acetrainer',null],
    ['Lt. Surge','Gym Leader','ltsurge','Electric'], ['Erika','Gym Leader','erika','Grass'], ['Koga','Gym Leader','koga','Poison'],
    ['Sabrina','Gym Leader','sabrina','Psychic'], ['Misty','Gym Leader','misty','Water'], ['Brock','Gym Leader','brock','Rock'],
    ['Winona','Gym Leader','winona','Flying'], ['Morty','Gym Leader','morty','Ghost'], ['Clair','Gym Leader','clair','Dragon'],
    ['Lance','Champion','lance','Dragon',true], ['Steven','Champion','steven','Steel',true], ['Cynthia','Champion','cynthia',null,true],
    ['Wallace','Champion','wallace','Water',true], ['Red','Champion','red',null,true]
  ];
  function trainerFor(run) {
    var rank = Math.min(TRAINER_CLASSES.length - 1, Math.floor((run.section - 1) * 1.45));
    // Early sections use the approachable end of the roster; later sections
    // draw progressively from leaders and champions, while still varying per run.
    var windowSize = Math.min(TRAINER_CLASSES.length, 7 + Math.floor(run.section * 1.55));
    var idx = C.hashString(run.seed + '|trainer|' + run.section) % windowSize;
    var prev = run.section > 1 ? C.hashString(run.seed + '|trainer|' + (run.section - 1)) % Math.min(TRAINER_CLASSES.length, 7 + Math.floor((run.section - 1) * 1.55)) : -1;
    if (idx === prev) idx = (idx + 1) % windowSize;
    // Every few late sections force a top-rank showdown.
    if (run.section >= 9 && run.section % 3 === 0) idx = Math.max(idx, rank);
    var t = TRAINER_CLASSES[idx];
    return { name:t[0], cls:t[1], tag:'wants to battle!', sprite:t[2], theme:t[3], boss:!!t[4] };
  }

  async function makeTrainerTeam(run, trainer) {
    var tr = tier(run, true), n = tr.teamSize;
    // Bosses gain a larger roster earlier, while normal trainers scale chiefly
    // through BST/EVs rather than becoming an endless six-mon slog.
    if (trainer && trainer.boss) n = Math.min(6, Math.max(n, 3 + Math.floor(run.section / 4)));
    var used = {}, team = [];
    for (var i = 0; i < n; i++) {
      var cands = candidatePool(run, tr, { fullyEvolved: run.section >= 3, excludeSpecies: used });
      if (trainer && trainer.theme) {
        var themed = cands.filter(function (id) { return Dex.species.get(id).types.indexOf(trainer.theme) >= 0; });
        // Preserve a reliable themed leader even if a narrow early BST band has no match.
        if (themed.length) cands = themed;
      }
      var rTeam = drand(run.seed + '|trainerTeam|' + run.section + '|' + i + '|' + (trainer ? trainer.sprite : ''));
      var id = C.pick(cands, rTeam);
      // Late bosses occasionally lead with an already-Mega species. This is a
      // true high-BST opponent (not merely an extra low-level party slot).
      var megaPool = ['charizardmegax','charizardmegay','venusaurmega','blastoise mega',
        'gengarmega','salamencemega','metagrossmega','garchompmega','lucariomega','gardevoirmega'];
      megaPool = megaPool.map(function (x) { return x.replace(/\s/g, ''); }).filter(function (x) {
        var sp = Dex.species.get(x);
        return sp.exists && (!trainer || !trainer.theme || sp.types.indexOf(trainer.theme) >= 0);
      });
      if (trainer && trainer.boss && run.section >= 8 && i === n - 1 && megaPool.length) {
        var rBoss = drand(run.seed + '|trainerMega|' + run.section + '|' + i);
        if (rBoss() < 0.55) id = C.pick(megaPool, rBoss);
      }
      used[id] = 1;
      var mon = await C.makeMon(id);
      applyTraining(run, mon, tr, true, id + '|' + i);
      team.push(mon);
    }
    return team;
  }

  // -------------------------------------------------------------- REWARD ---
  // ---- ECONOMY ------------------------------------------------------------
  // Flat, predictable and compounding:
  //   base           = 1000 per battle
  //   trainer battle = +100%  (so 2000)
  //   win streak     = +10% of base per battle already won (additive)
  var BASE_REWARD = 1000;
  var STREAK_STEP = 0.10;

  function rewardMultiplier(run) { return 1 + (run.battlesWon || 0) * STREAK_STEP; }

  function wildReward(run) {
    return Math.round(BASE_REWARD * rewardMultiplier(run));
  }
  function trainerReward(run) {
    return Math.round(BASE_REWARD * 2 * rewardMultiplier(run));
  }
  // ------------------------------------------------------------- HEALING ---
  // There is no Poke Center. The team is restored for free after every
  // trainer battle (i.e. once per section) and never in between, so damage
  // taken on the three wild battles genuinely has to be managed.
  function healAll(run) {
    run.party.forEach(function (m) {
      // Nuzlocke rule: fainted is permanent. Never resurrect, even if a
      // fainted Pokemon somehow survived in the party.
      if (C.isFainted(m)) return;
      m.hpPct = 1; m.status = '';
      for (var k in m.pp) m.pp[k] = Math.floor(Dex.moves.get(k).pp * 1.6);
    });
  }

  // ---------------------------------------------------------------- MART ---
  // Curated rotating stock + always-available services.
  function rollMart(run) {
    var seed = C.hashString(run.seed + '|mart|' + run.section + '|' + run.battleInSection + '|' + (run._shopSeq || 0));
    var rand = C.mulberry32(seed);
    var stock = [];
    var s = run.section;

    // --- Balls (always) ---
    var balls = ['pokeball', 'greatball'];
    if (s >= 2) balls.push('ultraball');
    if (s >= 3) balls.push(C.pick(['timerball', 'netball', 'quickball', 'duskball'], rand));
    if (s >= 7 && rand() < 0.12) balls.push('masterball');
    balls.forEach(function (id) {
      var b = C.BALLS[id];
      stock.push({ kind: 'ball', id: id, name: b.name, price: b.price, desc: b.desc, stock: id === 'masterball' ? 1 : 99 });
    });

    // --- Healing / status (always a useful spread) ---
    var heals = ['potion', 'superpotion'];
    if (s >= 2) heals.push('hyperpotion');
    if (s >= 4) heals.push('maxpotion');
    if (s >= 6) heals.push('fullrestore');
    heals.push('fullheal');
    if (rand() < 0.5) heals.push('ether'); else heals.push('elixir');
    heals.forEach(function (id) {
      var h = C.HEAL_ITEMS[id];
      stock.push({ kind: 'heal', id: id, name: h.name, price: h.price, desc: h.desc, stock: 99 });
    });

    // --- Held items: weighted by tier, more exotic later ---
    var T = C.ITEM_TIERS;
    var picks = []
      .concat(C.pickN(T.common, 2, rand))
      .concat(C.pickN(T.core, s >= 2 ? 3 : 2, rand))
      .concat(C.pickN(T.typed, 1, rand));
    if (s >= 4) picks = picks.concat(C.pickN(T.rare, s >= 7 ? 3 : 2, rand));
    var seen = {};
    picks.forEach(function (id) {
      if (seen[id] || !Dex.items.get(id).exists) return;
      seen[id] = 1;
      var info = C.heldItemInfo(id);
      stock.push({ kind: 'held', id: id, name: info.name, price: info.price, desc: info.desc, stock: 1 });
    });

    // --- Evolution items ---
    // ONLY items a Pokemon currently in the party can actually use. No filler:
    // a shelf full of stones for Pokemon you don't own is just noise.
    var E = window.Evo;
    if (E) {
      E.relevantItems(run).forEach(function (ent) {
        stock.push({ kind: 'evo', id: ent.id, name: E.itemName(ent.id),
                     price: E.itemPrice(ent.id), desc: E.itemDesc(ent.id),
                     stock: 99, hot: true,
                     forSpecies: ent.forSpecies, becomes: ent.becomes });
      });
    }

    // --- Forme change items (only for a LIVING party member) ---
    var FM = window.Forme;
    if (FM) {
      FM.relevantItems(run).forEach(function (f) {
        stock.push({ kind: 'forme', id: f.id, name: f.name, price: f.price,
                     desc: f.desc, stock: 99, hot: true, unique: true,
                     forSpecies: f.forSpecies });
      });
    }

    // --- Mega Stones (only ones the current party can actually use) ---
    // Marked `unique`: the shop hides them while you already own one (in the
    // bag OR equipped). Sell it and it reappears, buyable again.
    var MG = window.Mega;
    if (MG) {
      MG.relevantStones(run).forEach(function (st2) {
        stock.push({ kind: 'mega', id: st2.id, name: st2.name, price: st2.price,
                     desc: MG.desc(st2.id), stock: 1, hot: true, unique: true,
                     forme: st2.formeName, forSpecies: st2.forSpecies });
      });
    }

    // Services (Move Tutor / Ability Patch) are NOT sold here -- they live
    // on each Pokemon in the Team menu, where the context actually is.

    // occasional sale
    if (rand() < 0.4) {
      var i = Math.floor(rand() * stock.length);
      if (stock[i].kind !== 'service') {
        stock[i].price = Math.max(50, Math.round(stock[i].price * 0.55 / 10) * 10);
        stock[i].sale = true;
      }
    }
    return stock;
  }

  // ------------------------------------------------------------- ITEM USE ---
  function applyItem(run, itemId, mon, moveId) {
    var h = C.HEAL_ITEMS[itemId];
    if (!h) {
      if (Dex.items.get(itemId).exists) {
        var old = mon.item;
        mon.item = itemId;
        useItem(run, itemId);
        if (old) addItem(run, old, 1);
        return { ok: true, msg: mon.name + ' is now holding ' + Dex.items.get(itemId).name + '.' };
      }
      return { ok: false, msg: 'Cannot use that.' };
    }
    if (h.revive) return { ok: false, msg: 'Fainted Pokemon are gone for good in a Nuzlocke.' };
    if (C.isFainted(mon)) return { ok: false, msg: mon.name + ' is gone.' };
    var did = false, msgs = [];
    if (h.healPct) {
      var mx = C.maxHP(mon), cur = Math.round(mx * mon.hpPct);
      var got = Math.min(mx - cur, C.healAmountFor(itemId, mon));
      if (got > 0) { mon.hpPct = (cur + got) / mx; did = true; msgs.push(mon.name + ' recovered ' + got + ' HP.'); }
    }
    if (h.cure && mon.status && (h.cure === 'all' || h.cure === mon.status)) {
      mon.status = ''; did = true; msgs.push(mon.name + ' was cured.');
    }
    if (h.pp && moveId) {
      var mv = Dex.moves.get(moveId), mp = Math.floor(mv.pp * 1.6);
      if (mon.pp[moveId] < mp) { mon.pp[moveId] = Math.min(mp, mon.pp[moveId] + h.pp); did = true; msgs.push(mv.name + '\'s PP restored.'); }
    }
    if (h.ppAll) {
      for (var k in mon.pp) {
        var mp2 = Math.floor(Dex.moves.get(k).pp * 1.6);
        if (mon.pp[k] < mp2) { mon.pp[k] = Math.min(mp2, mon.pp[k] + h.ppAll); did = true; }
      }
      if (did) msgs.push(mon.name + '\'s PP restored.');
    }
    if (!did) return { ok: false, msg: 'It would have no effect.' };
    useItem(run, itemId);
    return { ok: true, msg: msgs.join(' ') };
  }

  // --------------------------------------------------------------- TUTOR ---
  // The tutor offers the COMPLETE legal learnset (status moves, situational
  // moves and all) -- only moves the Pokemon already knows are hidden.
  async function tutorOptions(mon) {
    // `all:true` retains every learn method in the Showdown learnset data:
    // level, egg, tutor, event, TM/HM and every pre-evolution in the chain.
    // Do not apply the battle AI's banned-move filter in this player-facing list.
    var all = await C.legalMoves(mon.id, { all: true });
    return all.filter(function (id) { return mon.moves.indexOf(id) < 0; });
  }
  function teachMove(run, mon, slot, moveId) {
    var old = mon.moves[slot];
    if (old) delete mon.pp[old];
    mon.moves[slot] = moveId;
    mon.pp[moveId] = Math.floor(Dex.moves.get(moveId).pp * 1.6);
    logMsg(run, mon.name + ' learned ' + Dex.moves.get(moveId).name + '!');
  }
  function abilityOptions(mon) {
    var s = Dex.species.get(mon.id);
    var out = [];
    for (var k in s.abilities) {
      var a = s.abilities[k];
      if (a && out.indexOf(a) < 0) out.push(a);
    }
    return out;
  }

  // ----------------------------------------------------------------- MVP ---
  function mvp(run) {
    var best = null, bestDmg = -1;
    Object.keys(run.damageDealt).forEach(function (uid) {
      var d = run.damageDealt[uid];
      if (d > bestDmg) { bestDmg = d; best = uid; }
    });
    if (!best || bestDmg <= 0) return null;
    var meta = run.monMeta[best] || { name: '?', id: null, shiny: false };
    var living = run.party.some(function (m) { return String(m.uid) === String(best); });
    return { uid: best, name: meta.name, id: meta.id, shiny: meta.shiny,
             damage: Math.round(bestDmg), kos: run.knockouts[best] || 0, survived: living };
  }

  function roster(run) {
    // living + dead, with their damage numbers, for the results screen
    var out = run.party.map(function (m) {
      return { name: m.name, id: m.id, alive: true, hpPct: m.hpPct,
               damage: Math.round(run.damageDealt[m.uid] || 0), kos: run.knockouts[m.uid] || 0,
               shiny: m.shiny };
    });
    run.graveyard.forEach(function (g) {
      out.push({ name: g.name, id: g.id, alive: false, hpPct: 0,
                 damage: g.damage || 0, kos: 0, section: g.section, killedBy: g.killedBy,
                 shiny: g.shiny });
    });
    return out;
  }

  window.Nuz = {
    MAX_PARTY: MAX_PARTY, BATTLES_PER_SECTION: BATTLES_PER_SECTION,
    newRun: newRun, addItem: addItem, useItem: useItem,
    alive: alive, logMsg: logMsg, trackMon: trackMon, buryFainted: buryFainted,
    ownsItem: ownsItem,
    nextIsTrainer: nextIsTrainer, advanceBattle: advanceBattle,
    resetSectionStats: resetSectionStats,
    tier: tier, pickWild: pickWild, makeWild: makeWild,
    trainerFor: trainerFor, makeTrainerTeam: makeTrainerTeam,
    wildReward: wildReward, trainerReward: trainerReward,
    rewardMultiplier: rewardMultiplier,
    BASE_REWARD: BASE_REWARD, healAll: healAll,
    rollMart: rollMart, applyItem: applyItem,
    tutorOptions: tutorOptions, teachMove: teachMove, abilityOptions: abilityOptions,
    mvp: mvp, roster: roster, trainPlayerMon: trainPlayerMon,
    SHINY_ODDS: SHINY_ODDS, rollShiny: rollShiny
  };
})();
