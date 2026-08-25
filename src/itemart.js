// ============================================================================
// itemart.js — item images for the shop, bag and team preview.
//
// Two sources, because neither alone is complete:
//   1. Showdown's itemicons-sheet.png (24x24, 16 cols) indexed by `spritenum`.
//      Covers every HELD item (berries, stones, mega stones, Leftovers, ...).
//      Does NOT contain medicine or Poke Balls (they aren't battle items).
//   2. PokeAPI item sprites, addressed by hyphenated name. Covers potions,
//      revives, balls, ethers etc.
//
// Custom items we invented (Link Cable, Rare Candy, Soothe Bell, Peat Block)
// fall back to PokeAPI names where they exist, else a coloured glyph.
// ============================================================================
(function () {
  var Dex = window.PS.Dex;

  var SHEET = 'https://play.pokemonshowdown.com/sprites/itemicons-sheet.png';
  var SHEET_W = 24, SHEET_H = 24, SHEET_COLS = 16;
  var POKEAPI = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/items/';

  // ids whose PokeAPI filename differs from a naive de-camel of the id
  var NAME_OVERRIDE = {
    pokeball: 'poke-ball', premierball: 'premier-ball', greatball: 'great-ball', ultraball: 'ultra-ball',
    masterball: 'master-ball', duskball: 'dusk-ball', timerball: 'timer-ball',
    netball: 'net-ball', quickball: 'quick-ball',
    superpotion: 'super-potion', hyperpotion: 'hyper-potion', maxpotion: 'max-potion',
    fullrestore: 'full-restore', maxrevive: 'max-revive', fullheal: 'full-heal',
    maxether: 'max-ether',
    rarecandy: 'rare-candy', soothebell: 'soothe-bell',
    linkcable: null,      // no PokeAPI sprite -> glyph
    peatblock: null       // no PokeAPI sprite -> glyph
  };

  // Emoji/glyph fallbacks so nothing ever renders blank.
  var GLYPH = {
    linkcable: '\u26AD',   // chain link
    peatblock: '\u25A9',   // hatched block
    rarecandy: '\u2764',
    soothebell: '\u266B'
  };

  function pokeApiName(id) {
    if (Object.prototype.hasOwnProperty.call(NAME_OVERRIDE, id)) return NAME_OVERRIDE[id];
    var it = Dex.items.get(id);
    var base = it.exists ? it.name : id;
    return String(base).toLowerCase()
      .replace(/[\u2019']/g, '')
      .replace(/\./g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  }

  // Does Showdown's sheet have this one?
  function sheetPos(id) {
    var it = Dex.items.get(id);
    if (!it.exists || it.spritenum == null) return null;
    var n = it.spritenum;
    var col = n % SHEET_COLS, row = Math.floor(n / SHEET_COLS);
    return { col: col, row: row };
  }

  // Inline HTML for an item image at `size` px (square box).
  function itemImg(id, size, cls) {
    size = size || 32;
    cls = cls || '';
    var pos = sheetPos(id);
    if (pos) {
      var scale = size / SHEET_W;
      return '<span class="itemimg sheet ' + cls + '" style="' +
        'width:' + size + 'px;height:' + size + 'px;' +
        'background-image:url(' + SHEET + ');' +
        'background-position:' + (-pos.col * SHEET_W * scale) + 'px ' + (-pos.row * SHEET_H * scale) + 'px;' +
        'background-size:' + (SHEET_COLS * SHEET_W * scale) + 'px auto;' +
        '"></span>';
    }
    var nm = pokeApiName(id);
    if (nm) {
      var g = GLYPH[id] || '\u25CF';
      return '<img class="itemimg ' + cls + '" width="' + size + '" height="' + size + '" ' +
        'src="' + POKEAPI + nm + '.png" alt="" ' +
        'onerror="this.onerror=null;this.outerHTML=\'<span class=&quot;itemimg glyph ' + cls +
        '&quot; style=&quot;width:' + size + 'px;height:' + size + 'px;font-size:' + Math.round(size * 0.7) +
        'px&quot;>' + g + '</span>\'">';
    }
    var gl = GLYPH[id] || '\u25CF';
    return '<span class="itemimg glyph ' + cls + '" style="width:' + size + 'px;height:' + size +
           'px;font-size:' + Math.round(size * 0.7) + 'px">' + gl + '</span>';
  }

  window.ItemArt = { itemImg: itemImg, pokeApiName: pokeApiName, sheetPos: sheetPos, SHEET: SHEET };
})();
