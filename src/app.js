// ============================================================================
// app.js — Nuzlocke simulator: screens, section flow, mart, battle glue.
// ============================================================================
(function () {
  var PS = window.PS, Dex = PS.Dex;
  var C = window.Core, N = window.Nuz, RB = window.RogueBattle;

  var $ = function (id) { return document.getElementById(id); };
  var run = null, ui = null, battle = null, bctx = null;

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ------------------------------------------------------------ SPRITES ---
  // Sprite fallback chain. `shiny` swaps in Showdown's parallel -shiny
  // directories and PokeAPI's /shiny/ path; every tier of the chain has a
  // shiny twin, so a shiny never silently falls back to normal colours.
  function spriteUrls(speciesId, isBack, shiny) {
    var urls = [];
    var sp = Dex.species.get(speciesId);
    var sd = String((sp.exists && sp.spriteid) || speciesId || 'unknown').toLowerCase().replace(/[^a-z0-9-]+/g, '');
    var num = sp.exists ? sp.num : 0;
    var bs = isBack ? '-back' : '';
    var sh = shiny ? '-shiny' : '';
    var pa = shiny ? 'shiny/' : '';
    function add(u) { if (u && urls.indexOf(u) < 0) urls.push(u); }
    add('https://play.pokemonshowdown.com/sprites/ani' + bs + sh + '/' + sd + '.gif');
    if (num) add('https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/versions/generation-v/black-white/animated/' + (isBack ? 'back/' : '') + pa + num + '.gif');
    add('https://play.pokemonshowdown.com/sprites/gen5' + bs + sh + '/' + sd + '.png');
    if (num) add('https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/' + (isBack ? 'back/' : '') + pa + num + '.png');
    // last resort: the non-shiny art, so something always renders
    if (shiny) spriteUrls(speciesId, isBack, false).forEach(add);
    return urls;
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
    var urls = spriteUrls(id, false, shiny);
    urls.push(iconUrl(id));
    var chain = urls.slice(1);
    var onerr = "this.onerror=null;var q=" + JSON.stringify(chain) + ";" +
                "if(!this._i)this._i=0;" +
                "if(this._i<q.length){this.src=q[this._i++];this.onerror=arguments.callee;}";
    return '<img class="anim-mon ' + (cls || '') + (shiny ? ' is-shiny' : '') + '" src="' + urls[0] + '" alt="" ' +
           'data-box="' + px + '" data-boxw="' + (pw || px) + '" data-wt="' + (wt || 1) + '" ' +
           'onload="window.__snapSprite&&window.__snapSprite(this)" ' +
           'onerror="' + onerr.replace(/"/g, '&quot;') + '">';
  }

  // Still needed for <img> fallbacks on the big artwork sprites.
  function iconUrl(id) {
    var sp = Dex.species.get(id);
    return sp.exists && sp.num
      ? 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/' + sp.num + '.png'
      : 'https://play.pokemonshowdown.com/sprites/gen5/' + id + '.png';
  }
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
  function speciesOf(mon) {
    if (!mon) return '';
    return mon.species || C.cleanName(mon.id);
  }

  function typeChips(types) {
    return types.map(function (t) { return '<span class="type type-' + t + '">' + t + '</span>'; }).join('');
  }

  // A large sprite that degrades through the whole fallback chain instead of
  // jumping straight to the 200px PokeAPI artwork (which then has to be
  // downscaled and looks soft). Small BW sprites are snapped to an integer
  // 2x so every source pixel maps to exactly 2x2 screen pixels.
  function bigSprite(id, cls, box, boxw, wt, shiny) {
    var urls = spriteUrls(id, false, shiny);
    urls.push(iconUrl(id));
    var chain = urls.slice(1);
    var onerr = "this.onerror=null;var q=" + JSON.stringify(chain) + ";" +
                "if(!this._i)this._i=0;" +
                "if(this._i<q.length){this.src=q[this._i++];this.onerror=arguments.callee;}";
    return '<img class="' + (cls || '') + (shiny ? ' is-shiny' : '') + '" src="' + urls[0] + '" alt="" ' +
           'data-box="' + (box || 112) + '" data-boxw="' + (boxw || box || 112) + '" data-wt="' + (wt || 1) + '" ' +
           'onload="window.__snapSprite&&window.__snapSprite(this)" ' +
           'onerror="' + onerr.replace(/"/g, '&quot;') + '">';
  }

  // ------------------------------------------------------------ SCREENS ---
  var SCREENS = ['Title', 'Starter', 'Crossroads', 'Battle',
                 'Reward', 'Catch', 'Tutor', 'Evolve', 'Summary', 'GameOver',
                 'Profile', 'Shinies', 'History', 'Rules'];
  function show(name) {
    SCREENS.forEach(function (s) {
      var el = $('screen' + s);
      if (el) el.hidden = (s !== name);
    });
    if (name !== 'Battle') teardownBattleUI();
    // Battle music never plays outside a battle. beginBattle() starts the
    // right track; every other screen fades it out.
    if (name !== 'Battle' && window.GameAudio) window.GameAudio.stop();
    // The showcase is a full WebGL context; never leave it running behind
    // another screen.
    if (name === 'Title') startTitleScene(); else stopTitleScene();
    window.scrollTo(0, 0);
  }
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg; t.classList.add('on');
    clearTimeout(t._h); t._h = setTimeout(function () { t.classList.remove('on'); }, 2300);
  }

  // -------------------------------------------------------------- TITLE ---
  // ---- TITLE SHOWCASE ------------------------------------------------------
  // A real BattleUI instance in `showcase` mode: the 3D biome and two animated
  // Pokemon, no HUD at all. They trade attack animations forever so the title
  // feels alive rather than being a static screenshot.
  var titleUI = null, titleLoop = null;

  function startTitleScene() {
    var host = $('titleStage');
    if (!host || titleUI || !window.BattleUI) return;
    try {
      titleUI = new window.BattleUI();
      titleUI.showcase = true;          // suppress every HUD element
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
      titleUI.setupBattle({
        player: { name: sa.name, lv: 100, types: sa.types.slice(), hp: 1, max: 100, st: null,
                  h: worldH(A), sid: sa.spriteid || A, num: sa.num, u: spriteUrls(A, true) },
        enemy:  { name: sb.name, lv: 100, types: sb.types.slice(), hp: 1, max: 100, st: null,
                  h: worldH(B), sid: sb.spriteid || B, num: sb.num, u: spriteUrls(B, false) },
        biomeSeed: 'title|' + A + '|' + B,
        biomeTypes: sa.types
      });
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
    } catch (e) { console.warn('title scene', e); }
  }

  function stopTitleScene() {
    if (titleLoop) { clearTimeout(titleLoop); titleLoop = null; }
    if (titleUI) {
      try { titleUI.unmount(); } catch (e) {}
      titleUI = null;
    }
    var host = $('titleStage');
    if (host) { host.innerHTML = ''; host._bm = false; }
  }

  function initTitle() {
    $('btnNewRun').addEventListener('click', function () { startRun(Math.floor(Math.random() * 1e9)); });
    $('btnDaily').addEventListener('click', function () {
      var d = new Date();
      startRun(C.hashString('daily|' + d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate()));
    });
    $('btnSeed').addEventListener('click', function () {
      var s = prompt('Enter a seed (any text):'); if (s) startRun(C.hashString(s));
    });
    var tl = $('btnTitleLoad');
    if (tl) tl.addEventListener('click', function () { openSaveImport(); });
    // Show today's date on the daily button so it reads as "the" run.
    try {
      var d0 = new Date();
      var fmt = d0.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
      $('dailyDate').textContent = 'Everyone gets the same seed \u00b7 ' + fmt;
    } catch (e) {}
    $('btnTitleMenu').addEventListener('click', openMenu);
    $('btnAbandonTitle').addEventListener('click', function () {
      if (confirm('Abandon the run in progress? Your team is lost.')) {
        clearSave(); run = null; setContinueState();
      }
    });
    setContinueState();
    $('btnContinue').addEventListener('click', function () {
      var s = loadGame(); if (!s) { toast('No save found.'); return; }
      run = reviveRun(s); renderCrossroads(); show('Crossroads');
    });
  }

  // Continue is always visible; disabled (not hidden) when nothing is saved,
  // so the title layout never shifts.
  // The title has exactly two states. With a run in progress we show ONLY
  // Continue (plus an explicit Abandon), so there is no way to casually click
  // "Daily Run" and destroy a run you forgot you had. With no save, Continue
  // is not rendered at all rather than shown disabled.
  function setContinueState() {
    var saved = loadGame();
    var fresh = $('titleFresh'), resume = $('titleResume');
    if (!fresh || !resume) return;
    fresh.hidden = !!saved;
    resume.hidden = !saved;
    if (saved) {
      var sub = $('continueSub');
      if (sub) {
        var sec = saved.section || 1, won = saved.battlesWon || 0;
        var n = (saved.party && saved.party.length) || 0;
        sub.textContent = 'Section ' + sec + ' \u00b7 ' + won +
          (won === 1 ? ' battle won' : ' battles won') + ' \u00b7 ' + n +
          (n === 1 ? ' Pokemon' : ' Pokemon');
      }
    }
  }

  function seedChip(seed) {
    return '<div class="seed-chip">Run seed: <b>' + seed + '</b></div>';
  }

  // ------------------------------------------------------------ STARTER ---
  var starterChoices = [];
  async function startRun(seed) {
    run = N.newRun(seed);
    var rand = C.mulberry32(seed ^ 0x1234);
    var pool = C.speciesPool().filter(function (id) {
      var b = C.bst(id);
      return b >= 380 && b <= 500 && !C.isLegendary(id);
    });
    var ids = C.pickN(pool, 3, rand);
    show('Starter');
    $('starterGrid').innerHTML = '<p class="hint center">Loading...</p>';
    starterChoices = [];
    for (var i = 0; i < ids.length; i++) {
      var sm = N.trainPlayerMon(await C.makeMon(ids[i]));
      // A starter rolls for shiny on the same 1/512 odds as a wild.
      if (rand() < N.SHINY_ODDS) sm.shiny = true;
      starterChoices.push(sm);
    }
    renderStarters();
  }

  function renderStarters() {
    var g = $('starterGrid');
    g.innerHTML = '';
    starterChoices.forEach(function (mon) {
      var card = document.createElement('div');
      card.className = 'card starter-card';
      card.innerHTML =
        '<div class="sprite-box">' + bigSprite(mon.id, '', 112, 150, 1, mon.shiny) + '</div>' +
        '<div class="sc-name">' + mon.name + '</div>' +
        '<div class="types">' + typeChips(mon.types) + '</div>' +
        '<div class="statline">HP ' + C.maxHP(mon) + ' \u00b7 BST ' + C.bst(mon.id) + '</div>' +
        '<div class="ability">' + mon.ability + '</div>' +
        '<div class="movelist">' + mon.moves.map(function (m) {
          var d = Dex.moves.get(m);
          return '<span class="mv-chip type-' + d.type + '" data-tip="move:' + d.id + '" tabindex="0">' + d.name + '</span>';
        }).join('') + '</div>' +
        '<button class="btn-primary pick-btn">Choose</button>';
      card.querySelector('.pick-btn').addEventListener('click', function () {
        askNickname(mon, function (nick) {
          mon.species = C.cleanName(mon.id);   // remember what it really is
          mon.name = nick;
          run.party.push(mon);
          N.trackMon(run, mon);
          run.seenSpecies[mon.id] = 1;
          N.addItem(run, 'pokeball', 5);
          N.addItem(run, 'potion', 3);
          N.logMsg(run, 'You set out with ' + nick + ' the ' + mon.species + '.');
          if (mon.shiny) recordShiny(mon, 'starter');
          saveGame(); renderCrossroads(); show('Crossroads');
        });
      });
      g.appendChild(card);
    });
    g.insertAdjacentHTML('beforeend', seedChip(run.seed));
  }

  // --------------------------------------------------------- CROSSROADS ---
  function renderCrossroads() {
    renderHud();
    var trainerNext = N.nextIsTrainer(run);
    var n = run.battleInSection;
    var routeNames = ['Verdant Trail', 'Sunlit Pass', 'Amber Hollow', 'Moonlit Ridge',
                      'Windward Steps', 'Quiet Glade', 'Ashen Flats', 'Silver Causeway'];
    $('xSection').textContent =
      routeNames[C.hashString(run.seed + '|route|' + run.section) % routeNames.length];
    var eyebrow = $('xEyebrow');
    if (eyebrow) eyebrow.textContent = 'Section ' + run.section;
    // One quiet line of progress instead of a stepper graphic.
    var stageNames = ['Capture', 'Wild', 'Wild', 'Trainer'];
    $('xProgress').textContent =
      'Stop ' + Math.min(n + 1, 4) + ' of 4  \u00b7  ' + stageNames[Math.min(n, 3)];

    var isCapture = !trainerNext && n === 0;
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
        var trainerArt = N.trainerFor(run);
        art = '<img src="https://play.pokemonshowdown.com/sprites/trainers/' + trainerArt.sprite + '.png" alt="' + trainerArt.cls + '" onerror="this.style.display=\'none\'">';
        bi.className = 'x-ic x-art trainer-art';
      } else {
        var wildKey = run.section + ':' + run.battleInSection;
        if (!run._nextWild || run._nextWild.key !== wildKey) run._nextWild = { key:wildKey, id:N.pickWild(run, { dupesClause:n === 0 }) };
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
      desc.textContent = 'Your only catch of Section ' + run.section + ' \u2014 weaken it, then throw a ball.';
      desc.classList.add('ok');
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
    drawOwned();

    // the shop lives on this screen now
    openMart();
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
        martStock.push({ kind: 'forme', id: f.id, name: f.name, price: f.price,
                         desc: f.desc, stock: 99, hot: true, unique: true,
                         forSpecies: f.forSpecies });
      });
    }
    drawMart();
  }
  function drawMart() {
    var grid = $('martGrid');
    grid.innerHTML = '';
    var groups = { ball: 'Poke Balls', heal: 'Medicine', evo: 'Evolution Items', forme: 'Forme Change', mega: 'Mega Stones', held: 'Held Items', service: 'Services' };
    Object.keys(groups).forEach(function (k) {
      var items = martStock.filter(function (e) {
        if (e.kind !== k) return false;
        if (e.unique && N.ownsItem(run, e.id)) return false;
        return true;
      });
      if (!items.length) return;
      var h = document.createElement('h3');
      h.className = 'sub-title'; h.textContent = groups[k];
      grid.appendChild(h);
      var wrap = document.createElement('div');
      wrap.className = 'shop-grid';
      items.forEach(function (e) {
        // Unique stock (Mega Stones): if you already own one, don't offer it
        // again. Selling it removes it from the bag, so it comes straight back.
        if (e.unique && N.ownsItem(run, e.id)) return;
        var sold = e.stock <= 0;
        // Can't afford it -> dim it, same as sold out. The price stays legible
        // so it still reads as a goal rather than a broken tile.
        var broke = !sold && run.money < e.price;
        var d = document.createElement('div');
        if (e.kind !== 'service') d.setAttribute('data-tip', 'item:' + e.id);
        d.className = 'shop-item' + (sold ? ' sold' : '') + (broke ? ' broke' : '') + (e.kind === 'service' ? ' service' : '') + (e.hot ? ' hot' : '') + (e.kind === 'mega' ? ' mega-item' : '') + (e.kind === 'forme' ? ' forme-item' : '');
        var artHtml = (window.ItemArt && e.kind !== 'service')
          ? window.ItemArt.itemImg(e.id, 34, 'si-art') : '';
        d.innerHTML =
          '<div class="si-top">' + artHtml + '<span class="si-name">' + e.name + '</span>' +
          '<span class="si-price' + (e.sale ? ' sale' : '') + '">' + (sold ? 'SOLD' : '$' + e.price) + '</span></div>' +
          '<div class="si-desc">' + (e.desc || '') + '</div>' +
          (e.kind === 'evo' ? '<div class="si-tag evo">evolution</div>' : '') +
          (e.kind === 'mega' ? '<div class="si-tag mega">mega stone</div>' : '') +
          (e.kind === 'forme' ? '<div class="si-tag forme">forme change</div>' : '') +
          (e.hot && e.kind !== 'evo'
              ? '<div class="si-hot">\u2726 your party can use this</div>' : '') +
          (run.bag[e.id] ? '<div class="si-own">owned: ' + run.bag[e.id] + '</div>' : '');
        if (!sold) d.addEventListener('click', function () { buyEntry(e); });
        wrap.appendChild(d);
      });
      grid.appendChild(wrap);
    });

    // sell
    var sell = $('martSell');
    var owned = Object.keys(run.bag);
    sell.innerHTML = owned.length ? '' : '<p class="hint">Your bag is empty.</p>';
    owned.forEach(function (id) {
      var nm = itemName(id);
      var val = Math.floor(basePrice(id) / 2);
      var b = document.createElement('button');
      b.className = 'sell-btn';
      b.innerHTML = (window.ItemArt ? window.ItemArt.itemImg(id, 22) : '') +
                    nm + ' x' + run.bag[id] + ' <b>+$' + val + '</b>';
      b.addEventListener('click', function () {
        N.useItem(run, id); run.money += val;
        drawMart(); drawOwned(); renderHud(); saveGame();
      });
      sell.appendChild(b);
    });
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

  function buyEntry(e) {
    if (run.money < e.price) { toast('Not enough money.'); return; }
    run.money -= e.price;
    if (!e.unique) e.stock--;      // unique items are gated by ownership
    N.addItem(run, e.id, 1);
    N.logMsg(run, 'Bought ' + e.name + '.');
    toast('Bought ' + e.name + '!');
    drawMart(); drawOwned(); renderHud(); saveGame();
  }

  // ------------------------------------------------------ TRAIN POKEMON ---
  // One paid session that covers everything: moves, ability, nature and EVs.
  // Pay once, change as much as you like, press Done.
  var svc = null;
  var SERVICE_PRICE = 2000;

  var NATURES = [
    ['Adamant','Atk','SpA'], ['Modest','SpA','Atk'], ['Jolly','Spe','SpA'],
    ['Timid','Spe','Atk'],   ['Bold','Def','Atk'],   ['Calm','SpD','Atk'],
    ['Impish','Def','SpA'],  ['Careful','SpD','SpA'],['Brave','Atk','Spe'],
    ['Quiet','SpA','Spe'],   ['Relaxed','Def','Spe'],['Sassy','SpD','Spe'],
    ['Naive','Spe','SpD'],   ['Hasty','Spe','Def'],  ['Serious','\u2014','\u2014']
  ];
  var STAT_KEYS = [['hp','HP'],['atk','Atk'],['def','Def'],['spa','SpA'],['spd','SpD'],['spe','Spe']];

  function openTrainer(mon) {
    if (run.money < SERVICE_PRICE) { toast('Not enough money.'); return; }
    run.money -= SERVICE_PRICE;
    svc = { mon: mon, tab: 'moves', replaceSlot: null, all: null };
    renderHud(); saveGame();
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
      b.addEventListener('click', function () { svc.tab = b.dataset.t; drawTrainer(); });
    });

    var body = $('trBody');
    if (svc.tab === 'moves') return drawTrainMoves(body, mon);
    if (svc.tab === 'ability') return drawTrainAbility(body, mon);
    if (svc.tab === 'nature') return drawTrainNature(body, mon);
    return drawTrainStats(body, mon);
  }

  async function drawTrainMoves(body, mon) {
    body.innerHTML = '<p class="hint">Reading learnset...</p>';
    if (!svc.all) {
      var all = await N.tutorOptions(mon);
      all.sort(function (a, b) {
        var A = Dex.moves.get(a), B = Dex.moves.get(b);
        var ap = A.category === 'Status' ? -1 : A.basePower;
        var bp = B.category === 'Status' ? -1 : B.basePower;
        if (ap !== bp) return bp - ap;
        return A.name.localeCompare(B.name);
      });
      svc.all = all;
    }
    body.innerHTML =
      '<div class="tutor-current" id="trCurrent"></div>' +
      '<input id="tutorSearch" class="search" placeholder="Search by name or type..." autocomplete="off"/>' +
      '<div id="tutorList" class="move-list"></div>';

    function drawCurrent() {
      $('trCurrent').innerHTML =
        '<div class="tc-label">Current moves \u2014 tap one to replace it</div>' +
        '<div class="tc-slots">' + mon.moves.map(function (id, i) {
          var m = Dex.moves.get(id);
          return '<button class="tc-slot type-' + m.type + (svc.replaceSlot === i ? ' sel' : '') +
            '" data-slot="' + i + '" data-tip="move:' + m.id + '">' +
            '<span class="tc-n">' + m.name + '</span>' +
            '<span class="tc-m">' + (m.category === 'Status' ? 'St' : m.basePower) + '</span>' +
            '</button>';
        }).join('') + '</div>';
      $('trCurrent').querySelectorAll('.tc-slot').forEach(function (b) {
        b.addEventListener('click', function () {
          var i = +b.dataset.slot;
          svc.replaceSlot = (svc.replaceSlot === i) ? null : i;
          drawCurrent();
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
      }).slice(0, 120);
      listEl.innerHTML = subset.map(function (id) {
        var m = Dex.moves.get(id);
        var acc = m.accuracy === true ? '\u2014' : m.accuracy;
        return '<button class="move-card" data-m="' + id + '" data-tip="move:' + id + '">' +
          '<div class="mc-top"><span class="mv-chip type-' + m.type + '">' + m.type + '</span>' +
            '<span class="mc-cat">' + m.category + '</span></div>' +
          '<div class="mc-name">' + m.name + '</div>' +
          '<div class="mc-stats"><span>' + (m.category === 'Status' ? '\u2014' : 'Pow ' + m.basePower) +
            '</span><span>Acc ' + acc + '</span><span>PP ' + m.pp + '</span></div></button>';
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
        N.teachMove(run, mon, slot, moveId);
      }
      svc.replaceSlot = null;
      toast(mon.name + ' learned ' + nm.name + '!');
      drawCurrent();
      drawList($('tutorSearch') ? $('tutorSearch').value : '');
      saveGame();
    }

    drawCurrent();
    drawList('');
    $('tutorSearch').addEventListener('input', function () { drawList(this.value); });
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
        mon.ability = b.dataset.a;
        toast(mon.name + '\u2019s ability is now ' + b.dataset.a + '.');
        drawTrainer(); saveGame();
      });
    });
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
        mon.nature = b.dataset.n;
        toast(mon.name + ' is now ' + b.dataset.n + '.');
        drawTrainer(); saveGame();
      });
    });
  }

  function drawTrainStats(body, mon) {
    C.ensureSP(mon);
    var MAXP = C.SP_MAX, TOTAL = C.SP_TOTAL;
    function used() { return C.spUsed(mon); }

    // Build once, then only patch values on input: re-rendering the whole
    // block mid-drag would tear the slider out from under the pointer.
    body.innerHTML =
      '<div class="sp-head">Stat Points left <b id="spLeft">0</b> <span>/ ' + TOTAL + '</span></div>' +
      STAT_KEYS.map(function (k) {
        var v = mon.sp[k[0]] || 0;
        return '<div class="sp-row" data-s="' + k[0] + '">' +
          '<span class="sp-k">' + k[1] + '</span>' +
          '<input class="sp-range" type="range" min="0" max="' + MAXP + '" step="1" ' +
                 'value="' + v + '" data-s="' + k[0] + '" aria-label="' + k[1] + '"/>' +
          '<span class="sp-v">' + v + '</span>' +
          '</div>';
      }).join('') +
      '<p class="hint">Max ' + MAXP + ' per stat, ' + TOTAL + ' in total. ' +
        '1 point = +1 to that stat.</p>';

    var leftEl = body.querySelector('#spLeft');
    var rows = [].slice.call(body.querySelectorAll('.sp-range'));

    function paint() {
      var left = TOTAL - used();
      leftEl.textContent = left;
      leftEl.classList.toggle('none', left === 0);
      rows.forEach(function (r) {
        var k = r.dataset.s, v = mon.sp[k] || 0;
        if (+r.value !== v) r.value = v;
        r.parentNode.querySelector('.sp-v').textContent = v;
        // colour the filled part of the track without a repaint of the DOM
        r.style.setProperty('--fill', (v / MAXP * 100) + '%');
        // a stat that cannot go any higher is worth showing as capped
        r.parentNode.classList.toggle('maxed', v >= MAXP);
      });
    }

    rows.forEach(function (r) {
      r.addEventListener('input', function () {
        var k = r.dataset.s;
        var want = Math.max(0, Math.min(MAXP, parseInt(r.value, 10) || 0));
        var others = used() - (mon.sp[k] || 0);
        // Clamp to the remaining budget instead of refusing the drag: the
        // slider simply stops where the points run out.
        mon.sp[k] = Math.min(want, TOTAL - others);
        C.syncEVs(mon);
        paint();
      });
      r.addEventListener('change', function () { saveGame(); });
    });
    paint();
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
          '<span class="ts-name">' + m.name + '</span>' +
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
      overlay.hidden = true;
      host.innerHTML = '';
      return;
    }
    overlay.hidden = false;

    var mx = C.maxHP(mon), cur = C.curHP(mon);
    var pct = pctHP(mon.hpPct);
    var col = mon.hpPct > 0.5 ? '#4ade80' : mon.hpPct > 0.2 ? '#facc15' : '#ef4444';
    var dmg = Math.round(run.damageDealt[mon.uid] || 0);
    var kos = run.knockouts[mon.uid] || 0;

    host.innerHTML =
      '<div class="party-detail">' +
        '<div class="pd-hero">' +
          '<div class="pd-art">' + bigSprite(mon.id, '', 104, 104, 1, mon.shiny) + '</div>' +
          '<div class="pd-id">' +
            '<div class="pd-species">' + speciesOf(mon) + (mon.shiny ? ' \u2728' : '') + '</div>' +
            '<div class="pd-name">' + mon.name + '</div>' +
            '<div class="types">' + typeChips(mon.types) + '</div>' +
          '</div>' +
          '<button class="pd-close" title="Close">\u00d7</button>' +
        '</div>' +

        '<div class="pd-hp">' +
          '<div class="hm-b big"><i style="width:' + pct + '%;background:' + col + '"></i></div>' +
          '<span>' + cur + ' / ' + mx + (mon.status ? '  \u00b7  ' + mon.status.toUpperCase() : '') + '</span>' +
        '</div>' +

        '<div class="pd-facts">' +
          '<div class="pd-fact" data-tip="ability:' + mon.ability + '" tabindex="0"><span class="k">Ability</span><span class="v">' + mon.ability + '</span></div>' +
          '<div class="pd-fact"><span class="k">Nature</span><span class="v">' + (mon.nature || 'Serious') + '</span></div>' +
          '<div class="pd-fact"><span class="k">Damage</span><span class="v">' + dmg.toLocaleString() + '</span></div>' +
          '<div class="pd-fact"><span class="k">KOs</span><span class="v">' + kos + '</span></div>' +
        '</div>' +

        '<div class="pd-sec"><div class="pd-label">Held item</div>' +
          (mon.item
            ? '<button class="pd-held" data-take="1" data-tip="item:' + mon.item + '">' +
                (window.ItemArt ? window.ItemArt.itemImg(mon.item, 26) : '') +
                '<span>' + itemName(mon.item) + '</span><em>tap to remove</em></button>'
            : '<div class="pd-empty">Nothing held \u2014 give one from your Bag.</div>') +
        '</div>' +

        '<div class="pd-sec"><div class="pd-label">Moves</div>' +
          '<div class="pd-moves">' + mon.moves.map(function (m) {
            var mv = Dex.moves.get(m);
            var mxpp = Math.floor(mv.pp * 1.6);
            var have = mon.pp[m] != null ? mon.pp[m] : mxpp;
            var low = have / mxpp < 0.25;
            return '<div class="pd-move" data-tip="move:' + mv.id + '" tabindex="0">' +
              '<span class="mv-chip type-' + mv.type + '">' + mv.type + '</span>' +
              '<span class="pd-mn">' + mv.name + '</span>' +
              '<span class="pd-mp' + (low ? ' low' : '') + '">' + have + '/' + mxpp + '</span>' +
              '</div>';
          }).join('') + '</div>' +
        '</div>' +

        evoRowHtml(mon, partySel) +
        formeRowHtml(mon) +

        '<div class="pd-actions">' +
          '<button class="btn-primary pd-train"><span class="ic-train"></span>Train Pokemon \u00b7 $' +
            SERVICE_PRICE.toLocaleString() + '</button>' +
          (partySel > 0 ? '<button class="btn-secondary pd-lead">Make lead</button>' : '') +
        '</div>' +
      '</div>';

    var close = host.querySelector('.pd-close');
    if (close) close.addEventListener('click', function () {
      overlay.hidden = true;
      partySel = -1;
      drawTeamStrip();
    });

    // Close when clicking the dark overlay background
    overlay.onclick = function (e) {
      if (e.target === overlay) {
        overlay.hidden = true;
        partySel = -1;
        drawTeamStrip();
      }
    };
    var take = host.querySelector('[data-take]');
    if (take) take.addEventListener('click', function () {
      N.addItem(run, mon.item, 1);
      toast('Took the ' + itemName(mon.item) + '.');
      mon.item = '';
      renderCrossroads(); saveGame();
    });
    var train = host.querySelector('.pd-train');
    if (train) train.addEventListener('click', function () {
      if (run.money < SERVICE_PRICE) { toast('Not enough money.'); return; }
      overlay.hidden = true;
      openTrainer(mon);
    });
    var lead = host.querySelector('.pd-lead');
    if (lead) lead.addEventListener('click', function () {
      run.party.unshift(run.party.splice(partySel, 1)[0]);
      partySel = 0;
      overlay.hidden = true;
      renderCrossroads(); saveGame();
    });
    host.querySelectorAll('.evo-btn').forEach(function (b) {
      b.addEventListener('click', function () {
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
  }

  // Items you own, shown above the shop. Tapping one uses/gives it.
  // The Bag: EVERYTHING you own, in one place above the shop -- balls,
  // medicine, evolution/forme/mega stones and held items, including the ones
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

    var GROUPS = [['ball', 'Poke Balls'], ['heal', 'Medicine'], ['held', 'Held Items'],
                  ['evo', 'Evolution Items'], ['forme', 'Forme Change'], ['mega', 'Mega Stones']];
    var html = '';
    GROUPS.forEach(function (g) {
      var mine = ids.filter(function (id) { return bagGroupOf(id) === g[0]; });
      if (!mine.length) return;
      html += '<div class="bag-group"><div class="bag-label">' + g[1] + '</div><div class="bag-items">';
      mine.forEach(function (id) {
        var e = entries[id];
        // one row per equipped copy, so you can see who is holding what
        e.holders.forEach(function (m) {
          html += '<button class="owned-item held" data-take="' + m.uid + '" data-tip="item:' + id + '">' +
            '<span class="oi-art">' + (window.ItemArt ? window.ItemArt.itemImg(id, 28) : '') + '</span>' +
            '<span class="oi-n">' + itemName(id) +
              '<em class="oi-who">' + m.name + '</em></span>' +
            '<span class="oi-q take">take</span>' +
            '</button>';
        });
        if (e.qty > 0) {
          html += '<button class="owned-item" data-item="' + id + '" data-tip="item:' + id + '">' +
            '<span class="oi-art">' + (window.ItemArt ? window.ItemArt.itemImg(id, 28) : '') + '</span>' +
            '<span class="oi-n">' + itemName(id) + '</span>' +
            '<span class="oi-q">x' + e.qty + '</span>' +
            '</button>';
        }
      });
      html += '</div></div>';
    });
    host.innerHTML = html;

    host.querySelectorAll('[data-item]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.dataset.item;
        if (C.BALLS[id]) { toast('Poke Balls are thrown during a battle.'); return; }
        useFromBag(id);
      });
    });
    // tapping an equipped item takes it back off that Pokemon
    host.querySelectorAll('[data-take]').forEach(function (b) {
      b.addEventListener('click', function () {
        var uid = b.dataset.take;
        var m = run.party.filter(function (x) { return String(x.uid) === String(uid); })[0];
        if (!m || !m.item) return;
        var was = m.item;
        N.addItem(run, was, 1);
        m.item = '';
        toast('Took the ' + itemName(was) + ' from ' + m.name + '.');
        renderCrossroads(); saveGame();
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
    var seed = $('menuSeed');
    if (seed) { seed.hidden = !run; seed.innerHTML = run ? 'Run seed: <b>' + run.seed + '</b>' : ''; }
    $('screenMenu').hidden = false;
  }
  function closeMenu() { $('screenMenu').hidden = true; }

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
  var pendingAvatar = null;
  function openAvatarPicker() {
    pendingAvatar = profile.avatar || 'red';
    var grid = $('avatarModalGrid');
    grid.innerHTML = AVATARS.map(function (id) { var label = id.replace(/^./, function (x) { return x.toUpperCase(); }); return '<button class="avatar-choice' + (id === pendingAvatar ? ' on' : '') + '" data-avatar="' + id + '" title="' + label + '" aria-label="' + label + '"><img loading="lazy" decoding="async" src="' + avatarUrl(id) + '" alt="" onerror="this.onerror=null;this.src=\'https://play.pokemonshowdown.com/sprites/trainers/red.png\'"></button>'; }).join('');
    grid.querySelectorAll('[data-avatar]').forEach(function (b) { b.onclick = function () { pendingAvatar = b.dataset.avatar; grid.querySelectorAll('.avatar-choice').forEach(function (x) { x.classList.toggle('on', x === b); }); }; });
    $('screenAvatarPicker').hidden = false;
  }
  function closeAvatarPicker() { $('screenAvatarPicker').hidden = true; }
  function applyTheme() { if (!profile) return; var choice = THEMES.filter(function (t) { return t.id === profile.theme; })[0] || THEMES[0]; profile.theme = choice.id; Object.keys(choice.p).forEach(function (k) { document.documentElement.style.setProperty(k, choice.p[k]); }); document.documentElement.style.setProperty('--cta', '#ffffff'); document.documentElement.style.setProperty('--cta-hi', '#ffffff'); document.documentElement.style.setProperty('--cta-text', '#080a12'); document.documentElement.style.setProperty('--title-ring', choice.id === 'default' ? '#ffffff' : (choice.p['--blue'] || '#ffffff')); }

  function updateMenuAvatar() { var e = $('menuAvatar'); if (e) e.innerHTML = '<img src="' + avatarUrl((profile && profile.avatar) || 'red') + '" alt="">'; }
  function showProfile() {
    closeMenu(); loadProfile(); applyTheme(); updateMenuAvatar();
    var shinies = profile.shinies.length, av = profile.avatar || 'red';
    var cur = run && !run.over ? '<div class="prof-now"><div class="pd-label">Current run</div><div class="prof-grid">' + statCard(run.battlesWon || 0, 'Battles won') + statCard('S' + (run.section || 1), 'Section') + statCard(run.caught || 0, 'Caught') + statCard('$' + (run.money || 0).toLocaleString(), 'Cash') + '</div></div>' : '<p class="hint center">No run in progress.</p>';
    $('profBody').innerHTML = '<div class="profile-hero"><div class="profile-avatar"><img src="' + avatarUrl(av) + '" alt="Avatar"></div><div style="flex:1"><div class="profile-name">Trainer Profile</div><div class="profile-sub">Customize your look and game theme</div></div><button id="editAvatar" class="btn-mini">Edit sprite</button></div>' +
      '' +
      '<div class="profile-section">Theme</div><div class="theme-grid">' + THEMES.map(function (t) { return '<button class="theme-choice' + (t.id === (profile.theme || 'default') ? ' on' : '') + '" data-theme="' + t.id + '" style="--theme-dot:' + t.dot + '"><span class="theme-dot"></span>' + t.name + '</button>'; }).join('') + '</div>' +
      '<div class="profile-section">Sound</div><div class="vol-group">' + volumeRow('music', 'Music', 'Battle themes') + volumeRow('sfx', 'Sound effects', 'Cries and battle sounds') + '</div>' +
      '<div class="profile-section">Career</div><div class="prof-grid big">' + statCard(profile.totalRuns, 'Runs played') + statCard(profile.bestBattles, 'Best battles') + statCard('S' + profile.bestSection, 'Furthest') + statCard(shinies, 'Shinies') + '</div>' + cur;
    $('editAvatar').onclick = openAvatarPicker;
    wireVolumeRows($('profBody'));
    // Full gallery is rendered only inside the dedicated sheet.
    $('profBody').querySelectorAll('[data-theme]').forEach(function (b) { b.onclick = function () { profile.theme = b.dataset.theme; saveProfile(); applyTheme(); showProfile(); }; });
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
        '<div class="sc-nm">' + sh.name + '</div>' +
        '<div class="sc-sp">' + sh.species + '</div>' +
        '<div class="types">' + typeChips(sh.types || []) + '</div>' +
        '<div class="sc-meta">' + (sh.how === 'starter' ? 'Starter' : 'Section ' + sh.section) +
          ' \u00b7 ' + when.toLocaleDateString() + '</div>' +
      '</div>';
    }).join('');
    show('Shinies');
  }

  function showRules() { closeMenu(); show('Rules'); }

  function showHistory() {
    closeMenu();
    loadProfile();
    var h = profile.history;
    if (!h.length) {
      $('histBody').innerHTML = '<p class="hint center">No finished runs yet. ' +
        'A run is recorded when your last Pokemon falls.</p>';
      show('History'); return;
    }
    $('histBody').innerHTML = h.map(function (r, i) {
      var d = new Date(r.at);
      return '<div class="hist-row">' +
        '<div class="hr-n">#' + (h.length - i) + '</div>' +
        '<div class="hr-main">' +
          '<div class="hr-top"><b>' + r.battles + ' battles</b>' +
            '<span class="hr-sec">Section ' + r.section + '</span></div>' +
          '<div class="hr-sub">' + r.caught + ' caught \u00b7 ' + r.trainers + ' trainers \u00b7 ' +
            d.toLocaleDateString() + '</div>' +
        '</div>' +
        (r.mvp ? '<div class="hr-mvp">' + animSprite(r.mvp.id, 40, 46, '', 1.45) +
                 '<span>' + r.mvp.name + '</span></div>' : '') +
      '</div>';
    }).join('');
    show('History');
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
    $('nickHint').textContent = 'Give it a name you will remember. It only gets one life.';
    $('screenNickname').hidden = false;
    setTimeout(function () { try { input.focus(); } catch (e) {} }, 60);
  }

  function confirmNickname() {
    var input = $('nickInput');
    var val = String(input.value || '').trim().replace(/\s+/g, ' ').slice(0, 12);
    if (!val) val = input.placeholder;           // never allow an empty name
    if (!val) { toast('Please enter a nickname.'); return; }
    $('screenNickname').hidden = true;
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
    // potion, instead of only being reachable from the party detail panel.
    var mode = (kind === 'heal') ? 'use'
             : (kind === 'evo' || kind === 'forme') ? 'evolve'
             : 'give';
    picker = { itemId: itemId, mode: mode, step: 'mon', mon: null };
    drawPicker();
    $('screenPicker').hidden = false;
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


  function closePicker() {
    picker = null;
    $('screenPicker').hidden = true;
  }

  function drawPicker() {
    if (!picker) return;
    var id = picker.itemId;
    var art = window.ItemArt ? window.ItemArt.itemImg(id, 40) : '';
    $('pickerTitle').innerHTML = art + '<span>' + itemName(id) + '</span>';

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
        '<div class="pick-info"><b>' + m.name + '</b>' +
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
    closePicker();
    if (t.kind === 'forme') { startFormeChange(mon, itemId, t.id); return; }
    startEvolution(mon, t.opt);
  }

  function applyPicked(mon, moveId) {
    var res = N.applyItem(run, picker.itemId, mon, moveId);
    toast(res.msg);
    closePicker();
    renderCrossroads(); saveGame();
  }

  // ------------------------------------------------------------ BATTLES ---
  function teardownBattleUI() {
    clearQueue();
    if (ui) { try { ui.unmount(); } catch (e) {} ui = null; }
    var h = $('battleHost'); if (h) h.innerHTML = '';
  }
  function ensureUI() {
    if (ui && !ui._disposed) return ui;
    var host = $('battleHost');
    if (!host) throw new Error('battle host element is missing');
    if (!window.BattleUI) throw new Error('battle renderer failed to load');
    host.innerHTML = '';
    host._bm = null;                    // clear any stale mount marker
    ui = new window.BattleUI(); ui.mount(host);
    return ui;
  }

  // Guards against a second battle being spun up while the first is still
  // rolling its team (double-tap on "Battle", or a stray keyboard activation).
  // Two concurrent runs of this used to fight over `bctx`/`battle` and leave
  // the screen wedged.
  var battleStarting = false;

  async function startNextBattle() {
    if (battleStarting) return;
    if (!N.alive(run).length) return gameOver();
    battleStarting = true;
    var isTrainer = N.nextIsTrainer(run);
    show('Battle');
    var u = ensureUI();
    u.setMsg('Loading\u2026');
    try {
      if (isTrainer) {
        var t = N.trainerFor(run);
        var team = await N.makeTrainerTeam(run, t);
        beginBattle({ enemies: team, isWild: false, trainer: t, catchable: false });
      } else {
        var isFirst = run.battleInSection === 0;
        var wildKey = run.section + ':' + run.battleInSection;
        var id = (run._nextWild && run._nextWild.key === wildKey) ? run._nextWild.id : N.pickWild(run, { dupesClause: isFirst });
        delete run._nextWild;
        var mon = await N.makeWild(run, id);
        run.encounterSeen = run.encounterSeen || isFirst;
        beginBattle({ enemies: [mon], isWild: true, catchable: isFirst && !run.catchUsedThisSection });
      }
    } catch (err) {
      // Anything in here (a bad species roll, the learnsets chunk failing to
      // download) used to reject silently and strand the player on an empty
      // battle screen. Surface it and offer a way out instead.
      console.error('[battle] failed to start', err);
      battleFailed(err);
    } finally {
      battleStarting = false;
    }
  }

  // Recoverable dead end: tell the player what happened and let them retry or
  // walk back to the crossroads with their run intact.
  function battleFailed(err) {
    teardownBattleUI();
    var host = $('battleHost');
    if (!host) return;
    host.innerHTML =
      '<div class="battle-error panel center">' +
      '<h2>Battle failed to load</h2>' +
      '<p class="hint">' + escapeHtml(err && err.message ? err.message : String(err || 'Unknown error')) + '</p>' +
      '<button class="btn-primary" id="btnBattleRetry">Try again</button>' +
      '<button class="btn-secondary" id="btnBattleBail">Back to route</button>' +
      '</div>';
    var retry = $('btnBattleRetry'), bail = $('btnBattleBail');
    if (retry) retry.addEventListener('click', function () { host.innerHTML = ''; startNextBattle(); });
    if (bail) bail.addEventListener('click', function () { host.innerHTML = ''; renderCrossroads(); show('Crossroads'); });
  }

  function beginBattle(cfg) {
    // lead = first non-fainted
    var lead = 0;
    for (var i = 0; i < run.party.length; i++) { if (!C.isFainted(run.party[i])) { lead = i; break; } }
    if (lead !== 0) run.party.unshift(run.party.splice(lead, 1)[0]);
    run.party.forEach(function (m) { N.trackMon(run, m); });

    bctx = { cfg: cfg, enemies: cfg.enemies, caught: false, ended: false };
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
        : ('Section ' + run.section + ' \u00b7 Trainer Battle \u00b7 ' + cfg.trainer.name),
      money: run.money
    });

    var p = run.party[0], e = cfg.enemies[0];
    u.setSpeciesLabels(speciesOf(p), cfg.isWild ? 'Wild ' + speciesOf(e) : speciesOf(e));
    u._catchEntrance = !!cfg.catchable;
    u.setupBattle({
      player: { name: p.name, lv: 100, types: p.types.slice(), hp: p.hpPct, max: 100, st: p.status || null,
                h: worldH(p.id), sid: Dex.species.get(p.id).spriteid || p.id, num: Dex.species.get(p.id).num,
                u: spriteUrls(p.id, true, p.shiny) },
      enemy: { name: e.name, lv: 100, types: e.types.slice(), hp: 1, max: 100, st: null,
               h: worldH(e.id), sid: Dex.species.get(e.id).spriteid || e.id, num: Dex.species.get(e.id).num,
               u: spriteUrls(e.id, false, e.shiny) },
      biomeSeed: run.seed + '|' + run.section + '|' + run.battleInSection,
      biomeTypes: e.types
    });
    if (!cfg.isWild) u.log(cfg.trainer.name + ' ' + cfg.trainer.tag);
    if (cfg.isWild && cfg.enemies[0] && cfg.enemies[0].shiny) {
      // A shiny outranks the ordinary catch banner: it is always catchable and
      // it can never break free, so say exactly that.
      u.log('A SHINY ' + speciesOf(cfg.enemies[0]).toUpperCase() + ' appeared!');
      showCatchBanner('\u2728 SHINY \u00b7 guaranteed catch \u00b7 any ball');
    } else if (cfg.catchable) {
      // The animated ball rail communicates the catch opportunity without a
      // second yellow banner covering the battlefield.
      u.log('A wild ' + speciesOf(cfg.enemies[0]) + ' appeared!');
    }
    u.setStatus('p', p.status || null);
    u.setStatus('e', null);

    battle = RB.startBattle({
      playerMons: run.party,
      enemyMons: cfg.enemies,
      isWild: cfg.isWild,
      trainerName: cfg.isWild ? 'Wild' : cfg.trainer.name,
      handlers: {
        onLog: handleLog,
        onRequest: handleRequest,
        onEnd: handleEnd,
        onDamage: function (amt, mon) {
          if (mon) run.damageDealt[mon.uid] = (run.damageDealt[mon.uid] || 0) + amt;
        },
        onKO: function (mon) {
          if (mon) run.knockouts[mon.uid] = (run.knockouts[mon.uid] || 0) + 1;
        },
        onError: function (e2) { console.error('[battle]', e2); }
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
  var atkSide = null, atkHit = false;

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
      case '-ability': case '-sidestart': case '-sideend': case '-singleturn':
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
  function step() {
    evTimer = null;
    if (!ui) { evQ.length = 0; return; }
    if (!evQ.length) {
      // queue drained -> now it is safe to hand control back to the player
      if (pendingRequest) { var r = pendingRequest; pendingRequest = null; renderRequest(r); }
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
      } else if (cmd === '-heal') {
        if (pct > 0) { ui.floatN(s2, pct, 'heal'); ui.flashHeal(s2); }
        say(who + ' restored HP' + (src ? ' with ' + src : '') + '!');
      }
    } else if (cmd === '-status') {
      ui.setStatus(sideOf(p[1]), p[2]);
      say(nameFromIdent(p[1]) + ' ' + statusVerb(p[2]) + '!');
    } else if (cmd === '-curestatus') {
      ui.setStatus(sideOf(p[1]), null);
      say(nameFromIdent(p[1]) + ' was cured of its ' + statusName(p[2]) + '!');
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
    } else if (cmd === 'switch' || cmd === 'drag' || cmd === 'replace') {
      var isP = sideOf(p[1]) === 'p';
      var sp = Dex.species.get((p[2] || '').split(',')[0].trim());
      if (sp.exists) {
        // Use the nickname the engine reports (which is our mon's .name),
        // falling back to the clean species name.
        var shown = nameFromIdent(p[1]) || C.cleanName(sp.id);
        // Shininess belongs to the individual, not the species: look up the
        // actual run object being sent out.
        var swMon = isP ? battle.activeMon() : (bctx && bctx.enemies && bctx.enemies[0]);
        var swShiny = !!(swMon && swMon.shiny);
        var pay = { name: shown, types: sp.types.slice(), h: worldH(sp.id),
                    sid: sp.spriteid || sp.id, num: sp.num, u: spriteUrls(sp.id, isP, swShiny) };
        if (isP) ui.setPlayer(pay); else ui.setEnemy(pay);
      }
      ui.setHp(isP ? 'p' : 'e', RB.parseHp(p[3]));
      // keep the species caption pointing at whoever is actually out
      if (sp.exists && ui.setSpeciesLabels) {
        var capt = C.cleanName(sp.id);
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
        var dfMon = dIsP ? battle.activeMon() : (bctx && bctx.enemies && bctx.enemies[0]);
        var dpay = { name: dsp.name, types: dsp.types.slice(), h: worldH(dsp.id),
                     sid: dsp.spriteid || dsp.id, num: dsp.num,
                     u: spriteUrls(dsp.id, dIsP, !!(dfMon && dfMon.shiny)) };
        if (dIsP) ui.setPlayer(dpay); else ui.setEnemy(dpay);
        // setPlayer/setEnemy treat a name+types update as "sprite only" and
        // skip their re-render, so the header would keep the old forme's name
        // and typing. Force the HUD to redraw.
        if (ui.render) ui.render();
        var mon2 = dIsP ? battle.activeMon() : null;
        if (mon2) { mon2.megaForme = dsp.id; mon2.types = dsp.types.slice(); }
      }
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
    if (req.wait) { ui.setMoves([], {}, null); return; }
    // While the intro is still flushing, render immediately so Fight/Bag/Ball
    // /Party are usable from the very first frame of the battle.
    if (!opening && (evQ.length || evTimer)) { pendingRequest = req; return; }
    renderRequest(req);
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
    var info = battle.enemyInfo();
    var foeTypes = info.types || ['Normal'];
    var moves = (req.active[0].moves || []).map(function (mv, idx) {
      var d = Dex.moves.get(mv.id || mv.move);
      return { id: d.id, name: d.name, type: d.type, power: d.basePower || 0,
               pp: mv.pp, max: mv.maxpp, disabled: !!mv.disabled,
               eff: d.category === 'Status' ? 1 : C.typeMod(d.type, foeTypes),
               _origIdx: idx };
    }).filter(function (m) { return m.id !== RB.IDLE_MOVE; });

    var mon = battle.activeMon();
    ui.setMsg('What will ' + (mon ? mon.name : 'your Pokemon') + ' do?');
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
    var wildShiny = bctx.cfg.isWild && bctx.enemies[0] && bctx.enemies[0].shiny;
    var canCatch = wildShiny || (bctx.cfg.catchable && !run.catchUsedThisSection);

    ui.setActions({
      itemCount: itemCount,
      canSwitch: canSwitch,
      // Fleeing always works, but only from a WILD battle -- a trainer will
      // not let you walk away. It costs you the battle's prize money.
      canRun: bctx.cfg.isWild,
      onBag: showBagPanel,
      onSwitch: function () { showPartyPanel(false); },
      onRun: fleeBattle
    });

    // Poke Balls are a floating rail on the right, only while the encounter
    // is actually catchable.
    if (canCatch && ballCount) buildBallRail();
    else ui.setBallRail(null);
  }

  // Running from a wild battle: it never fails, but you forfeit the reward.
  // The section still advances, so fleeing is a real escape valve when a
  // fight is going badly -- paid for in cash rather than in RNG.
  function fleeBattle() {
    if (!bctx || bctx.ended || !bctx.cfg.isWild) return;
    bctx.ended = true;
    bctx.fled = true;
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
        return '<div class="grave">' + iconEl(m.id, 1.1, '', m.shiny) + '<span>' + m.name + '</span></div>';
      }).join('') + '</div>';
    }
    if (missedCatch) {
      html += '<div class="miss-note"><b>Catch lost.</b> That was Section ' + run.section +
              '\u2019s only wild encounter.</div>';
    }
    html += '<p class="hint">Battles won: <b>' + run.battlesWon + '</b> \u00b7 Party: <b>' +
            run.party.length + '</b></p>';
    $('rewardBody').innerHTML = html;
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
      var pct = pctHP(m.hpPct);
      var hpCol = m.hpPct > 0.5 ? '#4ade80' : m.hpPct > 0.2 ? '#facc15' : '#ef4444';
      var cur = C.curHP(m), mx = C.maxHP(m);
      var stCol = statusColor(m.status);
      var stTxtCol = (m.status === 'par') ? '#000' : '#fff';
      // Build a detailed HTML blob for the battle switcher that mimics pd-card
      var html = '<div class="pd-hero" style="margin:0">' +
        '<div class="pd-art">' + bigSprite(m.id, '', 72, 72, 1, m.shiny) + '</div>' +
        '<div class="pd-id" style="min-width:0">' +
          '<div class="pd-species">' + speciesOf(m) + (m.shiny ? ' \u2728' : '') + '</div>' +
          '<div class="pd-name" style="font-size:1.1rem">' + m.name + '</div>' +
          '<div class="types" style="margin-top:2px">' + typeChips(m.types) + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="pd-hp" style="margin-top:8px">' +
        '<div class="hm-b big"><i style="width:' + pct + '%;background:' + hpCol + '"></i></div>' +
        '<span>' + cur + ' / ' + mx + (m.status ? ' \u00b7 ' + m.status.toUpperCase() : '') + '</span>' +
        (m.status ? '<span class="battle-st-badge" style="margin-left:6px;background:' + stCol + ';color:' + stTxtCol + ';padding:2px 6px;border-radius:999px;font-size:.62rem">' + m.status.toUpperCase() + '</span>' : '') +
      '</div>';
      return {
        name: m.name,
        species: speciesOf(m),
        hp: m.hpPct,
        fainted: C.isFainted(m),
        active: m === activeMon,
        status: m.status,
        statusColor: stCol,
        pct: pct,
        hpCol: hpCol,
        cur: cur,
        mx: mx,
        types: m.types.slice(),
        iconHtml: animSprite(m.id, 46, 52, '', 1.4, m.shiny),
        detailHtml: html,
        disabled: !ok
      };
    });
    ui.setPanel({
      type: 'party-rich', items: items,
      onPick: function (i) {
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
    Object.keys(run.bag).forEach(function (id) {
      if (!C.BALLS[id]) return;
      var shinyTgt = bctx.enemies[0] && bctx.enemies[0].shiny;
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
    var tgt = bctx.enemies[0];
    var res = (tgt && tgt.shiny)
      ? { caught: true, shakes: 4 }
      : C.rollCatch(ballId, info.id, info.hpPct, info.status,
          { turn: battle.state.turn, targetTypes: info.types }, run.rand);
    ballAnim(ballId, res.shakes, res.caught, function () {
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

  function onCaught() {
    battle.sync();
    var caught = bctx.enemies[0];
    var clone = JSON.parse(JSON.stringify(caught));
    clone.uid = 'c' + Date.now();
    // Keep EXACTLY the HP / PP / status it had at capture. Only guard against
    // a literal 0 (it was caught, so it can't join the party already fainted).
    if (clone.hpPct <= 0) clone.hpPct = 1 / Math.max(1, C.maxHP(clone));
    bctx.caught = true;
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
      '<h3 style="margin:0 0 8px 0;">' + clone.name + '</h3>' +
      '<div class="types" style="justify-content:center;">' + typeChips(clone.types) + '</div>' +
      '<div class="statline" style="margin:8px 0;font-size:1rem;">HP ' + pctHP(clone.hpPct) + '% \u00b7 Status ' + st + '</div>' +
      '<div class="ability" style="margin:6px 0;opacity:0.8;">' + clone.ability + '</div>' +
      '<div class="movelist">' + clone.moves.map(function (m) {
        var d = Dex.moves.get(m);
        return '<span class="mv-chip type-' + d.type + '">' + d.name + '</span>';
      }).join('') + '</div></div></div>' +
      '<p class="hint">It keeps the HP, PP and status it had when caught.</p>' +
      '<p class="reward-money">+$' + money + '</p>';

    var swap = $('catchSwap');
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
          return '<button class="swap-btn" data-i="' + i + '">' + iconEl(m.id, 1.2, '', m.shiny) + '<span>' + m.name + '</span>' +
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
    if (bctx.ended) return;
    if (res.result === 'caught') return;
    bctx.ended = true;
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
        var money = bctx.cfg.isWild ? N.wildReward(run) : N.trainerReward(run);
        var healed = false;
        if (!bctx.cfg.isWild) {
          run.trainersBeaten++;
          // Beating a trainer closes the section: the survivors are patched
          // up for free. (The fallen stay fallen -- healAll skips them.)
          healed = N.alive(run).some(function (m) { return m.hpPct < 1 || m.status; });
          N.healAll(run);
          if (healed) N.logMsg(run, 'Your team rested and recovered fully.');
        }
        run.money += money;
        var ss = run.sectionStats || (run.sectionStats = { money:0, won:0, caught:null, lost:[], damage:0, kos:0, startedAt:run.section });
        ss.money = (Number(ss.money) || 0) + (Number(money) || 0);
        ss.won = (Number(ss.won) || 0) + 1;
        dead.forEach(function (d) { ss.lost.push({ name: d.name, id: d.id, shiny: d.shiny }); });
        showReward(money, dead, false, missed, healed);
      } else {
        if (!N.alive(run).length) return gameOver();
        var ss2 = run.sectionStats || (run.sectionStats = { money:0, won:0, caught:null, lost:[], damage:0, kos:0, startedAt:run.section });
        dead.forEach(function (d) { ss2.lost.push({ name: d.name, id: d.id, shiny: d.shiny }); });
        showReward(0, dead, true, missed);
      }
    });
  }

  function showReward(money, dead, lost, missedCatch, healed) {
    show('Reward');
    $('rewardTitle').textContent = lost ? 'Defeated...' : 'Victory!';
    $('rewardTitle').className = 'scr-title' + (lost ? ' dead' : '');
    var html = '';
    if (money) html += '<p class="reward-money">+$' + money + '</p>';
    if (dead && dead.length) {
      html += '<div class="losses"><h4>Lost forever</h4>' + dead.map(function (m) {
        return '<div class="grave">' + iconEl(m.id, 1.1, '', m.shiny) + '<span>' + m.name + '</span></div>';
      }).join('') + '</div>';
    }
    if (missedCatch) {
      html += '<div class="miss-note"><b>Catch failed.</b> That was Section ' + run.section +
              '\u2019s only wild encounter \u2014 no new Pokemon this section.</div>';
    }
    if (healed) html += '<p class="reward-heal">Your team was fully restored.</p>';
    if (!money && (!dead || !dead.length) && !missedCatch && !healed) html += '<p class="hint">You live to fight on.</p>';
    html += '<p class="hint">Battles won: <b>' + run.battlesWon + '</b> \u00b7 Party: <b>' + run.party.length + '</b></p>';
    $('rewardBody').innerHTML = html;
    $('btnRewardDone').onclick = afterBattleAdvance;
    renderHud();
  }

  function afterBattleAdvance() {
    if (!N.alive(run).length) return gameOver();
    var finishedSection = run.section;
    var newSection = N.advanceBattle(run);
    martStock = null;             // fresh stock each stop
    run._shopSeq = (run._shopSeq || 0) + 1;
    saveGame();
    if (newSection) {
      showSectionSummary(finishedSection);
      return;
    }
    renderCrossroads(); show('Crossroads');
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
          '<div class="sum-who"><b>' + m.name + '</b><span>' + speciesOf(m) + '</span></div>' +
          '<div class="sum-hp"><i style="width:' + pct + '%;background:' + col + '"></i></div>' +
          '<span class="sum-pct">' + pct + '%</span></div>';
      }).join('');

    if (ss.lost.length) {
      $('sumLost').innerHTML = '<div class="sum-label bad">Lost forever</div>' +
        '<div class="sum-graves">' + ss.lost.map(function (g) {
          return '<div class="grave">' + iconEl(g.id, 1.1, '', g.shiny) + '<span>' + g.name + '</span></div>';
        }).join('') + '</div>';
      $('sumLost').hidden = false;
    } else {
      $('sumLost').hidden = true;
    }

    $('btnSumNext').textContent = 'Enter Section ' + run.section;
    show('Summary');
  }

  // ------------------------------------------------------------ GAME OVER --
  function gameOver() {
    if (run.over) return;          // never double-record a run
    run.over = true;
    recordRunEnd();
    var m = N.mvp(run);
    show('GameOver');
    $('goScore').innerHTML =
      '<div class="score-big">' + run.battlesWon + '</div><div class="score-lbl">battles won</div>' +
      '<p>Reached <b>Section ' + run.section + '</b> \u00b7 Trainers beaten <b>' + run.trainersBeaten + '</b> \u00b7 Caught <b>' + run.caught + '</b></p>';
    $('goMvp').innerHTML = m
      ? '<div class="mvp"><div class="mvp-tag">MVP</div>' +
        bigSprite(m.id, '', 104, 104, 1, m.shiny) +
        '<div><div class="sc-name">' + m.name + '</div>' +
        '<div class="statline">' + m.damage.toLocaleString() + ' total damage \u00b7 ' + m.kos + ' KOs</div>' +
        '<div class="hint">' + (m.survived ? 'Survived to the end.' : 'Fell in battle.') + '</div></div></div>'
      : '<p class="hint">No damage was dealt. Rough run.</p>';
    var ros = N.roster(run).sort(function (a, b) { return b.damage - a.damage; });
    $('goRoster').innerHTML = '<h3 class="sub-title">Roster</h3>' + ros.map(function (r) {
      return '<div class="ros-row' + (r.alive ? '' : ' dead') + '">' +
        iconEl(r.id, 1, '', r.shiny) +
        '<span class="ros-n">' + r.name + '</span>' +
        '<span class="ros-d">' + r.damage.toLocaleString() + ' dmg</span>' +
        '<span class="ros-s">' + (r.alive ? pctHP(r.hpPct) + '%' : 'S' + r.section) + '</span></div>';
    }).join('') + seedChip(run.seed);
    clearSave();
  }

  // ------------------------------------------------------- EVOLUTION ------
  function evoOptionByKey(mon, key) {
    var opts = window.Evo.optionsFor(mon);
    for (var i = 0; i < opts.length; i++) if (opts[i].id === key) return opts[i];
    return null;
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

  function startFormeChange(mon, itemId, formeId) {
    var fromId = mon.id;
    show('Evolve');
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
      // consume the item only on success
      var res = await window.Forme.applyForme(run, mon, formeId);
      if (res.ok) {
        run.bag[itemId]--; if (run.bag[itemId] <= 0) delete run.bag[itemId];
        stage.classList.remove('morphing');
        stage.classList.add('done');
        $('evoText').innerHTML = mon.name + ' became <b>' + res.to + '</b>!';
        N.logMsg(run, res.from + ' changed forme to ' + res.to + '.');
        if (mon.shiny) {
          recordShiny(mon, 'forme');
          toast('\u2728 Shiny ' + mon.name + ' (' + res.to + ') added to collection!');
        }
        try { playCry(mon.id); } catch (e) {}
      } else {
        stage.classList.remove('morphing');
        $('evoText').textContent = res.msg || 'Nothing happened.';
      }
      doneBtn.hidden = false; doneBtn.style.display = '';
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
    return '<div class="evo-box"><div class="evo-title">Evolution</div>' + rows + '</div>';
  }

  // Animated evolution: the classic white-out morph with a pulsing silhouette.
  function startEvolution(mon, opt) {
    var fromId = mon.id, fromName = mon.name;
    show('Evolve');
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
      if (res.ok) {
        $('evoText').innerHTML = res.renamed
          ? ('Congratulations! <b>' + res.to + '</b> evolved into a ' + res.species + '!')
          : ('Congratulations! Your ' + res.fromSpecies + ' evolved into <b>' + res.species + '</b>!');
        N.logMsg(run, res.to + ' evolved into ' + res.species + '!');
        if (mon.shiny) {
          recordShiny(mon, 'evolved');
          toast('\u2728 Shiny ' + mon.name + ' evolved into ' + res.species + '!');
        }
        try { playCry(opt.id); } catch (e) {}
      } else {
        $('evoText').textContent = res.msg || 'The evolution failed.';
      }
      doneBtn.hidden = false; doneBtn.style.display = '';
      renderHud(); saveGame();
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
  var SAVE_KEY = 'nuzlocke-run';
  var SAVE_VERSION = 2;

  // ---------------------------------------------------------- PROFILE ------
  // Everything that OUTLIVES a run: the shiny collection and the run history.
  // Deliberately a separate key from the run save, so abandoning a run (or a
  // save-format bump) can never wipe a collection built up over months.
  var PROFILE_KEY = 'nuzlocke-profile';
  var profile = null;

  function blankProfile() {
    return { __v: 1, shinies: [], history: [], totalRuns: 0, bestBattles: 0,
             bestSection: 0, totalCaught: 0, totalKOs: 0, avatar: 'red', theme: 'default' };
  }
  function loadProfile() {
    try {
      var raw = localStorage.getItem(PROFILE_KEY);
      profile = raw ? JSON.parse(raw) : blankProfile();
    } catch (e) { profile = blankProfile(); }
    // tolerate a partially-written or hand-edited profile
    var d = blankProfile();
    Object.keys(d).forEach(function (k) { if (profile[k] == null) profile[k] = d[k]; });
    if (!Array.isArray(profile.shinies)) profile.shinies = [];
    if (!Array.isArray(profile.history)) profile.history = [];
    return profile;
  }
  function saveProfile() {
    try { localStorage.setItem(PROFILE_KEY, JSON.stringify(profile)); }
    catch (e) { console.warn('profile', e); }
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
      seed: run.seed
    });
    // a long history is just noise; keep the most recent 50 runs
    if (profile.history.length > 50) profile.history.length = 50;
    saveProfile();
  }

  // Central serializer: snapshot the live run (minus the `rand` function
  // handle, which reviveRun() rebuilds deterministically) and persist it to
  // localStorage. Returns the snapshot so callers -- autosave AND the export
  // modal -- always work from exactly the same object.
  function saveGameState() {
    if (!run || run.over) return null;
    var c = { __v: SAVE_VERSION };
    Object.keys(run).forEach(function (k) { if (k !== 'rand') c[k] = run[k]; });
    try {
      if (run.rand && run.rand.getState) c.randState = run.rand.getState();
    } catch (e) {}
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(c)); }
    catch (e) { console.warn('save', e); }
    return c;
  }
  function saveGame() { saveGameState(); }

  function loadGame() {
    try {
      var raw = localStorage.getItem(SAVE_KEY);
      var fromLegacy = false;
      if (!raw) {
        raw = localStorage.getItem('nuzlocke-run-v1');
        fromLegacy = !!raw;
      }
      if (!raw) return null;
      var data = JSON.parse(raw);
      if (!data || !data.party) return null;
      var migrated = migrateSave(data);
      // Persist the migrated save under the NEW key before dropping the old
      // one -- loadGame() is called more than once (title render, then the
      // Continue click), and consuming the legacy key without rewriting it
      // made the second call find nothing.
      if (fromLegacy) {
        try {
          if (migrated) localStorage.setItem(SAVE_KEY, JSON.stringify(migrated));
          localStorage.removeItem('nuzlocke-run-v1');
        } catch (e) {}
      }
      return migrated;
    } catch (e) { return null; }
  }

  // Bring any older save up to the current schema.
  function migrateSave(d) {
    var v = d.__v || 1;
    // v1 -> v2: species split out from name; sectionStats / catchMissed added;
    // fainted Pokemon were not always buried.
    if (v < 2) {
      (d.party || []).forEach(function (m) {
        if (!m.species) m.species = C.cleanName(m.id);
        if (!m.name) m.name = m.species;
        if (m.pp == null) m.pp = {};
      });
      // a fainted Pokemon must never survive in the party
      d.graveyard = d.graveyard || [];
      for (var i = (d.party || []).length - 1; i >= 0; i--) {
        var mon = d.party[i];
        if (!mon || mon.hpPct > 0) continue;
        d.graveyard.push({ name: mon.name, id: mon.id, section: d.section || 1,
                           killedBy: 'a previous battle',
                           damage: Math.round((d.damageDealt || {})[mon.uid] || 0) });
        d.party.splice(i, 1);
      }
      if (d.catchMissed === undefined) d.catchMissed = false;
      if (d.lastCaughtName === undefined) d.lastCaughtName = null;
      if (!d.sectionStats) {
        d.sectionStats = { money: 0, won: 0, caught: null, lost: [],
                           damage: 0, kos: 0, startedAt: d.section || 1 };
      }
      d.__v = 2;
    }
    // a save with nothing left alive is not resumable
    if (!d.party || !d.party.length) return null;
    return d;
  }

  function clearSave() {
    try {
      localStorage.removeItem(SAVE_KEY);
      localStorage.removeItem('nuzlocke-run-v1');
    } catch (e) {}
  }

  function reviveRun(s) {
    var r = N.newRun(s.seed);
    Object.keys(s).forEach(function (k) { if (k !== '__v' && k !== 'randState') r[k] = s[k]; });
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
    r.party.forEach(function (m) {
      if (!m.species) m.species = C.cleanName(m.id);
      if (!m.name) m.name = m.species;
      if (!m.pp) m.pp = {};
      N.trackMon(r, m);
    });
    if (!r.sectionStats) N.resetSectionStats(r);
    // Ensure _nextWild is cleared so it will be recomputed deterministically
    // via pickWild (which is now hash-based, not rand-based) after refresh.
    if (r._nextWild) delete r._nextWild;
    return r;
  }

  // -------------------------------------------------- SAVE TRANSFER --------
  // Cross-device saves: the same snapshot saveGameState() writes is compressed
  // into a "Save Code" (src/savecode.js), shareable as text, link or QR.
  // Importing goes through the exact localStorage load path -- validate,
  // migrate, revive -- so a code can never smuggle in a state a normal save
  // could not represent.

  // Schema check for decoded save data. Returns null when usable, otherwise a
  // human-readable reason -- every invalid/corrupt/foreign code fails here
  // instead of crashing the run.
  function validateImportedSave(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return 'That does not look like a save from this game.';
    // tolerate numeric-string seeds from hand-edited codes
    if (typeof data.seed === 'string' && data.seed.trim() !== '' && isFinite(Number(data.seed))) data.seed = Number(data.seed);
    if (typeof data.seed !== 'number' || !isFinite(data.seed)) return 'The save data has no valid run seed.';
    if ((data.__v || 1) > SAVE_VERSION) return 'This save was made with a newer version of the game and cannot be loaded here.';
    if (!Array.isArray(data.party)) return 'The save data has no party information.';
    if (!data.party.length) return 'That run has no Pokemon left to continue with.';
    for (var i = 0; i < data.party.length; i++) {
      var m = data.party[i];
      if (!m || typeof m !== 'object' || typeof m.id !== 'string' || !m.id) return 'The save data has a corrupted party member.';
    }
    return null;
  }

  // Helper to merge imported shiny collection into profile
  function mergeShinies(imported) {
    if (!Array.isArray(imported) || !imported.length) return;
    loadProfile();
    var existing = profile.shinies || [];
    var seen = {};
    existing.forEach(function (s) { seen[s.id + '|' + s.at] = true; });
    imported.forEach(function (s) {
      if (!s || !s.id) return;
      var key = s.id + '|' + s.at;
      if (seen[key]) return;
      // basic sanitization
      existing.push({
        id: s.id,
        species: s.species || s.id,
        name: s.name || s.species || s.id,
        types: Array.isArray(s.types) ? s.types.slice() : [],
        how: s.how || 'imported',
        section: s.section || 0,
        at: s.at || Date.now()
      });
      seen[key] = true;
    });
    // keep newest first? profile stores chronological, showShinies reverses, so push is fine
    saveProfile();
  }

  // Apply a decoded save object: validate -> migrate -> revive -> persist.
  // Never throws; returns { ok: true } or { ok: false, error } for the UI.
  function loadGameState(saveData) {
    var err = validateImportedSave(saveData);
    if (err) return { ok: false, error: err };
    try {
      var migrated = migrateSave(saveData);
      if (!migrated) return { ok: false, error: 'That run has no Pokemon left to continue with.' };
      run = reviveRun(migrated);
      // Merge shiny collection if present in save code
      if (saveData._shiny || saveData._sh || saveData.shinies) {
        mergeShinies(saveData._shiny || saveData._sh || saveData.shinies);
      }
      // Restore avatar and theme if present in save code
      if (saveData._avatar || saveData._theme) {
        loadProfile();
        if (saveData._avatar) profile.avatar = saveData._avatar;
        if (saveData._theme) profile.theme = saveData._theme;
        saveProfile();
        applyTheme();
        updateMenuAvatar();
      }
      saveGame();                          // persist to THIS device's storage
      setContinueState();                  // title button reflects the import
      return { ok: true };
    } catch (e) {
      console.warn('import save', e);
      return { ok: false, error: 'The save data could not be read.' };
    }
  }

  // ---- EXPORT MODAL -------------------------------------------------------
  var saveShareUrl = '';       // share link backing the current export modal

  // The state a transfer should carry: the live run when one exists, else the
  // run parked in storage (so "Transfer save" works from the title's Menu).
  function exportSourceState() {
    if (run && !run.over) return saveGameState();
    return loadGame();
  }

  function openSaveExport() {
    var SC = window.SaveCode;
    if (!SC || !SC.enabled()) { toast('Save transfer is unavailable right now.'); return; }
    var snap = exportSourceState();
    if (!snap) { toast('No run in progress to save.'); return; }
    // The rolling battle log is never displayed, only bloats the QR payload.
    var slim = {};
    Object.keys(snap).forEach(function (k) { if (k !== 'log') slim[k] = snap[k]; });
    // Include shiny collection, avatar, and theme in the save code/link/QR
    try {
      loadProfile();
      if (profile) {
        if (profile.shinies && profile.shinies.length) {
          slim._shiny = profile.shinies;
        }
        if (profile.avatar) {
          slim._avatar = profile.avatar;
        }
        if (profile.theme) {
          slim._theme = profile.theme;
        }
      }
    } catch (e) {}
    var code = SC.encode(slim);
    if (!code) { toast('Could not create a save code.'); return; }
    saveShareUrl = SC.buildShareUrl(code);
    $('saveCodeOut').value = code;
    $('saveExportMsg').textContent = '';
    // The QR encodes the exact share URL so a phone camera opens it directly.
    var qrBox = $('saveQrBox'), qrNote = $('saveQrNote');
    var qr = SC.renderQR(qrBox, saveShareUrl);
    qrBox.hidden = !qr.ok;
    qrNote.hidden = qr.ok;
    if (!qr.ok) qrNote.textContent = qr.reason || 'QR code unavailable.';
    // Wire up Save QR button visibility
    var qrBtn = $('btnSaveQR');
    if (qrBtn) qrBtn.hidden = !qr.ok;
    $('screenSaveExport').hidden = false;
  }

  function closeSaveExport() { $('screenSaveExport').hidden = true; }

  function copyFeedback(btn, ok) {
    var old = btn.textContent;
    btn.textContent = ok ? 'Copied!' : 'Copy failed';
    setTimeout(function () { btn.textContent = old; }, 1600);
    $('saveExportMsg').textContent = ok ? 'Copied to clipboard!' : 'Copy failed \u2014 select the code above and copy it manually.';
    if (ok) toast('Copied to clipboard!');
    else { var ta = $('saveCodeOut'); ta.focus(); ta.select(); }
  }

  // ---- IMPORT MODAL -------------------------------------------------------
  function openSaveImport() {
    $('saveCodeIn').value = '';
    $('saveImportMsg').textContent = '';
    $('screenSaveImport').hidden = false;
    setTimeout(function () { $('saveCodeIn').focus(); }, 60);
  }
  function closeSaveImport() { $('screenSaveImport').hidden = true; }

  // Shared by the manual import box and the ?save= URL handler.
  function importFromText(text) {
    var SC = window.SaveCode;
    if (!SC || !SC.enabled()) return { ok: false, error: 'Save transfer is unavailable right now.' };
    var code = SC.extractCode(text);
    if (!code) return { ok: false, error: 'That does not look like a save code or link.' };
    var data = SC.decode(code);
    if (!data) return { ok: false, error: 'Save code invalid or corrupted!' };
    return loadGameState(data);
  }

  function performManualImport() {
    var res = importFromText($('saveCodeIn').value);
    if (!res.ok) { $('saveImportMsg').textContent = res.error; return; }
    closeSaveImport();
    closeMenu();
    toast('Save loaded! Section ' + run.section + ', ' + run.party.length + ' Pokemon.');
    // Jump straight into the imported run.
    renderCrossroads(); show('Crossroads');
  }

  // ---- URL AUTO-IMPORT -----------------------------------------------------
  // A share link (or scanned QR) opens the game with ?save=CODE. Called from
  // boot() before the title renders so the Continue button reflects it.
  function applySaveFromUrl() {
    var SC = window.SaveCode;
    if (!SC || !SC.enabled()) return;
    var code = SC.readCodeFromUrl();
    if (!code) return;
    // Remove the param FIRST (even on failure) so refreshing the page never
    // re-applies or re-prompts for the same code.
    SC.stripCodeFromUrl();
    var data = SC.decode(code);
    if (!data) { toast('Save link invalid or corrupted.'); return; }
    var err = validateImportedSave(data);
    if (err) { toast(err); return; }
    // Never silently destroy a run already in progress on this device.
    var existing = loadGame();
    if (existing) {
      var same = existing.seed === data.seed && existing.battlesWon === data.battlesWon;
      if (!same && !confirm('This link will replace your current run (Section ' +
          (existing.section || 1) + ') with the shared run (Section ' + (data.section || 1) + '). Continue?')) {
        toast('Import cancelled \u2014 your current run is safe.');
        return;
      }
    }
    var res = loadGameState(data);
    toast(res.ok
      ? 'Save imported! Section ' + run.section + ' \u00b7 tap Continue to play.'
      : res.error);
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
  function boot() {
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
    // A ?save=CODE link/QR applies the save before the title renders, so the
    // Continue button it paints already describes the imported run.
    applySaveFromUrl();
    initTitle();

    // Warm the learnsets chunk while the player is still on the title screen.
    // It's only *needed* at the first roll of a moveset, but fetching it now
    // means that roll is instant instead of a 2.9 MB stall in front of the
    // first battle. Failure here is non-fatal: legalMoves() awaits it again.
    if (window.PS && window.PS.learnsetsReady) {
      window.PS.learnsetsReady().catch(function (e) {
        console.warn('[boot] learnsets prefetch failed; will retry on demand', e);
      });
    }

    $('btnGoBattle').addEventListener('click', startNextBattle);
    $('btnTutorBack').addEventListener('click', function () {
      svc = null; renderCrossroads(); show('Crossroads');
    });
    // "Save progress" lives on every battle/section finish screen.
    $('btnRewardSave').addEventListener('click', openSaveExport);
    $('btnCatchSave').addEventListener('click', openSaveExport);
    $('btnSumSave').addEventListener('click', openSaveExport);
    // Export + import modals (Save Codes / links / QR).
    $('btnSaveExportClose').addEventListener('click', closeSaveExport);
    $('screenSaveExport').addEventListener('click', function (e) {
      if (e.target === $('screenSaveExport')) closeSaveExport();
    });
    $('btnCopyCode').addEventListener('click', function () {
      window.SaveCode.copyText($('saveCodeOut').value)
        .then(function (ok) { copyFeedback($('btnCopyCode'), ok); });
    });
    $('btnCopyLink').addEventListener('click', function () {
      window.SaveCode.copyText(saveShareUrl)
        .then(function (ok) { copyFeedback($('btnCopyLink'), ok); });
    });
    var qrSaveBtn = $('btnSaveQR');
    if (qrSaveBtn) qrSaveBtn.addEventListener('click', function () {
      try {
        var box = $('saveQrBox');
        if (!box) { toast('No QR to save.'); return; }
        var canvas = box.querySelector('canvas');
        var dataUrl = '';
        if (canvas && canvas.toDataURL) {
          dataUrl = canvas.toDataURL('image/png');
        } else {
          // qrcodejs fallback renders a table: rasterize via temporary canvas
          // Create a simple canvas from table is complex, so fallback to copying link
          var img = box.querySelector('img');
          if (img && img.src) dataUrl = img.src;
        }
        if (!dataUrl) { toast('QR image not ready.'); return; }
        var a = document.createElement('a');
        a.href = dataUrl;
        a.download = 'dailylocke-qr.png';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        toast('QR image saved!');
      } catch (e) {
        console.warn('save qr', e);
        toast('Could not save QR image.');
      }
    });
    $('btnSaveImportClose').addEventListener('click', closeSaveImport);
    $('screenSaveImport').addEventListener('click', function (e) {
      if (e.target === $('screenSaveImport')) closeSaveImport();
    });
    $('btnImportLoad').addEventListener('click', performManualImport);
    $('saveCodeIn').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); performManualImport(); }
    });
    $('btnCatchDone').addEventListener('click', afterBattleAdvance);
    $('btnEvoDone').addEventListener('click', function () {
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
    $('btnAvatarCancel').addEventListener('click', closeAvatarPicker);
    $('btnAvatarSave').addEventListener('click', function () { if (pendingAvatar) { profile.avatar = pendingAvatar; saveProfile(); updateMenuAvatar(); } closeAvatarPicker(); showProfile(); });
    $('screenAvatarPicker').addEventListener('click', function (e) { if (e.target === $('screenAvatarPicker')) closeAvatarPicker(); });
    $('btnPickerCancel').addEventListener('click', closePicker);
    $('screenPicker').addEventListener('click', function (e) {
      if (e.target === $('screenPicker')) closePicker();
    });
    $('btnGoTitle').addEventListener('click', function () { show('Title'); setContinueState(); });
    $('btnMenu').addEventListener('click', openMenu);
    $('btnMenuClose').addEventListener('click', closeMenu);
    $('screenMenu').addEventListener('click', function (e) {
      if (e.target === $('screenMenu')) closeMenu();
    });
    $('btnMenuProfile').addEventListener('click', showProfile);
    $('btnMenuShinies').addEventListener('click', showShinies);
    $('btnMenuHistory').addEventListener('click', showHistory);
    $('btnMenuRules').addEventListener('click', showRules);
    $('btnMenuTransfer').addEventListener('click', function () { closeMenu(); openSaveExport(); });
    $('btnMenuImport').addEventListener('click', function () { closeMenu(); openSaveImport(); });
    $('btnRulesBack').addEventListener('click', backToRoute);
    $('btnMenuQuit').addEventListener('click', function () {
      if (confirm('Abandon this run? Your team is lost.')) {
        closeMenu(); clearSave(); run = null; show('Title'); setContinueState();
      }
    });
    $('btnProfBack').addEventListener('click', backToRoute);
    $('btnShinyBack').addEventListener('click', backToRoute);
    $('btnHistBack').addEventListener('click', backToRoute);
    show('Title');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.Game = { get run() { return run; }, show: show, startNextBattle: startNextBattle,
                  redrawRoute: renderCrossroads, toast: toast,
                  // the live 3D battle UI, for debugging field effects
                  get ui() { return ui; } };

  // ---------------------------------------------------------------- AUDIO --
  // Music is owned by src/audio.js. It plays only while a battle is on screen
  // and is started by beginBattle()/stopped by show(), so nothing here needs
  // to poll or observe the DOM.
})();
