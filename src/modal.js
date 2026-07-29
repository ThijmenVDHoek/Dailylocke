// ============================================================================
// modal.js — ONE modal controller for every overlay in the game.
//
// Before this existed each overlay did its own `el.hidden = false`, which meant
// no dialog semantics, no focus management, and a screen-reader user could tab
// straight out of an "open" dialog into the page behind it.
//
// This implements the WAI-ARIA Authoring Practices modal dialog pattern:
//   * role="dialog" + aria-modal="true" on the dialog card
//   * focus moves INTO the dialog on open
//   * Tab / Shift+Tab are trapped inside it
//   * Escape closes (unless the caller opts out)
//   * focus returns to whatever opened it
//   * the rest of the page is marked inert / aria-hidden
//
// Usage:
//   Modal.open('screenMenu', { onClose: fn, initialFocus: el, escape: false })
//   Modal.close('screenMenu')
//   Modal.isOpen('screenMenu')
//
// Overlays stack (the item picker can open above the crossroads sheet), so the
// controller keeps a stack and only restores page inertness when it empties.
// ============================================================================
(function () {
  var stack = [];        // [{ id, el, card, opener, onClose, escape, prevLabels }]

  function $(id) { return document.getElementById(id); }

  // Everything that is NOT the open dialog gets hidden from assistive tech.
  // `inert` is the modern one-liner; aria-hidden is the fallback for browsers
  // that don't have it yet (and is harmless where they do).
  //
  // The overlays are NOT direct children of <body> -- most of them live inside
  // <main>. So marking body's children inert would mark the dialog's own
  // ancestor inert, and inert is inherited: the dialog itself would go dead
  // and become unclickable. Instead, walk from the dialog UP to <body> and at
  // each level mark only the SIBLINGS, never the ancestor on the path.
  function backgroundNodes(exceptEl) {
    var out = [];
    var body = document.body;
    if (!body || !exceptEl) return out;
    var node = exceptEl;
    while (node && node !== body && node.parentElement) {
      var parent = node.parentElement;
      for (var i = 0; i < parent.children.length; i++) {
        var sib = parent.children[i];
        if (sib === node) continue;
        if (sib.tagName === 'SCRIPT' || sib.tagName === 'TEMPLATE') continue;
        out.push(sib);
      }
      node = parent;
    }
    return out;
  }

  function setBackgroundInert(exceptEl, on) {
    backgroundNodes(exceptEl).forEach(function (node) {
      if (on) {
        // Remember whether the node was ALREADY inert/aria-hidden so closing
        // one modal above another doesn't un-hide the page.
        if (node.__mdlPrev === undefined) {
          node.__mdlPrev = { inert: !!node.inert, aria: node.getAttribute('aria-hidden') };
        }
        try { node.inert = true; } catch (e) {}
        node.setAttribute('aria-hidden', 'true');
      } else {
        var prev = node.__mdlPrev;
        if (!prev) return;
        try { node.inert = prev.inert; } catch (e) {}
        if (prev.aria === null) node.removeAttribute('aria-hidden');
        else node.setAttribute('aria-hidden', prev.aria);
        delete node.__mdlPrev;
      }
    });
  }

  var FOCUSABLE = [
    'a[href]', 'button:not([disabled])', 'input:not([disabled])',
    'select:not([disabled])', 'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])'
  ].join(',');

  function focusables(root) {
    if (!root) return [];
    var all = root.querySelectorAll(FOCUSABLE);
    var out = [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.hidden || el.closest('[hidden]')) continue;
      // offsetParent is null for display:none; JSDOM has no layout so treat a
      // missing value as visible rather than skipping every control.
      if (el.offsetParent === null && el.style && el.style.display === 'none') continue;
      out.push(el);
    }
    return out;
  }

  // The dialog card is the inner panel, not the full-screen scrim: putting
  // role="dialog" on the scrim would make the backdrop part of the dialog.
  function cardOf(el) {
    return el.querySelector('.overlay-card, [data-modal-card]') || el;
  }

  function top() { return stack.length ? stack[stack.length - 1] : null; }

  function onKeydown(e) {
    var entry = top();
    if (!entry) return;
    if (e.key === 'Escape' && entry.escape) {
      e.preventDefault();
      close(entry.id);
      return;
    }
    if (e.key !== 'Tab') return;
    var items = focusables(entry.card);
    if (!items.length) { e.preventDefault(); entry.card.focus(); return; }
    var first = items[0], last = items[items.length - 1];
    var active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || !entry.card.contains(active)) { e.preventDefault(); last.focus(); }
    } else if (active === last || !entry.card.contains(active)) {
      e.preventDefault(); first.focus();
    }
  }

  // A click that lands on the scrim (never on the card) dismisses, matching
  // what every overlay in the game already did by hand.
  function onScrimClick(e) {
    var entry = top();
    if (!entry || !entry.dismissOnScrim) return;
    if (e.target === entry.el) close(entry.id);
  }

  function open(id, opts) {
    opts = opts || {};
    var el = typeof id === 'string' ? $(id) : id;
    if (!el) return null;
    var key = el.id || String(id);
    if (isOpen(key)) return el;

    var card = cardOf(el);
    card.setAttribute('role', opts.role || 'dialog');
    card.setAttribute('aria-modal', 'true');
    if (!card.hasAttribute('tabindex')) card.setAttribute('tabindex', '-1');
    // Label the dialog from its own heading when the markup didn't already.
    if (!card.getAttribute('aria-labelledby') && !card.getAttribute('aria-label')) {
      var h = card.querySelector('h1, h2, h3, h4, .picker-title');
      if (h) {
        if (!h.id) h.id = key + '__title';
        card.setAttribute('aria-labelledby', h.id);
      } else if (opts.label) {
        card.setAttribute('aria-label', opts.label);
      }
    }

    var entry = {
      id: key, el: el, card: card,
      opener: opts.opener || document.activeElement,
      onClose: opts.onClose || null,
      escape: opts.escape !== false,
      dismissOnScrim: opts.dismissOnScrim !== false
    };

    // Only the FIRST modal freezes the page; nested ones sit above it.
    if (!stack.length) {
      setBackgroundInert(el, true);
      document.addEventListener('keydown', onKeydown, true);
      if (document.body) document.body.classList.add('modal-open');
    } else {
      // The modal below must stop being reachable by Tab.
      var below = top();
      try { below.card.inert = true; } catch (e) {}
    }

    stack.push(entry);
    el.hidden = false;
    el.addEventListener('click', onScrimClick);

    // Focus AFTER unhiding, and let layout settle first: an <input> inside a
    // freshly-shown overlay isn't focusable in the same frame on iOS.
    var target = opts.initialFocus ||
      card.querySelector('[data-autofocus]') ||
      focusables(card)[0] || card;
    setTimeout(function () {
      try { target.focus({ preventScroll: true }); }
      catch (e) { try { target.focus(); } catch (e2) {} }
    }, 0);

    return el;
  }

  function close(id) {
    var key = typeof id === 'string' ? id : (id && id.id);
    var idx = -1;
    for (var i = stack.length - 1; i >= 0; i--) if (stack[i].id === key) { idx = i; break; }
    if (idx < 0) {
      // Closing something that was opened the old way should still hide it.
      var el0 = typeof id === 'string' ? $(id) : id;
      if (el0) el0.hidden = true;
      return;
    }
    var entry = stack.splice(idx, 1)[0];
    entry.el.hidden = true;
    entry.el.removeEventListener('click', onScrimClick);
    entry.card.removeAttribute('aria-modal');

    if (!stack.length) {
      setBackgroundInert(entry.el, false);
      document.removeEventListener('keydown', onKeydown, true);
      if (document.body) document.body.classList.remove('modal-open');
    } else {
      var below = top();
      try { below.card.inert = false; } catch (e) {}
    }

    // Restore focus to the control that opened the dialog, but never to
    // something that has since been hidden or removed.
    var back = entry.opener;
    if (back && back.isConnected && !back.closest('[hidden]')) {
      setTimeout(function () { try { back.focus({ preventScroll: true }); } catch (e) {} }, 0);
    } else if (stack.length) {
      var t = top();
      setTimeout(function () { try { t.card.focus({ preventScroll: true }); } catch (e) {} }, 0);
    }

    if (entry.onClose) { try { entry.onClose(); } catch (e) { console.warn('[modal] onClose', e); } }
  }

  function closeAll() {
    while (stack.length) close(stack[stack.length - 1].id);
  }

  function isOpen(id) {
    var key = typeof id === 'string' ? id : (id && id.id);
    for (var i = 0; i < stack.length; i++) if (stack[i].id === key) return true;
    return false;
  }

  window.Modal = {
    open: open, close: close, closeAll: closeAll, isOpen: isOpen,
    get depth() { return stack.length; },
    // exposed for the smoke test
    _focusables: focusables
  };
})();
