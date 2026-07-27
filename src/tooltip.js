// ============================================================================
// tooltip.js — inspect moves / abilities / items.
//
// Desktop : hover (and keyboard focus) shows a popover.
// Mobile  : press-and-hold ~380ms shows it; it closes on release or tap-away.
//
// Usage: put data-tip="move:icebeam" (or ability:/item:/text:) on any element.
// The lookup is lazy so this stays cheap for long lists.
// ============================================================================
(function () {
  var Dex = window.PS.Dex;

  var el = null;          // the popover node
  var holdTimer = null;
  var current = null;     // element the tip belongs to
  var HOLD_MS = 380;

  function ensureEl() {
    if (el) return el;
    el = document.createElement('div');
    el.className = 'tip';
    el.setAttribute('role', 'tooltip');
    el.hidden = true;
    document.body.appendChild(el);
    return el;
  }

  // ---- content builders ---------------------------------------------------
  function typeChip(t) { return '<span class="type type-' + t + '">' + t + '</span>'; }

  function moveTip(id) {
    var m = Dex.moves.get(id);
    if (!m.exists) return null;
    var acc = m.accuracy === true ? '\u2014' : m.accuracy + '%';
    var pow = m.category === 'Status' ? '\u2014' : m.basePower;
    var body = m.desc || m.shortDesc || '';
    var extra = [];
    if (m.priority > 0) extra.push('Priority +' + m.priority);
    if (m.priority < 0) extra.push('Priority ' + m.priority);
    if (m.flags && m.flags.contact) extra.push('Contact');
    if (m.flags && m.flags.sound) extra.push('Sound');
    if (m.flags && m.flags.bullet) extra.push('Bullet');
    if (m.flags && m.flags.punch) extra.push('Punch');
    if (m.recoil) extra.push('Recoil');
    if (m.drain) extra.push('Drain');
    return '<div class="tip-head">' + typeChip(m.type) +
             '<span class="tip-name">' + m.name + '</span>' +
             '<span class="tip-cat">' + m.category + '</span></div>' +
           '<div class="tip-stats"><span>Power <b>' + pow + '</b></span>' +
             '<span>Acc <b>' + acc + '</b></span>' +
             '<span>PP <b>' + m.pp + '</b></span></div>' +
           (body ? '<div class="tip-body">' + body + '</div>' : '') +
           (extra.length ? '<div class="tip-tags">' + extra.map(function (x) {
             return '<span>' + x + '</span>'; }).join('') + '</div>' : '');
  }

  function abilityTip(name) {
    var a = Dex.abilities.get(name);
    if (!a.exists) return null;
    return '<div class="tip-head"><span class="tip-kind ability">Ability</span>' +
             '<span class="tip-name">' + a.name + '</span></div>' +
           '<div class="tip-body">' + (a.desc || a.shortDesc || 'No description.') + '</div>';
  }

  function itemTip(id) {
    // our invented items first, then Showdown's
    var custom = null;
    if (window.Evo && window.Evo.CUSTOM_ITEMS[id]) custom = window.Evo.CUSTOM_ITEMS[id];
    if (window.Core && window.Core.BALLS[id]) custom = window.Core.BALLS[id];
    if (window.Core && window.Core.HEAL_ITEMS[id]) custom = window.Core.HEAL_ITEMS[id];
    if (window.Forme && window.Forme.CUSTOM[id]) custom = window.Forme.CUSTOM[id];
    var art = window.ItemArt ? window.ItemArt.itemImg(id, 26) : '';
    if (custom) {
      return '<div class="tip-head">' + art +
               '<span class="tip-name">' + custom.name + '</span></div>' +
             '<div class="tip-body">' + (custom.desc || '') + '</div>';
    }
    var it = Dex.items.get(id);
    if (!it.exists) return null;
    return '<div class="tip-head">' + art +
             '<span class="tip-name">' + it.name + '</span></div>' +
           '<div class="tip-body">' + (it.desc || it.shortDesc || 'No description.') + '</div>';
  }

  function buildHtml(spec) {
    var i = String(spec).indexOf(':');
    if (i < 0) return null;
    var kind = spec.slice(0, i), val = spec.slice(i + 1);
    if (!val) return null;
    if (kind === 'move') return moveTip(val);
    if (kind === 'ability') return abilityTip(val);
    if (kind === 'item') return itemTip(val);
    if (kind === 'text') return '<div class="tip-body">' + val + '</div>';
    return null;
  }

  // ---- positioning --------------------------------------------------------
  function place(target) {
    var t = ensureEl();
    var r = target.getBoundingClientRect();
    t.hidden = false;
    t.style.left = '0px'; t.style.top = '0px';   // measure unclamped
    var tw = t.offsetWidth, th = t.offsetHeight;
    var pad = 8;
    var left = r.left + r.width / 2 - tw / 2;
    left = Math.max(pad, Math.min(left, window.innerWidth - tw - pad));
    var top = r.top - th - 10;
    t.classList.remove('below');
    if (top < pad) { top = r.bottom + 10; t.classList.add('below'); }
    t.style.left = Math.round(left) + 'px';
    t.style.top = Math.round(top) + 'px';
  }

  function show(target) {
    var spec = target.getAttribute('data-tip');
    if (!spec) return;
    var html = buildHtml(spec);
    if (!html) return;
    var t = ensureEl();
    t.innerHTML = html;
    current = target;
    place(target);
    requestAnimationFrame(function () { t.classList.add('on'); });
  }

  function hide() {
    clearTimeout(holdTimer); holdTimer = null;
    current = null;
    if (!el) return;
    el.classList.remove('on');
    // keep it out of the layout once faded
    setTimeout(function () { if (!current && el) el.hidden = true; }, 140);
  }

  function findTip(node) {
    while (node && node !== document.body) {
      if (node.getAttribute && node.getAttribute('data-tip')) return node;
      node = node.parentNode;
    }
    return null;
  }

  // ---- events (delegated, so dynamic content just works) -----------------
  // Desktop hover/focus only
  document.addEventListener('mouseover', function (e) {
    if ('ontouchstart' in window) return; // skip on touch devices
    var t = findTip(e.target);
    if (!t || t === current) return;
    show(t);
  });
  document.addEventListener('mouseout', function (e) {
    if ('ontouchstart' in window) return;
    var t = findTip(e.target);
    if (t && t === current) hide();
  });
  document.addEventListener('focusin', function (e) {
    if ('ontouchstart' in window) return;
    var t = findTip(e.target);
    if (t) show(t);
  });
  document.addEventListener('focusout', hide);

  // Mobile: ONLY show on press-and-hold (never on normal tap)
  document.addEventListener('touchstart', function (e) {
    var t = findTip(e.target);
    if (!t) { hide(); return; }
    clearTimeout(holdTimer);
    holdTimer = setTimeout(function () {
      show(t);
      t.dataset.tipHeld = '1';
    }, HOLD_MS);
  }, { passive: true });

  function endTouch(e) {
    clearTimeout(holdTimer); holdTimer = null;
    var t = findTip(e.target);
    if (t && t.dataset.tipHeld) {
      delete t.dataset.tipHeld;
      // swallow the immediate click that follows a long-press
      var swallow = function (ev) { ev.stopPropagation(); ev.preventDefault(); };
      t.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(function () { t.removeEventListener('click', swallow, true); }, 350);
    }
    hide();
  }
  document.addEventListener('touchend', endTouch);
  document.addEventListener('touchcancel', endTouch);
  document.addEventListener('touchmove', function () { clearTimeout(holdTimer); }, { passive: true });

  window.addEventListener('scroll', function () { if (current) hide(); }, true);

  window.Tip = { show: show, hide: hide };
})();
