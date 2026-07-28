// ============================================================================
// evolution.js — evolution items, requirement resolution and evolving.
//
// Showdown stores evolution data on the CHILD species:
//   evoType : undefined(level) | useItem | trade | levelFriendship | levelMove
//             | levelHold | levelExtra | other
//   evoItem : "Fire Stone" etc.
//   evoLevel / evoMove / evoCondition
//
// We turn every one of those into "consume one shop item":
//   level-up family      -> Rare Candy
//   trade family         -> Link Cable (+ the held item it also needs)
//   useItem / levelHold  -> that exact item
//   friendship           -> Soothe Bell
//   levelMove / other    -> Rare Candy (with the condition shown as flavour)
// ============================================================================
(function () {
  var Dex = window.PS.Dex;
  var toID = window.PS.toID;
  var C = window.Core;

  // ---- custom items that don't exist in the Showdown item Dex -------------
  var CUSTOM_ITEMS = {
    linkcable:  { name: 'Link Cable',  price: 2500,
                  desc: 'Evolves Pokemon that would normally evolve by trading.' },
    rarecandy:  { name: 'Rare Candy',  price: 3000,
                  desc: 'Instantly evolves a Pokemon that evolves by leveling up.' },
    soothebell: { name: 'Soothe Bell', price: 2000,
                  desc: 'Evolves Pokemon that need high friendship.' },
    peatblock:  { name: 'Peat Block',  price: 3000,
                  desc: 'A block of peat soaked in moonlight. Evolves Ursaring.' }
  };

  function itemExists(id) { return !!CUSTOM_ITEMS[id] || Dex.items.get(id).exists; }
  function itemName(id) {
    if (CUSTOM_ITEMS[id]) return CUSTOM_ITEMS[id].name;
    var it = Dex.items.get(id);
    return it.exists ? it.name : id;
  }
  function itemDesc(id) {
    if (CUSTOM_ITEMS[id]) return CUSTOM_ITEMS[id].desc;
    var it = Dex.items.get(id);
    return (it.desc || it.shortDesc || '');
  }
  function itemPrice(id) {
    if (CUSTOM_ITEMS[id]) return CUSTOM_ITEMS[id].price;
    var p = C.itemPrice(id);
    return p || 3000;
  }

  // ---- which item does a given evolution need? ---------------------------
  // Returns { item, label, note } or null when we can't support it.
  function requirementFor(childSpecies) {
    var ev = childSpecies;
    var type = ev.evoType || 'levelup';
    var held = ev.evoItem ? toID(ev.evoItem) : null;

    if (type === 'useItem') {
      if (!held || !itemExists(held)) return null;
      return { item: held, label: itemName(held), note: 'Use ' + itemName(held) };
    }
    if (type === 'levelHold') {
      // e.g. Gligar + Razor Fang. We treat the hold item as the trigger.
      if (!held || !itemExists(held)) return null;
      return { item: held, label: itemName(held), note: 'Level up holding ' + itemName(held) };
    }
    if (type === 'trade') {
      // Trade evolutions that ALSO need a held item are triggered by that item
      // alone -- Scyther + Metal Coat is enough, no Link Cable required.
      // Only plain trade evolutions (Machoke, Haunter, ...) need the cable.
      if (held && itemExists(held)) {
        return { item: held, label: itemName(held),
                 note: 'Trade holding ' + itemName(held) };
      }
      return { item: 'linkcable', label: 'Link Cable', note: 'Evolves by trading' };
    }
    if (type === 'levelFriendship') {
      return { item: 'soothebell', label: 'Soothe Bell', note: 'Evolves with high friendship' };
    }
    if (type === 'levelMove') {
      var mv = ev.evoMove ? Dex.moves.get(ev.evoMove) : null;
      return { item: 'rarecandy', label: 'Rare Candy',
               note: 'Level up knowing ' + (mv && mv.exists ? mv.name : ev.evoMove) };
    }
    if (type === 'other') {
      // Ursaluna specifically wants a Peat Block; everything else we allow
      // with a Rare Candy and just show the real condition as flavour.
      var cond = ev.evoCondition || '';
      if (/peat block/i.test(cond)) {
        return { item: 'peatblock', label: 'Peat Block', note: cond };
      }
      return { item: 'rarecandy', label: 'Rare Candy', note: cond || 'Special condition' };
    }
    // plain level-up (and levelExtra)
    var lv = ev.evoLevel ? (' (Lv ' + ev.evoLevel + ')') : '';
    return { item: 'rarecandy', label: 'Rare Candy', note: 'Evolves by leveling up' + lv };
  }

  // All evolutions available to a mon, with their requirement.
  // [{ id, name, types, requirement, sprite }]
  function optionsFor(mon) {
    var sp = Dex.species.get(mon.id);
    if (!sp.exists || !sp.evos || !sp.evos.length) return [];
    var out = [];
    for (var i = 0; i < sp.evos.length; i++) {
      var child = Dex.species.get(sp.evos[i]);
      if (!child.exists) continue;
      if (child.isNonstandard && child.isNonstandard !== 'Past') continue;
      var req = requirementFor(child);
      if (!req) continue;
      // Use the FULL forme name (Urshifu-Rapid-Strike, Raichu-Alola, ...) so
      // multiple evolutions of the same base species stay distinguishable.
      var label = child.name;
      out.push({
        id: child.id, name: label, species: child.name,
        types: child.types.slice(), bst: C.bst(child.id),
        requirement: req
      });
    }
    return out;
  }

  // Does the player hold everything needed?
  function canEvolve(run, mon, opt) {
    var req = opt.requirement;
    if (!run.bag[req.item]) return false;
    if (req.extraItem) {
      // the held item may either be in the bag OR already equipped
      if (!run.bag[req.extraItem] && toID(mon.item) !== req.extraItem) return false;
    }
    return true;
  }

  // Perform the evolution IN PLACE so the mon keeps its identity (uid),
  // HP fraction, status, held item and MVP damage totals.
  async function evolve(run, mon, opt) {
    var req = opt.requirement;
    var child = Dex.species.get(opt.id);
    if (!child.exists) return { ok: false, msg: 'Unknown evolution.' };

    // consume items
    run.bag[req.item]--; if (run.bag[req.item] <= 0) delete run.bag[req.item];
    if (req.extraItem) {
      if (run.bag[req.extraItem]) {
        run.bag[req.extraItem]--; if (run.bag[req.extraItem] <= 0) delete run.bag[req.extraItem];
      } else if (toID(mon.item) === req.extraItem) {
        mon.item = '';   // the held item is consumed by the evolution
      }
    }

    var fromName = mon.name;
    var fromSpecies = mon.species || C.cleanName(mon.id);
    var hpPct = mon.hpPct;

    // --- carry everything over ---
    mon.id = child.id;
    // The SPECIES changes; the nickname the player gave it does not.
    // Only fall back to the species name if it was never nicknamed.
    var newSpecies = (child.baseSpecies && child.baseSpecies !== child.name)
      ? child.name : C.cleanName(child.id);
    var wasUnnamed = !mon.name || mon.name === fromSpecies;
    mon.species = newSpecies;
    if (wasUnnamed) mon.name = newSpecies;
    mon.types = child.types.slice();
    mon.hpPct = hpPct;                       // same % of the NEW max HP

    // ability: keep it if the evolution can legally have it, else use its first
    var legalAb = [];
    for (var k in child.abilities) if (child.abilities[k]) legalAb.push(child.abilities[k]);
    if (legalAb.indexOf(mon.ability) < 0) mon.ability = legalAb[0] || mon.ability;

    // moves: keep everything still legal, top up from the new learnset
    var legal = await C.legalMoves(child.id, { all: true });
    var kept = mon.moves.filter(function (m) { return legal.indexOf(m) >= 0; });
    var newPP = {};
    kept.forEach(function (m) {
      newPP[m] = mon.pp[m] != null ? mon.pp[m] : Math.floor(Dex.moves.get(m).pp * 1.6);
    });
    if (kept.length < 4) {
      // deterministic: don't consume the catch RNG (run.rand)
      var dr = C.mulberry32(C.hashString((run ? run.seed : 'evo') + '|' + child.id + '|' + (mon.uid || '')));
      var auto = await C.autoMoveset(child.id, dr);
      for (var i = 0; i < auto.length && kept.length < 4; i++) {
        if (kept.indexOf(auto[i]) >= 0) continue;
        kept.push(auto[i]);
        newPP[auto[i]] = Math.floor(Dex.moves.get(auto[i]).pp * 1.6);
      }
    }
    mon.moves = kept;
    mon.pp = newPP;

    if (run.monMeta && run.monMeta[mon.uid]) {
      run.monMeta[mon.uid].name = mon.name;
      run.monMeta[mon.uid].id = mon.id;
    }
    run.seenSpecies[mon.id] = 1;

    return { ok: true, from: fromName, to: mon.name, species: newSpecies,
             fromSpecies: fromSpecies, renamed: !wasUnnamed, mon: mon };
  }

  // ---- shop stock ---------------------------------------------------------
  // Every item that any evolution in the game can require.
  var _allItems = null;
  function allEvolutionItems() {
    if (_allItems) return _allItems;
    var set = {};
    for (var id in Dex.data.Species) {
      var s = Dex.species.get(id);
      if (!s.exists || !s.evos) continue;
      for (var i = 0; i < s.evos.length; i++) {
        var child = Dex.species.get(s.evos[i]);
        if (!child.exists) continue;
        var req = requirementFor(child);
        if (!req) continue;
        set[req.item] = 1;
        if (req.extraItem) set[req.extraItem] = 1;
      }
    }
    _allItems = Object.keys(set).filter(itemExists).sort(function (a, b) {
      return itemName(a).localeCompare(itemName(b));
    });
    return _allItems;
  }

  // Only the items that are actually useful to the player's current party.
  // Returns [{ id, forSpecies, becomes }] so the shop can explain WHY it's here.
  function relevantItems(run) {
    var need = {}, order = [];
    run.party.forEach(function (mon) {
      optionsFor(mon).forEach(function (o) {
        var ids = [o.requirement.item];
        if (o.requirement.extraItem) ids.push(o.requirement.extraItem);
        ids.forEach(function (id) {
          if (!itemExists(id)) return;
          if (!need[id]) {
            need[id] = { id: id, forSpecies: mon.name, becomes: o.name };
            order.push(id);
          }
        });
      });
    });
    return order.map(function (id) { return need[id]; });
  }

  window.Evo = {
    CUSTOM_ITEMS: CUSTOM_ITEMS,
    itemExists: itemExists, itemName: itemName, itemDesc: itemDesc, itemPrice: itemPrice,
    requirementFor: requirementFor, optionsFor: optionsFor,
    canEvolve: canEvolve, evolve: evolve,
    allEvolutionItems: allEvolutionItems, relevantItems: relevantItems
  };
})();
