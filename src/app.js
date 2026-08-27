// ============================================================================
// app.js — Nuzlocke simulator: screens, section flow, mart, battle glue.
// ============================================================================
(function () {
  var PS = window.PS, Dex = PS.Dex;
  var C = window.Core, N = window.Nuz, RB = window.RogueBattle;

  var $ = function (id) { return document.getElementById(id); };

  function appFatal(title, err, message) {
    var detail = err && (err.stack || err.message) ? (err.stack || err.message) : String(err || '');
    var text = message || (err && err.message) || 'Please reload the game and try again.';
    if (window.__dailylockeShowFatal) {
      window.__dailylockeShowFatal(title || 'The game could not start', text, detail);
    } else {
      console.error('[app] fatal', err || text);
    }
  }

  var run = null, ui = null, battle = null, bctx = null;
  // Monotonically identifies the live battle stream. A renderer failure can
  // leave a few async stream callbacks queued; stale callbacks must not paint
  // into or mutate the next battle after the player backs out.
  var battleEpoch = 0;

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ------------------------------------------------------------ SPRITES ---
  // Sprite fallback chain. Preferred art is ALWAYS Pokemon Showdown's
  // animated GIF (`/sprites/ani…`). Static gen5 PNGs and PokeAPI art are
  // fallbacks only — never preloaded in parallel with the preferred GIF, or
  // the smaller PNG wins the race and players mostly see gen5 sprites.
  // `shiny` swaps in Showdown's parallel -shiny directories and PokeAPI's
  // /shiny/ path; every tier of the chain has a shiny twin, so a shiny never
  // silently falls back to normal colours.
  // True when a species is an alternate forme whose sprite differs from its
  // base species. PokeAPI sprites are keyed by national dex number, so they
  // always show the DEFAULT forme -- using them as a fallback for e.g.
  // Sneasel-Hisui would silently show regular Sneasel.
  function isForme(sp) {
    return sp.exists && sp.baseSpecies && sp.baseSpecies !== sp.name;
  }

  var SD_SPRITE = 'https://play.pokemonshowdown.com/sprites/';
  var PA_SPRITE = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/';

  function spriteUrls(speciesId, isBack, shiny) {
    var urls = [];
    var sp = Dex.species.get(speciesId);
    var sd = String((sp.exists && sp.spriteid) || speciesId || 'unknown').toLowerCase().replace(/[^a-z0-9-]+/g, '');
    var num = sp.exists ? sp.num : 0;
    var forme = isForme(sp);
    var bs = isBack ? '-back' : '';
    var sh = shiny ? '-shiny' : '';
    var pa = shiny ? 'shiny/' : '';
    function add(u) { if (u && urls.indexOf(u) < 0) urls.push(u); }
    // 1. Showdown animated (the goal). Front + back, shiny variants included.
    add(SD_SPRITE + 'ani' + bs + sh + '/' + sd + '.gif');
    // 2. Another Showdown animated set (gen5ani) — still animated, still
    //    keyed by spriteid. Used only when the modern ani GIF is missing.
    add(SD_SPRITE + 'gen5ani' + bs + sh + '/' + sd + '.gif');
    // 3. Static Showdown gen5 PNG — last Showdown tier before leaving the host.
    add(SD_SPRITE + 'gen5' + bs + sh + '/' + sd + '.png');
    // PokeAPI sprites use the national dex number which is identical across all
    // formes of a species.  For alternate formes (Hisui, Alola, Galar, Paldea,
    // regional variants, Rotom-Wash, Deoxys-Attack, etc.) these URLs always
    // return the DEFAULT forme's sprite, so we skip them entirely.
    if (!forme) {
      if (num) add(PA_SPRITE + 'versions/generation-v/black-white/animated/' + (isBack ? 'back/' : '') + pa + num + '.gif');
      if (num) add(PA_SPRITE + (isBack ? 'back/' : '') + pa + num + '.png');
      // Official artwork as last resort before the silhouette
      if (num) add(PA_SPRITE + 'other/official-artwork/' + pa + num + '.png');
    }
    // last resort: the non-shiny art, so something always renders
    if (shiny) spriteUrls(speciesId, isBack, false).forEach(add);
    return urls;
  }

  // Warm a sprite URL without putting it on screen. Shared with BattleUI's
  // Image cache when available so a party-strip load also primes the battle.
  function warmSpriteUrl(url) {
    if (!url) return;
    if (window.BattleUI && window.BattleUI.preload) {
      try { window.BattleUI.preload(url); return; } catch (e) {}
    }
    var img = new Image();
    try { if ('fetchPriority' in img) img.fetchPriority = 'low'; } catch (e) {}
    img.decoding = 'async';
    img.src = url;
  }

  // Prefetch the preferred Showdown animated GIF for a species (and optionally
  // its battle-back pose). Call this as soon as we know which mon will appear.
  function prefetchSpecies(speciesId, opts) {
    opts = opts || {};
    if (!speciesId) return;
    var shiny = !!opts.shiny;
    // Front ani GIF first — used by party strip, pickers, and enemy battle.
    var front = spriteUrls(speciesId, false, shiny);
    if (front[0]) warmSpriteUrl(front[0]);
    if (opts.back) {
      var back = spriteUrls(speciesId, true, shiny);
      if (back[0]) warmSpriteUrl(back[0]);
    }
  }

  function prefetchParty(party) {
    if (!party || !party.length) return;
    for (var i = 0; i < party.length; i++) {
      var m = party[i];
      if (!m || !m.id) continue;
      // Lead gets the back sprite warmed too — it is what the battle shows.
      prefetchSpecies(m.id, { shiny: !!m.shiny, back: i === 0 });
    }
  }
  // ---- SMALL ANIMATED SPRITES ---------------------------------------------
  // The game shows the animated BW gif EVERYWHERE -- party strip, battle,
  // pickers, memorial, results. The old 40x30 Showdown icon sheet was a second,
  // inconsistent art style for the same Pokemon, so it is gone. `iconEl` keeps
  // its name and signature (scale multiplier) and now renders a tiny animated
  // sprite fitted to an equivalent box.
  function iconEl(id, scale, cls, shiny) {
    scale = scale || 1;
    // The old sheet drew 40x30 cells; match that footprint so every existing
    // layout keeps its rhythm.
    var boxW = Math.round(44 * scale), boxH = Math.round(34 * scale);
    return animSprite(id, boxH, boxW, 'mini ' + (cls || ''), 1.45, shiny);
  }

  // Small ANIMATED sprite (the BW gif) for the party dock. Falls back through
  // the same chain as the big sprites so a missing gif still shows something.
  function animSprite(id, px, pw, cls, wt, shiny) {
    // Big enough that ordinary sprites render 1:1; only genuine giants shrink.
    px = px || 116;
    pw = pw || px;
    wt = wt || 1;
    var urls = spriteUrls(id, false, shiny);
    urls.push(iconUrl(id));
    urls.push(FALLBACK_SPRITE);
    var chain = urls.slice(1);
    // onerror only advances on a REAL failure. Never time out a still-loading
    // Showdown GIF into the gen5 PNG — that is exactly how gen5 became the
    // default art players saw. The chain still covers missing formes / 404s.
    var onerr = "this.onerror=null;var q=" + JSON.stringify(chain) + ";" +
                "if(!this._i)this._i=0;" +
                "if(this._i<q.length){this.src=q[this._i++];this.onerror=arguments.callee;}";
    // The onload snap happens after the image has decoded. Give the browser
    // the same bounds up front so a cached 200px fallback can never paint one
    // oversized frame before __snapSprite() fits it into the slot.
    var bounds = 'max-height:' + px + 'px;max-width:' + Math.round(pw * wt) + 'px';
    // decoding=async keeps layout free while the GIF decodes; fetchpriority
    // high marks party/route sprites as more important than background chrome.
    return '<img class="anim-mon ' + (cls || '') + (shiny ? ' is-shiny' : '') + '" src="' + urls[0] + '" alt="" ' +
           'decoding="async" fetchpriority="high" ' +
           'style="' + bounds + '" data-box="' + px + '" data-boxw="' + pw + '" data-wt="' + wt + '" ' +
           'onload="window.__snapSprite&&window.__snapSprite(this)" ' +
           'onerror="' + onerr.replace(/"/g, '&quot;') + '">';
  }

  // Still needed for <img> fallbacks on the big artwork sprites.
  function iconUrl(id) {
    var sp = Dex.species.get(id);
    // Alternate formes share the national dex number with the base species,
    // so the PokeAPI URL always returns the default forme's sprite.
    // Prefer Showdown's gen5 static sprite which is keyed by spriteid
    // (e.g. "sneasel-hisui"), never the bare toID ("sneaselhisui").
    if (isForme(sp) || !sp.num) {
      var sid = String((sp.exists && sp.spriteid) || id || 'unknown')
        .toLowerCase().replace(/[^a-z0-9-]+/g, '');
      return SD_SPRITE + 'gen5/' + sid + '.png';
    }
    return PA_SPRITE + sp.num + '.png';
  }

  // The END of every sprite fallback chain: a bundled, offline-safe silhouette.
  // Without it, playing offline (or through a sprite-host outage) renders the
  // browser's broken-image glyph in every party slot, which looks like the game
  // is broken rather than like the art hasn't loaded.
  var FALLBACK_SPRITE = 'assets/img/fallback-sprite.svg';
  // On-field size in world units.
  //
  // The old curve was `1.0 + heightm^0.55 * 1.15` clamped to [1.0, 3.4]. That
  // constant +1.0 floor swamped the real height for anything small: Wingull
  // (0.6m) came out at 1.87 vs Charizard's (1.7m) 2.54 -- barely a quarter
  // smaller, when it should be a third the size. Every little Pokemon looked
  // enormous. A pure power law keeps the real ordering and still compresses
  // the extremes so Joltik stays visible and Wailord still fits on screen.
  function worldH(id) {
    var sp = Dex.species.get(id);
    var m = (sp.exists && sp.heightm) ? sp.heightm : 1.0;
    return Math.max(0.55, Math.min(4.2, 1.55 * Math.pow(m, 0.42)));
  }
  // Never render a living Pokemon as 0%: 1 HP out of 651 rounds to zero and
  // looks like it already fainted. Only a0 HP shows 0%.
  function pctHP(frac) {
    if (!frac || frac <= 0) return 0;
    return Math.max(1, Math.round(frac * 100));
  }

  // The real species behind a (possibly nicknamed) Pokemon.
  // Always prefer the Dex entry for mon.id: mon.species used to be collapsed
  // to the base forme by an old cleanName() bug ("Sneasel" for Sneasel-Hisui),
  // which made battle captions and type chips lie about regional variants.
  function speciesOf(mon) {
    if (!mon) return '';
    if (mon.id) {
      var sp = Dex.species.get(mon.id);
      if (sp && sp.exists) return sp.name;
    }
    return mon.species || C.cleanName(mon.id);
  }

  function monDisplayName(mon) {
    return (mon && mon.name) || speciesOf(mon) || 'this Pokemon';
  }

  // ---- plain-language helpers (LAYER 1: always on, for everyone) ----------
  // These add information the game always had but never said out loud. They
  // are NOT part of the tutorial and are never hidden by the tips toggle: a
  // veteran benefits from a STAB marker exactly as much as a beginner does.

  // STAB / weak-stat / drawback chips for one move.
  function badgesHtml(moveId, mon, opts) {
    if (!window.Coach) return '';
    var b = window.Coach.moveBadges(moveId, mon, opts);
    return b ? '<div class="mv-badges">' + b + '</div>' : '';
  }

  // The honest one-line subtitle for an item whose name misleads.
  function itemPlainHtml(id, cls) {
    if (!window.Coach) return '';
    var line = window.Coach.itemOneLiner(id);
    if (!line) {
      var held = window.Coach.heldPlain(id);
      if (held) line = held;
    }
    return line ? '<span class="' + (cls || 'si-plain') + '">' + escapeHtml(line) + '</span>' : '';
  }

  function typeChips(types) {
    return types.map(function (t) { return '<span class="type type-' + t + '">' + t + '</span>'; }).join('');
  }

  // ---- transformation shop cards -----------------------------------------
  // Forme changes and Mega Stones are the two remaining party-specific shop
  // shelves. Unlike ordinary items, their value is in the Pokemon they create,
  // so a name + item sprite is not enough: show a large result silhouette and
  // compare the concrete type, base-stat and ability changes before purchase.
  var TRANSFORM_STATS = [
    ['hp', 'HP'], ['atk', 'Atk'], ['def', 'Def'],
    ['spa', 'Sp. Atk'], ['spd', 'Sp. Def'], ['spe', 'Speed']
  ];

  function martTransformOwner(entry) {
    if (!run || !Array.isArray(run.party)) return null;
    if (entry.forId != null) {
      for (var i = 0; i < run.party.length; i++) {
        if (String(run.party[i].uid) === String(entry.forId) || run.party[i].id === entry.forId) return run.party[i];
      }
    }
    if (entry.forSpecies) {
      for (var j = 0; j < run.party.length; j++) {
        if (run.party[j].name === entry.forSpecies) return run.party[j];
      }
    }
    return null;
  }

  function martTransformInfo(entry) {
    var owner = martTransformOwner(entry);
    if (!owner) return null;
    var targets = [];
    if (entry.kind === 'mega' && window.Mega) {
      var mega = window.Mega.infoFor(entry.id);
      var megaTarget = mega && mega.forme;
      if (!megaTarget && entry.forme) megaTarget = Dex.species.get(entry.forme).id;
      if (megaTarget) targets.push({ id: megaTarget });
    } else if (entry.kind === 'forme' && window.Forme) {
      targets = window.Forme.targetsFor(owner, entry.id).map(function (target) {
        return { id: target.id };
      });
    }
    targets = targets.filter(function (target) {
      var sp = Dex.species.get(target.id);
      return sp && sp.exists;
    });
    if (!targets.length) return null;
    return { owner: owner, from: Dex.species.get(owner.id), targets: targets };
  }

  function firstAbility(species) {
    if (!species || !species.abilities) return '';
    for (var key in species.abilities) {
      if (species.abilities[key]) return species.abilities[key];
    }
    return '';
  }

  function distinctValues(values) {
    var out = [];
    values.forEach(function (value) {
      if (out.indexOf(value) < 0) out.push(value);
    });
    return out;
  }

  // The old full-size tile (transformTypeSpec / transformStatSpec /
  // transformBstSpec / transformAbilitySpec / transformSilhouettes) was
  // replaced by transformBenefit() + a compact two-sprite preview. Those
  // functions are intentionally gone: the card this small has no room for
  // five spec cells, and "varies by result" is exactly the line a player
  // will skip. The helpers below intentionally do not call them.

  // One-line summary of the most consequential change a forme / mega stone
  // makes, so the compact shop tile can still show "what does this do?" at a
  // glance. Order of preference: type change, then a real stat deltas, then
  // ability swap. Lines that say "unchanged" or "varies by result" are
  // dropped -- they are noise on a card this small. Returns an empty string
  // if nothing meaningful changed.
  function transformBenefit(info) {
    var before;
    var after;
    // 1. Type change (only if it actually changes).
    before = (info.from.types || []).join(' / ');
    after = distinctValues(info.targets.map(function (t) {
      return (Dex.species.get(t.id).types || []).join(' / ');
    }));
    if (after.length === 1 && after[0] !== before) {
      return 'Type: ' + before + ' \u2192 ' + after[0];
    }
    // 2. Stat deltas (only the non-zero ones, condensed).
    before = info.from.baseStats || {};
    after = info.targets.map(function (t) {
      return Dex.species.get(t.id).baseStats || {};
    });
    if (after.length === 1) {
      var b2 = after[0];
      var parts = [];
      TRANSFORM_STATS.forEach(function (s) {
        var d = (b2[s[0]] || 0) - (before[s[0]] || 0);
        if (d) parts.push(s[1] + (d > 0 ? ' +' : ' ') + d);
      });
      if (parts.length) return 'Stats: ' + parts.join(' \u00b7 ');
    } else {
      // Multi-target forme (e.g. Arceus plates): each target gives a different
      // type, so mention the type roster once.
      var types = distinctValues(info.targets.map(function (t) {
        return (Dex.species.get(t.id).types || []).join(' / ');
      }));
      if (types.length && types.join(' / ') !== before) {
        return 'Type: ' + before + ' \u2192 ' + types.join(' / ');
      }
    }
    // 3. Ability swap.
    before = firstAbility(info.from);
    after = distinctValues(info.targets.map(function (t) {
      return firstAbility(Dex.species.get(t.id));
    }));
    if (after.length === 1 && after[0] && after[0] !== before) {
      return 'Ability: ' + (before || 'none') + ' \u2192 ' + after[0];
    }
    return '';
  }

  // Same one-line benefit string transformShopTileHtml() uses internally, but
  // available as a standalone helper for the plain shop tile path. Forme /
  // mega items have no plain one-liner in the coach module (both itemOneLiner
  // and heldPlain return null for them), so we derive a short spec line
  // here. Returns '' if there's nothing meaningful to say.
  function formeBenefitHtml(entry) {
    var info = martTransformInfo(entry);
    if (!info) return '';
    var line = transformBenefit(info);
    return line ? '<span class="si-plain">' + escapeHtml(line) + '</span>' : '';
  }

  function transformShopTileHtml(entry) {
    var info = martTransformInfo(entry);
    if (!info) return '';
    var price = entry.sale ? '$' + entry.price + ' sale' : '$' + entry.price;
    // Source sprite (the holder) and a single result sprite, side by side.
    // The "for {species}" chip on the right is the small inline label so
    // the player can read at a glance which Pokemon this is meant for.
    var ownerName = entry.forSpecies || speciesOf(info.owner);
    var single = info.targets.length === 1;
    return '<div class="si-transform-card">' +
      '<div class="si-top si-transform-top">' +
        (window.ItemArt ? window.ItemArt.itemImg(entry.id, 32, 'si-art') : '') +
        '<span class="si-name">' + escapeHtml(entry.name) + '</span>' +
        '<span class="si-price' + (entry.sale ? ' sale' : '') + '">' + price + '</span>' +
      '</div>' +
      '<div class="si-transform-sprites">' +
        '<span class="si-transform-source-mini">' +
          animSprite(info.owner.id, 48, 54, '', 1.15, info.owner.shiny) +
        '</span>' +
        '<span class="si-transform-arrow" aria-hidden="true">\u2192</span>' +
        '<span class="si-transform-result-mini">' +
          (single
            ? animSprite(info.targets[0].id, 48, 54, '', 1.15, false)
            : '<span class="si-transform-mult">choose 1 of ' + info.targets.length + '</span>') +
        '</span>' +
        '<span class="si-transform-for">for ' + escapeHtml(ownerName) + '</span>' +
      '</div>' +
      '<div class="si-desc si-transform-desc">' +
        escapeHtml(transformBenefit(info) ||
          (entry.kind === 'mega' ? 'Mega stone.' : 'Forme change.')) +
      '</div>' +
      (run.bag[entry.id] ? '<div class="si-own">owned: ' + run.bag[entry.id] + '</div>' : '') +
    '</div>';
  }

  // Small roster row for history tiles: party sprites in a tight row, with
  // the MVP marked by a tiny gold pill.
  function rosterRowHtml(roster, mvpId) {
    if (!roster || !roster.length) return '';
    return '<div class="hr-roster">' + roster.map(function (p) {
      var isMvp = mvpId && p.id === mvpId;
      return '<div class="hr-roster-mon">' +
        animSprite(p.id, 28, 32, '', 1.4, p.shiny) +
        (isMvp ? '<span class="hr-mvp-pill">MVP</span>' : '') +
      '</div>';
    }).join('') + '</div>';
  }

  // A large sprite that degrades through the whole fallback chain instead of
  // jumping straight to the 200px PokeAPI artwork (which then has to be
  // downscaled and looks soft). Small BW sprites are snapped to an integer
  // 2x so every source pixel maps to exactly 2x2 screen pixels.
  function bigSprite(id, cls, box, boxw, wt, shiny) {
    var urls = spriteUrls(id, false, shiny);
    urls.push(iconUrl(id));
    urls.push(FALLBACK_SPRITE);
    var chain = urls.slice(1);
    var onerr = "this.onerror=null;var q=" + JSON.stringify(chain) + ";" +
                "if(!this._i)this._i=0;" +
                "if(this._i<q.length){this.src=q[this._i++];this.onerror=arguments.callee;}";
    var boxH = box || 112;
    var boxW = boxw || box || 112;
    var widthTolerance = wt || 1;
    // Evolution art is deliberately 200px and sized entirely by CSS. Every
    // other large sprite gets decode-time bounds for the same reason as
    // animSprite(): opening the party sheet must not flash the image at its
    // (sometimes 200px) intrinsic fallback size before onload runs.
    var isEvolutionArt = (' ' + (cls || '') + ' ').indexOf(' evo-sprite ') >= 0;
    var bounds = isEvolutionArt ? ''
      : ' style="max-height:' + boxH + 'px;max-width:' + Math.round(boxW * widthTolerance) + 'px"';
    return '<img class="' + (cls || '') + (shiny ? ' is-shiny' : '') + '" src="' + urls[0] + '" alt=""' + bounds + ' ' +
           'decoding="async" fetchpriority="high" ' +
           'data-box="' + boxH + '" data-boxw="' + boxW + '" data-wt="' + widthTolerance + '" ' +
           'onload="window.__snapSprite&&window.__snapSprite(this)" ' +
           'onerror="' + onerr.replace(/"/g, '&quot;') + '">';
  }

  // ------------------------------------------------------------ SCREENS ---
  var SCREENS = ['Title', 'Setup', 'Starter', 'TeamBuilder', 'Crossroads', 'Battle',
                 'Reward', 'Catch', 'Tutor', 'Evolve', 'Summary', 'GameOver',
                 'DailyResult', 'Profile', 'Shinies', 'History', 'Rules', 'Guide'];
  function show(name) {
    SCREENS.forEach(function (s) {
      var el = $('screen' + s);
      if (el) el.hidden = (s !== name);
    });
    if (name !== 'Battle') teardownBattleUI();
    // A coach mark is anchored to an element on the screen being left, so it
    // must never survive the transition.
    if (window.Coach) { try { window.Coach.clearMark(); } catch (e) {} }
    // Battle music never plays outside a battle. beginBattle() starts the
    // right track; every other screen fades it out.
    if (name !== 'Battle' && window.GameAudio) window.GameAudio.stop();
    // The title backdrop owns the shared WebGL renderer while the title is on
    // screen. Leaving the title (starting a game, entering a battle, opening
    // another screen) must stop it so its canvas, loop and projection are gone
    // before the next screen mounts; returning to the title rebuilds it.
    if (name === 'Title') startTitleScene(); else stopTitleScene();
    // The title advertises live state (today's Daily, the streak, the Free
    // Play slot), and that state changes while the player is away from it.
    // Refreshing here means EVERY route back to the title is correct, instead
    // of depending on each caller remembering to ask.
    if (name === 'Title') { try { setContinueState(); } catch (e) { console.warn('title state', e); } }
    window.scrollTo(0, 0);
  }
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg; t.classList.add('on');
    clearTimeout(t._h); t._h = setTimeout(function () { t.classList.remove('on'); }, 2300);
  }

  // -------------------------------------------------------------- TITLE ---
  // ---- TITLE SHOWCASE ------------------------------------------------------
  // The title reuses BattleUI's projected animated Pokemon, layered CSS
  // perspective environment AND the same WebGL biome a real battle renders,
  // so the landing page is a true preview of the game. It shares the one
  // session renderer with battles: stopTitleScene() releases the canvas when
  // the title is left, and whichever screen mounts next (a battle, or the
  // title again) re-acquires the same context. If WebGL cannot be created
  // right now the scene mounts flat and the session's background recovery
  // upgrades it to 3D in place -- exactly like a battle.
  var titleUI = null, titleLoop = null;

  function startTitleScene() {
    var host = $('titleStage');
    if (!host || titleUI || !window.BattleUI) return;
    try {
      titleUI = new window.BattleUI();
      titleUI.showcase = true;          // suppress every HUD element
      // Acquire WebGL like a battle: the same shared renderer, biome and
      // camera. If a context is unavailable this instant, the mount degrades
      // to the CSS environment and the session's recovery chain upgrades it
      // to 3D in place -- no remount, no toast, no stuck 2D title.
      titleUI.onMountError = function (owner, err) {
        if (owner && owner !== titleUI) return;
        setTimeout(function () {
          if (owner && owner !== titleUI) return;
          stopTitleScene();
          console.warn('[title] showcase unavailable', err);
        }, 0);
      };
      titleUI.onError = titleUI.onMountError;
      titleUI.mount(host);

      // Two random fully-evolved-ish combatants each visit, so the title is
      // different every time you open the game. Filtered to a sane BST band
      // and no legendaries -- the same taste that picks starters.
      var pool = C.speciesPool().filter(function (id) {
        var bst = C.bst(id);
        return bst >= 400 && bst <= 560 && !C.isLegendary(id);
      });
      var pick2 = C.pickN(pool, 2, Math.random);
      var A = pick2[0] || 'gengar', B = pick2[1] || 'nidorino';
      var sa = Dex.species.get(A), sb = Dex.species.get(B);
      try {
        prefetchSpecies(A, { back: true });
        prefetchSpecies(B);
      } catch (e) {}
      var titleBiomeKey = null;
      if (profile && (profile.battlefield || 'dynamic') === 'match') {
        titleBiomeKey = THEME_BIOME[(profile && profile.theme) || 'default'] || 'meadow';
      }
      titleUI.setupBattle({
        // The showcase is visual ambience, not a battle entrance. Keep both
        // Pokemon silent so opening or returning to the title never plays a cry.
        player: { name: sa.name, lv: 100, types: sa.types.slice(), hp: 1, max: 100, st: null,
                  h: worldH(A), sid: sa.spriteid || A, num: sa.num, u: spriteUrls(A, true), silent: true },
        enemy:  { name: sb.name, lv: 100, types: sb.types.slice(), hp: 1, max: 100, st: null,
                  h: worldH(B), sid: sb.spriteid || B, num: sb.num, u: spriteUrls(B, false), silent: true },
        biomeSeed: 'title|' + A + '|' + B,
        biomeTypes: sa.types
      });
      if (titleBiomeKey) titleUI.buildBiome(titleBiomeKey);
      titleUI.setMsg('');
      // Use the REAL battle slots and the real battle camera -- the whole
      // point is that the title looks like the game. `showcase` only strips
      // the HUD; it must not invent its own framing.

      // Title battle: ultra-subtle, never-snapping, feels like a real idle battle.
      // The underlying BattleUI now smooth-longs lunge/shake with spring damping,
      // so we keep attacks tiny and let the sprite drift handle most of the life.
      var beat = 0;
      function nextBeat() {
        if (!titleUI) return;
        // pick a pattern with weighted randomness: mostly idle sway, occasional small lunge
        var roll = Math.random();
        var seq;
        var atkSide = null;
        if (roll < 0.35) {
          // pure idle – let the micro-sway breathe
          seq = [{ m: 'idle', d: 1200 + Math.random()*800 }];
        } else if (roll < 0.65) {
          // player feint: small forward nudge then smooth glide back
          atkSide = 'p';
          seq = [
            { m: 'idle', d: 400 + Math.random()*300 },
            { m: 'playerAttack', d: 420 },
            { m: 'idle', d: 700 + Math.random()*500 }
          ];
        } else {
          // enemy feint
          atkSide = 'e';
          seq = [
            { m: 'idle', d: 400 + Math.random()*300 },
            { m: 'enemyAttack', d: 420 },
            { m: 'idle', d: 700 + Math.random()*500 }
          ];
        }
        try {
          titleUI.queueMoments(seq);
          // very subtle impact spark – smaller, rarer, no screen flash
          if (atkSide && Math.random()<0.5) {
            var side = atkSide==='p' ? 'e' : 'p';
            var delay = 360 + Math.random()*80;
            setTimeout(function () {
              if (!titleUI) return;
              try {
                var col = atkSide==='p' ? 0xc07ce8 : 0x7fb2ff;
                var sp = titleUI.s[side];
                if (sp && sp.grp && titleUI._burst) {
                  var pos = new window.THREE.Vector3();
                  sp.grp.getWorldPosition(pos); pos.y += sp.h * 0.48 + Math.random()*0.15;
                  // tiny burst, reads as contact but not explosive
                  titleUI._burst(pos, col, 6 + Math.floor(Math.random()*4));
                }
              } catch (e) {}
            }, delay);
          }
          // rare mega pulse – one every ~8 beats, still subtle
          if (beat % 8 === 7 && Math.random()<0.6) {
            setTimeout(function () {
              if (titleUI && titleUI.trigMega) { try { titleUI.trigMega(Math.random()<0.5?'p':'e'); } catch (e) {} }
            }, 900 + Math.random()*400);
          }
        } catch (e) {}
        beat++;
        // irregular, longer gaps so it never feels metronomic
        titleLoop = setTimeout(nextBeat, 1800 + Math.random() * 1700);
      }
      titleLoop = setTimeout(nextBeat, 800 + Math.random()*400);
    } catch (e) {
      console.warn('title scene', e);
      // The showcase is cosmetic. A failure removes only its backdrop; the
      // title controls stay usable and no GPU recovery loop is involved.
      stopTitleScene();
    }
  }

  function stopTitleScene() {
    if (titleLoop) { clearTimeout(titleLoop); titleLoop = null; }
    if (titleUI) {
      try { titleUI.unmount(); } catch (e) {}
      titleUI = null;
    }
    // The whole stage is rebuilt on the next visit. Clearing it (plus the
    // mount flag and any flat-mode residue) guarantees no canvas, sprites or
    // environment can leak from the title into the running game, even if an
    // unmount was interrupted halfway.
    var host = $('titleStage');
    if (host) {
      host.innerHTML = '';
      host._bm = null;
      host.classList.remove('battle-flat');
      host.style.background = '';
    }
  }

  function initTitle() {
    $('btnNewRun').addEventListener('click', function () {
      var s = loadGame('free');
      if (s) { run = reviveRun(s); renderCrossroads(); show('Crossroads'); return; }
      withModeInfo('free', startFreeRun);
    });
    $('btnDaily').addEventListener('click', onDailyClick);
    $('btnGauntlet').addEventListener('click', onGauntletClick);
    $('btnTitleMenu').addEventListener('click', openMenu);
    var ar = $('btnArchiveDaily');
    if (ar) ar.addEventListener('click', archiveStaleDaily);
    // ---- first-visit doors ----
    var fresh = $('btnFreshGame');
    if (fresh) fresh.addEventListener('click', openSetup);
    var resume = $('btnResumeRun');
    if (resume) resume.addEventListener('click', function () {
      var s = loadGame('free');
      if (!s) { setContinueState(); return; }
      run = reviveRun(s); renderCrossroads(); show('Crossroads');
    });
    [$('btnTitleLoad'), $('btnTitleLoad2')].forEach(function (b) {
      if (b) b.addEventListener('click', openSaveImport);
    });
    setContinueState();
  }

  // Has this player ever finished anything? Used to decide whether the title
  // shows two friendly doors or the full three-mode menu. Deliberately
  // generous: any run in any slot, any history, any completed Daily counts,
  // so an existing player is never demoted to the beginner screen.
  function hasAnyHistory() {
    try {
      if (window.Coach && window.Coach.isOnboarded()) return true;
      if (profile && (profile.history || []).length) return true;
      if (profile && profile.totalRuns > 0) return true;
      if (loadGame('free') || loadGame('daily') || loadGame('gauntlet')) return true;
      var d = window.Daily && window.Daily.load();
      if (d && d.results && Object.keys(d.results).length) return true;
    } catch (e) {}
    return false;
  }

  // ------------------------------------------------------- TRAINER SETUP ---
  // Sprite + name + "how much help do you want". Ten seconds of investment
  // before any instruction, which is what makes someone willing to read the
  // first lesson instead of hammering past it.
  var setupWantsTips = true;

  function openSetup() {
    loadProfile();
    setupWantsTips = true;
    pendingAvatar = null;
    var img = $('setupAvatarImg');
    if (img) img.src = avatarUrl(safeAvatar());
    var nameIn = $('setupName');
    if (nameIn) nameIn.value = profile.name || '';
    $('screenSetup').querySelectorAll('[data-exp]').forEach(function (b) {
      b.classList.toggle('on', (b.dataset.exp === 'new') === setupWantsTips);
    });
    show('Setup');
    // The tutorial's first beat: Professor Oak introduces himself over the
    // setup screen and walks the player through sprite, name and the
    // experience choice, so the onboarding reads as one conversation from
    // the very first tap.
    var CO = window.Coach;
    if (CO && CO.tipsOn() && !CO.isOnboarded() && !CO.seen('welcome')) {
      setTimeout(function () {
        if ($('screenSetup').hidden) return;
        CO.lesson('welcome', {
          anchor: $('setupAvatar'),
          vital: true,
          stillValid: function () { return !$('screenSetup').hidden; }
        });
      }, 0);
    }
  }

  function initSetup() {
    var av = $('setupAvatar');
    if (av) av.addEventListener('click', function () { openAvatarPicker({ from: 'setup' }); });
    $('screenSetup').querySelectorAll('[data-exp]').forEach(function (b) {
      b.addEventListener('click', function () {
        setupWantsTips = b.dataset.exp === 'new';
        $('screenSetup').querySelectorAll('[data-exp]').forEach(function (o) {
          o.classList.toggle('on', o === b);
        });
      });
    });
    var back = $('btnSetupBack');
    if (back) back.addEventListener('click', function () { show('Title'); });
    var go = $('btnSetupGo');
    if (go) go.addEventListener('click', beginFreshGame);
    var nameIn = $('setupName');
    if (nameIn) nameIn.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); beginFreshGame(); }
    });

    // ---- skip tutorial overlay buttons ----
    var sDaily = $('btnSkipChooseDaily');
    if (sDaily) sDaily.addEventListener('click', function () {
      window.Modal.close('screenSkipTutorialChoice');
      onDailyClick();
    });
    var sFree = $('btnSkipChooseFree');
    if (sFree) sFree.addEventListener('click', function () {
      window.Modal.close('screenSkipTutorialChoice');
      startFreeRun();
    });
    var sGauntlet = $('btnSkipChooseGauntlet');
    if (sGauntlet) sGauntlet.addEventListener('click', function () {
      window.Modal.close('screenSkipTutorialChoice');
      onGauntletClick();
    });
    var sBack = $('btnSkipChooseBack');
    if (sBack) sBack.addEventListener('click', function () {
      window.Modal.close('screenSkipTutorialChoice');
    });
  }

  // Commit the trainer, then start the guided first run.
  function beginFreshGame() {
    loadProfile();
    var nameIn = $('setupName');
    var val = String((nameIn && nameIn.value) || '').trim().replace(/\s+/g, ' ').slice(0, 12);
    profile.name = val || 'Trainer';
    if (pendingAvatar) { profile.avatar = pendingAvatar; pendingAvatar = null; }
    saveProfile();
    updateMenuAvatar();

    if (window.Coach) {
      window.Coach.setOff(!setupWantsTips);
      // The prologue flag turns on the scripted beats. The run separately
      // keeps its difficulty safety net through both introductory sections.
      window.Coach.setPrologue(setupWantsTips);
      window.Coach.setOnboarded(true);
    }

    if (!setupWantsTips) {
      if (window.Coach) {
        var face = $('skipChooseFace');
        if (face) face.innerHTML = window.Coach.advisorImg(46);
      }
      window.Modal.open('screenSkipTutorialChoice');
    } else {
      startFreeRun({ prologue: true });
    }
  }

  // ---------------------------------------------------- MODE EXPLAINERS ----
  // One sheet the first time each mode is opened. Answers only three
  // questions: what is it, how long is it, what's the catch.
  function withModeInfo(mode, go) {
    var C2 = window.Coach;
    if (!C2 || !C2.modeSeen || !C2.inPrologue() || C2.modeSeen(mode) || !C2.tipsOn()) {
      go(); return;
    }
    var info = C2.modeInfo(mode);
    if (!info) { go(); return; }
    var el = $('screenModeInfo');
    if (!el) { go(); return; }
    $('modeFace').innerHTML = C2.advisorImg(104);
    $('modeTitle').textContent = info.title;
    $('modeLede').textContent = info.lede;
    $('modePoints').innerHTML = info.points.map(function (p) {
      return '<li><b>' + escapeHtml(p[0]) + '</b><span>' + escapeHtml(p[1]) + '</span></li>';
    }).join('');
    var done = false;
    function close(then) {
      if (done) return; done = true;
      C2.markMode(mode);
      window.Modal.close(el);
      if (then) then();
    }
    $('btnModeGo').onclick = function () { close(go); };
    $('btnModeBack').onclick = function () { close(null); };
    window.Modal.open(el, { onClose: function () { if (!done) { done = true; C2.markMode(mode); } } });
  }

  // The Daily button has four states, and the click means something different
  // in each: play today, resume today, review today's finished result, or
  // start over after a wipe.
  function onDailyClick() {
    var D = window.Daily;
    var today = D.dayKey();
    var done = D.resultFor(today);
    if (done) { showDailyResult(done); return; }
    var saved = loadDailyToday();
    if (saved) {
      run = reviveRun(saved); renderCrossroads(); show('Crossroads'); return;
    }
    // Starting today's Daily must never silently destroy yesterday's.
    var stale = loadDailyStale();
    if (stale && !confirm('You have an unfinished Daily from ' + stale.dailyDate +
        '.\n\nStarting today\u2019s Daily replaces it. Use "Move to Free Play" on the ' +
        'title screen first if you want to keep it.')) return;
    withModeInfo('daily', startDailyRun);
  }

  // The Gauntlet CTA mirrors the Daily's: resume the parked run when one
  // exists, otherwise open the draft. One click, two meanings, no fork.
  function onGauntletClick() {
    var saved = loadGame('gauntlet');
    if (saved) {
      run = reviveRun(saved); renderCrossroads(); show('Crossroads'); return;
    }
    withModeInfo('gauntlet', startGauntlet);
  }

  // ---- RUN STARTERS --------------------------------------------------------
  // Two entry points instead of one: the Daily is dated, finite and scored,
  // while Free Play is randomized and endless.
  function startDailyRun() {
    var D = window.Daily;
    var key = D.dayKey();
    return startRun(D.seedFor(key), {
      mode: 'daily',
      dailyDate: key,
      maxSections: D.SECTIONS,
      dailyNumber: D.puzzleNumber(key)
    });
  }
  function startFreeRun(opts) {
    opts = opts || {};
    return startRun(Math.floor(Math.random() * 1e9),
      { mode: 'free', prologue: !!opts.prologue });
  }

  // Yesterday's unfinished Daily is a real run someone spent time on. Rather
  // than deleting it, hand it to Free Play so it can keep going endlessly.
  function archiveStaleDaily() {
    var stale = loadDailyStale();
    if (!stale) { toast('No archived Daily to move.'); return; }
    var existing = loadGame('free');
    if (existing && !confirm('Your Free Play slot already has a run at Section ' +
        (existing.section || 1) + '. Replace it with the Daily from ' + stale.dailyDate + '?')) return;
    stale.mode = 'free';
    stale.archivedFrom = stale.dailyDate;
    stale.dailyDate = null;
    stale.maxSections = 0;             // endless from here on
    ST.putRun('free', stale);
    ST.clearRun('daily');
    toast('Moved to Free Play \u2014 it can run forever now.');
    setContinueState();
  }

  // The title reflects BOTH slots independently: today's Daily and a Free Play
  // run can now coexist, so neither one hides the other.
  function setContinueState() {
    var D = window.Daily;
    var today = D.dayKey();
    var result = D.resultFor(today);
    var dailySave = loadDailyToday();
    var stale = loadDailyStale();
    var free = loadGame('free');

    // ---- which title is this? ----
    // A first-time visitor gets two doors, not three modes they cannot tell
    // apart. Someone mid-prologue gets one door back into it. Everyone else
    // gets the real menu.
    var firstBlock = $('titleFirst'), resumeBlock = $('titleResume'), modesBlock = $('titleModes');
    var prologue = (window.Coach && window.Coach.inPrologue()) || !!(free && free.prologue);
    var veteran = hasAnyHistory();
    var mode = (prologue && free) ? 'resume' : (veteran ? 'modes' : 'first');
    if (firstBlock) firstBlock.hidden = mode !== 'first';
    if (resumeBlock) resumeBlock.hidden = mode !== 'resume';
    if (modesBlock) modesBlock.hidden = mode !== 'modes';
    if (mode === 'resume' && free) {
      var rs = $('resumeSub');
      if (rs) {
        rs.textContent = 'Section ' + (free.section || 1) + ' \u00b7 ' +
          (free.battlesWon || 0) + (free.battlesWon === 1 ? ' battle won' : ' battles won');
      }
    }
    // Nothing below this point matters when the mode grid is hidden.
    if (mode !== 'modes') return;

    // ---- Daily button ----
    var main = $('dailyMain'), sub = $('dailyDate'), btn = $('btnDaily');
    if (main && sub && btn) {
      btn.classList.toggle('done', !!result);
      if (result) {
        var fmt = today;
        try {
          fmt = D.parseKey(today).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
        } catch (e) {}
        // Build the hist-row style tile inside the button
        var rosterHtml = rosterRowHtml(result.roster, result.mvp ? result.mvp.id : null);
        main.innerHTML = '<div class="hr-main">' +
          '<div class="hr-top">' +
            '<b>' + fmt + '</b>' +
            '<span class="hr-badge ' + result.outcome + '">' +
              (result.outcome === 'complete' ? 'Cleared' : 'Fell at S' + result.sections) +
            '</span>' +
          '</div>' +
          '<div class="hr-sub">' +
            result.battles + ' battles \u00b7 ' +
            result.caught + ' caught \u00b7 ' +
            result.lost + ' lost' +
          '</div>' +
        '</div>' + rosterHtml;
        sub.textContent = '';
      } else if (dailySave) {
        main.textContent = 'Resume Daily';
        sub.textContent = 'Section ' + (dailySave.section || 1) + ' of ' + D.SECTIONS +
          ' \u00b7 ' + (dailySave.battlesWon || 0) + ' battles won';
      } else {
        main.textContent = 'Daily Run';
        var dailyFmt = today;
        try {
          dailyFmt = D.parseKey(today).toLocaleDateString(undefined,
            { weekday: 'short', month: 'short', day: 'numeric' });
        } catch (e) {}
        sub.textContent = D.SECTIONS + ' sections \u00b7 one scored run today \u00b7 ' + dailyFmt;
      }
    }

    // ---- streak chip ----
    var chip = $('dailyStreak');
    if (chip) {
      var st = D.streakInfo(today);
      if (st.streak > 0) {
        chip.hidden = false;
        chip.innerHTML = '<b>' + st.streak + '</b> day streak' +
          (st.best > st.streak ? ' \u00b7 best ' + st.best : '');
      } else {
        chip.hidden = true;
      }
    }

    // The Daily CTA itself reopens today's result once the run is complete, so
    // there is deliberately no duplicate "See today's result" button here.

    // ---- Free Play row ----
    var freeSep = $('titleFreeSep');
    if (freeSep) freeSep.hidden = false;

    var btnNewRun = $('btnNewRun');
    var btnNewRunMain = btnNewRun ? btnNewRun.querySelector('.bd-main') : null;
    if (btnNewRunMain) {
      if (free) {
        btnNewRunMain.textContent = 'Continue run';
        var sec = free.section || 1, won = free.battlesWon || 0;
        var n = (free.party && free.party.length) || 0;
        btnNewRun.title = 'Section ' + sec + ' \u00b7 ' + won +
          (won === 1 ? ' battle won' : ' battles won') + ' \u00b7 ' + n +
          (n === 1 ? ' Pokemon' : ' Pokemon');
      } else {
        btnNewRunMain.textContent = 'Random run';
        btnNewRun.removeAttribute('title');
      }
    }

    // ---- Full team gauntlet ----
    var gauntlet = loadGame('gauntlet');
    var gMain = $('gauntletMain'), gBtn = $('btnGauntlet');
    if (gMain && gBtn) {
      gBtn.classList.add('btn-glass');
      gBtn.classList.remove('btn-white', 'btn-daily');
      if (gauntlet) {
        gMain.textContent = 'Resume Gauntlet';
        gBtn.title = 'Trainer ' + (gauntlet.section || 1) + ' \u00b7 ' +
          (gauntlet.trainersBeaten || 0) + ' beaten';
      } else {
        gMain.textContent = 'Full team gauntlet';
        gBtn.removeAttribute('title');
      }
    }

    // ---- archived Daily offer ----
    var ar = $('btnArchiveDaily');
    if (ar) {
      ar.hidden = !stale;
      if (stale) ar.querySelector('.bd-sub').textContent =
        'Unfinished Daily from ' + stale.dailyDate + ' \u00b7 Section ' + (stale.section || 1);
    }
  }

  // ------------------------------------------------------------ STARTER ---
  var starterChoices = [];
  async function startRun(seed, opts) {
    opts = opts || {};
    run = N.newRun(seed);
    // Mode metadata rides on the run itself, so it survives a save/load and
    // every screen can ask "is this a Daily?" without a global.
    run.mode = opts.mode === 'daily' ? 'daily' : 'free';
    run.dailyDate = opts.dailyDate || null;
    run.dailyNumber = opts.dailyNumber || 0;
    run.maxSections = opts.maxSections || 0;    // 0 = endless
    run.sectionMarks = [];                      // share-card squares
    run.trainingPaidThisRound = false;
    // The guided first run is a REAL run in the real Free Play slot. The
    // scripted coach can graduate the player at the start of section 2, while
    // a separate safety marker keeps both opening sections approachable.
    run.prologue = !!opts.prologue;
    if (!run.prologue && window.Coach) window.Coach.setPrologue(false);
    run.tutorialSafeThrough = run.prologue ? 2 : 0;
    // Section 1 is a finite script. These flags are run-scoped (not profile
    // lesson history), so a player who has already seen a lesson or reloads
    // halfway through still gets the exact next action.
    run.tutorialStarterShown = false;
    run.tutorialRouteDone = false;
    run.tutorialHealDone = false;
    run.tutorialOnwardDone = false;
    run.tutorialTrainerDone = false;
    run.tutorialDamageDone = false;
    run.tutorialCatchDone = false;
    run.tutorialEffectDone = false;
    run.tutorialSwitchOpen = false;
    run.tutorialSwitchDone = false;
    run.tutorialSwitchPickDone = false;
    run.tutorialBattleBagDone = false;
    run.tutorialTrainingUid = null;
    var backBtn = $('btnStarterBack');
    if (backBtn) backBtn.hidden = !!run.prologue;
    var rand = C.mulberry32(seed ^ 0x1234);
    // Starters use the same complete National Dex pool as wild encounters and
    // the gauntlet.  No mode-specific species whitelist: all 1025 species are
    // eligible here, including legendary and unevolved Pokémon.
    //
    // EXCEPT in the prologue: a fixed grass/fire/water trio makes the first
    // lesson legible. Three random picks out of 1025 can hand a beginner
    // three unevolved oddities or three legendaries, and then "compare the
    // stats" teaches nothing. These three differ in a way a person can read,
    // and all three still evolve, so evolution can be taught later on the
    // player's own Pokemon.
    var ids = run.prologue
      ? ['treecko', 'charmander', 'froakie']
      : C.pickN(C.speciesPool(), 3, rand);
    show('Starter');
    $('starterGrid').innerHTML = '<p class="hint center">Loading...</p>';
    starterChoices = [];
    for (var i = 0; i < ids.length; i++) {
      var sm = N.trainPlayerMon(await C.makeMon(ids[i]));
      // A starter rolls for shiny on the same 1/512 odds as a wild.
      if (rand() < N.SHINY_ODDS) sm.shiny = true;
      starterChoices.push(sm);
      try { prefetchSpecies(sm.id, { shiny: !!sm.shiny }); } catch (e) {}
    }
    renderStarters();
  }

  function renderStarters() {
    var g = $('starterGrid');
    var CO = window.Coach;

    // The advice is the professor's immersive dialog sheet with the typewriter
    // reveal — the same surface the rest of the tutorial uses, so the very
    // first lesson sets the register for everything that follows.
    //
    // The choice itself is FREE: the lesson points at the grid as a whole and
    // never action-locks a specific card. Forcing the first card (the old
    // behaviour) made the tutorial pick Treecko for the player — Charmander
    // and Froakie were literally unclickable — and the rest of the guided run
    // is built to adapt to whichever starter is actually chosen.
    if (CO && CO.tipsOn() && run && run.prologue && !run.tutorialStarterShown) {
      setTimeout(function () {
        if ($('screenStarter').hidden) return;
        CO.lesson('starter', {
          anchor: g,
          keepHalo: true,
          bypassSeen: true,
          vital: true,
          stillValid: function () { return !$('screenStarter').hidden; },
          onShow: function () {
            run.tutorialStarterShown = true;
            if (!CO.seen('starter')) CO.markSeen('starter');
          }
        });
      }, 0);
    }
    var sub = $('starterSub');
    if (sub && run && run.prologue) sub.textContent = 'One life. No revives. Choose carefully.';

    g.innerHTML = '';
    starterChoices.forEach(function (mon) {
      var card = document.createElement('div');
      var isPro = run && run.prologue;
      card.className = 'card starter-card' + (isPro ? ' simple' : '');
      if (isPro) {
        card.innerHTML =
          '<div class="sprite-box">' + bigSprite(mon.id, '', 112, 150, 1, mon.shiny) + '</div>' +
          '<div class="sc-name">' + escapeHtml(mon.name) + '</div>' +
          '<div class="types" style="justify-content:center;margin:6px 0">' + typeChips(mon.types) + '</div>' +
          '<button class="btn-primary pick-btn">Choose</button>';
      } else {
        card.innerHTML =
          '<div class="sprite-box">' + bigSprite(mon.id, '', 112, 150, 1, mon.shiny) + '</div>' +
          '<div class="sc-name">' + escapeHtml(mon.name) + '</div>' +
          '<div class="types">' + typeChips(mon.types) + '</div>' +
          '<div class="statline">HP ' + C.maxHP(mon) + ' \u00b7 BST ' + C.bst(mon.id) + '</div>' +
          '<div class="ability" data-tip="ability:' + mon.ability + '">' + mon.ability + '</div>' +
          '<div class="movelist">' + mon.moves.map(function (m) {
            var d = Dex.moves.get(m);
            var pw = d.category === 'Status' ? 'Status' : (d.basePower ? 'Pow ' + d.basePower : '');
            return '<div class="move-card-inline" data-tip="move:' + d.id + '" tabindex="0">' +
              '<div class="mci-top"><span class="mv-chip type-' + d.type + '">' + d.type + '</span>' +
              '<span class="mci-pw">' + pw + '</span></div>' +
              '<span class="mci-name">' + d.name + '</span>' +
              badgesHtml(m, mon, { compact: true }) + '</div>';
          }).join('') + '</div>' +
          '<button class="btn-primary pick-btn">Choose</button>';
      }
      card.querySelector('.pick-btn').addEventListener('click', function () {
        // The naming dialog is the next tutorial surface, not a second layer
        // underneath the starter lesson. Retire the lesson/bubble first so the
        // name prompt always sits directly above the three starter cards.
        if (window.Coach) { try { window.Coach.clearMark(); } catch (e) {} }
        askNickname(mon, function (nick) {
          mon.species = C.cleanName(mon.id);   // remember what it really is
          mon.name = nick;
          run.party.push(mon);
          // The guided run tracks the starter by identity so the forced
          // evolution and training steps can find it even after it evolves.
          if (run && run.prologue) run.tutorialStarterUid = mon.uid;
          N.trackMon(run, mon);
          run.seenSpecies[mon.id] = 1;
          N.addItem(run, 'pokeball', 5);
          // Full Restore is the only healing item in the game. Give a new run
          // a few so the first tutorial can teach the real item instead of a
          // medicine that will never appear on a fresh shop shelf.
          N.addItem(run, 'fullrestore', 3);
          N.logMsg(run, 'You set out with ' + nick + ' the ' + mon.species + '.');
          if (mon.shiny) recordShiny(mon, 'starter');
          // The Daily result records which starter you took, so the share card
          // and history can show how the same challenge played out differently.
          run.starterMeta = { id: mon.id, name: mon.species };
          saveGame(); renderCrossroads(); show('Crossroads');
        });
      });
      g.appendChild(card);
    });
  }

  // ----------------------------------------------------- TEAM GAUNTLET ----
  // The third mode: draft any six Pokemon at no cost, then fight trainer
  // after trainer. There is deliberately no starter RNG here -- the whole
  // point is that the player chooses the exact team they want to climb with.
  // Picks go through makeMon() + trainPlayerMon(), so a built mon is raised
  // exactly like a starter (role-based moveset, competitive SP/nature).
  var GB_MAX = 6;
  var GB_PAGE = 10000;           // the complete national dex; search narrows it
  var gbTeam = [];               // [{id,name,types,bst,mon}] in draft order

  var _gbPool = null;
  function gbPool() {
    if (_gbPool) return _gbPool;
    _gbPool = C.speciesPool().map(function (id) {
      var sp = Dex.species.get(id);
      return { id: id, name: sp.name, types: sp.types, bst: C.bst(id), stats: sp.baseStats || {} };
    });
    return _gbPool;
  }

  function gbChosen(id) {
    return gbTeam.some(function (p) { return p.id === id; });
  }

  function gbMatches(query) {
    var q = String(query || '').trim().toLowerCase();
    // Punctuation-insensitive both ways: "farfetchd" finds Farfetch'd,
    // "mr mime" finds Mr. Mime and "rotomwash" finds Rotom-Wash.
    var words = q
      ? q.split(/\s+/).map(function (w) { return w.replace(/[^a-z0-9]/g, ''); })
          .filter(function (w) { return w.length > 0; })
      : [];
    var hits = [];
    var pool = gbPool();
    for (var i = 0; i < pool.length; i++) {
      var p = pool[i];
      if (words.length) {
        var hay = (p.name + ' ' + p.id + ' ' + p.types.join(' '))
          .toLowerCase().replace(/[^a-z0-9]/g, '');
        if (!words.every(function (w) { return hay.indexOf(w) >= 0; })) continue;
      }
      hits.push(p);
      if (hits.length >= GB_PAGE) break;
    }
    var stat = ($('tbSortStat') && $('tbSortStat').value) || 'bst';
    var dir = ($('tbSortDir') && $('tbSortDir').value) || 'desc';
    hits.sort(function (a, b) {
      var av = stat === 'name' ? a.name.toLowerCase() : (stat === 'bst' ? a.bst : (a.stats[stat] || 0));
      var bv = stat === 'name' ? b.name.toLowerCase() : (stat === 'bst' ? b.bst : (b.stats[stat] || 0));
      var n = typeof av === 'string' ? av.localeCompare(bv) : av - bv;
      return (dir === 'asc' ? n : -n) || a.name.localeCompare(b.name);
    });
    return { hits: hits, capped: hits.length >= GB_PAGE, query: q };
  }

  function startGauntlet() {
    gbTeam = [];
    $('tbSearch').value = '';
    drawBuilder();
    show('TeamBuilder');
  }

  function drawBuilder() {
    // ---- the six draft slots ----
    var teamHost = $('tbTeam');
    var slots = '';
    for (var i = 0; i < GB_MAX; i++) {
      var p = gbTeam[i];
      if (p) {
        slots += '<div class="tslot filled" data-i="' + i + '">' +
          (i === 0 ? '<span class="ts-lead">LEAD</span>' : '') +
          '<span class="ts-art">' + animSprite(p.id, 46, 52, '', 1.4, p.mon && p.mon.shiny) + '</span>' +
          '<span class="ts-name">' + escapeHtml(p.name) + '</span>' +
          (p.mon && p.mon.item ? '<span class="ts-item" title="' + escapeHtml(itemName(p.mon.item)) + '">' + (window.ItemArt ? window.ItemArt.itemImg(p.mon.item, 20) : '') + '</span>' : '') +
          '<button class="ts-rm" data-rm="' + i + '" title="Remove">\u00d7</button></div>';
      } else {
        slots += '<div class="tslot empty">?</div>';
      }
    }
    teamHost.innerHTML = slots;
    // Clicking a filled slot opens its configuration panel
    teamHost.querySelectorAll('.tslot.filled[data-i]').forEach(function (b) {
      b.addEventListener('click', function (e) {
        if (e.target.closest('.ts-rm')) return; // remove button handled separately
        openGbConfig(+b.dataset.i);
      });
    });
    // Remove buttons
    teamHost.querySelectorAll('.ts-rm[data-rm]').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        gbTeam.splice(+b.dataset.rm, 1);
        drawBuilder();
      });
    });

    $('tbCount').textContent = gbTeam.length + ' / ' + GB_MAX +
      (gbTeam.length === GB_MAX ? ' \u00b7 team complete!' : '');
    var startBtn = $('btnTbStart');
    startBtn.disabled = gbTeam.length !== GB_MAX;
    $('tbStartLabel').textContent = gbTeam.length === GB_MAX
      ? 'Start Gauntlet'
      : 'Pick ' + (GB_MAX - gbTeam.length) + ' more';

    // ---- the catalogue ----
    var m = gbMatches($('tbSearch').value);
    var full = gbTeam.length >= GB_MAX;
    var listHost = $('tbList');
    if (!m.hits.length) {
      listHost.innerHTML = '<div class="tb-empty">No Pokemon matches that name.</div>';
      return;
    }
    listHost.innerHTML = m.hits.map(function (p) {
      var taken = gbChosen(p.id);
      var dis = taken || full ? ' disabled' : '';
      return '<button class="tb-row' + (taken ? ' seen' : '') + '" data-id="' + p.id + '"' + dis + '>' +
        '<span class="tb-art">' + animSprite(p.id, 48, 56, '', 1.45, false) + '</span>' +
        '<span class="tb-who"><span class="tb-name">' + escapeHtml(p.name) + '</span>' +
        '<span class="tb-meta"><span class="types">' + typeChips(p.types) + '</span>' +
        '<span class="tb-bst">BST ' + p.bst + (C.isLegendary(p.id) ? ' \u00b7 Legendary' : '') + '</span></span></span>' +
        '<span class="tb-add">' + (taken ? 'Picked' : '+ Add') + '</span></button>';
    }).join('') + (m.capped
      ? '<div class="tb-empty">More matches \u2014 keep typing to narrow it down.</div>'
      : '');
    listHost.querySelectorAll('.tb-row[data-id]').forEach(function (b) {
      b.addEventListener('click', async function () {
        var id = b.dataset.id;
        if (gbChosen(id) || gbTeam.length >= GB_MAX) return;
        var p = gbMatches($('tbSearch').value).hits.filter(function (x) { return x.id === id; })[0];
        if (!p) return;
        b.disabled = true;
        b.querySelector('.tb-add').textContent = 'Loading\u2026';
        try {
          var mon = N.trainPlayerMon(await C.makeMon(id));
          mon.species = C.cleanName(mon.id);
          gbTeam.push({ id: p.id, name: p.name, types: p.types, bst: p.bst, mon: mon });
        } catch (e) {
          console.error('[gauntlet] makeMon failed', e);
          toast('Failed to create Pokemon. Try again.');
          drawBuilder();
          return;
        }
        try { playCry(id); } catch (e) {}
        drawBuilder();
        if (gbTeam.length >= GB_MAX) {
          toast('Team complete \u2014 tap a slot to configure, then Start Gauntlet!');
        }
      });
    });
  }

  // ---- GAUNTLET TEAM BUILDER CONFIG PANEL ----------------------------------
  // Opens a detail/config panel for a team builder Pokemon. Reuses the
  // xTeamDetail overlay but reads from gbTeam instead of run.party.
  var gbConfigIdx = -1;

  function openGbConfig(idx) {
    var entry = gbTeam[idx];
    if (!entry || !entry.mon) return;
    gbConfigIdx = idx;
    window.Modal.open('xTeamDetail', { onClose: function () { gbConfigIdx = -1; } });
    drawGbDetail();
  }

  function drawGbDetail() {
    var overlay = $('xTeamDetail');
    if (!overlay) return;
    var host = overlay.querySelector('.overlay-card');
    if (!host) return;
    var entry = gbTeam[gbConfigIdx];
    if (!entry || !entry.mon) { window.Modal.close('xTeamDetail'); host.innerHTML = ''; return; }
    var mon = entry.mon;

    var formeTargets = [];
    if (window.Forme) {
      // Check all forme items for this Pokemon
      var FM = window.Forme;
      Object.keys(FM.CUSTOM).forEach(function (cid) {
        FM.targetsFor(mon, cid).forEach(function (t) { formeTargets.push({ item: cid, target: t }); });
      });
      // Also check Showdown forme items
      var idx = FM.index();
      var baseId = PS.toID(Dex.species.get(mon.id).baseSpecies || mon.id);
      (idx.byBase[baseId] || []).forEach(function (e) {
        FM.targetsFor(mon, e.item).forEach(function (t) { formeTargets.push({ item: e.item, target: t }); });
      });
    }

    var heldHtml = '<div class="pd-sec"><div class="pd-label">Held item</div>';
    if (mon.item) {
      heldHtml += '<button class="pd-held" data-gb-take="1" data-tip="item:' + mon.item + '">' +
        (window.ItemArt ? window.ItemArt.itemImg(mon.item, 26) : '') +
        '<span>' + itemName(mon.item) + '</span><em>tap to change</em></button>';
    } else {
      heldHtml += '<div class="pd-empty">Nothing held \u2014 tap to pick one.</div>';
    }
    heldHtml += '<button class="btn-secondary wide" style="margin-top:8px" data-gb-held="1">Pick Held Item</button></div>';

    var formeHtml = '';
    // Held forme items require the item; custom key-item forme tools are free
    // and are deliberately never placed in the held-item picker.
    formeTargets = formeTargets.filter(function (ft) { return (window.Forme.CUSTOM && window.Forme.CUSTOM[ft.item]) || mon.item === ft.item; });
    if (formeTargets.length) {
      formeHtml = '<div class="evo-box forme-box"><div class="evo-title">Forme change</div>' +
        formeTargets.map(function (ft) {
          return '<button class="evo-btn forme-btn ready" data-gb-forme-item="' + ft.item + '" data-gb-forme="' + ft.target.id + '">' +
            evoPreviewHtml(mon.id, ft.target.id, { reveal: true }) +
            '<span class="evo-txt"><span class="evo-n">' + ft.target.name + '</span>' +
            '<span class="evo-r">Switch forme</span></span></button>';
        }).join('') + '</div>';
    }

    // Quick-switch team grid for the gauntlet builder
    var gbGridHtml = '<div class="team-strip" style="margin:0 0 14px">';
    for (var gi = 0; gi < gbTeam.length; gi++) {
      var ge = gbTeam[gi];
      if (ge && ge.mon) {
        gbGridHtml += '<button class="tslot' + (gi === gbConfigIdx ? ' sel' : '') + '" data-gbgi="' + gi + '">' +
          (gi === 0 ? '<span class="ts-lead">LEAD</span>' : '') +
          '<span class="ts-art">' + animSprite(ge.mon.id, 46, 52, '', 1.4, ge.mon.shiny) + '</span>' +
          '<span class="ts-name">' + escapeHtml(ge.name) + '</span>' +
          (ge.mon.item ? '<span class="ts-item" title="' + escapeHtml(itemName(ge.mon.item)) + '">' + (window.ItemArt ? window.ItemArt.itemImg(ge.mon.item, 20) : '') + '</span>' : '') +
          '</button>';
      } else {
        gbGridHtml += '<div class="tslot empty"><span class="dock-ball"></span></div>';
      }
    }
    gbGridHtml += '</div>';

    host.innerHTML =
      gbGridHtml +
      '<div class="party-detail">' +
        '<div class="pd-hero">' +
          '<div class="pd-art">' + bigSprite(mon.id, '', 104, 104, 1, mon.shiny) + '</div>' +
          '<div class="pd-id">' +
            '<div class="pd-species">' + speciesOf(mon) + '</div>' +
            '<div class="pd-name">' + escapeHtml(mon.name) + '</div>' +
            '<div class="types">' + typeChips(mon.types) + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="pd-facts">' +
          '<div class="pd-fact" data-tip="ability:' + mon.ability + '" tabindex="0"><span class="k">Ability</span><span class="v">' + mon.ability + '</span></div>' +
          '<div class="pd-fact"><span class="k">Nature</span><span class="v">' + (mon.nature || 'Serious') + '</span></div>' +
          '<div class="pd-fact"><span class="k">BST</span><span class="v">' + C.bst(mon.id) + '</span></div>' +
        '</div>' +
        '<div class="pd-actions">' +
          '<button class="btn-primary pd-gb-train">Train \u00b7 free</button>' +
          (hasCollectedShiny(mon.id) ? '<button class="btn-secondary wide pd-gb-shiny" data-gb-shiny="1">' + (mon.shiny ? 'Use normal colours' : 'Make shiny') + '</button>' : '') +
        '</div>' +
        '<div class="pd-sec"><div class="pd-label">Moves</div>' +
          '<div class="pd-moves">' + mon.moves.map(function (m) {
            var mv = Dex.moves.get(m);
            var pw = mv.category === 'Status' ? 'Status' : (mv.basePower ? 'Pow ' + mv.basePower : '');
            return '<div class="pd-move" data-tip="move:' + mv.id + '" tabindex="0">' +
              '<div class="pd-move-top"><span class="mv-chip type-' + mv.type + '">' + mv.type + '</span>' +
              '<span class="pd-mv-pw">' + pw + '</span></div>' +
              '<span class="pd-mn">' + mv.name + '</span></div>';
          }).join('') + '</div>' +
        '</div>' +
        heldHtml +
        formeHtml +
      '</div>' +
      '<button type="button" class="btn-secondary wide pd-close">Close</button>';

    // Wire up event handlers
    // Team grid click handlers - quick switch
    host.querySelectorAll('.tslot[data-gbgi]').forEach(function (b) {
      b.addEventListener('click', function () {
        gbConfigIdx = +b.dataset.gbgi;
        drawGbDetail();
      });
    });
    var close = host.querySelector('.pd-close');
    if (close) close.addEventListener('click', function () { window.Modal.close('xTeamDetail'); });

    // Train button
    var trainBtn = host.querySelector('.pd-gb-train');
    if (trainBtn) trainBtn.addEventListener('click', function () {
      gbTraining = true;
      var saveIdx = gbConfigIdx;
      window.Modal.close('xTeamDetail');
      gbConfigIdx = saveIdx;
      openTrainer(mon, true);
    });
    var shinyBtn = host.querySelector('[data-gb-shiny]');
    if (shinyBtn) shinyBtn.addEventListener('click', function () {
      mon.shiny = !mon.shiny;
      toast(mon.shiny ? mon.name + ' is now shiny!' : mon.name + ' is back to normal colours.');
      drawGbDetail(); drawBuilder();
    });

    // Take/change held item
    var takeBtn = host.querySelector('[data-gb-take]');
    if (takeBtn) takeBtn.addEventListener('click', async function () {
      if (window.Forme && window.Forme.setHeldItemAndEnforce) await window.Forme.setHeldItemAndEnforce({ party: [mon] }, mon, '');
      else mon.item = '';
      toast('Removed held item.');
      drawGbDetail(); drawBuilder();
    });

    // Pick held item button
    host.querySelectorAll('[data-gb-held]').forEach(function (b) {
      b.addEventListener('click', function () { openGbHeldPicker(); });
    });

    // Forme change buttons
    host.querySelectorAll('[data-gb-forme]').forEach(function (b) {
      b.addEventListener('click', function () {
        var itemId = b.dataset.gbFormeItem;
        var formeId = b.dataset.gbForme;
        gbFormeChange(itemId, formeId);
      });
    });
  }

  // Held item picker for the gauntlet team builder
  // Gauntlet item picker: one searchable list. Forme-change key items in
  // Forme.CUSTOM are intentionally absent: they are free-use tools, not held items.
  function openGbHeldPicker() {
    var entry = gbTeam[gbConfigIdx];
    if (!entry || !entry.mon) return;
    var mon = entry.mon, host = $('xTeamDetail').querySelector('.overlay-card');
    if (!host) return;
    var items = (C.allHeldItems ? C.allHeldItems() : C.HELD_ITEMS).filter(function (id) {
      return !(window.Forme && window.Forme.CUSTOM && window.Forme.CUSTOM[id]);
    });
    function render() {
      var q = (host.querySelector('.gb-item-search').value || '').toLowerCase().trim();
      var shown = items.filter(function (id) { return itemName(id).toLowerCase().indexOf(q) >= 0; });
      host.querySelector('.gb-item-results').innerHTML = shown.map(function (id) {
        return '<button class="btn-mini' + (mon.item === id ? ' on' : '') + '" data-gb-give="' + id + '" data-tip="item:' + id + '">' +
          (window.ItemArt ? window.ItemArt.itemImg(id, 20) : '') + escapeHtml(itemName(id)) + '</button>';
      }).join('') || '<div class="tb-empty">No held items match.</div>';
      host.querySelectorAll('[data-gb-give]').forEach(function (b) { b.addEventListener('click', async function () {
        var id = b.dataset.gbGive;
        await (window.Forme && window.Forme.setHeldItemAndEnforce ? window.Forme.setHeldItemAndEnforce({ party: [mon] }, mon, id) : (mon.item = id));
        toast(mon.name + ' is now holding ' + itemName(id) + '.'); drawGbDetail(); drawBuilder();
      }); });
    }
    host.innerHTML = '<button class="btn-secondary wide pd-gb-back">← Back to ' + escapeHtml(mon.name) + '</button>' +
      '<div class="pd-label" style="margin:12px 0 8px">Search held items</div>' +
      '<input class="tb-search gb-item-search" type="search" placeholder="Type to filter items…" autocomplete="off">' +
      '<div class="gb-item-results" style="display:flex;flex-wrap:wrap;gap:6px"></div>' +
      (mon.item ? '<button class="btn-secondary wide" style="margin-top:12px" data-gb-clear="1">Remove held item</button>' : '');
    host.querySelector('.pd-gb-back').addEventListener('click', drawGbDetail);
    host.querySelector('.gb-item-search').addEventListener('input', render);
    var clear = host.querySelector('[data-gb-clear]');
    if (clear) clear.addEventListener('click', async function () {
      await window.Forme.setHeldItemAndEnforce({ party: [mon] }, mon, ''); toast('Removed held item.'); drawGbDetail(); drawBuilder();
    });
    render();
  }

  // Forme change for the gauntlet team builder (no item cost)
  async function gbFormeChange(itemId, formeId) {
    var entry = gbTeam[gbConfigIdx];
    if (!entry || !entry.mon) return;
    var mon = entry.mon;
    // Custom forme tools are free; real held forme items must be equipped.
    if (!window.Forme || !(window.Forme.CUSTOM && window.Forme.CUSTOM[itemId]) && (!mon.item || mon.item !== itemId) ||
        !window.Forme.targetsFor(mon, itemId).some(function (t) { return t.id === formeId; })) {
      toast('This forme cannot be used by this Pokemon.');
      return;
    }
    // Apply the forme change without consuming an item
    var sp = Dex.species.get(formeId);
    if (!sp.exists) return;
    var fromName = mon.species || C.cleanName(mon.id);
    mon.id = sp.id;
    mon.species = sp.name;
    mon.types = sp.types.slice();
    // Adjust ability if needed
    var legalAb = [];
    for (var k in sp.abilities) if (sp.abilities[k]) legalAb.push(sp.abilities[k]);
    if (legalAb.indexOf(mon.ability) < 0) mon.ability = legalAb[0] || mon.ability;
    // Keep legal moves, fill with auto if needed
    var legal = await C.legalMoves(sp.id, { all: true });
    var kept = mon.moves.filter(function (m) { return legal.indexOf(m) >= 0; });
    var newPP = {};
    kept.forEach(function (m) { newPP[m] = mon.pp[m] != null ? mon.pp[m] : Math.floor(Dex.moves.get(m).pp * 1.6); });
    if (kept.length < 4) {
      var auto = await C.autoMoveset(sp.id);
      for (var i = 0; i < auto.length && kept.length < 4; i++) {
        if (kept.indexOf(auto[i]) >= 0) continue;
        kept.push(auto[i]);
        newPP[auto[i]] = Math.floor(Dex.moves.get(auto[i]).pp * 1.6);
      }
    }
    mon.moves = kept;
    mon.pp = newPP;
    // Update the team entry metadata
    entry.name = sp.name;
    entry.id = sp.id;
    entry.types = sp.types.slice();
    entry.bst = C.bst(sp.id);
    toast(fromName + ' changed to ' + sp.name + '!');
    try { playCry(sp.id); } catch (e) {}
    drawGbDetail();
    drawBuilder();
  }

  // Draft done -> create the run. Mon objects are already built and configured
  // by the player during the team builder phase.
  var gbStarting = false;
  async function confirmGauntlet() {
    if (gbStarting || gbTeam.length !== GB_MAX) return;
    gbStarting = true;
    var startBtn = $('btnTbStart');
    startBtn.disabled = true;
    $('tbStartLabel').textContent = 'Preparing your team\u2026';
    try {
      run = N.newRun(Math.floor(Math.random() * 1e9));
      run.mode = 'gauntlet';
      run.dailyDate = null;
      run.dailyNumber = 0;
      run.maxSections = 0;          // endless trainer rush
      run.sectionMarks = [];
      run.trainingPaidThisRound = false;
      run.money = 0;                // no cash in the Gauntlet -- ever
      for (var i = 0; i < gbTeam.length; i++) {
        var mon = gbTeam[i].mon;
        if (!mon) {
          // Fallback: create the mon if it somehow wasn't built
          mon = N.trainPlayerMon(await C.makeMon(gbTeam[i].id));
          mon.species = C.cleanName(mon.id);
        }
        run.party.push(mon);
        N.trackMon(run, mon);
        run.seenSpecies[mon.id] = 1;
      }
      N.logMsg(run, 'You set out with a hand-picked team of six.');
      saveGame();
      gbTeam = [];
      renderCrossroads();
      show('Crossroads');
      toast('Gauntlet started \u2014 Trainer 1 awaits!');
    } catch (e) {
      console.error('[gauntlet] draft failed', e);
      toast('Something went wrong building the team. Try again.');
      drawBuilder();
    } finally {
      gbStarting = false;
    }
  }

  // --------------------------------------------------------- CROSSROADS ---
  function renderCrossroads() {
    // If the app was closed mid-battle, the synced HP/status is preserved in
    // run.party but the battle is lost. Clear the flag so the user can continue.
    if (run._inBattle) { run._inBattle = false; saveGame(); }
    // Warm Showdown ani GIFs for the whole party (and the lead's back sprite)
    // while the player is still on the route — battle then paints instantly.
    try { prefetchParty(run.party); } catch (e) {}
    renderHud();
    // Tutorial mode: dim shop and bag, hide extra complexity -- SECTION 1
    // ONLY. Section 2 is where the guided run teaches the Mart, so its shop
    // and bag must be fully interactive while the run is still a prologue.
    var cr = $('screenCrossroads');
    if (cr) cr.classList.toggle('prologue-dim', !!(run && run.prologue && run.section === 1));
    var isG = N.isGauntlet(run);
    var trainerNext = N.nextIsTrainer(run);   // always true in a Gauntlet
    var gTrainer = isG ? N.trainerFor(run) : null;
    var n = run.battleInSection;
    var routeNames = ['Verdant Trail', 'Sunlit Pass', 'Amber Hollow', 'Moonlit Ridge',
                      'Windward Steps', 'Quiet Glade', 'Ashen Flats', 'Silver Causeway'];
    $('xSection').textContent = isG
      ? gTrainer.name
      : routeNames[C.hashString(run.seed + '|route|' + run.section) % routeNames.length];
    var eyebrow = $('xEyebrow');
    if (eyebrow) {
      // A finite Daily says how much is left; Free Play just counts up.
      eyebrow.textContent = run.maxSections
        ? 'Daily \u00b7 Section ' + run.section + ' of ' + run.maxSections
        : (isG ? 'Gauntlet \u00b7 Trainer ' + run.section : 'Section ' + run.section);
    }
    // One quiet line of progress instead of a stepper graphic.
    var stageNames = ['Capture', 'Wild', 'Wild', 'Trainer'];
    $('xProgress').textContent = isG
      ? run.trainersBeaten + ' beaten \u00b7 survivors heal after every win'
      : 'Stop ' + Math.min(n + 1, 4) + ' of 4  \u00b7  ' + stageNames[Math.min(n, 3)];
    renderAscension(trainerNext);

    var isCapture = !trainerNext && n === 0;
    var isStrongCapture = isCapture && run.section === 6;
    var catchOpen = isCapture && !run.catchUsedThisSection;
    $('xNextLabel').innerHTML = trainerNext ? 'Trainer Battle'
      : (isCapture ? 'Capture Encounter' : 'Wild Battle ' + n);
    var bc = $('btnGoBattle');
    if (bc) bc.classList.toggle('catchable', catchOpen);
    var bi = $('xBattleIcon');
    if (bi) {
      var art;
      if (isCapture) art = window.ItemArt ? window.ItemArt.itemImg('pokeball', 32, 'route-ball') : '';
      else if (trainerNext) {
        var trainerArt = gTrainer || N.trainerFor(run);
        art = '<img src="https://play.pokemonshowdown.com/sprites/trainers/' + trainerArt.sprite + '.png" alt="' + trainerArt.cls + '" onerror="this.style.display=\'none\'">';
        bi.className = 'x-ic x-art trainer-art';
      } else {
        var wildKey = run.section + ':' + run.battleInSection;
        if (!run._nextWild || run._nextWild.key !== wildKey) run._nextWild = { key:wildKey, id:N.pickWild(run, { dupesClause:n === 0 }) };
        try { prefetchSpecies(run._nextWild.id); } catch (e) {}
        art = animSprite(run._nextWild.id, 48, 48, 'route-wild', 1, false);
        bi.className = 'x-ic x-art wild-art';
      }
      if (isCapture) bi.className = 'x-ic x-art ball-art';
      bi.innerHTML = art;
    }
    // ONE line of context, not a stack of them.
    var desc = $('xNextDesc');
    desc.classList.remove('ok', 'bad');
    if (catchOpen) {
      desc.textContent = isStrongCapture
        ? 'A powerful catch awaits in Section 6 \u2014 weaken it, then use your best ball.'
        : 'Your only catch of Section ' + run.section + ' \u2014 weaken it, then throw a ball.';
      desc.classList.add('ok');
    } else if (trainerNext && isG) {
      desc.textContent = 'No items, no running \u2014 win and your survivors are fully restored.';
    } else if (trainerNext) {
      desc.textContent = 'A trainer with a full team and smarter tactics.';
    } else if (run.catchMissed) {
      desc.textContent = 'Catch missed \u2014 no new Pokemon this section.';
      desc.classList.add('bad');
    } else if (run.catchUsedThisSection && run.lastCaughtName) {
      desc.textContent = 'Caught ' + run.lastCaughtName + ' this section.';
    } else {
      desc.textContent = 'A wild Pokemon blocks the path.';
    }

    drawTeamStrip();
    drawPartyDetail();

    // The Gauntlet has no economy at all: no cash, no bag, no Mart. The team
    // strip and the trainer preview are the whole route screen.
    var cashPill = $('xCashPill'), bagBlock = $('xBagBlock'), shopBlock = $('xShopBlock');
    if (cashPill) cashPill.hidden = isG;
    if (bagBlock) bagBlock.hidden = isG;
    if (shopBlock) shopBlock.hidden = isG;
    if (!isG) {
      drawOwned();
      // the shop lives on this screen now
      openMart();
    }
    routeCoach(trainerNext, isG);
  }

  // ---- route-screen teaching ----------------------------------------------
  // Fires at most ONE lesson per visit, chosen by what the route is asking the
  // player to do right now. The coach module itself refuses to chain, but
  // choosing here as well keeps the ordering deliberate rather than
  // whichever-check-ran-first.
  //
  // During the guided run the route screen only teaches its two scripted
  // beats -- the shape of a section, and the pre-boss heal warning -- and
  // they are `vital` so a race with another card can never swallow them. The
  // rest of the syllabus waits for the tutorial to be over, so it does not
  // pile onto the scripted beats.
  function routeCoach(trainerNext, isG) {
    var CO = window.Coach;
    if (!run || !run.prologue || !CO || !CO.tipsOn() || isG) return;
    // Request on a SHORT beat, not immediately: renderCrossroads() is always
    // followed synchronously by show('Crossroads'), so the screen is still
    // hidden at render time -- and a beat requested into a hidden screen
    // drops (stillValid), losing the lesson exactly once before. The old
    // 420ms timer hid that by racing the navigation instead of modelling it.
    // `stillValid` + the coach's vital queue are the correct patience model:
    // a beat whose screen was left drops and is re-requested at the next
    // render, and a beat raced by another card waits instead of dying.
    setTimeout(requestRouteLesson, 0);
    function requestRouteLesson() {
      // A queued callback can outlive the tutorial flag (for example when
      // graduation happens before the next frame). Never let it fall through
      // to the old contextual lesson path after the run becomes ordinary.
      if ($('screenCrossroads').hidden || !run || !run.prologue) return;
      var n = run.battleInSection;
      var pro = run && run.prologue;
      var onRoute = function () { return !$('screenCrossroads').hidden; };

      // 1. How a section is shaped. The very first thing after the starter.
      // This is a run action, not profile knowledge: bypass old profile lesson
      // history so a resumed guided run can never skip its next button.
      if (pro && run.section === 1 && run.battleInSection === 0 && !run.tutorialRouteDone) {
        CO.lesson('route', {
          anchor: $('btnGoBattle'), actionRequired: true, keepHalo: true,
          bypassSeen: true, vital: true, stillValid: onRoute,
          onShow: function () { if (!CO.seen('route')) CO.markSeen('route'); }
        });
        return;
      }

      // Veteran / non-prologue runs still get the ordinary route explainer.
      // It is informational, so it does not lock the route to one scripted
      // button like the guided run does.
      if (!pro && !CO.seen('route')) {
        CO.lesson('route', { anchor: $('xProgress'), stillValid: onRoute });
        return;
      }

      // 1b. After the capture (before battle 2 of section 1): heal the new
      //     partner. It joins the team at catch HP, and learning to open a
      //     team card and use a Full Restore is the most-used skill in the game.
      //     The next battle button stays locked until the Full Restore is used, so
      //     the path stays linear: catch -> heal -> battle 2.
      if (pro && run.section === 1 && run.battleInSection === 1 && !tutorialHealed()) {
        var caughtMonH = caughtMonInParty();
        var caughtSlotH = caughtMonH && caughtMonH.hpPct < 1 ? teamSlotFor(caughtMonH) : null;
        if (caughtMonH && caughtSlotH) {
          CO.lesson('healOpen', {
            anchor: caughtSlotH, actionRequired: true, keepHalo: true,
            bypassSeen: true, vital: true,
            stillValid: function () {
              return onRoute() && run.section === 1 && run.battleInSection === 1 &&
                !tutorialHealed();
            },
            template: { NAME: monDisplayName(caughtMonH) },
            onShow: function () { if (!CO.seen('healOpen')) CO.markSeen('healOpen'); }
          });
          return;
        }
        // The new partner arrived at full HP (or there is nothing to heal):
        // there is no Full Restore to press. Fall through to the onward beat below
        // instead of stranding the player on the route with no next action.
      }

      // 1b2. Healed. The route now has exactly one next action: press the
      //      battle button for stop 2. This is its own beat, not part of the
      //      heal card, so the player is never left looking at a route with
      //      nothing glowing after the Full Restore (or after a full-HP catch).
      if (pro && run.section === 1 && run.battleInSection === 1 && tutorialHealed()) {
        CO.lesson('onward', {
          anchor: $('btnGoBattle'), actionRequired: true, keepHalo: true,
          bypassSeen: true, vital: true,
          stillValid: function () {
            return onRoute() && run.section === 1 && run.battleInSection === 1 &&
              tutorialHealed();
          },
          onShow: function () { if (!CO.seen('onward')) CO.markSeen('onward'); }
        });
        return;
      }

      // 1c. After the capture (before battle 2 of section 1): teach the
      //     player to make the new Pokemon their lead. It lands here, after
      //     the super-effective battle, so battle 2 pairs a fresh lead with
      //     the switch lesson that comes with it. The first card is the only
      //     target; once it is opened, tutorialPartyDetailCoach points at the
      //     single Make lead button.
      if (pro && run.section === 1 && run.battleInSection === 2 && !caughtIsLead()) {
        var caughtMon = caughtMonInParty();
        var caughtSlot = teamSlotFor(caughtMon);
        if (caughtMon && caughtSlot) {
          CO.lesson('makeLead', {
            anchor: caughtSlot, actionRequired: true, keepHalo: true,
            bypassSeen: true, vital: true,
            stillValid: function () {
              return onRoute() && run.section === 1 && run.battleInSection === 2 &&
                !!caughtMonInParty() && !caughtIsLead();
            },
            template: { NAME: monDisplayName(caughtMon) },
            onShow: function () { if (!CO.seen('makeLead')) CO.markSeen('makeLead'); }
          });
        }
        return;
      }

      // 2. Before the boss: the route gives one explicit next action. The
      // first guided trainer uses legal low-power moves and cannot knock out
      // the learner during the tutorial, so there is no hidden preparation
      // choice to make here.
      if (pro && trainerNext && !run.tutorialTrainerDone) {
        CO.lesson('trainer', {
          anchor: $('btnGoBattle'), actionRequired: true, keepHalo: true,
          bypassSeen: true, vital: true, stillValid: onRoute,
          onShow: function () { if (!CO.seen('trainer')) CO.markSeen('trainer'); }
        });
        return;
      }

      // Everything below is contextual teaching for AFTER the tutorial: it
      // re-fires on every visit until read, so it needs no queue, and it
      // must not pile onto the guided run's scripted beats.
      if (pro) return;

      // 3. The two middle battles are the budget. Said once, on stop 2.
      if (!trainerNext && n === 1 && !CO.seen('skipping')) {
        CO.lesson('skipping', { anchor: $('xNextDesc') }); return;
      }

      // 4. The Mart, once there is actually money to spend.
      if (run.money >= 600 && !CO.seen('mart')) {
        CO.lesson('mart', { anchor: $('xShopBlock') }); return;
      }

      // 5. Training, once it is affordable. Section 2+ so it does not land on
      //    top of the first section's own lessons.
      if (run.section >= 2 && run.money >= SERVICE_PRICE && !CO.seen('train')) {
        CO.lesson('train', { anchor: $('xTeam') }); return;
      }

      // 6. Held items, once one is affordable and somebody could use it.
      if (run.section >= 2 && !CO.seen('held') && martHasAffordableHeld()) {
        CO.lesson('held', { anchor: $('xShopBlock') }); return;
      }
    }
  }

  function martHasAffordableHeld() {
    if (!martStock) return false;
    return martStock.some(function (e) {
      return e.kind === 'held' && e.price <= run.money &&
        window.Coach && window.Coach.bestHolderFor(e.id, run.party);
    });
  }

  // ---- guided-run identity helpers -----------------------------------------
  // The tutorial tracks the starter and the first catch by uid so the forced
  // evolution / training / make-lead steps can find them after renames,
  // evolutions and party reordering.
  function tutorialSection1() {
    return !!(run && run.prologue && run.section === 1);
  }

  // The tutorial sheet uses a progress bar, not a step number. Several ideas
  // intentionally take two or more cards (open a card, then press its control),
  // while a full-HP catch can satisfy healing without a Full Restore. A card counter
  // therefore lies; these are the stable conceptual milestones instead.
  function tutorialHealed() {
    if (run && run.tutorialHealDone) return true;
    var caught = caughtMonInParty();
    return !caught || caught.hpPct >= 1;
  }
  function tutorialProgress() {
    if (!run || !run.prologue) return null;
    var CO = window.Coach;
    var milestones = [
      !!(CO && (CO.seen('welcome') || run.tutorialStarterShown)),
      !!run.tutorialStarterShown,
      !!run.tutorialRouteDone,
      !!run.tutorialDamageDone,
      !!run.tutorialCatchDone,
      tutorialHealed(),
      !!run.tutorialOnwardDone,
      !!run.tutorialEffectDone,
      caughtIsLead(),
      !!run.tutorialSwitchDone,
      !!run.tutorialBattleBagDone,
      !!run.tutorialTrainerDone,
      !!(CO && CO.seen('save')),
      !!run.tutorialEvolved,
      !!run.tutorialTrained
    ];
    var done = milestones.filter(function (v) { return v; }).length;
    return { done: done, total: milestones.length, percent: Math.round(done / milestones.length * 100) };
  }

  function starterMon() {
    if (!run || !run.party) return null;
    if (!run.tutorialStarterUid) return run.party[0] || null;
    for (var i = 0; i < run.party.length; i++) {
      if (String(run.party[i].uid) === String(run.tutorialStarterUid)) return run.party[i];
    }
    return null;
  }
  function caughtMonInParty() {
    if (!run || !run.party || !run._tutCatchUid) return null;
    for (var i = 0; i < run.party.length; i++) {
      if (String(run.party[i].uid) === String(run._tutCatchUid)) return run.party[i];
    }
    return null;
  }
  function caughtIsLead() {
    var c = caughtMonInParty();
    return !!c && run.party[0] === c;
  }

  function trainingMon() {
    if (!run || !run.party) return null;
    if (run.tutorialTrainingUid != null) {
      for (var i = 0; i < run.party.length; i++) {
        if (String(run.party[i].uid) === String(run.tutorialTrainingUid)) return run.party[i];
      }
    }
    return starterMon() || caughtMonInParty() || run.party[0] || null;
  }

  function teamSlotFor(mon) {
    if (!mon || !run || !run.party) return null;
    var i = run.party.indexOf(mon);
    if (i < 0) return null;
    return document.querySelector('#xTeam .tslot[data-i="' + i + '"]');
  }

  function scrollTeamSlotIntoView(mon) {
    var slot = teamSlotFor(mon);
    if (!slot) return null;
    try { slot.scrollIntoView({ block: 'center', inline: 'nearest' }); }
    catch (e) { try { slot.scrollIntoView(); } catch (_) {} }
    return slot;
  }

  // ---- ASCENSION BANNER ----------------------------------------------------
  // Everything ascension does is shown BEFORE the fight. A difficulty system
  // the player can't see is just unfairness, so the tier, the field effect,
  // the boss clause and the trainer's intent are all previewed here.
  function renderAscension(trainerNext) {
    var host = $('xAscension');
    if (!host) return;
    var eff = N.ascensionEffects(run);
    var parts = [];

    if (eff.tier > 0) {
      var bits = [];
      if (eff.field) bits.push('field effects');
      if (eff.elite) bits.push('elite Pokemon');
      if (eff.healPct < 1) bits.push(Math.round(eff.healPct * 100) + '% section healing');
      if (eff.aiDepth >= 2) bits.push('sharper AI');
      parts.push('<div class="asc-tier"><b>Ascension ' + eff.tier + '</b>' +
        (bits.length ? '<span>' + bits.join(' \u00b7 ') + '</span>' : '') + '</div>');
    }

    // What is already on the field when the fight begins.
    var field = N.fieldEffectFor(run, trainerNext);
    if (field) {
      parts.push('<div class="asc-row asc-field"><span class="asc-k">Field</span>' +
        '<span class="asc-v">' + escapeHtml(field.label) + '</span>' +
        '<span class="asc-n">' + escapeHtml(field.note) + '</span></div>');
    }

    // Trainer intent preview: at higher ascension you get to see the plan.
    if (trainerNext) {
      var t = N.trainerFor(run);
      if (t.clause) {
        parts.push('<div class="asc-row asc-clause"><span class="asc-k">Clause</span>' +
          '<span class="asc-v">' + escapeHtml(t.clause.label) + '</span>' +
          '<span class="asc-n">' + escapeHtml(t.clause.note) + '</span></div>');
      }
      if (eff.tier >= 1 && t.strategy) {
        parts.push('<div class="asc-row asc-strategy"><span class="asc-k">Intent</span>' +
          '<span class="asc-v">' + escapeHtml(t.strategy.label) + '</span>' +
          '<span class="asc-n">' + escapeHtml(strategyHint(t.strategy.id)) + '</span></div>');
      }
    }

    host.innerHTML = parts.join('');
    host.hidden = !parts.length;
  }

  function strategyHint(id) {
    return {
      balanced:  'A mixed team with no single plan.',
      offense:   'Fast, fragile, and hits extremely hard.',
      stall:     'Bulky Pokemon that heal and wear you down.',
      weather:   'Sets weather and builds the team around it.',
      hazards:   'Lays hazards and forces you to switch into them.',
      trickroom: 'Slow, heavy hitters that want the speed order reversed.'
    }[id] || '';
  }

  // A short banner across the battle screen when the catch window opens.
  function showCatchBanner(text) {
    var host = $('battleHost');
    if (!host) return;
    var el = document.createElement('div');
    el.className = 'catch-banner' + (/SHINY/.test(text) ? ' shiny' : '');
    el.textContent = text;
    host.appendChild(el);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 3400);
  }

  function renderHud() {
    var el;
    if ((el = $('xCash'))) el.textContent = run.money.toLocaleString();
  }

  // --------------------------------------------------------------- MART ---
  var martStock = null;
  function openMart() {
    if (!martStock) martStock = N.rollMart(run);
    // Forme / Mega stock is party-dependent: a catch or a faint changes it, so
    // refresh those groups rather than freezing them into the cached stock.
    martStock = martStock.filter(function (e) { return e.kind !== 'forme'; });
    if (window.Forme) {
      var seenF = {};
      window.Forme.relevantItems(run).forEach(function (f) {
        if (seenF[f.id]) return; seenF[f.id] = 1;
        var formeOwner = run.party.filter(function (m) { return m.name === f.forSpecies; })[0];
        martStock.push({ kind: 'forme', id: f.id, name: f.name, price: f.price,
                         desc: f.desc, stock: 99, hot: true, unique: true,
                         forSpecies: f.forSpecies, forId: formeOwner && formeOwner.id });
      });
    }
    drawMart();
    shopCoach();
  }

  // ---- the section-2 tutorial (guided run) -------------------------------
  // Evolution and held items are battle rewards now, not shop stock. The
  // tutorial therefore uses the Rare Candy awarded at the end of section 1,
  // then walks the player through using it and training the starter.
  // Only when both have actually happened does the tutorial conclude.
  function shopCoach() {
    var CO = window.Coach;
    if (!CO || !CO.tipsOn() || !CO.inPrologue() || !run || !run.prologue || run.section !== 2) return;
    // Same short beat as routeCoach: the crossroads is still hidden at render
    // time (show() runs right after), and beats requested into a hidden
    // screen drop. `vital` beats queue, and re-request on the next visit.
    setTimeout(function () {
      var onRoute = function () {
        return !$('screenCrossroads').hidden && run && run.prologue && run.section === 2;
      };
      var starter = starterMon();
      var evolved = !!run.tutorialEvolved || !starter;

      if (!evolved) {
        // A tutorial save from before battle rewards were introduced may reach
        // section 2 without its Rare Candy. Repair that one incomplete
        // tutorial state with the same item a section-1 reward supplies; it is
        // never added to the shop.
        if (!run.bag.rarecandy) {
          N.addItem(run, 'rarecandy', 1);
          N.logMsg(run, 'Tutorial reward: you received a Rare Candy.');
          saveGame();
        }

        // Point at the starter's one team card instead of making the player
        // infer the next step from the reward they selected.
        var starterSlot = scrollTeamSlotIntoView(starter);
        if (starterSlot) {
          // The player received the evolution item as a battle reward. Move
          // the viewport back to the team grid and use a compact tooltip on
          // the exact Pokemon that can evolve, instead of opening another
          // full sheet over the shop they just used.
          CO.lesson('evoOpen', {
            surface: 'bubble',
            resolve: function () { return teamSlotFor(starterMon()); },
            anchor: starterSlot, actionRequired: true, keepHalo: true,
            bypassSeen: true, vital: true, stillValid: onRoute,
            template: { NAME: monDisplayName(starter) },
            onShow: function () { if (!CO.seen('evoOpen')) CO.markSeen('evoOpen'); }
          });
        }
        return;
      }

      if (!run.tutorialTrained) {
        // Keep the invitation armed until the guided session has actually
        // happened. Training is always performed on the starter so the
        // scripted Stat Point move has a known point to move out of HP.
        if (!tutorGuideActive()) {
          var target = trainingMon() || starter || run.party[0];
          if (target) run.tutorialTrainingUid = target.uid;
          var targetSlot = teamSlotFor(target);
          if (targetSlot) {
            CO.lesson('trainOpen', {
              anchor: targetSlot, actionRequired: true, keepHalo: true,
              bypassSeen: true, vital: true, stillValid: onRoute,
              template: { NAME: monDisplayName(target) },
              onShow: function () { if (!CO.seen('trainOpen')) CO.markSeen('trainOpen'); }
            });
          }
        }
        return;
      }

      // Evolution AND training are done: the tutorial concludes right here,
      // in section 2. Nothing in section 3+ re-explains anything.
      concludeTutorial();
    }, 0);
  }

  // The guided first run is over: the safety net and scripted beats stop, and
  // the run continues as an ordinary one with normal randomness. Both flags
  // go together -- the coach module's governs lesson logic, the run's
  // governs encounter generation, and splitting them is how the tutorial
  // used to die halfway through.
  function concludeTutorial(opts) {
    opts = opts || {};
    var was = (window.Coach && window.Coach.inPrologue()) || (run && run.prologue);
    if (!was) return;
    // The tutorial covered everything already (battles, catching, the lead,
    // saving, the Mart, evolution, training). The just-in-time lessons that
    // would otherwise start firing later are repetition for this player, so
    // mark them read and let the run continue quietly. In-battle Bag use was
    // already taught immediately after the required switch in section 1.
    var CO = window.Coach;
    if (CO) {
      ['skipping', 'mart', 'train', 'held', 'moveChoice', 'evoBranch', 'battleBag'].forEach(function (id) {
        if (!CO.seen(id)) CO.markSeen(id);
      });
    }
    if (CO && CO.inPrologue()) CO.setPrologue(false);
    if (run && run.prologue) { run.prologue = false; saveGame(); }
    // The bookend: Professor Oak says goodbye and points at the Guide. A
    // sheet, not a toast, so the tutorial ends the way it began — with the
    // professor talking to the player.
    if (!opts.silent) {
      if (CO && CO.tipsOn()) {
        CO.lesson('graduate', {
          vital: true,
          stillValid: function () { return !!(run && !run.prologue); }
        });
      } else {
        toast('Tutorial complete \u2014 the rest of the run is all yours.');
      }
    }
  }

  // "Skip tips" anywhere during the guided run means the player is opting
  // out of the tutorial itself, not just out of future cards. The coach has
  // its own toast for that ("Tips off..."), so this just ends the prologue.
  function onCoachSkip() {
    if ((window.Coach && window.Coach.inPrologue()) || (run && run.prologue)) {
      concludeTutorial({ silent: true });
    }
  }
  function drawMart() {
    var grid = $('martGrid');
    grid.innerHTML = '';
    var isPro = run && run.prologue;
    // One "Supplies" shelf holds the two staples SIDE BY SIDE: the section's
    // ball tier and Full Restore. Separate "Poke Balls" / "Medicine" headings
    // stacked them into two full-width rows; with exactly one of each in
    // stock, a single 2-column grid puts both tiles on one row. Later
    // sections add the dedicated Forme Change and Mega Stone shelves;
    // held/evolution items are chosen after victories.
    var groups = (isPro && run.section === 1)
      ? { basic: 'Supplies' }
      : { basic: 'Supplies', forme: 'Forme Change', mega: 'Mega Stones', service: 'Services' };
    Object.keys(groups).forEach(function (k) {
      var items = martStock.filter(function (e) {
        if (k === 'basic' ? (e.kind !== 'ball' && e.kind !== 'heal') : e.kind !== k) return false;
        if (e.unique && N.ownsItem(run, e.id)) return false;
        return true;
      });
      if (!items.length) return;
      var h = document.createElement('h3');
      h.className = 'sub-title'; h.textContent = groups[k];
      grid.appendChild(h);
      var wrap = document.createElement('div');
      // Forme and Mega shelves render as a horizontal carousel so the compact
      // tiles sit side by side and scroll if there are more than the screen
      // can fit. Ordinary groups keep the 2-column grid.
      wrap.className = 'shop-grid' + (k === 'forme' || k === 'mega' ? ' forme-carousel' : '');
      items.forEach(function (e) {
        // Unique stock (Mega Stones): if you already own one, don't offer it
        // again. Selling it removes it from the bag, so it comes straight back.
        if (e.unique && N.ownsItem(run, e.id)) return;
        var sold = e.stock <= 0;
        // Can't afford it -> dim it, same as sold out. The price stays legible
        // so it still reads as a goal rather than a broken tile.
        var broke = !sold && run.money < e.price;
        var d = document.createElement('div');
        if (e.kind !== 'service' && e.kind !== 'forme' && e.kind !== 'mega') {
          d.setAttribute('data-tip', 'item:' + e.id);
        }
        d.className = 'shop-item' + (sold ? ' sold' : '') + (broke ? ' broke' : '') + (e.kind === 'service' ? ' service' : '') + (e.hot ? ' hot' : '') + (e.kind === 'mega' ? ' mega-item' : '') + (e.kind === 'forme' ? ' forme-item' : '');
        var transformHtml = (e.kind === 'forme' || e.kind === 'mega')
          ? transformShopTileHtml(e) : '';
        var artHtml = (window.ItemArt && e.kind !== 'service' && !transformHtml)
          ? window.ItemArt.itemImg(e.id, 34, 'si-art') : '';
        // The canon name stays; the gold line underneath is what the item
        // ACTUALLY does. legacy status-only medicines are not stocked on new runs --
        // everyone reads it as "restores everything", and it restores no HP.
        var plainHtml = itemPlainHtml(e.id, 'si-plain');
        // ✦Tip: a recommendation, not a lesson. Only for a held item that
        // genuinely suits someone in the party, and only when affordable --
        // a badge on everything is a badge on nothing.
        var tipHtml = '';
        if (window.Coach && e.kind === 'held' && !sold && !broke) {
          var holder = window.Coach.bestHolderFor(e.id, run.party);
          if (holder) {
            tipHtml = window.Coach.tipBadge('Good fit for ' + holder.name + '. ' +
              (window.Coach.heldPlain(e.id) || ''));
          }
        }
        d.innerHTML = transformHtml || tipHtml +
          '<div class="si-top">' + artHtml + '<span class="si-name">' + e.name + '</span>' +
          '<span class="si-price' + (e.sale ? ' sale' : '') + '">' + (sold ? 'SOLD' : '$' + e.price) + '</span></div>' +
          '<div class="si-desc">' + plainHtml + (e.kind === 'forme' || e.kind === 'mega' ? formeBenefitHtml(e) : '') + '</div>' +
          (e.kind === 'evo' ? '<div class="si-tag evo">evolution</div>' : '') +
          (e.kind === 'mega' ? '<div class="si-tag mega">mega stone</div>' : '') +
          (e.kind === 'forme' ? '<div class="si-tag forme">forme change</div>' : '') +
          (e.hot && e.kind !== 'evo'
              ? '<div class="si-hot">\u2726 your party can use this</div>' : '') +
          (run.bag[e.id] ? '<div class="si-own">owned: ' + run.bag[e.id] + '</div>' : '');
        // A Mart tile is an inspector first and a purchase target second. This
        // keeps a thumb tap from spending money before the player has read the
        // item's complete effect. Sold-out and unaffordable tiles still open
        // the sheet so the reason is visible there too.
        d.setAttribute('role', 'button');
        d.setAttribute('tabindex', '0');
        d.setAttribute('aria-label', e.name + (sold ? ', sold out' : ', open details'));
        d.addEventListener('click', function () { openShopItemPopup(e); });
        d.addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault(); openShopItemPopup(e);
          }
        });
        wrap.appendChild(d);
      });
      grid.appendChild(wrap);
    });

    var bonus = N.shopBonusStatus ? N.shopBonusStatus(run) : {
      bought: Number(run.shopBallPurchases) || 0,
      target: 10, awarded: !!run.shopPremierAwarded
    };
    var bonusEl = $('martBallBonus');
    if (bonusEl) {
      var remaining = Math.max(0, bonus.target - bonus.bought);
      bonusEl.textContent = bonus.awarded
        ? 'Premier Ball earned at this shop.'
        : 'Buy ' + remaining + ' more ball' + (remaining === 1 ? '' : 's') +
          ' here to earn a Premier Ball.';
      bonusEl.classList.toggle('earned', bonus.awarded);
    }
  }
  function itemName(id) {
    if (window.Evo && window.Evo.CUSTOM_ITEMS[id]) return window.Evo.CUSTOM_ITEMS[id].name;
    if (window.Forme && window.Forme.isFormeItem(id)) return window.Forme.itemName(id);
    if (window.Mega && window.Mega.isMegaStone(id)) return Dex.items.get(id).name;
    return (C.BALLS[id] && C.BALLS[id].name) || (C.HEAL_ITEMS[id] && C.HEAL_ITEMS[id].name) ||
           (Dex.items.get(id).exists ? Dex.items.get(id).name : id);
  }
  function basePrice(id) {
    if (window.Evo && window.Evo.CUSTOM_ITEMS[id]) return window.Evo.CUSTOM_ITEMS[id].price;
    if (window.Forme && window.Forme.isFormeItem(id)) return window.Forme.itemPrice(id);
    if (window.Mega && window.Mega.isMegaStone(id)) return window.Mega.price(id);
    if (C.BALLS[id]) return C.BALLS[id].price;
    if (C.HEAL_ITEMS[id]) return C.HEAL_ITEMS[id].price;
    return C.heldPrice(id);
  }

  // The compact tile uses a short coach line, but the item sheet must never
  // truncate the actual effect. Prefer the stock's description (it is also
  // where party-specific Mega/Forme wording lives), then fall back through
  // each catalog's full description and finally Showdown's item Dex.
  function fullItemDescription(id, fallback) {
    if (fallback) return String(fallback);
    if (C.BALLS[id]) return C.BALLS[id].desc || '';
    if (C.HEAL_ITEMS[id]) return C.HEAL_ITEMS[id].desc || '';
    if (window.Evo && window.Evo.CUSTOM_ITEMS[id]) return window.Evo.CUSTOM_ITEMS[id].desc || '';
    if (window.Forme && window.Forme.isFormeItem(id)) return window.Forme.itemDesc(id) || '';
    if (window.Mega && window.Mega.isMegaStone(id)) return window.Mega.desc(id) || '';
    var item = Dex.items.get(id);
    return item.exists ? (item.desc || item.shortDesc || '') : '';
  }

  function sellValue(id) {
    var price = Number(basePrice(id));
    return Math.max(1, isFinite(price) ? Math.floor(price / 2) : 1);
  }

  function itemKindLabel(kind) {
    return {
      ball: 'Ball', heal: 'Medicine', held: 'Held item', evo: 'Evolution item',
      forme: 'Forme change', mega: 'Mega Stone', service: 'Service'
    }[kind] || 'Item';
  }

  // One sheet serves both sides of the Mart interaction. `source` is either
  // `shop` (buy-only: the [-] qty [+] stepper plus the confirm button) or
  // `owned` (the Bag side: Use for a Full Restore, Sell for anything, and
  // "Take item" for a copy a Pokemon is holding). Keeping the source in one
  // small object avoids two nearly-identical dialogs drifting apart.
  var shopItemPopup = null;

  // The largest quantity the current shop entry allows: never more than the
  // shelf holds, never more than the player can pay for, and always exactly 1
  // for `unique` stock (Mega Stones / Forme items are gated by ownership).
  function shopQtyMax(entry) {
    if (!entry) return 1;
    var stock = entry.unique ? 1 : Math.max(0, Math.floor(Number(entry.stock) || 0));
    var affordable = entry.price > 0
      ? Math.floor((Number(run.money) || 0) / entry.price) : stock;
    return Math.max(1, Math.min(stock, affordable));
  }
  function shopQtyClamp(v, max) {
    var n = Math.floor(Number(v));
    if (!isFinite(n) || n < 1) n = 1;
    return Math.max(1, Math.min(n, max));
  }

  function openShopItemPopup(entry) {
    if (!entry || !run) return;
    shopItemPopup = { source: 'shop', entry: entry, qty: 1 };
    drawShopItemPopup();
    var buy = $('btnShopItemBuy');
    window.Modal.open('screenShopItem', {
      initialFocus: buy && !buy.disabled ? buy : $('btnShopItemClose'),
      onClose: function () { shopItemPopup = null; }
    });
  }

  function openOwnedItemPopup(id, holder) {
    if (!run || !id) return;
    shopItemPopup = { source: 'owned', id: id, holder: holder || null };
    drawShopItemPopup();
    var sell = $('btnShopItemSell'), use = $('btnShopItemUse');
    window.Modal.open('screenShopItem', {
      initialFocus: sell && !sell.hidden && !sell.disabled ? sell
        : (use && !use.hidden ? use : $('btnShopItemClose')),
      onClose: function () { shopItemPopup = null; }
    });
  }

  function drawShopItemPopup() {
    var ctx = shopItemPopup;
    if (!ctx || !run) return;
    var sourceShop = ctx.source === 'shop';
    var entry = sourceShop ? ctx.entry : null;
    var id = sourceShop ? entry.id : ctx.id;
    var kind = sourceShop ? entry.kind : bagGroupOf(id);
    var qty = Math.max(0, Number(run.bag[id]) || 0);
    var art = $('shopItemArt');
    if (art) art.innerHTML = window.ItemArt ? window.ItemArt.itemImg(id, 72, 'shop-popup-art') : '';
    $('shopItemTitle').textContent = sourceShop ? entry.name : itemName(id);
    $('shopItemKind').textContent = itemKindLabel(kind);
    $('shopItemDesc').textContent = fullItemDescription(id, sourceShop && entry.desc);

    var meta = $('shopItemMeta');
    var buy = $('btnShopItemBuy');
    var use = $('btnShopItemUse');
    var sell = $('btnShopItemSell');
    var qtyRow = $('shopQtyRow');
    var qtyInput = $('shopQtyInput');
    var qtyMinus = $('btnShopQtyMinus');
    var qtyPlus = $('btnShopQtyPlus');
    if (sourceShop) {
      var sold = Number(entry.stock) <= 0;
      var maxQty = shopQtyMax(entry);
      // Re-clamp the remembered quantity every draw: money and stock both
      // change between opens, and a stale 99 must not survive into a shelf
      // that now holds three.
      var qtyWanted = shopQtyClamp(ctx.qty, maxQty);
      ctx.qty = qtyWanted;
      var total = entry.price * qtyWanted;
      var broke = !sold && run.money < total;
      qtyRow.hidden = false;
      // Never rewrite the field mid-typing ('input' redraws the button
      // states); the caret would keep jumping to the clamped value.
      if (document.activeElement !== qtyInput) qtyInput.value = String(qtyWanted);
      qtyInput.max = String(maxQty);
      qtyInput.disabled = sold;
      qtyMinus.disabled = sold || qtyWanted <= 1;
      qtyPlus.disabled = sold || qtyWanted >= maxQty;
      meta.textContent = sold ? 'Sold out' : '$' + entry.price + ' each \u00b7 In stock: ' +
        (entry.unique ? 1 : Number(entry.stock)) +
        (run.bag[id] ? ' \u00b7 You own ' + run.bag[id] : '');
      buy.hidden = false;
      buy.disabled = sold || broke;
      buy.textContent = sold ? 'Sold out'
        : broke ? 'Not enough money'
        : (qtyWanted > 1 ? 'Buy ' + qtyWanted + ' for $' + total.toLocaleString()
                         : 'Buy for $' + entry.price);
      // The shop sheet is buy-only now. Selling lives on the same item
      // reached from the Bag, where the loose copy actually is.
      use.hidden = true;
      sell.hidden = true;
    } else {
      qtyRow.hidden = true;
      var holder = ctx.holder;
      var holderName = holder ? holder.name : '';
      meta.textContent = holderName
        ? 'Held by ' + holderName + (qty ? ' \u00b7 ' + qty + ' loose in Bag' : '')
        : qty + (qty === 1 ? ' in your Bag' : ' in your Bag');
      buy.hidden = true;
      sell.hidden = false;
      var canSell = qty > 0 || !!(holder && holder.item === id);
      sell.disabled = !canSell;
      sell.textContent = !canSell ? 'No copy to sell'
        : (holder && qty < 1 ? 'Sell held item for $' : 'Sell 1 for $') + sellValue(id);
      // Use is a Full Restore affordance: it is the one loose bag item with
      // an immediate field effect. Balls are battle controls (Sell only),
      // and reward items are used or given the moment they are chosen, so
      // they never sit in the Bag waiting for a Use button.
      var canUse = !holder && C.HEAL_ITEMS[id] && qty > 0;
      use.hidden = !canUse && !holder;
      if (holder) {
        use.hidden = false;
        use.textContent = 'Take item from ' + holderName;
      } else if (canUse) {
        use.textContent = 'Use';
      }
    }
  }

  function closeShopItemPopup() {
    window.Modal.close('screenShopItem');
  }

  function buyFromShopPopup() {
    var ctx = shopItemPopup;
    if (!ctx || ctx.source !== 'shop') return;
    var entry = ctx.entry;
    if (Number(entry.stock) <= 0) { toast('Sold out.'); return; }
    // The stepper clamps as the player taps, but the sheet is the last line
    // of defence: re-derive the quantity from stock and money again here.
    var qty = shopQtyClamp(ctx.qty, shopQtyMax(entry));
    var total = entry.price * qty;
    if (run.money < total) { toast('Not enough money.'); return; }
    closeShopItemPopup();
    buyEntry(entry, qty);
  }

  function sellFromShopPopup() {
    var ctx = shopItemPopup;
    if (!ctx) return;
    // Selling is a Bag-side action only: the shop sheet is buy-only now
    // (stepper + confirm), so every sale comes from an owned item sheet.
    if (ctx.source !== 'owned') return;
    var id = ctx.id;
    var value = sellValue(id);
    var label = itemName(id);
    if (N.useItem(run, id)) {
      finishSell(label, value);
      return;
    }
    // A held copy is still owned. If there is no loose copy, take it off the
    // Pokemon as part of the sale, enforcing any forme reversion on the way.
    var holder = ctx.holder;
    if (!holder || holder.item !== id) {
      toast('There is no ' + label + ' to sell.');
      return;
    }
    closeShopItemPopup();
    function finishHeldSell() {
      run.money += value;
      N.logMsg(run, 'Sold ' + label + ' for $' + value + '.');
      toast('Sold ' + label + ' for $' + value + '.');
      drawMart(); drawOwned(); renderHud(); saveGame();
    }
    if (window.Forme && window.Forme.setHeldItemAndEnforce) {
      window.Forme.setHeldItemAndEnforce(run, holder, '').then(finishHeldSell, function () {
        holder.item = '';
        finishHeldSell();
      });
    } else {
      holder.item = '';
      finishHeldSell();
    }

    function finishSell(name, amount) {
      run.money += amount;
      N.logMsg(run, 'Sold ' + name + ' for $' + amount + '.');
      closeShopItemPopup();
      toast('Sold ' + name + ' for $' + amount + '.');
      drawMart(); drawOwned(); renderHud(); saveGame();
    }
  }

  function useOwnedFromShopPopup() {
    var ctx = shopItemPopup;
    if (!ctx || ctx.source !== 'owned') return;
    var id = ctx.id;
    var holder = ctx.holder;
    closeShopItemPopup();
    if (holder) {
      takeHeldItem(holder.uid);
    } else {
      useFromBag(id);
    }
  }

  function takeHeldItem(uid) {
    if (!run) return;
    var mon = run.party.filter(function (m) { return String(m.uid) === String(uid); })[0];
    if (!mon || !mon.item) return;
    var oldItem = mon.item;
    N.addItem(run, oldItem, 1);
    if (window.Forme && window.Forme.setHeldItemAndEnforce) {
      window.Forme.setHeldItemAndEnforce(run, mon, '').then(function () {
        toast('Took the ' + itemName(oldItem) + ' from ' + mon.name + '.');
        renderCrossroads(); saveGame();
      }, function () {
        mon.item = '';
        toast('Took the ' + itemName(oldItem) + ' from ' + mon.name + '.');
        renderCrossroads(); saveGame();
      });
    } else {
      mon.item = '';
      toast('Took the ' + itemName(oldItem) + ' from ' + mon.name + '.');
      renderCrossroads(); saveGame();
    }
  }

  function buyEntry(e, qty) {
    qty = Math.max(1, Math.floor(Number(qty) || 1));
    var total = e.price * qty;
    if (run.money < total) { toast('Not enough money.'); return; }
    run.money -= total;
    if (!e.unique) e.stock = Math.max(0, (Number(e.stock) || 0) - qty);  // unique items are gated by ownership
    N.addItem(run, e.id, qty);
    // The ten-ball Premier bonus counts individual balls, so a multi-buy
    // walks the counter once per ball in the stack.
    var earnedPremier = false;
    if (e.kind === 'ball' && N.noteShopBallPurchase) {
      for (var b = 0; b < qty; b++) {
        if (N.noteShopBallPurchase(run, e.id)) earnedPremier = true;
      }
    }
    var label = (qty > 1 ? qty + 'x ' : '') + e.name;
    if (earnedPremier) {
      N.logMsg(run, 'You bought 10 balls at this stop and received a Premier Ball.');
    }
    N.logMsg(run, 'Bought ' + label + '.');
    toast(earnedPremier ? 'Bought ' + label + ' \u2014 Premier Ball earned!' : 'Bought ' + label + '!');
    drawMart(); drawOwned(); renderHud(); saveGame();
    // The purchase is the completed target of the current lesson. Immediately
    // arm the next, single team-card target instead of making the player guess
    // where the candy is supposed to be used.
    if (run && run.prologue && run.section === 2) shopCoach();
    // Mega Stones and Forme Change items are party-specific: the shop entry
    // already knows exactly which Pokemon the item is for, so their existing
    // follow-up sheet is the natural next step. Without it a player buys a
    // stone, walks back to the team, and may not even remember which member it
    // was meant for by the time they get there.
    if (e.kind === 'mega' || e.kind === 'forme') {
      offerUseTransform(e);
    }
  }

  // ---- "use the item you just bought?" popup ---------------------------
  // Mega Stones and Forme Change items are always sold in the shop with a
  // `forSpecies` (and forme items also carry their target forme). That lets the
  // popup name the Pokemon, preview the change as a silhouette, and offer a
  // single "Use now" without forcing the player to dig through the team
  // strip. The popup is one-shot: closing it (any way) records that the
  // player was offered, so a refresh during the dialog doesn't re-trigger it.
  function offerUseTransform(entry) {
    if (!entry || !run || N.isGauntlet(run)) return;
    var owner = martTransformOwner(entry);
    if (!owner) return;       // no eligible party member any more (fainted?): skip
    var formeId = null, kind = entry.kind;
    if (kind === 'forme' && window.Forme) {
      var ts = window.Forme.targetsFor(owner, entry.id);
      if (!ts.length) return;     // item no longer usable (e.g. party changed)
      formeId = ts[0].id;
    } else if (kind === 'mega' && window.Mega) {
      var info = window.Mega.infoFor(entry.id);
      if (!info) return;
      formeId = info.forme;
    } else return;

    // The item is now in the bag. Spend the bag count so the popup reflects
    // reality, but do not commit a save until the player commits either way
    // (so "Save for later" leaves the item exactly where they expect it).
    var bagCount = run.bag[entry.id] || 0;
    run.bag[entry.id] = bagCount - 1;
    if (run.bag[entry.id] <= 0) delete run.bag[entry.id];
    saveGame();
    drawMart(); drawOwned();

    var title, sub;
    if (kind === 'mega') {
      title = 'Use ' + entry.name + '?';
      sub = entry.desc || 'Mega stones let this Pokemon Mega Evolve in battle.';
    } else {
      title = 'Change to ' + (formeId ? Dex.species.get(formeId).name + '?' : 'this forme?');
      sub = entry.desc || 'This item changes ' + owner.name + '\u2019s forme.';
    }

    $('useTransformTitle').textContent = title;
    $('useTransformSub').textContent = sub;
    $('useTransformPokemon').textContent = monDisplayName(owner) + ' (' + speciesOf(owner) + ')';

    // The art is a from -> arrow -> silhouette (or revealed sprite) of the
    // forme. Use the same compact preview as the shop tile so the popup and
    // the card it came from look like one decision, not two.
    var artHtml;
    if (formeId) {
      var reveal = kind === 'forme';
      artHtml = '<div class="ut-from">' + animSprite(owner.id, 56, 64, '', 1.15, owner.shiny) +
        '<span class="ut-label">Now</span></div>' +
        '<span class="ut-arrow" aria-hidden="true">\u2192</span>' +
        '<div class="ut-to">' + evoPreviewHtml(owner.id, formeId, { reveal: reveal }) +
        '<span class="ut-label">' + escapeHtml(Dex.species.get(formeId).name) + '</span></div>';
    } else {
      artHtml = '<div class="ut-from">' + animSprite(owner.id, 56, 64, '', 1.15, owner.shiny) +
        '<span class="ut-label">' + escapeHtml(speciesOf(owner)) + '</span></div>';
    }
    $('useTransformArt').innerHTML = artHtml;

    var done = false;
    function close() {
      if (done) return;
      done = true;
      window.Modal.close('screenUseTransform');
    }
    // Refund + save the player's no on close (Escape, click outside, Cancel).
    function refundItem() {
      run.bag[entry.id] = (run.bag[entry.id] || 0) + 1;
      saveGame();
    }
    function applyNow() {
      applyTransformItem(owner, entry, formeId, kind);
    }

    var yesBtn = $('btnUseTransformYes');
    var noBtn = $('btnUseTransformNo');
    yesBtn.onclick = function () { close(); applyNow(); };
    noBtn.onclick = function () { refundItem(); close(); };

    // First-time auto-focus on the affirmative: a player who just bought the
    // stone is most likely going to use it, and a stray Enter should
    // commit, not dismiss the popup.
    window.Modal.open('screenUseTransform', {
      initialFocus: yesBtn,
      onClose: function () {
        if (done) return;       // close() already handled
        // Closed by Escape / outside-click / X: keep the item. Same effect
        // as "Save for later" without taking the user through a second tap.
        done = true;
      }
    });
  }

  // Apply a freshly-bought Mega Stone or Forme Change item to a specific
  // party member. Mega Stones are equipped as held items; the actual mega
  // evolution is a battle-only effect (the engine does the work in-fight).
  // Forme Change items can be held (Plates, Drives, Memories -- the mon
  // changes forme immediately and keeps the item) or one-shot key tools
  // (Gracidea, Reveal Glass -- consumed on use, mon ends up holding nothing).
  // `setHeldItemAndEnforce` in forme.js handles both held-formes and the
  // forme tool case; we only run a separate animation when the forme has
  // actually changed, so an Arceus plate just equips and the game keeps
  // moving.
  async function applyTransformItem(mon, entry, formeId, kind) {
    if (!run || !mon) return;
    var itemId = entry.id;
    if (kind === 'mega') {
      // Mega stones are HELD items, not consumed. Give one to the bag
      // (the popup already decremented; this is the one being equipped) and
      // equip it via the forme-equip path so the engine sees it before the
      // next battle. enforceHeldForme for a Mega is a no-op (the forme
      // doesn't change in the overworld), so this is just a safe equip.
      N.addItem(run, itemId, 1);
      try {
        if (window.Forme && window.Forme.setHeldItemAndEnforce) {
          await window.Forme.setHeldItemAndEnforce(run, mon, itemId);
        } else {
          mon.item = itemId;
        }
      } catch (e) { console.warn('[transform] equip failed', e); }
      N.logMsg(run, mon.name + ' is now holding ' + entry.name + '.');
      toast(mon.name + ' can now Mega Evolve with ' + entry.name + '!');
      drawOwned(); renderHud(); saveGame();
      return;
    }
    // Forme change path: show the same white-out morph the party sheet uses.
    if (formeId) {
      startFormeChange(mon, itemId, formeId);
    } else {
      toast('Nothing happened.');
    }
  }

  // ------------------------------------------------------ TRAIN POKEMON ---
  // One paid session that covers everything: moves, ability, nature and EVs.
  // Pay once, change as much as you like, press Done.
  var svc = null;
  var gbTraining = false;   // true when training a gauntlet team-builder mon
  var SERVICE_PRICE = 2000;

  // ---- the guided training choreography (tutorial, section 2) --------------
  // The tutorial does not just describe the Train service: it walks the
  // player through it, one highlighted control at a time — replace a move,
  // pick an ability, pick a nature, move a Stat Point, press Done. Each step is a
  // coach BUBBLE anchored to the exact control, fired when the previous step
  // actually happened, so there is nothing to figure out along the way.
  var tutorGuide = null;   // { step: 'slot'|'pick'|'ability'|'nature'|'statsTake'|'statsGive'|'done' }

  function tutorGuideActive() {
    return !!(tutorGuide && run && run.prologue && run.section === 2 && !run.tutorialTrained &&
      !$('screenTutor').hidden);
  }
  function tutorBubble(id, anchor, template) {
    var CO = window.Coach;
    if (!CO || !anchor || !anchor.isConnected) return false;
    return CO.lesson(id, {
      surface: 'bubble',
      anchor: anchor,
      actionRequired: true,
      bypassSeen: true,
      holdUntilValid: /^trainStats/.test(id),
      vital: true,
      keepHalo: true,
      template: template,
      stillValid: function () {
        return !$('screenTutor').hidden && run && run.prologue && run.section === 2 && !run.tutorialTrained;
      }
    });
  }
  function tutorTabBtn(tab) {
    return document.querySelector('#screenTutor .tr-tab[data-t="' + tab + '"]');
  }
  // Which stat the guided stats step moves where. Derive this from the live
  // spread instead of assuming an old save or a particular species: the
  // source must have a point to give and the destination must have room.
  //
  // The destination prefers a stat the Pokemon actually wants -- its better
  // attacking stat, then Speed, then the defensive stats -- so the walkthrough
  // never teaches a special attacker to move points into Attack. The old
  // version always picked the first non-maxed stat, which for every guided
  // starter (all special attackers) meant the useless Atk slider.
  function tutorStatTargets(mon) {
    C.ensureSP(mon);
    var keyFor = function (key) {
      for (var i = 0; i < STAT_KEYS.length; i++) {
        if (STAT_KEYS[i][0] === key) return STAT_KEYS[i];
      }
      return null;
    };
    var take = null;
    for (var i = 0; i < STAT_KEYS.length; i++) {
      if ((mon.sp[STAT_KEYS[i][0]] || 0) > 0) {
        take = STAT_KEYS[i]; break;
      }
    }
    var takeKey = take ? take[0] : 'hp';
    var want = [];
    try {
      var style = window.Coach ? window.Coach.attackStyle(mon.id) : null;
      if (style && style.key === 'Physical') want.push('atk');
      else if (style && style.key === 'Special') want.push('spa');
    } catch (e) {}
    want.push('spe', 'def', 'spd', 'hp');
    var give = null;
    for (var w = 0; w < want.length && !give; w++) {
      var key = want[w];
      if (key !== takeKey && (mon.sp[key] || 0) < C.SP_MAX) give = keyFor(key);
    }
    if (!give) {
      for (var j = 0; j < STAT_KEYS.length; j++) {
        var k2 = STAT_KEYS[j][0];
        if (k2 !== takeKey && (mon.sp[k2] || 0) < C.SP_MAX) { give = STAT_KEYS[j]; break; }
      }
    }
    return {
      takeKey: takeKey,
      take: take ? take[1] : 'HP',
      giveKey: give ? give[0] : 'def',
      give: give ? give[1] : 'Def'
    };
  }

  var NATURES = [
    ['Hardy','\u2014','\u2014'],  ['Lonely','Atk','Def'],  ['Brave','Atk','Spe'],
    ['Adamant','Atk','SpA'],    ['Naughty','Atk','SpD'],
    ['Bold','Def','Atk'],       ['Docile','\u2014','\u2014'],['Relaxed','Def','Spe'],
    ['Impish','Def','SpA'],     ['Lax','Def','SpD'],
    ['Timid','Spe','Atk'],      ['Hasty','Spe','Def'],    ['Serious','\u2014','\u2014'],
    ['Jolly','Spe','SpA'],      ['Naive','Spe','SpD'],
    ['Modest','SpA','Atk'],     ['Mild','SpA','Def'],     ['Quiet','SpA','Spe'],
    ['Bashful','\u2014','\u2014'],['Rash','SpA','SpD'],
    ['Calm','SpD','Atk'],       ['Gentle','SpD','Def'],   ['Sassy','SpD','Spe'],
    ['Careful','SpD','SpA'],    ['Quirky','\u2014','\u2014']
  ];
  var STAT_KEYS = [['hp','HP'],['atk','Atk'],['def','Def'],['spa','SpA'],['spd','SpD'],['spe','Spe']];

  // Stat sliders edit a session draft. A fully trained Pokemon normally starts
  // with all 66 points allocated; clamping every attempted increase back to
  // its old value made the sliders look broken unless the player happened to
  // lower another stat first. A draft lets sliders move in either order. It is
  // committed only while it is within budget, so an over-budget intermediate
  // state can never leak into a battle or save file.
  function statDraftUsed(draft) {
    return STAT_KEYS.reduce(function (total, stat) {
      return total + (Number(draft && draft[stat[0]]) || 0);
    }, 0);
  }
  function statDraftFor(mon) {
    if (!svc || svc.mon !== mon) return Object.assign({}, mon.sp || {});
    if (!svc.spDraft) svc.spDraft = Object.assign({}, mon.sp || {});
    return svc.spDraft;
  }
  function commitStatDraft(showError) {
    if (!svc || !svc.spDraft || !svc.mon) return true;
    var used = statDraftUsed(svc.spDraft);
    if (used > C.SP_TOTAL) {
      if (showError) toast('Remove ' + (used - C.SP_TOTAL) + ' Stat Point' +
        (used - C.SP_TOTAL === 1 ? '' : 's') + ' before continuing.');
      return false;
    }
    svc.mon.sp = Object.assign({}, svc.spDraft);
    C.syncEVs(svc.mon);
    return true;
  }

  function openTrainer(mon, free) {
    if (!free) {
      if (!run.trainingPaidThisRound) {
        // The tutorial must never dead-end on the price: if the Rare Candy
        // purchase left them short, Oak covers the fee so the guided
        // training always goes ahead.
        if (run.money < SERVICE_PRICE) {
          if (run && run.prologue && run.section === 2 && !run.tutorialTrained) {
            run.money = SERVICE_PRICE;
            saveGame();
            toast('Professor Oak spotted you the training fee.');
          } else {
            toast('Not enough money.'); return;
          }
        }
        run.money -= SERVICE_PRICE;
        run.trainingPaidThisRound = true;
      }
    }
    svc = { mon: mon, tab: 'moves', replaceSlot: null, all: null, free: !!free };
    if (!free) { renderHud(); saveGame(); }
    // Arm the hand-held training walkthrough when the tutorial asks for it.
    if (run && run.prologue && run.section === 2 && !run.tutorialTrained) {
      tutorGuide = { step: 'slot' };
    }
    $('btnTutorBack').textContent = 'Done';
    drawTrainer();
    show('Tutor');
  }

  async function drawTrainer() {
    if (!svc) return;
    var mon = svc.mon;
    $('tutorTitle').textContent = 'Train ' + mon.name;
    $('tutorSub').textContent = speciesOf(mon) + ' \u00b7 change as much as you like';

    var box = $('tutorBody');
    var tabs = [['moves','Moves'],['ability','Ability'],['nature','Nature'],['stats','Stats']];
    var tabHtml = '<div class="tr-tabs">' + tabs.map(function (t) {
      return '<button class="tr-tab' + (svc.tab === t[0] ? ' on' : '') + '" data-t="' + t[0] + '">' + t[1] + '</button>';
    }).join('') + '</div>';

    box.innerHTML = tabHtml + '<div id="trBody" class="tr-body"></div>';
    box.querySelectorAll('.tr-tab').forEach(function (b) {
      b.addEventListener('click', function () {
        // Do not let an unfinished over-budget draft escape the Stats tab.
        // The live Pokemon still has its last valid spread, but keeping the
        // player here makes the required correction explicit.
        if (svc.tab === 'stats' && !commitStatDraft(true)) return;
        svc.tab = b.dataset.t;
        drawTrainer();
        // The guided walkthrough advances tab by tab; each tab body fires
        // its own bubble once it is on screen (see the drawTrain* fns).
        if (window.Coach) { try { window.Coach.clearMark(); } catch (e) {} }
      });
    });

    var body = $('trBody');
    if (svc.tab === 'moves') return drawTrainMoves(body, mon);
    if (svc.tab === 'ability') return drawTrainAbility(body, mon);
    if (svc.tab === 'nature') return drawTrainNature(body, mon);
    return drawTrainStats(body, mon);
  }

  function guidedMoveUpgrade(mon, options) {
    var types = (mon.types || []).map(function (t) { return String(t).toLowerCase(); });
    function isStab(id) {
      var m = Dex.moves.get(id);
      return !!(m && m.exists && m.category !== 'Status' &&
        types.indexOf(String(m.type).toLowerCase()) >= 0);
    }
    var candidates = (options || []).filter(function (id) {
      var m = Dex.moves.get(id);
      return mon.moves.indexOf(id) < 0 && isStab(id) && (m.basePower || 0) > 0;
    }).sort(function (a, b) {
      var A = Dex.moves.get(a), B = Dex.moves.get(b);
      if ((A.basePower || 0) !== (B.basePower || 0)) return (B.basePower || 0) - (A.basePower || 0);
      var aa = A.accuracy === true ? 101 : Number(A.accuracy) || 0;
      var ba = B.accuracy === true ? 101 : Number(B.accuracy) || 0;
      return ba - aa;
    });
    // Replace a non-STAB move first. Status moves are the clearest teaching
    // contrast; otherwise discard the weakest off-type attack. Only fall back
    // to the weakest current move when an imported save already has all STAB.
    var slots = mon.moves.map(function (id, index) {
      var m = Dex.moves.get(id);
      return { index: index, stab: isStab(id), status: m.category === 'Status', power: m.basePower || 0 };
    }).sort(function (a, b) {
      if (a.stab !== b.stab) return a.stab ? 1 : -1;
      if (a.status !== b.status) return a.status ? -1 : 1;
      return a.power - b.power;
    });
    return { slotIndex: slots.length ? slots[0].index : null,
             moveId: candidates.length ? candidates[0] : null };
  }

  async function drawTrainMoves(body, mon) {
    var activeSvc = svc;
    body.innerHTML = '<p class="hint">Reading learnset...</p>';
    if (!activeSvc.all) {
      var all = await N.tutorOptions(mon);
      // The player can switch to Stats (or finish training) while the
      // learnset promise is still resolving. Never write through a stale/null
      // service after that screen transition.
      if (!svc || svc !== activeSvc || svc.mon !== mon || svc.tab !== 'moves' || !body.isConnected) return;
      all.sort(function (a, b) {
        var A = Dex.moves.get(a), B = Dex.moves.get(b);
        var ap = A.category === 'Status' ? -1 : A.basePower;
        var bp = B.category === 'Status' ? -1 : B.basePower;
        if (ap !== bp) return bp - ap;
        return A.name.localeCompare(B.name);
      });
      svc.all = all;
    }
    if (tutorGuideActive() && tutorGuide.step === 'slot' && tutorGuide.slotIndex == null) {
      var upgrade = guidedMoveUpgrade(mon, svc.all);
      tutorGuide.slotIndex = upgrade.slotIndex;
      tutorGuide.moveId = upgrade.moveId;
    }
    body.innerHTML =
      '<div class="tutor-current" id="trCurrent"></div>' +
      '<input id="tutorSearch" class="search" placeholder="Search by name or type..." autocomplete="off"/>' +
      '<div id="tutorList" class="move-list"></div>';

    function drawCurrent() {
      var CO = window.Coach;
      var style = CO ? CO.attackStyle(mon.id) : null;
      // Say out loud what the game has always silently assumed: this Pokemon
      // has a better attacking stat, and its moves should use it.
      var guide = style && style.key !== 'mixed'
        ? '<div class="tc-guide">' + escapeHtml(speciesOf(mon)) + ' hits harder with <b>' +
          escapeHtml(style.label.toLowerCase()) + '</b> moves. Look for <b>STAB</b> \u2014 ' +
          'those match its own type and do 50% more damage.</div>'
        : '';
      $('trCurrent').innerHTML = guide +
        '<div class="tc-label">Current moves \u2014 tap one to replace it</div>' +
        '<div class="tc-slots">' + mon.moves.map(function (id, i) {
          var m = Dex.moves.get(id);
          return '<button class="tc-slot type-' + m.type + (svc.replaceSlot === i ? ' sel' : '') +
            '" data-slot="' + i + '" data-tip="move:' + m.id + '">' +
            '<span class="tc-n">' + m.name + '</span>' +
            '<span class="tc-m">' + (m.category === 'Status' ? 'St' : m.basePower) + '</span>' +
            badgesHtml(id, mon, { compact: true }) +
            '</button>';
        }).join('') + '</div>';
      $('trCurrent').querySelectorAll('.tc-slot').forEach(function (b) {
        b.addEventListener('click', function () {
          var i = +b.dataset.slot;
          svc.replaceSlot = (svc.replaceSlot === i) ? null : i;
          drawCurrent();
          // Guided training: a slot is now armed — point at a move to learn.
          if (tutorGuideActive() && tutorGuide.step === 'slot') {
            if (window.Coach) { try { window.Coach.clearMark(); } catch (e) {} }
            tutorGuide.step = 'pick';
            var wanted = tutorGuide.moveId && listEl
              ? listEl.querySelector('.move-card[data-m="' + tutorGuide.moveId + '"]') : null;
            var first = wanted || (listEl ? listEl.querySelector('.move-card') : null);
            if (first) {
              try { first.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) {}
              setTimeout(function () { tutorBubble('trainPickMove', first); }, 0);
            }
          }
        });
      });
    }

    var listEl = $('tutorList');
    function drawList(filter) {
      var f = (filter || '').toLowerCase();
      var subset = svc.all.filter(function (id) {
        if (mon.moves.indexOf(id) >= 0) return false;
        if (!f) return true;
        var m = Dex.moves.get(id);
        return m.name.toLowerCase().indexOf(f) >= 0 || m.type.toLowerCase().indexOf(f) >= 0;
      });
      // During the walkthrough the recommended card is intentionally first:
      // it is the strongest available STAB attack, not merely the first
      // high-power off-type move in the generic tutor ordering.
      if (!f && tutorGuideActive() && tutorGuide.moveId) {
        var wantedIndex = subset.indexOf(tutorGuide.moveId);
        if (wantedIndex > 0) subset.unshift(subset.splice(wantedIndex, 1)[0]);
      }
      subset = subset.slice(0, 120);
      listEl.innerHTML = subset.map(function (id) {
        var m = Dex.moves.get(id);
        var acc = m.accuracy === true ? '\u2014' : m.accuracy;
        return '<button class="move-card" data-m="' + id + '" data-tip="move:' + id + '">' +
          '<div class="mc-top"><span class="mv-chip type-' + m.type + '">' + m.type + '</span>' +
            '<span class="mc-cat">' + m.category + '</span></div>' +
          '<div class="mc-name">' + m.name + '</div>' +
          '<div class="mc-stats"><span>' + (m.category === 'Status' ? '\u2014' : 'Pow ' + m.basePower) +
            '</span><span>Acc ' + acc + '</span><span>PP ' + m.pp + '</span></div>' +
          // This is where the wrong choice actually gets made: a big power
          // number with "must rest after" attached. Say so on the card.
          badgesHtml(id, mon) + '</button>';
      }).join('') || '<p class="hint">No matches.</p>';
      listEl.querySelectorAll('.move-card').forEach(function (b) {
        b.addEventListener('click', function () { teachNow(b.dataset.m); });
      });
    }

    function teachNow(moveId) {
      var nm = Dex.moves.get(moveId);
      var slot = svc.replaceSlot;
      if (slot == null) {
        if (mon.moves.length < 4) slot = mon.moves.length;
        else { toast('Pick which move to replace first.'); return; }
      }
      if (slot >= mon.moves.length) {
        mon.moves.push(moveId);
        mon.pp[moveId] = Math.floor(nm.pp * 1.6);
      } else {
        if (run && !svc.free) N.teachMove(run, mon, slot, moveId);
        else {
          var old = mon.moves[slot];
          if (old) delete mon.pp[old];
          mon.moves[slot] = moveId;
          mon.pp[moveId] = Math.floor(nm.pp * 1.6);
        }
      }
      svc.replaceSlot = null;
      toast(mon.name + ' learned ' + nm.name + '!');
      drawCurrent();
      drawList($('tutorSearch') ? $('tutorSearch').value : '');
      if (run && !svc.free) saveGame();
      // Guided training: the move is changed — move on to the Ability tab.
      if (tutorGuideActive() && tutorGuide.step === 'pick') {
        if (window.Coach) { try { window.Coach.clearMark(); } catch (e) {} }
        tutorGuide.step = 'ability';
        setTimeout(function () { tutorBubble('trainAbilityTab', tutorTabBtn('ability')); }, 0);
      }
    }

    drawCurrent();
    drawList('');
    $('tutorSearch').addEventListener('input', function () { drawList(this.value); });

    // Guided training, first step: pick the slot to replace.
    if (tutorGuideActive() && tutorGuide.step === 'slot') {
      var firstSlot = $('trCurrent') ? $('trCurrent').querySelector(
        '.tc-slot[data-slot="' + tutorGuide.slotIndex + '"]') : null;
      if (!firstSlot && $('trCurrent')) firstSlot = $('trCurrent').querySelector('.tc-slot');
      // A mon with fewer than four moves has an open slot — skip straight to
      // choosing the strongest available STAB move.
      if (!firstSlot || (mon.moves && mon.moves.length < 4)) {
        tutorGuide.step = 'pick';
        var firstMove = tutorGuide.moveId && listEl
          ? listEl.querySelector('.move-card[data-m="' + tutorGuide.moveId + '"]') : null;
        if (!firstMove && listEl) firstMove = listEl.querySelector('.move-card');
        if (firstMove) {
          try { firstMove.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) {}
          setTimeout(function () { tutorBubble('trainPickMove', firstMove); }, 0);
        }
      } else if (firstSlot) {
        setTimeout(function () { tutorBubble('trainMovesSlot', firstSlot); }, 0);
      }
    }

    // How to actually pick a move. Fires once, on the list itself, the first
    // time someone opens the move tab.
    var CO2 = window.Coach;
    if (CO2 && CO2.tipsOn() && run && run.prologue && !tutorGuideActive() && !CO2.seen('moveChoice')) {
      setTimeout(function () {
        if (run && run.prologue && !$('screenTutor').hidden) {
          CO2.lesson('moveChoice', { anchor: $('trCurrent') });
        }
      }, 500);
    }
  }

  function drawTrainAbility(body, mon) {
    var opts = N.abilityOptions(mon);
    body.innerHTML = '<div class="opt-list">' + opts.map(function (a) {
      var ab = Dex.abilities.get(a);
      var on = a === mon.ability;
      return '<button class="opt-row' + (on ? ' sel' : '') + '" data-a="' + a + '" data-tip="ability:' + ab.id + '">' +
        '<b>' + ab.name + '</b><span>' + (ab.shortDesc || ab.desc || '') + '</span>' +
        (on ? '<span class="mv-meta">current</span>' : '') + '</button>';
    }).join('') + '</div>' +
    (opts.length < 2 ? '<p class="hint">This Pokemon has only one legal ability.</p>' : '');
    body.querySelectorAll('.opt-row').forEach(function (b) {
      b.addEventListener('click', function () {
        var advanceGuide = tutorGuideActive() && tutorGuide.step === 'ability';
        if (advanceGuide) {
          // Advance BEFORE redraw. The redraw below re-enters drawTrainAbility;
          // if the step still says "ability" it schedules a second ability
          // bubble, which can sit in the vital queue and block Nature/Stats.
          if (window.Coach) { try { window.Coach.clearMark(); } catch (e) {} }
          tutorGuide.step = 'nature';
        }
        mon.ability = b.dataset.a;
        toast(mon.name + '\u2019s ability is now ' + b.dataset.a + '.');
        drawTrainer(); if (run && !svc.free) saveGame();
        // Guided training: the ability is set — move on to Nature.
        if (advanceGuide) {
          setTimeout(function () { tutorBubble('trainNatureTab', tutorTabBtn('nature')); }, 0);
        }
      });
    });

    // Guided training, ability step: point at the ability to pick. A species
    // with only one legal ability gets a short sheet instead of a dead tap.
    if (tutorGuideActive() && tutorGuide.step === 'ability') {
      var pick = body.querySelector('.opt-row:not(.sel)');
      if (pick) {
        setTimeout(function () { tutorBubble('trainAbilityPick', pick); }, 0);
      } else {
        var only = body.querySelector('.opt-row');
        if (only) {
          setTimeout(function () {
            tutorBubble('trainAbilityOnly', only, {
              NAME: mon.name, ABILITY: Dex.abilities.get(mon.ability).name
            });
          }, 0);
        }
      }
    }
  }

  function drawTrainNature(body, mon) {
    body.innerHTML = '<div class="nat-grid">' + NATURES.map(function (n) {
      var on = (mon.nature || 'Serious') === n[0];
      return '<button class="nat' + (on ? ' sel' : '') + '" data-n="' + n[0] + '">' +
        '<span class="nat-n">' + n[0] + '</span>' +
        '<span class="nat-d">' + (n[1] === '\u2014' ? 'balanced' : '+' + n[1] + ' \u2212' + n[2]) + '</span>' +
        '</button>';
    }).join('') + '</div>';
    body.querySelectorAll('.nat').forEach(function (b) {
      b.addEventListener('click', function () {
        var advanceGuide = tutorGuideActive() && tutorGuide.step === 'nature';
        if (advanceGuide) {
          // Advance BEFORE redraw for the same reason as the ability step:
          // avoid queuing a stale duplicate nature bubble ahead of Stats.
          if (window.Coach) { try { window.Coach.clearMark(); } catch (e) {} }
          tutorGuide.step = 'statsTake';
        }
        mon.nature = b.dataset.n;
        toast(mon.name + ' is now ' + b.dataset.n + '.');
        drawTrainer(); if (run && !svc.free) saveGame();
        // Guided training: the nature is set — move on to Stat Points.
        if (advanceGuide) {
          setTimeout(function () { tutorBubble('trainStatsTab', tutorTabBtn('stats')); }, 0);
        }
      });
    });

    // Guided training, nature step: point at a nature that boosts the stat
    // this Pokemon already loves, skipping the one it currently has.
    if (tutorGuideActive() && tutorGuide.step === 'nature') {
      var want = 'Atk';
      try {
        var style = window.Coach ? window.Coach.attackStyle(mon.id) : null;
        if (style && style.key === 'Special') want = 'SpA';
      } catch (e) {}
      var cur = mon.nature || 'Serious';
      var pick = null;
      for (var i = 0; i < NATURES.length; i++) {
        if (NATURES[i][1] === want && NATURES[i][0] !== cur) { pick = NATURES[i][0]; break; }
      }
      if (!pick) {
        for (var j = 0; j < NATURES.length; j++) {
          if (NATURES[j][0] !== cur && NATURES[j][1] !== '\u2014') { pick = NATURES[j][0]; break; }
        }
      }
      var natBtn = pick ? body.querySelector('.nat[data-n="' + pick + '"]') : null;
      if (natBtn) setTimeout(function () { tutorBubble('trainNaturePick', natBtn); }, 0);
    }
  }

  function drawTrainStats(body, mon) {
    C.ensureSP(mon);
    var MAXP = C.SP_MAX, TOTAL = C.SP_TOTAL;
    var draft = statDraftFor(mon);
    function used() { return statDraftUsed(draft); }

    // Compute base stats and final stats
    var sp = Dex.species.get(mon.id);
    var base = sp.exists ? sp.baseStats : {hp:100,atk:100,def:100,spa:100,spd:100,spe:100};
    var natArr = NATURES.filter(function (n) { return n[0] === (mon.nature || 'Serious'); });
    var natPlus = natArr.length ? natArr[0][1] : '\u2014';
    var natMinus = natArr.length ? natArr[0][2] : '\u2014';

    function finalStat(key) {
      var b = base[key] || 100;
      var ev = C.spToEv(draft[key] || 0);
      var iv = 31;
      if (key === 'hp') return Math.floor(((2 * b + iv + Math.floor(ev / 4)) * 100) / 100) + 100 + 10;
      var nat = 1;
      var label = {atk:'Atk',def:'Def',spa:'SpA',spd:'SpD',spe:'Spe'}[key];
      if (natPlus === label) nat = 1.1;
      else if (natMinus === label) nat = 0.9;
      return Math.floor((Math.floor(((2 * b + iv + Math.floor(ev / 4)) * 100) / 100) + 5) * nat);
    }

    var statsTable = '<div class="stats-table">' +
      '<div class="st-row st-head"><span></span><span class="st-base">Base</span><span class="st-ev">Points</span><span class="st-fin">Final</span></div>' +
      STAT_KEYS.map(function (k) {
        var ev = draft[k[0]] || 0;
        var fin = finalStat(k[0]);
        var label = {hp:'HP',atk:'Atk',def:'Def',spa:'SpA',spd:'SpD',spe:'Spe'}[k[0]];
        var isPlus = natPlus === label, isMinus = natMinus === label;
        var natClass = isPlus ? ' st-plus' : (isMinus ? ' st-minus' : '');
        return '<div class="st-row' + natClass + '">' +
          '<span class="st-name">' + k[1] + '</span>' +
          '<span class="st-base">' + (base[k[0]] || 0) + '</span>' +
          '<span class="st-ev">' + ev + '</span>' +
          '<span class="st-fin">' + fin + '</span>' +
          '</div>';
      }).join('') +
      '</div>';

    // Build once, then only patch values on input: re-rendering the whole
    // block mid-drag would tear the slider out from under the pointer.
    body.innerHTML =
      statsTable +
      '<div class="sp-head" id="spBudget" aria-live="polite">Stat Points left <b id="spLeft">0</b> <span>/ ' + TOTAL + '</span></div>' +
      STAT_KEYS.map(function (k) {
        var v = draft[k[0]] || 0;
        return '<div class="sp-row" data-s="' + k[0] + '">' +
          '<span class="sp-k">' + k[1] + '</span>' +
          '<input class="sp-range" type="range" min="0" max="' + MAXP + '" step="1" ' +
                 'value="' + v + '" data-s="' + k[0] + '" aria-label="' + k[1] + '"/>' +
          '<span class="sp-v">' + v + '</span>' +
          '</div>';
      }).join('') +
      '<p class="sp-warning" id="spWarning" role="alert" hidden></p>' +
      '<p class="hint">Max ' + MAXP + ' per stat, ' + TOTAL + ' in total. ' +
        'You can move any slider first; finish at ' + TOTAL + ' or fewer points.</p>';

    var leftEl = body.querySelector('#spLeft');
    var budgetEl = body.querySelector('#spBudget');
    var warningEl = body.querySelector('#spWarning');
    var rows = [].slice.call(body.querySelectorAll('.sp-range'));
    var stRows = [].slice.call(body.querySelectorAll('.st-row:not(.st-head)'));

    function paint() {
      var left = TOTAL - used();
      leftEl.textContent = left;
      leftEl.classList.toggle('none', left === 0);
      budgetEl.classList.toggle('over', left < 0);
      warningEl.hidden = left >= 0;
      warningEl.textContent = left < 0
        ? 'Remove ' + Math.abs(left) + ' point' + (left === -1 ? '' : 's') + ' before continuing.'
        : '';
      rows.forEach(function (r) {
        var k = r.dataset.s, v = draft[k] || 0;
        if (+r.value !== v) r.value = v;
        r.parentNode.querySelector('.sp-v').textContent = v;
        // colour the filled part of the track without a repaint of the DOM
        r.style.setProperty('--fill', (v / MAXP * 100) + '%');
        // a stat that cannot go any higher is worth showing as capped
        r.parentNode.classList.toggle('maxed', v >= MAXP);
      });
      // Update final stats in the table
      stRows.forEach(function (row, idx) {
        var k = STAT_KEYS[idx];
        if (!k) return;
        var evCell = row.querySelector('.st-ev');
        var finCell = row.querySelector('.st-fin');
        if (evCell) evCell.textContent = draft[k[0]] || 0;
        if (finCell) finCell.textContent = finalStat(k[0]);
      });
    }

    rows.forEach(function (r) {
      r.addEventListener('input', function () {
        var k = r.dataset.s;
        var want = Math.max(0, Math.min(MAXP, parseInt(r.value, 10) || 0));
        var before = draft[k] || 0;
        // Never snap the thumb back just because the spread is currently
        // full. Let the session draft go temporarily over budget; the player
        // can now increase first and lower another stat second.
        draft[k] = want;
        commitStatDraft(false);
        paint();

        if (!tutorGuideActive()) return;
        var tt = tutorStatTargets(mon);
        var takeKey = tutorGuide.takeKey || tt.takeKey;
        var giveKey = tutorGuide.giveKey || tt.giveKey;
        if (tutorGuide.step === 'statsTake' && k === takeKey) {
          if (draft[k] < (tutorGuide.takeStart == null ? before : tutorGuide.takeStart)) {
            if (window.Coach) { try { window.Coach.clearMark(); } catch (e) {} }
            tutorGuide.step = 'statsGive';
            tutorGuide.giveStart = draft[giveKey] || 0;
            setTimeout(function () {
              var give = body.querySelector('.sp-range[data-s="' + giveKey + '"]');
              if (give) tutorBubble('trainStatsGive', give, { GIVE: tt.give });
            }, 0);
          }
        } else if (tutorGuide.step === 'statsGive' && k === giveKey) {
          if (draft[k] > (tutorGuide.giveStart == null ? before : tutorGuide.giveStart)) {
            if (window.Coach) { try { window.Coach.clearMark(); } catch (e) {} }
            tutorGuide.step = 'done';
            setTimeout(function () {
              var done = $('btnTutorBack');
              if (done) tutorBubble('trainDone', done);
            }, 0);
          }
        }
      });
      r.addEventListener('change', function () {
        // Only valid drafts are copied to the live Pokemon and persisted.
        // Over-budget values stay local to this training session.
        if (commitStatDraft(false) && run && !svc.free) saveGame();
        // The guided stat move is two explicit controls, never one sentence
        // that makes the player guess which slider comes first. Input handles
        // the transition; change only persists the value.
      });
    });
    paint();

    // Guided training, stats step: first point at the source slider. The
    // destination slider gets its own lesson only after the source moved.
    if (tutorGuideActive() && tutorGuide.step === 'statsTake') {
      var tt = tutorStatTargets(mon);
      var takeRow = body.querySelector('.sp-range[data-s="' + tt.takeKey + '"]');
      if (takeRow) {
        tutorGuide.takeKey = tt.takeKey;
        tutorGuide.giveKey = tt.giveKey;
        tutorGuide.takeStart = draft[tt.takeKey] || 0;
        setTimeout(function () {
          tutorBubble('trainStatsTake', takeRow, { TAKE: tt.take });
        }, 0);
      }
    }
  }

  // ---- TEAM (inline on the route screen) ----------------------------------
  // A 1x6 grid of slots. Tapping one opens its detail panel right below.
  var partySel = -1;   // -1 = nothing expanded

  function statusColor(st) {
    if (!st) return '';
    var map = { brn: '#ff5f6d', psn: '#a855f7', tox: '#9333ea', par: '#facc15', slp: '#a2aac4', frz: '#7dd3fc' };
    return map[st] || '#ff5f6d';
  }
  function statusBadgeClass(st) {
    return st ? (' st-' + st) : '';
  }
  function statusBadgeHtml(st) {
    if (!st) return '';
    var col = statusColor(st);
    var txtCol = (st === 'par' || st === 'slp' || st === 'frz') ? '#000' : '#fff';
    return '<span class="ts-st' + statusBadgeClass(st) + '" style="background:' + col + ';color:' + txtCol + '">' + st.toUpperCase() + '</span>';
  }
  function drawTeamStrip() {
    var strip = $('xTeam');
    if (!strip) return;
    var html = '';
    for (var i = 0; i < N.MAX_PARTY; i++) {
      var m = run.party[i];
      if (m) {
        var pct = pctHP(m.hpPct);
        var col = m.hpPct > 0.5 ? '#4ade80' : m.hpPct > 0.2 ? '#facc15' : '#ef4444';
        html += '<button class="tslot' + (i === partySel ? ' sel' : '') + '" data-i="' + i + '">' +
          (i === 0 ? '<span class="ts-lead">LEAD</span>' : '') +
          '<span class="ts-art">' + animSprite(m.id, 46, 52, '', 1.4, m.shiny) + '</span>' +
          '<span class="ts-name">' + escapeHtml(m.name) + '</span>' +
          '<span class="ts-bar"><i style="width:' + pct + '%;background:' + col + '"></i></span>' +
          statusBadgeHtml(m.status) +
          '</button>';
      } else {
        html += '<div class="tslot empty"><span class="dock-ball"></span></div>';
      }
    }
    strip.innerHTML = html;
    strip.querySelectorAll('.tslot[data-i]').forEach(function (b) {
      b.addEventListener('click', function () {
        var i = +b.dataset.i;
        partySel = (partySel === i) ? -1 : i;
        drawTeamStrip();
        drawPartyDetail();
      });
    });
  }

  function drawPartyDetail() {
    var overlay = $('xTeamDetail');
    if (!overlay) return;
    var host = overlay.querySelector('.overlay-card');
    if (!host) return;

    var mon = run.party[partySel];
    if (!mon) {
      window.Modal.close('xTeamDetail');
      host.innerHTML = '';
      return;
    }
    // Re-drawing an already-open sheet must not re-run the open sequence (it
    // would steal focus back to the top on every repaint).
    if (!window.Modal.isOpen('xTeamDetail')) {
      window.Modal.open('xTeamDetail', { onClose: function () {
        partySel = -1;
        drawTeamStrip();
      } });
    }

    var mx = C.maxHP(mon), cur = C.curHP(mon);
    var pct = pctHP(mon.hpPct);
    var col = mon.hpPct > 0.5 ? '#4ade80' : mon.hpPct > 0.2 ? '#facc15' : '#ef4444';
    var dmg = Math.round(run.damageDealt[mon.uid] || 0);
    var kos = run.knockouts[mon.uid] || 0;

    // Quick-switch party grid — same 6-slot layout as the team strip
    var gridHtml = '<div class="team-strip" style="margin:0 0 14px">';
    for (var gi = 0; gi < N.MAX_PARTY; gi++) {
      var gm = run.party[gi];
      if (gm) {
        var gPct = pctHP(gm.hpPct);
        var gCol = gm.hpPct > 0.5 ? '#4ade80' : gm.hpPct > 0.2 ? '#facc15' : '#ef4444';
        gridHtml += '<button class="tslot' + (gi === partySel ? ' sel' : '') + '" data-gi="' + gi + '">' +
          (gi === 0 ? '<span class="ts-lead">LEAD</span>' : '') +
          '<span class="ts-art">' + animSprite(gm.id, 46, 52, '', 1.4, gm.shiny) + '</span>' +
          '<span class="ts-name">' + escapeHtml(gm.name) + '</span>' +
          '<span class="ts-bar"><i style="width:' + gPct + '%;background:' + gCol + '"></i></span>' +
          statusBadgeHtml(gm.status) +
          '</button>';
      } else {
        gridHtml += '<div class="tslot empty"><span class="dock-ball"></span></div>';
      }
    }
    gridHtml += '</div>';

    // Full Restore suggestion
    var potionHtml = '';
    if (mon.hpPct < 1 && !C.isFainted(mon)) {
      var bestPotion = null;
      var potionOrder = ['fullrestore', 'maxpotion', 'hyperpotion', 'superpotion', 'potion'];
      for (var pi = 0; pi < potionOrder.length; pi++) {
        if (run.bag[potionOrder[pi]] && run.bag[potionOrder[pi]] > 0) { bestPotion = potionOrder[pi]; break; }
      }
      if (bestPotion) {
        potionHtml = '<button class="btn-secondary wide pd-potion-btn" data-potion="' + bestPotion + '">' +
          (window.ItemArt ? window.ItemArt.itemImg(bestPotion, 18) : '') +
          'Use ' + itemName(bestPotion) + '</button>';
      }
    }

    // Ether suggestion
    var etherHtml = '';
    var needsEther = mon.moves.some(function (m) { return (mon.pp[m] || 0) <= 0; });
    if (needsEther) {
      var bestEther = run.bag['maxether'] ? 'maxether' : (run.bag['ether'] ? 'ether' : null);
      if (bestEther) {
        etherHtml = '<button class="btn-secondary wide pd-ether-btn" data-ether="' + bestEther + '">' +
          (window.ItemArt ? window.ItemArt.itemImg(bestEther, 18) : '') +
          'Use ' + itemName(bestEther) + '</button>';
      }
    }

    // Train button. The Gauntlet offers free training (no money, no cost).
    var isG = N.isGauntlet(run);
    var trainLabel = isG
      ? 'Train \u00b7 free'
      : (run.trainingPaidThisRound
        ? 'Train more \u00b7 already paid this round'
        : 'Train Pokemon \u00b7 $' + SERVICE_PRICE.toLocaleString());

    host.innerHTML =
      gridHtml +
      (partySel > 0 ? '<button class="btn-secondary wide pd-lead" style="margin-bottom:10px">Make lead</button>' : '') +
      '<div class="party-detail">' +
        '<div class="pd-hero">' +
          '<div class="pd-art">' + bigSprite(mon.id, '', 104, 104, 1, mon.shiny) + '</div>' +
          '<div class="pd-id">' +
            '<div class="pd-species">' + speciesOf(mon) + (mon.shiny ? ' \u2728' : '') + '</div>' +
            '<div class="pd-name">' + escapeHtml(mon.name) + '</div>' +
            '<div class="types">' + typeChips(mon.types) + '</div>' +
          '</div>' +
        '</div>' +

        '<div class="pd-hp">' +
          '<div class="hm-b big"><i style="width:' + pct + '%;background:' + col + '"></i></div>' +
          '<span>' + cur + ' / ' + mx + (mon.status ? '  \u00b7  ' + mon.status.toUpperCase() : '') + '</span>' +
        '</div>' +
        potionHtml +

        '<div class="pd-facts">' +
          '<div class="pd-fact" data-tip="ability:' + mon.ability + '" tabindex="0"><span class="k">Ability</span><span class="v">' + mon.ability + '</span></div>' +
          '<div class="pd-fact"><span class="k">Nature</span><span class="v">' + (mon.nature || 'Serious') + '</span></div>' +
          '<div class="pd-fact"><span class="k">Damage</span><span class="v">' + dmg.toLocaleString() + '</span></div>' +
          '<div class="pd-fact"><span class="k">KOs</span><span class="v">' + kos + '</span></div>' +
        '</div>' +

        '<div class="pd-actions">' +
          '<button class="btn-primary pd-train"><img class="ic-train-img" src="https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/items/power-bracer.png" alt="">' + trainLabel + '</button>' +
        '</div>' +

        '<div class="pd-sec"><div class="pd-label">Moves</div>' +
          '<div class="pd-moves">' + mon.moves.map(function (m) {
            var mv = Dex.moves.get(m);
            var mxpp = Math.floor(mv.pp * 1.6);
            var have = mon.pp[m] != null ? mon.pp[m] : mxpp;
            var low = have / mxpp < 0.25;
            var frac = mxpp ? have / mxpp : 0;
            var ppCol = low ? '#ef4444' : '#fff';
            var pw = mv.category === 'Status' ? 'Status' : (mv.basePower ? 'Pow ' + mv.basePower : '');
            return '<div class="pd-move" data-tip="move:' + mv.id + '" tabindex="0">' +
              '<div class="pd-move-top"><span class="mv-chip type-' + mv.type + '">' + mv.type + '</span>' +
              '<span class="pd-mv-pw">' + pw + '</span></div>' +
              '<span class="pd-mn">' + mv.name + '</span>' +
              badgesHtml(m, mon, { compact: true }) +
              '<div class="pd-mp-bar"><div class="pd-mp-track"><div class="pd-mp-fill" style="width:' + (frac * 100) + '%;background:' + ppCol + '"></div></div>' +
              '<span class="pd-mp' + (low ? ' low' : '') + '">' + have + '/' + mxpp + '</span></div>' +
              '</div>';
          }).join('') + '</div>' +
        '</div>' +
        etherHtml +

        (isG ? (
        '<div class="pd-sec"><div class="pd-label">Held item</div>' +
          (mon.item
            ? '<button class="pd-held" data-take="1" data-tip="item:' + mon.item + '">' +
                (window.ItemArt ? window.ItemArt.itemImg(mon.item, 26) : '') +
                '<span>' + itemName(mon.item) + '</span><em>tap to remove</em></button>'
            : '<div class="pd-empty">Nothing held.</div>') +
          '<button class="btn-secondary wide" style="margin-top:8px" data-gb-pick-held="1">Pick Held Item</button>' +
        '</div>' +
        gbFormeRowHtml(mon)
        ) :
        '<div class="pd-sec"><div class="pd-label">Held item</div>' +
          (mon.item
            ? '<button class="pd-held" data-take="1" data-tip="item:' + mon.item + '">' +
                (window.ItemArt ? window.ItemArt.itemImg(mon.item, 26) : '') +
                '<span>' + itemName(mon.item) +
                  (window.Coach && window.Coach.heldPlain(mon.item)
                    ? '<em class="oi-plain">' + escapeHtml(window.Coach.heldPlain(mon.item)) + '</em>' : '') +
                '</span><em>tap to remove</em></button>'
            // An empty slot is the single biggest missed opportunity for a
            // casual player, so say what it is FOR, not just that it is empty.
            : '<div class="pd-empty">Nothing held. A held item works in every battle and never ' +
              'runs out \u2014 held items come as battle rewards and are given straight away.</div>') +
        '</div>' +
        evoRowHtml(mon, partySel) +
        formeRowHtml(mon)) +

      '</div>' +
      '<button type="button" class="btn-secondary wide pd-close">Close</button>';

    // Party grid click handlers
    host.querySelectorAll('.tslot[data-gi]').forEach(function (b) {
      b.addEventListener('click', function () {
        partySel = +b.dataset.gi;
        drawPartyDetail();
      });
    });
    var close = host.querySelector('.pd-close');
    if (close) close.addEventListener('click', function () {
      window.Modal.close('xTeamDetail');
    });
    // Full Restore button
    var potionBtn = host.querySelector('.pd-potion-btn');
    if (potionBtn) potionBtn.addEventListener('click', function () {
      var itemId = potionBtn.dataset.potion;
      var h = C.HEAL_ITEMS[itemId];
      if (!h || !h.healPct) return;
      var amount = Math.max(1, Math.round(mx * h.healPct));
      var got = Math.min(mx - cur, amount);
      if (got <= 0) { toast('Already at full HP.'); return; }
      N.useItem(run, itemId);
      mon.hpPct = Math.min(1, mon.hpPct + got / mx);
      toast(mon.name + ' recovered ' + got + ' HP!');
      // The guided run's heal step is complete the moment the new partner is
      // healed out of battle — this is the taught action, not just a card
      // read.
      var COheal = window.Coach;
      if (COheal && run && run.prologue && run.section === 1 &&
          run.battleInSection === 1 && !run.tutorialHealDone &&
          mon === caughtMonInParty()) {
        run.tutorialHealDone = true;
        if (!COheal.seen('healOpen')) COheal.markSeen('healOpen');
        if (!COheal.seen('healUse')) COheal.markSeen('healUse');
        try { COheal.clearMark(); } catch (e) {}
        saveGame();
        // Close the party sheet and return to the route immediately so the
        // next scripted beat ("continue to the next battle") appears now,
        // rather than waiting for the player to dismiss the sheet themselves.
        window.Modal.close('xTeamDetail');
        renderCrossroads();
        return;
      }
      saveGame(); drawPartyDetail(); drawTeamStrip(); renderHud();
    });
    // Ether button
    var etherBtn = host.querySelector('.pd-ether-btn');
    if (etherBtn) etherBtn.addEventListener('click', function () {
      var itemId = etherBtn.dataset.ether;
      var h = C.HEAL_ITEMS[itemId];
      if (!h) return;
      var restored = false;
      for (var ei = 0; ei < mon.moves.length; ei++) {
        var mvId = mon.moves[ei];
        if ((mon.pp[mvId] || 0) <= 0) {
          var maxpp = Math.floor(Dex.moves.get(mvId).pp * 1.6);
          mon.pp[mvId] = h.pp === 999 ? maxpp : Math.min(maxpp, (h.pp || 10));
          restored = true;
          break;
        }
      }
      if (!restored) { toast('All moves have PP.'); return; }
      N.useItem(run, itemId);
      toast('PP restored!');
      saveGame(); drawPartyDetail();
    });
    // Backdrop clicks and Escape are handled by the shared modal controller.
    var take = host.querySelector('[data-take]');
    if (take) take.addEventListener('click', async function () {
      var oldItem = mon.item;
      N.addItem(run, oldItem, 1);
      toast('Took the ' + itemName(oldItem) + '.');
      if (window.Forme && window.Forme.setHeldItemAndEnforce) {
        await window.Forme.setHeldItemAndEnforce(run, mon, '');
      } else {
        mon.item = '';
      }
      renderCrossroads(); saveGame(); drawPartyDetail();
    });
    var train = host.querySelector('.pd-train');
    if (train) train.addEventListener('click', function () {
      if (!isG) {
        if (!run.trainingPaidThisRound && run.money < SERVICE_PRICE) { toast('Not enough money.'); return; }
      }
      window.Modal.close('xTeamDetail');
      openTrainer(mon, isG);
    });
    var lead = host.querySelector('.pd-lead');
    if (lead) lead.addEventListener('click', function () {
      run.party.unshift(run.party.splice(partySel, 1)[0]);
      partySel = 0;
      // The guided "make it your lead" step is complete the moment the
      // mechanic is used, whichever Pokemon it was applied to.
      var COl = window.Coach;
      if (COl && run && run.prologue && run.section === 1 && run.battleInSection === 2) {
        if (!COl.seen('makeLead')) COl.markSeen('makeLead');
        if (!COl.seen('makeLeadTap')) COl.markSeen('makeLeadTap');
        try { COl.clearMark(); } catch (e) {}
      }
      window.Modal.close('xTeamDetail');
      renderCrossroads(); saveGame();
    });
    host.querySelectorAll('.evo-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        // An armed evo-use bubble/halo has done its job the moment the
        // player commits to the evolution.
        if (window.Coach) { try { window.Coach.clearMark(); } catch (e) {} }
        if (b.dataset.gbRunForme) {   // gauntlet free forme change
          gbRunFormeChange(mon, b.dataset.gbRunFormeItem, b.dataset.gbRunForme);
          return;
        }
        if (b.dataset.item) {   // forme
          if (!run.bag[b.dataset.item]) { toast('You need a ' + itemName(b.dataset.item) + '.'); return; }
          startFormeChange(mon, b.dataset.item, b.dataset.forme);
          return;
        }
        var opt = evoOptionByKey(mon, b.dataset.evo);
        if (!opt) return;
        if (!window.Evo.canEvolve(run, mon, opt)) { toast('You need a ' + opt.requirement.label + '.'); return; }
        startEvolution(mon, opt);
      });
    });

    // Gauntlet: pick held item from all available items
    var gbPickHeld = host.querySelector('[data-gb-pick-held]');
    if (gbPickHeld) gbPickHeld.addEventListener('click', function () {
      openGbRunHeldPicker(mon);
    });

    // Evolution lessons, on the row itself. The branch warning takes
    // precedence: it is the one with a consequence attached.
    var CO = window.Coach;
    if (CO && CO.tipsOn() && run && run.prologue && !isG) {
      var evoBox = host.querySelector('.evo-box');
      if (evoBox) {
        var branching = evoBox.querySelectorAll('.evo-btn').length > 1;
        var pro = !!(run && run.prologue && CO.inPrologue());
        // During the guided run this is a FALLBACK for the scripted evolution
        // lesson (the Mart sheet normally teaches it first): if the player
        // opens a party member's evolution box before the chain reaches it,
        // the lesson fires here instead. The tutorial itself only concludes
        // once the starter has ACTUALLY evolved and training is done, so
        // dismissing this card never ends the prologue on its own.
        //
        // Section 1 is deliberately excluded: its scripted beats (heal the
        // new friend, make it the lead) own the party sheet, and this sheet
        // used to fire over them and stall the queue mid-step. Evolution
        // belongs to section 2.
        var which = pro
          ? ((run.section === 2 && !CO.seen('evolve')) ? 'evolve' : null)
          : ((branching && !CO.seen('evoBranch')) ? 'evoBranch'
            : (!CO.seen('evolve') ? 'evolve' : null));
        if (which) {
          setTimeout(function () {
            if (!window.Modal.isOpen('xTeamDetail')) return;
            CO.lesson(which, {
              anchor: evoBox,
              vital: pro,
              stillValid: function () { return window.Modal.isOpen('xTeamDetail') && !!(run && run.prologue); }
            });
          }, 480);
        }
      }
    }

    // Guided-run coaching anchored inside the party sheet: the make-lead tap
    // (section 1) and the use-the-evolution-item tap (section 2).
    tutorialPartyDetailCoach(mon);
  }

  // Coach beats that live on the party sheet itself, fired when the sheet
  // opens on the right Pokemon at the right moment of the guided run.
  function tutorialPartyDetailCoach(mon) {
    var CO = window.Coach;
    if (!CO || !CO.tipsOn() || !run || !run.prologue) return;

    // Section 1, before battle 2: the "heal your new friend" bubble on the
    // actual Full Restore button inside the new partner's card.
    if (run.section === 1 && run.battleInSection === 1 && !run.tutorialHealDone &&
        !!caughtMonInParty() && mon === caughtMonInParty() && mon.hpPct < 1 &&
        partySel > 0) {
      var potionBtn = document.querySelector('#xTeamDetail .pd-potion-btn');
      if (potionBtn) {
        setTimeout(function () {
          if (!window.Modal.isOpen('xTeamDetail')) return;
          CO.lesson('healUse', {
            surface: 'bubble', anchor: potionBtn, actionRequired: true,
            bypassSeen: true, vital: true, keepHalo: true,
            stillValid: function () {
              return window.Modal.isOpen('xTeamDetail') && run && run.prologue &&
                run.section === 1 && run.battleInSection === 1 && !run.tutorialHealDone;
            },
            template: { NAME: monDisplayName(mon) },
            onShow: function () { if (!CO.seen('healUse')) CO.markSeen('healUse'); }
          });
        }, 0);
      }
      return;
    }

    // Section 1, before battle 2: the "make it your lead" bubble on the
    // actual Make lead button.
    if (run.section === 1 && run.battleInSection === 2 && !caughtIsLead() && !!caughtMonInParty() && partySel > 0) {
      var leadBtn = document.querySelector('#xTeamDetail .pd-lead');
      if (leadBtn) {
        setTimeout(function () {
          if (!window.Modal.isOpen('xTeamDetail')) return;
          CO.lesson('makeLeadTap', {
            surface: 'bubble',
            anchor: leadBtn, actionRequired: true, bypassSeen: true,
            vital: true, keepHalo: true,
            stillValid: function () { return window.Modal.isOpen('xTeamDetail') && run && run.prologue && !caughtIsLead(); },
            onShow: function () { if (!CO.seen('makeLeadTap')) CO.markSeen('makeLeadTap'); }
          });
        }, 0);
      }
      return;
    }

    // Section 2: the starter's evolution is armed — point at the ready
    // Evolve button so the player actually uses the item.
    if (run.section === 2 && !run.tutorialEvolved && mon && starterMon() === mon) {
      var readyBtn = document.querySelector('#xTeamDetail .evo-btn.ready');
      if (readyBtn) {
        // The inspector is taller than a phone screen and evolution lives near
        // its foot. Put that section in view before attaching the tutorial so
        // the player never has to hunt/scroll for the highlighted action.
        try { readyBtn.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' }); }
        catch (e) { try { readyBtn.scrollIntoView(); } catch (_) {} }
        setTimeout(function () {
          if (!window.Modal.isOpen('xTeamDetail')) return;
          var liveReady = document.querySelector('#xTeamDetail .evo-btn.ready');
          if (liveReady) {
            try { liveReady.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) {}
            readyBtn = liveReady;
          }
          CO.lesson('evoUse', {
            surface: 'bubble', anchor: readyBtn, actionRequired: true,
            bypassSeen: true, vital: true, keepHalo: true,
            stillValid: function () {
              return window.Modal.isOpen('xTeamDetail') && run && run.prologue &&
                run.section === 2 && !run.tutorialEvolved;
            },
            onShow: function () { if (!CO.seen('evoUse')) CO.markSeen('evoUse'); }
          });
        }, 0);
      }
      return;
    }

    // Evolution and training use the same two-step pattern: first point at
    // the team card, then point at the one control inside its detail sheet.
    if (run.section === 2 && !run.tutorialTrained && mon && trainingMon() === mon) {
      var trainBtn = document.querySelector('#xTeamDetail .pd-train');
      if (trainBtn) {
        setTimeout(function () {
          if (!window.Modal.isOpen('xTeamDetail')) return;
          CO.lesson('trainButton', {
            surface: 'bubble', anchor: trainBtn, actionRequired: true,
            bypassSeen: true, vital: true, keepHalo: true,
            stillValid: function () {
              return window.Modal.isOpen('xTeamDetail') && run && run.prologue &&
                run.section === 2 && !run.tutorialTrained;
            },
            onShow: function () { if (!CO.seen('trainButton')) CO.markSeen('trainButton'); }
          });
        }, 0);
      }
    }
  }

  // Items you own, shown above the shop. Tapping one opens its detail sheet;
  // that sheet keeps the existing use/give action and also offers Sell.
  // The Bag: EVERYTHING you own, in one place above the shop -- balls,
  // Full Restores, evolution/forme/mega stones and held items, including the ones
  // currently equipped on a Pokemon (those are owned too, they were just
  // invisible before because they live on `mon.item`, not in `run.bag`).
  function bagGroupOf(id) {
    if (C.BALLS[id]) return 'ball';
    if (C.HEAL_ITEMS[id]) return 'heal';
    if (window.Mega && window.Mega.isMegaStone(id)) return 'mega';
    if (window.Forme && window.Forme.isFormeItem(id)) return 'forme';
    if (window.Evo && window.Evo.allEvolutionItems().indexOf(id) >= 0) return 'evo';
    return 'held';
  }

  // Inline category chip name shown on every bag item, so the player can tell
  // Poke Balls from Medicine at a glance even though both live in the same
  // 2-column grid. Order matches the categories in the Mart.
  var BAG_GROUP_LABEL = { ball: 'Ball', heal: 'Heal', held: 'Held', evo: 'Evo', forme: 'Forme', mega: 'Mega' };

  function drawOwned() {
    var host = $('xOwned');
    if (!host) return;

    // bag stock + everything currently held, so nothing you own is hidden
    var entries = {};
    Object.keys(run.bag).forEach(function (id) {
      entries[id] = { id: id, qty: run.bag[id], holders: [] };
    });
    run.party.forEach(function (m) {
      if (!m.item) return;
      var e = entries[m.item] || (entries[m.item] = { id: m.item, qty: 0, holders: [] });
      e.holders.push(m);
    });

    var ids = Object.keys(entries);
    var note = $('xBagNote');
    if (note) {
      var total = ids.reduce(function (n, id) {
        return n + entries[id].qty + entries[id].holders.length;
      }, 0);
      note.textContent = total ? total + (total === 1 ? ' item' : ' items') : '';
    }

    if (!ids.length) {
      host.innerHTML = '<div class="owned-empty">Nothing yet \u2014 buy something below.</div>';
      return;
    }

    // A SINGLE flat 2-column grid replaces the old per-category stacks. With
    // 1 ball + 1 medicine the two tiles sit side by side on one row; the
    // grid wraps naturally when more items exist later. A small category
    // chip on every tile preserves the information the old group headers
    // used to carry.
    var cards = [];
    ids.forEach(function (id) {
      var e = entries[id];
      var group = BAG_GROUP_LABEL[bagGroupOf(id)] || '';
      // one row per equipped copy, so you can see who is holding what
      e.holders.forEach(function (m) {
        cards.push('<button class="owned-item held" data-held-item="' + id + '" data-take="' + m.uid + '" data-tip="item:' + id + '">' +
          (group ? '<span class="oi-cat">' + group + '</span>' : '') +
          '<span class="oi-art">' + (window.ItemArt ? window.ItemArt.itemImg(id, 28) : '') + '</span>' +
          '<span class="oi-n">' + itemName(id) +
            '<em class="oi-who">' + escapeHtml(m.name) + '</em></span>' +
          '<span class="oi-q take">take</span>' +
          '</button>');
      });
      if (e.qty > 0) {
        cards.push('<button class="owned-item" data-item="' + id + '" data-tip="item:' + id + '">' +
          (group ? '<span class="oi-cat">' + group + '</span>' : '') +
          '<span class="oi-art">' + (window.ItemArt ? window.ItemArt.itemImg(id, 28) : '') + '</span>' +
          '<span class="oi-n">' + itemName(id) + itemPlainHtml(id, 'oi-plain') + '</span>' +
          '<span class="oi-q">x' + e.qty + '</span>' +
          '</button>');
      }
    });
    host.innerHTML = '<div class="bag-items">' + cards.join('') + '</div>';

    host.querySelectorAll('[data-item]').forEach(function (b) {
      b.addEventListener('click', function () {
        openOwnedItemPopup(b.dataset.item, null);
      });
    });
    // Equipped copies also belong to the player. Their sheet offers "Take
    // item" (and Sell if there is another loose copy) instead of silently
    // changing the held item on the first tap.
    host.querySelectorAll('[data-held-item]').forEach(function (b) {
      b.addEventListener('click', function () {
        var uid = b.dataset.take;
        var m = run.party.filter(function (x) { return String(x.uid) === String(uid); })[0];
        if (m && m.item) openOwnedItemPopup(b.dataset.heldItem, m);
      });
    });
  }

  // ------------------------------------------------------------- MENU ------
  // One entry point in the route header. Everything that is not "play the
  // next battle" lives behind it, so the header stays a single button.
  function openMenu() {
    loadProfile(); applyTheme(); updateMenuAvatar();
    var n = profile.shinies.length;
    $('miShinyCount').textContent = n
      ? n + (n === 1 ? ' shiny caught' : ' shinies caught')
      : 'No shinies yet';
    var h = profile.history.length;
    $('miHistCount').textContent = h
      ? h + (h === 1 ? ' run finished' : ' runs finished')
      : 'No runs finished';
    updateMenuAvatar();
    var abBtn = $('btnMenuAbandon');
    if (abBtn) abBtn.hidden = !run || run.over || !$('screenTitle').hidden;
    window.Modal.open('screenMenu');
  }
  function closeMenu() { window.Modal.close('screenMenu'); }

  // Complete directory index downloaded from Pokemon Showdown's trainer-sprite
  // catalogue. Native lazy loading prevents the large gallery from fetching
  // every PNG until the player scrolls to it.
  var AVATARS = ["aaron","aarune","acerola-masters","acerola-masters2","acerola-masters3","acerola","acetrainer-gen1","acetrainer-gen1rb","acetrainer-gen2","acetrainer-gen3","acetrainer-gen3jp","acetrainer-gen3rs","acetrainer-gen4","acetrainer-gen4dp","acetrainer-gen6","acetrainer-gen6xy","acetrainer-gen7","acetrainer","acetrainercouple-gen3","acetrainercouple","acetrainerf-gen1","acetrainerf-gen1rb","acetrainerf-gen2","acetrainerf-gen3","acetrainerf-gen3rs","acetrainerf-gen4","acetrainerf-gen4dp","acetrainerf-gen6","acetrainerf-gen6xy","acetrainerf-gen7","acetrainerf","acetrainersnow","acetrainersnowf","adaman-masters","adaman-masters2","adaman","aetheremployee","aetheremployeef","aetherfoundation","aetherfoundation2","aetherfoundationf","agatha-gen1","agatha-gen1rb","agatha-gen3","agatha-lgpe","akari-isekai","akari","alain","alder","alec-anime","allister-masters","allister-unmasked","allister","amarys","amelia-shuffle","anabel-gen3","anabel-gen7","anabel","ansha-cook","ansha","anthe","anthea","anvin","aquagrunt-rse","aquagrunt","aquagruntf-rse","aquagruntf","aquasuit","archer","archie-gen3","archie-gen6","archie-usum","arezu","argenta","ariana","arlo","aromalady-gen3","aromalady-gen3rs","aromalady-gen6","aromalady","artist-gen4","artist-gen6","artist-gen8","artist-gen9","artist","artistf-gen6","arven-masters","arven-s","arven-v","ash-alola","ash-capbackward","ash-hoenn","ash-johto","ash-kalos","ash-sinnoh","ash-unova","ash","atticus","avery","az-lza","az","backers","backersf","backpacker-gen6","backpacker-gen8","backpacker-gen9","backpacker","backpackerf","baker","ballguy-masters","ballguy","baoba","barry-masters","barry","battlegirl-gen3","battlegirl-gen4","battlegirl-gen6","battlegirl-gen6xy","battlegirl","bea-masters","bea","beauty-gen1","beauty-gen1rb","beauty-gen2","beauty-gen2jp","beauty-gen3","beauty-gen3rs","beauty-gen4dp","beauty-gen5bw2","beauty-gen6","beauty-gen6xy","beauty-gen7","beauty-gen8","beauty-gen9","beauty-masters","beauty","becca","bede-leader","bede-masters","bede-masters2","bede","bellelba","bellepa","bellhop","bellis","benga","beni-ninja","beni","bertha","bianca-masters","bianca-pwt","bianca","biker-gen1","biker-gen1rb","biker-gen2","biker-gen3","biker-gen4","biker","bill-gen3","bill","birch-gen3","birch","birdkeeper-gen1","birdkeeper-gen1rb","birdkeeper-gen2","birdkeeper-gen3","birdkeeper-gen3rs","birdkeeper-gen4dp","birdkeeper-gen6","birdkeeper","blackbelt-gen1","blackbelt-gen1rb","blackbelt-gen2","blackbelt-gen3","blackbelt-gen3rs","blackbelt-gen4","blackbelt-gen4dp","blackbelt-gen6","blackbelt-gen7","blackbelt-gen8","blackbelt-gen9","blackbelt","blaine-gen1","blaine-gen1rb","blaine-gen2","blaine-gen3","blaine-lgpe","blaine","blanche-casual","blanche","blue-gen1","blue-gen1champion","blue-gen1rb","blue-gen1rbchampion","blue-gen1rbtwo","blue-gen1two","blue-gen2","blue-gen3","blue-gen3champion","blue-gen3two","blue-gen7","blue-lgpe","blue-masters","blue-masters2","blue","boarder-gen2","boarder","bodybuilder-gen9","bodybuilderf-gen9","brandon-gen3","brandon","brassius","brawly-gen3","brawly-gen6","brawly","brendan-contest","brendan-e","brendan-gen3","brendan-gen3rs","brendan-masters","brendan-masters2","brendan-masters3","brendan-rs","brendan","briar","brigette","brock-gen1","brock-gen1rb","brock-gen2","brock-gen3","brock-lgpe","brock-masters","brock","bruno-gen1","bruno-gen1rb","bruno-gen2","bruno-gen3","bruno","brycen","brycenman","bryony","buck","bugcatcher-gen1","bugcatcher-gen1rb","bugcatcher-gen2","bugcatcher-gen3","bugcatcher-gen3rs","bugcatcher-gen4dp","bugcatcher-gen6","bugcatcher","bugmaniac-gen3","bugmaniac-gen6","bugsy-gen2","bugsy-masters","bugsy","burgh-masters","burgh","burglar-gen1","burglar-gen1rb","burglar-gen2","burglar-gen3","burglar-lgpe","burglar","burnet-radar","burnet","butler","byron","cabbie-gen9","cabbie","cafemaster","caitlin-gen4","caitlin-masters","caitlin","calaba","calem-masters","calem","cameraman-gen6","cameraman-gen8","cameraman","camper-gen2","camper-gen3","camper-gen3rs","camper-gen6","camper","canari","candela-casual","candela","candice-masters","candice","caraliss","caretaker","carmine-festival","carmine-masters","carmine","cedricjuniper","celio","channeler-gen1","channeler-gen1rb","channeler-gen3","channeler-lgpe","charm","charon","chase","chef","cheren-gen5bw2","cheren-masters","cheren","cheryl","chili","choy","christoph","chuck-gen2","chuck","cilan","clair-gen2","clair-masters","clair","clavell-s","clay","clemont","clerk-boss","clerk-gen8","clerk-unite","clerk","clerkf-gen8","clerkf","cliff","clive-v","clover","clown","cogita","coin","collector-gen3","collector-gen6","collector-gen7","collector-masters","collector","colress-gen7","colress","colza","concordia","cook-gen7","cook-gen9","cook","corbeau","courier","courtney-gen3","courtney","cowgirl","crasherwake","cress","crispin","crushgirl-gen3","crushkin-gen3","cueball-gen1","cueball-gen1rb","cueball-gen3","curtis","cyclist-gen4","cyclist","cyclistf-gen4","cyclistf","cyllene","cynthia-anime","cynthia-anime2","cynthia-gen4","cynthia-gen7","cynthia-masters","cynthia-masters2","cynthia-masters3","cynthia-masters4","cynthia-masters5","cynthia","cyrano","cyrus-masters","cyrus","dagero","dahlia","daisy-gen3","daisy","dana","dancer-gen7","dancer-gen8","dancer","darach-caitlin","darach","dawn-contest","dawn-gen4pt","dawn-masters","dawn-masters2","dawn-masters3","dawn","delinquent-gen9","delinquent","delinquentf-gen9","delinquentf2-gen9","dendra","depotagent","dexio-gen6","dexio","diamondclanmember","diantha-masters","diantha-masters2","diantha","doctor-gen8","doctor","doctorf-gen8","doubleteam","dragontamer-gen3","dragontamer-gen6","dragontamer-gen9","dragontamer","drake-gen3","drasna","drayden","drayton","dulse","elaine","elesa-gen5bw2","elesa-masters","elesa-masters2","elesa-masters3","elesa","elio-masters","elio-usum","elio","elm","emma-lza","emma","emmet-masters","emmet","engineer-gen1","engineer-gen1rb","engineer-gen3","erbie-unite","eri","erika-gen1","erika-gen1rb","erika-gen2","erika-gen3","erika-lgpe","erika-masters","erika-masters2","erika-masters3","erika","essentia","ethan-gen2","ethan-gen2c","ethan-masters","ethan-pokeathlon","ethan","eusine-gen2","eusine","evelyn","expert-gen3","expert-gen6","expertf-gen3","expertf-gen6","faba","fairytalegirl","falkner-gen2","falkner","fantina","fennel","firebreather-gen2","firebreather","firefighter","fisher-gen8","fisherman-gen1","fisherman-gen1rb","fisherman-gen2jp","fisherman-gen3","fisherman-gen3rs","fisherman-gen4","fisherman-gen6","fisherman-gen6xy","fisherman-gen7","fisherman","flannery-gen3","flannery-gen6","flannery","flaregrunt","flaregruntf","flint","florian-bb","florian-festival","florian-masters","florian-s","freediver","furisodegirl-black","furisodegirl-blue","furisodegirl-pink","furisodegirl-white","gaeric","galacticgrunt","galacticgruntf","gambler-gen1","gambler-gen1rb","gambler","gamer-gen3","garcon","gardener","gardenia-masters","gardenia","geeta","gentleman-gen1","gentleman-gen1rb","gentleman-gen2","gentleman-gen3","gentleman-gen3rs","gentleman-gen4","gentleman-gen4dp","gentleman-gen6","gentleman-gen6xy","gentleman-gen7","gentleman-gen8","gentleman-lgpe","gentleman","ghetsis-gen5bw","ghetsis","giacomo","ginchiyo-conquest","ginter","giovanni-gen1","giovanni-gen1rb","giovanni-gen3","giovanni-lgpe","giovanni-masters","giovanni-masters2","giovanni","glacia-gen3","glacia","gladion-masters","gladion-masters2","gladion-stance","gladion","gloria-dojo","gloria-league","gloria-masters","gloria-masters2","gloria-tundra","gloria","golfer","gordie","grace","grant","green","greta-gen3","greta","grimsley-gen7","grimsley-masters","grimsley","grisham","grusha","guitarist-gen2","guitarist-gen3","guitarist-gen4","guitarist-gen6","guitarist","gurkinn","guzma-masters","guzma","gwynn","hala","hanbei-conquest","hapu","harlequin","harmony","hassel","hau-masters","hau-stance","hau","hayley","heath","hero-conquest","hero2-conquest","heroine-conquest","heroine2-conquest","hexmaniac-gen3","hexmaniac-gen3jp","hexmaniac-gen6","hiker-gen1","hiker-gen1rb","hiker-gen2","hiker-gen3","hiker-gen3rs","hiker-gen4","hiker-gen6","hiker-gen7","hiker-gen8","hiker-gen9","hiker","hilbert-masters","hilbert-masters2","hilbert-masters3","hilbert-wonderlauncher","hilbert","hilda-masters","hilda-masters2","hilda-masters3","hilda-masters4","hilda-wonderlauncher","hilda","hooligans","hoopster","hop-masters","hop","hugh-masters","hugh","hyde","idol","ilima","infielder","ingo-hisui","ingo-masters","ingo","interviewers-gen3","interviewers-gen6","interviewers","iono-masters","iono-masters2","iono","irida-masters","irida-masters2","irida","iris-gen5bw2","iris-masters","iris-masters2","iris","iscan","ivor","jacinthe","jacq","jamie","janine-gen2","janine","janitor-gen7","janitor-gen9","janitor","jasmine-contest","jasmine-gen2","jasmine-masters","jasmine-masters2","jasmine-masters3","jasmine","jessiejames-gen1","jogger","johanna-contest","johanna","jrtrainer-gen1","jrtrainer-gen1rb","jrtrainerf-gen1","jrtrainerf-gen1rb","juan-gen3","juan","juggler-gen1","juggler-gen1rb","juggler-gen2","juggler-gen3","juggler","juliana-bb","juliana-festival","juliana-masters","juliana-s","juniper","jupiter","kabu-masters","kabu","kahili","kamado-armor","kamado","karen-gen2","karen","katy","kiawe","kieran-champion","kieran-festival","kieran-masters","kieran","kimonogirl-gen2","kimonogirl","kindler-gen3","kindler-gen6","klara","kofu","koga-gen1","koga-gen1rb","koga-gen2","koga-gen3","koga-lgpe","koga","korrina-masters","korrina","kris-gen2","kris-masters","kris-masters2","kris","kukui-stand","kukui","kunoichi-conquest","kunoichi2-conquest","kurt","lacey-masters","lacey","lady-gen3","lady-gen3rs","lady-gen4","lady-gen6","lady-gen6oras","lady","lana-masters","lana-masters2","lana","lance-gen1","lance-gen1rb","lance-gen2","lance-gen3","lance-lgpe","lance-masters","lance-masters2","lance","lanette","larry-masters","larry-masters2","larry","lass-gen1","lass-gen1rb","lass-gen2","lass-gen3","lass-gen3rs","lass-gen4","lass-gen4dp","lass-gen6","lass-gen6oras","lass-gen7","lass-gen8","lass","laventon","laventon2","leaf-gen3","leaf-masters","leaf-masters2","leaguestaff","leaguestafff","lebanne","lenora","leon-masters","leon-masters2","leon-tower","leon","li","lian","lida","liko","lillie-masters","lillie-masters2","lillie-masters3","lillie-masters4","lillie-masters5","lillie-z","lillie","linebacker","lisia-masters","lisia","liza-gen6","liza-masters","liza","lorelei-gen1","lorelei-gen1rb","lorelei-gen3","lorelei-lgpe","ltsurge-gen1","ltsurge-gen1rb","ltsurge-gen2","ltsurge-gen3","ltsurge","lucas-contest","lucas-gen4pt","lucas","lucian","lucy-gen3","lucy","lusamine-masters","lusamine-nihilego","lusamine","lyra-masters","lyra-masters2","lyra-pokeathlon","lyra","lysandre-masters","lysandre","mable","madame-gen4","madame-gen4dp","madame-gen6","madame-gen7","madame-gen8","madame","magmagrunt-rse","magmagrunt","magmagruntf-rse","magmagruntf","magmasuit","magnolia","magnus","mai","maid-gen4","maid-gen6","maid","mallow-masters","mallow","malva","marley-masters","marley","marlon","marnie-league","marnie-masters","marnie-masters2","marnie-masters3","marnie-masters4","marnie","mars","marshal","masamune-conquest","mateo","matt-gen3","matt","maxie-gen3","maxie-gen6","may-contest","may-e","may-gen3","may-gen3rs","may-masters","may-masters2","may-masters3","may-masters4","may-rs","may","maylene","medium-gen2jp","medium","mela","melli","melony","miku-fairy","miku-fire","miku-flying","miku-ghost","miku-grass","miku-ground","miku-ice","miku-psychic","miku-water","milo","mina-lgpe","mina-masters","mina","mira","miriam","mirror","misty-gen1","misty-gen1rb","misty-gen2","misty-gen3","misty-lgpe","misty-masters","misty","model-gen8","mohn-anime","mohn","molayne","mom-alola","mom-hoenn","mom-johto","mom-paldea","mom-unova","mom-unova2","morgan","morty-gen2","morty-masters","morty-masters2","morty-masters3","morty","mrbriney","mrfuji-gen3","mrstone","musician-gen8","musician-gen9","musician","mustard-champion","mustard-master","mustard","n-masters","n-masters2","n-masters3","n","nancy","nanu","nate-masters","nate-pokestar","nate-pokestar3","nate-wonderlauncher","nate","naveen","nemona-masters","nemona-s","nemona-v","neroli","nessa-masters","nessa","ninjaboy-gen3","ninjaboy-gen6","ninjaboy","nita","nobunaga-conquest","noland-gen3","noland","norman-gen3","norman-gen6","norman","nurse","nurseryaide","oak-gen1","oak-gen1rb","oak-gen2","oak-gen3","oak","officer-gen2","officeworker-gen9","officeworker","officeworkerf-gen9","officeworkerf","ogreclan","oichi-conquest","oldcouple-gen3","oleana","olivia","olympia","opal","ortega","owner","painter-gen3","palina","palmer","parasollady-gen3","parasollady-gen4","parasollady-gen6","parasollady","paulo-masters","paxton","pearlclanmember","penny","peonia","peony-league","peony","perrin-masters","perrin","pesselle","petrel","phil","phillipe","phoebe-gen3","phoebe-gen6","phoebe-masters","phorus-unite","phyco","picnicker-gen2","picnicker-gen3","picnicker-gen3rs","picnicker-gen6","picnicker","piers-league","piers-masters","piers","pilot","plasmagrunt-gen5bw","plasmagrunt","plasmagruntf-gen5bw","plasmagruntf","player-go","playerf-go","plumeria-league","plumeria","pokefan-gen2","pokefan-gen3","pokefan-gen4","pokefan-gen6","pokefan-gen6xy","pokefan","pokefanf-gen2","pokefanf-gen3","pokefanf-gen4","pokefanf-gen6","pokefanf-gen6xy","pokefanf","pokekid-gen8","pokekid","pokekidf-gen8","pokemaniac-gen1","pokemaniac-gen1rb","pokemaniac-gen2","pokemaniac-gen3","pokemaniac-gen3rs","pokemaniac-gen6","pokemaniac-gen9","pokemaniac","pokemonbreeder-gen3","pokemonbreeder-gen4","pokemonbreeder-gen6","pokemonbreeder-gen6xy","pokemonbreeder-gen7","pokemonbreeder-gen8","pokemonbreeder","pokemonbreederf-gen3","pokemonbreederf-gen3frlg","pokemonbreederf-gen4","pokemonbreederf-gen6","pokemonbreederf-gen6xy","pokemonbreederf-gen7","pokemonbreederf-gen8","pokemonbreederf","pokemoncenterlady","pokemonranger-gen3","pokemonranger-gen3rs","pokemonranger-gen4","pokemonranger-gen6","pokemonranger-gen6xy","pokemonranger","pokemonrangerf-gen3","pokemonrangerf-gen3rs","pokemonrangerf-gen4","pokemonrangerf-gen6","pokemonrangerf-gen6xy","pokemonrangerf","policeman-gen4","policeman-gen7","policeman-gen8","policeman","poppy-masters","poppy","postman","preschooler-gen6","preschooler-gen7","preschooler","preschoolerf-gen6","preschoolerf-gen7","preschoolerf","preschoolers","proton","pryce-gen2","pryce","psychic-gen1","psychic-gen1rb","psychic-gen2","psychic-gen3","psychic-gen3rs","psychic-gen4","psychic-gen6","psychic-lgpe","psychic","psychicf-gen3","psychicf-gen3rs","psychicf-gen4","psychicf","psychicfjp-gen3","punkgirl-gen7","punkgirl-masters","punkgirl","punkguy-gen7","punkguy","raifort","raihan-masters","raihan","railstaff","rainbowrocketgrunt","rainbowrocketgruntf","ramos","rancher","ranmaru-conquest","red-gen1","red-gen1main","red-gen1rb","red-gen1title","red-gen2","red-gen3","red-gen7","red-lgpe","red-masters","red-masters2","red-masters3","red-masters4","red","rei-isekai","rei-masters","rei","reporter-gen6","reporter-gen8","reporter","rhi","richboy-gen3","richboy-gen4","richboy-gen6","richboy-gen6xy","richboy","rika-masters","rika","riley","risingstar-gen6","risingstar","risingstarf-gen6","risingstarf","rita","river","roark","rocker-gen1","rocker-gen1rb","rocker-gen3","rocket-gen1","rocket-gen1rb","rocketexecutive-gen2","rocketexecutivef-gen2","rocketgrunt-gen2","rocketgrunt","rocketgruntf-gen2","rocketgruntf","rollerskater","rollerskaterf","rood","rosa-masters","rosa-masters2","rosa-masters3","rosa-masters4","rosa-pokestar","rosa-pokestar2","rosa-pokestar3","rosa-wonderlauncher","rosa","rose-zerosuit","rose","roughneck-gen4","roughneck","rowan","roxanne-gen3","roxanne-gen6","roxanne-masters","roxanne","roxie-masters","roxie","roy","ruffian","ruinmaniac-gen3","ruinmaniac-gen3rs","ruinmaniac-gen6","ruinmaniac","rye","ryme","ryuki","sabi","sabrina-frlg","sabrina-gen1","sabrina-gen1rb","sabrina-gen2","sabrina-gen3","sabrina-lgpe","sabrina-masters","sabrina","sada-ai","sada","sage-gen2","sage-gen2jp","sage","saguaro","sailor-gen1","sailor-gen1rb","sailor-gen2","sailor-gen3","sailor-gen3jp","sailor-gen3rs","sailor-gen6","sailor","salvatore","samsonoak","sanqua","saturn","sbcmember","schoolboy-gen2","schoolboy","schoolgirl","schoolkid-gen3","schoolkid-gen4","schoolkid-gen4dp","schoolkid-gen6","schoolkid-gen8","schoolkid","schoolkidf-gen3","schoolkidf-gen4","schoolkidf-gen6","schoolkidf-gen8","schoolkidf","scientist-gen1","scientist-gen1rb","scientist-gen2","scientist-gen3","scientist-gen4","scientist-gen4dp","scientist-gen6","scientist-gen7","scientist-gen9","scientist","scientistf-gen6","scientistf","scott","scottie-masters","scubadiver","securitycorps","securitycorpsf","selene-masters","selene-masters2","selene-usum","selene","serena-anime","serena-masters","serena-masters2","serena-masters3","serena","shadowtriad","shauna-masters","shauna","shauntal-masters","shauntal","shelly-gen3","shelly","shielbert","sidney-gen3","sidney","siebold-masters","siebold","sierra","sightseer","sightseerf","silver-gen2","silver-gen2kanto","silver-masters","silver-masters2","silver","sina-gen6","sina","sisandbro-gen3","sisandbro-gen3rs","sisandbro","skier-gen2","skier","skierf-gen4dp","skierf","skullgrunt","skullgruntf","skyla-masters","skyla-masters2","skyla-masters3","skyla","skytrainer","skytrainerf","smasher","soliera","sonia-masters","sonia-masters2","sonia-professor","sonia","sophocles","sordward-shielbert","sordward","spark-casual","spark","spenser-gen3","spenser","srandjr-gen3","stargrunt-s","stargrunt-v","stargruntf-s","stargruntf-v","steven-gen3","steven-gen6","steven-masters","steven-masters2","steven-masters3","steven-masters4","steven-masters5","steven","streetthug-masters","streetthug","striker","supernerd-gen1","supernerd-gen1rb","supernerd-gen2","supernerd-gen3","supernerd","surfer","swimmer-gen1","swimmer-gen1rb","swimmer-gen4","swimmer-gen4dp","swimmer-gen4jp","swimmer-gen6","swimmer-gen7","swimmer-gen8","swimmer-masters","swimmer","swimmerf-gen2","swimmerf-gen3","swimmerf-gen3rs","swimmerf-gen4","swimmerf-gen4dp","swimmerf-gen6","swimmerf-gen7","swimmerf-gen8","swimmerf","swimmerf2-gen6","swimmerf2-gen7","swimmerfjp-gen2","swimmerm-gen2","swimmerm-gen3","swimmerm-gen3rs","sycamore-masters","sycamore","tabitha-gen3","tabitha","tamer-gen1","tamer-gen1rb","tamer-gen3","taohua","tarragon","tate-gen6","tate-masters","tate","tateandliza-gen3","tateandliza-gen6","taunie","teacher-gen2","teacher-gen7","teacher","teamaquabeta-gen3","teamaquagruntf-gen3","teamaquagruntm-gen3","teammagmagruntf-gen3","teammagmagruntm-gen3","teammates","teamrocket","teamrocketgruntf-gen3","teamrocketgruntm-gen3","theroyal","thorton","tierno","tina-masters","toddsnap","toddsnap2","tourist","touristf","touristf2","trace","trevor","trialguide","trialguidef","triathletebiker-gen6","triathletebikerf-gen3","triathletebikerm-gen3","triathleterunner-gen6","triathleterunnerf-gen3","triathleterunnerm-gen3","triathleteswimmer-gen6","triathleteswimmerf-gen3","triathleteswimmerm-gen3","tricia-masters","trinnia-masters","trista-masters","tuber-gen3","tuber-gen6","tuber","tuberf-gen3","tuberf-gen3rs","tuberf-gen6","tuberf","tucker-gen3","tucker","tuli","tulip","turo-ai","turo","twins-gen2","twins-gen3","twins-gen3rs","twins-gen4","twins-gen4dp","twins-gen6","twins","tyme","ultraforestkartenvoy","unknown","unknownf","urbain","valerie","vessa","veteran-gen4","veteran-gen6","veteran-gen7","veteran","veteranf-gen6","veteranf-gen7","veteranf","victor-dojo","victor-league","victor-masters","victor-tundra","victor","vince","viola-masters","viola","volkner-masters","volkner","volo-ginkgo","volo","waiter-gen4","waiter-gen4dp","waiter-gen9","waiter","waitress-gen4","waitress-gen6","waitress-gen9","waitress","wallace-gen3","wallace-gen3rs","wallace-gen6","wallace-masters","wallace","wally-gen3","wally-masters","wally-rse","wally","wattson-gen3","wattson","whitney-gen2","whitney-masters","whitney","wicke","wikstrom","will-gen2","will","willem","willow-casual","willow","winona-gen3","winona-gen6","winona","worker-gen4","worker-gen6","worker-gen7","worker-gen8","worker-gen9","worker-lgpe","worker","worker2-gen6","workerf-gen8","workerice","wulfric","xerosic","yancy","yellgrunt","yellgruntf","yellow","youngathlete","youngathletef","youngcouple-gen3","youngcouple-gen3rs","youngcouple-gen4dp","youngcouple-gen6","youngcouple","youngn","youngster-gen1","youngster-gen1rb","youngster-gen2","youngster-gen3","youngster-gen3rs","youngster-gen4","youngster-gen4dp","youngster-gen6","youngster-gen6xy","youngster-gen7","youngster-gen8","youngster-gen9","youngster-masters","youngster","yukito-hideko","zinnia-masters","zinnia","zinzolin","zirco-unite","zisu","zossie"];

  // Type palettes change colour only. Layout, font, sprite source, animation and
  // shader treatment remain identical, so a theme never compromises readability.
  var THEMES = [
    {id:'default',name:'Default',dot:'#ffffff',p:{'--bg-0':'#080a12','--bg-1':'#0e1220','--bg-2':'#151a2c','--surface':'rgba(255,255,255,.055)','--surface-hi':'rgba(255,255,255,.10)','--surface-press':'rgba(255,255,255,.16)','--ink':'#eef0f8','--ink-2':'#a2aac4','--ink-3':'#6d7590','--gold':'#ffd76e','--blue':'#5b8cff','--green':'#4ade80','--amber':'#facc15','--red':'#ff5f6d','--violet':'#c07ce8'}},
    {id:'normal',name:'Normal',dot:'#a8a77a',p:{'--bg-0':'#171713','--bg-1':'#25251d','--bg-2':'#353528','--gold':'#d9d2a7','--blue':'#aaa984','--green':'#b7ba8c','--amber':'#d7c36e','--red':'#bd7e71','--violet':'#b7a2ae'}},
    {id:'fire',name:'Fire',dot:'#ee8130',p:{'--bg-0':'#1b0907','--bg-1':'#34110a','--bg-2':'#552014','--gold':'#ffd16e','--blue':'#ff754b','--green':'#ffad52','--amber':'#ffcb43','--red':'#ff5d45','--violet':'#eb846f'}},
    {id:'water',name:'Water',dot:'#6390f0',p:{'--bg-0':'#061225','--bg-1':'#0a2342','--bg-2':'#123a69','--gold':'#a9ddff','--blue':'#6390f0','--green':'#62d8cf','--amber':'#8acbff','--red':'#e77c92','--violet':'#a29bff'}},
    {id:'electric',name:'Electric',dot:'#f7d02c',p:{'--bg-0':'#1b1704','--bg-1':'#342b06','--bg-2':'#57460b','--gold':'#fff27a','--blue':'#ffd92c','--green':'#d7ef57','--amber':'#ffcf28','--red':'#ff9466','--violet':'#e7c05b'}},
    {id:'grass',name:'Grass',dot:'#7ac74c',p:{'--bg-0':'#07170b','--bg-1':'#102b15','--bg-2':'#1d4923','--gold':'#cdf27c','--blue':'#70c97d','--green':'#7ac74c','--amber':'#b7d75e','--red':'#df7968','--violet':'#a6d17d'}},
    {id:'ice',name:'Ice',dot:'#96d9d6',p:{'--bg-0':'#071819','--bg-1':'#0d3032','--bg-2':'#185156','--gold':'#d4ffff','--blue':'#7edee7','--green':'#a4eee0','--amber':'#d5f5a0','--red':'#ed8795','--violet':'#aebdff'}},
    {id:'fighting',name:'Fighting',dot:'#c22e28',p:{'--bg-0':'#1d0708','--bg-1':'#3a0d10','--bg-2':'#5a171b','--gold':'#ffb16e','--blue':'#e35047','--green':'#df8a57','--amber':'#ef9c3f','--red':'#ee514c','--violet':'#ce7070'}},
    {id:'poison',name:'Poison',dot:'#a33ea1',p:{'--bg-0':'#180819','--bg-1':'#301034','--bg-2':'#4d1d53','--gold':'#f0a8ed','--blue':'#bd6fe0','--green':'#ba8ee2','--amber':'#e6a55b','--red':'#ef779e','--violet':'#c95dcc'}},
    {id:'ground',name:'Ground',dot:'#e2bf65',p:{'--bg-0':'#1c1307','--bg-1':'#382710','--bg-2':'#59411c','--gold':'#ffe39a','--blue':'#d9a660','--green':'#c6cf70','--amber':'#efbe55','--red':'#e27b55','--violet':'#c99d79'}},
    {id:'flying',name:'Flying',dot:'#a98ff3',p:{'--bg-0':'#100d20','--bg-1':'#201a3e','--bg-2':'#372c65','--gold':'#dfd0ff','--blue':'#a98ff3','--green':'#9dd9d5','--amber':'#e4ba79','--red':'#e9809d','--violet':'#bda7ff'}},
    {id:'psychic',name:'Psychic',dot:'#f95587',p:{'--bg-0':'#210713','--bg-1':'#411025','--bg-2':'#69203d','--gold':'#ffb0ce','--blue':'#fb6aa0','--green':'#e99db9','--amber':'#ffc268','--red':'#ff5a8b','--violet':'#e786dc'}},
    {id:'bug',name:'Bug',dot:'#a6b91a',p:{'--bg-0':'#141906','--bg-1':'#29330a','--bg-2':'#445414','--gold':'#e7f475','--blue':'#b9cd42','--green':'#a6b91a','--amber':'#d2c949','--red':'#dd7d58','--violet':'#c0be68'}},
    {id:'rock',name:'Rock',dot:'#b6a136',p:{'--bg-0':'#191606','--bg-1':'#322d0d','--bg-2':'#524a19','--gold':'#f0df7e','--blue':'#c4ae45','--green':'#b9bf69','--amber':'#d9ac3a','--red':'#d87e58','--violet':'#c8af71'}},
    {id:'ghost',name:'Ghost',dot:'#735797',p:{'--bg-0':'#0d0918','--bg-1':'#1c1331','--bg-2':'#302150','--gold':'#c8a9f5','--blue':'#876cba','--green':'#8aa494','--amber':'#c4a05a','--red':'#d77491','--violet':'#9274c2'}},
    {id:'dragon',name:'Dragon',dot:'#6f35fc',p:{'--bg-0':'#0c071d','--bg-1':'#190d39','--bg-2':'#2c1660','--gold':'#c9adff','--blue':'#7c49ff','--green':'#7bd1b6','--amber':'#b68aff','--red':'#e06d90','--violet':'#9b6cff'}},
    {id:'dark',name:'Dark',dot:'#705746',p:{'--bg-0':'#0d0c0b','--bg-1':'#211d1a','--bg-2':'#382f2a','--gold':'#d5bda4','--blue':'#967461','--green':'#91a071','--amber':'#c69c67','--red':'#cf7669','--violet':'#a5819c'}},
    {id:'steel',name:'Steel',dot:'#b7b7ce',p:{'--bg-0':'#101218','--bg-1':'#202633','--bg-2':'#353d4d','--gold':'#e2e7f2','--blue':'#aebcd8','--green':'#a8c8bd','--amber':'#d5bc7a','--red':'#df8490','--violet':'#b7b7ce'}},
    {id:'fairy',name:'Fairy',dot:'#d685ad',p:{'--bg-0':'#210d1d','--bg-1':'#3f1937','--bg-2':'#642956','--gold':'#ffd0ed','--blue':'#e98ec8','--green':'#b9debc','--amber':'#ffd075','--red':'#f577a4','--violet':'#e59ee9'}}
  ];
  function avatarUrl(id) { return 'https://play.pokemonshowdown.com/sprites/trainers/' + id + '.png'; }
  // profile.avatar can come from an imported backup, so it must be allow-listed
  // against the catalogue before it is ever used in an <img src>.
  function safeAvatar() {
    var a = profile && profile.avatar;
    return AVATARS.indexOf(a) >= 0 ? a : 'red';
  }
  var pendingAvatar = null;
  var avatarPickerFrom = null;   // 'setup' when opened from trainer setup
  function openAvatarPicker(opts) {
    avatarPickerFrom = (opts && opts.from) || null;
    pendingAvatar = safeAvatar();
    var grid = $('avatarModalGrid');
    grid.innerHTML = AVATARS.map(function (id) { var label = id.replace(/^./, function (x) { return x.toUpperCase(); }); return '<button class="avatar-choice' + (id === pendingAvatar ? ' on' : '') + '" data-avatar="' + id + '" title="' + label + '" aria-label="' + label + '"><img loading="lazy" decoding="async" src="' + avatarUrl(id) + '" alt="" onerror="this.onerror=null;this.src=\'https://play.pokemonshowdown.com/sprites/trainers/red.png\'"></button>'; }).join('');
    grid.querySelectorAll('[data-avatar]').forEach(function (b) { b.onclick = function () { pendingAvatar = b.dataset.avatar; grid.querySelectorAll('.avatar-choice').forEach(function (x) { x.classList.toggle('on', x === b); }); }; });
    window.Modal.open('screenAvatarPicker');
  }
  function closeAvatarPicker() { window.Modal.close('screenAvatarPicker'); }
  function applyTheme() {
    if (!profile) return;
    var choice = THEMES.filter(function (t) { return t.id === profile.theme; })[0] || THEMES[0];
    profile.theme = choice.id;
    Object.keys(choice.p).forEach(function (k) { document.documentElement.style.setProperty(k, choice.p[k]); });
    // CTA buttons use the theme's accent color (dot) instead of always white.
    // Default theme stays white for the classic look.
    var cta = choice.dot || '#ffffff';
    document.documentElement.style.setProperty('--cta', cta);
    document.documentElement.style.setProperty('--cta-hi', cta);
    // Readable text: dark on light accents, white on dark accents.
    var isLight = choice.id === 'default' || choice.id === 'electric' ||
                  choice.id === 'ground' || choice.id === 'ice' ||
                  choice.id === 'normal' || choice.id === 'steel';
    document.documentElement.style.setProperty('--cta-text', isLight ? '#080a12' : '#ffffff');
    document.documentElement.style.setProperty('--title-ring', choice.id === 'default' ? '#ffffff' : (choice.p['--blue'] || '#ffffff'));
  }

  // Map each theme to a battlefield biome for "Match theme" mode.
  var THEME_BIOME = {
    'default': 'meadow', 'normal': 'plains', 'fire': 'volcano',
    'water': 'beach', 'electric': 'powerplant', 'grass': 'forest',
    'ice': 'snow', 'fighting': 'dojo', 'poison': 'swamp',
    'ground': 'canyon', 'flying': 'skyclouds', 'psychic': 'psychic',
    'bug': 'garden', 'rock': 'rocky', 'ghost': 'graveyard',
    'dragon': 'ruins', 'dark': 'void', 'steel': 'factory', 'fairy': 'glade'
  };

  function updateMenuAvatar() {
    var src = avatarUrl(safeAvatar());
    var e = $('menuAvatar'); if (e) e.innerHTML = '<img src="' + src + '" alt="">';
    var button = $('menuButtonAvatar'); if (button) button.innerHTML = '<img src="' + src + '" alt="">';
    var titleBtn = $('titleMenuAvatar'); if (titleBtn) titleBtn.innerHTML = '<img src="' + src + '" alt="">';
    var hero = $('menuProfileAvatar'); if (hero) hero.innerHTML = '<img src="' + src + '" alt="">';
  }
  function showProfile() {
    closeMenu(); loadProfile(); applyTheme(); updateMenuAvatar();
    var shinies = profile.shinies.length, av = safeAvatar();
    var cur = run && !run.over ? '<div class="prof-now"><div class="pd-label">Current run</div><div class="prof-grid">' + statCard(run.battlesWon || 0, 'Battles won') + statCard('S' + (run.section || 1), 'Section') + statCard(run.caught || 0, 'Caught') + statCard('$' + (run.money || 0).toLocaleString(), 'Cash') + '</div></div>' : '<p class="hint center">No run in progress.</p>';
    var bf = profile.battlefield || 'dynamic';
    $('profBody').innerHTML = '<div class="profile-hero"><div class="profile-avatar"><img src="' + avatarUrl(av) + '" alt="Avatar"></div><div style="flex:1"><div class="profile-name">' + escapeHtml(profile.name || 'Trainer Profile') + '</div><div class="profile-sub">Customize your look and game theme</div></div><button id="editAvatar" class="btn-mini">Edit sprite</button></div>' +
      '<div class="profile-section">Theme</div><div class="theme-grid">' + THEMES.map(function (t) { return '<button class="theme-choice' + (t.id === (profile.theme || 'default') ? ' on' : '') + '" data-theme="' + t.id + '" style="--theme-dot:' + t.dot + '"><span class="theme-dot"></span>' + t.name + '</button>'; }).join('') + '</div>' +
      '<div class="profile-section">Battlefield</div>' +
      '<div class="bf-toggle">' +
        '<button class="bf-btn' + (bf === 'dynamic' ? ' on' : '') + '" data-bf="dynamic"><b>Dynamic</b><span>Biome from enemy types</span></button>' +
        '<button class="bf-btn' + (bf === 'match' ? ' on' : '') + '" data-bf="match"><b>Match theme</b><span>Battlefield follows your theme</span></button>' +
      '</div>' +
      '<div class="profile-section">Sound</div><div class="vol-group">' + volumeRow('music', 'Music', 'Battle themes') + volumeRow('sfx', 'Sound effects', 'Cries and battle sounds') + '</div>' +
      '<div class="profile-section">Career</div><div class="prof-grid big">' + statCard(profile.totalRuns, 'Runs played') + statCard(profile.bestBattles, 'Best battles') + statCard('S' + profile.bestSection, 'Furthest') + statCard(shinies, 'Shinies') + '</div>' + cur;
    $('editAvatar').onclick = openAvatarPicker;
    wireVolumeRows($('profBody'));
    // Full gallery is rendered only inside the dedicated sheet.
    $('profBody').querySelectorAll('[data-theme]').forEach(function (b) { b.onclick = function () { profile.theme = b.dataset.theme; saveProfile(); applyTheme(); showProfile(); }; });
    $('profBody').querySelectorAll('[data-bf]').forEach(function (b) { b.onclick = function () { profile.battlefield = b.dataset.bf; saveProfile(); showProfile(); }; });
    show('Profile');
  }

  function statCard(v, k) {
    return '<div class="prof-stat"><span class="v">' + v + '</span><span class="k">' + k + '</span></div>';
  }

  // ---- VOLUME SLIDERS ------------------------------------------------------
  // Backed by GameAudio (its own localStorage key), not by the profile: sound
  // settings are a device preference and shouldn't ride along with a profile
  // that syncs shinies and run history.
  function volumeValue(which) {
    if (!window.GameAudio) return which === 'music' ? 0.35 : 0.7;
    return which === 'music' ? window.GameAudio.getMusic() : window.GameAudio.getSfx();
  }
  function volumeRow(which, label, sub) {
    var pct = Math.round(volumeValue(which) * 100);
    return '<div class="vol-row" data-vol="' + which + '">' +
      '<div class="vol-head"><span class="vol-label">' + label + '</span>' +
      '<span class="vol-pct" data-volpct="' + which + '">' + pct + '%</span></div>' +
      '<input class="vol-slider" type="range" min="0" max="100" step="1" value="' + pct + '" ' +
      'data-volinput="' + which + '" aria-label="' + escapeHtml(label) + ' volume"/>' +
      '<div class="vol-sub">' + sub + '</div></div>';
  }
  function wireVolumeRows(root) {
    if (!root) return;
    root.querySelectorAll('[data-volinput]').forEach(function (input) {
      var which = input.dataset.volinput;
      var pctEl = root.querySelector('[data-volpct="' + which + '"]');
      function apply() {
        var v = Number(input.value) / 100;
        if (pctEl) pctEl.textContent = Math.round(v * 100) + '%';
        if (!window.GameAudio) return;
        if (which === 'music') window.GameAudio.setMusic(v);
        else window.GameAudio.setSfx(v);
      }
      // `input` updates live while dragging so the music responds under the
      // thumb; `change` catches keyboard use and the end of a drag.
      input.addEventListener('input', apply);
      input.addEventListener('change', function () {
        apply();
        // Audible reference point for a slider whose effect is otherwise
        // silent outside battle.
        if (which === 'sfx' && window.GameAudio) window.GameAudio.playSfx(SFX_PREVIEW, 0.5);
      });
    });
  }
  var SFX_PREVIEW = 'https://play.pokemonshowdown.com/audio/cries/pikachu.mp3';

  function showShinies() {
    closeMenu();
    loadProfile();
    var list = profile.shinies.slice().reverse();
    $('shinySub').textContent = list.length
      ? list.length + ' registered \u00b7 1 in 512 chance per encounter'
      : '';
    if (!list.length) {
      $('shinyGrid').innerHTML =
        '<div class="shiny-empty">' +
          '<div class="se-spark"></div>' +
          '<b>No shinies yet</b>' +
          '<p>Wild Pokemon and your starter each have a <b>1 in 512</b> chance of ' +
          'being shiny. Shinies are <b>always catchable</b> and never break free \u2014 ' +
          'even outside a capture encounter.</p>' +
        '</div>';
      show('Shinies'); return;
    }
    $('shinyGrid').innerHTML = list.map(function (sh) {
      var when = new Date(sh.at);
      return '<div class="shiny-card">' +
        '<span class="sc-star"></span>' +
        '<div class="sc-art">' + animSprite(sh.id, 72, 84, '', 1.4, true) + '</div>' +
        '<div class="sc-nm">' + escapeHtml(sh.name) + '</div>' +
        '<div class="sc-sp">' + escapeHtml(sh.species) + '</div>' +
        '<div class="types">' + typeChips(sh.types || []) + '</div>' +
        '<div class="sc-meta">' + (sh.how === 'starter' ? 'Starter' : 'Section ' + sh.section) +
          ' \u00b7 ' + when.toLocaleDateString() + '</div>' +
      '</div>';
    }).join('');
    show('Shinies');
  }

  function showRules() {
    closeMenu();
    var face = $('rulesFace');
    if (face && window.Coach) face.innerHTML = window.Coach.advisorImg(32);
    show('Rules');
  }

  // ---------------------------------------------------------------- GUIDE --
  // Every lesson, permanently re-readable, grouped the way a person would
  // look for them. This is what licenses the game to stop nagging: if someone
  // gets stuck later, the answer is here rather than on a wiki.
  var GUIDE_GROUPS = [
    ['basics',   'The basics'],
    ['battle',   'In battle'],
    ['catching', 'Catching'],
    ['items',    'Items & the Mart'],
    ['training', 'Training & evolving'],
    ['saving',   'Keeping your progress']
  ];

  function showGuide() {
    closeMenu();
    var CO = window.Coach;
    if (!CO) { show('Title'); return; }
    var face = $('guideFace');
    if (face) face.innerHTML = CO.advisorImg(44);
    var who = $('guideWho');
    if (who) who.textContent = CO.ADVISOR.name;

    var body = $('guideBody');
    var html = '';
    GUIDE_GROUPS.forEach(function (g) {
      var items = CO.LESSONS.filter(function (l) { return l.where === g[0]; });
      if (!items.length) return;
      html += '<div class="guide-group"><h3 class="guide-group-title">' + escapeHtml(g[1]) + '</h3>';
      items.forEach(function (l) {
        var read = CO.seen(l.id);
        html += '<button type="button" class="guide-card" data-lesson="' + l.id + '">' +
          '<span class="coach-portrait">' + CO.advisorImg(30) + '</span>' +
          '<span class="gc-t"><b>' + escapeHtml(l.title) + '</b>' +
            '<em>' + escapeHtml(stripTags((l.say ? l.say + ' ' : '') + l.body).slice(0, 74)) + '\u2026</em></span>' +
          '<span class="gc-state' + (read ? ' seen' : '') + '">' + (read ? 'Read' : 'New') + '</span>' +
          '</button>';
      });
      html += '</div>';
    });

    // The three modes get their own cards at the end.
    html += '<div class="guide-group"><h3 class="guide-group-title">Game modes</h3>';
    ['daily', 'free', 'gauntlet'].forEach(function (m) {
      var info = CO.modeInfo(m);
      if (!info) return;
      html += '<button type="button" class="guide-card" data-mode="' + m + '">' +
        '<span class="coach-portrait">' + CO.advisorImg(30) + '</span>' +
        '<span class="gc-t"><b>' + escapeHtml(info.title) + '</b>' +
          '<em>' + escapeHtml(info.lede) + '</em></span></button>';
    });
    html += '</div>';

    body.innerHTML = html;
    body.querySelectorAll('[data-lesson]').forEach(function (b) {
      b.addEventListener('click', function () { CO.replay(b.dataset.lesson); });
    });
    body.querySelectorAll('[data-mode]').forEach(function (b) {
      b.addEventListener('click', function () {
        var info = CO.modeInfo(b.dataset.mode);
        if (!info) return;
        CO.sheet({
          title: info.title,
          body: '<p>' + escapeHtml(info.lede) + '</p>' + info.points.map(function (p) {
            return '<p><b>' + escapeHtml(p[0]) + '.</b> ' + escapeHtml(p[1]) + '</p>';
          }).join('')
        }, { force: true, noSkip: true, eyebrow: 'Game mode' });
      });
    });
    show('Guide');
  }

  function stripTags(s) { return String(s || '').replace(/<[^>]*>/g, ''); }

  // History has two halves now: the dated Daily record (calendar + streak) and
  // the old all-runs list. A tab keeps both reachable without a new screen.
  var histTab = 'daily';

  function showHistory() {
    closeMenu();
    loadProfile();
    drawHistory();
    show('History');
  }

  function drawHistory() {
    var body = $('histBody');
    body.innerHTML =
      '<div class="hist-tabs" role="tablist">' +
        '<button type="button" class="hist-tab' + (histTab === 'daily' ? ' on' : '') +
          '" data-tab="daily" role="tab" aria-selected="' + (histTab === 'daily') + '">Daily</button>' +
        '<button type="button" class="hist-tab' + (histTab === 'all' ? ' on' : '') +
          '" data-tab="all" role="tab" aria-selected="' + (histTab === 'all') + '">All runs</button>' +
      '</div>' +
      (histTab === 'daily' ? dailyHistoryHtml() : allRunsHtml());
    body.querySelectorAll('[data-tab]').forEach(function (b) {
      b.addEventListener('click', function () { histTab = b.dataset.tab; drawHistory(); });
    });
  }

  function dailyHistoryHtml() {
    var D = window.Daily;
    var st = D.stats();
    var cal = D.calendar(35);
    var store = D.load();
    var keys = Object.keys(store.results).sort().reverse().slice(0, 30);

    var html = '<div class="daily-stats">' +
      statCard(st.streak, 'Streak') +
      statCard(st.best, 'Best streak') +
      statCard(st.completed, 'Cleared') +
      statCard(st.winRate + '%', 'Clear rate') +
    '</div>';

    html += '<div class="cal-wrap">' +
      '<div class="cal-head"><span class="cal-title">Last 5 weeks</span></div>' +
      '<div class="cal-grid">' + cal.map(function (c) {
        var cls = 'cal-cell' + (c.outcome ? ' ' + c.outcome : '') + (c.isToday ? ' today' : '');
        var label = c.date + (c.outcome
          ? (c.outcome === 'complete' ? ' \u2014 cleared' : ' \u2014 fell in section ' + c.sections)
          : ' \u2014 not played');
        return '<div class="' + cls + '" title="' + label + '" aria-label="' + label + '">' + c.day + '</div>';
      }).join('') + '</div>' +
      '<div class="cal-legend">' +
        '<span><i class="cal-dot complete"></i>Cleared</span>' +
        '<span><i class="cal-dot wipe"></i>Fell short</span>' +
        '<span><i class="cal-dot"></i>Not played</span>' +
      '</div>' +
    '</div>';

    if (!keys.length) {
      return html + '<p class="hint center">No Dailies played yet. Today\u2019s is waiting.</p>';
    }
    html += keys.map(function (k) {
      var r = store.results[k];
      var d = D.parseKey(k);
      var fmt = k;
      try {
        fmt = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      } catch (e) {}

      return '<div class="hist-row">' +
        '<div class="hr-main">' +
          '<div class="hr-top">' +
            '<b>' + fmt + '</b>' +
            '<span class="hr-badge ' + r.outcome + '">' +
              (r.outcome === 'complete' ? 'Cleared' : 'Fell at S' + r.sections) +
            '</span>' +
          '</div>' +
          '<div class="hr-sub">' +
            r.battles + ' battles \u00b7 ' +
            r.caught + ' caught \u00b7 ' +
            r.lost + ' lost' +
          '</div>' +
        '</div>' +
        rosterRowHtml(r.roster, r.mvp ? r.mvp.id : null) +
      '</div>';
    }).join('');
    return html;
  }

  function allRunsHtml() {
    var h = profile.history;
    if (!h.length) {
      return '<p class="hint center">No finished runs yet. ' +
        'A run is recorded when your last Pokemon falls.</p>';
    }
    return h.map(function (r, i) {
      var d = new Date(r.at);
      var fmt = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      return '<div class="hist-row">' +
        '<div class="hr-main">' +
          '<div class="hr-top">' +
            '<b>' + fmt + '</b>' +
            '<span class="hr-badge wipe">Fell at S' + r.section + '</span>' +
          '</div>' +
          '<div class="hr-sub">' +
            'Run #' + (h.length - i) + ' \u00b7 ' +
            r.battles + ' battles \u00b7 ' +
            r.caught + ' caught \u00b7 ' +
            r.trainers + ' trainers' +
          '</div>' +
        '</div>' +
        rosterRowHtml(r.roster, r.mvp ? r.mvp.id : null) +
      '</div>';
    }).join('');
  }

  // ---- NICKNAME PROMPT -----------------------------------------------------
  // Every Pokemon the player owns must be nicknamed. `mon.name` is the
  // nickname (the battle engine echoes it in its messages); `mon.species`
  // keeps the real species and is shown as the caption above it.
  var nickCb = null;
  function askNickname(mon, onDone) {
    nickCb = onDone;
    var species = C.cleanName(mon.id);
    $('nickSprite').innerHTML = bigSprite(mon.id, '', 126, 190, 1, mon.shiny);
    $('nickSpecies').textContent = species;
    $('nickTypes').innerHTML = typeChips(mon.types);
    var input = $('nickInput');
    input.value = '';
    input.placeholder = species;
    input.maxLength = 12;
    // Oak explains nicknames for the starter and the player's FIRST capture.
    // Later catches keep the mandatory name field but not the repeated
    // tutorial speech. `run.caught` is incremented immediately before the
    // catch screen opens, so exactly 1 identifies that first capture.
    var isStarterNickname = !!(run && run.prologue && !$('screenStarter').hidden);
    var isFirstCaptureNickname = !!(run && run.prologue && run.caught === 1 && !$('screenCatch').hidden);
    var hint = $('nickHint');
    if (hint) {
      hint.hidden = !(isStarterNickname || isFirstCaptureNickname);
      hint.innerHTML = hint.hidden ? '' :
        '<span class="nick-guide-chat">' +
          (isFirstCaptureNickname
            ? 'Your first catch! Give your new friend a name to remember.'
            : 'A wonderful choice! Every great trainer gives their Pokemon a name to remember.') +
        '</span><span class="coach-portrait nick-guide-professor">' +
        (window.Coach ? window.Coach.advisorImg(104) : '') + '</span>';
    }
    // Naming is mandatory -- there is no cancel -- so Escape and a backdrop
    // click must NOT dismiss this one. While naming a starter, give the dialog
    // its dedicated transparent layer above the three choices (and any retiring
    // coach layer). CSS keeps it in the standard bottom-sheet position on
    // phones, with the raised treatment reserved for wider screens.
    var el = $('screenNickname');
    el.classList.toggle('starter-nickname', isStarterNickname);
    window.Modal.open(el, {
      initialFocus: el.querySelector('.overlay-card'),
      escape: false,
      dismissOnScrim: false
    });
  }

  function confirmNickname() {
    var input = $('nickInput');
    var val = String(input.value || '').trim().replace(/\s+/g, ' ').slice(0, 12);
    if (!val) val = input.placeholder;           // never allow an empty name
    if (!val) { toast('Please enter a nickname.'); return; }
    window.Modal.close('screenNickname');
    var cb = nickCb; nickCb = null;
    if (cb) cb(val);
  }

  // ---- ITEM TARGET PICKER --------------------------------------------------
  // Select an item, then tap the Pokemon to use/give it to. No prompts.
  var picker = null;   // {itemId, mode:'use'|'give', step:'mon'|'move', mon}

  function useFromBag(itemId) {
    if (!run.party.length) return;
    var kind = bagGroupOf(itemId);
    // Evolution and forme items are now "used on" a Pokemon exactly like a
    // Full Restore, instead of only being reachable from the party detail panel.
    var mode = (kind === 'heal') ? 'use'
             : (kind === 'evo' || kind === 'forme') ? 'evolve'
             : 'give';
    var thisPicker = { itemId: itemId, mode: mode, step: 'mon', mon: null };
    // Re-opening an already-open sheet is a no-op for Modal.open (it would
    // keep the stale onClose); close any existing picker sheet first.
    if (window.Modal.isOpen('screenPicker')) window.Modal.close('screenPicker');
    picker = thisPicker;
    drawPicker();
    window.Modal.open('screenPicker', {
      onClose: function () { if (picker === thisPicker) picker = null; }
    });
  }

  // A battle reward item is used or given from this target sheet, which opens
  // over the reward screen. The player CAN cancel: closing the sheet (Cancel,
  // Escape, scrim tap) before a target is chosen gives the pick back -- the
  // item added on card click is returned and the reward cards are live again,
  // so a different card (or the cash bundle) can be chosen. Once a target is
  // chosen the choice is locked in by closePicker's commit path, so a
  // cancellation can never refund an item already used or given.
  function openRewardItemPicker(entry) {
    if (!run || !entry || !run.party.length) return;
    var mode = entry.kind === 'evo' ? 'evolve' : 'give';
    var thisPicker = { itemId: entry.id, mode: mode, step: 'mon', mon: null, fromReward: true };
    // A re-pick right after a cancelled sheet would Modal.open() onto an
    // already-open sheet (a no-op that keeps the stale onClose). Close it
    // first; the old onClose no-ops because it is keyed to its own instance.
    if (window.Modal.isOpen('screenPicker')) window.Modal.close('screenPicker');
    picker = thisPicker;
    rewardChoicePending = entry;
    drawPicker();
    var cancelBtn = $('btnPickerCancel');
    if (cancelBtn) cancelBtn.hidden = false;
    // Key the close logic to this picker instance. A dismiss (Cancel /
    // Escape / scrim) leaves rewardDone unset and returns the held item,
    // re-enabling every reward card; a resolution path (closePicker) sets
    // rewardDone so the card stays locked and the item is spent in place.
    window.Modal.open('screenPicker', {
      escape: true, dismissOnScrim: true,
      onClose: function () {
        if (picker !== thisPicker) return;
        var committed = !!thisPicker.rewardDone;
        picker = null;
        if (cancelBtn) cancelBtn.hidden = false;
        if (!committed) cancelRewardChoice();
      }
    });
  }

  // ---- reward choice state ------------------------------------------------
  // rewardChoicePending: the card currently being resolved (sheet open or
  //   full-screen evolution running). Not yet a choice -- a cancel walks it
  //   back. rewardEvoPending: a reward-triggered evolution/forme sequence is
  //   playing; its Done button returns to the reward screen to finalise.
  var rewardChoicePending = null;
  var rewardEvoPending = null;
  // True while the full-screen Evolve view is showing a reward-triggered
  // morph: the Done button returns to the reward screen, not the crossroads.
  var rewardEvoOnScreen = false;

  // The picker was closed without using the item. Return the held copy and
  // make every reward card clickable again, so the player can make a
  // different choice instead of being locked into the card they first tapped.
  function cancelRewardChoice() {
    var entry = rewardChoicePending;
    rewardChoicePending = null;
    if (!entry) return;
    // The card click added exactly one copy "on hold". Take it back -- unless
    // a commit path already spent it (committed choices never route here).
    N.useItem(run, entry.id);
    var note = $('rewardBody').querySelector('.reward-pick-note');
    if (note) note.textContent = 'Select one reward to continue.';
    $('rewardBody').querySelectorAll('[data-reward-id]').forEach(function (node) {
      node.disabled = false;
      node.classList.remove('picked');
    });
    $('btnRewardDone').disabled = true;
    renderHud(); saveGame();
  }

  // The picked reward is spent (item given/used, or cash taken). Lock every
  // card so the choice cannot be re-made or swapped for the cash bundle.
  function commitRewardChoice(entryId) {
    rewardChoicePending = null;
    $('rewardBody').querySelectorAll('[data-reward-id]').forEach(function (node) {
      node.disabled = true;
      if (entryId) node.classList.toggle('picked', node.dataset.rewardId === entryId);
    });
    var doneBtn = $('btnRewardDone');
    if (doneBtn) doneBtn.disabled = false;
  }

  // What would this item do to this Pokemon? Returns { note, dis } so the
  // picker can grey out targets the item cannot affect, with the reason shown
  // inline rather than only as a toast after a wasted tap.
  function itemEffectOn(itemId, mon) {
    var kind = bagGroupOf(itemId);

    if (kind === 'evo' || kind === 'forme') {
      var targets = evoTargetsFor(itemId, mon);
      if (!targets.length) return { note: 'no effect', dis: true };
      // Show WHAT it becomes as a silhouette, not as a spoiler string. Forme
      // changes are revealed (they are cosmetic and reversible); true
      // evolutions stay hidden until the animation plays.
      var t0 = targets[0];
      return { note: (targets.length > 1 ? targets.length + ' options' : ''),
               dis: false,
               art: evoPreviewHtml(mon.id, t0.id, { reveal: t0.kind === 'forme' }) };
    }

    var h = C.HEAL_ITEMS[itemId];
    if (h) {
      if (h.revive) return { note: 'gone for good', dis: true };
      if (C.isFainted(mon)) return { note: 'has fainted', dis: true };
      // Full Restore heals AND cures, so it is useful if either applies.
      var missing = C.maxHP(mon) - C.curHP(mon);
      var parts = [], useful = false;
      if (h.healPct) {
        if (missing > 0) {
          parts.push('heals ' + Math.min(C.healAmountFor(itemId, mon), missing) + ' HP');
          useful = true;
        } else parts.push('already at full HP');
      }
      if (h.cure) {
        var cures = mon.status && (h.cure === 'all' || h.cure === mon.status);
        if (cures) { parts.push('cures ' + mon.status.toUpperCase()); useful = true; }
        else if (!h.healPct) parts.push(mon.status ? 'wrong status' : 'no status to cure');
      }
      if (h.pp || h.ppAll) {
        var low = mon.moves.some(function (mv) {
          var mx = Math.floor(Dex.moves.get(mv).pp * 1.6);
          return (mon.pp[mv] != null ? mon.pp[mv] : mx) < mx;
        });
        if (low) { parts.push('restores PP'); useful = true; }
        else parts.push('all PP full');
      }
      return { note: parts.join(' \u00b7 ') || 'no effect', dis: !useful };
    }

    // held item: show WHAT it is holding as art, not as a sentence
    if (mon.item) {
      return { note: '',
               dis: false,
               art: '<span class="held-art" title="' + Dex.items.get(mon.item).name + '">' +
                      (window.ItemArt ? window.ItemArt.itemImg(mon.item, 26) : '') +
                    '</span>' };
    }
    return { note: 'no held item', dis: false };
  }

  // Every evolution / forme target this item unlocks for this Pokemon.
  function evoTargetsFor(itemId, mon) {
    var out = [];
    if (window.Evo) {
      window.Evo.optionsFor(mon).forEach(function (o) {
        var r = o.requirement;
        if (!r || r.item !== itemId) return;
        // the extra held item (if any) must also be available
        if (r.extraItem && !run.bag[r.extraItem] && window.PS.toID(mon.item || "") !== r.extraItem) return;
        out.push({ kind: 'evo', id: o.id, name: o.species || o.name, opt: o });
      });
    }
    if (window.Forme && window.Forme.isFormeItem(itemId)) {
      window.Forme.targetsFor(mon, itemId).forEach(function (t) {
        out.push({ kind: 'forme', id: t.id, name: t.name });
      });
    }
    return out;
  }


  // closePicker() closes a RESOLVED picker: the item was used/given or a
  // evolution target was chosen. rewardDone marks that for a reward picker
  // so the modal's onClose handler knows not to refund. Cancel, Escape and
  // scrim taps never set it -- they close via dismissPicker().
  function closePicker() {
    if (picker && picker.fromReward) picker.rewardDone = true;
    window.Modal.close('screenPicker');
  }

  // A genuine dismissal (Cancel button / Escape / scrim tap). The modal's
  // onClose distinguishes this from closePicker() via rewardDone and refunds
  // a reward item that was only on hold, so the reward cards go live again.
  function dismissPicker() {
    window.Modal.close('screenPicker');
  }

  function drawPicker() {
    if (!picker) return;
    var id = picker.itemId;
    var art = window.ItemArt ? window.ItemArt.itemImg(id, 40) : '';
    $('pickerTitle').innerHTML = art + '<span>' + itemName(id) +
      itemPlainHtml(id, 'pick-plain') + '</span>';

    if (picker.step === 'move') {
      var mon = picker.mon;
      $('pickerSub').textContent = 'Restore which move?';
      $('pickerBody').innerHTML = mon.moves.map(function (mv, i) {
        var d = Dex.moves.get(mv);
        var mx = Math.floor(d.pp * 1.6), cur = mon.pp[mv] != null ? mon.pp[mv] : mx;
        var full = cur >= mx;
        return '<button class="pick-row" data-mv="' + i + '"' + (full ? ' disabled' : '') + '>' +
          '<span class="mv-chip type-' + d.type + '">' + d.type + '</span>' +
          '<b>' + d.name + '</b>' +
          '<span class="pick-meta">' + cur + '/' + mx + ' PP' + (full ? ' (full)' : '') + '</span></button>';
      }).join('');
      $('pickerBody').querySelectorAll('.pick-row').forEach(function (b) {
        b.addEventListener('click', function () {
          applyPicked(picker.mon, mon.moves[+b.dataset.mv]);
        });
      });
      return;
    }

    var verb = picker.mode === 'give' ? 'Give to which Pokemon?'
             : picker.mode === 'evolve' ? 'Use on which Pokemon?'
             : 'Use on which Pokemon?';
    $('pickerSub').textContent = verb;
    $('pickerBody').innerHTML = run.party.map(function (m, i) {
      var pct = pctHP(m.hpPct);
      var col = m.hpPct > 0.5 ? '#4ade80' : m.hpPct > 0.2 ? '#facc15' : '#ef4444';
      var eff = itemEffectOn(id, m);
      var note = eff.note, dis = eff.dis;
      return '<button class="pick-row mon' + (eff.art ? ' has-art' : '') + '" data-i="' + i + '"' +
        (dis ? ' disabled' : '') + '>' +
        iconEl(m.id, 1.2, '', m.shiny) +
        '<div class="pick-info"><b>' + escapeHtml(m.name) + '</b>' +
          '<div class="pick-hp"><i style="width:' + pct + '%;background:' + col + '"></i></div>' +
          '<span class="pick-meta">' + C.curHP(m) + '/' + C.maxHP(m) +
          (m.status ? ' \u00b7 ' + m.status.toUpperCase() : '') + '</span></div>' +
        (eff.art ? '<span class="pick-art">' + eff.art + '</span>' : '') +
        '<span class="pick-note">' + note + '</span></button>';
    }).join('');
    $('pickerBody').querySelectorAll('.pick-row').forEach(function (b) {
      b.addEventListener('click', function () {
        var mon = run.party[+b.dataset.i];
        if (picker.mode === 'evolve') { startEvoFromBag(picker.itemId, mon); return; }
        var h = C.HEAL_ITEMS[picker.itemId];
        if (h && h.pp) { picker.mon = mon; picker.step = 'move'; drawPicker(); return; }
        applyPicked(mon, null);
      });
    });
  }

  // An evolution / forme item used from the Bag. If the item unlocks more than
  // one target (Rotom Catalog, Eevee stones with regional splits) ask which,
  // otherwise go straight into the animation.
  function startEvoFromBag(itemId, mon) {
    var targets = evoTargetsFor(itemId, mon);
    if (!targets.length) { toast('That has no effect on ' + mon.name + '.'); return; }
    if (targets.length === 1) { runEvoTarget(itemId, mon, targets[0]); return; }
    picker.step = 'target'; picker.mon = mon; picker.targets = targets;
    $('pickerSub').textContent = 'Change ' + mon.name + ' into?';
    $('pickerBody').innerHTML = targets.map(function (t, i) {
      return '<button class="pick-row" data-t="' + i + '">' +
        evoPreviewHtml(mon.id, t.id, { reveal: t.kind === 'forme' }) +
        '<b>' + (t.kind === 'forme' ? t.name : '???') + '</b>' +
        '<span class="pick-meta">' + (t.kind === 'forme' ? 'forme change' : 'evolution') +
        '</span></button>';
    }).join('');
    $('pickerBody').querySelectorAll('.pick-row').forEach(function (b) {
      b.addEventListener('click', function () {
        runEvoTarget(itemId, picker.mon, picker.targets[+b.dataset.t]);
      });
    });
  }

  function runEvoTarget(itemId, mon, t) {
    // An evolution/forme item picked as a battle reward now plays the SAME
    // full-screen morph sequence as the Bag path. The sequence remembers it
    // was launched from the reward (rewardEvoPending) so its Done button
    // returns to the reward screen instead of the crossroads, and the reward
    // choice only locks in once the morph resolves.
    if (picker && picker.fromReward) {
      rewardEvoPending = { itemId: itemId, mon: mon, target: t };
      closePicker();
      if (t.kind === 'forme') { startFormeChange(mon, itemId, t.id); return; }
      startEvolution(mon, t.opt);
      return;
    }
    closePicker();
    if (t.kind === 'forme') { startFormeChange(mon, itemId, t.id); return; }
    startEvolution(mon, t.opt);
  }

  // Finalise a reward whose evolution/forme sequence just ended: lock the
  // cards, report the result where the player is looking, and leave the
  // reward screen's Continue as the only way forward.
  function finalizeRewardEvolution(noteText) {
    var pending = rewardEvoPending;
    rewardEvoPending = null;
    var entry = pending && rewardChoicePending;
    rewardChoicePending = null;
    commitRewardChoice(entry ? entry.id : null);
    if (noteText) {
      var note = $('rewardBody').querySelector('.reward-pick-note');
      if (note) note.textContent = noteText;
    }
    renderHud(); saveGame();
  }

  function applyPicked(mon, moveId) {
    var fromReward = !!(picker && picker.fromReward);
    var itemId = picker.itemId;
    var res = N.applyItem(run, itemId, mon, moveId);
    toast(res.msg);
    if (fromReward) {
      // The reward item was given/held just now -- echo it where the player
      // is looking instead of only in a toast, and lock the reward choice in
      // the same instant.
      var entry = rewardChoicePending;
      closePicker();
      rewardChoicePending = null;
      commitRewardChoice(entry ? entry.id : null);
      var note = $('rewardBody').querySelector('.reward-pick-note');
      if (note) note.textContent = res.msg;
    } else {
      closePicker();
    }
    renderCrossroads(); renderHud(); saveGame();
  }

  // ------------------------------------------------------------ BATTLES ---
  // True only between an auto-resumed battle being spun up and its first
  // request: handleRequest() uses it to re-apply saved HP/status to the HUD
  // once, then clears it. A module flag rather than a field on `run` so it can
  // never be persisted into a save or leak into a later battle.
  var resumePending = false;

  function teardownBattleUI() {
    resumePending = false;
    flushBattleSave();
    clearQueue();
    if (battleRendererRecoveryTimer) {
      clearTimeout(battleRendererRecoveryTimer);
      battleRendererRecoveryTimer = null;
    }
    battleRendererRecovering = false;
    battleRendererRecoveryAttempts = 0;
    if (ui) { try { ui.unmount(); } catch (e) {} ui = null; }
    var h = $('battleHost'); if (h) h.innerHTML = '';
  }
  function ensureUI() {
    if (ui && !ui._disposed && ui.s && ui.s.mounted) return ui;
    // A context-lost instance is not reusable even though BattleUI has not
    // marked it disposed yet. Dispose it before replacing it so its dead
    // canvas and resize listener cannot compete with the fresh renderer.
    if (ui) { try { ui.unmount(); } catch (e) {} ui = null; }
    var host = $('battleHost');
    if (!host) throw new Error('battle host element is missing');
    if (!window.BattleUI) throw new Error('battle renderer failed to load');
    host.innerHTML = '';
    host._bm = null;
    // Force a reflow so the host reports real dimensions. Without this,
    // show('Battle') just removed [hidden] and the browser hasn't laid out
    // #battleHost yet — mount() would see 0×0 and defer via rAF, causing
    // setupBattle to queue and the battle to appear stuck (no biome, no
    // sprites, no moves).
    void host.offsetHeight;
    ui = new window.BattleUI();
    // Install the callback BEFORE mount(). A context can be lost while the
    // renderer is being created (especially when the browser is reclaiming
    // GPU memory), so assigning it afterwards leaves a narrow white-screen
    // race.
    ui.onContextLost = function (lostUI) {
      handleBattleContextLost(lostUI || ui);
    };
    ui.onMountError = function (owner, err) {
      handleBattleRendererFailure(owner || ui, err);
    };
    ui.onError = function (owner, err) {
      handleBattleRendererFailure(owner || ui, err);
    };
    ui.onContextRestored = function (owner) {
      handleBattleContextRestored(owner || ui);
    };
    ui.mount(host);
    if (ui._mountFailed) throw ui._mountFailedError || new Error('The battle renderer failed to mount.');
    // The layered CSS battlefield is always present. WebGL can attach now or
    // later without changing the player's battle surface or showing an error.
    // Keep tutorial annotations glued across HUD re-renders: any redraw
    // (sprites loading, HP bars settling, ...) replaces the exact nodes a
    // coach glow or bubble points at. Re-pinning only per battle request
    // would leave the taught control dark for the rest of the turn.
    var baseRender = ui.render.bind(ui);
    ui.render = function () {
      var ret = baseRender.apply(null, arguments);
      try { repinTutGlow(); } catch (e) {}
      return ret;
    };
    return ui;
  }

  // Sync live battle HP/status back to run.party so closing mid-fight
  // doesn't let the player cheat by restoring full HP on reload.
  //
  // NEVER walk `p1.pokemon` by index here. Showdown REORDERS a side's party
  // array on every switch (the mon coming in is swapped into the outgoing
  // mon's slot), so `p1.pokemon[i]` stops matching `run.party[i]` the moment
  // anyone switches -- including the forced switch after the lead faints.
  // Doing so wrote the incoming Pokemon's healthy HP onto the dead lead and
  // the dead lead's 0 HP onto whoever now sat at that index: the lead came
  // back to life and an innocent party member was buried in its place.
  //
  // The engine wrapper already owns a stable identity mapping (a tag stamped
  // on each live Pokemon), and it syncs straight into the very objects in
  // `run.party` (they are passed in as `playerMons`). So delegate to it.
  function syncBattleToRun() {
    if (!battle || !battle.battle || !run) return;
    try {
      battle.sync();
      // Mirror the (now up-to-date) enemy state into _battleCfg for resume.
      // bctx.enemies IS the array handed to the engine, so `battle.sync()`
      // has already refreshed it by identity -- copy it across positionally,
      // which is safe because both arrays are ours and never reordered.
      var cfgEnemies = run._battleCfg && run._battleCfg.enemies;
      var liveEnemies = bctx && bctx.enemies;
      if (cfgEnemies && liveEnemies) {
        for (var i = 0; i < Math.min(cfgEnemies.length, liveEnemies.length); i++) {
          if (!cfgEnemies[i] || !liveEnemies[i]) continue;
          cfgEnemies[i].hpPct = Math.max(0, liveEnemies[i].hpPct != null ? liveEnemies[i].hpPct : 1);
          cfgEnemies[i].status = liveEnemies[i].status || '';
        }
      }
    } catch (e) {}
  }

  // Guards against a second battle being spun up while the first is still
  // rolling its team (double-tap on "Battle", or a stray keyboard activation).
  // Two concurrent runs of this used to fight over `bctx`/`battle` and leave
  // the screen wedged.
  var battleStarting = false;
  // A context loss is recoverable without rerolling the encounter. Keep this
  // separate from battleStarting: the battle engine can still be alive while
  // its presentation layer is being rebuilt.
  var battleRendererRecovering = false;
  var battleRendererRecoveryTimer = null;
  var battleRendererRecoveryAttempts = 0;
  var battleRendererRecoveryFailed = false;
  var battleNeedsRendererRecovery = false;

  async function startNextBattle() {
    if (battleStarting) return;
    if (!N.alive(run).length) return gameOver();
    // The route button is the scripted gate into the next stop. Mark the
    // route beat complete only when that exact button was actually used.
    if (tutorialSection1()) {
      if (run.battleInSection === 0) run.tutorialRouteDone = true;
      if (run.battleInSection === 1) run.tutorialOnwardDone = true;
      if (N.nextIsTrainer(run)) run.tutorialTrainerDone = true;
      saveGame();
    }
    // A fresh battle must never re-apply stale resume overrides.
    resumePending = false;
    battleStarting = true;
    try {
      var isTrainer = N.nextIsTrainer(run);
      // These MUST live inside the try: show() / ensureUI() can throw (most
      // commonly BattleUI.mount() failing to create a WebGL context), and a
      // throw outside the try used to reject the async function with the
      // finally never running -- `battleStarting` stayed true forever and
      // every later battle-button click was silently swallowed.
      show('Battle');
      // Three/BattleUI are a post-paint upgrade. If the player reaches a
      // battle before that upgrade finishes, wait for it here rather than
      // handing back an unmounted UI or a blank battle host.
      if (window.RendererReady && !window.RendererReady.loaded) {
        await window.RendererReady.start();
      }
      var u = ensureUI();
      u.setMsg('Loading\u2026');
      if (isTrainer) {
        var t = N.trainerFor(run);
        var team = await N.makeTrainerTeam(run, t);
        beginBattle({ enemies: team, isWild: false, trainer: t, catchable: false,
                      fieldEffect: N.fieldEffectFor(run, true), clause: t.clause || null,
                      isTutorialSafe: N.isTutorialSafetySection(run) });
      } else {
        var isFirst = run.battleInSection === 0;
        var isTutorialCapture = !!(run && run.prologue && run.section === 1 && run.battleInSection === 0);
        var isTutorialSE = !!(run && run.prologue && run.section === 1 && run.battleInSection === 1);
        var isTutorialSwitch = !!(run && run.prologue && run.section === 1 && run.battleInSection === 2);
        var wildKey = run.section + ':' + run.battleInSection;
        var id = (run._nextWild && run._nextWild.key === wildKey) ? run._nextWild.id : N.pickWild(run, { dupesClause: isFirst });
        delete run._nextWild;
        var mon = await N.makeWild(run, id);
        run.encounterSeen = run.encounterSeen || isFirst;
        beginBattle({ enemies: [mon], isWild: true, catchable: isFirst && !run.catchUsedThisSection,
                      fieldEffect: N.fieldEffectFor(run, false), isTutorialCapture: isTutorialCapture,
                      isTutorialSE: isTutorialSE, isTutorialSwitch: isTutorialSwitch,
                      isTutorialSafe: N.isTutorialSafetySection(run) });
      }
    } catch (err) {
      // Anything in here (a bad species roll, the learnsets chunk failing to
      // download, a renderer that refused to mount) used to reject silently
      // and strand the player on an empty battle screen. Surface it and offer
      // a way out instead.
      console.error('[battle] failed to start', err);
      battleFailed(err);
    } finally {
      battleStarting = false;
    }
  }

  // Rebuild only the presentation layer after a GPU reset. The Showdown
  // streams are deliberately kept alive: restarting the battle here would
  // reroll a wild encounter, rewind HP/PP, and could even consume a second
  // daily turn. `battle.state.lastRequest` gives the new HUD the latest set of
  // controls once the new scene is ready.
  function restoreBattleRenderer() {
    if (!run || !battle || !bctx || !bctx.cfg || !battle.battle) return false;
    var cfg = bctx.cfg;
    var p = battle.activeMon ? battle.activeMon() : null;
    var e = battle.activeEnemyMon ? battle.activeEnemyMon() : null;
    if (!p) p = run.party && run.party[0];
    if (!e) e = bctx.enemies && bctx.enemies[0];
    if (!p || !e) return false;

    function face(mon) {
      var sp = Dex.species.get(mon.id);
      var types = (sp.exists && sp.types && sp.types.length)
        ? sp.types.slice() : ((mon.types && mon.types.slice()) || ['Normal']);
      mon.types = types;
      if (sp.exists) mon.species = sp.name;
      return { name: mon.name, types: types,
               sid: (sp.exists && sp.spriteid) || mon.id,
               num: sp.exists ? sp.num : 0, h: worldH(mon.id) };
    }

    var pf = face(p), ef = face(e);
    var u = ensureUI();
    if (!u || !u.s || !u.s.mounted) return false;
    u.setRunInfo({
      left: cfg.isWild
        ? ('Section ' + run.section + ' · ' + (cfg.catchable ? 'Capture Encounter' : 'Wild Battle ' + run.battleInSection))
        : (N.isGauntlet(run)
            ? ('Gauntlet · Trainer ' + run.section + ' · ' + (cfg.trainer && cfg.trainer.name || 'Trainer'))
            : ('Section ' + run.section + ' · Trainer Battle · ' + (cfg.trainer && cfg.trainer.name || 'Trainer'))),
      money: N.isGauntlet(run) ? null : run.money
    });
    u.setSpeciesLabels(speciesOf(p), cfg.isWild ? 'Wild ' + speciesOf(e) : speciesOf(e));
    u._catchEntrance = !!cfg.catchable;
    u.setupBattle({
      player: { name: pf.name, lv: 100, types: pf.types, hp: p.hpPct, max: 100,
                st: p.status || null, h: pf.h, sid: pf.sid, num: pf.num,
                u: spriteUrls(p.id, true, p.shiny), silent: true },
      enemy: { name: ef.name, lv: 100, types: ef.types,
               hp: e.hpPct != null ? e.hpPct : 1, max: 100, st: e.status || null,
               h: ef.h, sid: ef.sid, num: ef.num,
               u: spriteUrls(e.id, false, e.shiny), silent: true },
      biomeSeed: run.seed + '|' + run.section + '|' + run.battleInSection,
      biomeTypes: ef.types
    });
    // Match the user's selected battlefield, just as beginBattle() does.
    try {
      var biomeKey = profile && (profile.battlefield || 'dynamic') === 'match'
        ? THEME_BIOME[profile.theme || 'default'] || 'meadow' : null;
      if (biomeKey) u.buildBiome(biomeKey);
    } catch (_) {}

    // Reapply the deterministic opening field effect. The engine remains the
    // source of truth for mechanics; this only restores the visual layer.
    var field = cfg.fieldEffect;
    if (field) {
      if (field.kind === 'weather') {
        var weather = { raindance: 'rain', primordialsea: 'rain', sunnyday: 'sun',
          desolateland: 'sun', deltastream: 'rain', sandstorm: 'sand',
          hail: 'hail', snow: 'snow', snowscape: 'snow' }[field.id];
        if (u.setWeather) u.setWeather(weather || null);
      } else if (field.kind === 'terrain' && u.setTerrain) {
        u.setTerrain(TERRAINS[field.id] || field.id || null);
      } else if (field.kind === 'room' && u.setRoom) {
        u.setRoom(ROOMS[field.id] || field.id || null);
      }
    }
    u.setStatus('p', p.status || null);
    u.setStatus('e', e.status || null);
    if (battle.state && battle.state.awaitingPlayer && battle.state.lastRequest) {
      opening = false;
      renderRequest(battle.state.lastRequest);
    } else {
      u.setMsg('Reconnecting battle…');
    }
    return true;
  }

  function finishBattleRendererRecovery() {
    battleRendererRecovering = false;
    battleRendererRecoveryFailed = false;
    battleRendererRecoveryTimer = null;
    battleRendererRecoveryAttempts = 0;
    battleNeedsRendererRecovery = false;
  }

  function recoverBattleRenderer() {
    if (battleRendererRecovering) return;
    if (!run || !battle || !bctx || !run._inBattle || (battle.state && battle.state.ended)) {
      battleFailed(new Error('The 3D renderer lost its context.'), { contextLost: true });
      return;
    }
    // Persist the live battle before taking the old canvas away. If the tab is
    // backgrounded again during recovery, auto-resume still has the current
    // HP/status/PP rather than the values from the start of the fight.
    syncBattleToRun();
    saveGame();
    teardownBattleUI();
    battleRendererRecovering = true;
    battleRendererRecoveryFailed = false;
    battleRendererRecoveryAttempts++;
    battleNeedsRendererRecovery = true;
    var attempt = battleRendererRecoveryAttempts;
    battleRendererRecoveryTimer = setTimeout(function () {
      battleRendererRecoveryTimer = null;
      if (!battleRendererRecovering) return;
      try {
        show('Battle');
        var u = ensureUI();
        if (battleRendererRecoveryFailed || !u || !u.s.mounted || !restoreBattleRenderer()) {
          throw new Error('The renderer did not become ready.');
        }
        finishBattleRendererRecovery();
        toast('Battle renderer recovered.');
      } catch (err) {
        console.error('[battle] renderer recovery failed', err);
        battleRendererRecovering = false;
        battleRendererRecoveryFailed = false;
        battleRendererRecoveryTimer = null;
        battleRendererRecoveryAttempts = attempt;
        battleFailed(new Error('The 3D renderer lost its context.'), { contextLost: true });
      }
    }, 80);
  }

  function handleBattleContextLost(lostUI) {
    // Context loss is cosmetic: the always-on CSS perspective environment,
    // projected Pokemon and HUD are already underneath the canvas. Reveal that
    // complete scene immediately and let WebGL recover silently in background.
    if (lostUI && lostUI !== ui) return;
    if (lostUI && lostUI.enterFlatMode) lostUI.enterFlatMode('context-lost');
    battleNeedsRendererRecovery = false;
  }

  function handleBattleContextRestored(restoredUI) {
    if (restoredUI && restoredUI !== ui) return;
    if (battleRendererRecovering) return;
    // The renderer session re-attaches a healthy canvas in place on
    // restore/recreation; when the scene already left flat mode there is
    // nothing to rebuild and a teardown would only churn the live battle.
    if (restoredUI && !restoredUI.flat) return;
    if (!run || !battle || !bctx || !run._inBattle || (battle.state && battle.state.ended)) return;
    // Give the browser one turn to finish restoring the shared context, then
    // rebuild only the presentation layer. The active stream and encounter
    // remain untouched.
    setTimeout(function () {
      if (restoredUI && restoredUI !== ui) return;
      if (run && battle && bctx && run._inBattle) recoverBattleRenderer();
    }, 0);
  }

  function handleBattleRendererFailure(owner, err) {
    if (owner && owner !== ui) return;
    setTimeout(function () {
      if (owner && owner !== ui) return;
      // Let the in-flight battle start finish and surface its own caught
      // error; disposing the renderer from this callback would otherwise race
      // the async team roll and create another blank screen.
      if (!battle && battleStarting) return;
      if (battleRendererRecovering) {
        battleRendererRecoveryFailed = true;
        return;
      }
      var active = run && run._inBattle && battle;
      battleFailed(err || new Error('The battle renderer stopped unexpectedly.'),
        active ? { contextLost: true } : {});
    }, 0);
  }

  function abandonFailedBattle() {
    if (!run) return;
    // Preserve damage/PP first, then stop the old stream. Otherwise a delayed
    // request from a dead renderer can mutate the next battle after the player
    // has chosen "Back to route".
    syncBattleToRun();
    battleEpoch++;
    if (battle && battle.destroy) { try { battle.destroy(); } catch (_) {} }
    battle = null;
    bctx = null;
    run._inBattle = false;
    run._battleCfg = null;
    saveGame();
  }

  // Recoverable dead end: tell the player what happened and let them retry or
  // walk back to the crossroads with their run intact.
  function battleFailed(err, opts) {
    opts = opts || {};
    if (opts.contextLost) battleNeedsRendererRecovery = true;
    teardownBattleUI();
    var host = $('battleHost');
    if (!host) return;
    // A half-mounted renderer can leave its canvas and its mount flag behind
    // even when teardownBattleUI() found no live `ui` to unmount (the throw
    // happened inside BattleUI.mount() before it was fully wired). Clear both
    // so "Try again" mounts a fresh scene instead of tripping the
    // "already mounted" guard on a zombie canvas.
    host._bm = null;
    host.querySelectorAll('canvas, .bm-sprites, .battle-hud').forEach(function (n) { n.remove(); });
    host.innerHTML =
      '<div class="battle-error panel center">' +
      '<h2>Battle failed to load</h2>' +
      '<p class="hint">' + escapeHtml(err && err.message ? err.message : String(err || 'Unknown error')) + '</p>' +
      '<button class="btn-primary" id="btnBattleRetry">Try again</button>' +
      '<button class="btn-secondary" id="btnBattleBail">Back to route</button>' +
      '</div>';
    var retry = $('btnBattleRetry'), bail = $('btnBattleBail');
    if (retry) retry.addEventListener('click', function () {
      host.innerHTML = '';
      if (battleNeedsRendererRecovery) {
        recoverBattleRenderer();
      } else {
        startNextBattle();
      }
    });
    if (bail) bail.addEventListener('click', function () {
      battleNeedsRendererRecovery = false;
      if (run && run._inBattle) abandonFailedBattle();
      host.innerHTML = ''; renderCrossroads(); show('Crossroads');
    });
  }

  // Showdown wants a 4x16-bit seed. Derive it from the run seed plus the exact
  // battle slot so every player fights the same rolls on the same day, and a
  // reload replays the same battle rather than re-rolling it.
  function dailyBattleSeed() {
    var base = C.hashString(run.seed + '|battle|' + run.section + '|' + run.battleInSection);
    var r = C.mulberry32(base);
    return [0, 0, 0, 0].map(function () { return Math.floor(r() * 0x10000); });
  }

  // Daily battles are a shared puzzle: the engine rolls are seeded via
  // dailyBattleSeed(), and the AI's tie-breaking jitter must be seeded too or
  // two players can get different opponent decisions on the same day. Free
  // Play passes nothing and keeps the engine's own randomness.
  function dailyAIRand() {
    return C.mulberry32(C.hashString(run.seed + '|ai|' + run.section + '|' + run.battleInSection));
  }

  function beginBattle(cfg) {
    // lead = first non-fainted
    var lead = 0;
    for (var i = 0; i < run.party.length; i++) { if (!C.isFainted(run.party[i])) { lead = i; break; } }
    if (lead !== 0) run.party.unshift(run.party.splice(lead, 1)[0]);
    run.party.forEach(function (m) { N.trackMon(run, m); });
    // Mark that a battle is in progress so the save reflects this.
    run._inBattle = true;
    saveGame();

    // Save battle config so we can resume if the app is closed mid-battle.
    // Everything the engine needs to rebuild the enemy side is captured here,
    // including held items and elite modifiers -- a resumed trainer fight must
    // be the same fight, not a hollowed-out 1-mon version of it.
    run._battleCfg = {
      enemies: cfg.enemies.map(function (e) { return { id: e.id, name: e.name, species: e.species, types: e.types.slice(), moves: e.moves.slice(), ability: e.ability, nature: e.nature, shiny: !!e.shiny, hpPct: e.hpPct, status: e.status, pp: e.pp ? JSON.parse(JSON.stringify(e.pp)) : {}, item: e.item || '', elite: e.elite || null }; }),
      isWild: cfg.isWild,
      catchable: cfg.catchable,
      isTutorialCapture: !!cfg.isTutorialCapture,
      isTutorialSE: !!cfg.isTutorialSE,
      isTutorialSwitch: !!cfg.isTutorialSwitch,
      isTutorialSafe: !!cfg.isTutorialSafe,
      trainer: cfg.trainer ? { name: cfg.trainer.name, tag: cfg.trainer.tag, sprite: cfg.trainer.sprite, boss: cfg.trainer.boss } : null,
      clause: cfg.clause || null
    };

    bctx = {
      cfg: cfg, enemies: cfg.enemies, caught: false, ended: false,
      tutorialMoveId: null, tutorialSEMoveId: null, tutorialBallId: null,
      tutorialSwitchOpen: false
    };
    run.trainingPaidThisRound = false;
    // A fresh, randomly chosen track per battle — rival themes for wilds,
    // trainer themes for trainers, the two "final" themes for bosses.
    if (window.GameAudio) {
      window.GameAudio.startBattle(
        cfg.isWild ? 'wild' : (cfg.trainer && cfg.trainer.boss ? 'boss' : 'trainer'));
    }
    clearQueue();
    atkSide = null; atkHit = false;
    var u = ensureUI();
    u.setRunInfo({
      left: cfg.isWild
        ? ('Section ' + run.section + ' \u00b7 ' + (cfg.catchable ? 'Capture Encounter' : 'Wild Battle ' + run.battleInSection))
        : (N.isGauntlet(run)
            ? ('Gauntlet \u00b7 Trainer ' + run.section + ' \u00b7 ' + cfg.trainer.name)
            : ('Section ' + run.section + ' \u00b7 Trainer Battle \u00b7 ' + cfg.trainer.name)),
      // No cash exists in a Gauntlet, so the money readout goes away entirely.
      money: N.isGauntlet(run) ? null : run.money
    });

    var p = run.party[0], e = cfg.enemies[0];
    // Resolve types/sprite from Dex(mon.id) so a stale mon.types/species on an
    // older save (regional collapsed to base) never paints the wrong forme.
    function battleFace(mon) {
      var sp = Dex.species.get(mon.id);
      var types = (sp.exists && sp.types && sp.types.length)
        ? sp.types.slice()
        : (mon.types ? mon.types.slice() : ['Normal']);
      // Keep mon.types in sync so the rest of the fight (AI, catch, switch)
      // sees the same typing the HUD just drew.
      mon.types = types;
      if (sp.exists) mon.species = sp.name;
      return {
        name: mon.name,
        types: types,
        sid: (sp.exists && sp.spriteid) || mon.id,
        num: sp.exists ? sp.num : 0,
        h: worldH(mon.id)
      };
    }
    var pf = battleFace(p), ef = battleFace(e);
    // High-priority warm of the exact battle poses right before the UI asks
    // for them. The lead's back GIF + the foe's front GIF are what _setTex
    // will request first.
    try {
      prefetchSpecies(p.id, { shiny: !!p.shiny, back: true });
      prefetchSpecies(e.id, { shiny: !!e.shiny });
      // Warm the rest of both benches at low urgency so switches don't stall.
      if (run.party) for (var pi = 1; pi < run.party.length; pi++) {
        if (run.party[pi]) prefetchSpecies(run.party[pi].id, { shiny: !!run.party[pi].shiny, back: true });
      }
      if (cfg.enemies) for (var ei = 1; ei < cfg.enemies.length; ei++) {
        if (cfg.enemies[ei]) prefetchSpecies(cfg.enemies[ei].id, { shiny: !!cfg.enemies[ei].shiny });
      }
    } catch (ePre) {}
    u.setSpeciesLabels(speciesOf(p), cfg.isWild ? 'Wild ' + speciesOf(e) : speciesOf(e));
    u._catchEntrance = !!cfg.catchable;
    u.setupBattle({
      player: { name: pf.name, lv: 100, types: pf.types, hp: p.hpPct, max: 100, st: p.status || null,
                h: pf.h, sid: pf.sid, num: pf.num,
                u: spriteUrls(p.id, true, p.shiny) },
      enemy: { name: ef.name, lv: 100, types: ef.types, hp: (e.hpPct != null && e.hpPct < 1) ? e.hpPct : 1, max: 100, st: e.status || null,
               h: ef.h, sid: ef.sid, num: ef.num,
               u: spriteUrls(e.id, false, e.shiny) },
      biomeSeed: run.seed + '|' + run.section + '|' + run.battleInSection,
      biomeTypes: ef.types
    });
    // "Match theme" overrides the random biome after setupBattle picks one.
    try {
      var biomeKey = profile && (profile.battlefield || 'dynamic') === 'match'
        ? THEME_BIOME[profile.theme || 'default'] || 'meadow' : null;
      if (biomeKey) u.buildBiome(biomeKey);
    } catch (_) { /* profile may be null on first run */ }
    if (!cfg.isWild) u.log(cfg.trainer.name + ' ' + cfg.trainer.tag);
    if (cfg.isWild && cfg.enemies[0] && cfg.enemies[0].shiny) {
      // A shiny outranks the ordinary catch banner: it is always catchable and
      // it can never break free, so say exactly that.
      u.log('A SHINY ' + speciesOf(cfg.enemies[0]).toUpperCase() + ' appeared!');
      showCatchBanner('\u2728 SHINY \u00b7 guaranteed catch \u00b7 any ball');
    } else if (cfg.isWild && cfg.enemies[0] &&
               cfg.enemies[0].specialEncounter === 'section6-strong-capture') {
      // Make the section-6 promise visible before the first turn. The normal
      // ball rail remains available, but the banner tells the player why the
      // Master Ball from section 5 matters.
      u.log('A powerful Section 6 capture encounter appeared!');
      showCatchBanner('\u26a1 SECTION 6 \u00b7 powerful capture \u00b7 use your best ball');
    } else if (cfg.catchable) {
      // The animated ball rail communicates the catch opportunity without a
      // second yellow banner covering the battlefield.
      u.log('A wild ' + speciesOf(cfg.enemies[0]) + ' appeared!');
    }
    u.setStatus('p', p.status || null);
    u.setStatus('e', null);

    var epoch = ++battleEpoch;
    battle = RB.startBattle({
      playerMons: run.party,
      enemyMons: cfg.enemies,
      isWild: cfg.isWild,
      isTutorialCapture: !!cfg.isTutorialCapture,
      isTutorialSE: !!cfg.isTutorialSE,
      isTutorialSafe: !!cfg.isTutorialSafe,
      trainerName: cfg.isWild ? 'Wild' : cfg.trainer.name,
      // Ascension: how far ahead the AI is allowed to look, and what is
      // already on the field when the fight starts.
      aiDepth: N.ascensionEffects(run).aiDepth,
      fieldEffect: cfg.fieldEffect || null,
      // A Daily must play out identically for everyone, crits included.
      battleSeed: run.mode === 'daily' ? dailyBattleSeed() : null,
      // ... and the AI's tie-breaking jitter must be seeded too.
      rand: run.mode === 'daily' ? dailyAIRand() : null,
      handlers: {
        onLog: function (chunk) { if (epoch === battleEpoch) handleLog(chunk); },
        onRequest: function (req) { if (epoch === battleEpoch) handleRequest(req); },
        onEnd: function (res) { if (epoch === battleEpoch) handleEnd(res); },
        onDamage: function (amt, mon) {
          if (epoch !== battleEpoch) return;
          if (mon) run.damageDealt[mon.uid] = (run.damageDealt[mon.uid] || 0) + amt;
        },
        onKO: function (mon) {
          if (epoch !== battleEpoch) return;
          if (mon) run.knockouts[mon.uid] = (run.knockouts[mon.uid] || 0) + 1;
        },
        onError: function (e2) {
          if (epoch === battleEpoch) console.error('[battle]', e2);
        }
      }
    });
  }

  // ---- log -> 3D UI (SEQUENCED) ------------------------------------------
  // Showdown delivers a whole turn as one chunk. Playing it instantly makes
  // everything happen at once. Instead we push each protocol line into a queue
  // and drain it on a timer, so moves, damage, effectiveness callouts, status
  // and faints appear one after another with readable text for each step.
  var evQ = [];            // pending [cmd, parts] events
  var evTimer = null;
  var pendingRequest = null;   // request held back until the queue is empty
  var decisionPrompt = null;   // the "What will X do?" line, restored after the queue drains
  var atkSide = null, atkHit = false;
  var battleSaveTimer = null;
  var BATTLE_SAVE_DEBOUNCE_MS = 500;

  function scheduleBattleSave() {
    if (!run || !run._inBattle || battleSaveTimer) return;
    battleSaveTimer = setTimeout(function () {
      battleSaveTimer = null;
      syncBattleToRun();
      saveGame();
    }, BATTLE_SAVE_DEBOUNCE_MS);
  }
  function flushBattleSave() {
    if (battleSaveTimer) { clearTimeout(battleSaveTimer); battleSaveTimer = null; }
    if (run && run._inBattle) { syncBattleToRun(); saveGame(); }
  }

  function q(seq) { if (ui && ui.queueMoments) ui.queueMoments(seq); }
  function sideOf(id) { return String(id || '').indexOf('p1') === 0 ? 'p' : 'e'; }

  // "153/301 par" / "0 fnt" / "100/100" -> 'par' | '' 
  function statusFromCondition(cond) {
    var m = String(cond || '').match(/\b(brn|par|slp|frz|psn|tox)\b/);
    return m ? m[1] : '';
  }

  function nameFromIdent(ident) {
    var raw = String(ident || '').split(': ').slice(1).join(': ').trim();
    return raw || String(ident || '').replace(/^p[12][ab]?:?\s*/, '');
  }

  // True until the first |turn| of a battle. The opening switch-ins carry no
  // information the player needs to read, so we blast through them and hand
  // over control immediately instead of making them watch (and wait on cries).
  var opening = true;

  // How long to hold on each event before showing the next one.
  function delayFor(cmd) {
    if (opening) {
      // battle intro: only a token beat so the sprites can fade in
      if (cmd === 'switch' || cmd === 'drag' || cmd === 'replace') return 120;
      if (cmd === 'turn') return 0;
      return 60;
    }
    switch (cmd) {
      // The lunge and the hit land TOGETHER: `move` holds only long enough to
      // read the "X used Y!" text, then the damage lands on top of the strike
      // rather than after it. Effectiveness callouts follow quickly so the
      // whole exchange reads as one beat instead of a slideshow.
      case 'move': return 480;
      case '-damage': return 850;
      case '-heal': return 850;
      case '-crit': case '-supereffective': case '-resisted': case '-immune': return 620;
      case '-miss': case '-fail': return 800;
      case 'faint': return 850;
      case '-mega': return 2600;      // full transformation animation
      case 'detailschange': return 200; // sprite swap, folded into -mega
      case 'switch': case 'drag': case 'replace': return 900;
      case '-status': case '-curestatus': return 850;
      case '-boost': case '-unboost': return 700;
      case '-weather': case '-fieldstart': case '-fieldend': return 800;
      case '-start': case '-end': case '-activate': case '-item': case '-enditem':
      case '-ability': case '-sidestart': case '-sideend': case '-singleturn': case '-transform':
        return 750;
      case 'cant': return 900;
      case 'turn': return 120;
      default: return 220;
    }
  }

  // The hidden turn-skip move must be invisible: the player used an item, they
  // did not "use Celebrate". Drop every event it generates.
  function isSkipNoise(parts) {
    var cmd = parts[0];
    if (cmd === 'move') {
      var mv = String(parts[2] || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      return mv === RB.IDLE_MOVE;
    }
    if (cmd === '-activate' || cmd === '-anim' || cmd === '-fail' || cmd === '-nothing') {
      for (var i = 1; i < parts.length; i++) {
        if (/celebrate/i.test(String(parts[i]))) return true;
      }
    }
    return false;
  }

  function handleLog(chunk) {
    var lines = String(chunk).split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.indexOf('|split|') === 0) { line = lines[i + 3] || lines[i + 1] || ''; i += 3; }
      if (!line || line[0] !== '|') continue;
      var parts = line.slice(1).split('|');
      if (isSkipNoise(parts)) continue;
      evQ.push(parts);
    }
    pumpQueue();
  }

  function pumpQueue() {
    if (evTimer) return;
    step();
  }
  // A queued request that keeps failing to render. Bounded so a permanently
  // broken request surfaces through battleFailed() instead of either killing
  // the queue silently (the old behaviour: one throw inside step() ended the
  // chain and left the move buttons locked forever) or retrying forever.
  var pendingRequestFails = 0;
  function step() {
    evTimer = null;
    if (!ui) { evQ.length = 0; pendingRequest = null; return; }
    if (!evQ.length) {
      // queue drained -> now it is safe to hand control back to the player
      if (pendingRequest) {
        var r = pendingRequest;
        try {
          renderRequest(r);
          pendingRequest = null;
          pendingRequestFails = 0;
        } catch (e) {
          // A single bad request must not kill the drain chain or leave the
          // move buttons locked. Retry on the next tick; only a sustained
          // failure is surfaced as a battle error.
          pendingRequestFails++;
          console.warn('glue: request render failed (attempt ' + pendingRequestFails + ')', e);
          if (pendingRequestFails >= 10) {
            pendingRequest = null;
            pendingRequestFails = 0;
            battleFailed(e instanceof Error ? e : new Error('The battle request could not be rendered.'));
            return;
          }
          evTimer = setTimeout(step, 250);
          return;
        }
      } else if (decisionPrompt && battle && battle.state && battle.state.awaitingPlayer) {
        // The decision prompt ("What will Cinder do?") is written when the
        // request arrives, but the log lines still draining behind it keep
        // overwriting the message bar. When the queue finally empties and the
        // engine is waiting for the player, put the prompt back so the
        // tutorial's "throw the ball" moment never freezes on a stale line
        // like "Cinder's Sp. Atk sharply fell!".
        if (ui && ui.s && ui.s.msg !== decisionPrompt) {
          ui.setMsg(decisionPrompt);
          ui.log(decisionPrompt);
        }
      }
      return;
    }
    var parts = evQ.shift();
    var cmd = parts[0];
    var d = delayFor(cmd);
    try { handleLine(cmd, parts); } catch (e) { console.warn('glue', e); }
    evTimer = setTimeout(step, d);
  }
  function clearQueue() {
    opening = true;
    evQ.length = 0;
    if (evTimer) { clearTimeout(evTimer); evTimer = null; }
    pendingRequest = null;
    pendingRequestFails = 0;
    decisionPrompt = null;
  }

  function handleLine(cmd, p) {
    if (cmd === 'move') {
      var sd = sideOf(p[1]); atkSide = sd; atkHit = false;
      q([{ m: sd === 'p' ? 'playerAttack' : 'enemyAttack', d: 0 }]);
      say(nameFromIdent(p[1]) + ' used ' + (p[2] || '') + '!');
    } else if (cmd === '-damage' || cmd === '-heal' || cmd === '-sethp') {
      var s2 = sideOf(p[1]), frac = RB.parseHp(p[2]);
      var prev = s2 === 'p' ? ui.s.p.hp : ui.s.e.hp;
      var pct = Math.round(Math.abs(frac - prev) * 100);
      ui.setHp(s2, frac);
      var who = nameFromIdent(p[1]);
      var src = reasonFrom(p);
      if (cmd === '-damage') {
        if (atkSide && !atkHit && ((atkSide === 'p' && s2 === 'e') || (atkSide === 'e' && s2 === 'p'))) {
          q([{ m: s2 === 'p' ? 'playerHit' : 'enemyHit', d: 0 }]); atkHit = true;
        } else q([{ m: 'idle', d: 0 }]);
        if (pct > 0) ui.floatN(s2, pct, 'damage');
        if (src) say(who + ' was hurt by ' + src + '!');
        if (s2 === 'p') scheduleBattleSave();
      } else if (cmd === '-heal') {
        if (pct > 0) { ui.floatN(s2, pct, 'heal'); ui.flashHeal(s2); }
        say(who + ' restored HP' + (src ? ' with ' + src : '') + '!');
        if (s2 === 'p') scheduleBattleSave();
      }
    } else if (cmd === '-status') {
      ui.setStatus(sideOf(p[1]), p[2]);
      say(nameFromIdent(p[1]) + ' ' + statusVerb(p[2]) + '!');
      if (sideOf(p[1]) === 'p') scheduleBattleSave();
    } else if (cmd === '-curestatus') {
      ui.setStatus(sideOf(p[1]), null);
      say(nameFromIdent(p[1]) + ' was cured of its ' + statusName(p[2]) + '!');
      if (sideOf(p[1]) === 'p') scheduleBattleSave();
    } else if (cmd === '-supereffective') {
      ui.floatT("It's super effective!", 'se'); say("It's super effective!");
      if (atkSide && !atkHit) { q([{ m: atkSide === 'p' ? 'enemyHit' : 'playerHit', d: 0 }]); atkHit = true; }
    } else if (cmd === '-resisted') {
      ui.floatT('Not very effective...', 'nv'); say("It's not very effective...");
      if (atkSide && !atkHit) { q([{ m: atkSide === 'p' ? 'enemyHit' : 'playerHit', d: 0 }]); atkHit = true; }
    } else if (cmd === '-crit') {
      ui.floatT('A critical hit!', 'cr'); say('A critical hit!');
    } else if (cmd === '-miss') {
      ui.floatT('Miss!', 'mi'); q([{ m: 'idle', d: 0 }]); atkSide = null;
      say((p[2] ? nameFromIdent(p[2]) : nameFromIdent(p[1])) + ' avoided the attack!');
    } else if (cmd === '-immune') {
      q([{ m: 'idle', d: 0 }]); atkSide = null;
      say("It doesn't affect " + nameFromIdent(p[1]) + '...');
    } else if (cmd === '-fail') {
      q([{ m: 'idle', d: 0 }]); atkSide = null; say('But it failed!');
    } else if (cmd === 'cant') {
      q([{ m: 'idle', d: 0 }]); atkSide = null;
      say(nameFromIdent(p[1]) + " can't move!");
    } else if (cmd === '-boost' || cmd === '-unboost') {
      var dir = cmd === '-boost' ? 'rose' : 'fell';
      var amt = +p[3] || 1;
      var much = amt >= 3 ? ' drastically' : amt === 2 ? ' sharply' : '';
      say(nameFromIdent(p[1]) + "'s " + statName(p[2]) + much + ' ' + dir + '!');
    } else if (cmd === 'faint') {
      var fs = sideOf(p[1]); ui.setHp(fs, 0); q([{ m: 'fainted', d: 0 }]); atkSide = null;
      var fname = nameFromIdent(p[1]);
      if (fs === 'p') { say(fname + ' fainted... and is gone forever.'); ui.log(fname + ' is gone forever.'); }
      else say('The foe ' + fname + ' fainted!');
      scheduleBattleSave();
    } else if (cmd === 'switch' || cmd === 'drag' || cmd === 'replace') {
      var isP = sideOf(p[1]) === 'p';
      // Prefer the run object's mon.id over the protocol species string. The
      // engine details are usually right, but a stale mon.species (old saves)
      // or a temporary display quirk must never collapse a regional variant
      // (Sneasel-Hisui) to its default forme sprite/types.
      // For the enemy side, never use enemies[0] -- that is always the lead.
      // Use the live active enemy mon so the second, third, etc. Pokemon show
      // their own sprite and typing after the previous one faints.
      var swMon = isP ? battle.activeMon() : (battle.activeEnemyMon ? battle.activeEnemyMon() : null);
      // Fallback to bctx for pre-battle log lines where active may not exist yet
      if (!swMon && !isP && bctx && bctx.enemies) swMon = bctx.enemies[0];
      var sp = Dex.species.get((p[2] || '').split(',')[0].trim());
      if (swMon && swMon.id) {
        var monSp = Dex.species.get(swMon.id);
        if (monSp.exists) sp = monSp;
      }
      if (sp.exists) {
        // Use the nickname the engine reports (which is our mon's .name),
        // falling back to the forme's full species name.
        var shown = nameFromIdent(p[1]) || sp.name;
        var swShiny = !!(swMon && swMon.shiny);
        // Prefer mon.types when present (already resolved for the individual).
        var swTypes = (swMon && Array.isArray(swMon.types) && swMon.types.length)
          ? swMon.types.slice() : sp.types.slice();
        var pay = { name: shown, types: swTypes, h: worldH(sp.id),
                    sid: sp.spriteid || sp.id, num: sp.num, u: spriteUrls(sp.id, isP, swShiny),
                    silent: opening };
        if (isP) ui.setPlayer(pay); else ui.setEnemy(pay);
      }
      ui.setHp(isP ? 'p' : 'e', RB.parseHp(p[3]));
      // keep the species caption pointing at whoever is actually out
      if (sp.exists && ui.setSpeciesLabels) {
        var capt = sp.name;
        if (isP) ui.setSpeciesLabels(capt, null);
        else ui.setSpeciesLabels(null, (bctx && bctx.cfg && bctx.cfg.isWild ? 'Wild ' : '') + capt);
      }
      // The incoming Pokemon has its OWN status. Without this the previous
      // occupant's badge (e.g. FRZ) stays stuck on the slot.
      ui.setStatus(isP ? 'p' : 'e', statusFromCondition(p[3]) || null);
      q([{ m: 'idle', d: 0 }]); atkSide = null;
      say(isP ? ('Go! ' + nameFromIdent(p[1]) + '!') : (nameFromIdent(p[1]) + ' appeared!'));
    } else if (cmd === 'detailschange') {
      // The engine has swapped the forme (mega / primal / Ultra Burst).
      // Update the 3D sprite + typing; the flashy part runs on |-mega|.
      var dIsP = sideOf(p[1]) === 'p';
      var dsp = Dex.species.get((p[2] || '').split(',')[0].trim());
      if (dsp.exists) {
        var dfMon = dIsP ? battle.activeMon() : (battle.activeEnemyMon ? battle.activeEnemyMon() : (bctx && bctx.enemies && bctx.enemies[0]));
        var dpay = { name: dsp.name, types: dsp.types.slice(), h: worldH(dsp.id),
                     sid: dsp.spriteid || dsp.id, num: dsp.num,
                     u: spriteUrls(dsp.id, dIsP, !!(dfMon && dfMon.shiny)) };
        if (dIsP) ui.setPlayer(dpay); else ui.setEnemy(dpay);
        // setPlayer/setEnemy treat a name+types update as "sprite only" and
        // skip their re-render, so the header would keep the old forme's name
        // and typing. Force the HUD to redraw.
        if (ui.render) ui.render();
        if (ui.setSpeciesLabels) {
          if (dIsP) ui.setSpeciesLabels(dsp.name, null);
          else ui.setSpeciesLabels(null, (bctx && bctx.cfg && bctx.cfg.isWild ? 'Wild ' : '') + dsp.name);
        }
        var mon2 = dIsP ? battle.activeMon() : null;
        if (mon2) { mon2.megaForme = dsp.id; mon2.types = dsp.types.slice(); }
      }
    } else if (cmd === '-transform') {
      // Transform (move) or Imposter: copy the target's visual appearance onto
      // the source Pokemon.  The engine already updated its internal state; we
      // just need to sync the 3D sprite, types, height and species label.
      var tSrcP = sideOf(p[1]) === 'p';
      var tTgtP = sideOf(p[2]) === 'p';
      var tSrc = tSrcP ? ui.s.p : ui.s.e;
      var tTgt = tTgtP ? ui.s.p : ui.s.e;
      if (tSrc && tTgt && tTgt.sid) {
        var tIsShiny = !!(tSrc.url && tSrc.url.indexOf('shiny') >= 0);
        var tPay = {
          name: tSrc.name,
          types: (tTgt.types || []).slice(),
          h: tTgt.h || 2.4,
          sid: tTgt.sid,
          num: tTgt.num,
          u: spriteUrls(tTgt.sid, tSrcP, tIsShiny)
        };
        if (tSrcP) ui.setPlayer(tPay); else ui.setEnemy(tPay);
        if (ui.setSpeciesLabels) {
          var tSp = C.cleanName(tTgt.sid);
          if (tSrcP) ui.setSpeciesLabels(tSp, null);
          else ui.setSpeciesLabels(null, (bctx && bctx.cfg && bctx.cfg.isWild ? 'Wild ' : '') + tSp);
        }
        if (ui.render) ui.render();
      }
      say(nameFromIdent(p[1]) + ' transformed!');
    } else if (cmd === '-mega') {
      var mIsP = sideOf(p[1]) === 'p';
      var mSide = mIsP ? 'p' : 'e';
      var who2 = nameFromIdent(p[1]);
      var stoneName = p[3] || 'its Mega Stone';
      megaFx(mSide);
      say(who2 + "'s " + stoneName + ' is reacting to the Key Stone!');
      setTimeout(function () {
        if (ui) ui.setMsg(who2 + ' has Mega Evolved!');
      }, 1300);
    } else if (cmd === '-weather') {
      var w = (p[1] || '').toLowerCase();
      // 'sun' has no falling particles but still regrades the whole scene,
      // so it must be mapped too -- it used to fall through to null.
      var mp = { raindance: 'rain', primordialsea: 'rain',
                 sunnyday: 'sun', desolateland: 'sun', deltastream: 'rain',
                 sandstorm: 'sand', hail: 'hail', snow: 'snow', snowscape: 'snow' };
      // |-weather|none| and the upkeep-only line both mean "no new weather".
      ui.setWeather((!w || w === 'none') ? null : (mp[w] || null));
      if (w && w !== 'none' && p.indexOf('[upkeep]') < 0) say(weatherText(w));
    } else if (cmd === '-ability') {
      say(nameFromIdent(p[1]) + "'s " + (p[2] || 'ability') + '!');
    } else if (cmd === '-item') {
      say(nameFromIdent(p[1]) + ' has ' + (p[2] || 'an item') + '!');
    } else if (cmd === '-enditem') {
      say(nameFromIdent(p[1]) + ' used its ' + (p[2] || 'item') + '!');
    } else if (cmd === '-start') {
      var sk = volatileKey(p[2]);
      say(nameFromIdent(p[1]) + ' ' + (START_TEXT[sk] || ('was affected by ' + effectText(p[2]))) + '!');
    } else if (cmd === '-end') {
      var ek = volatileKey(p[2]);
      // Illusion breaking: the disguised Pokemon reverts to its real species.
      // Update the 3D sprite, types, and species label to match.
      if (ek === 'illusion') {
        var ilIsP = sideOf(p[1]) === 'p';
        var ilMon = ilIsP ? battle.activeMon() : (battle.activeEnemyMon ? battle.activeEnemyMon() : (bctx && bctx.enemies && bctx.enemies[0]));
        if (ilMon) {
          var ilSp = Dex.species.get(ilMon.id || ilMon.species);
          if (ilSp && ilSp.exists) {
            var ilPay = {
              name: ilMon.name || C.cleanName(ilSp.id),
              types: ilSp.types.slice(),
              h: worldH(ilSp.id),
              sid: ilSp.spriteid || ilSp.id,
              num: ilSp.num,
              u: spriteUrls(ilSp.id, ilIsP, !!ilMon.shiny)
            };
            if (ilIsP) ui.setPlayer(ilPay); else ui.setEnemy(ilPay);
            if (ui.setSpeciesLabels) {
              if (ilIsP) ui.setSpeciesLabels(C.cleanName(ilSp.id), null);
              else ui.setSpeciesLabels(null, (bctx && bctx.cfg && bctx.cfg.isWild ? 'Wild ' : '') + C.cleanName(ilSp.id));
            }
            if (ui.render) ui.render();
          }
        }
      }
      say(nameFromIdent(p[1]) + ' ' + (END_TEXT[ek] || ('is no longer affected by ' + effectText(p[2]))) + '.');
    } else if (cmd === '-activate') {
      say(nameFromIdent(p[1]) + ': ' + effectText(p[2]) + '!');
    } else if (cmd === '-fieldstart') {
      applyField(p[1], true);
      say(fieldText(p[1], true));
    } else if (cmd === '-fieldend') {
      applyField(p[1], false);
      say(fieldText(p[1], false));
    } else if (cmd === 'turn') {
      opening = false;
      q([{ m: 'idle', d: 0 }]); atkSide = null;
    }
  }

  // Mega Evolution flourish: the 3D camera pushes in, the engine's own gold
  // burst fires, and we overlay a spinning ring + flash on the battle canvas.
  function megaFx(side) {
    if (!ui) return;
    try {
      q([{ m: 'mega', d: 0 }]);
      if (ui.trigMega) ui.trigMega(side);
      ui.floatT('MEGA EVOLUTION!', 'se');
    } catch (e) {}
    var host = $('battleHost');
    if (!host) return;
    // Pure screen flash -- no rings or orbs, just the classic strobe.
    var fx = document.createElement('div');
    fx.className = 'mega-fx';
    fx.innerHTML = '<div class="mega-flash"></div>';
    host.appendChild(fx);
    setTimeout(function () { if (fx.parentNode) fx.parentNode.removeChild(fx); }, 2600);
  }

  function say(text) { if (ui) { ui.setMsg(text); ui.log(text); } }
  function statusName(st) {
    return ({ brn: 'burn', par: 'paralysis', slp: 'sleep', frz: 'freeze', psn: 'poison', tox: 'bad poison' })[st] || st;
  }
  function statusVerb(st) {
    return ({ brn: 'was burned', par: 'was paralyzed', slp: 'fell asleep', frz: 'was frozen solid',
              psn: 'was poisoned', tox: 'was badly poisoned' })[st] || ('was afflicted by ' + st);
  }
  function statName(k) {
    return ({ atk: 'Attack', def: 'Defense', spa: 'Sp. Atk', spd: 'Sp. Def', spe: 'Speed',
              accuracy: 'accuracy', evasion: 'evasiveness' })[k] || k;
  }
  // Route a |-fieldstart|/|-fieldend| effect to the right 3D system. Showdown
  // sends these as 'move: Electric Terrain' / 'move: Trick Room', so normalise
  // to a bare id first.
  function fieldKey(raw) {
    return String(raw || '').replace(/^(move|ability|item|condition):\s*/i, '')
                            .toLowerCase().replace(/[^a-z0-9]+/g, '');
  }
  var TERRAINS = { electricterrain: 'electric', grassyterrain: 'grassy',
                   mistyterrain: 'misty', psychicterrain: 'psychic' };
  var ROOMS = { trickroom: 'trickroom', wonderroom: 'wonderroom', magicroom: 'magicroom' };

  function applyField(raw, on) {
    if (!ui) return;
    var k = fieldKey(raw);
    if (TERRAINS[k]) { ui.setTerrain(on ? TERRAINS[k] : null); return; }
    if (ROOMS[k]) { ui.setRoom(on ? ROOMS[k] : null); return; }
  }

  var FIELD_TEXT = {
    electricterrain: ['An electric current runs across the battlefield!', 'The electricity disappeared.'],
    grassyterrain:   ['Grass grew to cover the battlefield!', 'The grass disappeared.'],
    mistyterrain:    ['Mist swirled around the battlefield!', 'The mist disappeared.'],
    psychicterrain:  ['The battlefield got weird!', 'The weirdness disappeared.'],
    trickroom:       ['The dimensions were twisted!', 'The twisted dimensions returned to normal.'],
    wonderroom:      ['Wonder Room twisted the dimensions!', 'Wonder Room wore off.'],
    magicroom:       ['Magic Room twisted the dimensions!', 'Magic Room wore off.'],
    gravity:         ['Gravity intensified!', 'Gravity returned to normal.'],
    tailwind:        ['A tailwind blew!', 'The tailwind died down.']
  };
  function fieldText(raw, on) {
    var k = fieldKey(raw), e = FIELD_TEXT[k];
    if (e) return on ? e[0] : e[1];
    return on ? (effectText(raw) + ' covered the field!') : (effectText(raw) + ' faded.');
  }

  function weatherText(w) {
    return ({ raindance: 'It started to rain!', primordialsea: 'A heavy rain began!',
              sunnyday: 'The sunlight turned harsh!', desolateland: 'The sunlight turned extremely harsh!',
              sandstorm: 'A sandstorm kicked up!', hail: 'It started to hail!',
              snow: 'It started to snow!', snowscape: 'It started to snow!',
              deltastream: 'Mysterious air currents blow!' })[w] || 'The weather changed!';
  }
  function effectText(raw) {
    var t = String(raw || '').replace(/^(move|ability|item|condition):\s*/i, '');
    return t || 'something';
  }
  // Readable phrasing for the common |-start|/|-end| volatiles.
  var START_TEXT = {
    yawn: 'became drowsy', confusion: 'became confused', substitute: 'put up a substitute',
    leechseed: 'was seeded', taunt: 'fell for the taunt', encore: 'got an Encore',
    disable: "'s move was disabled", torment: 'was tormented', attract: 'fell in love',
    curse: 'was cursed', nightmare: 'began having a nightmare', perish3: 'will faint in 3',
    aquaring: 'surrounded itself with water', ingrain: 'planted its roots',
    magnetrise: 'levitated on electromagnetism', embargo: "can't use items",
    healblock: 'was prevented from healing', flashfire: 'powered up its Fire moves',
    protosynthesis: "'s Protosynthesis activated", quarkdrive: "'s Quark Drive activated",
    slowstart: "can't get it going", typechange: ' transformed'
  };
  var END_TEXT = {
    yawn: 'is no longer drowsy', confusion: 'snapped out of its confusion',
    substitute: "'s substitute faded", leechseed: 'was freed from Leech Seed',
    taunt: "'s taunt wore off", encore: "'s Encore ended", disable: 'is no longer disabled',
    torment: 'is no longer tormented', attract: 'got over its infatuation'
  };
  function volatileKey(raw) {
    return String(raw || '').replace(/^(move|ability|item|condition):\s*/i, '')
      .toLowerCase().replace(/[^a-z0-9]/g, '');
  }
  // "[from] item: Leftovers" / "[from] Sandstorm" -> readable cause
  function reasonFrom(parts) {
    for (var i = 2; i < parts.length; i++) {
      var m = String(parts[i]).match(/^\[from\]\s*(.+)$/);
      if (m) return effectText(m[1]);
    }
    return null;
  }

  // ---- requests ----
  // Called by the engine. If animations are still playing we stash the request
  // and replay it from step() once the queue drains -- this is what keeps the
  // move menu from popping up in the middle of a turn.
  function handleRequest(req) {
    if (!ui || !req) return;
    // ANY engine response proves the previous choice was consumed. Releasing
    // the action lock here means a request that fails to render (or a wait)
    // can never leave every move button permanently dead mid-battle.
    if (ui.s) ui.s.locked = false;
    if (req.wait) { ui.setMoves([], {}, null); return; }
    // Flush the debounced damage/status persistence before handing control to
    // the player. This keeps reloads safe without stringifying the whole run
    // once per animation event.
    flushBattleSave();
    // On resume, override the HUD's HP/status with saved values after the
    // opening switch events have been processed. The flag lives on a module
    // variable (never on the run save) and is consumed exactly once, on the
    // first request of the resumed battle.
    if (resumePending && bctx && bctx.cfg) {
      resumePending = false;
      var p = run.party[0];
      // On resume the active enemy might not be the lead if the battle was
      // saved mid-trainer fight. Prefer the live active mon, falling back to
      // first non-fainted in the saved cfg.
      var eMon = battle.activeEnemyMon ? battle.activeEnemyMon() : null;
      var e = eMon || bctx.cfg.enemies[0];
      if (!eMon && bctx.cfg.enemies.length > 1) {
        for (var ei = 0; ei < bctx.cfg.enemies.length; ei++) {
          if (bctx.cfg.enemies[ei].hpPct > 0) { e = bctx.cfg.enemies[ei]; break; }
        }
      }
      if (p && ui.s.p) {
        ui.setHp('p', p.hpPct || 1);
        if (p.status) ui.setStatus('p', p.status);
      }
      if (e && ui.s.e) {
        var eHp = (e.hpPct != null && e.hpPct < 1) ? e.hpPct : 1;
        ui.setHp('e', eHp);
        if (e.status) ui.setStatus('e', e.status);
      }
    }
    saveGame();
    // While the intro is still flushing, render immediately so Fight/Bag/Ball
    // /Party are usable from the very first frame of the battle.
    if (!opening && (evQ.length || evTimer)) { pendingRequest = req; return; }
    renderRequest(req);
  }

  function tutorialMoveId(req, predicate, preferredTypes) {
    if (!req || !req.active || !req.active[0]) return null;
    var slots = req.active[0].moves || [];
    var types = (preferredTypes || []).map(function (t) { return String(t).toLowerCase(); });
    var legal = [];
    for (var i = 0; i < slots.length; i++) {
      var slot = slots[i];
      if (slot.disabled || !slot.pp) continue;
      var d = Dex.moves.get(slot.id || slot.move);
      if (!d || !d.exists || d.id === RB.IDLE_MOVE || d.category === 'Status') continue;
      if (predicate && !predicate(d)) continue;
      legal.push(d);
    }
    if (!legal.length) return null;
    // The player's first instructed attack teaches the useful default rule:
    // use the strongest move that matches one of the Pokemon's own types.
    // Accuracy breaks ties and is preferred strongly enough that the scripted
    // first tap normally resolves, but STAB and displayed power stay primary.
    legal.sort(function (a, b) {
      var aStab = types.indexOf(String(a.type).toLowerCase()) >= 0 ? 1 : 0;
      var bStab = types.indexOf(String(b.type).toLowerCase()) >= 0 ? 1 : 0;
      if (aStab !== bStab) return bStab - aStab;
      if ((a.basePower || 0) !== (b.basePower || 0)) return (b.basePower || 0) - (a.basePower || 0);
      var aa = a.accuracy === true ? 101 : Number(a.accuracy) || 0;
      var ba = b.accuracy === true ? 101 : Number(b.accuracy) || 0;
      return ba - aa;
    });
    return legal[0].id;
  }

  function renderRequest(req) {
    if (!ui || !req) return;
    if (req.wait) { ui.setMsg('...'); ui.setMoves([], {}, null); return; }
    if (req.forceSwitch) {
      // Ask the ENGINE who is legally switchable -- the fainted mon is no
      // longer "active", so we must not infer this from our own indices.
      var opts = battle.switchableFromRequest(req);
      if (!opts.length) { battle.chooseSwitchSlot(0); return; }
      ui.setMsg('Send out which Pokemon?');
      showPartyPanel(true, opts);
      return;
    }
    if (!req.active) return;
    var activeMonForRequest = battle.activeMon();
    var info = battle.enemyInfo();
    var foeTypes = info.types || ['Normal'];
    var isTutorialCapture = !!(run && run.prologue && run.section === 1 && run.battleInSection === 0);
    var isTurn1 = isTutorialCapture && (!info || info.hpPct > 0.9);
    var isTutorialSE = !!(run && run.prologue && run.section === 1 && run.battleInSection === 1);
    var isTurn1SE = isTutorialSE && (!info || info.hpPct > 0.9);
    var isTutorialSwitch = !!(run && run.prologue && run.section === 1 && run.battleInSection === 2);
    // The first request after the prescribed switch teaches in-battle healing.
    // Keep it run-scoped (rather than trusting profile lesson history), so a
    // returning player still follows the guided run's switch -> Bag sequence.
    var isTutorialBattleBag = !!(isTutorialSwitch && run.tutorialSwitchDone &&
      !run.tutorialBattleBagDone);
    var isScriptedSection1 = !!(run && run.prologue && run.section === 1);
    var ownTypes = activeMonForRequest && activeMonForRequest.types ? activeMonForRequest.types : [];
    var forcedDamageId = isTurn1
      ? (bctx.tutorialMoveId || tutorialMoveId(req, null, ownTypes)) : null;
    var forcedSEId = isTurn1SE ? (bctx.tutorialSEMoveId || tutorialMoveId(req, function (d) {
      return C.typeMod(d.type, foeTypes) >= 2;
    }, ownTypes)) : null;
    if (isTurn1 && forcedDamageId) bctx.tutorialMoveId = forcedDamageId;
    if (isTurn1SE && forcedSEId) bctx.tutorialSEMoveId = forcedSEId;

    var moves = (req.active[0].moves || []).map(function (mv, idx) {
      var d = Dex.moves.get(mv.id || mv.move);
      var disabled = !!mv.disabled;
      // Showdown's request object can omit pp/maxpp while a two-turn move is
      // in its locked second turn (Dig, Phantom Force, Fly, etc.). The button
      // still represents the same learned move, so fall back to the live run
      // mon's PP and the move's max PP instead of rendering undefined/undefined.
      var maxpp = mv.maxpp != null ? mv.maxpp :
        (d && d.exists && d.pp ? Math.floor(d.pp * 1.6) : 0);
      var curpp = mv.pp != null ? mv.pp :
        (activeMonForRequest && activeMonForRequest.pp && d && d.id &&
          activeMonForRequest.pp[d.id] != null ? activeMonForRequest.pp[d.id] : maxpp);
      if (isTutorialCapture) {
        if (isTurn1) {
          // Exactly one legal damaging move is presented. Status moves and
          // every other attack are disabled until that one move is pressed.
          if (d.category === 'Status' || (forcedDamageId && d.id !== forcedDamageId)) disabled = true;
        } else {
          // After Pikachu is weakened, the only next action is the one ball on
          // the rail; no second move can accidentally knock it out.
          disabled = true;
        }
      }
      if (isTutorialSE && isTurn1SE && forcedSEId) {
        // Exactly one legal super-effective move is presented; everything
        // else stays locked until it is used. Deliberately gated on
        // `forcedSEId` existing: if no move hits the foe for 2x (a lead the
        // player reordered into a strange matchup), the battle unlocks
        // normally instead of disabling every button -- the lesson simply
        // stays quiet rather than soft-locking the fight.
        if (d.category === 'Status' || d.id !== forcedSEId) disabled = true;
      }
      if (isTutorialSwitch && (!run.tutorialSwitchDone || isTutorialBattleBag)) {
        // The third wild starts with a single prescribed switch. On the next
        // request, moves remain locked for one more beat while Bag is exposed
        // on its own, making in-battle healing the immediate next action.
        disabled = true;
      }
      return { id: d.id, name: d.name, type: d.type, power: d.basePower || 0,
               pp: curpp, max: maxpp, disabled: disabled,
               eff: d.category === 'Status' ? 1 : C.typeMod(d.type, foeTypes),
               _origIdx: idx };
    }).filter(function (m) { return m.id !== RB.IDLE_MOVE; });

    var mon = activeMonForRequest;
    var prompt = 'What will ' + (mon ? mon.name : 'your Pokemon') + ' do?';
    decisionPrompt = prompt;
    ui.setMsg(prompt);
    ui.setPanel(null);
    // Mega Evolution: the engine tells us when it is available (the active mon
    // is holding its matching stone). The toggle is sticky for one action --
    // pick Mega, then pick a move, and both are sent as "move N mega".
    var act0 = req.active[0];
    var megaFlags = {
      cm: !!act0.canMegaEvo,
      cx: !!act0.canMegaEvoX,
      cy: !!act0.canMegaEvoY,
      a: null
    };
    ui.setMoves(moves, megaFlags, function (ch) {
      clearTutBeat('move');
      ui.setMsg('...');
      // Use the original engine index, not the filtered array index
      var move = moves[ch.moveIndex];
      var engineIdx = move ? move._origIdx : ch.moveIndex;
      battle.chooseMove(engineIdx, ch.mega);
    });

    var ballCount = 0, itemCount = 0;
    Object.keys(run.bag).forEach(function (id) {
      if (C.BALLS[id]) ballCount += run.bag[id];
      if (C.HEAL_ITEMS[id] && !C.HEAL_ITEMS[id].revive) itemCount += run.bag[id];
    });
    var activeNow = battle.activeMon();
    var canSwitch = run.party.some(function (m) { return !C.isFainted(m) && m !== activeNow; });
    // A shiny is always catchable: it ignores both the one-per-section rule
    // and the "only the first wild" rule. Letting one walk away would be a
    // uniquely miserable moment in a Nuzlocke.
    var activeShinyMonR = battle.activeEnemyMon ? battle.activeEnemyMon() : null;
    var wildShiny = bctx.cfg.isWild && (activeShinyMonR ? activeShinyMonR.shiny : (bctx.enemies[0] && bctx.enemies[0].shiny));
    var canCatch = wildShiny || (bctx.cfg.catchable && !run.catchUsedThisSection);

    var actCanSwitch = canSwitch;
    var actCanRun = bctx.cfg.isWild;
    var actNoBag = N.isGauntlet(run);
    var actNoRun = N.isGauntlet(run);

    if (isScriptedSection1) {
      // Section 1 has one path: no wandering into Bag, fleeing or an
      // unrequested second switch. The current lesson temporarily enables
      // the one action it is teaching.
      actCanSwitch = false;
      actCanRun = false;
      actNoBag = true;
      actNoRun = true;
    }

    if (isTutorialCapture) {
      if (isTurn1) {
        canCatch = false;
      } else {
        canCatch = true;
      }
    }

    if (isTutorialSE && isTurn1SE) {
      canCatch = false;
    }

    if (isTutorialSwitch && !run.tutorialSwitchDone) {
      actCanSwitch = true;
    }

    if (isTutorialBattleBag) {
      // Party stays disabled and Run stays absent. Bag is the only available
      // utility action until it is opened, after which this battle resumes
      // with the ordinary scripted-section controls.
      actNoBag = false;
    }

    ui.setActions({
      itemCount: itemCount,
      canSwitch: actCanSwitch,
      // Fleeing always works, but only from a WILD battle -- a trainer will
      // not let you walk away. It costs you the battle's prize money.
      canRun: actCanRun,
      // The Gauntlet is pure battle: no bag items to spend, ever, and no
      // running from a trainer -- so those buttons are not offered at all.
      noBag: actNoBag,
      noRun: actNoRun,
      onBag: function () { clearTutBeat('bag'); showBagPanel(); },
      onSwitch: function () {
        if (isTutorialSwitch && !run.tutorialSwitchDone) {
          clearTutBeat('switch');
          bctx.tutorialSwitchOpen = true;
          var reqNow = battle.state.lastRequest;
          var choices = battle.switchableFromRequest(reqNow);
          // The scripted switch sends in the starter when it is a legal
          // switch-in. If the starter is already the active mon (the player
          // skipped making the catch their lead), the only selectable card
          // is the first OTHER legal switch-in -- and the lesson must name
          // THAT Pokemon, not one whose card is locked.
          var wanted = starterMon();
          var wantedIndex = wanted ? run.party.indexOf(wanted) : -1;
          var only = choices.filter(function (o) { return o.partyIndex === wantedIndex; });
          if (!only.length) only = choices.slice(0, 1);
          var switchTarget = only.length ? run.party[only[0].partyIndex] : null;
          if (!switchTarget) {
            // Nothing to switch to at all: the switch lesson cannot be
            // taught in this battle. Unlock the fight rather than stranding
            // the player on an empty, all-disabled panel.
            run.tutorialSwitchDone = true;
            saveGame();
            showPartyPanel(false);
            return;
          }
          bctx.tutorialSwitchTargetUid = switchTarget.uid;
          showPartyPanel(true, only);
          setTimeout(function () { runBattleCoach(true); }, 0);
        } else {
          clearTutBeat('switch'); showPartyPanel(false);
        }
      },
      onRun: function () { clearTutBeat('run'); fleeBattle(); }
    });

    // Poke Balls are a floating rail on the right, only while the encounter
    // is actually catchable.
    if (canCatch && ballCount) buildBallRail();
    else ui.setBallRail(null);

    battleCoach(canCatch && ballCount > 0);
  }

  // ---- in-battle teaching --------------------------------------------------
  // Battle beats are anchored coach BUBBLES, not modal sheets: the fight
  // keeps running underneath them, they dismiss with one tap, and the
  // control they explain KEEPS ITS GLOW until the player actually uses it.
  // The guided run's battle beats, in the order the run makes them matter:
  //   section 1, battle 0 (capture encounter) -> one damaging move, then one ball
  //   section 1, battle 1 (wild)              -> one ×2 move
  //   section 1, battle 2 (wild)              -> Party, switch card, then Bag
  //   section 1, battle 3 (trainer)           -> no in-battle choice lesson
  // All scripted beats are `vital`: if the surface is busy when they fire, they
  // queue and still appear instead of being silently dropped.
  //
  // THE ARMED PULSE. `bctx.tutBeat` remembers which control the live beat
  // teaches: every HUD re-render re-pins .coach-spot on the fresh node (the
  // HUD replaces nodes as it redraws), and the beat only releases when the
  // player performs the action it taught (BEAT_CLEARS) or the battle ends.
  // The next move during the tutorial is therefore always, literally,
  // "press the pulsing thing".
  var BEAT_CLEARS = {
    move:     { battleBag: 1, effect: 1, tutorialDamage: 1 },
    ball:     { catch: 1, tutorialCatch: 1 },
    bag:      { battleBag: 1 },
    'switch': { 'switch': 1 },
    switchPick: { 'switch': 1 },
    run:      { battleBag: 1, catch: 1, effect: 1, 'switch': 1, switchPick: 1, tutorialDamage: 1, tutorialCatch: 1 }
  };

  // The super-effective move button right now, if one is offered. Disabled
  // (mid-animation) still counts: the button being explained is the same one.
  function seMoveBtn() {
    var mbs = document.querySelectorAll('.battle-hud .mb');
    for (var i = 0; i < mbs.length; i++) {
      if (mbs[i].querySelector('.ef.se')) return mbs[i];
    }
    return null;
  }

  var BEAT_TARGETS = {
    // The whole-bar lesson is gone: the bag beat points ONLY at the Bag
    // button, and the player heals with a Full Restore from inside.
    battleBag:  { resolve: function () { return document.querySelector('.battle-hud [data-a="bag"]'); } },
    catch:      { side: 'right',
                  resolve: function () {
                    var rail = document.querySelector('.battle-hud .ballrail');
                    return (rail && rail.querySelector('.br-btn')) ? rail : null;
                  } },
    tutorialDamage: {
      resolve: function () {
        var mbs = document.querySelectorAll('.battle-hud .mb');
        for (var i = 0; i < mbs.length; i++) {
          var mb = mbs[i];
          if (!mb.disabled && bctx && bctx.tutorialMoveId &&
              mb.getAttribute('data-move') === bctx.tutorialMoveId) return mb;
        }
        // First-frame fallback: the capture tutorial disables every move except
        // the one legal damaging choice. If the stored move id has not been
        // filled yet (or an old save disagrees), anchor the bubble to that one
        // enabled move instead of dropping the very first lesson.
        var open = [];
        for (var j = 0; j < mbs.length; j++) if (!mbs[j].disabled) open.push(mbs[j]);
        return open.length === 1 ? open[0] : null;
      }
    },
    tutorialCatch: {
      side: 'right',
      resolve: function () {
        var rail = document.querySelector('.battle-hud .ballrail');
        if (!rail) return null;
        var id = bctx && bctx.tutorialBallId;
        return rail.querySelector(id ? '.br-btn[data-ball="' + id + '"]' : '.br-btn');
      }
    },
    effect: {
      resolve: function () {
        var mbs = document.querySelectorAll('.battle-hud .mb');
        for (var i = 0; i < mbs.length; i++) {
          var mb = mbs[i];
          if (!mb.disabled && bctx && bctx.tutorialSEMoveId &&
              mb.getAttribute('data-move') === bctx.tutorialSEMoveId) return mb;
        }
        return seMoveBtn();
      }
    },
    'switch':   { resolve: function () { return document.querySelector('.battle-hud [data-a="switch"]'); } },
    switchPick: { resolve: function () { return document.querySelector('.battle-hud [data-tutorial="switch"]'); } }
  };

  function armTutBeat(id) {
    var tgt = BEAT_TARGETS[id];
    if (bctx && tgt) bctx.tutBeat = { id: id, resolve: tgt.resolve };
  }

  function clearTutBeat(action) {
    if (!bctx || !bctx.tutBeat || !BEAT_CLEARS[action] || !BEAT_CLEARS[action][bctx.tutBeat.id]) return;
    var id = bctx.tutBeat.id;
    bctx.tutBeat = null;
    if (tutorialSection1()) {
      // Both scripted move lessons have the same lifecycle: choosing the
      // highlighted move dismisses Oak, releases the action lock and completes
      // that popup. If the attack misses, the one legal move stays available,
      // but the explanation does not immediately repeat over the next choice.
      if (id === 'tutorialDamage' && action === 'move') run.tutorialDamageDone = true;
      if (id === 'effect' && action === 'move') run.tutorialEffectDone = true;
      if (id === 'tutorialCatch' && action === 'ball') run.tutorialCatchDone = true;
      if (id === 'switchPick' && action === 'switch') {
        run.tutorialSwitchPickDone = true;
        run.tutorialSwitchDone = true;
      }
      if (id === 'battleBag' && action === 'bag') run.tutorialBattleBagDone = true;
      // Opening Party is a step, but not the final switch until its one card
      // is selected.
      if (id === 'switch' && action === 'switch') run.tutorialSwitchOpen = true;
      if (id === 'tutorialDamage' || id === 'tutorialCatch' || id === 'effect' ||
          id === 'switch' || id === 'switchPick' || id === 'battleBag') {
        if (window.Coach && !window.Coach.seen(id)) window.Coach.markSeen(id);
      }
      saveGame();
    }
    // The taught action just happened: the explanation has done its job, so
    // bubble and glow both go.
    if (window.Coach) { try { window.Coach.clearMark(); } catch (e) {} }
  }

  // Re-pin the armed beat's glow and re-glue any open bubble onto the living
  // node. Called after every HUD re-render (see ensureUI) and on every
  // battle request -- the taught control must stay lit for the whole beat.
  function repinTutGlow() {
    var CO = window.Coach;
    if (!CO || !bctx || !bctx.tutBeat) return;
    var lit = bctx.tutBeat.resolve();
    if (lit && !lit.classList.contains('coach-spot')) CO.halo({ anchor: lit });
    // Keep the rail visibly associated with its one remaining button. The
    // action lock still resolves to the individual ball, so the larger halo
    // is orientation only, never a second choice.
    if (lit && bctx.tutBeat.id === 'tutorialCatch') {
      var rail = lit.closest('.ballrail');
      if (rail) rail.classList.add('coach-spot');
    }
    if (CO.reanchorBubble) CO.reanchorBubble();
  }

  function teachInBattle(id, opts) {
    var CO = window.Coach;
    var tgt = BEAT_TARGETS[id];
    if (!CO || !tgt) return false;
    if (!tgt.resolve()) return false;   // no live subject yet: next request retries
    opts = opts || {};
    var callerOnShow = opts.onShow;
    return CO.lesson(id, {
      surface: 'bubble',
      resolve: tgt.resolve,
      side: tgt.side,
      vital: !!opts.vital,
      actionRequired: opts.actionRequired === true || opts.bypassSeen === true,
      // bypassSeen keeps a scripted tutorial beat firing for THIS run even
      // when the profile already marks it seen; the caller de-dups via a
      // run-scoped flag set in onShow.
      bypassSeen: !!opts.bypassSeen,
      stillValid: opts.stillValid,
      keepHalo: true,
      template: opts.template,
      onShow: function () {
        armTutBeat(id);
        if (id === 'tutorialCatch') {
          var ball = tgt.resolve();
          var rail = ball && ball.closest('.ballrail');
          if (rail) rail.classList.add('coach-spot');
        }
        if (callerOnShow) { try { callerOnShow(); } catch (e) {} }
      }
    });
  }

  // The first damaging-move prompt and the next battle's super-effective
  // prompt deliberately share every presentation/behaviour option. Keeping
  // that contract in one helper prevents one from drifting into a modal,
  // losing its action lock, or opening on a different schedule.
  function teachScriptedMove(id, stillHere) {
    return teachInBattle(id, {
      vital: true,
      bypassSeen: true,
      stillValid: stillHere
    });
  }

  function battleCoach(catchOpen) {
    var CO = window.Coach;
    if (!CO || !CO.tipsOn() || !run || !run.prologue) return;
    // Short settle beat only: the capture-encounter tutorial must pop the
    // moment the battle is on screen, not wait for the first turn to finish.
    setTimeout(function () { runBattleCoach(catchOpen); }, 80);
  }

  // The coach work itself, factored out so a prologue beat can RETRY if its
  // subject (the ball rail, the move buttons) is not in the DOM yet — that is
  // what makes the capture lesson appear instantly instead of a turn late.
  function runBattleCoach(catchOpen) {
    if ($('screenBattle').hidden || !ui) return;
    if (!document.querySelector('.battle-hud')) return;
    var CO = window.Coach;
    if (!CO || !CO.tipsOn() || !run || !run.prologue) return;

    // The HUD re-rendered for this request: re-pin the armed beat's glow
    // on the fresh node and keep any open bubble glued to it.
    repinTutGlow();

    var pro = run && run.prologue;
    var n = run.battleInSection;
    var isWild = bctx && bctx.cfg && bctx.cfg.isWild;
    // A queued beat goes stale the moment the fight moves on or ends; the
    // next natural beat re-requests it (turn requests re-run battleCoach).
    var stillHere = function () {
      return !$('screenBattle').hidden && run && run.battleInSection === n;
    };

    var info = battle.enemyInfo();
    var requested = false;
    if (pro && run.section === 1) {
      if (n === 0 && isWild) {
        // The capture encounter has exactly two actions: one damaging move,
        // then one Poke Ball. The run flags are intentionally separate from
        // profile lesson history, so a previous tutorial cannot skip either.
        if (info && info.hpPct <= 0.9) run.tutorialDamageDone = true;
        if (!run.tutorialDamageDone && info && info.hpPct > 0.9) {
          requested = teachScriptedMove('tutorialDamage', stillHere);
        } else if (!run.tutorialCatchDone && info && info.hpPct <= 0.9) {
          requested = teachInBattle('tutorialCatch', {
            vital: true, bypassSeen: true, stillValid: stillHere
          });
        }
      } else if (n === 1 && isWild && !run.tutorialEffectDone) {
        requested = teachScriptedMove('effect', stillHere);
      } else if (n === 2 && isWild) {
        if (!run.tutorialSwitchDone) {
          if (!bctx.tutorialSwitchOpen) {
            requested = teachInBattle('switch', {
              vital: true, bypassSeen: true, stillValid: stillHere
            });
          } else if (!run.tutorialSwitchPickDone) {
            requested = teachInBattle('switchPick', {
              vital: true, bypassSeen: true, stillValid: stillHere,
              // Name the card that is actually selectable -- the armed switch
              // target -- not the starter. They differ whenever the player
              // skipped making the catch their lead, and naming a locked card
              // would teach the opposite of what the screen allows.
              template: (function () {
                var uid = bctx && bctx.tutorialSwitchTargetUid;
                var m = null;
                if (uid != null) {
                  for (var pi = 0; pi < run.party.length; pi++) {
                    if (String(run.party[pi].uid) === String(uid)) { m = run.party[pi]; break; }
                  }
                }
                if (!m) m = starterMon();
                return m ? { NAME: monDisplayName(m) } : null;
              }())
            });
          }
        } else if (!run.tutorialBattleBagDone) {
          // This is deliberately the very next request after the switch. It
          // bypasses profile history because the action is part of this run's
          // required sequence, not an optional contextual reminder.
          requested = teachInBattle('battleBag', {
            vital: true,
            bypassSeen: true,
            stillValid: function () { return stillHere() && !run.tutorialBattleBagDone; }
          });
        }
      }
      // Battle 3 (the Trainer) has no in-battle lesson: the route has already
      // named the one button that starts it, and all item/run controls remain
      // locked for this scripted fight.
    }

    // Section 1 is a closed script. Do not let ordinary contextual lessons
    // (Bag, generic effect, catch) sneak in after the scripted beat has been
    // completed; they would create a second possible next action.
    if (pro && run.section === 1) return;

    // Outside the closed section-1 script, ordinary runs still receive this
    // contextual Bag reminder on their first eligible battle. Guided runs
    // have already completed and marked it during battle 2 above.
    if (!requested && !CO.seen('battleBag') && !(pro && !isWild)) {
      requested = teachInBattle('battleBag', {});
    }

    if (!requested && !CO.seen('effect')) {
      requested = teachInBattle('effect', {});
    }

    if (!requested && catchOpen && !CO.seen('catch')) {
      info = battle.enemyInfo();
      if (info && info.hpPct <= 0.7) requested = teachInBattle('catch', {});
    }

    // The subject was not in the DOM yet (first frames of a battle). Retry a
    // few times so a scripted beat still lands the moment it can — this is
    // the "instant catch lesson" guarantee.
    if (pro && run.section === 1 && !requested && n === 0 && isWild) {
      var tries = 0;
      var retry = setInterval(function () {
        tries++;
        if ($('screenBattle').hidden || !bctx || bctx.ended || tries > 12) {
          clearInterval(retry);
          return;
        }
        info = battle.enemyInfo();
        var retryId = !run.tutorialDamageDone && info && info.hpPct > 0.9
          ? 'tutorialDamage'
          : (!run.tutorialCatchDone && info && info.hpPct <= 0.9 ? 'tutorialCatch' : null);
        var retried = retryId === 'tutorialDamage'
          ? teachScriptedMove(retryId, stillHere)
          : (retryId ? teachInBattle(retryId, {
              vital: true, bypassSeen: true, stillValid: stillHere
            }) : false);
        if (retried) clearInterval(retry);
      }, 250);
    }

    if (pro && run.section === 1 && !requested && n === 1 && isWild && !run.tutorialEffectDone) {
      var tries1 = 0;
      var retry1 = setInterval(function () {
        tries1++;
        if ($('screenBattle').hidden || !bctx || bctx.ended || tries1 > 12) {
          clearInterval(retry1);
          return;
        }
        if (teachScriptedMove('effect', stillHere)) clearInterval(retry1);
      }, 250);
    }
  }

  // Running from a wild battle: it never fails, but you forfeit the reward.
  // The section still advances, so fleeing is a real escape valve when a
  // fight is going badly -- paid for in cash rather than in RNG.
  function fleeBattle() {
    if (!bctx || bctx.ended || !bctx.cfg.isWild) return;
    bctx.ended = true;
    bctx.fled = true;
    run._inBattle = false; run._battleCfg = null;
    syncBattleToRun(); saveGame();
    ui.setPanel(null);
    ui.setBallRail(null);
    ui.setMsg('Got away safely!');
    ui.log('You fled the battle. No prize money.');
    ui.floatT('Got away safely!', 'nv');
    clearQueue();
    try { battle.finish('fled'); } catch (e) {}
    // A capture encounter you run from still burns this section's catch.
    var missed = false;
    if (bctx.cfg.catchable && !run.catchUsedThisSection) {
      run.catchMissed = true;
      run.catchUsedThisSection = true;
      missed = true;
      N.logMsg(run, 'You fled -- the catch chance for Section ' + run.section + ' was lost.');
    } else {
      N.logMsg(run, 'You fled the battle.');
    }
    // Anything that fainted before you ran is still gone for good.
    var dead = N.buryFainted(run, 'wild ' + speciesOf(bctx.enemies[0]));
    var ss = run.sectionStats;
    if (ss && dead.length) dead.forEach(function (d) { ss.lost.push({ name: d.name, id: d.id }); });
    setTimeout(function () {
      if (!N.alive(run).length) { gameOver(); return; }
      showFled(dead, missed);
    }, 900);
  }

  function showFled(dead, missedCatch) {
    show('Reward');
    $('rewardTitle').textContent = 'Got away safely!';
    $('rewardTitle').className = 'scr-title';
    var html = '<p class="fled-note">You fled the battle \u2014 <b>no prize money</b>.</p>';
    if (dead && dead.length) {
      html += '<div class="losses"><h4>Lost forever</h4>' + dead.map(function (m) {
        return '<div class="grave">' + iconEl(m.id, 1.1, '', m.shiny) + '<span>' + escapeHtml(m.name) + '</span></div>';
      }).join('') + '</div>';
    }
    if (missedCatch) {
      html += '<div class="miss-note"><b>Catch lost.</b> That was Section ' + run.section +
              '\u2019s only wild encounter.</div>';
    }
    html += '<p class="hint">Battles won: <b>' + run.battlesWon + '</b> \u00b7 Party: <b>' +
            run.party.length + '</b></p>';
    $('rewardBody').innerHTML = html;
    // A previous victory may have disabled Continue while waiting for an item
    // choice. Fleeing has no choice screen, so make sure it remains escapable.
    $('btnRewardDone').disabled = false;
    $('btnRewardDone').onclick = afterBattleAdvance;
    renderHud();
  }

  function showPartyPanel(forced, engineOpts) {
    var activeMon = battle.activeMon();
    var allowed = null;
    if (engineOpts) {
      allowed = {};
      engineOpts.forEach(function (o) { allowed[o.partyIndex] = o.slot; });
    }
    // Build rich items mirroring crossroads team detail: big sprite, hp bar, status badge color, types, moves preview
    var items = run.party.map(function (m, i) {
      var ok = allowed ? (allowed[i] != null) : (!C.isFainted(m) && m !== activeMon);
      // Use live battle HP/status for the active Pokemon (run.party is only synced at battle start)
      var isActive = m === activeMon;
      var liveHp = isActive && ui && ui.s && ui.s.p ? ui.s.p.hp : m.hpPct;
      var liveStatus = isActive && ui && ui.s && ui.s.p ? ui.s.p.st : m.status;
      var pct = pctHP(liveHp);
      var hpCol = liveHp > 0.5 ? '#4ade80' : liveHp > 0.2 ? '#facc15' : '#ef4444';
      var cur = Math.round(C.maxHP(m) * liveHp), mx = C.maxHP(m);
      var stCol = statusColor(liveStatus);
      var stTxtCol = (liveStatus === 'par') ? '#000' : '#fff';
      // Build a detailed HTML blob for the battle switcher that mimics pd-card
      var html = '<div class="pd-hero" style="margin:0">' +
        '<div class="pd-art">' + bigSprite(m.id, '', 72, 72, 1, m.shiny) + '</div>' +
        '<div class="pd-id" style="min-width:0">' +
          '<div class="pd-species">' + speciesOf(m) + (m.shiny ? ' \u2728' : '') + '</div>' +
          '<div class="pd-name" style="font-size:1.1rem">' + escapeHtml(monDisplayName(m)) + '</div>' +
          '<div class="types" style="margin-top:2px">' + typeChips(m.types) + '</div>' +
        '</div>' +
      '</div>' +
        '<div class="pd-hp" style="margin-top:8px">' +
          '<div class="hm-b big"><i style="width:' + pct + '%;background:' + hpCol + '"></i></div>' +
          '<span>' + cur + ' / ' + mx + (liveStatus ? ' \u00b7 ' + liveStatus.toUpperCase() : '') + '</span>' +
          (liveStatus ? '<span class="battle-st-badge" style="margin-left:6px;background:' + stCol + ';color:' + stTxtCol + ';padding:2px 6px;border-radius:999px;font-size:.62rem">' + liveStatus.toUpperCase() + '</span>' : '') +
        '</div>';
      return {
        name: monDisplayName(m),
        species: speciesOf(m),
        hp: liveHp,
        fainted: C.isFainted(m),
        active: m === activeMon,
        status: liveStatus,
        statusColor: stCol,
        pct: pct,
        hpCol: hpCol,
        cur: cur,
        mx: mx,
        types: m.types.slice(),
        iconHtml: animSprite(m.id, 46, 52, '', 1.4, m.shiny),
        detailHtml: html,
        disabled: !ok,
        tutorial: !!(bctx && bctx.tutorialSwitchTargetUid &&
          String(m.uid) === String(bctx.tutorialSwitchTargetUid))
      };
    });
    ui.setPanel({
      type: 'party-rich', items: items,
      onPick: function (i) {
        // In the scripted third stop the only enabled row is the named
        // starter. Selecting it is the exact moment the switch lesson ends.
        if (bctx && bctx.cfg && bctx.cfg.isTutorialSwitch && !run.tutorialSwitchDone) {
          if (!allowed || allowed[i] == null) return;
          clearTutBeat('switch');
          run.tutorialSwitchDone = true;
          bctx.tutorialSwitchOpen = true;
          saveGame();
        }
        ui.setPanel(null); ui.setMsg('...');
        if (allowed && allowed[i] != null) battle.chooseSwitchSlot(allowed[i]);
        else battle.chooseSwitch(i);
      },
      onBack: forced ? null : function () { ui.setPanel(null); renderRequest(battle.state.lastRequest); }
    });
    if (forced) {
      var bk = ui.hud && ui.hud.querySelector('.bg-back');
      if (bk) bk.style.display = 'none';
    }
  }

  function buildBallRail() {
    var info = battle.enemyInfo();
    var list = [];
    var tutorialCapture = !!(run && run.prologue && run.section === 1 &&
      run.battleInSection === 0);
    var tutorialBallId = null;
    if (tutorialCapture) {
      tutorialBallId = run.bag.pokeball > 0 ? 'pokeball' :
        Object.keys(run.bag).filter(function (id) { return C.BALLS[id] && run.bag[id] > 0; })[0] || null;
      if (bctx) bctx.tutorialBallId = tutorialBallId;
    }
    var activeShinyMon = battle.activeEnemyMon ? battle.activeEnemyMon() : null;
    var shinySrc = activeShinyMon || (bctx.enemies && bctx.enemies[0]) || {};
    Object.keys(run.bag).forEach(function (id) {
      if (!C.BALLS[id]) return;
      // The capture lesson has one answer, not a choice between five ball
      // types. Prefer a Poke Ball; a repaired/older save falls back to its
      // first available ball so the tutorial can never dead-end.
      if (tutorialCapture && id !== tutorialBallId) return;
      var shinyTgt = shinySrc && shinySrc.shiny;
      var ch = shinyTgt ? 1 : C.catchChance(id, info.id, info.hpPct, info.status,
        { turn: battle.state.turn, targetTypes: info.types });
      list.push({
        id: id, name: C.BALLS[id].name, qty: run.bag[id],
        chance: Math.round(ch * 100),
        img: window.ItemArt ? window.ItemArt.itemImg(id, 34) : '',
        onPick: function (ballId) { ui.setBallRail(null); throwBall(ballId); }
      });
    });
    list.sort(function (a, b) { return b.chance - a.chance; });
    ui.setBallRail(list);
  }

  function showBagPanel() {
    var mon = battle.activeMon();
    var items = [];
    Object.keys(run.bag).forEach(function (id) {
      var h = C.HEAL_ITEMS[id];
      if (!h || h.revive) return;
      items.push({ name: h.name, qty: run.bag[id], note: h.desc, disabled: false, _id: id });
    });
    if (!items.length) { toast('No usable items!'); return; }
    ui.setPanel({
      type: 'list', title: 'Use an item on ' + (mon ? mon.name : ''),
      items: items,
      onPick: function (i) { ui.setPanel(null); useBattleItem(items[i]._id, mon); },
      onBack: function () { ui.setPanel(null); renderRequest(battle.state.lastRequest); }
    });
  }

  function useBattleItem(itemId, mon) {
    var b = battle.battle, live = b && b.p1.active[0], h = C.HEAL_ITEMS[itemId];
    if (!live || !h) return;
    var before = live.hp, did = false, msgs = [];
    if (h.healPct) {
      var amount = Math.max(1, Math.round(live.maxhp * h.healPct));
      var got = Math.min(live.maxhp - live.hp, amount);
      if (got > 0) { live.hp += got; did = true; msgs.push(mon.name + ' recovered ' + got + ' HP!'); }
    }
    if (h.cure && live.status && (h.cure === 'all' || h.cure === live.status)) {
      live.clearStatus(); did = true; msgs.push(mon.name + ' was cured!');
    }
    if (h.ppAll) {
      live.moveSlots.forEach(function (s) {
        if (s.id === RB.IDLE_MOVE) return;
        if (s.pp < s.maxpp) { s.pp = Math.min(s.maxpp, s.pp + h.ppAll); did = true; }
      });
      if (did) msgs.push('PP restored!');
    }
    if (!did) { toast('It had no effect.'); return; }
    N.useItem(run, itemId);
    ui.setHp('p', live.hp / live.maxhp);
    ui.setStatus('p', live.status || null);
    if (h.healPct) { ui.floatN('p', Math.round((live.hp - before) / live.maxhp * 100), 'heal'); ui.flashHeal('p'); }
    ui.setMsg(msgs.join(' ')); ui.log(msgs.join(' '));
    battle.passTurn();
  }

  // ---- POKE BALL THROW ANIMATION -----------------------------------------
  // The engine positions the enemy sprite absolutely every frame, so we can
  // read its live rect and (a) fly the ball to exactly that spot, and
  // (b) shrink the Pokemon INTO the ball rather than parking the ball beside it.
  function enemyRect() {
    try {
      var img = ui && ui.s && ui.s.e && ui.s.e.img;
      var host = $('battleHost');
      if (!img || !host) return null;
      var r = img.getBoundingClientRect(), h = host.getBoundingClientRect();
      if (!r.width) return null;
      // aim for the body centre, and remember where the feet are so the ball
      // can drop to the ground afterwards
      return { cx: r.left - h.left + r.width / 2,
               cy: r.top - h.top + r.height * 0.55,
               feet: r.top - h.top + r.height,
               w: r.width, h: r.height };
    } catch (e) { return null; }
  }

  // Animate the enemy sprite being absorbed / released.
  function absorbEnemy(into) {
    var img = ui && ui.s && ui.s.e && ui.s.e.img;
    if (!img) return;
    if (into) {
      img.style.transition = 'transform .34s cubic-bezier(.5,-0.3,.8,.4), opacity .34s ease-in, filter .2s';
      img.style.transformOrigin = '50% 100%';
      img.style.transform = 'scale(0.05)';
      img.style.opacity = '0';
      img.style.filter = 'brightness(2.2) saturate(0)';
      ui._ballHidingEnemy = true;
    } else {
      img.style.transition = 'transform .3s cubic-bezier(.2,1.6,.4,1), opacity .25s, filter .25s';
      img.style.transform = '';
      img.style.opacity = '1';
      img.style.filter = '';
      ui._ballHidingEnemy = false;
      setTimeout(function () {
        if (img) { img.style.transition = ''; img.style.transformOrigin = ''; }
      }, 340);
    }
  }

  function ballAnim(ballId, shakes, caught, done) {
    // Cap visual shakes at 3 — the engine uses 4 checks for probability but
    // the player only ever sees at most 3 wobbles.
    shakes = Math.min(3, shakes);
    var host = $('battleHost');
    var target = enemyRect();
    if (!host || !target) { done(); return; }

    var wrap = document.createElement('div');
    wrap.className = 'ball-fx';
    var img = window.ItemArt ? window.ItemArt.itemImg(ballId, 30, 'ball-sprite')
                             : '<span class="ball-sprite"></span>';
    wrap.innerHTML = '<div class="ball-thrown">' + img + '</div>' +
                     '<div class="ball-open"></div>';
    host.appendChild(wrap);

    var thrown = wrap.querySelector('.ball-thrown');
    var flash = wrap.querySelector('.ball-open');

    // start near the player's side, land exactly on the enemy sprite
    var startX = host.clientWidth * 0.18, startY = host.clientHeight * 0.66;
    var endX = target.cx, endY = target.cy;
    var peak = Math.min(startY, endY) - Math.max(90, host.clientHeight * 0.16);

    thrown.style.left = (startX - 15) + 'px';
    thrown.style.top  = (startY - 15) + 'px';
    flash.style.left = endX + 'px';
    flash.style.top  = endY + 'px';

    // 1. arc via keyframe interpolation through the peak
    var T_ARC = 560;
    thrown.animate([
      { transform: 'translate(0,0) rotate(0deg) scale(.8)' },
      { transform: 'translate(' + ((endX - startX) * 0.5) + 'px,' + (peak - startY) + 'px) rotate(360deg) scale(.95)', offset: 0.5 },
      { transform: 'translate(' + (endX - startX) + 'px,' + (endY - startY) + 'px) rotate(720deg) scale(1)' }
    ], { duration: T_ARC, easing: 'ease-out', fill: 'forwards' });

    // 2. open + absorb the Pokemon
    setTimeout(function () {
      flash.classList.add('go');
      absorbEnemy(true);
    }, T_ARC - 40);

    // 3. drop to the ground under the target, then wobble
    var T_DROP = 320;
    setTimeout(function () {
      var groundY = target.feet ? (target.feet - 10) : (endY + target.h * 0.35);
      thrown.animate([
        { transform: 'translate(' + (endX - startX) + 'px,' + (endY - startY) + 'px) rotate(720deg)' },
        { transform: 'translate(' + (endX - startX) + 'px,' + (groundY - startY) + 'px) rotate(720deg)' }
      ], { duration: T_DROP, easing: 'cubic-bezier(.4,0,.8,1)', fill: 'forwards' });
      setTimeout(startWobble, T_DROP);
    }, T_ARC + 120);

    function startWobble() {
      var i = 0;
      (function step2() {
        if (i >= Math.max(1, shakes)) {
          setTimeout(function () {
            if (caught) {
              thrown.classList.add('caught');
              setTimeout(function () { cleanup(); done(); }, 720);
            } else {
              thrown.classList.add('burst');
              absorbEnemy(false);
              setTimeout(function () { cleanup(); done(); }, 500);
            }
          }, 240);
          return;
        }
        i++;
        thrown.classList.remove('wob');
        void thrown.offsetWidth;
        thrown.classList.add('wob');
        setTimeout(step2, 600);
      })();
    }

    function cleanup() {
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
    }
  }

  function throwBall(ballId) {
    var info = battle.enemyInfo();
    N.useItem(run, ballId);
    var nm = C.BALLS[ballId].name;
    ui.setMsg('You threw a ' + nm + '!'); ui.log('You threw a ' + nm + '!');
    // Shinies have a 100% catch rate -- any ball, any HP.
    // Use the active enemy mon, not hard-coded enemies[0], so a shiny that
    // appears mid-battle (wild only has one, but future-proof) is respected.
    var tgt = (battle.activeEnemyMon ? battle.activeEnemyMon() : null) || bctx.enemies[0];
    var isTutorialCapture = !!(run && run.prologue && run.section === 1 && run.battleInSection === 0);
    var res = (isTutorialCapture || (tgt && tgt.shiny))
      ? { caught: true, shakes: 4 }
      : C.rollCatch(ballId, info.id, info.hpPct, info.status,
          { turn: battle.state.turn, targetTypes: info.types }, run.rand);
    ballAnim(ballId, res.shakes, res.caught, function () {
      // The wobble chain runs on bare timers: if the battle surface was
      // torn down while the ball was mid-air (screen change, teardown),
      // `ui` is gone and the callback must not touch it -- the uncaught
      // TypeError used to kill the timer AND strand the run in
      // _inBattle with no screen left to play it.
      if (!ui) return;
      if (res.caught) { ui.floatT('Gotcha!', 'se'); onCaught(); }
      else {
        var t = res.shakes === 0 ? 'Oh no! It broke free!'
              : res.shakes === 1 ? 'Aww, so close!'
              : res.shakes === 2 ? 'Argh! Almost had it!' : 'Gah! It escaped at the last second!';
        ui.floatT(t, 'nv'); ui.setMsg(t);
        battle.passTurn();
      }
    });
  }

  async function onCaught() {
    battle.sync();
    // A break-free keeps the rail lit for the retry; the catch itself is
    // what the beat was teaching, so its glow ends here.
    clearTutBeat('ball');
    var caught = (battle.activeEnemyMon ? battle.activeEnemyMon() : null) || bctx.enemies[0];
    var clone = JSON.parse(JSON.stringify(caught));
    clone.uid = 'c' + Date.now();

    var isTutorialCapture = !!(run && run.prologue && run.section === 1 && run.battleInSection === 0);
    if (isTutorialCapture && clone.id === 'pikachu') {
      try {
        var autoMoves = await C.autoMoveset('pikachu');
        var extraMoves = autoMoves.filter(function (m) {
          return m !== 'tickle' && clone.moves.indexOf(m) < 0;
        });
        for (var mi = 0; mi < extraMoves.length && clone.moves.length < 4; mi++) {
          clone.moves.push(extraMoves[mi]);
        }
        clone.pp = clone.pp || {};
        clone.moves.forEach(function (mId) {
          if (clone.pp[mId] == null) {
            var mv = Dex.moves.get(mId);
            if (mv && mv.exists) {
              clone.pp[mv.id] = Math.floor(mv.pp * 1.6);
            }
          }
        });
      } catch (e) {
        console.error('[catch] failed to generate additional Pikachu moves', e);
      }
    }

    // Keep EXACTLY the HP / PP / status it had at capture. Only guard against
    // a literal 0 (it was caught, so it can't join the party already fainted).
    if (clone.hpPct <= 0) clone.hpPct = 1 / Math.max(1, C.maxHP(clone));
    bctx.caught = true;
    run._inBattle = false; run._battleCfg = null;
    syncBattleToRun(); saveGame();
    // A shiny caught OUTSIDE the designated capture encounter is a bonus: it
    // must not consume this section's one legitimate catch.
    var bonusShiny = clone.shiny && !bctx.cfg.catchable;
    if (!bonusShiny) {
      run.catchUsedThisSection = true;
      run.catchMissed = false;
      run.lastCaughtName = clone.name;
    }
    run.caught++;
    run.seenSpecies[clone.id] = 1;
    // NOTE: compute the reward BEFORE crediting it. `var` hoisting meant the
    // old order read `money` while it was still undefined, so the section
    // total became NaN on any section where something was caught.
    var money = Math.round(N.wildReward(run) * 0.5);
    run.money += money;
    if (run.sectionStats) run.sectionStats.money = (Number(run.sectionStats.money) || 0) + money;
    run.battlesWon++;
    N.logMsg(run, 'Caught ' + clone.name + '!');
    battle.finish('caught');
    // handleEnd() returns early for a catch, so it never runs buryFainted.
    // Without this, a Pokemon that fainted during a capture battle stays in
    // the party and the Poke Center happily "revives" it.
    var deadOnCatch = N.buryFainted(run, 'wild ' + speciesOf(caught));
    setTimeout(function () {
      if (deadOnCatch.length) {
        toast(deadOnCatch.map(function (d) { return d.name; }).join(', ') + ' was lost.');
      }
      if (!N.alive(run).length) { gameOver(); return; }
      showCatch(clone, money);
    }, 800);
  }

  function showCatch(clone, money) {
    show('Catch');
    $('catchTitle').textContent = (clone.shiny ? '\u2728 Shiny! ' : 'Gotcha! ') + clone.name + ' was caught!';
    var st = clone.status ? clone.status.toUpperCase() : 'none';
    $('catchBody').innerHTML =
      '<div class="catch-new">' + bigSprite(clone.id, '', 140, 154, 1, clone.shiny) +
      '<div class="catch-info">' +
      '<h3 style="margin:0 0 8px 0;">' + escapeHtml(clone.name) + '</h3>' +
      '<div class="types" style="justify-content:center;">' + typeChips(clone.types) + '</div>' +
      '<div class="statline" style="margin:8px 0;font-size:1rem;">HP ' + pctHP(clone.hpPct) + '% \u00b7 Status ' + st + '</div>' +
      '<div class="ability" style="margin:6px 0;opacity:0.8;">' + clone.ability + '</div>' +
      '<div class="movelist">' + clone.moves.map(function (m) {
        var d = Dex.moves.get(m);
        var pw = d.category === 'Status' ? 'Status' : (d.basePower ? 'Pow ' + d.basePower : '');
        return '<div class="move-card-inline">' +
          '<div class="mci-top"><span class="mv-chip type-' + d.type + '">' + d.type + '</span>' +
          '<span class="mci-pw">' + pw + '</span></div>' +
          '<span class="mci-name">' + d.name + '</span></div>';
      }).join('') + '</div></div></div>' +
      '<p class="hint">It keeps the HP, PP and status it had when caught.</p>' +
      '<p class="reward-money">+$' + money + '</p>';

    var COc = window.Coach;
    if (COc && COc.tipsOn() && run && run.prologue && !COc.seen('caught')) {
      setTimeout(function () {
        if ($('screenCatch').hidden || !run || !run.prologue) return;
        COc.lesson('caught', {
          vital: !!(run && run.prologue),
          stillValid: function () { return !$('screenCatch').hidden; }
        });
      }, 700);
    }

    var swap = $('catchSwap');
    // The guided run's "make it your lead" step points at the Pokemon that
    // was just caught, so remember which one that was.
    if (run && run.prologue) run._tutCatchUid = clone.uid;
    if (run.party.length < N.MAX_PARTY) {
      swap.innerHTML = '';
      $('btnCatchDone').hidden = true;
      askNickname(clone, function (nick) {
        clone.species = C.cleanName(clone.id);
        clone.name = nick;
        run.party.push(clone);
        N.trackMon(run, clone);
        N.logMsg(run, 'Caught ' + nick + ' the ' + clone.species + '!');
        $('catchTitle').textContent = 'Gotcha! ' + nick + ' was caught!';
        // Register AFTER nicknaming so the collection stores the name the
        // player actually chose, not the raw species.
        if (clone.shiny) { recordShiny(clone, 'caught'); toast('\u2728 ' + nick + ' added to your Shiny Collection!'); }
        $('btnCatchDone').hidden = false;
        renderHud(); saveGame();
      });
    } else {
      $('btnCatchDone').hidden = true;
      swap.innerHTML = '<p class="hint">Your party is full. Choose a Pokemon to release, or let it go.</p>' +
        '<div class="swap-grid">' + run.party.map(function (m, i) {
          return '<button class="swap-btn" data-i="' + i + '">' + iconEl(m.id, 1.2, '', m.shiny) + '<span>' + escapeHtml(m.name) + '</span>' +
                 '<small>' + pctHP(m.hpPct) + '% \u00b7 ' + Math.round(run.damageDealt[m.uid] || 0) + ' dmg</small></button>';
        }).join('') + '<button class="swap-btn skip" data-i="-1"><span>Release the new one</span></button></div>';
      swap.querySelectorAll('.swap-btn').forEach(function (b) {
        b.addEventListener('click', function () {
          var i = +b.dataset.i;
          if (i < 0) {
            // Even a released shiny was caught -- it belongs in the collection.
            if (clone.shiny) recordShiny(clone, 'caught');
            toast('You released ' + clone.name + '.'); afterBattleAdvance(); return;
          }
          askNickname(clone, function (nick) {
            clone.species = C.cleanName(clone.id);
            clone.name = nick;
            var old = run.party.splice(i, 1, clone)[0];
            N.trackMon(run, clone);
            N.logMsg(run, 'Released ' + old.name + ' for ' + nick + '.');
            if (clone.shiny) recordShiny(clone, 'caught');
            toast(nick + ' joined the party!');
            afterBattleAdvance();
          });
        });
      });
    }
  }

  // ---- battle end ----
  function handleEnd(res) {
    if (!bctx || !run) return;
    if (bctx.ended) return;
    if (res.result === 'caught') return;
    bctx.ended = true;
    run._inBattle = false; run._battleCfg = null;
    syncBattleToRun(); saveGame();
    // Wait for the event queue to ACTUALLY drain (the faint animation is the
    // last thing in it) instead of guessing a duration. `win` arrives on the
    // same chunk as `faint`, so a fixed timer would cut the KO short.
    function whenQueueDone(fn) {
      if (evQ.length || evTimer) { setTimeout(function () { whenQueueDone(fn); }, 120); return; }
      setTimeout(fn, 250);   // brief beat once the faint has played
    }
    whenQueueDone(function () {
      clearQueue();
      var killer = bctx.cfg.isWild ? ('wild ' + speciesOf(bctx.enemies[0])) : bctx.cfg.trainer.name;
      var dead = N.buryFainted(run, killer);
      // A catchable encounter that ended without a capture is a MISS: this
      // section yields no new Pokemon at all.
      var missed = false;
      if (bctx.cfg.catchable && !bctx.caught && !run.catchUsedThisSection) {
        run.catchMissed = true;
        run.catchUsedThisSection = true;
        missed = true;
        N.logMsg(run, 'The catch chance for Section ' + run.section + ' was lost.');
      }
      if (res.result === 'win') {
        run.battlesWon++;
        // The Gauntlet pays nothing: no cash exists in the mode at all.
        var money = N.isGauntlet(run) ? 0
          : (bctx.cfg.isWild ? N.wildReward(run) : N.trainerReward(run));
        var healed = false;
        if (!bctx.cfg.isWild) {
          run.trainersBeaten++;
          // Beating a trainer closes the section: the survivors are patched
          // up for free. (The fallen stay fallen -- healAll skips them.)
          // Every Gauntlet battle is a trainer battle, so this is also the
          // Gauntlet's "full restore after every won battle".
          healed = N.alive(run).some(function (m) { return m.hpPct < 1 || m.status; });
          N.healAll(run);
          if (healed) N.logMsg(run, 'Your team rested and recovered fully.');
        }
        run.money += money;
        // Clearing section 5 is the gateway to the strong section-6 catch.
        // Award this once, on the section's trainer victory (handleEnd is
        // guarded against duplicate resolution), rather than making it a
        // random shop item.
        var sectionItemReward = (!N.isGauntlet(run) && !bctx.cfg.isWild &&
          run.section === 5 && N.sectionCompletionReward(run.section)) || null;
        var itemChoices = N.battleRewardChoices(run);
        if (sectionItemReward) {
          N.addItem(run, sectionItemReward, 1);
          N.logMsg(run, 'Section 5 complete! You received a Master Ball.');
          // Persist the milestone before the player dismisses the reward
          // screen; a refresh here must not make the prize disappear.
          saveGame();
        }
        var ss = run.sectionStats || (run.sectionStats = { money:0, won:0, caught:null, lost:[], damage:0, kos:0, startedAt:run.section });
        ss.money = (Number(ss.money) || 0) + (Number(money) || 0);
        ss.won = (Number(ss.won) || 0) + 1;
        dead.forEach(function (d) { ss.lost.push({ name: d.name, id: d.id, shiny: d.shiny }); });
        // Beating a trainer clears the section, so instead of a 1-of-3 item
        // pick the reward screen announces the progression that just unlocked:
        // better balls in the shop, stronger wilds, and a harder climb.
        var trainerWin = !bctx.cfg.isWild && !N.isGauntlet(run);
        showReward(money, dead, false, missed, healed, sectionItemReward,
          trainerWin ? [] : itemChoices, trainerWin);
      } else {
        if (!N.alive(run).length) return gameOver();
        var ss2 = run.sectionStats || (run.sectionStats = { money:0, won:0, caught:null, lost:[], damage:0, kos:0, startedAt:run.section });
        dead.forEach(function (d) { ss2.lost.push({ name: d.name, id: d.id, shiny: d.shiny }); });
        showReward(0, dead, true, missed);
      }
    });
  }

  function showReward(money, dead, lost, missedCatch, healed, itemReward, itemChoices, trainerWin) {
    itemChoices = Array.isArray(itemChoices) ? itemChoices : [];
    rewardChoicePending = null;
    rewardEvoPending = null;
    rewardEvoOnScreen = false;
    show('Reward');
    $('rewardTitle').textContent = lost ? 'Defeated...' : 'Victory!';
    $('rewardTitle').className = 'scr-title' + (lost ? ' dead' : '');
    var html = '';
    if (money) html += '<p class="reward-money">+$' + money + '</p>';
    if (dead && dead.length) {
      html += '<div class="losses"><h4>Lost forever</h4>' + dead.map(function (m) {
        return '<div class="grave">' + iconEl(m.id, 1.1, '', m.shiny) + '<span>' + escapeHtml(m.name) + '</span></div>';
      }).join('') + '</div>';
    }
    if (missedCatch) {
      html += '<div class="miss-note"><b>Catch failed.</b> That was Section ' + run.section +
              '\u2019s only wild encounter \u2014 no new Pokemon this section.</div>';
    }
    if (healed) html += '<p class="reward-heal">Your team was fully restored.</p>';
    if (itemReward) {
      html += '<p class="reward-item">You received a <b>' + escapeHtml(itemName(itemReward)) + '</b>!</p>';
    }
    if (trainerWin && !lost) {
      // A trainer win closes a section: the "prize" is progression itself.
      // The ball line is truthful about the next shelf: sections 1->2 and
      // 2->3 move up a tier; afterwards the Ultra Ball shelf just restocks.
      var finished = run.section;
      var nextBall = finished === 1 ? 'greatball' : finished === 2 ? 'ultraball' : null;
      var ballLine = nextBall
        ? 'Poke Balls are upgraded in the shop \u2014 ' + itemName(nextBall) + 's are now in stock.'
        : 'The shop is restocked with Ultra Balls.';
      html += '<div class="reward-upgrade">' +
        '<h3>Section ' + finished + ' cleared!</h3>' +
        '<ul class="upgrade-list">' +
          '<li><b>' + ballLine + '</b></li>' +
          '<li><b>Pokemon encounters are upgraded</b> \u2014 stronger wilds appear from here on.</li>' +
          '<li><b>Difficulty is increased</b> \u2014 trainers and fields get tougher every section.</li>' +
        '</ul>' +
        '<p class="hint">' +
          (run.maxSections && finished >= run.maxSections
            ? 'Tap Continue to see your results.'
            : 'Tap Continue to move on to Section ' + (finished + 1) + '.') +
        '</p>' +
      '</div>';
    }
    if (itemChoices.length) {
      // A fourth "skip for cash" card is always offered alongside the three
      // item picks. Its cash is calibrated to be a clear downgrade on trainer
      // battles (where 2x BASE makes the money reward already the larger of
      // the two) and a close call on wild battles -- an item the party can
      // actually use tends to be worth more than a cash infusion, so picking
      // skip is a deliberate trade, not always strictly optimal. The card
      // sits at the end of the row so the seeded item order is preserved.
      var skipId = '__skip_for_cash__';
      var skipCash = Math.round(N.BASE_REWARD * 0.75 *
        N.rewardMultiplier(run) * N.ascensionRewardBonus(run));
      var cards = itemChoices.slice();
      cards.push({ id: skipId, kind: 'cash', name: 'Cash bundle',
                   desc: '+$' + skipCash.toLocaleString() + ' instead of an item.' });
      html += '<div class="reward-pick"><h3>Choose one reward</h3>' +
        '<p class="hint">Take one item \u2014 it is used or given immediately \u2014 or trade all three for cash.</p>' +
        '<div class="reward-choices reward-choices-4">' + cards.map(function (entry) {
          if (entry.id === skipId) {
            // Cash card: a money-themed pill in place of an item sprite.
            return '<button type="button" class="reward-choice reward-choice-cash" data-reward-id="' +
              escapeHtml(entry.id) + '"><span class="reward-choice-art reward-choice-cash-art">' +
              '$</span><span class="reward-choice-copy"><b>' + escapeHtml(entry.name) +
              '</b><small>Skip items</small><em>' + escapeHtml(entry.desc) +
              '</em></span></button>';
          }
          var kind = entry.kind === 'evo' ? 'Evolution item' : 'Held item';
          return '<button type="button" class="reward-choice" data-reward-id="' +
            escapeHtml(entry.id) + '"><span class="reward-choice-art">' +
            (window.ItemArt ? window.ItemArt.itemImg(entry.id, 42) : '') +
            '</span><span class="reward-choice-copy"><b>' + escapeHtml(entry.name) +
            '</b><small>' + escapeHtml(kind) + '</small><em>' + escapeHtml(entry.desc || '') +
            '</em></span></button>';
        }).join('') + '</div><p class="hint reward-pick-note">Select one reward to continue.</p></div>';
    }
    if (!money && (!dead || !dead.length) && !missedCatch && !healed && !itemReward && !itemChoices.length) {
      html += '<p class="hint">You live to fight on.</p>';
    }
    html += '<p class="hint">Battles won: <b>' + run.battlesWon + '</b> \u00b7 Party: <b>' + run.party.length + '</b></p>';
    $('rewardBody').innerHTML = html;
    var continueBtn = $('btnRewardDone');
    continueBtn.disabled = itemChoices.length > 0;
    continueBtn.onclick = afterBattleAdvance;
    $('rewardBody').querySelectorAll('[data-reward-id]').forEach(function (button) {
      button.addEventListener('click', function () {
        if (button.disabled) return;
        // A choice is already resolving (picker sheet open or the evolution
        // animation playing): no second card -- including the cash bundle --
        // may be claimed on top of it.
        if (rewardChoicePending || rewardEvoPending) return;
        var pickedId = button.dataset.rewardId;
        // The 4th card is a cash-only sentinel: the sentinel is not in
        // itemChoices, so it does not go through N.addItem, and its picked
        // value is the run.money figure computed up front.
        var isSkip = pickedId === skipId;
        var picked = null;
        for (var ri = 0; ri < itemChoices.length; ri++) {
          if (itemChoices[ri].id === pickedId) { picked = itemChoices[ri]; break; }
        }
        if (!isSkip && !picked) return;
        if (isSkip) {
          // Cash is an instant, final choice: lock every card so an item can
          // never be claimed on top of the cash.
          run.money = (Number(run.money) || 0) + skipCash;
          if (run.sectionStats) {
            run.sectionStats.money = (Number(run.sectionStats.money) || 0) + skipCash;
          }
          N.logMsg(run, 'You took the cash (+$' + skipCash.toLocaleString() + ').');
          var note2 = $('rewardBody').querySelector('.reward-pick-note');
          if (note2) note2.textContent = '+$' + skipCash.toLocaleString() + ' added to your money.';
          commitRewardChoice(skipId);
        } else {
          N.addItem(run, picked.id, 1);
          N.logMsg(run, 'You chose ' + picked.name + ' as your battle reward.');
          var note = $('rewardBody').querySelector('.reward-pick-note');
          if (note) note.textContent = picked.name + ' \u2014 use it now.';
          // The card is NOT locked yet: cancelling the use/give sheet returns
          // the item and re-enables every card, so a different reward can
          // still be picked. The sheet opening is the pending state that
          // blocks a second choice; commitRewardChoice() locks once the item
          // is actually used or given.
          openRewardItemPicker(picked);
        }
        continueBtn.disabled = isSkip ? false : true;
        saveGame();
      });
    });
    renderHud();
  }

  function afterBattleAdvance() {
    if (!N.alive(run).length) return gameOver();
    var finishedSection = run.section;
    var newSection = N.advanceBattle(run);
    martStock = null;             // fresh stock each stop
    run._shopSeq = (run._shopSeq || 0) + 1;
    // Nuzlocke resets the ten-ball bonus with the new route stop.
    // The Gauntlet keeps its momentum: win -> heal -> next trainer. No share
    // marks, no section summary, no shop -- the route screen IS the breather.
    if (N.isGauntlet(run)) {
      saveGame();
      renderCrossroads(); show('Crossroads');
      return;
    }
    if (newSection) {
      // Evolution items come from battle rewards. Ensure the guided run has
      // the Rare Candy it needs when it reaches section 2, even if the player
      // picked a different reward in section 1 or is loading an older tutorial
      // save. This is a tutorial safety net, never shop stock.
      if (run.prologue && finishedSection === 1 && !run.bag.rarecandy) {
        N.addItem(run, 'rarecandy', 1);
        N.logMsg(run, 'Section 1 tutorial reward: you received a Rare Candy.');
      }
      recordSectionMark(finishedSection);
      // A finite run ENDS here rather than rolling into another section.
      if (run.maxSections && finishedSection >= run.maxSections) {
        run.section = finishedSection;     // don't display a section they never played
        return finishDaily('complete');
      }
    }
    saveGame();
    if (newSection) {
      showSectionSummary(finishedSection);
      return;
    }
    renderCrossroads(); show('Crossroads');
  }

  // One emoji square per section for the share card. Recorded as the section
  // closes, while sectionStats still describes it.
  function recordSectionMark(section, ended) {
    if (!run.sectionMarks) run.sectionMarks = [];
    var ss = run.sectionStats || {};
    var hurt = run.party.some(function (m) { return m.hpPct < 0.6; });
    run.sectionMarks[section - 1] = window.Daily.markFor({
      lost: (ss.lost || []).length,
      hurt: hurt,
      ended: !!ended
    });
  }

  // ---- END OF SECTION -----------------------------------------------------
  function showSectionSummary(finished) {
    var ss = run.sectionStats || { money: 0, won: 0, lost: [], startedAt: finished };
    // Never let a bad accumulator surface as "$NaN" (old saves, future bugs).
    var num = function (v) { v = Number(v); return isFinite(v) ? v : 0; };
    ss.money = num(ss.money);
    ss.won = num(ss.won);
    if (!Array.isArray(ss.lost)) ss.lost = [];
    var caughtName = run.lastCaughtName;

    $('sumTitle').textContent = 'Section ' + finished + ' complete';
    $('sumSub').textContent = run.catchMissed
      ? 'You pressed on empty-handed.'
      : (caughtName ? caughtName + ' joined the team.' : 'The route is behind you.');

    $('sumStats').innerHTML =
      '<div class="sum-stat"><span class="v gold">$' + ss.money.toLocaleString() + '</span><span class="k">Earned</span></div>' +
      '<div class="sum-stat"><span class="v">' + ss.won + '</span><span class="k">Battles</span></div>' +
      '<div class="sum-stat"><span class="v' + (run.catchMissed ? ' bad' : '') + '">' +
        (run.catchMissed ? 'Missed' : (caughtName ? '1' : '0')) + '</span><span class="k">Caught</span></div>' +
      '<div class="sum-stat"><span class="v' + (ss.lost.length ? ' bad' : '') + '">' + ss.lost.length + '</span><span class="k">Lost</span></div>';

    // roll of honour: who did the work this section
    var roster = run.party.slice().sort(function (a, b) {
      return (run.damageDealt[b.uid] || 0) - (run.damageDealt[a.uid] || 0);
    });
    $('sumTeam').innerHTML = '<div class="sum-label">Your team</div>' +
      roster.map(function (m) {
        var pct = pctHP(m.hpPct);
        var col = m.hpPct > 0.5 ? '#4ade80' : m.hpPct > 0.2 ? '#facc15' : '#ef4444';
        return '<div class="sum-row">' + iconEl(m.id, 1.1, '', m.shiny) +
          '<div class="sum-who"><b>' + escapeHtml(m.name) + '</b><span>' + speciesOf(m) + '</span></div>' +
          '<div class="sum-hp"><i style="width:' + pct + '%;background:' + col + '"></i></div>' +
          '<span class="sum-pct">' + pct + '%</span></div>';
      }).join('');

    if (ss.lost.length) {
      $('sumLost').innerHTML = '<div class="sum-label bad">Lost forever</div>' +
        '<div class="sum-graves">' + ss.lost.map(function (g) {
          return '<div class="grave">' + iconEl(g.id, 1.1, '', g.shiny) + '<span>' + escapeHtml(g.name) + '</span></div>';
        }).join('') + '</div>';
      $('sumLost').hidden = false;
    } else {
      $('sumLost').hidden = true;
    }

    $('btnSumNext').textContent = 'Enter Section ' + run.section;
    show('Summary');

    // The guided run does NOT end at the section boundary: the shop series
    // and the evolution lesson in section 2 are still ahead of the player.
    // The prologue flags are cleared only by concludeTutorial() -- after the
    // evolution lesson has actually been taught -- or by skipping tips.
    //
    // SAVE SAFETY, taught at the one moment it is felt rather than as a
    // settings-menu line item: the player has just finished a section with a
    // team they now care about. Losing browser data would take it. The
    // "Save progress" button is right there on this screen, so the lesson
    // points at the real thing and the next tap does it for real.
    var COs = window.Coach;
    if (COs && COs.tipsOn() && run && run.prologue && !COs.seen('save')) {
      setTimeout(function () {
        if ($('screenSummary').hidden) return;
        COs.lesson('save', {
          anchor: $('btnSumSave'),
          vital: !!(run && run.prologue),
          stillValid: function () { return !$('screenSummary').hidden; }
        });
      }, 800);
    }
  }

  // ------------------------------------------------------------ GAME OVER --
  function gameOver() {
    if (run.over) return;          // never double-record a run
    // A Daily that wipes is still a completed attempt: it gets scored and
    // recorded, just with a 'wipe' outcome that doesn't extend the streak.
    if (run.mode === 'daily' && run.dailyDate) return finishDaily('wipe');
    run.over = true;
    recordRunEnd();
    var m = N.mvp(run);
    show('GameOver');
    $('goScore').innerHTML =
      '<div class="score-big">' + run.battlesWon + '</div><div class="score-lbl">' +
        (N.isGauntlet(run) ? 'trainers beaten' : 'battles won') + '</div>' +
      (N.isGauntlet(run)
        ? '<p>Reached <b>Trainer ' + run.section + '</b> \u00b7 Team wiped after <b>' + run.trainersBeaten + '</b> wins</p>'
        : '<p>Reached <b>Section ' + run.section + '</b> \u00b7 Trainers beaten <b>' + run.trainersBeaten + '</b> \u00b7 Caught <b>' + run.caught + '</b></p>');
    $('goMvp').innerHTML = m
      ? '<div class="mvp"><div class="mvp-tag">MVP</div>' +
        bigSprite(m.id, '', 104, 104, 1, m.shiny) +
        '<div><div class="sc-name">' + escapeHtml(m.name) + '</div>' +
        '<div class="statline">' + m.damage.toLocaleString() + ' total damage \u00b7 ' + m.kos + ' KOs</div>' +
        '<div class="hint">' + (m.survived ? 'Survived to the end.' : 'Fell in battle.') + '</div></div></div>'
      : '<p class="hint">No damage was dealt. Rough run.</p>';
    var ros = N.roster(run).sort(function (a, b) { return b.damage - a.damage; });
    $('goRoster').innerHTML = '<h3 class="sub-title">Roster</h3>' + ros.map(function (r) {
      return '<div class="ros-row' + (r.alive ? '' : ' dead') + '">' +
        iconEl(r.id, 1, '', r.shiny) +
        '<span class="ros-n">' + escapeHtml(r.name) + '</span>' +
        '<span class="ros-d">' + r.damage.toLocaleString() + ' dmg</span>' +
        '<span class="ros-s">' + (r.alive ? pctHP(r.hpPct) + '%' : 'S' + r.section) + '</span></div>';
    }).join('');
    clearSave();
  }

  // ============================== DAILY RESULT ==============================
  // The Daily is finite, so it has a real ending: score it, write it to the
  // dated history (which drives the streak and calendar), and show a share
  // card. `outcome` is 'complete' (cleared every section) or 'wipe'.
  // Only a CLEARED Daily with at least one survivor may continue in Free Play.
  // A wipe must never leave a dead snapshot behind for the result CTA.
  var lastDailyRun = null;

  function finishDaily(outcome) {
    if (run.over) return;
    run.over = true;
    var D = window.Daily;
    var m = N.mvp(run);

    // The section that ended the run gets a black square rather than nothing.
    if (outcome === 'wipe') recordSectionMark(run.section, true);

    // Score: battles are the spine, with credit for the things that are hard.
    var score = (run.battlesWon || 0) * 100 +
                (run.trainersBeaten || 0) * 150 +
                (run.caught || 0) * 75 +
                (outcome === 'complete' ? 1000 : 0) -
                (run.graveyard || []).length * 50;

    var entry = D.record(run.dailyDate, {
      outcome: outcome,
      sections: outcome === 'complete' ? (run.maxSections || run.section) : run.section,
      battles: run.battlesWon || 0,
      caught: run.caught || 0,
      lost: (run.graveyard || []).length,
      trainers: run.trainersBeaten || 0,
      score: Math.max(0, score),
      starter: run.starterMeta || null,
      mvp: m ? { id: m.id, name: m.name, damage: m.damage } : null,
      marks: (run.sectionMarks || []).filter(Boolean),
      roster: (run.party || []).concat(run.graveyard || []).map(function (p) {
        return { id: p.id, name: p.name, shiny: !!p.shiny };
      })
    });

    // The all-time profile still records it, exactly like a Free Play run.
    recordRunEnd();
    // A cleared team can carry on; a wiped team has nobody left and must end
    // here. N.alive() is intentional: party.length can still include a
    // zero-HP Pokemon on some simultaneous-KO battle endings.
    lastDailyRun = outcome === 'complete' && N.alive(run).length
      ? ST.snapshot(run) : null;
    // Store party for the daily summary button on title screen
    window._lastDailyParty = run.party ? run.party.slice() : [];
    clearSave('daily');
    showDailyResult(entry, { fresh: true });
  }

  function showDailyResult(entry, opts) {
    opts = opts || {};
    if (!entry) { toast('No Daily result yet.'); return; }
    var D = window.Daily;
    var st = D.streakInfo();
    var complete = entry.outcome === 'complete';

    $('drTitle').textContent = complete ? 'Daily complete!' : 'Daily ended';
    $('drTitle').className = 'scr-title' + (complete ? '' : ' dead');
    $('drSub').textContent = 'Dailylocke #' + entry.n + ' \u00b7 ' + entry.date;

    $('drStats').innerHTML =
      '<div class="sum-stat"><span class="v' + (complete ? ' gold' : '') + '">' +
        entry.sections + (complete ? '/' + D.SECTIONS : '') + '</span><span class="k">Sections</span></div>' +
      '<div class="sum-stat"><span class="v">' + entry.battles + '</span><span class="k">Battles</span></div>' +
      '<div class="sum-stat"><span class="v">' + entry.caught + '</span><span class="k">Caught</span></div>' +
      '<div class="sum-stat"><span class="v' + (entry.lost ? ' bad' : '') + '">' + entry.lost +
        '</span><span class="k">Lost</span></div>';

    $('drScore').innerHTML =
      '<div class="score-big">' + entry.score.toLocaleString() + '</div>' +
      '<div class="score-lbl">score</div>' +
      (st.streak > 0
        ? '<p class="dr-streak"><b>' + st.streak + '</b> day streak' +
          (st.best > st.streak ? ' \u00b7 best <b>' + st.best + '</b>' : '') + '</p>'
        : '<p class="hint">Clear a Daily to start a streak.</p>');

    $('drMvp').innerHTML = entry.mvp
      ? '<div class="mvp"><div class="mvp-tag">MVP</div>' +
        bigSprite(entry.mvp.id, '', 96, 96, 1, false) +
        '<div><div class="sc-name">' + escapeHtml(entry.mvp.name) + '</div>' +
        '<div class="statline">' + (entry.mvp.damage || 0).toLocaleString() + ' total damage</div></div></div>'
      : '';

    $('drMarks').textContent = (entry.marks || []).join('');

    // The share text is exactly what gets copied -- shown verbatim so there is
    // never a surprise about what lands in someone's clipboard.
    var share = D.shareText(entry, { url: shareBaseUrl() });
    $('drShareText').value = share;

    // Never offer Free Play after a wipe. Check living Pokemon rather than the
    // raw array length because a simultaneous KO can briefly leave a dead mon
    // in party even though the run has ended.
    var cont = $('btnDrContinue');
    var hasSurvivor = lastDailyRun && N.alive(lastDailyRun).length > 0;
    if (cont) cont.hidden = !(opts.fresh && complete && hasSurvivor);

    show('DailyResult');
  }

  function shareBaseUrl() {
    try {
      var u = new URL(window.location.href);
      u.search = ''; u.hash = '';
      return u.href;
    } catch (e) { return ''; }
  }

  // "Keep going" -> the finished Daily team becomes an endless Free Play run.
  function continueDailyInFreePlay() {
    if (!lastDailyRun || !N.alive(lastDailyRun).length) {
      lastDailyRun = null;
      toast('No surviving team to continue with.');
      return;
    }
    var existing = loadGame('free');
    if (existing && !confirm('Your Free Play slot already has a run at Section ' +
        (existing.section || 1) + '. Replace it with this Daily team?')) return;
    var carried = lastDailyRun;
    carried.mode = 'free';
    carried.archivedFrom = carried.dailyDate;
    carried.dailyDate = null;
    carried.maxSections = 0;        // endless from here
    carried.over = false;
    // The Daily ended at the LAST section it played; Free Play resumes at the
    // next one with a clean section counter.
    carried.section = (carried.section || 1) + 1;
    carried.battleInSection = 0;
    carried.sectionStats = { money: 0, won: 0, caught: null, lost: [], damage: 0,
                             kos: 0, startedAt: carried.section };
    carried.catchUsedThisSection = false;
    carried.catchMissed = false;
    carried.lastCaughtName = null;
    ST.putRun('free', carried);
    lastDailyRun = null;
    run = reviveRun(carried);
    N.healAll(run);
    toast('Your Daily team continues in Free Play.');
    renderCrossroads(); show('Crossroads');
  }

  // ------------------------------------------------------- EVOLUTION ------
  function evoOptionByKey(mon, key) {
    var opts = window.Evo.optionsFor(mon);
    for (var i = 0; i < opts.length; i++) if (opts[i].id === key) return opts[i];
    return null;
  }

  // Forme options for the gauntlet: all available formes without needing items.
  function gbFormeRowHtml(mon) {
    if (!window.Forme) return '';
    var FM = window.Forme;
    var formeTargets = [];
    // Check custom items
    Object.keys(FM.CUSTOM).forEach(function (cid) {
      FM.targetsFor(mon, cid).forEach(function (t) { formeTargets.push({ item: cid, target: t }); });
    });
    // Check Showdown forme items
    var idx = FM.index();
    var baseId = PS.toID(Dex.species.get(mon.id).baseSpecies || mon.id);
    (idx.byBase[baseId] || []).forEach(function (e) {
      FM.targetsFor(mon, e.item).forEach(function (t) { formeTargets.push({ item: e.item, target: t }); });
    });
    // Custom key-item formes are free; real held-item formes require the item.
    formeTargets = formeTargets.filter(function (ft) { return (window.Forme.CUSTOM && window.Forme.CUSTOM[ft.item]) || mon.item === ft.item; });
    if (!formeTargets.length) return '';
    var rows = formeTargets.map(function (ft) {
      return '<button class="evo-btn forme-btn ready" data-gb-run-forme-item="' + ft.item + '" data-gb-run-forme="' + ft.target.id + '">' +
        evoPreviewHtml(mon.id, ft.target.id, { reveal: true }) +
        '<span class="evo-txt"><span class="evo-n">' + ft.target.name + '</span>' +
        '<span class="evo-r">Switch forme (free)</span></span></button>';
    }).join('');
    return '<div class="evo-box forme-box"><div class="evo-title">Forme change</div>' + rows + '</div>';
  }

    // Gauntlet run: held item picker showing every legal held item
  function openGbRunHeldPicker(mon) {
    var overlay = $('xTeamDetail'), host = overlay && overlay.querySelector('.overlay-card');
    if (!host) return;
    var items = (C.allHeldItems ? C.allHeldItems() : C.HELD_ITEMS).filter(function (id) {
      return !(window.Forme && window.Forme.CUSTOM && window.Forme.CUSTOM[id]);
    });
    function render() {
      var q = (host.querySelector('.gb-item-search').value || '').toLowerCase().trim();
      var shown = items.filter(function (id) { return itemName(id).toLowerCase().indexOf(q) >= 0; });
      host.querySelector('.gb-item-results').innerHTML = shown.map(function (id) {
        return '<button class="btn-mini' + (mon.item === id ? ' on' : '') + '" data-gb-run-give="' + id + '" data-tip="item:' + id + '">' +
          (window.ItemArt ? window.ItemArt.itemImg(id, 20) : '') + escapeHtml(itemName(id)) + '</button>';
      }).join('') || '<div class="tb-empty">No held items match.</div>';
      host.querySelectorAll('[data-gb-run-give]').forEach(function (b) { b.addEventListener('click', async function () {
        var id = b.dataset.gbRunGive;
        await (window.Forme && window.Forme.setHeldItemAndEnforce ? window.Forme.setHeldItemAndEnforce(run, mon, id) : (mon.item = id));
        toast(mon.name + ' is now holding ' + itemName(id) + '.'); saveGame(); drawPartyDetail();
      }); });
    }
    host.innerHTML = '<button class="btn-secondary wide pd-gb-back">← Back to ' + escapeHtml(mon.name) + '</button>' +
      '<div class="pd-label" style="margin:12px 0 8px">Search held items</div>' +
      '<input class="tb-search gb-item-search" type="search" placeholder="Type to filter items…" autocomplete="off">' +
      '<div class="gb-item-results" style="display:flex;flex-wrap:wrap;gap:6px"></div>' +
      (mon.item ? '<button class="btn-secondary wide" style="margin-top:12px" data-gb-clear="1">Remove held item</button>' : '');
    host.querySelector('.pd-gb-back').addEventListener('click', drawPartyDetail);
    host.querySelector('.gb-item-search').addEventListener('input', render);
    var clear = host.querySelector('[data-gb-clear]');
    if (clear) clear.addEventListener('click', async function () {
      await window.Forme.setHeldItemAndEnforce(run, mon, ''); toast('Removed held item.'); saveGame(); drawPartyDetail();
    });
    render();
  }

  // Gauntlet run: apply forme change without consuming items
  async function gbRunFormeChange(mon, itemId, formeId) {
    if (!window.Forme || !(window.Forme.CUSTOM && window.Forme.CUSTOM[itemId]) && (!mon.item || mon.item !== itemId) ||
        !window.Forme.targetsFor(mon, itemId).some(function (t) { return t.id === formeId; })) {
      toast('This forme cannot be used by this Pokemon.');
      return;
    }
    var sp = Dex.species.get(formeId);
    if (!sp.exists) return;
    // Use the existing Forme.applyForme but without consuming an item
    // We need a temporary run-like bag object so the function doesn't fail
    var res = await window.Forme.applyForme(run, mon, formeId);
    if (res.ok) {
      toast(mon.name + ' became ' + res.to + '!');
      try { playCry(mon.id); } catch (e) {}
      if (mon.shiny) recordShiny(mon, 'forme');
    } else {
      toast(res.msg || 'Nothing happened.');
    }
    saveGame();
    drawPartyDetail();
  }

  // Forme options this Pokemon could switch to, given what is in the bag.
  function formeRowHtml(mon) {
    if (!window.Forme) return '';
    var owned = Object.keys(run.bag).filter(function (id) {
      return window.Forme.isFormeItem(id) && window.Forme.targetsFor(mon, id).length;
    });
    if (!owned.length) return '';
    var rows = owned.map(function (id) {
      return window.Forme.targetsFor(mon, id).map(function (t) {
        return '<button class="evo-btn forme-btn ready" data-item="' + id + '" data-forme="' + t.id + '">' +
          evoPreviewHtml(mon.id, t.id, { reveal: true }) +
          '<span class="evo-txt">' +
            '<span class="evo-n">' + t.name + '</span>' +
            '<span class="evo-r">Use ' + itemName(id) + '</span>' +
          '</span>' +
          '</button>';
      }).join('');
    }).join('');
    return '<div class="evo-box forme-box"><div class="evo-title">Forme change</div>' + rows + '</div>';
  }

  // Evolution can be launched from either of the two crossroads dialogs. A
  // dialog makes every background screen inert; leaving it open while showing
  // screenEvolve therefore also makes the final Continue button inert. Always
  // dismiss the originating sheet before moving to the full-screen sequence.
  function openEvolutionScreen() {
    if (window.Modal) {
      if (window.Modal.isOpen('screenPicker')) window.Modal.close('screenPicker');
      if (window.Modal.isOpen('xTeamDetail')) window.Modal.close('xTeamDetail');
    }
    partySel = -1;
    // Remember whether this morph belongs to a reward choice so its Done
    // button returns to the reward screen rather than the crossroads.
    rewardEvoOnScreen = !!rewardEvoPending;
    show('Evolve');
  }

  function startFormeChange(mon, itemId, formeId) {
    var fromId = mon.id;
    openEvolutionScreen();
    var stage = $('evoStage');
    stage.className = 'evo-stage';
    stage.innerHTML =
      '<div class="evo-glow"></div>' +
      bigSprite(fromId, 'evo-sprite from', 0, 0, 1, mon.shiny) +
      bigSprite(formeId, 'evo-sprite to', 0, 0, 1, mon.shiny) +
      '<div class="evo-rays"></div>';
    $('evoText').textContent = mon.name + ' is changing forme!';
    var doneBtn = $('btnEvoDone');
    doneBtn.hidden = true; doneBtn.style.display = 'none';

    setTimeout(function () { stage.classList.add('morphing'); }, 600);
    setTimeout(function () { $('evoText').textContent = '...'; }, 1200);
    setTimeout(async function () {
      // Forme items are held items, not one-shot evolution consumables. Equip
      // the item as part of the change so Arceus, Dialga, Genesect, etc. can
      // never remain in their default forme while holding a forme-forcing item.
      var oldItem = mon.item;
      if (oldItem && oldItem !== itemId) N.addItem(run, oldItem, 1);
      mon.item = itemId;
      var res = await window.Forme.applyForme(run, mon, formeId);
      var formeNote;
      if (res.ok) {
        run.bag[itemId]--; if (run.bag[itemId] <= 0) delete run.bag[itemId];
        stage.classList.remove('morphing');
        stage.classList.add('done');
        $('evoText').innerHTML = escapeHtml(mon.name) + ' became <b>' + res.to + '</b>!';
        N.logMsg(run, res.from + ' changed forme to ' + res.to + '.');
        formeNote = mon.name + ' changed forme to ' + res.to + '!';
        if (mon.shiny) {
          recordShiny(mon, 'forme');
          toast('\u2728 Shiny ' + mon.name + ' (' + res.to + ') added to collection!');
        }
        try { playCry(mon.id); } catch (e) {}
      } else {
        stage.classList.remove('morphing');
        $('evoText').textContent = res.msg || 'Nothing happened.';
        formeNote = res.msg || 'Nothing happened.';
      }
      doneBtn.hidden = false; doneBtn.style.display = '';
      if (rewardEvoPending) finalizeRewardEvolution(formeNote);
      renderHud(); saveGame();
    }, 3000);
  }

  // A "current -> ???" evolution preview. The target is rendered as a black
  // silhouette so the species stays a surprise until it actually evolves,
  // exactly like the classic "Who's That Pokemon?" reveal. Used by BOTH the
  // party-detail evolution button and the Bag item picker so they match.
  function evoPreviewHtml(fromId, toId, opts) {
    opts = opts || {};
    // Just the target. Showing the current Pokemon plus an arrow was noise --
    // you already know what you are holding the item over.
    return '<span class="evop">' +
      '<span class="evop-to' + (opts.reveal ? ' shown' : '') + '">' +
        animSprite(toId, 48, 54, '', 1.45) +
      '</span>' +
    '</span>';
  }

  function evoRowHtml(mon, idx) {
    if (!window.Evo) return '';
    var opts = window.Evo.optionsFor(mon);
    if (!opts.length) return '';
    var rows = opts.map(function (o) {
      var have = window.Evo.canEvolve(run, mon, o);
      var need = o.requirement.label + (o.requirement.extraItem
        ? ' + ' + window.Evo.itemName(o.requirement.extraItem) : '');
      // The silhouette keeps the evolution a surprise; the requirement line
      // still tells you exactly what it costs.
      return '<button class="evo-btn' + (have ? ' ready' : '') + '" data-i="' + idx + '" data-evo="' + o.id + '"' +
        (have ? '' : ' disabled') + '>' +
        evoPreviewHtml(mon.id, o.id) +
        '<span class="evo-txt">' +
          '<span class="evo-n">' + (have ? 'Ready to evolve' : 'Evolution') + '</span>' +
          '<span class="evo-r">' + (have ? 'Use ' + need : 'Needs ' + need) + '</span>' +
        '</span>' +
        '</button>';
    }).join('');
    // A branching evolution is a one-way, irreversible choice that a casual
    // player does not know they are making. Name it, even though the targets
    // themselves stay a surprise.
    var branchNote = opts.length > 1
      ? '<div class="evo-branch-note">This one can become <b>' + opts.length +
        ' different Pokemon</b> \u2014 you only get to pick once.</div>'
      : '';
    return '<div class="evo-box"><div class="evo-title">Evolution</div>' +
      branchNote + rows + '</div>';
  }

  // Animated evolution: the classic white-out morph with a pulsing silhouette.
  function startEvolution(mon, opt) {
    var fromId = mon.id, fromName = mon.name;
    openEvolutionScreen();
    var stage = $('evoStage');
    stage.className = 'evo-stage';
    stage.innerHTML =
      '<div class="evo-glow"></div>' +
      bigSprite(fromId, 'evo-sprite from', 0, 0, 1, mon.shiny) +
      bigSprite(opt.id, 'evo-sprite to', 0, 0, 1, mon.shiny) +
      '<div class="evo-rays"></div>';
    $('evoText').textContent = 'What? ' + fromName + ' is evolving!';
    var doneBtn = $('btnEvoDone');
    doneBtn.hidden = true; doneBtn.style.display = 'none';

    // phase 1: shudder, phase 2: morph flashes, phase 3: reveal
    setTimeout(function () { stage.classList.add('morphing'); }, 700);
    setTimeout(function () { $('evoText').textContent = '...'; }, 1400);

    setTimeout(async function () {
      var res = await window.Evo.evolve(run, mon, opt);
      stage.classList.remove('morphing');
      stage.classList.add('done');
      var rewardNote;
      if (res.ok) {
        // The guided run's evolution step is satisfied the moment the
        // starter actually evolves (party sheet OR bag path).
        if (run && run.prologue && run.tutorialStarterUid &&
            String(mon.uid) === String(run.tutorialStarterUid)) {
          run.tutorialEvolved = true;
          saveGame();
        }
        $('evoText').innerHTML = res.renamed
          ? ('Congratulations! <b>' + res.to + '</b> evolved into a ' + res.species + '!')
          : ('Congratulations! Your ' + res.fromSpecies + ' evolved into <b>' + res.species + '</b>!');
        N.logMsg(run, res.to + ' evolved into ' + res.species + '!');
        rewardNote = res.to + ' evolved into ' + res.species + '!';
        if (mon.shiny) {
          recordShiny(mon, 'evolved');
          toast('\u2728 Shiny ' + mon.name + ' evolved into ' + res.species + '!');
        }
        try { playCry(opt.id); } catch (e) {}
      } else {
        $('evoText').textContent = res.msg || 'The evolution failed.';
        rewardNote = res.msg || 'The evolution failed.';
      }
      doneBtn.hidden = false; doneBtn.style.display = '';
      // A reward-picked evolution locks its card in only once the morph
      // resolves; a failed evolution leaves the unconsumed item to be used
      // from the Bag later, so the reward screen is finalised either way.
      if (rewardEvoPending) finalizeRewardEvolution(rewardNote);
      renderHud(); saveGame();
      if (res.ok && run && run.prologue && run.section === 2 && window.Coach && window.Coach.tipsOn()) {
        setTimeout(function () {
          if ($('screenEvolve').hidden || run.tutorialTrained) return;
          window.Coach.lesson('evoDone', {
            anchor: doneBtn, actionRequired: true, keepHalo: true,
            bypassSeen: true, vital: true,
            stillValid: function () { return !$('screenEvolve').hidden && run && run.prologue && run.section === 2; },
            onShow: function () { if (!window.Coach.seen('evoDone')) window.Coach.markSeen('evoDone'); }
          });
        }, 120);
      }
    }, 3200);
  }

  function playCry(speciesId) {
    var sp = Dex.species.get(speciesId);
    var sid = String((sp.exists && sp.spriteid) || speciesId).toLowerCase().replace(/[^a-z0-9-]+/g, '');
    var url = 'https://play.pokemonshowdown.com/audio/cries/' + sid + '.mp3';
    if (window.GameAudio) return window.GameAudio.playSfx(url, 0.7);
    var a = new Audio(url);
    a.volume = 0.5;
    a.play().catch(function () {});
  }

  // ---------------------------------------------------------------- SAVE ---
  // ---- SAVES -------------------------------------------------------------
  // SAVE_VERSION must be bumped whenever the run schema changes. Without it a
  // save written by an older build is restored into newer code and silently
  // carries missing/renamed fields -- which looks exactly like features having
  // "reverted" (blank species captions, a fainted Pokemon still in the party,
  // no section stats). Old saves are migrated where possible, dropped if not.
  // ---------------------------------------------------------- SAVE SLOTS ---
  // Persistence, migrations and the slot layout live in src/storage.js.
  // Daily and Free Play have their OWN slots: they used to share one, so a
  // good Free Play run blocked today's Daily and vice versa.
  var ST = window.Storage;

  // ---------------------------------------------------------- PROFILE ------
  // Everything that OUTLIVES a run: the shiny collection and the run history.
  // Deliberately a separate key from the run save, so abandoning a run (or a
  // save-format bump) can never wipe a collection built up over months.
  var profile = null;

  // loadProfile() REPLACES the profile object, so anything holding a
  // reference to the old one is instantly stale. The coach keeps lesson state
  // on the profile, so it has to be re-pointed on every load or a tip marked
  // as seen would be forgotten the next time any screen refreshed.
  function loadProfile() {
    profile = ST.loadProfile();
    if (window.Coach) window.Coach.attach(profile, saveProfile);
    return profile;
  }
  function saveProfile() { return ST.saveProfile(profile); }

  // Shiny ownership is a profile unlock. It is never rolled automatically in
  // the Gauntlet; the player explicitly opts a selected Pokemon in or out.
  function hasCollectedShiny(id) {
    loadProfile();
    return (profile.shinies || []).some(function (sh) { return sh.id === id; });
  }

  // A shiny is registered the moment it is OBTAINED (caught or chosen as a
  // starter) -- not when the run ends. Losing the run must not lose the shiny.
  function recordShiny(mon, how) {
    if (!mon || !mon.shiny) return false;
    loadProfile();
    profile.shinies.push({
      id: mon.id,
      species: mon.species || C.cleanName(mon.id),
      name: mon.name || C.cleanName(mon.id),
      types: (mon.types || []).slice(),
      how: how || 'caught',
      section: run ? run.section : 0,
      at: Date.now()
    });
    saveProfile();
    return true;
  }

  function recordRunEnd() {
    loadProfile();
    var m = N.mvp(run);
    profile.totalRuns++;
    profile.bestBattles = Math.max(profile.bestBattles, run.battlesWon || 0);
    profile.bestSection = Math.max(profile.bestSection, run.section || 0);
    profile.totalCaught += (run.caught || 0);
    profile.history.unshift({
      at: Date.now(), battles: run.battlesWon || 0, section: run.section || 0,
      caught: run.caught || 0, trainers: run.trainersBeaten || 0,
      mvp: m ? { id: m.id, name: m.name, damage: m.damage } : null,
      seed: run.seed,
      roster: (run.party || []).concat(run.graveyard || []).map(function (p) {
        return { id: p.id, name: p.name, shiny: !!p.shiny };
      })
    });
    // a long history is just noise; keep the most recent 50 runs
    if (profile.history.length > 50) profile.history.length = 50;
    saveProfile();
  }

  // Central serializer: snapshot the live run (minus the `rand` function
  // handle, which reviveRun() rebuilds deterministically) and persist it to
  // localStorage. Returns the snapshot so callers -- autosave AND the export
  // modal -- always work from exactly the same object.
  function saveGameState() { return ST.saveRun(run); }
  function saveGame() { saveGameState(); }

  // Read one slot. `mode` is 'daily' | 'free'; omitted means "the Free Play
  // slot", which is what every legacy caller meant.
  function loadGame(mode) { return ST.loadRun(mode, migrateSave); }

  // Today's Daily, but only if it IS today's. A Daily from a previous day is
  // stale: it can no longer be scored, so it is offered as an archive instead.
  function loadDailyToday() {
    var s = loadGame('daily');
    if (!s) return null;
    return s.dailyDate === window.Daily.dayKey() ? s : null;
  }
  function loadDailyStale() {
    var s = loadGame('daily');
    if (!s) return null;
    return s.dailyDate === window.Daily.dayKey() ? null : s;
  }

  // Bring any older save up to the current schema (src/storage.js owns the
  // actual migration steps; this supplies the game helpers they need).
  function migrateSave(d) {
    return ST.migrate(d, { cleanName: C.cleanName });
  }

  // Clear one slot (default: the slot the live run belongs to).
  function clearSave(mode) {
    ST.clearRun(mode === undefined ? (run && run.mode) : mode);
  }

  function reviveRun(s) {
    var r = N.newRun(s.seed);
    Object.keys(s).forEach(function (k) { if (k !== '__v' && k !== 'randState') r[k] = s[k]; });
    // Saves written before the two-section safety marker can still be midway
    // through a guided run. The starter uid is run-scoped proof that this run
    // opted into that tutorial; ordinary Free Play saves stay untouched.
    if (s.tutorialSafeThrough == null && r.mode === 'free' && r.tutorialStarterUid) {
      r.tutorialSafeThrough = 2;
    }
    // Restore exact RNG state if available, so catch shakes and any remaining
    // randomness stay stable across refreshes. Old saves fallback to the
    // previous best-effort formula.
    if (s.randState != null) {
      try {
        r.rand = C.mulberry32(s.seed ^ 0x9e3779b9);
        if (r.rand.setState) r.rand.setState(s.randState);
      } catch (e) {
        r.rand = C.mulberry32((s.seed ^ 0x9e3779b9) + (s.battlesWon || 0) * 7919);
      }
    } else {
      r.rand = C.mulberry32((s.seed ^ 0x9e3779b9) + (s.battlesWon || 0) * 7919);
    }
    // Belt and braces: normalise anything a migration could not infer.
    // Always re-resolve species/types from mon.id so a save written under the
    // old cleanName bug (regional variants collapsed to their base forme name)
    // still fights and draws as the correct forme after load.
    r.party.forEach(function (m) {
      var sp = m.id ? Dex.species.get(m.id) : null;
      if (sp && sp.exists) {
        m.species = sp.name;
        if (Array.isArray(sp.types) && sp.types.length) m.types = sp.types.slice();
      } else if (!m.species) {
        m.species = C.cleanName(m.id);
      }
      if (!m.name) m.name = m.species;
      if (!m.pp) m.pp = {};
      N.trackMon(r, m);
    });
    if (!r.sectionStats) N.resetSectionStats(r);
    if (window.Coach) window.Coach.setPrologue(!!r.prologue);
    // Ensure _nextWild is cleared so it will be recomputed deterministically
    // via pickWild (which is now hash-based, not rand-based) after refresh.
    if (r._nextWild) delete r._nextWild;

    // Enforce automatic forme changes from held items (Arceus plates, Dialga crystal, etc.)
    // This fixes old saves where a Pokemon may have the wrong forme for its held item.
    if (window.Forme) {
      (async function () {
        for (var i = 0; i < r.party.length; i++) {
          try { await window.Forme.enforceHeldForme(r, r.party[i]); } catch (e) {}
        }
      })();
    }
    return r;
  }

  // -------------------------------------------------- ENCRYPTED BACKUPS ----
  // Full-account backup files are plain JSON.
  // Competitive/server-verified scores would additionally require a server-side
  // authority; no browser-only game can keep a secret from its owner.
  var pendingImportFile = null;
  function fullBackupState() {
    if (run && !run.over) saveGame();
    return {
      format: window.SaveCode ? window.SaveCode.FORMAT : 'dailylocke-full-state', version: 1,
      savedAt: Date.now(),
      runs: { daily: loadGame('daily'), free: loadGame('free'), gauntlet: loadGame('gauntlet') },
      profile: ST.loadProfile(),
      daily: window.Daily ? window.Daily.load() : null
    };
  }
  function openSaveExport() {
    $('saveExportMsg').textContent = '';
    window.Modal.open('screenSaveExport');
  }
  function closeSaveExport() { window.Modal.close('screenSaveExport'); }
  function downloadCurrentSave() {
    var msg = $('saveExportMsg');
    var state = fullBackupState();
    var text = JSON.stringify(state);
    var d = new Date().toISOString().slice(0, 10);
    window.SaveCode.download('dailylocke-backup-' + d + '.json', text);
    msg.textContent = 'Backup downloaded.';
    toast('Backup downloaded.');
  }
  function openSaveImport() {
    pendingImportFile = null; $('saveFileIn').value = ''; $('saveImportMsg').textContent = '';
    $('saveFileName').hidden = true;
    window.Modal.open('screenSaveImport');
  }
  function closeSaveImport() { window.Modal.close('screenSaveImport'); pendingImportFile = null; }
  function onSaveFileChosen(ev) {
    pendingImportFile = ev.target.files && ev.target.files[0];
    $('saveFileName').hidden = !pendingImportFile;
    $('saveFileName').textContent = pendingImportFile ? 'Selected: ' + pendingImportFile.name : '';
  }
  // Every value in a backup is untrusted input: it can come from another
  // device, a hand edit, or a malicious file. Nothing is written to storage
  // until it has been schema-checked and coerced to safe shapes, and any
  // player-controlled string is escaped at render time (see escapeHtml).
  function sanitizeProfileBackup(p) {
    var d = ST.blankProfile();
    if (!p || typeof p !== 'object' || Array.isArray(p)) return d;
    ['totalRuns', 'bestBattles', 'bestSection', 'totalCaught', 'totalKOs'].forEach(function (k) {
      var n = Number(p[k]);
      if (isFinite(n) && n >= 0) d[k] = Math.floor(n);
    });
    if (Array.isArray(p.shinies)) {
      d.shinies = p.shinies.filter(function (sh) {
        return sh && typeof sh === 'object' && typeof sh.id === 'string' && sh.id;
      }).slice(0, 1000).map(function (sh) {
        return { id: sh.id, species: String(sh.species || sh.id),
                 name: String(sh.name || sh.species || sh.id),
                 types: Array.isArray(sh.types) ? sh.types.map(String) : [],
                 how: String(sh.how || 'caught'),
                 section: Math.max(0, Math.floor(Number(sh.section) || 0)),
                 at: isFinite(Number(sh.at)) ? Number(sh.at) : Date.now() };
      });
    }
    if (Array.isArray(p.history)) {
      d.history = p.history.filter(function (h) { return h && typeof h === 'object'; })
        .slice(0, 50)
        .map(function (h) {
          return { at: isFinite(Number(h.at)) ? Number(h.at) : Date.now(),
                   battles: Math.max(0, Math.floor(Number(h.battles) || 0)),
                   section: Math.max(0, Math.floor(Number(h.section) || 0)),
                   caught: Math.max(0, Math.floor(Number(h.caught) || 0)),
                   trainers: Math.max(0, Math.floor(Number(h.trainers) || 0)),
                   mvp: h.mvp && typeof h.mvp === 'object'
                     ? { id: String(h.mvp.id || ''), name: String(h.mvp.name || ''),
                         damage: Math.max(0, Math.floor(Number(h.mvp.damage) || 0)) }
                     : null,
                   seed: isFinite(Number(h.seed)) ? Number(h.seed) : 0,
                   roster: Array.isArray(h.roster) ? h.roster.filter(function (p2) {
                     return p2 && typeof p2.id === 'string';
                   }).slice(0, 20).map(function (p2) {
                     return { id: p2.id, name: String(p2.name || p2.id), shiny: !!p2.shiny };
                   }) : [] };
        });
    }
    // Avatar and theme come from fixed catalogues, never free-form strings.
    if (AVATARS.indexOf(String(p.avatar)) >= 0) d.avatar = String(p.avatar);
    if (THEMES.some(function (t) { return t.id === p.theme; })) d.theme = p.theme;

    // Trainer name is free-form player input, so it is length-capped here and
    // HTML-escaped at every render site (see escapeHtml).
    if (typeof p.name === 'string') d.name = p.name.trim().slice(0, 12);

    // Coach state: only known keys, only the right types. `seen` and `modes`
    // are id maps, so their KEYS are the untrusted part -- restrict them to
    // the ids this build actually knows about rather than copying a
    // hand-edited file's arbitrary keys into storage.
    var c = ST.blankCoach();
    if (p.coach && typeof p.coach === 'object' && !Array.isArray(p.coach)) {
      var pc = p.coach;
      c.off = !!pc.off;
      c.badges = pc.badges !== false;
      c.onboarded = !!pc.onboarded;
      c.prologue = !!pc.prologue;
      if (pc.seen && typeof pc.seen === 'object' && window.Coach) {
        window.Coach.LESSONS.forEach(function (l) { if (pc.seen[l.id]) c.seen[l.id] = 1; });
      }
      if (pc.modes && typeof pc.modes === 'object') {
        ['daily', 'free', 'gauntlet'].forEach(function (m) { if (pc.modes[m]) c.modes[m] = 1; });
      }
    }
    d.coach = c;
    return d;
  }

  function sanitizeDailyBackup(s) {
    var out = { __v: 1, results: {}, streak: 0, best: 0, lastPlayed: null, grace: 0, lastStreakDay: null };
    if (!s || typeof s !== 'object' || !s.results || typeof s.results !== 'object') return out;
    Object.keys(s.results).forEach(function (k) {
      var e = s.results[k];
      if (!e || typeof e !== 'object' || !/^\d{4}-\d{2}-\d{2}$/.test(String(k))) return;
      out.results[k] = {
        date: String(k),
        n: Math.max(1, Math.floor(Number(e.n) || 1)),
        outcome: e.outcome === 'complete' ? 'complete' : 'wipe',
        sections: Math.max(0, Math.floor(Number(e.sections) || 0)),
        battles: Math.max(0, Math.floor(Number(e.battles) || 0)),
        caught: Math.max(0, Math.floor(Number(e.caught) || 0)),
        lost: Math.max(0, Math.floor(Number(e.lost) || 0)),
        trainers: Math.max(0, Math.floor(Number(e.trainers) || 0)),
        score: Math.max(0, Math.floor(Number(e.score) || 0)),
        starter: e.starter && typeof e.starter === 'object'
          ? { id: String(e.starter.id || ''), name: String(e.starter.name || '') } : null,
        mvp: e.mvp && typeof e.mvp === 'object'
          ? { id: String(e.mvp.id || ''), name: String(e.mvp.name || ''),
              damage: Math.max(0, Math.floor(Number(e.mvp.damage) || 0)) } : null,
        marks: Array.isArray(e.marks) ? e.marks.map(String).slice(0, 40) : [],
        at: isFinite(Number(e.at)) ? Number(e.at) : Date.now()
      };
    });
    if (isFinite(Number(s.streak))) out.streak = Math.max(0, Math.floor(Number(s.streak)));
    if (isFinite(Number(s.best))) out.best = Math.max(0, Math.floor(Number(s.best)));
    if (isFinite(Number(s.grace))) out.grace = Math.max(0, Math.floor(Number(s.grace)));
    if (typeof s.lastPlayed === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.lastPlayed)) out.lastPlayed = s.lastPlayed;
    if (typeof s.lastStreakDay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.lastStreakDay)) out.lastStreakDay = s.lastStreakDay;
    return out;
  }

  // Normalise every party member's species/types from its durable id -- the
  // same repair reviveRun() performs -- so an imported backup written under
  // the old cleanName bug (regional variants collapsed to their base forme
  // name) is corrected before it ever reaches storage, not on the next load.
  function repairRunSpecies(r) {
    (r.party || []).forEach(function (m) {
      var sp = m.id ? Dex.species.get(m.id) : null;
      if (sp && sp.exists) {
        m.species = sp.name;
        if (Array.isArray(sp.types) && sp.types.length) m.types = sp.types.slice();
      } else if (!m.species) {
        m.species = C.cleanName(m.id);
      }
      if (!m.name) m.name = m.species;
      if (!m.pp) m.pp = {};
    });
    return r;
  }

  function restoreFullBackup(data) {
    var FMT = window.SaveCode ? window.SaveCode.FORMAT : 'dailylocke-full-state';
    if (!data || data.format !== FMT || !data.runs || typeof data.runs !== 'object' || !data.profile) {
      throw new Error('This backup is incomplete or invalid.');
    }
    // Each run slot is validated, migrated and species-repaired before it
    // touches storage; anything unusable rejects the whole restore.
    ['daily', 'free', 'gauntlet'].forEach(function (mode) {
      var r = data.runs[mode];
      if (!r) { ST.clearRun(mode); return; }
      var err = ST.validate(r);
      if (err) throw new Error('The ' + mode + ' run in this backup is invalid: ' + err);
      var migrated = migrateSave(r);
      if (!migrated) throw new Error('The ' + mode + ' run in this backup has no surviving Pokemon.');
      ST.putRun(mode, repairRunSpecies(migrated));
    });
    ST.saveProfile(sanitizeProfileBackup(data.profile));
    if (data.daily && window.Daily) window.Daily.save(sanitizeDailyBackup(data.daily));
    run = null; loadProfile(); applyTheme(); updateMenuAvatar(); setContinueState();
  }
  function performManualImport() {
    var msg = $('saveImportMsg');
    if (!pendingImportFile) { msg.textContent = 'Choose a backup file first.'; return; }
    window.SaveCode.readFile(pendingImportFile).then(function (text) {
      var data;
      try { data = JSON.parse(String(text).replace(/^\uFEFF/, '').trim()); }
      catch (e) { throw new Error('This is not a valid Dailylocke save file.', { cause: e }); }
      var FMT = window.SaveCode ? window.SaveCode.FORMAT : 'dailylocke-full-state';
      if (!data || data.format !== FMT) throw new Error('This is not a valid Dailylocke backup file.');
      restoreFullBackup(data); closeSaveImport(); closeMenu(); show('Title'); toast('Backup restored. Reloading...');
      setTimeout(function () { window.location.reload(); }, 350);
    }).catch(function (e) { msg.textContent = e.message || 'Could not restore this backup.'; });
  }

  // The sub-screens are reachable mid-run AND from the title, so "Back" has
  // to return to whichever one the player actually came from.
  function backToRoute() {
    if (run && !run.over && run.party && run.party.length) {
      renderCrossroads(); show('Crossroads');
    } else { show('Title'); setContinueState(); }
  }

  // ---------------------------------------------------------------- PWA ----
  // Installability -- the service worker and the title-screen install pill --
  // lives in src/pwa.js, which owns its own state and needs nothing from the
  // game beyond `Game.toast`.

  // ---------------------------------------------------------------- BOOT ---
  function bootImpl() {
    // Render pixel sprites at their NATIVE size (1:1).
    //
    // Showdown's sprite canvases vary a lot -- Tatsugiri is 60x44, Grafaiai
    // 74x52, Charizard 133x140. The old rule doubled anything under 56px tall
    // to "fill the box", which made those two render at 2x pixel size next to
    // 1x neighbours: same art, visibly chunkier pixels. Species size should
    // come from the sprite itself, not from how it fits a container.
    // Only shrink (never enlarge) when a sprite genuinely overflows.
    window.__snapSprite = function (img) {
      try {
        if (img.classList.contains('evo-sprite')) return; // sized by CSS
        var nh = img.naturalHeight, nw = img.naturalWidth;
        if (!nh || !nw) return;
        var boxH = parseInt(img.dataset.box, 10) || 112;
        var boxW = parseInt(img.dataset.boxw, 10) || boxH;
        // Wide poses are the problem case. Showdown frames Salamence at
        // 137x92 (wings out) but Eevee at 64x55, so fitting BOTH axes hard
        // shrank Salamence to 0.38 scale -- it looked tiny beside its
        // neighbours. Sprites are transparent with empty edges, so a wide one
        // may spill a little past its slot; that reads far better than
        // shrinking it. `data-wt` is the width tolerance (1 = strict).
        var wt = parseFloat(img.dataset.wt) || 1;
        var scale = Math.min(1, boxH / nh, (boxW * wt) / nw);
        img.style.height = Math.max(1, Math.round(nh * scale)) + 'px';
        img.style.width  = Math.max(1, Math.round(nw * scale)) + 'px';
      } catch (e) {}
    };
    loadProfile(); applyTheme(); updateMenuAvatar();
    // If localStorage is unavailable (Safari private mode, storage disabled,
    // quota exceeded) the game runs but nothing persists. Say so ONCE per
    // session instead of letting the player lose an hour of progress on
    // refresh with no warning at all.
    try {
      if (window.Storage && !window.Storage.available()) {
        setTimeout(function () {
          toast('Saves are disabled in this browser — your run will not persist after this session.');
        }, 1200);
      }
    } catch (eStorageWarn) {}
    // The coach never touches localStorage itself: it reads and writes the
    // profile object app.js already owns, so there is exactly one writer and
    // the lesson state rides along in every backup automatically.
    if (window.Coach) window.Coach.attach(profile, saveProfile);
    initTitle();
    initSetup();

    // Warm the learnsets chunk while the player is still on the title screen.
    // It's only *needed* at the first roll of a moveset, but fetching it now
    // means that roll is instant instead of a 2.9 MB stall in front of the
    // first battle. Failure here is non-fatal: legalMoves() awaits it again.
    if (window.PS && window.PS.learnsetsReady) {
      window.PS.learnsetsReady().catch(function (e) {
        console.warn('[boot] learnsets prefetch failed; will retry on demand', e);
      });
    }

    var bootResumedBattle = false;
    $('btnGoBattle').addEventListener('click', startNextBattle);
    $('btnStarterBack').addEventListener('click', function () { show('Title'); setContinueState(); });
    // Team Gauntlet draft screen.
    $('btnTbBack').addEventListener('click', function () { gbConfigIdx = -1; gbTraining = false; show('Title'); setContinueState(); });
    $('btnTbStart').addEventListener('click', confirmGauntlet);
    $('tbSearch').addEventListener('input', drawBuilder);
    $('tbSortStat').addEventListener('change', drawBuilder);
    $('tbSortDir').addEventListener('change', drawBuilder);

    // ---- AUTO-RESUME: if a run was mid-battle when the app was closed,
    // go directly back to that battle instead of showing the title.
    try {
      var resumeRun = null;
      ['free', 'daily', 'gauntlet'].forEach(function (mode) {
        if (resumeRun) return;
        var saved = loadGame(mode);
        if (saved && saved._inBattle && saved._battleCfg) resumeRun = saved;
      });
      if (resumeRun) {
        run = reviveRun(resumeRun);
        var cfg = run._battleCfg;
        if (cfg && cfg.enemies && cfg.enemies.length && cfg.enemies[0]) {
          // Rebuild EVERY enemy from the saved config -- a trainer fight has
          // up to six of them, and resuming a 6v6 as a 6v1 was a free win.
          var enemies = cfg.enemies.map(function (eData, ei) {
            return {
              id: eData.id, name: eData.name, species: eData.species || eData.name,
              types: eData.types || [], moves: eData.moves || [],
              ability: eData.ability || 'No Ability',
              nature: eData.nature || 'Serious', shiny: !!eData.shiny,
              hpPct: eData.hpPct != null ? eData.hpPct : 1, status: eData.status || '',
              pp: eData.pp || {}, item: eData.item || '', elite: eData.elite || null,
              level: 100, uid: 'e' + Date.now() + '-' + ei,
              evs: {hp:0,atk:0,def:0,spa:0,spd:0,spe:0},
              ivs: {hp:31,atk:31,def:31,spa:31,spd:31,spe:31},
              sp: null, section: run.section || 1
            };
          });
          bootResumedBattle = true;
          show('Battle');
          var resumeCfg = {
            enemies: enemies,
            isWild: cfg.isWild,
            catchable: cfg.catchable,
            isTutorialCapture: !!cfg.isTutorialCapture,
            isTutorialSE: !!cfg.isTutorialSE,
            isTutorialSwitch: !!cfg.isTutorialSwitch,
            isTutorialSafe: cfg.isTutorialSafe != null ? !!cfg.isTutorialSafe :
              N.isTutorialSafetySection(run),
            trainer: cfg.trainer || null,
            clause: cfg.clause || null,
            // The field effect is deterministic per seed/section/battle, so it
            // can be recomputed instead of stored in the save.
            fieldEffect: N.fieldEffectFor(run, cfg.isWild ? false : true)
          };
          // handleRequest() applies the saved HP/status once on the first
          // request (module flag -- never persisted into the save).
          resumePending = true;
          function resumeNow() {
            try {
              beginBattle(resumeCfg);
              toast('Resuming battle...');
            } catch (err) {
              console.warn('[boot] auto-resume renderer failed', err);
              battleFailed(err);
            }
          }
          if (window.RendererReady && !window.RendererReady.loaded) {
            window.RendererReady.start().then(resumeNow, function (err) {
              console.warn('[boot] renderer upgrade failed during resume', err);
              battleFailed(err);
            });
          } else {
            resumeNow();
          }
        } else {
          // Battle config was lost or corrupt: drop the flag and let the title
          // offer the run normally rather than stranding the player.
          run._inBattle = false;
          run._battleCfg = null;
          saveGame();
        }
      }
    } catch (e) {
      console.warn('[boot] auto-resume failed', e);
      if (run && run._inBattle) battleFailed(e);
      else appFatal('The saved battle could not be resumed', e);
    }
    $('btnTutorBack').addEventListener('click', function () {
      // Sliders may be moved in either order, so their session draft can be
      // temporarily over budget. Do not close or graduate the tutorial until
      // the player has brought it back within the 66-point limit.
      if (!commitStatDraft(true)) return;
      if (run && svc && !svc.free) saveGame();
      // The guided training is complete once the player presses Done: every
      // tab was walked through, so this is where the tutorial concludes —
      // provided the forced evolution happened too (train-first players are
      // sent back to evolve the starter before the prologue ends).
      if (tutorGuide) {
        var wasGuided = tutorGuideActive();
        tutorGuide = null;
        if (run && !run.tutorialTrained) {
          run.tutorialTrained = true;
          saveGame();
        }
        if (wasGuided) {
          if (window.Coach) { try { window.Coach.clearMark(); } catch (e) {} }
          if (run.tutorialEvolved || !starterMon()) concludeTutorial();
        }
      }
      svc = null;
      if (gbTraining) {
        gbTraining = false;
        show('TeamBuilder');
        if (gbConfigIdx >= 0) {
          drawBuilder();
          openGbConfig(gbConfigIdx);
        } else {
          drawBuilder();
        }
      } else {
        renderCrossroads(); show('Crossroads');
      }
    });
    // "Save progress" lives only on the section summary now: saving is
    // taught at the one moment it matters (a section done), not after every
    // battle. The backup itself stays reachable from the menu.
    $('btnSumSave').addEventListener('click', openSaveExport);
    // Encrypted backup export and restore modals.
    $('btnSaveExportClose').addEventListener('click', closeSaveExport);
    var dlBtn = $('btnDownloadSave');
    if (dlBtn) dlBtn.addEventListener('click', downloadCurrentSave);
    $('btnSaveImportClose').addEventListener('click', closeSaveImport);
    $('btnImportLoad').addEventListener('click', performManualImport);
    $('saveFileIn').addEventListener('change', onSaveFileChosen);
    $('btnCatchDone').addEventListener('click', afterBattleAdvance);
    $('btnEvoDone').addEventListener('click', function () {
      // A morph launched from the reward screen returns to it so the
      // Continue flow (section summary / next section) still runs.
      if (rewardEvoOnScreen) {
        rewardEvoOnScreen = false;
        show('Reward');
        return;
      }
      renderCrossroads(); show('Crossroads');
    });
    $('btnSumNext').addEventListener('click', function () {
      run.catchMissed = false; run.lastCaughtName = null;
      N.resetSectionStats(run);
      saveGame(); renderCrossroads(); show('Crossroads');
    });
    $('btnNickOk').addEventListener('click', confirmNickname);
    $('nickInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); confirmNickname(); }
    });
    $('btnAvatarCancel').addEventListener('click', function () {
      // Cancelling from setup must not discard the sprite they had.
      if (avatarPickerFrom === 'setup') pendingAvatar = null;
      closeAvatarPicker();
    });
    $('btnAvatarSave').addEventListener('click', function () {
      if (avatarPickerFrom === 'setup') {
        // Setup commits on "Begin", not here -- so just preview the choice.
        var img = $('setupAvatarImg');
        if (img && pendingAvatar) img.src = avatarUrl(pendingAvatar);
        closeAvatarPicker();
        return;
      }
      if (pendingAvatar) { profile.avatar = pendingAvatar; saveProfile(); updateMenuAvatar(); }
      closeAvatarPicker(); showProfile();
    });
    $('btnPickerCancel').addEventListener('click', dismissPicker);
    $('btnShopItemBuy').addEventListener('click', buyFromShopPopup);
    $('btnShopItemUse').addEventListener('click', useOwnedFromShopPopup);
    $('btnShopItemSell').addEventListener('click', sellFromShopPopup);
    $('btnShopItemClose').addEventListener('click', closeShopItemPopup);
    // ---- Shop quantity stepper ([-] [input] [+] on the buy sheet) ----
    $('btnShopQtyMinus').addEventListener('click', function () {
      var ctx = shopItemPopup;
      if (!ctx || ctx.source !== 'shop') return;
      ctx.qty = shopQtyClamp((Number(ctx.qty) || 1) - 1, shopQtyMax(ctx.entry));
      drawShopItemPopup();
    });
    $('btnShopQtyPlus').addEventListener('click', function () {
      var ctx = shopItemPopup;
      if (!ctx || ctx.source !== 'shop') return;
      ctx.qty = shopQtyClamp((Number(ctx.qty) || 1) + 1, shopQtyMax(ctx.entry));
      drawShopItemPopup();
    });
    var shopQtyInputEl = $('shopQtyInput');
    shopQtyInputEl.addEventListener('input', function () {
      var ctx = shopItemPopup;
      if (!ctx || ctx.source !== 'shop') return;
      // Only remember what was typed; the redraw keeps the caret alone and
      // clamping happens on 'change' (blur) so typing "10" isn't truncated
      // to "1" after the first keystroke.
      ctx.qty = Math.max(1, Math.floor(Number(shopQtyInputEl.value) || 1));
      drawShopItemPopup();
    });
    shopQtyInputEl.addEventListener('change', function () {
      var ctx = shopItemPopup;
      if (!ctx || ctx.source !== 'shop') return;
      ctx.qty = shopQtyClamp(shopQtyInputEl.value, shopQtyMax(ctx.entry));
      drawShopItemPopup();
    });
    shopQtyInputEl.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      var buyBtn = $('btnShopItemBuy');
      if (buyBtn && !buyBtn.disabled) buyBtn.click();
    });
    $('btnGoTitle').addEventListener('click', function () { show('Title'); setContinueState(); });
    // ---- Daily result screen ----
    $('btnDrTitle').addEventListener('click', function () { show('Title'); setContinueState(); });
    $('btnDrHistory').addEventListener('click', showHistory);
    $('btnDrContinue').addEventListener('click', continueDailyInFreePlay);
    $('btnDrCopy').addEventListener('click', function () {
      var txt = $('drShareText').value;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(function () { toast('Result copied!'); }, function () { toast('Copy failed.'); });
      } else { $('drShareText').focus(); $('drShareText').select(); toast('Select and copy the result text.'); }
    });
    // The Web Share sheet is the natural way to send this on a phone, but it
    // only exists on some browsers -- so the button only appears where it works.
    var shareBtn = $('btnDrShare');
    if (shareBtn && navigator.share) {
      shareBtn.hidden = false;
      shareBtn.addEventListener('click', function () {
        navigator.share({ title: 'Dailylocke', text: $('drShareText').value })
          .catch(function () { /* the user dismissed the sheet */ });
      });
    }
    $('btnMenu').addEventListener('click', openMenu);
    $('btnMenuClose').addEventListener('click', closeMenu);
    $('btnMenuProfile').addEventListener('click', showProfile);
    $('btnMenuShinies').addEventListener('click', showShinies);
    $('btnMenuHistory').addEventListener('click', showHistory);
    $('btnMenuGuide').addEventListener('click', showGuide);
    $('btnMenuRules').addEventListener('click', showRules);
    $('btnMenuTransfer').addEventListener('click', function () { closeMenu(); openSaveExport(); });
    $('btnMenuImport').addEventListener('click', function () { closeMenu(); openSaveImport(); });
    $('btnRulesBack').addEventListener('click', backToRoute);
    var rg = $('btnRulesGuide');
    if (rg) rg.addEventListener('click', showGuide);
    $('btnMenuAbandon').addEventListener('click', function () {
      if (!run) return;
      if (!confirm('Are you sure you want to abandon this run?')) return;
      var mode = run.mode || 'free';
      clearSave(mode);
      run = null;
      closeMenu();
      show('Title');
      setContinueState();
    });
    $('btnMenuQuit').addEventListener('click', function () {
      closeMenu(); show('Title'); setContinueState();
    });
    $('btnProfBack').addEventListener('click', backToRoute);
    $('btnShinyBack').addEventListener('click', backToRoute);
    $('btnHistBack').addEventListener('click', backToRoute);
    $('btnGuideBack').addEventListener('click', backToRoute);
    if (!bootResumedBattle) show('Title');
    // The first title paint is static. Once Three/BattleUI is ready, add the
    // animated showcase: projected Pokemon over the same 3D biome a battle
    // renders, sharing the one session renderer. If WebGL is unavailable the
    // showcase mounts flat and the recovery chain upgrades it in place.
    if (window.RendererReady) {
      window.RendererReady.ready.then(function () {
        if (!$('screenTitle').hidden) startTitleScene();
      }, function (err) {
        console.warn('[boot] optional animated showcase unavailable', err);
        toast('The game is ready; animated scenery is unavailable.');
      });
    }
  }
  function boot() {
    try {
      bootImpl();
    } catch (err) {
      console.error('[app] boot failed', err);
      appFatal('The game could not start', err);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.Game = { get run() { return run; }, show: show, startNextBattle: startNextBattle,
                  startGauntlet: startGauntlet,
                  // True while startNextBattle is still assembling a battle.
                  // Exposed so tests can assert the "dead button" latch is
                  // released after a failed start.
                  get battleStarting() { return battleStarting; },
                  // Stable conceptual progress for the guided run. The coach
                  // renders this as a bar instead of claiming every card is a
                  // separately numbered step.
                  tutorialProgress: tutorialProgress,
                  // The guided training walkthrough's current step (tests).
                  get tutorGuide() { return tutorGuide; },
                  // Sprite helpers (tests + console debugging).
                  spriteUrls: spriteUrls, prefetchSpecies: prefetchSpecies,
                  redrawRoute: renderCrossroads, toast: toast,
                  // The exact payload the Download backup button writes. Exposed
                  // so tests can assert on what an export contains.
                  fullBackupState: fullBackupState,
                  // the live 3D battle UI, for debugging field effects
                  get ui() { return ui; },
                  // Post-battle progression. Exposed because the end of a
                  // finite Daily is a boundary worth testing directly: reaching
                  // it through six real boss Pokemon is far too slow and too
                  // RNG-dependent to assert on.
                  advance: afterBattleAdvance,
                  // The victory screen, exposed so the suite can drive the
                  // 1-of-3 reward cards (and their forced use/give sheet)
                  // without playing a whole battle to get there.
                  reward: showReward,
                  setContinueState: setContinueState,
                  showDailyResult: showDailyResult,
                  continueDailyInFreePlay: continueDailyInFreePlay,
                  // Coach hook: the player bailed on tips mid-tutorial, so the
                  // guided run is over -- hand them the ordinary game.
                  onCoachSkip: onCoachSkip };

  // ---------------------------------------------------------------- AUDIO --
  // Music is owned by src/audio.js. It plays only while a battle is on screen
  // and is started by beginBattle()/stopped by show(), so nothing here needs
  // to poll or observe the DOM.
})();
