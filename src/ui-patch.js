// ============================================================================
// ui-patch.js — extends the vendored BattleUI with a roguelike action bar
// (Fight / Bag / Ball / Switch / Run) plus a top-bar rewrite for run info.
// Loaded AFTER battle-ui.js. Non-destructive: wraps render().
// ============================================================================
(function () {
  if (!window.BattleUI) { console.error('[ui-patch] BattleUI missing'); return; }
  var BU = window.BattleUI;

  // Nicknames are player input (and can arrive via an imported backup), so any
  // name interpolated into panel HTML must be escaped at the renderer too, not
  // just at the call site.
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // extra styles
  var css = [
    // Action bar + panels, matched to the vendor HUD's frosted-glass language.
    '.battle-hud .actbar{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:8px 0 0;width:100%;}',
    '.battle-hud .actbar.three{grid-template-columns:repeat(3,1fr);}',
    '.battle-hud .actbar.two{grid-template-columns:repeat(2,1fr);}',
    '.battle-hud .actbar.one{grid-template-columns:repeat(1,1fr);}',
    '.battle-hud .ab{padding:11px 0;border-radius:.85rem;border:none;background:rgba(255,255,255,.16);color:#fff;',
      'cursor:pointer;font-family:inherit;font-size:1rem;letter-spacing:.6px;text-transform:uppercase;',
      'backdrop-filter:blur(14px) saturate(1.3);-webkit-backdrop-filter:blur(14px) saturate(1.3);',
      'transition:transform .1s,background-color .15s;box-shadow:0 4px 16px rgba(0,0,0,.28);',
      'text-shadow:0 1px 4px rgba(0,0,0,.55);}',
    '.battle-hud .ab:hover:not(:disabled){background:rgba(255,255,255,.3);transform:translateY(-2px);}',
    '.battle-hud .ab:active:not(:disabled){transform:translateY(0) scale(.98);}',
    '.battle-hud .ab:disabled{opacity:.32;cursor:not-allowed;}',
    '.battle-hud .ab.on{background:rgba(255,255,255,.42);}',
    '.battle-hud .ab .sub{display:block;font-size:.7rem;opacity:.75;letter-spacing:0;text-transform:none;}',
    '.battle-hud .plist{display:grid;grid-template-columns:1fr 1fr;gap:8px;}',
    '.battle-hud .pitem{display:flex;align-items:center;gap:9px;padding:10px 12px;border-radius:.85rem;border:none;',
      'background:rgba(255,255,255,.16);color:#fff;cursor:pointer;font-family:inherit;text-align:left;',
      'backdrop-filter:blur(14px) saturate(1.3);-webkit-backdrop-filter:blur(14px) saturate(1.3);',
      'box-shadow:0 4px 16px rgba(0,0,0,.28);transition:transform .1s,background-color .15s;}',
    '.battle-hud .pitem:hover:not(:disabled){background:rgba(255,255,255,.3);transform:translateY(-2px);}',
    '.battle-hud .pitem:disabled{opacity:.36;cursor:not-allowed;}',
    '.battle-hud .pitem img{width:34px;height:34px;object-fit:contain;image-rendering:auto;}',
    '.battle-hud .pitem .anim-mon{flex:0 0 auto;}',
    '.battle-hud .pitem .pi-n{font-size:.95rem;line-height:1.15;}',
    '.battle-hud .pitem .pi-h{font-size:.72rem;opacity:.8;}',
    '.battle-hud .pitem .qty{opacity:.7;font-size:.82rem;}',
    '.battle-hud .pitem .pi-r{font-size:1rem;color:#ffd76e;white-space:nowrap;margin-left:6px;}',
    '.battle-hud .ptitle{font-size:.85rem;letter-spacing:1.2px;text-transform:uppercase;opacity:.8;',
      'margin:0 2px 8px;color:#fff;text-shadow:0 2px 8px rgba(0,0,0,.9);}',
    '.battle-hud .pbar{height:5px;border-radius:999px;background:rgba(0,0,0,.45);margin-top:4px;overflow:hidden;}',
    '.battle-hud .pbar i{display:block;height:100%;border-radius:999px;}',
    '.battle-hud .bg-back{display:block;width:100%;margin-top:0;}',
    '.battle-hud .runinfo{display:flex;gap:12px;align-items:center;font-size:.95rem;}',
    '.battle-hud .runinfo b{color:#ffd76e;}',
    // --- floating ball rail (right edge, thumb reachable) ---
    '.battle-hud .ballrail{position:absolute;left:10px;top:50%;transform:translateY(-50%);',
      'display:flex;flex-direction:column;gap:9px;align-items:center;pointer-events:auto;z-index:5;}',
    '.battle-hud .ballrail.catch-enter{animation:ballRailAppear .68s cubic-bezier(.18,1.35,.35,1) both;transform-origin:left center;}',
    '@keyframes ballRailAppear{0%{opacity:0;transform:translate(-110px,-50%) scale(.72)}62%{opacity:1;transform:translate(5px,-50%) scale(1.05)}100%{opacity:1;transform:translate(0,-50%) scale(1)}}',
    '.battle-hud .ballrail.catch-enter .br-btn{animation:ballButtonFloat .7s ease-out both;}',
    '.battle-hud .ballrail.catch-enter .br-btn:nth-of-type(2){animation-delay:.09s;}',
    '.battle-hud .ballrail.catch-enter .br-btn:nth-of-type(3){animation-delay:.18s;}',
    '@keyframes ballButtonFloat{0%{opacity:0;transform:translateY(18px) scale(.55)}100%{opacity:1;transform:translateY(0) scale(1)}}',
    '.battle-hud .br-label{font-size:.62rem;letter-spacing:1.6px;text-transform:uppercase;',
      'color:rgba(255,255,255,.75);text-shadow:0 2px 8px rgba(0,0,0,.9);margin-bottom:1px;}',
    '.battle-hud .br-btn{position:relative;width:56px;height:56px;border:none;border-radius:50%;cursor:pointer;',
      'background:rgba(255,255,255,.17);backdrop-filter:blur(14px) saturate(1.35);',
      '-webkit-backdrop-filter:blur(14px) saturate(1.35);box-shadow:0 6px 20px rgba(0,0,0,.4);',
      'display:flex;align-items:center;justify-content:center;font-family:inherit;',
      'transition:transform .12s cubic-bezier(.2,.8,.3,1),background-color .15s;}',
    '.battle-hud .br-btn:hover:not(:disabled){background:rgba(255,255,255,.3);transform:scale(1.08);}',
    '.battle-hud .br-btn:active:not(:disabled){transform:scale(.95);}',
    '.battle-hud .br-btn:disabled{opacity:.35;cursor:not-allowed;}',
    '.battle-hud .br-art{display:flex;align-items:center;justify-content:center;}',
    '.battle-hud .br-qty{position:absolute;top:-3px;right:-3px;min-width:19px;height:19px;',
      'border-radius:999px;background:#1b2036;color:#fff;font-size:.68rem;line-height:19px;',
      'text-align:center;padding:0 4px;box-shadow:0 2px 8px rgba(0,0,0,.5);}',
    '.battle-hud .br-odds{position:absolute;bottom:-7px;left:50%;transform:translateX(-50%);',
      'font-size:.62rem;color:#ffd76e;background:rgba(10,13,24,.85);padding:1px 6px;border-radius:999px;',
      'white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.5);}',
    '.battle-hud .pitem.rich{display:flex;flex-direction:column;align-items:stretch;gap:6px;padding:12px 12px;}',
    '.battle-hud .pitem.rich .pd-hero{display:flex;align-items:center;gap:10px;}',
    '.battle-hud .pitem.rich .pd-art{flex:0 0 auto;width:64px;display:flex;justify-content:center;}',
    '.battle-hud .pitem.rich .pd-id{flex:1;min-width:0;}',
    '.battle-hud .pitem.rich .pd-species{font-size:.7rem;color:rgba(255,255,255,.6);text-transform:uppercase;letter-spacing:1px;}',
    '.battle-hud .pitem.rich .pd-name{font-size:1.05rem;color:#fff;line-height:1.1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    // Grid-style party switcher (matches overview team strip)
    // Full-width grid + full-width back button stacked vertically.
    // The battle log above already says \"Send out which Pokemon?\" so no extra title is shown.
    '.battle-hud .mv:has(.party-grid),.battle-hud .mv:has(.switch-panel){display:flex !important;flex-direction:column;width:100% !important;gap:8px;grid-template-columns:1fr !important;}',
    '.battle-hud .switch-panel{display:flex;flex-direction:column;gap:8px;width:100%;grid-column:1/-1;}',
    '.battle-hud .party-grid{display:grid;grid-template-columns:repeat(6,1fr);gap:6px;width:100%;grid-column:1/-1;margin-top:0;}',
    '.battle-hud .party-grid .tslot{position:relative;display:flex;flex-direction:column;align-items:center;gap:3px;',
      'overflow:visible;padding:8px 3px 7px;border-radius:var(--r-md,8px);min-width:0;',
      'background:rgba(255,255,255,.16);color:#fff;box-shadow:0 4px 16px rgba(0,0,0,.28);',
      'backdrop-filter:blur(14px) saturate(1.3);-webkit-backdrop-filter:blur(14px) saturate(1.3);',
      'transition:background-color .15s,transform .12s,box-shadow .15s;border:none;cursor:pointer;font-family:inherit;}',
    '.battle-hud .party-grid .tslot:hover:not(:disabled):not(.empty){background:rgba(255,255,255,.3);transform:translateY(-2px);}',
    '.battle-hud .party-grid .tslot:disabled{opacity:.36;cursor:not-allowed;}',
    '.battle-hud .party-grid .tslot.active{box-shadow:0 0 0 2px #ffd76e,0 4px 16px rgba(0,0,0,.28);}',
    '.battle-hud .party-grid .ts-art{height:46px;display:flex;align-items:flex-end;justify-content:center;overflow:visible;}',
    '.battle-hud .party-grid .ts-name{font-size:.66rem;color:#fff;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '.battle-hud .party-grid .ts-bar{display:block;width:88%;height:3px;border-radius:999px;background:rgba(0,0,0,.5);overflow:hidden;}',
    '.battle-hud .party-grid .ts-bar i{display:block;height:100%;border-radius:999px;}',
    '.battle-hud .party-grid .ts-lead{position:absolute;top:-4px;left:50%;transform:translateX(-50%);',
      'font-size:.48rem;letter-spacing:.6px;padding:1px 5px;border-radius:999px;background:#ffd76e;color:#241a00;}',
    '.battle-hud .party-grid .ts-st{position:absolute;top:4px;right:3px;font-size:.48rem;',
      'padding:0 3px;border-radius:999px;background:#888;color:#fff;}',
    '.battle-hud .switch-panel .bg-back{width:100% !important;grid-column:1/-1;}',
    '.battle-hud .switch-panel .plist{width:100%;grid-column:1/-1;}',
    '.battle-hud .party-grid .ts-st.st-brn{background:#ff5f6d;color:#fff;}',
    '.battle-hud .party-grid .ts-st.st-psn{background:#a855f7;color:#fff;}',
    '.battle-hud .party-grid .ts-st.st-tox{background:#9333ea;color:#fff;}',
    '.battle-hud .party-grid .ts-st.st-par{background:#facc15;color:#000;}',
    '.battle-hud .party-grid .ts-st.st-slp{background:#a2aac4;color:#000;}',
    '.battle-hud .party-grid .ts-st.st-frz{background:#7dd3fc;color:#000;}',
    '.battle-hud .types{margin-top:2px;display:flex;gap:4px;flex-wrap:wrap;}',
    '.battle-hud .type{font-size:.58rem;padding:2px 6px;border-radius:999px;color:#fff;text-transform:uppercase;}',
    '.battle-hud .hm-b.big{height:7px;background:rgba(0,0,0,.45);border-radius:999px;overflow:hidden;flex:1;}',
    '.battle-hud .hm-b.big i{display:block;height:100%;border-radius:999px;}',
    '.battle-hud .pd-hp{display:flex;align-items:center;gap:8px;font-size:.78rem;color:rgba(255,255,255,.8);}',
    '.battle-hud .battle-st-badge{font-size:.62rem;padding:2px 6px;border-radius:999px;}',
    '.battle-hud .pd-moves{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;}',
    '.battle-hud .pd-moves .mv-chip{font-size:.62rem;padding:2px 6px;border-radius:999px;color:#fff;}'
  ].join('');
  var st = document.createElement('style');
  st.textContent = css;
  document.head.appendChild(st);

  // ---- LET THE BALL ANIMATION OWN THE ENEMY SPRITE ----------------------
  // _projectSprites() rewrites the sprite's left/top/width/height/transform
  // every frame, which would stomp on the "shrink into the ball" animation.
  // While _ballHidingEnemy is set we let the projection run (so the position
  // stays correct) but re-apply our own transform/opacity afterwards.
  var _origProject = BU.prototype._projectSprites;
  BU.prototype._projectSprites = function (t, dt) {
    _origProject.call(this, t, dt);
    if (!this._ballHidingEnemy) return;
    try {
      var img = this.s && this.s.e && this.s.e.img;
      if (!img) return;
      img.style.transformOrigin = '50% 100%';
      img.style.transform = 'scale(0.05)';
      img.style.opacity = '0';
      // Also shrink the ground shadow disc to zero
      var sh = this.s.e.sh;
      if (sh) { sh.material.opacity = 0; sh.scale.set(0, 0, 1); }
    } catch (e) {}
  };

  // ---- HP PERCENT DISPLAY ------------------------------------------------
  // A Pokemon with 1 HP out of 651 rounds to 0%, which reads as "already
  // fainted". Anything still alive must show at least 1%.
  function hpPct(frac) {
    if (frac <= 0) return 0;
    return Math.max(1, Math.round(frac * 100));
  }
  BU.prototype.hpPctText = hpPct;

  // setHp writes the number straight into the DOM, so wrap it.
  var _origSetHp = BU.prototype.setHp;
  BU.prototype.setHp = function (si, f) {
    _origSetHp.call(this, si, f);
    try {
      var key = this._rs(si);
      var s = this.s[key];
      var d = this._dom;
      if (!s || !d) return;
      var pct = hpPct(s.hp);
      if (d[key + '-hp']) d[key + '-hp'].style.width = pct + '%';
      if (d[key + '-hn']) d[key + '-hn'].textContent = pct + '%';
    } catch (e) {}
  };

  // --- new state fields ---
  var _origRender = BU.prototype.render;

  var _origSetMoves = BU.prototype.setMoves;
  BU.prototype.setMoves = function (mv, mg, cb) {
    // a new decision point -> forget any stale Mega selection
    if (!mg || !(mg.cm || mg.cx || mg.cy)) this._megaPick = null;
    return _origSetMoves.call(this, mv, mg, cb);
  };

  // biomeKey is now handled by calling buildBiome directly after
  // setupBattle in app.js, avoiding conflicts with _whenMounted.

  BU.prototype.setActions = function (cfg) {
    // cfg: {onFight,onBag,onBall,onSwitch,onRun, canRun, noBag, noRun, ballCount, itemCount, mode}
    this.s.act = cfg || null;
    this.render();
  };
  BU.prototype.setPanel = function (panel) {
    // panel: null | {type:'party', items:[{name,hp,fainted,active,sid,num,disabled}], onPick, onBack}
    this.s.panel = panel || null;
    this.render();
  };
  BU.prototype.setRunInfo = function (info) { this.s.runinfo = info || null; this.render(); };

  // Replace the hardcoded "Your Pokemon" / "Wild Pokemon" captions with the
  // real species, so a nicknamed Pokemon still shows what it actually is.
  // Pass null to leave one side unchanged.
  BU.prototype.setSpeciesLabels = function (playerSpecies, enemySpecies) {
    if (playerSpecies != null) this._pSpecies = playerSpecies;
    if (enemySpecies != null) this._eSpecies = enemySpecies;
    this.render();
  };

  // Poke Balls live on a floating rail at the right edge instead of inside the
  // action menu -- one tap to throw, and the odds are always visible.
  // balls: [{id, name, qty, chance, img, onPick}]
  BU.prototype.setBallRail = function (balls) {
    this.s.balls = balls && balls.length ? balls : null;
    this.render();
  };

  BU.prototype.render = function () {
    // Showcase mode: projected Pokemon over the 3D biome, with no HUD. The
    // title uses it; the shared renderer still paints the scenery underneath.
    if (this.showcase) { if (this.hud) this.hud.innerHTML = ''; return; }
    _origRender.call(this);
    if (!this.hud) return;
    var self = this;

    // re-apply the "never show 0% while alive" rule after a full re-render
    try {
      ['p', 'e'].forEach(function (k) {
        var st = self.s[k]; if (!st) return;
        var pct = hpPct(st.hp);
        var bar = self.hud.querySelector('.' + k + '-hp');
        var num = self.hud.querySelector('.' + k + '-hn');
        if (bar) bar.style.width = pct + '%';
        if (num) num.textContent = pct + '%';
      });
    } catch (e) {}

    // ---- keep the Mega toggle sticky --------------------------------------
    // The vendor render() recreates its internal `megaM` every call, so any
    // HP/message update wiped the player's Mega selection. We mirror the
    // choice on the instance and re-bind the buttons + move handler.
    if (this.s.mega && (this.s.mega.cm || this.s.mega.cx || this.s.mega.cy)) {
      var mgBtns = this.hud.querySelectorAll('.mg');
      if (mgBtns.length) {
        Array.prototype.forEach.call(mgBtns, function (btn) {
          var key = btn.dataset.m;
          if (self._megaPick === key) btn.classList.add('ac');
          else btn.classList.remove('ac');
          var clone = btn.cloneNode(true);
          btn.parentNode.replaceChild(clone, btn);
          clone.addEventListener('click', function () {
            self._megaPick = (self._megaPick === key) ? null : key;
            Array.prototype.forEach.call(self.hud.querySelectorAll('.mg'), function (x) {
              x.classList.toggle('ac', x.dataset.m === self._megaPick);
            });
          });
        });
        // rebind move buttons so they read the persisted choice
        var mbs = this.hud.querySelectorAll('.mb');
        Array.prototype.forEach.call(mbs, function (btn) {
          var clone = btn.cloneNode(true);
          btn.parentNode.replaceChild(clone, btn);
          clone.addEventListener('click', function () {
            if (self.s.locked) return;
            var i = parseInt(clone.dataset.i, 10);
            if (isNaN(i)) return;
            self.s.locked = true;
            Array.prototype.forEach.call(self.hud.querySelectorAll('.mb'), function (x) { x.disabled = true; });
            var pick = self._megaPick;
            self._megaPick = null;
            if (self.s.onMove) self.s.onMove({ moveIndex: i, mega: pick });
          });
        });
      }
    }
    var bb = this.hud.querySelector('.bb');
    var mv = this.hud.querySelector('.mv');
    if (!bb || !mv) return;

    // ---- top bar: replace with run info ----
    if (this.s.runinfo) {
      var tc = this.hud.querySelector('.topbar .tc');
      var sc = this.hud.querySelector('.topbar .sc');
      var ri = this.s.runinfo;
      if (tc) tc.innerHTML = '<div class="runinfo"><span>' + (ri.left || '') + '</span></div>';
      // money == null means the mode has no cash at all (Team Gauntlet) --
      // leave the whole right cell empty instead of showing a fake "$0".
      if (sc) {
        if (ri.money == null && ri.row == null) sc.innerHTML = '';
        else sc.innerHTML = '<div class="runinfo">' +
          (ri.money != null ? '<span>$<b>' + ri.money + '</b></span>' : '') +
          (ri.row != null ? '<span>Route <b>' + ri.row + '/' + (ri.rows || 14) + '</b></span>' : '') + '</div>';
      }
    }

    // ---- sub-panel (party switch list) replaces the move grid ----
    if (this.s.panel && (this.s.panel.type === 'party' || this.s.panel.type === 'party-rich' || this.s.panel.type === 'list')) {
      var p = this.s.panel;
      var isList = p.type === 'list';
      var isRich = p.type === 'party-rich';
      var html = '';
      // Only show title for list and party panels, NOT for party-rich (battle switcher)
      if (p.title && !isRich) html += '<div class="ptitle">' + esc(p.title) + '</div>';
      
      // Use grid layout for party-rich (battle switcher) to match overview
      // Layout requirement: grid fills width of container, back button below grid and also fills width.
      // No extra text – the battle log above is sufficient.
      if (isRich) {
        html += '<div class="switch-panel"><div class="party-grid">';
        for (var i = 0; i < p.items.length; i++) {
          var it = p.items[i];
          var st = it.status || '';
          var pct = it.pct != null ? it.pct : Math.round((it.hp||0)*100);
          var col = it.hpCol || (it.hp > 0.5 ? '#4ade80' : it.hp > 0.2 ? '#facc15' : '#ef4444');
          var classes = 'tslot';
          if (it.active) classes += ' active';
          if (it.fainted) classes += ' empty';
          html += '<button class="' + classes + '" data-i="' + i + '"' +
            (it.tutorial ? ' data-tutorial="switch"' : '') +
            (it.disabled ? ' disabled' : '') + '>';
          if (i === 0 && !it.fainted) html += '<span class="ts-lead">LEAD</span>';
          if (st && !it.fainted) html += '<span class="ts-st st-' + st + '">' + st.toUpperCase() + '</span>';
          html += '<span class="ts-art">' + (it.iconHtml || '') + '</span>';
          html += '<span class="ts-name">' + esc(it.name) + '</span>';
          if (!it.fainted) {
            html += '<span class="ts-bar"><i style="width:' + pct + '%;background:' + col + '"></i></span>';
          }
          html += '</button>';
        }
        html += '</div><button class="ab bg-back">Back</button></div>';
      } else {
        html += '<div class="switch-panel"><div class="plist">';
        for (var itemIndex = 0; itemIndex < p.items.length; itemIndex++) {
          var item = p.items[itemIndex];
          if (isList) {
            // simple item row: name + qty + note (no HP bar)
            html += '<button class="pitem" data-i="' + itemIndex + '"' + (item.disabled ? ' disabled' : '') + '>' +
              '<div style="flex:1;min-width:0">' +
                '<div class="pi-n">' + esc(item.name) + (item.qty ? ' <span class="qty">x' + item.qty + '</span>' : '') + '</div>' +
                (item.note ? '<div class="pi-h">' + esc(item.note) + '</div>' : '') +
              '</div>' +
              (item.right ? '<span class="pi-r">' + esc(item.right) + '</span>' : '') +
              '</button>';
          } else {
            var hpColor = item.hp > 0.5 ? '#4ade80' : item.hp > 0.2 ? '#facc15' : '#ef4444';
            // status color mapping for legacy party panel
            var stm = { brn: '#ff5f6d', psn: '#a855f7', tox: '#9333ea', par: '#facc15', slp: '#a2aac4', frz: '#7dd3fc' };
            var statusColor = item.status ? (stm[item.status] || '#ff5f6d') : '';
            var stTxtC = (item.status === 'par') ? '#000' : '#fff';
            var badge = item.status ? '<span style="margin-left:6px;background:' + statusColor + ';color:' + stTxtC + ';padding:1px 5px;border-radius:999px;font-size:.6rem">' + item.status.toUpperCase() + '</span>' : '';
            html += '<button class="pitem" data-i="' + itemIndex + '"' + (item.disabled ? ' disabled' : '') + '>' +
              (item.iconHtml ? item.iconHtml
                            : (item.icon ? '<img src="' + item.icon + '" alt="">' : '')) +
              '<div style="flex:1;min-width:0">' +
                '<div class="pi-n">' + esc(item.name) + (item.active ? ' <span style="opacity:.7">(out)</span>' : '') + '</div>' +
                '<div class="pi-h">' + (item.fainted ? 'Fainted' : Math.round(item.hp * 100) + '%' + (item.status ? ' ' : '')) + badge + '</div>' +
                '<div class="pbar"><i style="width:' + Math.round(item.hp * 100) + '%;background:' + hpColor + '"></i></div>' +
              '</div></button>';
          }
        }
        html += '</div><button class="ab bg-back">Back</button></div>';
      }
      mv.innerHTML = html;
      mv.querySelectorAll('.pitem, .tslot').forEach(function (b) {
        b.addEventListener('click', function () {
          var idx = parseInt(b.dataset.i, 10);
          if (p.onPick) p.onPick(idx);
        });
      });
      var bk = mv.querySelector('.bg-back');
      if (bk) bk.addEventListener('click', function () { if (p.onBack) p.onBack(); });
      return;
    }

    // ---- inspectable move buttons (hover / long-press) ----
    try {
      var moveButtons = this.hud.querySelectorAll('.mb');
      for (var mi2 = 0; mi2 < moveButtons.length; mi2++) {
        var idx2 = parseInt(moveButtons[mi2].dataset.i, 10);
        var mv2 = this.s.moves[idx2];
        if (mv2 && mv2.id) moveButtons[mi2].setAttribute('data-tip', 'move:' + mv2.id);
      }
    } catch (e) {}

    // ---- species captions over the nicknames ----
    try {
      if (this._pSpecies) {
        var pl = this.hud.querySelector('.pc .pl');
        if (pl) pl.textContent = this._pSpecies;
      }
      if (this._eSpecies) {
        var el2 = this.hud.querySelector('.ec .pl');
        if (el2) el2.textContent = this._eSpecies;
      }
    } catch (e) {}

    // ---- action bar above the moves (no Ball button -- see the rail) ----
    if (this.s.act) {
      var a = this.s.act;
      var bar = document.createElement('div');
      var dis = this.s.locked ? ' disabled' : '';
      // The Gauntlet has no items and no escape, so the Bag and Run buttons
      // themselves are dropped there rather than shown as dead controls.
      var btns = '', cols = 3;
      if (!a.noBag) btns += '<button class="ab" data-a="bag"' + dis + '>Bag<span class="sub">' + (a.itemCount || 0) + ' items</span></button>';
      else cols--;
      btns += '<button class="ab" data-a="switch"' + dis + (a.canSwitch ? '' : ' disabled') + '>Party<span class="sub">switch</span></button>';
      if (!a.noRun) btns += '<button class="ab" data-a="run"' + dis + (a.canRun ? '' : ' disabled') + '>Run<span class="sub">' + (a.canRun ? 'flee' : 'no') + '</span></button>';
      else cols--;
      bar.className = 'actbar ' + ['one', 'one', 'two', 'three'][Math.max(cols, 1)];
      bar.innerHTML = btns;
      // BELOW the move grid: attacks are the primary action, utilities secondary.
      bb.appendChild(bar);
      bar.querySelectorAll('.ab').forEach(function (b) {
        b.addEventListener('click', function () {
          if (self.s.locked) return;
          var k = b.dataset.a;
          if (k === 'bag' && a.onBag) a.onBag();
          else if (k === 'switch' && a.onSwitch) a.onSwitch();
          else if (k === 'run' && a.onRun) a.onRun();
        });
      });
    }

    // ---- floating Poke Ball rail ----
    if (this.s.balls && !this.s.panel) {
      var rail = document.createElement('div');
      rail.className = 'ballrail' + (this._catchEntrance ? ' catch-enter' : '');
      this._catchEntrance = false;
      rail.innerHTML =
        '<div class="br-label">Catch</div>' +
        this.s.balls.map(function (b2, i) {
          return '<button class="br-btn" data-i="' + i + '" data-ball="' + esc(b2.id || '') + '"' + (self.s.locked ? ' disabled' : '') + '>' +
            '<span class="br-art">' + (b2.img || '') + '</span>' +
            '<span class="br-qty">' + b2.qty + '</span>' +
            '<span class="br-odds">' + b2.chance + '%</span>' +
            '</button>';
        }).join('');
      this.hud.querySelector('.col').appendChild(rail);
      rail.querySelectorAll('.br-btn').forEach(function (b3) {
        b3.addEventListener('click', function () {
          if (self.s.locked) return;
          var entry = self.s.balls[+b3.dataset.i];
          if (entry && entry.onPick) entry.onPick(entry.id);
        });
      });
    }
  };
})();
