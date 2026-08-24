// ============================================================================
// coach.js — the plain-language layer: turns Pokemon jargon into facts a
// casual player can act on. These are always on, for everyone — they add
// information the game always had but never said out loud (STAB, the stat a
// Pokemon actually wants, honest item copy, good held-item fits). They are not
// tips and never pop up; they live on the cards the player is already reading.
//
// WHAT LIVES HERE
//   Coach.moveFacts(...)    STAB / physical-special match / drawbacks / upsides
//   Coach.moveBadges(...)   compact badge markup for any move list
//   Coach.itemPlain(...)    the honest one-liner for a confusing item
//   Coach.heldPlain(...)    plain-language copy for held items
//   Coach.bestHolderFor(..) best party member for an item (mart recommendations)
//   Coach.attackStyle(...)  which attacking stat this Pokemon actually wants
// ============================================================================

(function () {
  var Dex = window.PS.Dex;

  // app.js owns the profile object; coach no longer keeps any state on it,
  // but attach() is still called from loadProfile()/boot(), so it stays as a
  // harmless no-op to avoid touching every caller.
  function attach() { return null; }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ====================================================== KNOWLEDGE LAYER ===
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
    fullrestore: { one: 'Fully restores one Pokémon', long: 'The only field medicine: restores all HP and PP, and cures any status. It cannot revive a fainted Pokémon.' },
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

  // Is this held item a sensible fit for this Pokemon? Powers the recommendation
  // marker in the Mart. Deliberately conservative: a marker that is wrong is
  // worse than no marker.
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

  // Best-fitting party member for an item, or null.
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

  window.Coach = {
    attach: attach,
    // knowledge
    attackStyle: attackStyle,
    moveFacts: moveFacts, moveBadges: moveBadges,
    itemPlain: itemPlain, itemOneLiner: itemOneLiner,
    heldPlain: heldPlain, heldFitsMon: heldFitsMon, bestHolderFor: bestHolderFor,
    canStillEvolve: canStillEvolve
  };
})();
