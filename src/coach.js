// ============================================================================
// coach.js — the teaching layer: Professor Oak, lessons, coach marks and the
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
//   5. On by default, tutorial-first and replayable. Lessons fire for
//      anyone who has not turned tips off. The guided prologue's scripted
//      beats are gated by the run's own prologue flag; the just-in-time
//      lessons (Mart, training, catching...) fire once each for everyone
//      else. Completing the tutorial pre-marks them read, so a player who
//      finished stays quiet — and every lesson remains in the Guide.
//
// TWO SURFACES, ONE REGISTER
//   Every lesson is the professor, the violet rail and the halo; which frame
//   carries it depends on WHERE the player is:
//     * OUT of battle -- the modal sheet (big portrait, typewriter reveal).
//       The game is already paused on a menu screen, so the card can safely
//       take the whole focus.
//     * IN battle -- the anchored bubble. The fight stays live underneath:
//       the bubble pops right beside the control it explains, dismisses with
//       one tap, and the control keeps its violet halo until the player
//       actually uses it. The taught action is always "press the glowing
//       thing", so nothing has to be held in memory under fire.
//   The small unattached coach-mark pill stays retired; a bubble is always
//   ANCHORED to the element it is about (anchor / anchorSel / resolve).
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
  // "lean on what players already know" principle. Oak's Showdown sprite is
  // familiar, friendly and reads well at 40px against a dark UI.
  var ADVISOR = {
    id: 'oak',
    name: 'Professor Oak',
    sprite: 'https://play.pokemonshowdown.com/sprites/trainers/oak.png'
  };

  // Immersive dialogue: bigger portrait + typewriter + sound for tutorial
  // The text sound is a tiny synthesized blip (Animal Crossing style) made in
  // Web Audio — see GameAudio.synthBlip. Never a Pokemon cry, never a fetch.
  function playTextSound() {
    try {
      if (window.GameAudio && window.GameAudio.synthBlip) {
        window.GameAudio.synthBlip();
        return;
      }
      // Standalone fallback (no audio module loaded yet).
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      var ctx = new AC();
      if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} }
      var t0 = ctx.currentTime;
      var osc = ctx.createOscillator(), gN = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(640 + Math.random() * 280, t0);
      gN.gain.setValueAtTime(0.0001, t0);
      gN.gain.exponentialRampToValueAtTime(0.02, t0 + 0.008);
      gN.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.07);
      osc.connect(gN); gN.connect(ctx.destination);
      osc.start(t0); osc.stop(t0 + 0.085);
    } catch (e) { /* audio blocked: text reveal still works */ }
  }

  // Typewriter reveal over the FINAL markup. The styled DOM (bolded action
  // words and any inline emphasis) is laid out up front and only the glyphs
  // are revealed in order, so nothing is swapped in when the animation ends
  // and the sheet never reflows. The old version typed a plain string and
  // then replaced it with the styled markup, which made Oak's line suddenly
  // render as a quoted block and visibly shift the card.
  function typeText(el, html, speed, onDone) {
    el.innerHTML = html;
    // Collect the text nodes in document order, then reveal them character by
    // character across node boundaries (a bold word stays bold while typed).
    var nodes = [];
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    var n;
    while ((n = walker.nextNode())) nodes.push(n);
    var full = nodes.map(function (x) { return x.nodeValue; });
    var total = 0;
    for (var i = 0; i < full.length; i++) total += full[i].length;
    function paint(limit) {
      var acc = 0;
      for (var k = 0; k < nodes.length; k++) {
        var len = full[k].length;
        nodes[k].nodeValue = full[k].slice(0, Math.max(0, Math.min(len, limit - acc)));
        acc += len;
      }
    }
    if (!total) { if (onDone) onDone(); return function () {}; }
    nodes.forEach(function (x) { x.nodeValue = ''; });
    var pos = 0;
    var timer = setInterval(function () {
      paint(pos);
      if (pos >= total) { clearInterval(timer); if (onDone) onDone(); return; }
      // One soft blip per character, quiet enough to sit under the words.
      playTextSound();
      pos++;
    }, speed || 34);
    return function skip() { clearInterval(timer); paint(total); if (onDone) onDone(); };
  }

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

  function attach(p, save) {
    profile = p; saveFn = save;
    // A different profile means a different tutorial context: beats queued
    // for the old profile must not pop up over the new one's game. `pending`
    // is declared in the presentation section below; assignment here is safe
    // because attach() only runs after the whole module has been evaluated.
    pending.length = 0;
    releaseActionLock();
    return state();
  }
  function persist() { if (saveFn) { try { saveFn(); } catch (e) {} } }

  function tipsOn() { return !state().off; }
  function badgesOn() { var c = state(); return !c.off && c.badges !== false; }
  function seen(id) { return !!state().seen[id]; }
  function markSeen(id) { state().seen[id] = 1; persist(); }
  // Forget a lesson was read. The guided run uses this to keep a FORCED step
  // (evolve the starter, train the team) armed until the player has actually
  // done it, not merely dismissed the card.
  function unsee(id) { delete state().seen[id]; persist(); }
  function setOff(v) {
    state().off = !!v;
    if (v) releaseActionLock();
    persist();
  }
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
    pending.length = 0;
    releaseActionLock();
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

    // Removed glass cannon - adds no useful info for new players. Just use fast attacker.
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
  // Every lesson has TWO voices:
  //   `say`  — Professor Oak speaking to the player. Plain, warm, short
  //            sentences. No jargon that has not just been defined, no
  //            gendered language, nothing that assumes prior Pokemon games.
  //   `body` — the ONE thing to do right now. One idea, one control, phrased
  //            as an instruction ("Tap the glowing..."), with the important
  //            word in bold.
  // This is what makes the tutorial read as a conversation with the professor
  // rather than a wall of documentation, and it is what keeps every step
  // isolated: dialogue first, one action second.
  var LESSONS = [
    { id: 'welcome', where: 'basics', title: 'Welcome!',
      say: 'Hello there! Welcome to the world of Pokemon. My name is Professor Oak, and I will be your guide from here on.',
      body: 'Before we begin, tell me a little about yourself: pick a <b>sprite</b>, enter a <b>name</b>, and choose how much help you would like. I promise to be right beside you the whole way.' },
    { id: 'starter', where: 'basics', title: 'Choose your starter!',
      say: 'A trainer\u2019s first decision! I have three wonderful young Pokemon here, and there is no wrong answer \u2014 any one of them can carry you far. But choose with your heart: in Dailylocke, a fainted Pokemon is gone for good, so guard your partner well.',
      body: 'Each card says what that Pokemon is good at. Tap <b>Choose</b> on the one you like, then give it a nickname.' },
    { id: 'route', where: 'basics', title: 'The path',
      say: 'Your journey is divided into sections, and every section has four stops: three wild Pokemon, and then a trainer. You can always see where you are, right here.',
      body: 'This section starts with a <b>Capture Encounter</b> \u2014 your one chance this section to catch a new friend. Tap the glowing <b>Capture Encounter</b> button to begin.' },
    { id: 'battleBag', where: 'battle', title: 'Bag: heal mid-battle',
      say: 'Even in the heat of battle, your Bag is right there. Healing costs your turn, so timing is everything.',
      body: 'Tap <b>Bag</b> and use a <b>Super Potion</b> to heal your active Pokemon. It costs your turn, so heal before a big hit lands \u2014 not after!' },
    { id: 'tutorialDamage', where: 'battle', title: 'Weaken Pikachu first',
      say: 'A wild Pikachu appeared! To catch a Pokemon, first weaken it \u2014 gently. The lower its HP, the easier it is to catch.',
      body: 'Tap the glowing <b>damaging move</b> to weaken Pikachu. Status moves are locked for now, and Pikachu cannot be knocked out during this lesson; after the hit, the Poke Ball appears.' },
    { id: 'tutorialCatch', where: 'battle', title: 'Throw a Poke Ball!',
      say: 'Wonderful! Pikachu is weakened. Now comes the exciting part.',
      body: 'Tap the glowing <b>Poke Ball</b> on the rail to throw it and catch Pikachu.' },
    { id: 'catch', where: 'catching', title: 'Catch your first!',
      say: 'A wild Pokemon! Let me show you how every catch works.',
      body: 'Weaken the wild Pokemon with attacks first \u2014 the lower its HP, the better your odds. Then tap a <b>Poke Ball</b> on the rail to catch it.' },
    { id: 'caught', where: 'catching', title: 'New friend!',
      say: 'You did it! Pikachu is yours now. A caught Pokemon keeps the HP and status it had when caught \u2014 it does not arrive fully rested.',
      body: 'Give it a nickname. In a moment I will show you how to heal it before the next battle.' },
    { id: 'healOpen', where: '_tutorial', title: 'Heal your new friend',
      say: 'Your new partner worked hard out there. A good trainer looks after the team between battles.',
      body: 'Tap <b>{NAME}\u2019s card</b> on your team, then use the glowing <b>Potion</b> to heal it.' },
    { id: 'healUse', where: '_tutorial', title: 'Use a Potion',
      say: 'There it is. One Potion, and your partner is ready for the next battle.',
      body: 'Tap the glowing <b>Use Potion</b> button to heal <b>{NAME}</b>.' },
    { id: 'onward', where: '_tutorial', title: 'Onward!',
      say: 'Well done! Your new friend is healed and ready. Now, back to the trail.',
      body: 'Tap the glowing <b>Wild Battle 1</b> button to begin the next battle.' },
    { id: 'effect', where: 'battle', title: 'Super effective!',
      say: 'Here is a secret every champion knows: every type is strong against some types and weak against others. Hitting a weakness doubles your damage.',
      body: 'The move with the <b>\u00d72</b> tag hits this wild Pokemon\u2019s weakness. Tap that move; the other actions stay locked until you use it.' },
    { id: 'switch', where: 'battle', title: 'How to Switch',
      say: 'A smart trainer knows when to let a teammate take over. Sending in the right Pokemon can turn a battle around.',
      body: 'Tap <b>Party</b>. It opens the switch list so you can choose a different Pokemon to send out.' },
    { id: 'switchPick', where: '_tutorial', title: 'Choose your switch',
      say: 'Perfect. Now, choose who takes the spotlight.',
      body: 'Tap <b>{NAME}</b> to send it into battle. The other party cards stay locked for this lesson.' },
    { id: 'trainer', where: 'basics', title: 'Heal first!',
      say: 'Your first Trainer battle is next \u2014 a real rival with a real strategy. Trainers never let you run away, so go in prepared.',
      body: 'Tap <b>Trainer Battle</b> to start it; this guided fight only allows the steps on screen.' },
    { id: 'skipping', where: 'basics', title: 'The middle stops are a budget',
      say: 'Every wild battle pays prize money, but it wears your Pokemon down. Sometimes the smart move is not to fight.',
      body: 'If a fight goes badly, <b>Run</b> always works \u2014 it only costs you the reward.' },
    { id: 'save', where: 'saving', title: 'Save your game',
      say: 'Your adventure lives only in <b>this browser</b> \u2014 nothing is stored online. I would hate for you to lose your team.',
      body: 'Clear your browser data and the save is gone, so tap <b>Save progress</b> to download a backup file you can restore to continue your run.' },
    { id: 'mart', where: 'items', title: 'The Mart is open',
      say: 'A well-stocked bag is a trainer\u2019s best friend. The Mart is open whenever you are on the route.',
      body: 'Spend prize money here. Balls and Potions are always in stock; the held items and stones rotate every section.' },
    { id: 'train', where: 'training', title: 'Train your Pokemon',
      say: 'Even the strongest Pokemon get better with practice. The Train service is where that happens.',
      body: 'The Train service rewrites moves, ability, nature and Stat Points for one fee. A few Stat Points in Speed often decides who moves first.' },
    { id: 'held', where: 'training', title: 'Free power, every turn',
      say: 'A held item is like a lucky charm that actually works \u2014 every turn, without spending a move.',
      body: 'If a \u2726Tip badge says one fits your Pokemon, it genuinely does.' },
    { id: 'evolve', where: 'training', title: 'Evolve your starter',
      say: 'Your starter has grown strong, and it is ready to become something greater. In Dailylocke, evolution is done with an item.',
      body: 'Tap the <b>Rare Candy</b> shop tile to buy the item your starter needs.' },
    { id: 'evoOpen', where: '_tutorial', title: 'Open your starter',
      say: 'The Rare Candy is in your bag. Now comes the fun part.',
      body: 'Tap <b>{NAME}</b> on your team to open the Pokemon that can evolve.' },
    { id: 'evoBranch', where: 'training', title: 'It can become more than one thing',
      say: 'Some Pokemon can become more than one thing. That makes the choice exciting \u2014 and permanent.',
      body: 'This evolution branches, and the choice is permanent. Check what each form does before you commit.' },
    { id: 'moveChoice', where: 'training', title: 'Four moves, no take-backs',
      say: 'A Pokemon can know four moves at a time. When you teach a new one, the old one is forgotten for good.',
      body: 'Prefer moves that match a type this Pokemon has \u2014 the STAB bonus makes those hit 50% harder \u2014 and its stronger attack stat.' },
    // ---- scripted tutorial steps (hidden from the Guide) -------------------
    // These are the guided run's choreography, not reference material, so
    // they carry a where-group the Guide never renders.
    { id: 'makeLead', where: '_tutorial', title: 'Your new lead',
      say: 'The first Pokemon in your team is the <b>lead</b> \u2014 the one that opens every battle.',
      body: 'Your new Pokemon is at the back of the party. Tap <b>its card</b> on the team strip, then tap <b>Make lead</b> \u2014 the leader opens every battle.' },
    { id: 'makeLeadTap', where: '_tutorial', title: 'Make lead',
      say: 'Almost there!',
      body: 'Tap <b>Make lead</b> to put this Pokemon at the front of your team.' },
    { id: 'evoUse', where: '_tutorial', title: 'Use the Rare Candy',
      say: 'This is the moment. Are you ready to meet your partner\u2019s new form?',
      body: 'Tap <b>Ready to evolve</b>. It spends the Rare Candy and evolves this Pokemon.' },
    { id: 'evoDone', where: '_tutorial', title: 'See the result',
      say: 'Look at that! Stronger, faster \u2014 and still the same friend you chose at the start.',
      body: 'Your starter evolved. Tap <b>Continue</b> to return to the route.' },
    { id: 'trainOpen', where: '_tutorial', title: 'Time to train',
      say: 'One last skill for today: training. A quick session can make a big difference.',
      body: 'Tap <b>{NAME}</b> on your team to open the Pokemon that needs training.' },
    { id: 'trainButton', where: '_tutorial', title: 'Open Training',
      say: 'This is the Train service. We will walk through it together, one step at a time.',
      body: 'Tap <b>Train Pokemon</b>. It opens the training service for moves, ability, nature and Stat Points.' },
    { id: 'trainMovesSlot', where: '_tutorial', title: 'Pick a move slot',
      say: 'Your Pokemon knows four moves. We will swap one of them for something better.',
      body: 'Tap the highlighted current move slot. That chooses which move this lesson will replace.' },
    { id: 'trainPickMove', where: '_tutorial', title: 'Learn this move',
      say: 'Take your time. Every move card says what the move does \u2014 including the traps to avoid.',
      body: 'Tap the highlighted move card to teach that move to your Pokemon.' },
    { id: 'trainAbilityTab', where: '_tutorial', title: 'Now your ability',
      say: 'Abilities are passive powers \u2014 they work every turn without you doing a thing.',
      body: 'Tap <b>Ability</b> to see and change your Pokemon\u2019s ability.' },
    { id: 'trainAbilityPick', where: '_tutorial', title: 'Pick this ability',
      say: 'This ability is a great fit for your partner.',
      body: 'Tap this ability \u2014 it changes how your Pokemon plays.' },
    { id: 'trainAbilityOnly', where: '_tutorial', title: 'Its only ability',
      say: 'Not every Pokemon gets a choice. {NAME} is born with a single ability, and it is a good one.',
      body: '{NAME} can only have <b>{ABILITY}</b>. Tap the ability card to confirm it and continue to Nature.' },
    { id: 'trainNatureTab', where: '_tutorial', title: 'Now your nature',
      say: 'A nature is a personality. It boosts one stat and lowers another \u2014 free power, if you pick the right one.',
      body: 'Tap <b>Nature</b> \u2014 a nature boosts one stat and lowers another.' },
    { id: 'trainNaturePick', where: '_tutorial', title: 'Pick this nature',
      say: 'This nature boosts the stat your Pokemon already loves. That is the one to take.',
      body: 'Tap this nature \u2014 it boosts the stat this Pokemon already loves.' },
    { id: 'trainStatsTab', where: '_tutorial', title: 'Now Stat Points',
      say: 'Last but not least: Stat Points. You have a small budget of points to shape your Pokemon exactly how you want.',
      body: 'Tap <b>Stats</b> to spend the training points that shape its stats.' },
    { id: 'trainStatsTake', where: '_tutorial', title: 'Move a point out',
      say: 'We will move one point away from a stat your partner does not need.',
      body: 'Drag the <b>{TAKE}</b> Stat Point slider down by one point to free a point.' },
    { id: 'trainStatsGive', where: '_tutorial', title: 'Move a point in',
      say: '\u2026and give it to a stat that makes it stronger.',
      body: 'Drag the <b>{GIVE}</b> Stat Point slider up by one point to spend the freed point.' },
    { id: 'trainDone', where: '_tutorial', title: 'All trained!',
      say: 'Magnificent! Your partner is stronger than ever \u2014 and so are you as a trainer.',
      body: 'Tap <b>Done</b> to lock in your training. That is everything the service does.' },
    { id: 'graduate', where: '_tutorial', title: 'You are ready!',
      say: 'You have learned everything a trainer needs: catching, healing, type matchups, switching, the Mart, evolution and training. I am proud of you.',
      body: 'The tutorial is complete \u2014 the rest of the run is all yours. If you ever need a reminder, every lesson is waiting in the <b>Guide</b> (Menu \u2192 Guide).' }
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
  // Two surfaces sharing one visual register and one queue:
  //   * the modal lesson sheet (everything outside battle) -- the modal
  //     controller owns its lifecycle;
  //   * the anchored bubble (inside battle) -- non-modal, dismissed by a tap,
  //     anchored via `resolve` so it survives the HUD re-rendering the node
  //     it points at.
  //
  // When the caller names what the lesson is ABOUT (anchor / anchorSel /
  // resolve), the violet halo lands on that element. On the sheet it lasts
  // for the sheet's lifetime. On the bubble it OUTLIVES the bubble (the
  // `keepHalo` beats): the glow -- not the card -- is what carries "press
  // THIS" after the player looks away. Screen transitions always sweep it.

  var busy = false;          // a card is on screen right now
  var cooldownUntil = 0;     // no second card for a moment after one closes
  var COOLDOWN_MS = 550;

  // A guided action is not a suggestion. While one is armed, the player must
  // press the one control the lesson names; clicking anywhere else is ignored.
  // This is deliberately owned by the coach rather than scattered across
  // every screen's click handler. It covers dynamically-rendered controls,
  // keyboard-generated clicks and buttons that are rebuilt by BattleUI.
  var actionLock = null;      // { opts: { resolve | anchor | anchorSel } }

  function actionTarget(opts) {
    return resolveTarget(opts);
  }

  function isCoachSurface(el) {
    return !!(el && (el.closest && (el.closest('#screenCoach') || el.closest('.coach-bubble'))));
  }

  function sameActionTarget(el, target) {
    return !!(el && target && (el === target || target.contains(el)));
  }

  function armActionLock(opts) {
    if (!opts || !opts.actionRequired) return;
    // Never let a queued later beat replace the action still owed by the
    // current beat. The first control remains authoritative until it is used.
    if (actionLock && actionLock.opts !== opts) return;
    var target = actionTarget(opts);
    if (!target) return;
    actionLock = { opts: opts };
    document.body.classList.add('coach-action-locked');
  }

  function releaseActionLock() {
    actionLock = null;
    document.body.classList.remove('coach-action-locked');
  }

  function guardActionEvent(e) {
    if (!actionLock) return;
    // The lesson's own dismiss control is always available. Dismissing the
    // card does NOT release the lock; the highlighted game control remains the
    // only valid next step.
    if (isCoachSurface(e.target)) return;
    var target = actionTarget(actionLock.opts);
    // The taught control is gone (a re-render replaced it, or the screen it
    // lived on was left). The step is moot: release the lock so a stale arm
    // can never swallow unrelated controls with no visible cause.
    if (!target || !target.isConnected) {
      releaseActionLock();
      return;
    }
    if (sameActionTarget(e.target, target)) {
      // Slider lessons validate the value in their input handler. Keep the
      // lock through pointerdown/input/change so dragging the wrong way does
      // not silently unlock every other control.
      if (actionLock.opts.holdUntilValid &&
          (e.type === 'pointerdown' || e.type === 'input' || e.type === 'change')) return;
      // Release before the app's bubbling handler runs. The target's handler
      // can then clear the coach mark and perform the action normally.
      releaseActionLock();
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  // Capture both pointer and click paths. Pointerdown matters for sliders in
  // the training service; click matters for programmatic `.click()` calls and
  // browsers that synthesize a click without a pointer event.
  document.addEventListener('pointerdown', guardActionEvent, true);
  document.addEventListener('click', guardActionEvent, true);
  document.addEventListener('input', guardActionEvent, true);
  document.addEventListener('change', guardActionEvent, true);

  // `resolveTarget` is declared below as a function declaration, so the lock
  // can safely resolve a fresh node even though these listeners are installed
  // before the presentation helpers are defined.
  function actionLockTarget() {
    return actionLock ? actionTarget(actionLock.opts) : null;
  }

  function actionLockActive() { return !!actionLock; }

  function clearActionLock() { releaseActionLock(); }

  // ---- the vital-lesson queue ---------------------------------------------
  // Tutorial beats (the guided run's scripted lessons) must not silently
  // vanish because another card was up or just closed when they fired. A
  // request made with `vital: true` that arrives while the surface is busy
  // (or cooling down) is queued -- deduped by lesson id -- and pumped when
  // the surface frees. `stillValid` lets the caller say when a beat has gone
  // stale (its battle is over, the screen was left): a stale beat drops, and
  // the natural call site re-requests it at the next appropriate moment.
  var pending = [];          // [{id, opts}]
  var pumpTimer = null;

  function queueVital(id, opts) {
    for (var i = 0; i < pending.length; i++) if (pending[i].id === id) return;
    pending.push({ id: id, opts: opts });
    // Arm the pump HERE, not just in setBusy(false): a beat queued during a
    // cooldown with no sheet opening after it would otherwise sit in the
    // queue forever -- nothing would ever fire it again. That was a real
    // dead-tutorial bug (shop chain stalls, route lessons lost).
    schedulePump();
  }

  function schedulePump() {
    if (pumpTimer || !pending.length) return;
    pumpTimer = setTimeout(function () {
      pumpTimer = null;
      pump();
    }, COOLDOWN_MS + 80);
  }

  function pump() {
    if (!pending.length) return;
    // Too early for this beat: RE-ARM instead of dying. An armed pump timer
    // can land inside a busy/cooldown window that only came into existence
    // after the timer was set (a surface opened, or the previous surface
    // closed and started a fresh cooldown, while the timer was in flight) —
    // and a consumed timer used to leave queued tutorial beats stranded with
    // nothing left to ever fire them again.
    if (busy || Date.now() < cooldownUntil) { schedulePump(); return; }
    while (pending.length && !busy) {
      var next = pending.shift();
      // bypassSeen beats (scripted tutorial beats scoped to the active run by
      // the caller) deliberately ignore the profile's seen state: their
      // de-dup is the caller's responsibility, not the profile's.
      if (!tipsOn() || (!next.opts || !next.opts.bypassSeen) && seen(next.id)) continue;
      if (next.opts && typeof next.opts.stillValid === 'function') {
        var ok = false;
        try { ok = !!next.opts.stillValid(); } catch (e) {}
        if (!ok) continue;   // gone stale: the call site will ask again later
      }
      lesson(next.id, next.opts);
    }
  }

  // `busy` gates every lesson, so anything that can set it and then fail to
  // clear it silences the coach for the rest of the session -- the player
  // simply stops being taught, with no visible cause. Route both edges
  // through one place so "released" is impossible to forget.
  function setBusy(on) {
    busy = !!on;
    if (!busy) {
      cooldownUntil = Date.now() + COOLDOWN_MS;
      schedulePump();
    }
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Scripted tutorial lessons can carry placeholders ({NAME}, {ABILITY} ...)
  // that the call site fills in with the live names it knows about.
  function fillTemplate(body, vals) {
    if (!vals) return body;
    return String(body).replace(/\{([A-Z_]+)\}/g, function (m, k) {
      return (vals[k] != null) ? esc(vals[k]) : m;
    });
  }

  // ---- the halo ------------------------------------------------------------
  // The element a lesson is talking about glows violet. `resolve` anchors are
  // preferred over live nodes and selectors: the battle HUD re-renders after
  // every action, replacing the exact node a lesson was pointed at, and only
  // a resolver can find the fresh twin. It re-resolves once after opening, so
  // a re-render in the same beat doesn't drop the link.
  var haloTimer = null;
  function sweepHalo() {
    var all = document.querySelectorAll('.coach-spot');
    for (var i = 0; i < all.length; i++) all[i].classList.remove('coach-spot');
    if (haloTimer) { clearTimeout(haloTimer); haloTimer = null; }
  }
  function resolveTarget(opts) {
    if (!opts) return null;
    if (typeof opts.resolve === 'function') {
      var r = null;
      try { r = opts.resolve(); } catch (e) {}
      if (r) return r;
    }
    return opts.anchor || (opts.anchorSel ? document.querySelector(opts.anchorSel) : null);
  }

  // Scroll an anchored element into the band of the viewport that stays
  // visible above a bottom-sheet dialog. Runs while the page can still
  // scroll (a modal locks it), so it is reliable on every browser.
  function scrollAnchorIntoView(el) {
    try {
      var r = el.getBoundingClientRect();
      var vh = window.innerHeight || document.documentElement.clientHeight || 800;
      // Already comfortably inside the visible band? Leave it alone.
      if (r.top >= vh * 0.12 && r.bottom <= vh * 0.58) return;
      var y = window.scrollY + r.top - vh * 0.18;
      y = Math.max(0, Math.min(y, (document.documentElement.scrollHeight || 0) - vh + 80));
      window.scrollTo(0, y);
    } catch (e) {}
  }
  function applyHalo(opts) {
    sweepHalo();
    if (!opts) return;
    var t = resolveTarget(opts);
    if (t && t.isConnected && !t.closest('[hidden]')) t.classList.add('coach-spot');
    if (opts.anchorSel || typeof opts.resolve === 'function') {
      haloTimer = setTimeout(function () {
        haloTimer = null;
        var n = resolveTarget(opts);
        var lit = document.querySelector('.coach-spot');
        if (lit && !lit.isConnected) lit.classList.remove('coach-spot');
        if ((!lit || !lit.isConnected) && n && n.isConnected && !n.closest('[hidden]')) {
          n.classList.add('coach-spot');
        }
      }, 320);
    }
  }

  // ---- the modal lesson sheet --------------------------------------------
  function showSheet(lesson, opts) {
    opts = opts || {};
    var el = document.getElementById('screenCoach');
    if (!el || !window.Modal) { if (opts.onDone) opts.onDone(); return; }
    // One coach surface at a time: a sheet wins over any open battle bubble.
    dismissBubble({ quiet: true });

    var card = el.querySelector('.overlay-card');

    var head = '<div class="coach-head immersive">' +
        '<span class="coach-portrait">' + advisorImg(88) + '</span>' +
        '<div class="coach-who"><b>' + esc(ADVISOR.name) + '</b>' +
          '<em>' + esc(opts.eyebrow || 'Professor Oak') + '</em></div>' +
      '</div>';

    var bodyId = 'coachBodyReveal';
    card.innerHTML =
      head +
      '<h3 class="coach-title" id="coachTitle">' + esc(lesson.title) + '</h3>' +
      '<div class="coach-body" id="' + bodyId + '"></div>' +
      (opts.extra || '') +
      '<div class="coach-actions">' +
        '<button type="button" class="btn-primary wide" data-coach-ok>' + esc(opts.okLabel || 'Got it') + '</button>' +
        ((opts.noSkip || inPrologue()) ? '' : '<button type="button" class="coach-skip" data-coach-skip>Skip tips</button>') +
      '</div>';

    if (window.Modal.isOpen(el)) window.Modal.close(el);

    // Dialogue first, instruction second: Oak's spoken line (`say`) leads
    // into the single actionable step (`body`, with the important word in
    // bold). Both live in one reveal block and read as one flowing sentence —
    // no quote styling, so finishing the typewriter changes nothing.
    var filled = fillTemplate(
      (lesson.say ? esc(lesson.say) + ' ' : '') + lesson.body,
      opts.template);

    // A sheet anchors to an element on the page behind it: scroll that
    // element into the visible band above the sheet BEFORE the modal opens
    // (modal-open locks background scrolling), and let the halo point at it
    // dimly through the scrim instead of popping above the dialog.
    var anchor = resolveTarget(opts);
    if (anchor && anchor.isConnected) scrollAnchorIntoView(anchor);
    setBusy(true);
    applyHalo(opts);
    armActionLock(opts);
    document.body.classList.add('coach-sheet-open');
    window.Modal.open(el, {
      onClose: function () {
        document.body.classList.remove('coach-sheet-open');
        // Action-required lessons stay armed after the dialogue is dismissed.
        // The target is the instruction; the card's Got it button is not the
        // action being taught.
        if (!opts.actionRequired && !opts.keepHalo) sweepHalo();
        setBusy(false);
        if (opts.onDone) { try { opts.onDone(); } catch (e) {} }
      }
    });
    if (opts.onShow) { try { opts.onShow(); } catch (e) {} }

    // The typewriter reveal: text appears character by character with a soft
    // blip, and a tap finishes the line immediately. The final markup is
    // already in place, so the bolded action simply appears as it is typed.
    var bodyDiv = card.querySelector('#' + bodyId);
    bodyDiv.classList.add('text-reveal');
    var skip = typeText(bodyDiv, filled, 34);
    bodyDiv.onclick = function () { skip(); bodyDiv.onclick = null; };

    card.querySelector('[data-coach-ok]').addEventListener('click', function () {
      window.Modal.close(el);
    });
    var sk = card.querySelector('[data-coach-skip]');
    if (sk) sk.addEventListener('click', function () {
      setOff(true);
      window.Modal.close(el);
      if (window.Game && window.Game.toast) window.Game.toast('Tips off. Turn them back on in Profile.');
      if (window.Game && window.Game.onCoachSkip) {
        try { window.Game.onCoachSkip(); } catch (e) {}
      }
    });
  }

  // ---- the anchored battle bubble -----------------------------------------
  // The in-battle surface. A modal sheet would freeze the fight behind it and
  // turn every battle beat into an interruption; the bubble instead pops
  // BESIDE the control it explains while the battle stays playable. One tap
  // on it (or on the glowing control itself, which is the natural response)
  // dismisses it -- and for `keepHalo` beats the control keeps glowing until
  // the action actually happens, so the player never has to remember what
  // the card said, only to press the thing that is lit up.
  var bubbleEl = null;       // the popover node
  var bubbleOpts = null;     // opts of the open bubble (null = none open)

  function ensureBubble() {
    if (bubbleEl) return bubbleEl;
    bubbleEl = document.createElement('div');
    bubbleEl.className = 'coach-bubble';
    bubbleEl.setAttribute('role', 'note');
    // The coach-mark layer floats ABOVE dialogs on purpose (e.g. a guide
    // bubble over the party sheet), so it opts out of the inertness the
    // modal controller applies to everything behind a dialog.
    bubbleEl.setAttribute('data-modal-overlay', '');
    bubbleEl.hidden = true;
    // Attached once, delegated: clicking anywhere on the bubble dismisses it,
    // including the "Got it" button. Never re-bound on re-renders.
    bubbleEl.addEventListener('click', function () { dismissBubble(); });
    document.body.appendChild(bubbleEl);
    return bubbleEl;
  }

  function bubbleKey(e) {
    if (e.key === 'Escape' && bubbleOpts) dismissBubble();
  }

  function placeBubble(target, side) {
    var b = ensureBubble();
    var r = target.getBoundingClientRect();
    b.hidden = false;                         // measure, then position
    b.style.left = '0px'; b.style.top = '0px';
    var bw = b.offsetWidth, bh = b.offsetHeight;
    var pad = 8, gap = 12;
    b.classList.remove('below', 'side-right', 'side-left');
    var left, top;
    if (side === 'right' && r.right + gap + bw + pad <= window.innerWidth) {
      b.classList.add('side-right');
      left = r.right + gap;
      top = r.top + r.height / 2 - bh / 2;
    } else if (side === 'left' && r.left - gap - bw - pad >= 0) {
      b.classList.add('side-left');
      left = r.left - gap - bw;
      top = r.top + r.height / 2 - bh / 2;
    } else {
      // Default: above the target, flipping below when there is no room.
      left = r.left + r.width / 2 - bw / 2;
      top = r.top - bh - gap;
      if (top < pad) { top = r.bottom + gap; b.classList.add('below'); }
    }
    left = Math.max(pad, Math.min(left, window.innerWidth - bw - pad));
    top = Math.max(pad, Math.min(top, window.innerHeight - bh - pad));
    b.style.left = Math.round(left) + 'px';
    b.style.top = Math.round(top) + 'px';
    // Keep the arrow aimed at the target's centre even when clamping dragged
    // the bubble off axis.
    var arrow = b.querySelector('.cb-arrow');
    if (arrow) {
      if (b.classList.contains('side-right') || b.classList.contains('side-left')) {
        arrow.style.left = '';
        arrow.style.top = Math.max(14, Math.min(bh - 14, Math.round(r.top + r.height / 2 - top))) + 'px';
      } else {
        arrow.style.top = '';
        arrow.style.left = Math.max(14, Math.min(bw - 14, Math.round(r.left + r.width / 2 - left))) + 'px';
      }
    }
  }

  function showBubble(lesson, opts) {
    opts = opts || {};
    var t = resolveTarget(opts);
    if (!t || !t.isConnected || t.closest('[hidden]')) {
      // The thing the lesson points at is gone; drop quietly exactly like a
      // stale sheet beat -- the natural call site re-requests at the next
      // appropriate moment.
      if (opts.onDone) { try { opts.onDone(); } catch (e) {} }
      return;
    }
    dismissBubble({ quiet: true });   // one coach surface at a time
    var b = ensureBubble();
    b.innerHTML =
      '<span class="coach-portrait">' + advisorImg(38) + '</span>' +
      '<div class="cb-main">' +
        '<b class="cb-title">' + esc(lesson.title) + '</b>' +
        '<p class="cb-body">' +
          (lesson.say ? esc(lesson.say) + ' ' : '') +
          fillTemplate(lesson.body, opts.template) +
        '</p>' +
        '<button type="button" class="cb-ok" data-coach-ok>' + esc(opts.okLabel || 'Got it') + '</button>' +
      '</div>' +
      '<span class="cb-arrow" aria-hidden="true"></span>';
    bubbleOpts = opts;
    setBusy(true);
    applyHalo(opts);
    armActionLock(opts);
    placeBubble(t, opts.side);
    document.addEventListener('keydown', bubbleKey);
    requestAnimationFrame(function () { b.classList.add('on'); });
    // Re-glue once after opening: a HUD re-render in the same beat (entrance
    // animations) can swap the anchored node for an identical fresh one.
    setTimeout(function () {
      if (!bubbleOpts || !bubbleEl || bubbleEl.hidden) return;
      var n = resolveTarget(bubbleOpts);
      if (n && n.isConnected && !n.closest('[hidden]')) placeBubble(n, bubbleOpts.side);
    }, 340);
    if (opts.onShow) { try { opts.onShow(); } catch (e) {} }
  }

  // `quiet`: a replacement surface is already opening -- leave `busy` alone
  // and do not fire the caller's completion hook.
  // `sweep`: take the halo down too (screen transitions); otherwise the
  // element keeps glowing for keepHalo beats.
  function dismissBubble(opts) {
    opts = opts || {};
    if (!bubbleOpts) return;
    var o = bubbleOpts;
    bubbleOpts = null;
    if (bubbleEl) {
      bubbleEl.classList.remove('on');
      document.removeEventListener('keydown', bubbleKey);
      setTimeout(function () { if (!bubbleOpts && bubbleEl) bubbleEl.hidden = true; }, 170);
    }
    if (!o.keepHalo || opts.sweep) sweepHalo();
    if (opts.quiet) return;
    setBusy(false);
    if (o.onDone) { try { o.onDone(); } catch (e) {} }
  }

  // The battle HUD re-renders after every action, replacing the node a bubble
  // points at. app.js calls this on each re-render so the bubble (and, via
  // the resolve target, the halo) stays glued to the living control.
  function reanchorBubble() {
    if (!bubbleOpts || !bubbleEl || bubbleEl.hidden) return;
    var t = resolveTarget(bubbleOpts);
    if (t && t.isConnected && !t.closest('[hidden]')) placeBubble(t, bubbleOpts.side);
    else dismissBubble();   // the thing it explained is gone: drop quietly
  }

  // A dialog (any dialog) wins the surface: the bubble yields rather than
  // floating over a scrim. The armed glow stays behind -- the beat resumes
  // meaning as soon as the dialog closes.
  document.addEventListener('modal:open', function () { dismissBubble(); });

  // Release the surface. Called on every screen transition by app.js: a halo
  // must never survive the screen it described, and `busy` must self-heal if
  // a sheet vanished without routing through Modal.close (a screen change
  // can hide an overlay directly, and then onClose never runs).
  function clearMark() {
    dismissBubble({ sweep: true });
    releaseActionLock();
    sweepHalo();
    // A screen transition can hide the sheet without routing through
    // Modal.close, so the halo z-index class must be released here too.
    document.body.classList.remove('coach-sheet-open');
    if (busy && !(window.Modal && window.Modal.isOpen('screenCoach'))) setBusy(false);
  }

  // ---- the public entry point ---------------------------------------------
  // Coach.lesson('mart', { anchor: el, vital: true, stillValid: fn })
  // Coach.lesson('catch', { surface:'bubble', resolve: fn, keepHalo: true })
  //
  // `surface: 'bubble'` picks the non-modal anchored bubble (battle beats);
  // everything else renders as the modal sheet. For bubbles, `resolve` finds
  // the subject fresh each time the HUD re-renders, and `keepHalo` leaves the
  // glow standing after the bubble itself is dismissed.
  //
  // Silently does nothing when: tips are off, this lesson was already seen,
  // the beat's own context is gone (`stillValid` says so), or another card is
  // on screen / just closed. That last rule is what stops chains -- EXCEPT
  // for `vital` tutorial beats, which queue instead of dropping so the
  // scripted onboarding can never lose a step to a race.
  //
  // `bypassSeen` is for scripted tutorial beats that must fire for THIS guided
  // run even when the profile already marks them seen (a returning player who
  // finished a prior tutorial). It skips the seen() check and does NOT mark
  // the lesson seen -- the caller owns the de-dup (typically a run-scoped
  // flag set in onShow, so the lesson is never marked "done" until it has
  // actually been displayed). It keeps the busy/cooldown + vital-queue
  // behaviour, so a bypassSeen beat still never stacks and still survives a
  // cooldown / first-render race.
  function lesson(id, opts) {
    opts = opts || {};
    var l = lessonById(id);
    if (!l) return false;
    // Scripted tutorial beats (bypassSeen) carry a progress marker — "Step 4
    // of 14" — derived from the live run, so the onboarding always reads as
    // one linear path with a visible position on it.
    if (!opts.force && opts.bypassSeen && !opts.eyebrow &&
        window.Game && typeof window.Game.tutorialStepLabel === 'function') {
      var lab;
      try { lab = window.Game.tutorialStepLabel(); } catch (e) { lab = null; }
      if (lab) opts.eyebrow = lab;
    }
    if (!opts.force) {
      if (!tipsOn()) return false;
      if (!opts.bypassSeen && seen(id)) return false;
      // The caller knows when a beat belongs: a capture lesson is only
      // meaningful during the capture battle, a shop lesson only while the
      // Mart is on screen. If that moment has ALREADY passed, drop quietly --
      // the natural call site re-requests at the next appropriate moment.
      if (typeof opts.stillValid === 'function') {
        var okNow;
        try { okNow = !!opts.stillValid(); } catch (e) { okNow = false; }
        if (!okNow) return false;
      }
      // Arm the target before the visual surface can open. A vital lesson may
      // be waiting behind the normal cooldown; without this early lock there
      // is a small window in which a player could skip ahead by tapping another
      // control.
      if (opts.actionRequired) armActionLock(opts);
      if (busy || Date.now() < cooldownUntil) {
        if (opts.vital) queueVital(id, opts);
        return false;
      }
    }
    // A bypassSeen beat is NOT marked seen on the profile: its dedup is the
    // caller's run-scoped responsibility, and marking it seen here would
    // suppress it again on the next guided run.
    if (!opts.force && !opts.bypassSeen) markSeen(id);
    if (opts.surface === 'bubble') showBubble(l, opts);
    else showSheet(l, opts);
    return true;
  }

  // Replay a lesson from the Guide, ignoring every gate.
  function replay(id) {
    var l = lessonById(id);
    if (!l) return;
    sweepHalo();
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
      '<i aria-hidden="true">✦</i>Tip</span>';
  }

  window.Coach = {
    ADVISOR: ADVISOR, advisorImg: advisorImg,
    attach: attach,
    // state
    tipsOn: tipsOn, badgesOn: badgesOn, seen: seen, markSeen: markSeen, unsee: unsee,
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
    halo: applyHalo, reanchorBubble: reanchorBubble,
    actionLockTarget: actionLockTarget, actionLocked: actionLockActive,
    clearActionLock: clearActionLock,
    tipBadge: tipBadge,
    get busy() { return busy; },
    get pendingCount() { return pending.length; }
  };
})();
