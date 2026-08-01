// ============================================================================
// nuzlocke.js — run state for the Nuzlocke simulator.
//
// STRUCTURE
//   A run is an endless sequence of SECTIONS.
//   A section = 3 wild battles + 1 trainer battle.
//   Between every battle the player picks: Next Battle | Poke Mart.
//
// TEAM GAUNTLET
//   A run with mode 'gauntlet' skips the wilds entirely: EVERY battle is the
//   section's trainer battle, so the whole difficulty engine (BST bands, EV
//   investment, team sizes, boss clauses, strategies, ascension) resolves
//   identically to the other modes at the same section number. Trainer N of
//   a Gauntlet is therefore exactly as hard as the Nth trainer battle of a
//   Daily or Free Play run, because both funnel through trainerFor(),
//   makeTrainerTeam() and tier() with the same run.section.
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

  // Team Gauntlet runs fight ONLY trainers: the section number IS the trainer
  // counter, so every stop on the route is a trainer battle.
  function isGauntlet(run) { return !!run && run.mode === 'gauntlet'; }

  function nextIsTrainer(run) {
    return isGauntlet(run) || run.battleInSection === BATTLES_PER_SECTION - 1;
  }

  function resetSectionStats(run) {
    run.sectionStats = { money: 0, won: 0, caught: null, lost: [], damage: 0, kos: 0,
                         startedAt: run.section };
  }
  function advanceBattle(run) {
    run.battleInSection++;
    // Gauntlet: one trainer per section means every battle IS the section
    // finale, so the section counter (and with it the difficulty) moves up
    // after every single fight.
    if (run.battleInSection >= BATTLES_PER_SECTION || isGauntlet(run)) {
      run.battleInSection = 0;
      run.section++;
      run.catchUsedThisSection = false;
      run.encounterSeen = false;
      return true;   // new section started
    }
    return false;
  }

  // ----------------------------------------------------------- ASCENSION ---
  // Sections 1-15 are the "climb": BST, EVs, team size and legendary access
  // all ramp and then hit their ceilings. Past 15 those ceilings can't rise
  // any further without producing nonsense (there is no 900-BST Pokemon, and
  // 7 party slots don't exist), yet the economy kept compounding -- so the run
  // got RICHER while it stopped getting HARDER.
  //
  // Ascension is the answer: after section 15 each further block of 5 sections
  // adds one tier of qualitative difficulty instead of more of the same
  // numbers. Rewards are simultaneously bent onto a diminishing curve.
  var ASCENSION_START = 15;      // last "normal" section
  var ASCENSION_EVERY = 5;       // one tier per 5 sections after that

  function ascension(run) {
    var s = (run && run.section) || 1;
    if (s <= ASCENSION_START) return 0;
    return Math.floor((s - ASCENSION_START - 1) / ASCENSION_EVERY) + 1;
  }

  // What a given ascension tier actually turns on. Each is additive and each
  // is VISIBLE to the player (app.js renders this on the route screen), so
  // difficulty is never a hidden stat tweak.
  function ascensionEffects(run) {
    var a = ascension(run);
    return {
      tier: a,
      // 1: the field itself fights you
      field: a >= 1,
      // 1: bosses every 5 sections gain a clause
      bossClause: a >= 1,
      // 2: one enemy per battle is "elite" with a single visible modifier
      elite: a >= 2,
      // 2: enemies get coherent held-item synergy rather than random items
      itemSynergy: a >= 2,
      // 3: post-section healing is partial, so attrition really bites
      healPct: a >= 3 ? Math.max(0.55, 1 - (a - 2) * 0.15) : 1,
      // 3+: the AI looks further ahead (battle.js reads this)
      aiDepth: Math.min(3, a),
      // every tier makes elites a little more common
      eliteChance: a >= 2 ? Math.min(0.75, 0.25 + (a - 2) * 0.15) : 0
    };
  }

  // ---------------------------------------------------------- DIFFICULTY ---
  // Endless scaling. Section 1 is gentle; by section 10+ it's brutal; past 15
  // ascension takes over (see above).
  function tier(run, isTrainer) {
    var s = run.section;
    var t = Math.min(1, (s - 1) / 14);              // 0..1 over 14 sections
    var a = ascension(run);
    // Section 1 wilds are deliberately weak so the run doesn't end instantly.
    var minBST = Math.round(200 + t * 320);          // 200 -> 520
    var maxBST = Math.round(330 + t * 350);          // 330 -> 680
    if (isTrainer) { minBST += 50; maxBST = Math.min(780, maxBST + 70); }
    // Ascension keeps squeezing the FLOOR upward even though the ceiling is
    // fixed by what exists in the dex: late enemies stop being a mixed bag and
    // become uniformly top-tier.
    if (a > 0) minBST = Math.min(maxBST - 40, minBST + a * 25);
    return {
      minBST: minBST,
      maxBST: maxBST,
      // enemies stay untrained early, then ramp to full investment
      evs: Math.min(252, Math.round(Math.max(0, (s - 1)) * 26)),
      allowLegend: s >= 6 && (isTrainer || a >= 2),
      itemChance: isTrainer ? Math.min(0.95, 0.25 + s * 0.09) : Math.min(0.55, Math.max(0, s - 1) * 0.07),
      teamSize: isTrainer ? Math.max(1, Math.min(6, Math.floor((s + 2) / 2))) : 1,
      perfectIV: true,
      ascension: a
    };
  }

  // The player's Pokemon are always competitively trained: max EVs in their
  // best attacking stat + speed, with a matching nature. This gives the player
  // a real edge early and keeps late-game fights winnable.
  function trainPlayerMon(mon) {
    var sp = Dex.species.get(mon.id);
    var physical = sp.baseStats.atk >= sp.baseStats.spa;
    // 32/32/2 Stat Points is this game's equivalent of the classic 252/252/4.
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
  // ---- the guided first run's safety net ----------------------------------
  // A prologue run is a REAL run in the real Free Play slot: same engine, same
  // rules, same permadeath. The only concession is that SECTION 1 does not
  // sabotage the lesson it is trying to teach.
  //
  // Specifically: the very first catchable encounter is drawn from a short
  // list of famously easy catches (capture rate 190-255, low BST, nothing that
  // can one-shot a starter). Teaching "weaken it, then throw a ball" against a
  // species with a 3% catch rate teaches the opposite lesson.
  //
  // Everything from section 2 onwards is completely untouched.
  var PROLOGUE_WILDS = ['rattata', 'pidgey', 'zigzagoon', 'bidoof', 'patrat',
                        'lillipup', 'sentret', 'poochyena', 'starly', 'bunnelby',
                        'yungoos', 'skwovet', 'wurmple', 'caterpie', 'weedle'];

  // Extra gentle species considered ONLY for the prologue's second battle.
  // That is the fight the coach uses to explain super-effective damage, so
  // the wild must be weak to a move the player's lead actually carries for
  // the lesson to make sense. Same bar as the main pool: base stat total at
  // most 330, capture rate at least 150, nothing that can end the run.
  var PROLOGUE_WEAK_POOL = ['sandshrew', 'geodude', 'diglett', 'psyduck', 'poliwag',
                            'wooper', 'marill', 'oddish', 'bellsprout', 'slugma',
                            'numel', 'vulpix'];

  // The starter's STAB types. The guided run's super-effective battle must
  // be weak to the STARTER's moves (that is the lesson being taught),
  // regardless of who currently leads the party.
  function starterStabTypes(run) {
    var starter = null;
    if (run && run.tutorialStarterUid && run.party) {
      for (var i = 0; i < run.party.length; i++) {
        if (String(run.party[i].uid) === String(run.tutorialStarterUid)) { starter = run.party[i]; break; }
      }
    }
    if (!starter) starter = (run && run.party && run.party[0]) || null;
    if (!starter) return [];
    var types = starter.types && starter.types.length ? starter.types.slice() : [];
    if (!types.length && starter.id) {
      var sp0 = Dex.species.get(starter.id);
      if (sp0 && sp0.exists) types = (sp0.types || []).slice();
    }
    var out = [];
    (starter.moves || []).forEach(function (mv) {
      var d = Dex.moves.get(mv);
      if (!d || !d.exists || d.category === 'Status') return;
      if (types.indexOf(d.type) < 0) return;
      if (out.indexOf(d.type) < 0) out.push(d.type);
    });
    if (!out.length) types.forEach(function (t) { if (out.indexOf(t) < 0) out.push(t); });
    return out;
  }

  function isPrologueSection(run) {
    return !!(run && run.prologue && run.section === 1);
  }

  function pickWild(run, opts) {
    opts = opts || {};
    if (isPrologueSection(run)) {
      // The capture encounter is a gentle one; the two cash battles that
      // follow are drawn from the same friendly pool so the first section
      // cannot end the run before the player knows what a Poke Ball is.
      var pr = drand(run.seed + '|prologue|' + run.battleInSection);
      // The SECOND battle teaches super-effective damage on a live target:
      // prefer a species the STARTER's STAB actually hits for 2x+, so the
      // lesson and the battle describe the same move even if the player has
      // already reordered the party.
      if (run.battleInSection === 1) {
        var weakTo = starterStabTypes(run);
        if (weakTo.length) {
          var wpool = PROLOGUE_WILDS.concat(PROLOGUE_WEAK_POOL).filter(function (id) {
            var spw = Dex.species.get(id);
            if (!spw || !spw.exists) return false;
            if ((run.seenSpecies || {})[id]) return false;
            return weakTo.some(function (t) { return C.typeMod(t, spw.types || []) >= 2; });
          });
          if (wpool.length) return C.pick(wpool, pr);
        }
      }
      var pool = PROLOGUE_WILDS.filter(function (id) {
        return Dex.species.get(id).exists && !(run.seenSpecies || {})[id];
      });
      if (!pool.length) pool = PROLOGUE_WILDS.filter(function (id) { return Dex.species.get(id).exists; });
      if (pool.length) return C.pick(pool, pr);
    }
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
  function rollShinyDeterministic(run, speciesId) {
    var r = drand(run.seed + '|shiny|' + run.section + '|' + run.battleInSection + '|' + speciesId);
    return r() < SHINY_ODDS;
  }

  async function makeWild(run, speciesId) {
    var tr = tier(run, false);
    // Wilds get a role too from ascension 1, so late-game encounters stop
    // being four-attack punching bags.
    var role = null;
    if (ascension(run) >= 1) {
      var rr = drand(run.seed + '|wildrole|' + run.section + '|' + run.battleInSection + '|' + speciesId);
      role = pickRoleFor({ roles: ['sweeper', 'wall', 'disruptor', 'pivot'] }, speciesId,
                         Math.floor(rr() * 4));
    }
    var mon = await C.makeMon(speciesId, { role: role });
    applyTraining(run, mon, tr, false, speciesId);
    if (rollShinyDeterministic(run, speciesId)) mon.shiny = true;
    var elite = eliteModFor(run, mon, 0, false);
    if (elite) mon.elite = elite;
    return mon;
  }

  // Held items that actually SUPPORT the role, instead of a random draw. At
  // ascension 2+ this replaces the flat pool, so a wall shows up with
  // Leftovers and a sweeper with a Life Orb rather than the other way round.
  var ROLE_ITEMS = {
    sweeper:   ['lifeorb', 'choicescarf', 'expertbelt', 'weaknesspolicy'],
    setup:     ['lifeorb', 'weaknesspolicy', 'sitrusberry'],
    wall:      ['leftovers', 'rockyhelmet', 'assaultvest', 'sitrusberry'],
    pivot:     ['choicescarf', 'leftovers', 'sitrusberry'],
    disruptor: ['leftovers', 'lumberry', 'rockyhelmet', 'focussash'],
    weather:   ['leftovers', 'lifeorb', 'focussash'],
    hazard:    ['focussash', 'leftovers', 'rockyhelmet'],
    priority:  ['choiceband', 'lifeorb', 'focussash'],
    attacker:  ['lifeorb', 'choiceband', 'choicespecs', 'expertbelt']
  };

  function applyTraining(run, mon, tr, isTrainer, speciesHint) {
    var s = Dex.species.get(mon.id);
    var physical = s.baseStats.atk >= s.baseStats.spa;
    var ev = tr.evs;
    mon.evs = { hp: Math.min(252, Math.round(ev * 0.7)), atk: 0, def: 0, spa: 0, spd: 0, spe: ev };
    if (physical) mon.evs.atk = ev; else mon.evs.spa = ev;
    mon.nature = physical ? 'Adamant' : 'Modest';
    // A wall wants its bulk invested, not its speed.
    if (mon.role === 'wall' || mon.role === 'disruptor') {
      mon.evs = { hp: Math.min(252, ev), atk: 0, def: Math.round(ev * 0.6),
                  spa: 0, spd: Math.round(ev * 0.6), spe: 0 };
      if (physical) mon.evs.atk = Math.round(ev * 0.4); else mon.evs.spa = Math.round(ev * 0.4);
      mon.nature = physical ? 'Careful' : 'Calm';
    }
    var key = run.seed + '|trainItem|' + run.section + '|' + run.battleInSection + '|' + mon.id + '|' + (speciesHint || '') + '|' + (isTrainer ? 't' : 'w');
    var r = drand(key);
    if (r() < tr.itemChance) {
      var synergy = ascensionEffects(run).itemSynergy && mon.role && ROLE_ITEMS[mon.role];
      var pool = synergy ? ROLE_ITEMS[mon.role] : (isTrainer
        ? ['leftovers', 'lifeorb', 'choicescarf', 'choiceband', 'choicespecs', 'focussash',
           'assaultvest', 'sitrusberry', 'lumberry', 'expertbelt', 'rockyhelmet', 'weaknesspolicy']
        : ['sitrusberry', 'lumberry', 'leftovers', 'focussash', 'quickclaw']);
      var it = C.pick(pool, r);
      if (it === 'choiceband' && s.baseStats.atk < s.baseStats.spa) it = 'choicespecs';
      if (it === 'choicespecs' && s.baseStats.spa < s.baseStats.atk) it = 'choiceband';
      // An Assault Vest blocks status moves, which would brick a set that was
      // built around one.
      if (it === 'assaultvest' && mon.moves && mon.moves.some(function (mv) {
        var d = Dex.moves.get(mv); return d && d.category === 'Status';
      })) it = 'leftovers';
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
  // ------------------------------------------------------- BOSS CLAUSES ----
  // Ascension 1+: every 5th section the boss fights under a named clause. It
  // is shown on the route screen BEFORE the fight, so it's a puzzle to prepare
  // for rather than an ambush.
  var BOSS_CLAUSES = [
    { id: 'fullteam',  label: 'Full Roster',   note: 'The boss brings a full team of six.' },
    { id: 'elites',    label: 'Elite Guard',   note: 'Every one of their Pokemon is elite.' },
    { id: 'noitems',   label: 'Item Lock',     note: 'You cannot use bag items this battle.' },
    { id: 'sturdy',    label: 'Last Stand',    note: 'Their lead survives one lethal hit.' },
    { id: 'weathered', label: 'Home Field',    note: 'They set the field on their terms.' }
  ];

  function bossClauseFor(run) {
    var eff = ascensionEffects(run);
    if (!eff.bossClause) return null;
    if (run.section % 5 !== 0) return null;
    var r = drand(run.seed + '|bossclause|' + run.section);
    return C.pick(BOSS_CLAUSES, r);
  }

  function trainerFor(run) {
    // The prologue's one trainer is always the friendliest face on the roster.
    // It is still a real trainer battle with a real team -- it just is not a
    // Gym Leader on the fight that teaches you what a trainer battle is.
    if (isPrologueSection(run)) {
      var t0 = TRAINER_CLASSES[0];
      return { name: t0[0], cls: t0[1], tag: 'wants to battle!', sprite: t0[2],
               theme: t0[3], boss: false, strategy: STRATEGIES[0] };
    }
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
    var out = { name:t[0], cls:t[1], tag:'wants to battle!', sprite:t[2], theme:t[3], boss:!!t[4] };
    // A section-5 multiple is always a boss encounter once ascension starts,
    // even if the roster roll produced an ordinary trainer.
    var clause = bossClauseFor(run);
    if (clause) { out.boss = true; out.clause = clause; }
    // A themed trainer also gets a STRATEGY, so two Water trainers don't play
    // the same way (core.js builds movesets around it).
    out.strategy = strategyFor(run, out);
    return out;
  }

  // -------------------------------------------------------- TEAM THEMES ----
  // A trainer's team should express an idea, not just a type. Each strategy
  // biases the roles core.js hands out when it builds their movesets.
  var STRATEGIES = [
    { id: 'balanced',  label: 'Balanced',     roles: ['sweeper', 'wall', 'pivot', 'disruptor'] },
    { id: 'offense',   label: 'Hyper Offence', roles: ['sweeper', 'sweeper', 'setup', 'priority'] },
    { id: 'stall',     label: 'Stall',        roles: ['wall', 'wall', 'disruptor', 'pivot'] },
    { id: 'weather',   label: 'Weather',      roles: ['weather', 'sweeper', 'sweeper', 'wall'] },
    { id: 'hazards',   label: 'Hazard Trap',  roles: ['hazard', 'disruptor', 'wall', 'sweeper'] },
    { id: 'trickroom', label: 'Trick Room',   roles: ['disruptor', 'sweeper', 'wall', 'setup'] }
  ];

  // Assign a role to a team slot. A species with no physical/special bulk is
  // a poor wall no matter what the strategy says, so the pick is filtered by
  // what the Pokemon can actually do.
  function pickRoleFor(strat, speciesId, index) {
    var roles = (strat && strat.roles) || ['attacker'];
    var want = roles[index % roles.length];
    var sp = Dex.species.get(speciesId);
    if (!sp || !sp.exists) return want;
    var bs = sp.baseStats;
    var bulk = bs.hp + bs.def + bs.spd;
    var offence = Math.max(bs.atk, bs.spa) + bs.spe;
    // Don't ask a Deoxys-Attack to wall, or a Shuckle to sweep.
    if (want === 'wall' && bulk < 260) return 'disruptor';
    if ((want === 'sweeper' || want === 'setup') && offence < 170) return 'wall';
    if (want === 'priority' && bs.spe > 100) return 'sweeper';
    return want;
  }

  function strategyFor(run, trainer) {
    // Below section 4 trainers stay simple: a new player shouldn't meet a
    // stall team before they own four Pokemon.
    if (run.section < 4) return STRATEGIES[0];
    var r = drand(run.seed + '|strategy|' + run.section + '|' + (trainer ? trainer.sprite : ''));
    // Bosses skew toward the sharper archetypes.
    var pool = (trainer && trainer.boss)
      ? STRATEGIES.filter(function (s) { return s.id !== 'balanced'; })
      : STRATEGIES;
    return C.pick(pool, r);
  }

  async function makeTrainerTeam(run, trainer) {
    var tr = tier(run, true), n = tr.teamSize;
    // Bosses gain a larger roster earlier, while normal trainers scale chiefly
    // through BST/EVs rather than becoming an endless six-mon slog.
    if (trainer && trainer.boss) n = Math.min(6, Math.max(n, 3 + Math.floor(run.section / 4)));
    if (trainer && trainer.clause && trainer.clause.id === 'fullteam') n = 6;
    var strat = (trainer && trainer.strategy) || STRATEGIES[0];
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
      // The strategy assigns each slot a role, so a "Stall" trainer really
      // fields walls and a "Hyper Offence" one really fields sweepers.
      var role = pickRoleFor(strat, id, i);
      var mon = await C.makeMon(id, { role: role });
      applyTraining(run, mon, tr, true, id + '|' + i);
      // Ascension 2+: a slot may be elite, with one visible modifier.
      var elite = eliteModFor(run, mon, i, true);
      if (elite) mon.elite = elite;
      // The Elite Guard clause upgrades every slot at once.
      if (trainer && trainer.clause && trainer.clause.id === 'elites' && !mon.elite) {
        var rE = drand(run.seed + '|eliteforce|' + run.section + '|' + i);
        mon.elite = C.pick(ELITE_MODS, rE);
      }
      team.push(mon);
    }
    return team;
  }

  // ------------------------------------------------------- FIELD EFFECTS ---
  // Ascension 1+: a battle can START with weather, terrain, a hazard or a
  // room already in play. Deterministic per seed/section/battle so the daily
  // stays identical for everyone, and always announced before the first turn.
  var FIELD_POOL = [
    { kind: 'weather', id: 'sandstorm',       label: 'Sandstorm',        note: 'A sandstorm rages.' },
    { kind: 'weather', id: 'raindance',       label: 'Rain',             note: 'Rain is pouring down.' },
    { kind: 'weather', id: 'sunnyday',        label: 'Harsh sunlight',   note: 'The sunlight is harsh.' },
    { kind: 'weather', id: 'snowscape',       label: 'Snow',             note: 'Snow is falling.' },
    { kind: 'terrain', id: 'electricterrain', label: 'Electric Terrain', note: 'The ground crackles.' },
    { kind: 'terrain', id: 'grassyterrain',   label: 'Grassy Terrain',   note: 'Grass covers the ground.' },
    { kind: 'terrain', id: 'psychicterrain',  label: 'Psychic Terrain',  note: 'The field feels weird.' },
    { kind: 'terrain', id: 'mistyterrain',    label: 'Misty Terrain',    note: 'Mist swirls underfoot.' },
    { kind: 'hazard',  id: 'stealthrock',     label: 'Stealth Rock',     note: 'Pointed stones float around you.' },
    { kind: 'hazard',  id: 'spikes',          label: 'Spikes',           note: 'Spikes litter your side.' },
    { kind: 'room',    id: 'trickroom',       label: 'Trick Room',       note: 'Dimensions are twisted.' }
  ];

  // Returns null, or {kind,id,label,note} to apply at battle start.
  function fieldEffectFor(run, isTrainer) {
    var eff = ascensionEffects(run);
    if (!eff.field) return null;
    var r = drand(run.seed + '|field|' + run.section + '|' + run.battleInSection);
    // Trainers bring the field more often than a wandering wild does.
    var chance = Math.min(0.7, (isTrainer ? 0.45 : 0.25) + eff.tier * 0.05);
    if (r() >= chance) return null;
    // Hazards only ever land on the PLAYER's side, and only from a trainer --
    // a wild Pokemon setting Stealth Rock for itself makes no sense.
    var pool = FIELD_POOL.filter(function (f) { return isTrainer || f.kind !== 'hazard'; });
    return C.pick(pool, r);
  }

  // ------------------------------------------------------------- ELITES ----
  // Ascension 2+: one enemy per battle may carry a single, VISIBLE modifier.
  // One only -- an elite should read at a glance, not be a stack of buffs.
  var ELITE_MODS = [
    { id: 'swift',    label: 'Swift',    note: '+1 Speed at the start', boosts: { spe: 1 } },
    { id: 'brutal',   label: 'Brutal',   note: '+1 Attack at the start', boosts: { atk: 1 } },
    { id: 'focused',  label: 'Focused',  note: '+1 Sp. Atk at the start', boosts: { spa: 1 } },
    { id: 'armored',  label: 'Armored',  note: '+1 Defence at the start', boosts: { def: 1 } },
    { id: 'warded',   label: 'Warded',   note: '+1 Sp. Def at the start', boosts: { spd: 1 } }
  ];

  function eliteModFor(run, mon, index, isTrainer) {
    var eff = ascensionEffects(run);
    if (!eff.elite || !mon) return null;
    var r = drand(run.seed + '|elite|' + run.section + '|' + run.battleInSection + '|' + index + '|' + mon.id);
    if (r() >= eff.eliteChance) return null;
    var mod = C.pick(ELITE_MODS, r);
    return { id: mod.id, label: mod.label, note: mod.note, boosts: mod.boosts, isTrainer: !!isTrainer };
  }

  // -------------------------------------------------------------- REWARD ---
  // ---- ECONOMY ------------------------------------------------------------
  // Flat and predictable, but DIMINISHING rather than linear:
  //   base           = 1000 per battle
  //   trainer battle = +100%  (so 2000)
  //   win streak     = grows with wins, but on a curve that flattens
  //
  // The old rule was +10% of base per win, forever. By 60 wins that was a 7x
  // multiplier against difficulty that had stopped rising at section 15, so
  // the player could simply buy their way through the late game. A square-root
  // curve keeps early wins feeling generous (each one is a visible bump) while
  // the payout converges instead of exploding.
  var BASE_REWARD = 1000;
  var STREAK_STEP = 0.10;
  var REWARD_LINEAR_WINS = 12;   // first dozen wins keep the old, snappy ramp
  var REWARD_CAP = 4.5;          // hard ceiling on the streak multiplier

  function rewardMultiplier(run) {
    var wins = Math.max(0, run.battlesWon || 0);
    if (wins <= REWARD_LINEAR_WINS) return 1 + wins * STREAK_STEP;
    // Continue smoothly from where the linear part stopped, then grow with
    // sqrt(extra wins) so the curve flattens instead of compounding.
    var base = 1 + REWARD_LINEAR_WINS * STREAK_STEP;
    var extra = Math.sqrt(wins - REWARD_LINEAR_WINS) * STREAK_STEP * 2.2;
    return Math.min(REWARD_CAP, base + extra);
  }

  // Ascension pays a modest premium -- harder fights should be worth more --
  // but far less than the difficulty rises, so the economy keeps tightening.
  function ascensionRewardBonus(run) {
    return 1 + Math.min(0.6, ascension(run) * 0.12);
  }

  function wildReward(run) {
    return Math.round(BASE_REWARD * rewardMultiplier(run) * ascensionRewardBonus(run));
  }
  function trainerReward(run) {
    return Math.round(BASE_REWARD * 2 * rewardMultiplier(run) * ascensionRewardBonus(run));
  }
  // ------------------------------------------------------------- HEALING ---
  // There is no Poke Center. The team is restored for free after every
  // trainer battle (i.e. once per section) and never in between, so damage
  // taken on the three wild battles genuinely has to be managed.
  //
  // At ascension 3+ that restore becomes PARTIAL (down to 55%), which is the
  // single most effective difficulty lever left once stats have capped: the
  // run stops resetting to full every section and attrition finally compounds.
  function healAll(run) {
    var pct = ascensionEffects(run).healPct;
    run.party.forEach(function (m) {
      // Nuzlocke rule: fainted is permanent. Never resurrect, even if a
      // fainted Pokemon somehow survived in the party.
      if (C.isFainted(m)) return;
      m.hpPct = pct >= 1 ? 1 : Math.max(m.hpPct, Math.min(1, pct));
      // Status is always cured -- a permanent burn across ten sections is
      // punishing in a way that isn't interesting.
      m.status = '';
      for (var k in m.pp) {
        var full = Math.floor(Dex.moves.get(k).pp * 1.6);
        m.pp[k] = pct >= 1 ? full : Math.max(m.pp[k] || 0, Math.round(full * pct));
      }
    });
    return pct;
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
    isGauntlet: isGauntlet,
    nextIsTrainer: nextIsTrainer, advanceBattle: advanceBattle,
    resetSectionStats: resetSectionStats,
    tier: tier, pickWild: pickWild, makeWild: makeWild,
    trainerFor: trainerFor, makeTrainerTeam: makeTrainerTeam,
    wildReward: wildReward, trainerReward: trainerReward,
    rewardMultiplier: rewardMultiplier,
    // ascension
    ASCENSION_START: ASCENSION_START, ASCENSION_EVERY: ASCENSION_EVERY,
    ascension: ascension, ascensionEffects: ascensionEffects,
    fieldEffectFor: fieldEffectFor, eliteModFor: eliteModFor,
    bossClauseFor: bossClauseFor, strategyFor: strategyFor, pickRoleFor: pickRoleFor,
    STRATEGIES: STRATEGIES, ELITE_MODS: ELITE_MODS, BOSS_CLAUSES: BOSS_CLAUSES,
    FIELD_POOL: FIELD_POOL,
    BASE_REWARD: BASE_REWARD, healAll: healAll,
    rollMart: rollMart, applyItem: applyItem,
    tutorOptions: tutorOptions, teachMove: teachMove, abilityOptions: abilityOptions,
    mvp: mvp, roster: roster, trainPlayerMon: trainPlayerMon,
    SHINY_ODDS: SHINY_ODDS
  };
})();
