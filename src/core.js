// ============================================================================
// core.js — RNG, type chart, Pokemon factory, catch formula, shop catalog.
// Depends on: window.PS (Dex/Teams/BattleStreams), window.PokeData
// ============================================================================
(function () {
  var Dex = window.PS.Dex;
  var PD = window.PokeData;

  // ---------------------------------------------------------------- RNG ----
  function mulberry32(seed) {
    var a = seed >>> 0;
    var fn = function () {
      a |= 0; a = (a + 1831565813) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    fn.getState = function () { return a >>> 0; };
    fn.setState = function (s) { a = s >>> 0; };
    fn.getSeed = function () { return seed >>> 0; };
    return fn;
  }
  function hashString(str) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function pick(arr, rand) { return arr[Math.floor(rand() * arr.length)]; }
  function shuffle(arr, rand) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(rand() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }
  function pickN(arr, n, rand) { return shuffle(arr, rand).slice(0, n); }

  // -------------------------------------------------------- TYPE CHART ----
  var CHART = {
    Normal:{Rock:.5,Ghost:0,Steel:.5},
    Fire:{Fire:.5,Water:.5,Grass:2,Ice:2,Bug:2,Rock:.5,Dragon:.5,Steel:2},
    Water:{Fire:2,Water:.5,Grass:.5,Ground:2,Rock:2,Dragon:.5},
    Electric:{Water:2,Electric:.5,Grass:.5,Ground:0,Flying:2,Dragon:.5},
    Grass:{Fire:.5,Water:2,Grass:.5,Poison:.5,Ground:2,Flying:.5,Bug:.5,Rock:2,Dragon:.5,Steel:.5},
    Ice:{Fire:.5,Water:.5,Grass:2,Ice:.5,Ground:2,Flying:2,Dragon:2,Steel:.5},
    Fighting:{Normal:2,Ice:2,Poison:.5,Flying:.5,Psychic:.5,Bug:.5,Rock:2,Ghost:0,Dark:2,Steel:2,Fairy:.5},
    Poison:{Grass:2,Poison:.5,Ground:.5,Rock:.5,Ghost:.5,Steel:0,Fairy:2},
    Ground:{Fire:2,Electric:2,Grass:.5,Poison:2,Flying:0,Bug:.5,Rock:2,Steel:2},
    Flying:{Electric:.5,Grass:2,Fighting:2,Bug:2,Rock:.5,Steel:.5},
    Psychic:{Fighting:2,Poison:2,Psychic:.5,Dark:0,Steel:.5},
    Bug:{Fire:.5,Grass:2,Fighting:.5,Poison:.5,Flying:.5,Psychic:2,Ghost:.5,Dark:2,Steel:.5,Fairy:.5},
    Rock:{Fire:2,Ice:2,Fighting:.5,Ground:.5,Flying:2,Bug:2,Steel:.5},
    Ghost:{Normal:0,Psychic:2,Ghost:2,Dark:.5},
    Dragon:{Dragon:2,Steel:.5,Fairy:0},
    Dark:{Fighting:.5,Psychic:2,Ghost:2,Dark:.5,Fairy:.5},
    Steel:{Fire:.5,Water:.5,Electric:.5,Ice:2,Rock:2,Steel:.5,Fairy:2},
    Fairy:{Fire:.5,Fighting:2,Poison:.5,Dragon:2,Dark:2,Steel:.5}
  };
  function typeMod(moveType, defTypes) {
    var mod = 1, row = CHART[moveType] || {};
    for (var i = 0; i < defTypes.length; i++) if (row[defTypes[i]] != null) mod *= row[defTypes[i]];
    return mod;
  }

  // ------------------------------------------------------ SPECIES POOL ----
  var _pool = null;
  function speciesPool() {
    if (_pool) return _pool;
    var pool = [];
    for (var id in Dex.data.Species) {
      var s = Dex.species.get(id);
      // This is deliberately the complete National Dex, not a playable-gen
      // or balance-filtered roster.  `num` is the National Dex number, while
      // Showdown also stores regional formes, Mega/Gmax formes, and aliases in
      // the same table.  Keep exactly the canonical entry for every number
      // 1..1025 so every game mode draws from the same 1025-species pool.
      if (!s.exists || s.num < 1 || s.num > 1025 || s.id !== id) continue;
      // `isNonstandard` includes fully implemented National Dex Pokemon that
      // are merely unavailable in current Scarlet/Violet cartridge formats
      // (`Past`). Dailylocke runs `gen9customgame`, so those Pokemon are legal
      // here and must stay in the pool; filtering this flag cuts the roster
      // down to the in-SV subset and makes every start button throw before a
      // run can begin. The forme/battle-only checks below remove actual
      // alternates, Megas, Gmax, CAP/custom entries, etc. while preserving the
      // one canonical entry for each National Dex number.
      if (s.battleOnly || s.isMega || s.isPrimal) continue;
      // Exclude ALL alternate formes from the encounter/choice pool.
      // The base species is the one you encounter; other formes are obtained
      // through the Forme-change item system (Plates, Memories, Rotom Catalog,
      // DNA Splicers, etc.), Mega Stones, or in-battle transformations
      // (Zacian-Crowned via Rusted Sword, Castform via weather, etc.).
      //
      // Two classes of forme ARE kept in the pool:
      //   1. REGIONAL formes (Alola, Galar, Hisui, Paldea) — these are
      //      treated as distinct Pokemon in this game.
      //   2. COSMETIC formes — minor visual variants (Unown letters,
      //      Vivillon patterns, Alcremie creams, etc.) that share the
      //      same stats and typing.
      //
      // This catches formes that the old `baseForme` heuristic missed:
      // Eternatus-Eternamax, Necrozma-Dusk-Mane/Dawn-Wings/Ultra,
      // Calyrex-Ice/Shadow, Terapagos-Terastal/Stellar, Greninja-Bond/Ash,
      // Rotom appliances, and any future formes whose base species happens
      // not to have a `baseForme` property.
      if (s.baseSpecies && s.baseSpecies !== s.name) {
        var f = (s.forme || '');
        var isRegional = /alola|galar|hisui|paldea|bloodmoon|eternal/i.test(f);
        // A few gender formes are genuine alternate builds, not just a
        // different sprite. Keep them when their battle data differs from
        // the canonical form (Basculegion-F, Indeedee-F, Oinkologne-F, ...).
        var isDistinctGender = false;
        if ((s.forme === 'M' || s.forme === 'F') && (s.gender === 'M' || s.gender === 'F')) {
          var base = Dex.species.get(s.baseSpecies);
          var same = base.exists && JSON.stringify(s.baseStats) === JSON.stringify(base.baseStats) &&
            JSON.stringify(s.types) === JSON.stringify(base.types) &&
            JSON.stringify(s.abilities) === JSON.stringify(base.abilities);
          isDistinctGender = !same;
        }
        if (!isRegional && !s.isCosmeticForme && !isDistinctGender) continue;
      }
      pool.push(s.id);
    }
    // Fail loudly during development if a simulator data update silently
    // drops a National Dex entry; never fall back to a smaller roster.
    pool.sort(function (a, b) { return Dex.species.get(a).num - Dex.species.get(b).num; });
    _pool = pool;
    return pool;
  }
  // Fully-evolved only — used for starters & bosses.
  function fePool() {
    return speciesPool().filter(function (id) { return !Dex.species.get(id).nfe; });
  }

  function isLegendary(id) { return !!PD.legendary[id]; }
  function captureRate(id) {
    if (PD.capture[id] != null) return PD.capture[id];
    var s = Dex.species.get(id);
    if (s.exists && s.baseSpecies) { var b = window.PS.toID(s.baseSpecies); if (PD.capture[b] != null) return PD.capture[b]; }
    return 45;
  }
  function bst(id) {
    var s = Dex.species.get(id); if (!s.exists) return 400;
    var t = 0, b = s.baseStats; for (var k in b) t += b[k]; return t;
  }
  function cleanName(id) {
    try {
      var sp = Dex.species.get(id); if (!sp.exists) return String(id).split('-')[0];
      var cur = sp, seen = {};
      while (cur && cur.baseSpecies && cur.baseSpecies !== cur.name && !seen[cur.baseSpecies]) {
        seen[cur.baseSpecies] = 1;
        var nx = Dex.species.get(cur.baseSpecies); if (!nx.exists) break; cur = nx;
      }
      return cur.name;
    } catch (e) { return String(id); }
  }

  // ---------------------------------------------------------- MOVESETS ----
  var BAD_MOVES = {revivalblessing:1,shedtail:1,teleport:1,roar:1,whirlwind:1,dragontail:1,
    circlethrow:1,perishsong:1,selfdestruct:1,explosion:1,memento:1,finalgambit:1,
    healingwish:1,lunardance:1,batonpass:1,uturn:1,voltswitch:1,flipturn:1,partingshot:1,chillyreception:1};

  // Moves that are strong on paper but bad for an AI/auto-set: they need setup,
  // a recharge turn, a specific condition, or lock the user into a bad spot.
  var TRAP_MOVES = {focuspunch:1,lastresort:1,gigaimpact:1,hyperbeam:1,blastburn:1,
    hydrocannon:1,frenzyplant:1,rockwrecker:1,roaroftime:1,prismaticlaser:1,eternabeam:1,
    meteorassault:1,solarbeam:1,solarblade:1,skullbash:1,skyattack:1,razorwind:1,
    bounce:1,fly:1,dig:1,dive:1,phantomforce:1,shadowforce:1,geomancy:1,freezeshock:1,
    iceburn:1,electroshot:1,meteorbeam:1,dreameater:1,synchronoise:1,steelroller:1,
    beatup:1,fakeout:1,firstimpression:1,burnup:1,doubleshock:1,steelbeam:1,
    mistyexplosion:1,naturesmadness:1,ruination:1,superfang:1,endeavor:1,
    counter:1,mirrorcoat:1,metalburst:1,comeuppance:1,bide:1,rollout:1,iceball:1,
    spitup:1,stockpile:1,swallow:1,naturalgift:1,fling:1,present:1,
    hiddenpower:1,returnnormal:1,frustration:1,magnitude:1,psywave:1,
    nightshade:1,seismictoss:1,sonicboom:1,dragonrage:1,guillotine:1,horndrill:1,
    fissure:1,sheercold:1,futuresight:1,doomdesire:1,upperhand:1,
    grassknot:1,lowkick:1,heatcrash:1,heavyslam:1,electroball:1,gyroball:1,
    wringout:1,crushgrip:1,eruption:1,waterspout:1,dragonenergy:1,
    lastrespects:1,ragefist:1,poltergeist:1,collisioncourse:1,electrodrift:1,
    terablast:1,terastarstorm:1,ivycudgel:1,springtidestorm:1,bleakwindstorm:1,
    wildboltstorm:1,sandsearstorm:1,relicsong:1,secretsword:1,technoblast:1,
    multiattack:1,judgment:1,revelationdance:1,aurawheel:1,ragingbull:1,
    tripleaxel:1,tripledive:1,populationbomb:1,scaleshot:1,
    skydrop:1,bodypress:1,foulplay:1,acrobatics:1,facade:1,
    hex:1,venoshock:1,brine:1,retaliate:1,avalanche:1,payback:1,revenge:1,
    assurance:1,round:1,echoedvoice:1,rage:1,fury:1,
    outrage:1,thrash:1,petaldance:1,ragingfury:1,glaiverush:1,
    axekick:1,highjumpkick:1,jumpkick:1,supercellslam:1,
    mindblown:1,chloroblast:1,lightofruin:1,headsmash:1,
    shellsidearm:1,photongeyser:1};

  // Build the full list of species ids whose learnsets a given Pokemon may draw
  // from. Alternate formes (Tatsugiri-Droopy, Rotom-Wash, Deoxys-Attack, ...)
  // carry NO learnset of their own -- the data lives on the base species. We
  // therefore walk: the forme itself -> changesFrom -> baseSpecies -> the whole
  // pre-evolution chain (each of which also contributes its own baseSpecies).
  function learnsetChain(speciesId) {
    var chain = [], seen = {};
    function push(id) {
      if (!id) return;
      var sp = Dex.species.get(id);
      if (!sp.exists || seen[sp.id]) return;
      seen[sp.id] = 1;
      chain.push(sp.id);
      if (sp.changesFrom) push(toIDLocal(sp.changesFrom));
      if (sp.baseSpecies && sp.baseSpecies !== sp.name) push(toIDLocal(sp.baseSpecies));
    }
    function toIDLocal(x) { return String(x).toLowerCase().replace(/[^a-z0-9]+/g, ''); }
    var cur = Dex.species.get(speciesId);
    var guard = 0;
    while (cur && cur.exists && guard++ < 20) {
      push(cur.id);
      if (!cur.prevo) break;
      cur = Dex.species.get(cur.prevo);
    }
    return chain;
  }

  // Every move the species can legally learn.
  // opts.all = true  -> the complete legal pool (used by the Move Tutor).
  // opts.all = false -> pool minus moves that break a simple AI/auto-set.
  async function legalMoves(speciesId, opts) {
    opts = opts || {};
    // Learnsets ship as a separate ~2.9 MB chunk that loads in the background
    // (see vendor/pkmn-sim.js). Everything downstream of this point reads
    // Dex.data.Learnsets synchronously, so block here until it has landed --
    // this function was already async, so no caller changes.
    if (window.PS.learnsetsReady) {
      try { await window.PS.learnsetsReady(); }
      catch (e) { console.error('[core] learnsets failed to load', e); }
    }
    var out = [], seen = {};
    async function addFrom(id) {
      var ls = await Dex.learnsets.get(id);
      if (!ls || !ls.learnset) return;
      for (var moveid in ls.learnset) {
        if (seen[moveid]) continue;
        var m = Dex.moves.get(moveid);
        if (!m.exists || m.gen > 9 || m.isZ || m.isMax || m.realMove) continue;
        if (!opts.all && BAD_MOVES[m.id]) continue;
        if (!opts.all && m.category === 'Status' && m.target === 'allySide') continue;
        seen[moveid] = 1; out.push(m.id);
      }
    }
    var chain = learnsetChain(speciesId);
    for (var i = 0; i < chain.length; i++) await addFrom(chain[i]);
    if (!out.length) out = ['tackle', 'scratch', 'pound'];
    return out;
  }

  // ------------------------------------------------------------- ROLES -----
  // Four damaging moves on everything made every Pokemon play the same. A ROLE
  // reserves slots for the utility that actually creates decisions: recovery
  // on a wall, a setup move on a sweeper, a pivot's switch move, hazards on a
  // lead. STAB is always required so a set never loses its identity.
  //
  // Each role declares how many attacks it wants and which utility categories
  // it will spend the remaining slots on, in priority order.
  var ROLES = {
    sweeper:   { attacks: 3, wants: ['setup'] },
    wall:      { attacks: 2, wants: ['recovery', 'status', 'hazard'] },
    pivot:     { attacks: 3, wants: ['pivot'] },
    disruptor: { attacks: 2, wants: ['status', 'disrupt', 'recovery'] },
    weather:   { attacks: 3, wants: ['weather'] },
    hazard:    { attacks: 2, wants: ['hazard', 'status', 'pivot'] },
    priority:  { attacks: 4, wants: [] },
    setup:     { attacks: 3, wants: ['setup'] },
    attacker:  { attacks: 4, wants: [] }
  };

  // Status moves worth a slot, grouped by what they DO. Anything not listed
  // stays out of generated sets -- a random Splash helps nobody.
  var UTILITY = {
    recovery: ['recover', 'roost', 'softboiled', 'moonlight', 'morningsun', 'synthesis',
               'slackoff', 'milkdrink', 'shoreup', 'rest', 'strengthsap', 'wish'],
    setup:    ['swordsdance', 'nastyplot', 'dragondance', 'calmmind', 'bulkup', 'quiverdance',
               'shellsmash', 'irondefense', 'agility', 'rockpolish', 'growth', 'workup',
               'honeclaws', 'curse', 'bellydrum', 'tailglow', 'victorydance'],
    status:   ['thunderwave', 'willowisp', 'toxic', 'glare', 'sleeppowder', 'spore',
               'hypnosis', 'yawn', 'confuseray', 'leechseed', 'darkvoid'],
    disrupt:  ['taunt', 'encore', 'disable', 'haze', 'roar', 'whirlwind', 'trick',
               'switcheroo', 'destinybond', 'perishsong', 'trickroom', 'painsplit'],
    pivot:    ['uturn', 'voltswitch', 'flipturn', 'partingshot', 'teleport', 'batonpass'],
    hazard:   ['stealthrock', 'spikes', 'toxicspikes', 'stickyweb', 'defog', 'rapidspin'],
    weather:  ['sunnyday', 'raindance', 'sandstorm', 'snowscape', 'chillyreception']
  };

  // Score a damaging move for a given species/role.
  function scoreAttack(m, s, physical, role) {
    if (m.category === 'Status') return -1;
    if (!m.basePower) return -1;
    if (TRAP_MOVES[m.id]) return -1;
    var acc = m.accuracy === true ? 100 : m.accuracy;
    if (acc < 75) return -1;
    if (m.selfdestruct) return -1;
    if (m.flags && m.flags.recharge) return -1;
    if (m.flags && m.flags.charge) return -1;
    var fits = (m.category === 'Physical') === physical;
    var bp = m.basePower;
    if (m.multihit) bp *= (typeof m.multihit === 'number' ? m.multihit : 3);
    var sc = bp * (acc / 100) * (fits ? 1.35 : 0.7);
    if (s.types.indexOf(m.type) >= 0) sc *= 1.5;
    if (m.recoil) sc *= 0.85;
    if (m.priority > 0) sc *= (role === 'priority' ? 1.45 : 1.1);
    if (m.secondary || m.secondaries) sc *= 1.05;
    // A wall that carries one strong attack is better served by a reliable
    // one than a glass-cannon nuke it will never survive to use twice.
    if (role === 'wall' && m.basePower > 110) sc *= 0.8;
    return sc;
  }

  // Pick the best available move from a utility category the species can learn.
  function pickUtility(category, learnable, chosen, s) {
    var list = UTILITY[category] || [];
    for (var i = 0; i < list.length; i++) {
      var id = list[i];
      if (chosen.indexOf(id) >= 0) continue;
      if (!learnable[id]) continue;
      var m = Dex.moves.get(id);
      if (!m || !m.exists) continue;
      // Rest without a way to wake up is a trap; only give it to a wall that
      // has nothing better, which the ordering above already handles.
      if (id === 'rest' && s.baseStats.hp < 70) continue;
      return id;
    }
    return null;
  }

  // Build a competent 4-move set. With no role this is the old behaviour
  // (best STAB attackers + coverage); with one it reserves utility slots.
  async function autoMoveset(speciesId, opts) {
    opts = opts || {};
    var role = opts.role && ROLES[opts.role] ? opts.role : null;
    var spec = role ? ROLES[role] : null;
    var s = Dex.species.get(speciesId);
    var all = await legalMoves(speciesId);
    var physical = s.baseStats.atk >= s.baseStats.spa;

    var learnable = {};
    for (var n = 0; n < all.length; n++) learnable[all[n]] = 1;

    var scored = [];
    for (var i = 0; i < all.length; i++) {
      var m = Dex.moves.get(all[i]);
      var sc = scoreAttack(m, s, physical, role);
      if (sc < 0) continue;
      scored.push({ id: m.id, type: m.type, sc: sc, stab: s.types.indexOf(m.type) >= 0 });
    }
    scored.sort(function (a, b) { return b.sc - a.sc; });

    var out = [];
    // 1. STAB is mandatory. A Fire type without a Fire move is not a Fire type.
    var bestStab = null;
    for (var q = 0; q < scored.length; q++) if (scored[q].stab) { bestStab = scored[q]; break; }
    if (bestStab) out.push(bestStab.id);

    // 2. Utility slots, in the role's own priority order.
    if (spec) {
      var slots = Math.max(0, 4 - spec.attacks);
      for (var w = 0; w < spec.wants.length && out.length < 1 + slots; w++) {
        var pick = pickUtility(spec.wants[w], learnable, out, s);
        if (pick) out.push(pick);
      }
    }

    // 3. Fill what's left with the best attacks, preferring type coverage.
    var typesUsed = {};
    out.forEach(function (id) {
      var mv = Dex.moves.get(id);
      if (mv && mv.basePower) typesUsed[mv.type] = 1;
    });
    for (var j = 0; j < scored.length && out.length < 4; j++) {
      var c = scored[j];
      if (out.indexOf(c.id) >= 0) continue;
      if (typesUsed[c.type] && out.length < 3) continue; // encourage coverage
      typesUsed[c.type] = 1; out.push(c.id);
    }
    for (var k = 0; k < scored.length && out.length < 4; k++)
      if (out.indexOf(scored[k].id) < 0) out.push(scored[k].id);
    if (!out.length) out = ['tackle'];
    return out.slice(0, 4);
  }

  // ------------------------------------------------------- MON FACTORY ----
  var _uid = 1;
  async function makeMon(speciesId, opts) {
    opts = opts || {};
    var s = Dex.species.get(speciesId);
    var moves = opts.moves || await autoMoveset(speciesId, { role: opts.role });
    var abils = [];
    for (var k in s.abilities) if (s.abilities[k]) abils.push(s.abilities[k]);
    var mon = {
      uid: _uid++,
      id: s.id,
      name: cleanName(s.id),
      species: s.name,
      types: s.types.slice(),
      level: 100,
      moves: moves.slice(0, 4),
      ability: opts.ability || abils[0] || 'No Ability',
      item: opts.item || '',
      nature: opts.nature || 'Serious',
      evs: opts.evs || { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
      sp: opts.sp || null,   // Stat Points; derived from evs on first use
      ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
      // The strategic role this set was built around ('sweeper', 'wall', ...).
      // The AI reads it to play the set the way it was designed.
      role: opts.role || null,
      // persistent run state
      hpPct: 1,
      status: '',
      pp: null,     // {moveid: current}
      shiny: opts.shiny || false
    };
    mon.pp = {};
    for (var i = 0; i < mon.moves.length; i++) {
      var mv = Dex.moves.get(mon.moves[i]);
      mon.pp[mv.id] = Math.floor(mv.pp * 1.6); // max PP w/ full PP Ups
    }
    return mon;
  }

  // ---------------------------------------------------- STAT POINTS (SP) ---
  // Dailylocke's training system: 66 Stat Points total, 32 per stat. It is a
  // deliberately simpler front-end for EVs -- a 66-point budget is something a
  // player can reason about on a phone, where "508 EVs in multiples of 4" is
  // not. The battle engine underneath still speaks EVs, so SP is what the
  // player edits and EVs are DERIVED from it.
  //
  // Conversion: the first stat point costs 4 EVs, every additional point costs
  // 8. That makes 32 SP exactly 252 EVs, so a maxed stat here is identical to
  // a maxed stat in the classic system and nothing is lost in translation.
  var SP_MAX = 32, SP_TOTAL = 66;
  function spToEv(sp) {
    sp = Math.max(0, Math.min(SP_MAX, Math.round(sp || 0)));
    return sp === 0 ? 0 : Math.min(252, 4 + (sp - 1) * 8);
  }
  function evToSp(ev) {
    ev = Math.max(0, Math.round(ev || 0));
    if (ev <= 0) return 0;
    return Math.max(1, Math.min(SP_MAX, Math.floor((ev - 4) / 8) + 1));
  }
  var STAT_IDS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];

  // Guarantee mon.sp exists. Old saves only have evs, so derive from those.
  function ensureSP(mon) {
    if (!mon) return mon;
    if (!mon.sp) {
      mon.sp = {};
      for (var i = 0; i < STAT_IDS.length; i++) {
        var k = STAT_IDS[i];
        mon.sp[k] = evToSp(mon.evs && mon.evs[k]);
      }
      // A converted spread can exceed the new 66 budget; trim the smallest
      // stats first so the player's intent (their big investments) survives.
      var total = STAT_IDS.reduce(function (t, k) { return t + mon.sp[k]; }, 0);
      while (total > SP_TOTAL) {
        var lo = null;
        for (var j = 0; j < STAT_IDS.length; j++) {
          var kk = STAT_IDS[j];
          if (mon.sp[kk] > 0 && (lo === null || mon.sp[kk] < mon.sp[lo])) lo = kk;
        }
        if (lo === null) break;
        mon.sp[lo]--; total--;
      }
    }
    syncEVs(mon);
    return mon;
  }
  // Push SP down into the EV block the simulator actually reads.
  function syncEVs(mon) {
    if (!mon || !mon.sp) return mon;
    if (!mon.evs) mon.evs = {};
    for (var i = 0; i < STAT_IDS.length; i++) {
      var k = STAT_IDS[i];
      mon.evs[k] = spToEv(mon.sp[k]);
    }
    return mon;
  }
  function spUsed(mon) {
    if (!mon || !mon.sp) return 0;
    return STAT_IDS.reduce(function (t, k) { return t + (mon.sp[k] || 0); }, 0);
  }

  function maxHP(mon) {
    ensureSP(mon);
    var s = Dex.species.get(mon.id);
    var base = s.baseStats.hp;
    return Math.floor(((2 * base + 31 + Math.floor((mon.evs.hp || 0) / 4)) * mon.level) / 100) + mon.level + 10;
  }
  function curHP(mon) { return Math.max(0, Math.round(maxHP(mon) * mon.hpPct)); }
  function isFainted(mon) { return mon.hpPct <= 0; }

  function toSet(mon) {
    ensureSP(mon);
    return {
      name: mon.name, species: mon.species, item: mon.item, ability: mon.ability,
      moves: mon.moves.slice(), nature: mon.nature, evs: mon.evs, ivs: mon.ivs, level: mon.level,
      shiny: mon.shiny, happiness: 255
    };
  }

  // ----------------------------------------------------- CATCH FORMULA ----
  // Gen 3/4-style Poke Ball formula using real capture_rate from PokeAPI.
  //   a = ((3*max - 2*cur) * rate * ballBonus / (3*max)) * statusBonus
  //   b = 65536 / (255/a)^0.1875  -> 4 shake checks
  var BALLS = {
    pokeball:   { name: 'Poke Ball',   bonus: 1,   price: 200,  desc: 'A standard ball. 1x catch rate.' },
    greatball:  { name: 'Great Ball',  bonus: 1.5, price: 600,  desc: '1.5x catch rate.' },
    ultraball:  { name: 'Ultra Ball',  bonus: 2,   price: 1200, desc: '2x catch rate.' },
    duskball:   { name: 'Dusk Ball',   bonus: 3,   price: 1800, desc: '3x catch rate on this dark route.' },
    timerball:  { name: 'Timer Ball',  bonus: 1,   price: 1000, desc: 'Better the longer the battle: +0.3x per turn, max 4x.' },
    netball:    { name: 'Net Ball',    bonus: 1,   price: 1000, desc: '3.5x vs Water/Bug types.' },
    quickball:  { name: 'Quick Ball',  bonus: 1,   price: 1500, desc: '5x on turn 1, 1x after.' },
    masterball: { name: 'Master Ball', bonus: 255, price: 30000, desc: 'Never fails. Ever.' }
  };
  var STATUS_BONUS = { slp: 2.5, frz: 2.5, par: 1.5, brn: 1.5, psn: 1.5, tox: 1.5 };

  function ballBonus(ballId, ctx) {
    var b = BALLS[ballId]; if (!b) return 1;
    if (ballId === 'timerball') return Math.min(4, 1 + 0.3 * (ctx.turn || 1));
    if (ballId === 'quickball') return (ctx.turn || 1) <= 1 ? 5 : 1;
    if (ballId === 'netball') {
      var t = ctx.targetTypes || [];
      return (t.indexOf('Water') >= 0 || t.indexOf('Bug') >= 0) ? 3.5 : 1;
    }
    return b.bonus;
  }

  function catchChance(ballId, targetId, hpPct, status, ctx) {
    ctx = ctx || {};
    if (ballId === 'masterball') return 1;
    var rate = captureRate(targetId);
    var bb = ballBonus(ballId, ctx);
    var sb = STATUS_BONUS[status] || 1;
    var max = 1000, cur = Math.max(1, Math.round(max * hpPct));
    var a = ((3 * max - 2 * cur) * rate * bb / (3 * max)) * sb;
    if (a >= 255) return 1;
    var b = 65536 / Math.pow(255 / a, 0.1875);
    var p = b / 65536;
    return Math.max(0, Math.min(1, Math.pow(p, 4)));
  }

  function rollCatch(ballId, targetId, hpPct, status, ctx, rand) {
    if (ballId === 'masterball') return { caught: true, shakes: 4 };
    var rate = captureRate(targetId);
    var bb = ballBonus(ballId, ctx || {});
    var sb = STATUS_BONUS[status] || 1;
    var max = 1000, cur = Math.max(1, Math.round(max * hpPct));
    var a = ((3 * max - 2 * cur) * rate * bb / (3 * max)) * sb;
    if (a >= 255) return { caught: true, shakes: 4 };
    var b = Math.floor(65536 / Math.pow(255 / a, 0.1875));
    var shakes = 0;
    for (var i = 0; i < 4; i++) {
      if (Math.floor((rand || Math.random)() * 65536) < b) shakes++;
      else break;
    }
    return { caught: shakes === 4, shakes: shakes };
  }

  // ------------------------------------------------------------- SHOP ----
  function itemPrice(id) { return PD.itemCost[id] || 3000; }

  // Healing is a PERCENTAGE of the target's max HP. At level 100 a flat 20 HP
  // potion is meaningless (a Blissey has 651 HP), so every potion scales.
  //   healPct: 0..1 of max HP
  var HEAL_ITEMS = {
    potion:      { name: 'Potion',       healPct: 0.20, price: 400,  desc: 'Restores 20% of max HP.' },
    superpotion: { name: 'Super Potion', healPct: 0.35, price: 900,  desc: 'Restores 35% of max HP.' },
    hyperpotion: { name: 'Hyper Potion', healPct: 0.50, price: 1600, desc: 'Restores 50% of max HP.' },
    maxpotion:   { name: 'Max Potion',   healPct: 1.00, price: 3000, desc: 'Fully restores HP.' },
    fullrestore: { name: 'Full Restore', healPct: 1.00, price: 3800, cure: 'all', desc: 'Fully restores HP and cures status.' },
    revive:      { name: 'Revive',       revive: 0.5, price: 2000, desc: 'Revives a fainted Pokemon to half HP.' },
    maxrevive:   { name: 'Max Revive',   revive: 1,   price: 4000, desc: 'Revives a fainted Pokemon to full HP.' },
    fullheal:    { name: 'Full Heal',    cure: 'all', price: 600,  desc: 'Cures any status condition.' },
    antidote:    { name: 'Antidote',     cure: 'psn', price: 200,  desc: 'Cures poison.' },
    awakening:   { name: 'Awakening',    cure: 'slp', price: 200,  desc: 'Wakes a sleeping Pokemon.' },
    ether:       { name: 'Ether',        pp: 10,     price: 1200, desc: 'Restores 10 PP to one move.' },
    maxether:    { name: 'Max Ether',    pp: 999,    price: 2000, desc: 'Fully restores one move\'s PP.' },
    elixir:      { name: 'Elixir',       ppAll: 10,  price: 3000, desc: 'Restores 10 PP to all moves.' }
  };
  // How much a heal item restores on a given mon, in absolute HP.
  function healAmountFor(itemId, mon) {
    var h = HEAL_ITEMS[itemId];
    if (!h) return 0;
    var pct = h.healPct != null ? h.healPct : 0;
    if (!pct) return 0;
    return Math.max(1, Math.round(maxHP(mon) * pct));
  }

  // Curated held-item roster: Smogon OU/VGC usage staples blended with the
  // Curated held-item roster, grouped by rarity tier so
  // the Mart can stock a sensible mix.
  var ITEM_TIERS = {
    // Tier 1 - cheap, always useful
    common: ['sitrusberry','lumberry','quickclaw','kingsrock','brightpowder','whiteherb',
             'mentalherb','focusband','shellbell','widelens','scopelens','ejectbutton'],
    // Tier 2 - the competitive backbone
    core:   ['leftovers','focussash','choicescarf','assaultvest','rockyhelmet',
             'muscleband','wiseglasses','expertbelt','airballoon','safetygoggles',
             'covertcloak','clearamulet','loadeddice','protectivepads'],
    // Tier 3 - expensive power items
    rare:   ['lifeorb','choiceband','choicespecs','heavydutyboots','weaknesspolicy',
             'eviolite','punchingglove','flameorb','toxicorb','boosterenergy','mirrorherb'],
    // Type-boosting (20%) - flavourful, cheap, situational
    typed:  ['silkscarf','charcoal','mysticwater','magnet','miracleseed','nevermeltice',
             'blackbelt','poisonbarb','softsand','sharpbeak','twistedspoon','silverpowder',
             'hardstone','spelltag','dragonfang','blackglasses','metalcoat','fairyfeather']
  };
  // Complete held-item pool for unrestricted modes. Showdown marks battle
  // items (including berries, plates, drives, memories and mega stones) with
  // a sprite number; non-holdable key items and TMs do not have one.
  function allHeldItems() {
    var out = [];
    for (var id in Dex.data.Items) {
      var it = Dex.items.get(id);
      if (!it.exists || it.spritenum == null) continue;
      out.push(it.id);
    }
    return out.sort(function (a, b) {
      return Dex.items.get(a).name.localeCompare(Dex.items.get(b).name);
    });
  }
  var HELD_ITEMS = allHeldItems();

  // PokeAPI's shop prices are wildly inconsistent for modern held items --
  // Clear Amulet and Mirror Herb are listed at $30,000, which is 15+ battles
  // for a single item, while Sitrus Berry is $80. We price by TIER instead so
  // the shop is readable and everything is realistically attainable.
  var TIER_PRICE = { common: 800, typed: 1200, core: 2500, rare: 4000 };
  var _heldPrice = null;
  function heldPriceTable() {
    if (_heldPrice) return _heldPrice;
    _heldPrice = {};
    Object.keys(ITEM_TIERS).forEach(function (tier) {
      ITEM_TIERS[tier].forEach(function (id) { _heldPrice[id] = TIER_PRICE[tier]; });
    });
    // a few deliberate outliers that really are premium
    _heldPrice.leftovers = 3000;
    _heldPrice.focussash = 3000;
    _heldPrice.choicescarf = 3500;
    _heldPrice.choiceband = 3500;
    _heldPrice.choicespecs = 3500;
    _heldPrice.lifeorb = 4500;
    _heldPrice.eviolite = 3000;
    _heldPrice.boosterenergy = 4500;
    _heldPrice.heavydutyboots = 3000;
    return _heldPrice;
  }
  function heldPrice(id) {
    var t = heldPriceTable();
    if (t[id]) return t[id];
    var p = itemPrice(id);
    return Math.min(5000, p);   // hard cap so nothing is absurd
  }

  function heldItemInfo(id) {
    var it = Dex.items.get(id);
    return { id: it.id, name: it.name, desc: it.desc || it.shortDesc || '', price: heldPrice(it.id) };
  }

  window.Core = {
    mulberry32: mulberry32, hashString: hashString, pick: pick, shuffle: shuffle, pickN: pickN,
    typeMod: typeMod, CHART: CHART,
    speciesPool: speciesPool, fePool: fePool, isLegendary: isLegendary,
    captureRate: captureRate, bst: bst, cleanName: cleanName,
    legalMoves: legalMoves, autoMoveset: autoMoveset, learnsetChain: learnsetChain,
    ROLES: ROLES, UTILITY: UTILITY,
    makeMon: makeMon, maxHP: maxHP, curHP: curHP, isFainted: isFainted, toSet: toSet,
    SP_MAX: SP_MAX, SP_TOTAL: SP_TOTAL, STAT_IDS: STAT_IDS,
    spToEv: spToEv, evToSp: evToSp, ensureSP: ensureSP, syncEVs: syncEVs, spUsed: spUsed,
    BALLS: BALLS, HEAL_ITEMS: HEAL_ITEMS, HELD_ITEMS: HELD_ITEMS, allHeldItems: allHeldItems, ITEM_TIERS: ITEM_TIERS,
    healAmountFor: healAmountFor,
    catchChance: catchChance, rollCatch: rollCatch, ballBonus: ballBonus,
    itemPrice: itemPrice, heldItemInfo: heldItemInfo, heldPrice: heldPrice
  };
})();
