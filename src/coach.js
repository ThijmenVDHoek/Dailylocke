// ============================================================================
// coach.js — the teaching layer: Professor Elm, lessons, coach marks and the
// plain-language helpers that turn Pokemon jargon into something a casual
// player can act on.
//
// WHY THIS EXISTS
//   Dailylocke is a genuinely deep game (1025 species, real Showdown movesets,
//   held items, natures, EVs, evolution branches, eight ball types, thirteen
//   medicines, ascension). To a seasoned player that is the appeal. To a
//   casual one it is a wall, and the observed failure mode is always the same:
//   they mash the first attack, skip the Mart, never train, never hold an
//   item, and lose to the section boss without ever discovering that the game
//   had answers for them.
//
// THE RULES THIS MODULE ENFORCES (from NN/g + GMTK research, see
// docs/ONBOARDING-RESEARCH.md)
//   1. ONE idea per card. Never two.
//   2. NEVER chain cards. If a second lesson wants to fire while one is on
//      screen (or immediately after), it waits for the next beat. Chained tips
//      are the single most-cited coach-mark antipattern: people start
//      dismissing them unread and the app starts to feel daunting.
//   3. Fire on INTERACTION events, never on timers. A tip that appears because
//      two seconds elapsed is not contextual, it is just early.
//   4. A hint must never look like a button. Everything here carries the
//      professor's portrait and the .coach- visual register.
//   5. Always skippable, always replayable. "Skip all tips" is permanent and
//      reversible from Profile; every lesson can be re-read from the Guide.
//
// WHAT LIVES WHERE
//   Coach.lesson(id, ...)   fire a lesson (deduped, queued, respects opt-out)
//   Coach.tipBadge(...)     the small ✦Tip marker on a thing worth choosing
//   Coach.moveFacts(...)    STAB / physical-special match / drawbacks
//   Coach.roleOf(...)       "Fast attacker", "Bulky", ... from base stats
//   Coach.itemPlain(...)    the honest one-liner for a confusing item
//   Coach.LESSONS           the syllabus, in the order the game makes it matter
//
// STATE lives on the profile (so it rides along in a backup, and so a player
// who restores on a new device is not re-taught from scratch):
//   profile.coach = { seen:{}, off:false, badges:true, onboarded:false,
//                     modes:{}, prologue:false }
// ============================================================================
(function () {
  var Dex = window.PS.Dex;

  // ------------------------------------------------------------ ADVISOR ----
  // A professor reads instantly as "the person who explains things" — it
  // leans on knowledge every Pokemon player already has, which is exactly the
  // "lean on what players already know" principle. Sycamore's Showdown sprite
  // is friendly, modern and reads well at 40px against a dark UI.
  var ADVISOR = {
    id: 'sycamore',
    name: 'Professor Elm',
    sprite: 'https://play.pokemonshowdown.com/sprites/trainers/sycamore.png'
  };

  function advisorImg(px) {
    return '<img class="coach-face" src="' + ADVISOR.sprite + '" alt="" width="' + px + '" ' +
      'height="' + px + '" loading="lazy" decoding="async" ' +
      'onerror="this.style.visibility=\'hidden\'">';
  }

  // -------------------------------------------------------------- STATE ----
  // The module never reads localStorage directly: app.js owns the profile
  // object and hands it over, so there is exactly one writer.
  var profile = null;
  var saveFn = null;

  function state() {
    if (!profile) return { seen: {}, off: false, badges: true, onboarded: false, modes: {}, prologue: false };
    if (!profile.coach || typeof profile.coach !== 'object') {
      profile.coach = { seen: {}, off: false, badges: true, onboarded: false, modes: {}, prologue: false };
    }
    var c = profile.coach;
    if (!c.seen || typeof c.seen !== 'object') c.seen = {};
    if (!c.modes || typeof c.modes !== 'object') c.modes = {};
    if (typeof c.badges !== 'boolean') c.badges = true;
    return c;
  }

  function attach(p, save) { profile = p; saveFn = save; return state(); }
  function persist() { if (saveFn) { try { saveFn(); } catch (e) {} } }

  function tipsOn() { return !state().off; }
  function badgesOn() { var c = state(); return !c.off && c.badges !== false; }
  function seen(id) { return !!state().seen[id]; }
  function markSeen(id) { state().seen[id] = 1; persist(); }
  // Put a lesson back in the syllabus. Used when a card was dismissed by the
  // UI rather than by the player, so it is not silently written off as read.
  function unsee(id) { delete state().seen[id]; persist(); }
  function setOff(v) { state().off = !!v; persist(); }
  function setBadges(v) { state().badges = !!v; persist(); }
  function isOnboarded() { return !!state().onboarded; }
  function setOnboarded(v) { state().onboarded = !!v; persist(); }
  function inPrologue() { return !!state().prologue; }
  function setPrologue(v) { state().prologue = !!v; persist(); }
  function modeSeen(m) { return !!state().modes[m]; }
  function markMode(m) { state().modes[m] = 1; persist(); }

  // Forget every lesson so the whole thing can be replayed from Profile.
  function resetAll() {
    var c = state();
    c.seen = {}; c.modes = {}; c.off = false; c.badges = true;
    c.onboarded = false; c.prologue = false;
    persist();
  }

  // ====================================================== KNOWLEDGE LAYER ===
  // These helpers are LAYER 1: they stay on forever, for everyone, including
  // veterans. They add information that was always true but never shown.

  // ---- what is this Pokemon actually for? --------------------------------
  // Derived from base stats, phrased the way a person would say it out loud.
  // A casual player picks a starter on looks because "BST 405" means nothing;
  // "Fast attacker" means something immediately.
  //
  // The comparison is RELATIVE to the Pokemon's own average, not against
  // absolute thresholds. Absolute cutoffs are calibrated for fully-evolved
  // Pokemon, so every base-stage starter came out as "All-rounder" -- which
  // is exactly the screen where the label matters most and told the player
  // nothing. Treecko is genuinely a fast special attacker *for a Treecko*,
  // and that is the useful comparison when choosing between three of them.
  function roleOf(speciesId) {
    var sp = Dex.species.get(speciesId);
    if (!sp || !sp.exists) return null;
    var b = sp.baseStats;
    var mean = (b.hp + b.atk + b.def + b.spa + b.spd + b.spe) / 6;
    // How far above its own average is each aspect? 1.0 = dead average.
    var speed = b.spe / mean;
    var off = Math.max(b.atk, b.spa) / mean;
    var bulk = ((b.hp + b.def + b.spd) / 3) / mean;

    var fast = speed >= 1.15;
    var veryFast = speed >= 1.35;
    var slow = speed <= 0.8;
    var hitsHard = off >= 1.25;
    var beefy = bulk >= 1.2;
    var frail = bulk <= 0.85;

    if (hitsHard && frail && fast) {
      return { key: 'glass', label: 'Glass cannon',
               note: 'Hits extremely hard and moves first, but folds to almost anything.' };
    }
    if (hitsHard && fast) {
      return { key: 'fast', label: 'Fast attacker',
               note: 'Usually moves first and hits hard. Great for finishing things off.' };
    }
    if (beefy && slow && !hitsHard) {
      return { key: 'wall', label: 'Wall',
               note: 'Very hard to knock out, but slow and low on damage.' };
    }
    if (beefy && hitsHard) {
      return { key: 'tank', label: 'Tank',
               note: 'Hits hard and takes hits. It will usually move second.' };
    }
    if (beefy) {
      return { key: 'bulky', label: 'Bulky',
               note: 'Built to survive. Good at soaking up a hit you cannot avoid.' };
    }
    if (hitsHard) {
      return { key: 'power', label: 'Heavy hitter',
               note: 'Big damage, but it will often move second.' };
    }
    if (veryFast) {
      return { key: 'sprinter', label: 'Very fast',
               note: 'Almost always moves first, though its attacks are not huge.' };
    }
    if (fast) {
      return { key: 'quick', label: 'Quick',
               note: 'Leans on speed rather than raw power.' };
    }
    return { key: 'balanced', label: 'All-rounder',
             note: 'Even across the board \u2014 no real weakness, no real speciality.' };
  }

  // Which attacking stat this Pokemon actually wants to use. Everything in
  // the game already assumes the player knows this (trainPlayerMon() silently
  // invests 32 points into whichever is higher and picks Adamant or Modest to
  // match) — this just says it out loud.
  function attackStyle(speciesId) {
    var sp = Dex.species.get(speciesId);
    if (!sp || !sp.exists) return null;
    var b = sp.baseStats;
    if (b.atk === b.spa) return { key: 'mixed', label: 'Mixed', note: 'Equally good with physical and special moves.' };
    var physical = b.atk > b.spa;
    var gap = Math.abs(b.atk - b.spa);
    return {
      key: physical ? 'Physical' : 'Special',
      label: physical ? 'Physical' : 'Special',
      strong: gap >= 20,
      note: physical
        ? 'Its Attack is higher, so physical moves hit harder.'
        : 'Its Sp. Atk is higher, so special moves hit harder.'
    };
  }

  // How big is this Pokemon, in words? BST is a power budget; a bar plus a
  // word is legible where a raw number is not.
  //
  // `speciesId` is optional but strongly preferred: something that can still
  // evolve is not "weak", it is EARLY, and telling a player their brand-new
  // starter is weak on the screen where they pick it is both discouraging and
  // beside the point. The bar still shows the real number either way.
  function powerBand(bst, speciesId) {
    var unevolved = speciesId ? canStillEvolve(speciesId) : false;
    var pct = Math.max(8, Math.min(100, Math.round((bst / 720) * 100)));
    if (unevolved && bst < 450) {
      return { label: 'Room to grow', pct: pct, early: true };
    }
    if (bst >= 600) return { label: 'Enormous', pct: pct };
    if (bst >= 525) return { label: 'Very strong', pct: pct };
    if (bst >= 470) return { label: 'Strong', pct: pct };
    if (bst >= 400) return { label: 'Decent', pct: pct };
    if (bst >= 330) return { label: 'Modest', pct: pct };
    return { label: 'Fragile', pct: pct };
  }

  // ---- move facts: STAB, stat match, and the traps -----------------------
  // Everything here comes out of data already loaded by the sim, so it costs
  // nothing and can be shown on every move list in the game.
  //
  // `mon` may be a live party member or {id, types}. Both are supported
  // because the same badges appear on starter cards, the training list, the
  // party sheet and the catch screen.
  function moveFacts(moveId, mon) {
    var m = Dex.moves.get(moveId);
    if (!m || !m.exists) return null;
    var out = { stab: false, match: null, warn: [], good: [] };

    var types = (mon && mon.types) || [];
    if (!types.length && mon && mon.id) {
      var sp0 = Dex.species.get(mon.id);
      if (sp0 && sp0.exists) types = sp0.types || [];
    }

    // STAB — the single most valuable thing a casual player does not know.
    if (m.category !== 'Status' && types.indexOf(m.type) >= 0) out.stab = true;

    // Does this move use the stat this Pokemon is actually good at?
    if (m.category !== 'Status' && mon && mon.id) {
      var style = attackStyle(mon.id);
      if (style && style.key !== 'mixed') {
        out.match = (m.category === style.key);
        out.mismatchNote = out.match ? null
          : 'Uses ' + (m.category === 'Physical' ? 'Attack' : 'Sp. Atk') +
            ', which is this Pokemon\u2019s weaker stat.';
      }
    }

    // The drawbacks. These are exactly the moves a casual player picks
    // because the power number is big, and then loses to.
    var f = m.flags || {};
    if (f.recharge) out.warn.push({ k: 'recharge', t: 'Must rest after', d: 'You lose your next turn completely.' });
    if (f.charge) out.warn.push({ k: 'charge', t: 'Charges first', d: 'Does nothing on turn one, attacks on turn two.' });
    if (m.self && m.self.volatileStatus === 'lockedmove') {
      out.warn.push({ k: 'locked', t: 'Locks you in', d: 'You must keep using it, then get confused.' });
    }
    if (m.recoil) out.warn.push({ k: 'recoil', t: 'Hurts you', d: 'You take a share of the damage you deal.' });
    if (m.hasCrashDamage) out.warn.push({ k: 'crash', t: 'Crashes on a miss', d: 'You take damage if it misses.' });
    if (m.self && m.self.boosts) {
      var drops = Object.keys(m.self.boosts).filter(function (k) { return m.self.boosts[k] < 0; });
      if (drops.length) out.warn.push({ k: 'drop', t: 'Lowers your stats', d: 'Drops your own ' + drops.map(statWord).join(' and ') + ' after use.' });
    }
    // Negative priority always moves last. On Focus Punch that is fatal --
    // any hit at all cancels the move entirely -- and the card otherwise just
    // advertises 150 power, which is exactly the trap.
    if (m.priority < 0 && m.category !== 'Status') {
      out.warn.push({ k: 'last', t: 'Always moves last',
                      d: m.id === 'focuspunch'
                        ? 'And it fails completely if you are hit first.'
                        : 'The opponent attacks before you do, every time.' });
    }
    if (m.category !== 'Status' && m.accuracy !== true && m.accuracy < 85) {
      out.warn.push({ k: 'acc', t: 'Often misses', d: 'Only ' + m.accuracy + '% accurate.' });
    }
    if (m.category !== 'Status' && m.pp <= 5) {
      out.warn.push({ k: 'pp', t: 'Few uses', d: 'Low PP \u2014 it runs out fast, and PP does not refill between battles.' });
    }
    if (/^(selfdestruct|explosion|memento|healingwish|lunardance|finalgambit|mistyexplosion)$/.test(m.id)) {
      out.warn.push({ k: 'faint', t: 'You faint', d: 'Your Pokemon is knocked out \u2014 and in a nuzlocke, that is forever.' });
    }

    // The good stuff a casual player also misses.
    if (m.category === 'Status' && m.boosts) {
      var ups = Object.keys(m.boosts).filter(function (k) { return m.boosts[k] > 0; });
      if (ups.length) out.good.push({ k: 'setup', t: 'Boosts you', d: 'Raises your ' + ups.map(statWord).join(' and ') + '. Two turns of this can win a fight.' });
    }
    if (m.priority > 0) out.good.push({ k: 'prio', t: 'Goes first', d: 'Always strikes before normal moves, whatever the speed.' });
    if (m.drain) out.good.push({ k: 'drain', t: 'Heals you', d: 'You recover part of the damage dealt.' });
    if (m.status) out.good.push({ k: 'status', t: 'Inflicts ' + statusWord(m.status), d: 'Status also makes a wild Pokemon much easier to catch.' });
    if (m.heal) out.good.push({ k: 'heal', t: 'Restores HP', d: 'Heals your own Pokemon without using an item.' });

    return out;
  }

  function statWord(k) {
    return { hp: 'HP', atk: 'Attack', def: 'Defense', spa: 'Sp. Atk', spd: 'Sp. Def',
             spe: 'Speed', accuracy: 'accuracy', evasion: 'evasion' }[k] || k;
  }
  function statusWord(s) {
    return { brn: 'a burn', par: 'paralysis', psn: 'poison', tox: 'bad poison',
             slp: 'sleep', frz: 'freeze' }[s] || s;
  }

  // Compact badge markup for any move list. Deliberately tiny: these appear
  // on cards that already carry a type chip and a power number.
  function moveBadges(moveId, mon, opts) {
    opts = opts || {};
    var f = moveFacts(moveId, mon);
    if (!f) return '';
    var out = '';
    if (f.stab) {
      out += '<span class="mv-badge stab" data-tip="text:<b>STAB</b> \u2014 same-type attack bonus. ' +
        'This move matches one of the Pokemon\u2019s own types, so it deals <b>50% more damage</b>.">STAB</span>';
    }
    if (f.match === false && !opts.compact) {
      out += '<span class="mv-badge off" data-tip="text:' + esc(f.mismatchNote || '') +
        '">weak stat</span>';
    }
    if (f.warn.length) {
      var w = f.warn[0];
      out += '<span class="mv-badge warn" data-tip="text:<b>' + esc(w.t) + '</b> \u2014 ' + esc(w.d) +
        '">' + esc(w.t) + '</span>';
    } else if (!opts.compact && f.good.length) {
      var g = f.good[0];
      out += '<span class="mv-badge good" data-tip="text:<b>' + esc(g.t) + '</b> \u2014 ' + esc(g.d) +
        '">' + esc(g.t) + '</span>';
    }
    return out;
  }

  // ---- honest item copy ---------------------------------------------------
  // The names are canon and stay canon; this is the subtitle that goes with
  // them. "Full Heal" is the worst offender in the game: it cures status and
  // restores ZERO HP, and it sits in the shop directly beside "Full Restore",
  // which does both. Everyone reads it as "heals everything".
  var ITEM_PLAIN = {
    fullheal:    { one: 'Status only \u2014 no HP', long: 'Cures poison, burn, paralysis, sleep or freeze. It restores <b>no HP at all</b>. For HP you want a Potion.' },
    fullrestore: { one: 'Full HP + cures status', long: 'The one that really does everything: back to full HP <b>and</b> clears any status.' },
    maxpotion:   { one: 'Full HP, status stays', long: 'Restores every point of HP, but a burn or paralysis will still be there afterwards.' },
    potion:      { one: 'Small heal (20%)', long: 'Restores a fifth of max HP. Cheap, and enough to survive one more hit.' },
    superpotion: { one: 'Medium heal (35%)', long: 'A third of max HP.' },
    hyperpotion: { one: 'Big heal (50%)', long: 'Half of max HP.' },
    revive:      { one: 'Does NOT work here', long: 'This is a nuzlocke: a fainted Pokemon is gone forever. Revives cannot bring it back.' },
    maxrevive:   { one: 'Does NOT work here', long: 'This is a nuzlocke: a fainted Pokemon is gone forever. Revives cannot bring it back.' },
    antidote:    { one: 'Poison only', long: 'Cures poison and nothing else. Full Heal covers everything.' },
    awakening:   { one: 'Sleep only', long: 'Wakes a sleeping Pokemon. Nothing else.' },
    ether:       { one: 'Refills one move', long: 'Move uses (PP) do not refill between battles. This tops one move back up by 10.' },
    maxether:    { one: 'Fully refills one move', long: 'Restores one move\u2019s uses completely.' },
    elixir:      { one: 'Refills every move', long: 'Adds 10 uses back to all four moves at once.' },
    pokeball:    { one: 'The basic ball', long: 'Works best on a weakened target. Cheap enough to throw several.' },
    greatball:   { one: '1.5\u00d7 better than a Poke Ball', long: 'A straight upgrade. Worth it on anything you actually want.' },
    ultraball:   { one: '2\u00d7 better than a Poke Ball', long: 'The reliable one. Use it when the catch really matters.' },
    duskball:    { one: '3\u00d7 \u2014 best odds here', long: 'Every route in this game counts as dark, so this is always at full strength.' },
    timerball:   { one: 'Gets better each turn', long: 'Weak on turn one, up to 4\u00d7 in a long fight. Good if you plan to whittle it down.' },
    netball:     { one: '3.5\u00d7 on Water and Bug', long: 'Excellent against those two types, ordinary against everything else.' },
    quickball:   { one: '5\u00d7 \u2014 but only turn one', long: 'Throw it immediately or not at all. After turn one it is just a Poke Ball.' },
    masterball:  { one: 'Never fails', long: 'A guaranteed catch, once. Save it for something you could never weaken safely.' },
    rarecandy:   { one: 'Evolves level-up Pokemon', long: 'Nothing in this game gains levels \u2014 this is how a level-up evolution happens instead.' },
    linkcable:   { one: 'Evolves trade Pokemon', long: 'Stands in for trading, which does not exist here.' },
    soothebell:  { one: 'Evolves friendship Pokemon', long: 'Stands in for high friendship.' }
  };

  function itemPlain(id) { return ITEM_PLAIN[id] || null; }
  function itemOneLiner(id) { var p = ITEM_PLAIN[id]; return p ? p.one : ''; }

  // Held items are the biggest untouched lever in the game for a casual
  // player: they cost money, they are permanent, and the Showdown
  // descriptions are written for people who already know. These are the ones
  // the Mart actually stocks often.
  var HELD_PLAIN = {
    leftovers:    'Heals a little every turn. Great on anything you want to keep alive.',
    focussash:    'Survives one hit that would knock it out, from full HP. Once per battle.',
    choicescarf:  'Much faster \u2014 but you can only use the first move you pick.',
    choiceband:   'Big physical damage \u2014 but you can only use the first move you pick.',
    choicespecial: 'Big special damage \u2014 but locked to one move.',
    choicespecs:  'Big special damage \u2014 but you can only use the first move you pick.',
    lifeorb:      'Everything hits harder, but you chip yourself each attack.',
    assaultvest:  'Much tougher against special attacks. You cannot use status moves.',
    rockyhelmet:  'Anything that touches you takes damage back.',
    eviolite:     'Only works on a Pokemon that can still evolve \u2014 makes it far bulkier.',
    heavydutyboots: 'Ignores entry hazards laid on your side.',
    sitrusberry:  'Auto-heals once when you drop to half HP.',
    lumberry:     'Auto-cures one status the moment you get it.',
    expertbelt:   'Super-effective hits do noticeably more.',
    airballoon:   'Immune to Ground moves until you take a hit.',
    quickclaw:    'Sometimes lets you move first out of nowhere.',
    focusband:    'Sometimes survives a knockout blow.',
    shellbell:    'Heals you a little every time you deal damage.',
    scopelens:    'Critical hits happen more often.',
    widelens:     'Makes your moves slightly more accurate.',
    brightpowder: 'Makes the opponent miss slightly more often.',
    muscleband:   'Physical moves hit a bit harder.',
    wiseglasses:  'Special moves hit a bit harder.',
    boosterenergy: 'Boosts the best stat of a Paradox Pokemon immediately.',
    safetygoggles: 'Immune to powder moves and weather chip damage.',
    ejectbutton:  'Swaps you out automatically when you get hit.',
    kingsrock:    'Attacks can make the target flinch.',
    whiteherb:    'Undoes the first stat drop you suffer.',
    mentalherb:   'Frees you from moves that stop you attacking.'
  };
  function heldPlain(id) { return HELD_PLAIN[id] || null; }

  // Is this held item a sensible fit for this Pokemon? Powers the ✦Tip badge
  // in the Mart. Deliberately conservative: a badge that is wrong is worse
  // than no badge.
  function heldFitsMon(itemId, mon) {
    if (!mon || !mon.id) return false;
    var sp = Dex.species.get(mon.id);
    if (!sp || !sp.exists) return false;
    var b = sp.baseStats;
    var style = attackStyle(mon.id);
    switch (itemId) {
      case 'choiceband':  return style && style.key === 'Physical' && b.atk >= 100;
      case 'choicespecs': return style && style.key === 'Special' && b.spa >= 100;
      case 'muscleband':  return style && style.key === 'Physical';
      case 'wiseglasses': return style && style.key === 'Special';
      case 'choicescarf': return b.spe >= 60 && b.spe <= 100 && Math.max(b.atk, b.spa) >= 95;
      case 'leftovers':   return (b.hp + b.def + b.spd) >= 280;
      case 'assaultvest': return b.spd >= 70 && Math.max(b.atk, b.spa) >= 85;
      case 'rockyhelmet': return b.def >= 90;
      case 'focussash':   return (b.hp + b.def + b.spd) < 270 && Math.max(b.atk, b.spa) >= 95;
      case 'lifeorb':     return Math.max(b.atk, b.spa) >= 100;
      case 'eviolite':    return canStillEvolve(mon.id);
      case 'expertbelt':  return Math.max(b.atk, b.spa) >= 90;
      case 'sitrusberry': return true;
      case 'lumberry':    return true;
      default: return false;
    }
  }

  function canStillEvolve(id) {
    var sp = Dex.species.get(id);
    return !!(sp && sp.exists && sp.evos && sp.evos.length);
  }

  // Best-fitting party member for an item, or null. Used for "great on Kip".
  function bestHolderFor(itemId, party) {
    if (!party || !party.length) return null;
    for (var i = 0; i < party.length; i++) {
      if (!party[i].item && heldFitsMon(itemId, party[i])) return party[i];
    }
    for (var j = 0; j < party.length; j++) {
      if (heldFitsMon(itemId, party[j])) return party[j];
    }
    return null;
  }

  // ============================================================== LESSONS ===
  // The syllabus. Ordered by when the game first makes each idea matter, not
  // by how a manual would be organised. `where` is the Guide grouping.
  //
  // Copy rules: one idea, ~2 short sentences, no jargon that has not just
  // been defined, and always phrased as something to DO.
  var LESSONS = [
    {
      id: 'welcome', where: 'basics', title: 'One life each',
      body: 'This is a <b>nuzlocke</b>: if one of your Pokemon faints, it is gone for the rest of the run. ' +
            'No revives, no second chances. That one rule is what makes every other decision matter.'
    },
    {
      id: 'starter', where: 'basics', title: 'Pick on the stats, not the sprite',
      body: 'Each card shows what that Pokemon is <b>good at</b> and whether it prefers <b>physical</b> or <b>special</b> moves. ' +
            'A fast attacker finishes fights quickly; a wall survives them. Both work \u2014 just know which one you took.'
    },
    {
      id: 'battleBar', where: 'battle', title: 'Your five options',
      body: '<b>Moves</b> attack. <b>Bag</b> uses an item. <b>Party</b> switches Pokemon \u2014 switching costs a turn but ' +
            'can save a life. <b>Run</b> leaves a wild fight for free, minus the prize money.'
    },
    {
      id: 'effect', where: 'battle', title: 'Read the \u00d7 numbers',
      body: 'Every move button shows how well it lands: <b>\u00d72</b> is super effective, <b>\u00d70.5</b> is resisted, <b>\u2014</b> means no effect at all. ' +
            'A weak super-effective move usually beats a strong resisted one.'
    },
    {
      id: 'stab', where: 'battle', title: 'The STAB bonus',
      body: 'A move marked <b>STAB</b> matches your Pokemon\u2019s own type and deals <b>50% more damage</b>. ' +
            'It is free power \u2014 which is why most good movesets keep one or two.'
    },
    {
      id: 'catch', where: 'catching', title: 'This is your one catch',
      body: 'Only the <b>first</b> wild Pokemon of each section can be caught. Knock its HP down first \u2014 ' +
            'and a status like <b>sleep</b> or <b>paralysis</b> makes the ball far more likely to hold.'
    },
    {
      id: 'caught', where: 'catching', title: 'It joins you as-is',
      body: 'A caught Pokemon keeps the HP, PP and status it had when you caught it. ' +
            'Give it a name you will recognise \u2014 you only get one of it.'
    },
    {
      id: 'route', where: 'basics', title: 'How a section works',
      body: 'Four stops: a <b>capture</b> encounter, two <b>cash</b> battles you may skip, then the <b>trainer</b>. ' +
            'HP and move uses never reset in between \u2014 only beating the trainer heals you.'
    },
    {
      id: 'skipping', where: 'basics', title: 'Those two fights are your budget',
      body: 'The middle battles pay the money you spend on balls, potions and held items. ' +
            'Skip them and you reach the trainer poorer \u2014 that is the trade, and it is a real one.'
    },
    {
      id: 'mart', where: 'items', title: 'Spend it, do not hoard it',
      body: 'Money does nothing at the end of a run. Balls first, then something to heal with. ' +
            'Anything marked <b>\u2726 Tip</b> is worth a look for the team you actually have.'
    },
    {
      id: 'fullheal', where: 'items', title: 'Careful: Full Heal is not a full heal',
      body: '<b>Full Heal</b> cures status and restores <b>no HP whatsoever</b>. ' +
            'The one that does both is <b>Full Restore</b>. Read the grey line under every item \u2014 it says what the item really does.'
    },
    {
      id: 'trainer', where: 'basics', title: 'The trainer is the boss',
      body: 'A full team, better items and smarter tactics. <b>Heal up before you press it</b> \u2014 ' +
            'and if you win, every survivor is restored to full for free.'
    },
    {
      id: 'save', where: 'saving', title: 'Your run lives in this browser',
      body: 'It saves automatically, but clearing your browser data or switching device will lose it. ' +
            '<b>Download a backup</b> from the menu to keep it safe \u2014 that same file loads your run on any other device.'
    },
    {
      id: 'train', where: 'training', title: 'Training changes everything but the species',
      body: 'One payment lets you rewrite <b>moves</b>, <b>ability</b>, <b>nature</b> and <b>stat points</b> as much as you like. ' +
            'It is the strongest thing money can buy, and most players never open it.'
    },
    {
      id: 'moveChoice', where: 'training', title: 'Picking moves that actually work',
      body: 'Prefer <b>STAB</b> moves that use your Pokemon\u2019s stronger attack stat, and keep two different types for coverage. ' +
            'Watch the red badges: <b>must rest after</b> and <b>charges first</b> mean you give the enemy a free turn.'
    },
    {
      id: 'held', where: 'items', title: 'Held items are free power',
      body: 'One item per Pokemon, active in every battle, and it never runs out. ' +
            '<b>Leftovers</b> heals each turn, <b>Focus Sash</b> survives one lethal hit. Most runs are lost holding nothing.'
    },
    {
      id: 'evolve', where: 'training', title: 'Evolving',
      body: 'Nothing levels up here \u2014 evolution comes from an <b>item</b> instead, sold in the Mart when someone in your party can use it. ' +
            'It is a big, permanent stat jump.'
    },
    {
      id: 'evoBranch', where: 'training', title: 'This one has a choice',
      body: 'Some Pokemon can evolve into more than one thing, and you only get to pick once. ' +
            'Check the stats and typing of each before you commit \u2014 there is no going back.'
    }
  ];

  var LESSON_BY_ID = {};
  LESSONS.forEach(function (l) { LESSON_BY_ID[l.id] = l; });
  function lessonById(id) { return LESSON_BY_ID[id] || null; }

  // Mode explainers — separate from lessons because they are per-mode and
  // shown on the way IN to a mode, not during play.
  var MODES = {
    daily: {
      title: 'The Daily',
      lede: 'The same challenge for everyone, today only.',
      points: [
        ['Fixed length', 'Five sections, twenty battles, then it ends \u2014 win or lose.'],
        ['Same for everyone', 'Identical seed, identical opponents, identical dice rolls worldwide.'],
        ['Scored once', 'One attempt per day. The result is recorded and shareable, and a daily streak builds up.']
      ]
    },
    free: {
      title: 'Random Run',
      lede: 'A fresh randomised run with no ending.',
      points: [
        ['Endless', 'Sections keep coming and keep getting harder. It ends when your last Pokemon falls.'],
        ['Its own save', 'Separate from the Daily, so a good run here never blocks tomorrow\u2019s Daily.'],
        ['Where to learn', 'Nothing is at stake beyond the run itself \u2014 this is the mode to experiment in.']
      ]
    },
    gauntlet: {
      title: 'Team Gauntlet',
      lede: 'You build the team. Then it is trainers only.',
      points: [
        ['Draft any six', 'Any Pokemon in the game, fully trained, free \u2014 and you set their moves and items.'],
        ['No safety net', 'No wild battles, no money, no items, no running away.'],
        ['Healed each win', 'Survivors are fully restored after every trainer \u2014 but fainted is still forever.']
      ]
    }
  };
  function modeInfo(m) { return MODES[m] || null; }

  // ========================================================== PRESENTATION ==
  // Two surfaces, and only two:
  //   * a SHEET   — a modal lesson card, for ideas that deserve a beat
  //   * a COACH MARK — a small anchored pill pointing at one element
  // Both carry the professor. Neither is ever chained to another.

  var busy = false;          // a card is on screen right now
  var cooldownUntil = 0;     // no second card for a moment after one closes
  var COOLDOWN_MS = 550;
  var host = null;           // the coach-mark layer

  // `busy` gates every lesson, so anything that can set it and then fail to
  // clear it silences the coach for the rest of the session -- the player
  // simply stops being taught, with no visible cause. Route both edges
  // through one place so "released" is impossible to forget.
  function setBusy(on) {
    busy = !!on;
    if (!busy) cooldownUntil = Date.now() + COOLDOWN_MS;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function ensureHost() {
    if (host && host.isConnected) return host;
    host = document.getElementById('coachLayer');
    if (!host) {
      host = document.createElement('div');
      host.id = 'coachLayer';
      host.className = 'coach-layer';
      document.body.appendChild(host);
    }
    // This layer floats above dialogs rather than behind them, so the modal
    // controller must not inert it along with the rest of the page.
    host.setAttribute('data-modal-overlay', '');
    return host;
  }

  // ---- the modal lesson sheet --------------------------------------------
  function showSheet(lesson, opts) {
    opts = opts || {};
    var el = document.getElementById('screenCoach');
    if (!el || !window.Modal) { if (opts.onDone) opts.onDone(); return; }

    var card = el.querySelector('.overlay-card');
    card.innerHTML =
      '<div class="coach-head">' +
        '<span class="coach-portrait">' + advisorImg(52) + '</span>' +
        '<div class="coach-who"><b>' + esc(ADVISOR.name) + '</b>' +
          '<em>' + esc(opts.eyebrow || 'Tip') + '</em></div>' +
      '</div>' +
      '<h3 class="coach-title" id="coachTitle">' + esc(lesson.title) + '</h3>' +
      '<div class="coach-body">' + lesson.body + '</div>' +
      (opts.extra || '') +
      '<div class="coach-actions">' +
        '<button type="button" class="btn-primary wide" data-coach-ok>' + esc(opts.okLabel || 'Got it') + '</button>' +
        (opts.noSkip ? '' : '<button type="button" class="coach-skip" data-coach-skip>Skip all tips</button>') +
      '</div>';

    // Modal.open() is a no-op when the dialog is ALREADY on the stack, and it
    // is the onClose it registers that clears `busy`. Opening a second sheet
    // over a live one would therefore latch `busy` on forever. Close the
    // stale one first so the fresh open really does register a handler.
    if (window.Modal.isOpen(el)) window.Modal.close(el);

    setBusy(true);
    window.Modal.open(el, {
      onClose: function () {
        setBusy(false);
        if (opts.onDone) { try { opts.onDone(); } catch (e) {} }
      }
    });
    card.querySelector('[data-coach-ok]').addEventListener('click', function () {
      window.Modal.close(el);
    });
    var sk = card.querySelector('[data-coach-skip]');
    if (sk) sk.addEventListener('click', function () {
      setOff(true);
      window.Modal.close(el);
      if (window.Game && window.Game.toast) window.Game.toast('Tips off. Turn them back on in Profile.');
    });
  }

  // ---- the anchored coach mark -------------------------------------------
  // Points at exactly one element. Repositions on scroll/resize, and gives up
  // gracefully (falling back to a sheet) if the target is not on screen.
  var activeMark = null;

  function clearMark() {
    if (!activeMark) {
      // No pill, but `busy` may still be set by a sheet whose dialog is gone
      // (a screen change can hide an overlay without routing through
      // Modal.close, and then onClose never runs). Releasing here keeps a
      // vanished card from silencing every later lesson.
      if (busy && !(window.Modal && window.Modal.isOpen('screenCoach'))) setBusy(false);
      // A halo can outlive its pill when the anchor is re-rendered; sweep.
      var orphans = document.querySelectorAll('.coach-spot');
      for (var o = 0; o < orphans.length; o++) orphans[o].classList.remove('coach-spot');
      return;
    }
    var m = activeMark;
    activeMark = null;
    if (m.poll) clearInterval(m.poll);
    if (m.reflow) {
      window.removeEventListener('scroll', m.reflow, true);
      window.removeEventListener('resize', m.reflow);
    }
    if (m.onModal) {
      document.removeEventListener('modal:open', m.onModal);
      document.removeEventListener('modal:close', m.onModal);
    }
    if (m.el && m.el.parentNode) {
      m.el.classList.remove('on');
      var n = m.el;
      setTimeout(function () { if (n.parentNode) n.parentNode.removeChild(n); }, 180);
    }
    if (m.target) m.target.classList.remove('coach-spot');
    // The halo may have moved to a re-rendered clone; sweep any stragglers.
    var stray = document.querySelectorAll('.coach-spot');
    for (var i = 0; i < stray.length; i++) stray[i].classList.remove('coach-spot');
    setBusy(false);
    if (m.onDone) { try { m.onDone(); } catch (e) {} }
  }

  // Is the thing a mark points at still really on screen? A node inside a
  // just-closed overlay is still `isConnected` -- the overlay is only
  // `hidden` -- so connectedness alone is not enough.
  function targetVisible(m) {
    var t = m && m.target;
    if (!t || !t.isConnected) return false;
    return !t.closest('[hidden]');
  }

  function showMark(lesson, target, opts) {
    opts = opts || {};
    // `anchorSel` lets a caller name its target by selector as well as by
    // node. BattleUI rebuilds its whole HUD on every render, so an element
    // captured now is detached moments later -- the halo would vanish and the
    // pill would sit pointing at nothing. With a selector we can re-resolve
    // the target on each reflow and follow it across re-renders.
    var sel = opts.anchorSel || null;
    if (!target && sel) target = document.querySelector(sel);
    if (!target || !target.isConnected) {
      // No anchor at all: the lesson still matters, so deliver it as a sheet.
      showSheet(lesson, opts);
      return;
    }
    clearMark();
    var layer = ensureHost();
    var el = document.createElement('div');
    el.className = 'coach-mark';
    el.setAttribute('role', 'status');
    el.innerHTML =
      '<span class="cm-face">' + advisorImg(34) + '</span>' +
      '<div class="cm-text">' +
        '<b>' + esc(lesson.title) + '</b>' +
        '<span>' + lesson.body + '</span>' +
      '</div>' +
      '<button type="button" class="cm-ok" data-cm-ok>Got it</button>';
    layer.appendChild(el);

    target.classList.add('coach-spot');

    function place() {
      if (!el.isConnected) return;
      // Re-resolve a selector-anchored target: the node we were handed may
      // have been replaced by a re-render since the last frame.
      if (sel && (!target || !target.isConnected)) {
        var next = document.querySelector(sel);
        if (next) {
          target = next;
          activeMark.target = next;
        }
      }
      if (!target || !target.isConnected) return;
      if (!target.classList.contains('coach-spot')) target.classList.add('coach-spot');
      var r = target.getBoundingClientRect();
      var w = el.offsetWidth, h = el.offsetHeight;
      var pad = 10;
      var left = r.left + r.width / 2 - w / 2;
      left = Math.max(pad, Math.min(left, window.innerWidth - w - pad));
      var top = r.top - h - 12;
      el.classList.remove('below');
      if (top < pad) { top = r.bottom + 12; el.classList.add('below'); }
      // If it still doesn't fit, pin it to the bottom of the viewport.
      if (top + h > window.innerHeight - pad) top = Math.max(pad, window.innerHeight - h - pad);
      el.style.left = Math.round(left) + 'px';
      el.style.top = Math.round(top) + 'px';
    }
    activeMark = { el: el, target: target, sel: sel, onDone: opts.onDone };
    place();
    requestAnimationFrame(function () { el.classList.add('on'); place(); });

    var reflow = function () { place(); };
    window.addEventListener('scroll', reflow, true);
    window.addEventListener('resize', reflow);
    // A re-rendered HUD swaps the anchor out from under us; keep the halo and
    // the pill following it for as long as the mark is up.
    var poll = setInterval(place, 400);
    activeMark.reflow = reflow;
    activeMark.poll = poll;
    // A mark only makes sense while the thing it points at is on screen.
    // Two ways that stops being true, both of which used to strand the pill
    // and latch `busy` -- which silently ended the teaching for the rest of
    // the session:
    //   * a dialog OPENS over it, burying the subject behind a scrim;
    //   * the dialog it was anchored INTO closes (the evolve lesson lives on
    //     the party sheet), taking the subject with it.
    // Either way the hint has lost its anchor, so retire it. It was never
    // actually read, so hand it back to the syllabus instead of counting it
    // as taught.
    activeMark.onModal = function (ev) {
      // On close, only give up if the subject really did go away -- closing
      // some unrelated dialog must not cancel a hint that is still valid.
      if (ev && ev.type === 'modal:close' && targetVisible(activeMark)) return;
      if (opts.markedSeen && lesson && lesson.id) unsee(lesson.id);
      clearMark();
    };
    document.addEventListener('modal:open', activeMark.onModal);
    document.addEventListener('modal:close', activeMark.onModal);
    setBusy(true);
    el.querySelector('[data-cm-ok]').addEventListener('click', clearMark);

    // Interacting with the thing being pointed at also dismisses the mark:
    // the player has understood, so the annotation has done its job.
    target.addEventListener('click', clearMark, { once: true });

    try { target.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) {}
  }

  // ---- the public entry point ---------------------------------------------
  // Coach.lesson('mart', { anchor: el })
  //
  // Silently does nothing when: tips are off, this lesson was already seen,
  // or another card is on screen / just closed. That last rule is what stops
  // chains — the caller does not need to know about it.
  function lesson(id, opts) {
    opts = opts || {};
    var l = lessonById(id);
    if (!l) return false;
    if (!opts.force) {
      if (!tipsOn()) return false;
      if (seen(id)) return false;
      if (busy) return false;
      if (Date.now() < cooldownUntil) return false;
    }
    if (!opts.force) markSeen(id);
    if (opts.anchor || opts.anchorSel) {
      // Tell showMark whether this counts against the syllabus, so a hint the
      // UI retires unread can be handed back rather than written off.
      var markOpts = {};
      for (var k in opts) if (Object.prototype.hasOwnProperty.call(opts, k)) markOpts[k] = opts[k];
      markOpts.markedSeen = !opts.force;
      showMark(l, opts.anchor || null, markOpts);
    } else {
      showSheet(l, opts);
    }
    return true;
  }

  // Replay a lesson from the Guide, ignoring every gate.
  function replay(id) {
    var l = lessonById(id);
    if (!l) return;
    clearMark();
    showSheet(l, { force: true, noSkip: true, eyebrow: 'From the guide' });
  }

  // ---- the ✦Tip badge ------------------------------------------------------
  // Marks a thing worth choosing. Stays on for the whole account (it is a
  // recommendation, not a lesson) unless the player turns badges off or
  // skipped tips entirely.
  function tipBadge(reason, opts) {
    if (!badgesOn()) return '';
    opts = opts || {};
    return '<span class="tip-badge' + (opts.cls ? ' ' + opts.cls : '') + '"' +
      (reason ? ' data-tip="text:' + esc(reason) + '"' : '') + '>' +
      '<i aria-hidden="true">\u2726</i>Tip</span>';
  }

  window.Coach = {
    ADVISOR: ADVISOR, advisorImg: advisorImg,
    attach: attach,
    // state
    tipsOn: tipsOn, badgesOn: badgesOn, seen: seen, markSeen: markSeen,
    setOff: setOff, setBadges: setBadges, resetAll: resetAll,
    isOnboarded: isOnboarded, setOnboarded: setOnboarded,
    inPrologue: inPrologue, setPrologue: setPrologue,
    modeSeen: modeSeen, markMode: markMode,
    // knowledge
    roleOf: roleOf, attackStyle: attackStyle, powerBand: powerBand,
    moveFacts: moveFacts, moveBadges: moveBadges,
    itemPlain: itemPlain, itemOneLiner: itemOneLiner,
    heldPlain: heldPlain, heldFitsMon: heldFitsMon, bestHolderFor: bestHolderFor,
    canStillEvolve: canStillEvolve,
    // syllabus
    LESSONS: LESSONS, lessonById: lessonById, MODES: MODES, modeInfo: modeInfo,
    // presentation
    lesson: lesson, replay: replay, sheet: showSheet, clearMark: clearMark,
    tipBadge: tipBadge,
    get busy() { return busy; }
  };
})();
