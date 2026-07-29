// ============================================================================
// mega.js — Mega Stones.
//
// Unlike evolution items, a Mega Stone is a HELD item and the transformation
// is temporary + battle-only. Showdown does all the real work:
//   * holding the right stone sets `canMegaEvo` on the move request
//   * choosing "move N mega" performs it
//   * the engine emits |detailschange| and |-mega| so we can animate it
//
// Our job is:
//   1. sell only the stones the player's current party can actually use
//   2. surface the Mega button in battle when canMegaEvo is set
//   3. play a transformation animation when |-mega| arrives
// ============================================================================
(function () {
  var Dex = window.PS.Dex;
  var toID = window.PS.toID;
  var C = window.Core;

  // Include BOTH stone generations:
  //   'Past'   = the Gen 6/7 megas (Charizardite, Gengarite, ...)
  //   'Future' = the Legends Z-A megas (Chimechite, Dragoninite, Raichunite,
  //              Skarmorite, ...). These have full species data and mega-evolve
  //              correctly, they are just flagged as not-yet-standard.
  // CAP entries are excluded.
  var ALLOWED_NS = { Past: 1, Future: 1 };
  var _index = null;
  function index() {
    if (_index) return _index;
    var bySpecies = {};   // speciesId -> [{item, itemName, forme, formeName}]
    var byItem = {};      // itemId -> {species, forme}
    for (var id in Dex.data.Items) {
      var it = Dex.items.get(id);
      if (!it.exists || !it.megaStone) continue;
      if (!ALLOWED_NS[it.isNonstandard]) continue;
      // megaStone is { "Charizard": "Charizard-Mega-X" }
      for (var baseName in it.megaStone) {
        var formeName = it.megaStone[baseName];
        var base = Dex.species.get(baseName);
        var forme = Dex.species.get(formeName);
        if (!base.exists || !forme.exists) continue;
        if (!bySpecies[base.id]) bySpecies[base.id] = [];
        bySpecies[base.id].push({
          item: it.id, itemName: it.name,
          forme: forme.id, formeName: forme.name,
          types: forme.types.slice(),
          ability: forme.abilities && forme.abilities[0] ? forme.abilities[0] : '',
          bst: C.bst(forme.id)
        });
        byItem[it.id] = { species: base.id, speciesName: base.name, forme: forme.id, formeName: forme.name };
      }
    }
    _index = { bySpecies: bySpecies, byItem: byItem };
    return _index;
  }

  function isMegaStone(itemId) { return !!index().byItem[toID(itemId)]; }
  function infoFor(itemId) { return index().byItem[toID(itemId)] || null; }

  // Which stones does this Pokemon have? (Charizard returns two.)
  function stonesFor(mon) {
    if (!mon) return [];
    var sp = Dex.species.get(mon.id);
    if (!sp.exists) return [];
    // a mon already in its mega forme can't take another stone
    if (sp.isMega) return [];
    var key = sp.id;
    var list = index().bySpecies[key];
    if (!list && sp.baseSpecies) list = index().bySpecies[toID(sp.baseSpecies)];
    return list || [];
  }

  function canMega(mon) { return stonesFor(mon).length > 0; }

  // Stones relevant to the CURRENT party, de-duplicated.
  function relevantStones(run) {
    var out = [], seen = {};
    run.party.forEach(function (mon) {
      stonesFor(mon).forEach(function (s) {
        if (seen[s.item]) return;
        seen[s.item] = 1;
        out.push({
          id: s.item, name: s.itemName,
          forSpecies: mon.name,
          formeName: s.formeName,
          types: s.types, ability: s.ability, bst: s.bst,
          price: price(s.item)
        });
      });
    });
    return out;
  }

  // Mega Stones have no canonical Poke Dollar price (they're never sold in the
  // games). Dailylocke charges a flat premium instead, so we mirror that
  // idea: one high flat price, nudged by how strong the resulting forme is.
  function price(itemId) {
    var info = infoFor(itemId);
    if (!info) return 12000;
    var b = C.bst(info.forme);
    // ~9k for weaker megas (Beedrill 495) up to ~16k for the monsters (Rayquaza 780)
    var p = 7000 + Math.round((b - 480) * 22);
    return Math.max(8000, Math.round(p / 100) * 100);
  }

  function desc(itemId) {
    var info = infoFor(itemId);
    if (!info) return 'A mysterious Mega Stone.';
    return 'Hold on ' + info.speciesName + ' to Mega Evolve into ' +
           info.formeName + ' during battle.';
  }

  // Can this mon actually use the stone it is holding?
  function holdingUsableStone(mon) {
    if (!mon || !mon.item) return false;
    var info = infoFor(mon.item);
    if (!info) return false;
    var sp = Dex.species.get(mon.id);
    return sp.exists && (sp.id === info.species || toID(sp.baseSpecies) === info.species);
  }

  window.Mega = {
    index: index, isMegaStone: isMegaStone, infoFor: infoFor,
    stonesFor: stonesFor, canMega: canMega, relevantStones: relevantStones,
    price: price, desc: desc, holdingUsableStone: holdingUsableStone
  };
})();
