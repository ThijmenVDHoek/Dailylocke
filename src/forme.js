// ============================================================================
// forme.js — permanent forme-change items (Rotom Catalog, Arceus plates,
// Silvally memories, Genesect drives, Ogerpon masks, origin orbs...).
//
// Unlike Mega Stones (temporary, battle-only) these SWAP THE FORME for good,
// the way an evolution does. They are only stocked when a Pokemon that can
// use them is alive in the party.
//
// Showdown marks them with:
//   forcedForme  -> "Giratina-Origin"
//   onPlate      -> Arceus type          ("Draco" => Arceus-Dragon)
//   onMemory     -> Silvally type
//   onDrive      -> Genesect type
// Rotom's appliances are not Showdown items at all, so we define them.
// ============================================================================
(function () {
  var Dex = window.PS.Dex;
  var toID = window.PS.toID;
  var C = window.Core;

  // Items the games have but Showdown does not model as held items.
  var CUSTOM = {
    rotomcatalog: {
      name: 'Rotom Catalog', price: 3000,
      desc: 'Lets Rotom possess a new appliance and change forme.',
      base: 'rotom',
      // one item, many destinations -> the player picks
      choices: ['Rotom', 'Rotom-Heat', 'Rotom-Wash', 'Rotom-Frost', 'Rotom-Fan', 'Rotom-Mow']
    },
    reveal_glass: {
      name: 'Reveal Glass', price: 3000,
      desc: 'Reveals the true form of the forces of nature.',
      multi: [
        ['tornadus', ['Tornadus', 'Tornadus-Therian']],
        ['thundurus', ['Thundurus', 'Thundurus-Therian']],
        ['landorus', ['Landorus', 'Landorus-Therian']],
        ['enamorus', ['Enamorus', 'Enamorus-Therian']]
      ]
    },
    prison_bottle: {
      name: 'Prison Bottle', price: 3000,
      desc: 'Unleashes Hoopa\u2019s true power.',
      base: 'hoopa',
      choices: ['Hoopa', 'Hoopa-Unbound']
    },
    gracidea_flower: {
      name: 'Gracidea', price: 2500,
      desc: 'A bouquet that changes Shaymin\u2019s forme.',
      base: 'shaymin',
      choices: ['Shaymin', 'Shaymin-Sky']
    },
    dna_splicers: {
      name: 'DNA Splicers', price: 4000,
      desc: 'Fuses Kyurem with a legendary dragon.',
      base: 'kyurem',
      choices: ['Kyurem', 'Kyurem-Black', 'Kyurem-White']
    },
    zygarde_cube: {
      name: 'Zygarde Cube', price: 4000,
      desc: 'Reconfigures Zygarde\u2019s cells.',
      base: 'zygarde',
      choices: ['Zygarde', 'Zygarde-10%', 'Zygarde-Complete']
    }
  };

  // ---- index Showdown's real forme items ---------------------------------
  var _index = null;
  function index() {
    if (_index) return _index;
    var byBase = {};   // baseSpeciesId -> [{item,itemName,forme,formeName,price}]
    var byItem = {};

    function add(itemId, itemName, formeName, price, desc) {
      var sp = Dex.species.get(formeName);
      if (!sp.exists) return;
      var baseId = toID(sp.baseSpecies || sp.name);
      var entry = {
        item: itemId, itemName: itemName,
        forme: sp.id, formeName: sp.name,
        base: baseId, price: price,
        desc: desc || ''
      };
      (byBase[baseId] = byBase[baseId] || []).push(entry);
      byItem[itemId] = entry;
    }

    for (var id in Dex.data.Items) {
      var it = Dex.items.get(id);
      if (!it.exists || it.megaStone) continue;
      if (it.zMove || /iumz$/.test(it.id)) continue;
      var target = null;
      if (it.forcedForme) target = it.forcedForme;
      else if (it.onPlate) target = 'Arceus-' + it.onPlate;
      else if (it.onMemory) target = 'Silvally-' + it.onMemory;
      else if (it.onDrive) target = 'Genesect-' + it.onDrive;
      if (!target) continue;
      add(it.id, it.name, target, priceOf(it.id), it.desc || it.shortDesc || '');
    }
    _index = { byBase: byBase, byItem: byItem };
    return _index;
  }

  function priceOf(itemId) {
    var p = C.itemPrice(itemId);
    if (!p || p > 6000) p = 3000;
    return Math.max(1500, Math.round(p / 100) * 100);
  }

  function itemExists(id) { return !!CUSTOM[id] || Dex.items.get(id).exists; }
  function itemName(id) {
    if (CUSTOM[id]) return CUSTOM[id].name;
    var it = Dex.items.get(id);
    return it.exists ? it.name : id;
  }
  function itemPrice(id) {
    if (CUSTOM[id]) return CUSTOM[id].price;
    var e = index().byItem[id];
    return e ? e.price : 3000;
  }
  function itemDesc(id) {
    if (CUSTOM[id]) return CUSTOM[id].desc;
    var e = index().byItem[id];
    return e ? e.desc : '';
  }
  function isFormeItem(id) { return !!CUSTOM[id] || !!index().byItem[id]; }

  // Which base species does a custom item serve?
  function customBases(def) {
    if (def.multi) return def.multi.map(function (m) { return m[0]; });
    return [def.base];
  }

  // ---- what can THIS Pokemon do with THIS item? --------------------------
  // Returns a list of {id, name} formes it could switch to (excluding current).
  function targetsFor(mon, itemId) {
    var sp = Dex.species.get(mon.id);
    if (!sp.exists) return [];
    var baseId = toID(sp.baseSpecies || sp.name);

    if (CUSTOM[itemId]) {
      var def = CUSTOM[itemId];
      var list = null;
      if (def.multi) {
        for (var i = 0; i < def.multi.length; i++) {
          if (def.multi[i][0] === baseId) { list = def.multi[i][1]; break; }
        }
      } else if (def.base === baseId) list = def.choices;
      if (!list) return [];
      return list.map(function (n) { return Dex.species.get(n); })
                 .filter(function (x) { return x.exists && x.id !== sp.id; })
                 .map(function (x) { return { id: x.id, name: x.name }; });
    }

    var e = index().byItem[itemId];
    if (!e || e.base !== baseId) return [];
    if (e.forme === sp.id) return [];
    var t = Dex.species.get(e.forme);
    return t.exists ? [{ id: t.id, name: t.name }] : [];
  }

  // Every forme item usable by anything alive in the party.
  function relevantItems(run) {
    var out = [], seen = {};
    var living = run.party.filter(function (m) { return !C.isFainted(m); });

    living.forEach(function (mon) {
      var sp = Dex.species.get(mon.id);
      if (!sp.exists) return;
      var baseId = toID(sp.baseSpecies || sp.name);

      // custom items
      Object.keys(CUSTOM).forEach(function (cid) {
        if (seen[cid]) return;
        if (customBases(CUSTOM[cid]).indexOf(baseId) < 0) return;
        if (!targetsFor(mon, cid).length) return;
        seen[cid] = 1;
        out.push({ id: cid, name: CUSTOM[cid].name, price: CUSTOM[cid].price,
                   desc: CUSTOM[cid].desc, forSpecies: mon.name });
      });

      // Showdown items
      var list = index().byBase[baseId] || [];
      list.forEach(function (e) {
        if (seen[e.item]) return;
        if (!targetsFor(mon, e.item).length) return;
        seen[e.item] = 1;
        out.push({ id: e.item, name: e.itemName, price: e.price,
                   desc: e.desc || ('Changes ' + baseId + '\u2019s forme.'),
                   forSpecies: mon.name });
      });
    });
    return out;
  }

  // Can any living party member use this item right now?
  function usableBy(run, itemId) {
    return run.party.filter(function (m) {
      return !C.isFainted(m) && targetsFor(m, itemId).length > 0;
    });
  }

  // ---- apply ------------------------------------------------------------
  // Swap the forme in place: keep uid, nickname, HP %, status, damage totals.
  async function applyForme(run, mon, formeId) {
    var sp = Dex.species.get(formeId);
    if (!sp.exists) return { ok: false, msg: 'Unknown forme.' };

    var fromName = mon.species || C.cleanName(mon.id);
    var hpPct = mon.hpPct;

    mon.id = sp.id;
    mon.species = sp.name;
    mon.types = sp.types.slice();
    mon.hpPct = hpPct;

    var legalAb = [];
    for (var k in sp.abilities) if (sp.abilities[k]) legalAb.push(sp.abilities[k]);
    if (legalAb.indexOf(mon.ability) < 0) mon.ability = legalAb[0] || mon.ability;

    // keep every move the new forme can still legally use
    var legal = await C.legalMoves(sp.id, { all: true });
    var kept = mon.moves.filter(function (m) { return legal.indexOf(m) >= 0; });
    var newPP = {};
    kept.forEach(function (m) {
      newPP[m] = mon.pp[m] != null ? mon.pp[m] : Math.floor(Dex.moves.get(m).pp * 1.6);
    });
    if (kept.length < 4) {
      var dr = C.mulberry32(C.hashString((run ? run.seed : 'forme') + '|' + sp.id + '|' + (mon.uid || '')));
      var auto = await C.autoMoveset(sp.id, dr);
      for (var i = 0; i < auto.length && kept.length < 4; i++) {
        if (kept.indexOf(auto[i]) >= 0) continue;
        kept.push(auto[i]);
        newPP[auto[i]] = Math.floor(Dex.moves.get(auto[i]).pp * 1.6);
      }
    }
    mon.moves = kept;
    mon.pp = newPP;

    if (run.monMeta && run.monMeta[mon.uid]) run.monMeta[mon.uid].id = mon.id;
    run.seenSpecies[mon.id] = 1;
    return { ok: true, from: fromName, to: sp.name, mon: mon };
  }

  window.Forme = {
    CUSTOM: CUSTOM, index: index,
    isFormeItem: isFormeItem, itemName: itemName, itemPrice: itemPrice,
    itemDesc: itemDesc, itemExists: itemExists,
    targetsFor: targetsFor, relevantItems: relevantItems, usableBy: usableBy,
    applyForme: applyForme
  };
})();
