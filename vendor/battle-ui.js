// battle-ui.js -- 3D glassmorphism battle UI. Sprites are projected DOM <img>
// elements so that animated GIFs play natively in the browser (no WebGL texture
// upload means no CORS requirement, no frame-decoding issues).
(function(){
'use strict';
var T = window.THREE;
if(!T){console.error('[BattleUI] THREE not loaded');return;}

var TC = {Normal:'#a8a878',Fire:'#f08030',Water:'#6890f0',Electric:'#f8d030',Grass:'#78c850',Ice:'#98d8d8',Fighting:'#c03028',Poison:'#a040a0',Ground:'#e0c068',Flying:'#a890f0',Psychic:'#f85888',Bug:'#a8b820',Rock:'#b8a038',Ghost:'#705898',Dragon:'#7038f8',Dark:'#705848',Steel:'#b8b8d0',Fairy:'#ee99ac',Status:'#888'};

var BIOMES = {
  meadow:{sky:0x70c3e8,fog:[0xa8e4ff,12,42],g:0x42b96a,d:0x2f8b4e,a:[0xfff4d6,1.05],s:[0xfff6dc,2.1,[-6,12,4]],hills:[[-6,1.2,-14,4,0x3a9d5a],[7,0.8,-16,5,0x328855],[2,0.5,-18,6,0x2a7549],[-9,1.5,-12,3.5,0x4aaa6a],[10,1.0,-13,3,0x3a9a5a],[-3,0.6,-20,5.5,0x2a7549],[5,0.4,-21,6,0x22703a]],trees:[[-6.5,0,2,2.8,0x2d8a4d],[7,0,3,2.4,0x348e50],[-8,0,-3,3.2,0x276b3e],[8.5,0,-4,2.7,0x2a7844]],trunk:0x5a3820,pf:[0x3a9d5a,0xd4a56a,0xb8864d],cc:0xffffff,fc:[0xf7e14a,0xf588c8,0xffffff,0xc48aff,0xff9066],fl:['#4dd67c','#3aae5c'],stripe:0x5cc77e,wth:null},
  forest:{sky:0x4a7a9a,fog:[0x6e9bb3,10,32],g:0x2f6b3a,d:0x1f4d27,a:[0xb8d0aa,0.85],s:[0xfff1c4,1.5,[-5,10,4]],hills:[[-7,1.5,-12,5,0x1f5529],[7,1.1,-14,6,0x1d4f25],[1,0.7,-17,7,0x174020],[-10,1.8,-10,4,0x1a4a22],[10,1.3,-11,4.5,0x164020],[-3,2.0,-9,3,0x1d4a28]],trees:[[-7,0,3,3.5,0x1f6030],[8,0,2,3.2,0x236b35],[-9,0,-1,4.0,0x184d22],[9,0,-3,3.6,0x1b5c28],[-5,0,-6,3.8,0x1f5f30],[6,0,-7,3.4,0x1f6030],[-4,0,1,2.8,0x206030],[4,0,-2,3.0,0x1a5525]],trunk:0x3a2414,pf:[0x2f6b3a,0x8a6a3a,0x664c2a],cc:0xd0dae0,fc:[0xfff7a0,0xa6ff8c,0xffffff],fl:['#ffffff','#f5e788'],stripe:0x3a8b50,wth:null},
  desert:{sky:0xf4c28a,fog:[0xe9d3a2,16,50],g:0xe6c879,d:0xc9a84b,a:[0xfff1cc,1.0],s:[0xfff0c0,2.3,[-4,14,3]],hills:[[-7,1.0,-14,5,0xc69b45],[8,0.7,-16,6,0xb58532],[2,0.4,-19,7,0xa17526],[-10,1.3,-11,4,0xd0a850],[11,0.9,-12,4.5,0xb88840],[-4,0.5,-21,5.5,0xa07830]],trees:[[-7,0,2,2.4,0x5a8e3a],[8,0,-2,2.0,0x4e7d33]],trunk:0x6b4d1f,pf:[0xd6b85e,0xa8803d,0x8a6627],cc:0xffeedc,fc:[0xffcc66,0xffaa44],fl:[],stripe:0,wth:null},
  snow:{sky:0xbfe0f3,fog:[0xddecfa,12,40],g:0xe8f2fa,d:0xc1d6e6,a:[0xe6f0ff,1.05],s:[0xffffff,1.8,[-6,12,4]],hills:[[-6,1.3,-14,5,0xc8ddef],[7,1.0,-16,6,0xb8d1e5],[2,0.6,-19,7,0xa8c5de],[-9,1.6,-11,4,0xd0dde8],[10,1.2,-12,4.5,0xb0c8dd],[-3,0.8,-21,5.5,0xa0b8d0]],trees:[[-7,0,2,3.0,0x2f6b4b],[8,0,2,2.6,0x377a55],[-9,0,-3,3.4,0x285e42],[9,0,-4,2.9,0x2f6b4b]],trunk:0x4a3218,pf:[0xf0f6fb,0xa8b6c2,0x7f92a0],cc:0xffffff,fc:[0xffffff,0xdde8ff],fl:[],stripe:0xf0f6fb,wth:'snow'},
  cave:{sky:0x1a1428,fog:[0x261c3c,8,24],g:0x2a2340,d:0x191228,a:[0x8270c0,0.7],s:[0xffd8a0,1.0,[0,10,4]],hills:[[-7,1.8,-12,6,0x221a33],[7,1.4,-14,7,0x1b132a],[0,0.9,-18,8,0x150f22],[3,2.5,-10,3,0x221a33],[-4,2.2,-11,3.5,0x1b132a],[10,1.6,-15,5,0x150f22],[-10,1.0,-16,5.5,0x1a1228]],trees:[],trunk:0x332440,pf:[0x4b3e66,0x6a5a88,0x3d3055],cc:0x2b1f44,fc:[0xff9cf0,0x9cffff,0xc098ff,0xffe08a],fl:[],stripe:0x332855,glow:0x6040c0,glowN:24,wth:null},
  volcano:{sky:0x4a1a1a,fog:[0x6b2820,10,28],g:0x4d2820,d:0x2a1510,a:[0xff9c5a,0.8],s:[0xff6030,1.8,[-5,10,3]],hills:[[-6,1.6,-13,5,0x4d1a10],[7,1.2,-15,6,0x3a1308],[2,0.8,-18,7,0x2a0d06],[-9,2.0,-10,4.5,0x5a2018],[10,1.8,-12,5,0x4a1810],[-3,2.8,-8,3,0x6a2820],[4,2.2,-9,3.5,0x5a2018]],trees:[],trunk:0x30140c,pf:[0x5a2218,0x8a2f1e,0x2f1008],cc:0x803020,fc:[0xffb040,0xff6020,0xffe060],fl:[],stripe:0x6b2820,glow:0xff4010,glowN:30,wth:null},
  beach:{sky:0x60b8e8,fog:[0x90d0f0,14,42],g:0xc8b870,d:0xa89850,a:[0xd0e8ff,1.1],s:[0xffffff,2.2,[-6,12,4]],hills:[[-7,0.8,-15,4,0x2870a8],[7,0.6,-16,4.5,0x206898],[0,0.4,-18,5,0x186090],[-10,1.0,-12,3.5,0x3090b8],[10,0.8,-13,4,0x2880a8]],trees:[[-7,0,3,3.0,0x308848],[9,0,2,2.8,0x288040]],trunk:0x5a4020,pf:[0xd8c080,0xa0b8d0,0x8090a8],cc:0xffffff,fc:[0x80d0ff,0xa0e0ff,0xffffff],fl:['#ff90b0','#ffc060'],stripe:0x4090c0,wth:null},
  psychic:{sky:0xb593e8,fog:[0xd0b4ff,12,38],g:0xa978e0,d:0x7849c2,a:[0xf0c8ff,1.0],s:[0xffb8f0,1.7,[-5,10,3]],hills:[[-6,1.3,-13,5,0x8a5cd0],[7,1.0,-15,6,0x7849c2],[2,0.6,-18,7,0x6a3eb0],[-9,1.6,-10,4,0x9a70d8],[10,1.2,-11,4.5,0x7060b0],[5,2.0,-8,3,0x8868c0]],trees:[[-7,0,2,3.0,0xffa8e4],[8,0,2,2.7,0xffc8f0],[-9,0,-2,3.2,0x9cf0ff],[9,0,-4,2.9,0xc0b0ff]],trunk:0x5a3a80,pf:[0xd8b8ff,0x9a7ad6,0x6b4aa8],cc:0xffe0ff,fc:[0xffa8e4,0x9cf0ff,0xfff080,0xc0b0ff],fl:['#ff88ff','#88c8ff'],stripe:0xc090f0,glow:0xc080ff,glowN:20,wth:null},
  plains:{sky:0x98c8e8,fog:[0xb8d8f0,14,46],g:0x6ab06a,d:0x4a8a4a,a:[0xf0f0e8,1.1],s:[0xfff8e0,1.9,[-5,12,4]],hills:[[-6,0.8,-14,4.5,0x5a9a5a],[7,0.6,-16,5,0x4a8a4a],[2,0.4,-18,5.5,0x3a7a3a],[-9,1.1,-11,3.5,0x6aaa5a],[10,0.7,-12,4,0x5a9a4a]],trees:[[-6,0,2,2.2,0x3a7a3a],[8,0,1,2.0,0x4a8a4a]],trunk:0x5a4820,pf:[0x5a9a5a,0xc8b878,0xa89858],cc:0xffffff,fc:[0xfff8d0,0xe0f0a0,0xffffff],fl:['#f0e070','#e0d060'],stripe:0x70b070,wth:null},
  dojo:{sky:0xb86848,fog:[0xc87850,10,30],g:0xd0a070,d:0xb08850,a:[0xf0d0a0,1.0],s:[0xfff0c0,1.8,[-5,10,3]],hills:[[-6,0.6,-14,3.5,0xa08050],[7,0.4,-16,4,0x907040],[-9,1.0,-11,3,0xb08850],[10,0.8,-12,3.5,0xa07838]],trees:[[-8,0,2,2.2,0xb84030],[9,0,1,2.0,0xc85040]],trunk:0x5a2810,walls:[[4,0,-15,8,3.5,0.4,0x906838],[-5,0,-13,6,3,0.4,0x805828]],pf:[0xd0a070,0xe0b880,0xb89060],cc:0xf0d8c0,fc:[0xff6040,0xffa080,0xffffff],fl:['#ff5050','#ff7070'],stripe:0xc09060,wth:null},
  swamp:{sky:0x2a2838,fog:[0x3a3048,6,22],g:0x304038,d:0x202828,a:[0x8070a0,0.6],s:[0xa090c0,1.0,[0,8,3]],hills:[[-7,1.0,-12,4,0x282830],[7,0.8,-14,5,0x202028],[0,0.5,-16,4.5,0x181820],[-10,1.4,-9,3.5,0x302838],[10,1.1,-10,4,0x282030],[3,1.8,-7,2.5,0x222030]],trees:[[-6,0,3,3.0,0x3a2a20],[8,0,2,2.5,0x4a3a2a],[-8,0,-2,3.5,0x2a1a10],[5,0,-4,2.8,0x3a2a18]],trunk:0x2a1a10,pf:[0x304038,0x584870,0x283028],cc:0x403850,fc:[0x80ff80,0xa0ffa0,0xc0ffc0,0xc080ff,0xa060e0],fl:['#a040c0','#8030a0'],stripe:0x283030,glow:0x8060c0,glowN:20,wth:null},
  canyon:{sky:0xd89850,fog:[0xe0b070,14,44],g:0xc89050,d:0xa87030,a:[0xf0d0a0,0.95],s:[0xffe0b0,2.2,[-4,12,3]],hills:[[-7,1.5,-12,5.5,0xb87838],[8,1.2,-14,6,0xa06828],[2,0.8,-17,6.5,0x885818],[-10,2.0,-9,4.5,0xc88848],[11,1.8,-10,5,0xa87038],[-4,1.0,-20,5,0x906028],[5,0.6,-21,5.5,0x805820]],trees:[],trunk:0x6a4020,pf:[0xc89050,0xa07030,0x886020],cc:0xf0d8a0,fc:[0xffc860,0xffa040],fl:[],stripe:0xb07830,wth:null},
  skyclouds:{sky:0x5090d0,fog:[0x80b0e0,18,55],g:0x90b8a0,d:0x70a080,a:[0xd0e8ff,1.15],s:[0xffffff,2.0,[-6,14,4]],hills:[[-6,0.6,-14,4,0x70a080],[7,0.4,-16,4.5,0x609878],[-9,0.8,-11,3.5,0x80b090],[10,0.5,-12,4,0x68a080],[0,1.0,-9,3,0x78b088]],trees:[[-7,0,2,2.2,0x508860],[9,0,1,2.0,0x609070]],trunk:0x4a6038,pf:[0x80b0a0,0xd0d8c0,0xa0c0a8],cc:0xffffff,fc:[0xd0e8ff,0xe0f0ff,0xffffff],fl:['#e0f0ff','#c0d8f0'],stripe:0x88b8a0,wth:null},
  garden:{sky:0x60b878,fog:[0x80d098,12,38],g:0x48a048,d:0x388838,a:[0xc0f0c0,1.0],s:[0xe0ffe0,1.8,[-5,10,4]],hills:[[-6,0.6,-14,4,0x3a903a],[7,0.4,-16,4.5,0x308830],[-9,0.9,-11,3.5,0x4a9848],[10,0.7,-12,4,0x388838]],trees:[[-6,0,2,2.4,0x2a782a],[8,0,2,2.2,0x388838],[-8,0,-2,2.6,0x207020],[4,0,-3,2.0,0x308030]],trunk:0x4a3018,pf:[0x48a048,0xd088c0,0xa068a0],cc:0xffffff,fc:[0xff80c0,0xffa0d0,0xffffff,0xc0ffa0],fl:['#ff70a0','#ff90c0','#e070ff'],stripe:0x50a850,wth:null},
  rocky:{sky:0x8a7a68,fog:[0xa09880,10,32],g:0x8a7a60,d:0x706048,a:[0xd0c8b0,0.8],s:[0xe0d8c0,1.5,[-5,10,3]],hills:[[-7,1.4,-12,5.5,0x6a5a40],[8,1.1,-14,6,0x5a4a30],[0,0.8,-17,6.5,0x4a3a20],[-10,1.8,-9,4.5,0x7a6a50],[11,1.5,-10,5,0x605040],[-4,2.0,-8,3,0x8a7a60],[5,1.6,-9,3.5,0x706050]],trees:[],trunk:0x3a2a1a,pf:[0x7a6a50,0xa09078,0x605040],cc:0xb0a890,fc:[0xd0c0a0,0xe0d0b0],fl:[],stripe:0x706050,wth:null},
  graveyard:{sky:0x1a1028,fog:[0x2a1838,6,22],g:0x2a2030,d:0x1a1020,a:[0x6040a0,0.5],s:[0x8060c0,0.8,[0,8,3]],hills:[[-7,1.2,-12,4.5,0x221828],[7,0.9,-14,5,0x1a1020],[0,0.6,-16,4,0x120818],[-10,1.6,-9,3.5,0x2a1830],[10,1.3,-10,4,0x1e1228],[3,2.0,-7,2.5,0x281830],[-4,1.8,-8,3,0x201428]],trees:[[-6,0,3,3.5,0x2a1a10],[8,0,2,3.0,0x3a2a1a],[-8,0,-2,3.8,0x1a0a00],[5,0,-4,2.5,0x2a1a08]],trunk:0x1a0a00,walls:[[5,0,-14,3,2.2,0.3,0x302040],[-4,0,-12,2.5,1.8,0.3,0x281838]],pf:[0x2a2030,0x5a4070,0x1a1020],cc:0x2a1838,fc:[0x8060ff,0xa080ff,0xc0a0ff,0xe0c0ff],fl:[],stripe:0x1a1020,glow:0x6040a0,glowN:22,wth:null},
  ruins:{sky:0x3a1a10,fog:[0x4a2818,10,32],g:0x4a3028,d:0x301810,a:[0xd0a070,0.8],s:[0xffc060,2.0,[-5,12,3]],hills:[[-7,2.0,-12,6,0x3a2018],[8,1.6,-14,6.5,0x2a1510],[-2,1.2,-17,7,0x200c08],[-4,1.8,-13,5,0x3a2018],[5,1.4,-15,5.5,0x2a1510],[-10,2.5,-9,4,0x4a2820],[11,2.2,-10,4.5,0x3a1a18],[4,3.0,-8,2.5,0x503028]],trees:[[-8,0,3,3.5,0x3a2818],[10,0,2,3.0,0x4a3828]],trunk:0x2a1810,pillars:[[-6,0,-10,0.5,4.0,0x6a5040],[7,0,-11,0.5,3.5,0x5a4030],[-3,0,-13,0.4,3.8,0x6a5040],[4,0,-12,0.4,3.2,0x5a4030]],walls:[[9,0,-14,6,3,0.4,0x5a4038],[-7,0,-15,5,2.5,0.4,0x4a3028]],pf:[0x4a3028,0xc09040,0x8a6030],cc:0x5a3828,fc:[0xffa040,0xff8020,0xffc060,0xff6020],fl:[],stripe:0x3a2018,glow:0xff8020,glowN:20,wth:null},
  void:{sky:0x12101e,fog:[0x1e1830,8,28],g:0x1e1828,d:0x141020,a:[0x6048a0,0.55],s:[0x8060c0,0.9,[0,8,3]],hills:[[-7,1.2,-12,4.5,0x1a1428],[7,0.9,-14,5,0x161022],[0,0.6,-16,4,0x120c1a],[-10,1.8,-9,3.5,0x201838],[10,1.5,-10,4,0x181030],[3,2.2,-7,2.5,0x221840],[-4,2.0,-8,3,0x1a1230]],trees:[],trunk:0x100a14,pf:[0x201838,0x382860,0x181030],cc:0x1e1830,fc:[0x8060e0,0xa080ff,0xc0a0ff,0x6040c0],fl:[],stripe:0x181028,glow:0x6040a0,glowN:30,wth:null},
  factory:{sky:0x505058,fog:[0x686870,8,26],g:0x585860,d:0x404048,a:[0xb0b0b8,0.8],s:[0xd0d0d8,1.5,[-4,10,3]],hills:[[-7,1.2,-12,4.5,0x404048],[7,0.9,-14,5,0x383840],[-10,1.6,-9,3.5,0x4a4a52],[10,1.3,-10,4,0x3a3a42]],trees:[],trunk:0x303038,pillars:[[-5,0,-10,0.4,3.5,0x6a6a72],[6,0,-11,0.4,3.0,0x5a5a62]],walls:[[8,0,-14,7,3.5,0.4,0x4a4a50],[-6,0,-15,5,3,0.4,0x3a3a42]],pf:[0x585860,0x909098,0x484850],cc:0x909098,fc:[0xc0c0e0,0xd8d8f0,0xffffff],fl:[],stripe:0x505058,wth:null},
  powerplant:{sky:0x1a2028,fog:[0x283030,8,28],g:0x2a2a22,d:0x1a1a18,a:[0xd0c870,0.7],s:[0xf0e040,1.6,[0,10,3]],hills:[[-7,1.2,-12,4.5,0x222218],[7,0.9,-14,5,0x1a1a10],[-10,1.6,-9,3.5,0x2a2a20],[10,1.3,-10,4,0x1a1a18]],trees:[],trunk:0x1a1a10,pillars:[[-6,0,-11,0.4,3.5,0x404030],[8,0,-13,0.4,3.0,0x383828],[-4,0,-15,0.35,3.2,0x404030],[5,0,-14,0.35,2.8,0x383828]],walls:[[9,0,-16,7,3.5,0.4,0x2a2a20],[-7,0,-17,5,3,0.4,0x1a1a10]],pf:[0x2a2a22,0xe0d040,0x40a020],cc:0x3a3a30,fc:[0xf0e040,0xe0ff60,0xffffff,0x80ff40],fl:[],stripe:0x2a2a22,glow:0xa0e040,glowN:20,wth:null},
  glade:{sky:0xc8a0d8,fog:[0xd8b8e8,12,36],g:0x60a868,d:0x488850,a:[0xf0d0f8,1.0],s:[0xffe0ff,1.8,[-5,10,3]],hills:[[-6,0.8,-14,4,0x509058],[7,0.6,-16,4.5,0x408048],[-9,1.1,-11,3.5,0x589860],[10,0.9,-12,4,0x488850]],trees:[[-6,0,2,2.6,0x3a7840],[8,0,2,2.4,0x4a8850],[-8,0,-1,2.8,0x306830],[4,0,-3,2.2,0x3a7840]],trunk:0x4a3020,pf:[0x60a868,0xd090c0,0xa070a0],cc:0xf0d8f0,fc:[0xff90d0,0xffb0e0,0xffffff,0xc0ffa0],fl:['#ff80c0','#ff60a0','#d080ff'],stripe:0x68b070,glow:0xc080ff,glowN:16,wth:null}
};

function pickBiome(seed,types){
  var b=[];
  function push(n,w){w=w||1;for(var i=0;i<w;i++)b.push(n);}
  push('meadow',4);push('forest',2);push('beach',2);push('cave',1);push('psychic',1);push('desert',1);push('snow',1);
  if(types){
    if(types.indexOf('Fire')>=0)push('volcano',5);
    if(types.indexOf('Water')>=0)push('beach',4);
    if(types.indexOf('Grass')>=0||types.indexOf('Bug')>=0)push('forest',4);
    if(types.indexOf('Ice')>=0)push('snow',5);
    if(types.indexOf('Ground')>=0||types.indexOf('Rock')>=0||types.indexOf('Steel')>=0)push('desert',3);
    if(types.indexOf('Dragon')>=0||types.indexOf('Ghost')>=0||types.indexOf('Dark')>=0||types.indexOf('Psychic')>=0)push('psychic',4);
    if(types.indexOf('Electric')>=0)push('cave',3);
  }
  var h=2166136261>>>0;
  for(var i=0;i<seed.length;i++){h^=seed.charCodeAt(i);h=Math.imul(h,16777619);}
  return b[Math.floor(((h>>>0)/4294967296)*b.length)]||'meadow';
}

function sg(r,wS,hS){return new T.SphereGeometry(r,wS||12,hS||8);}
function cg(rt,rb,h,s){return new T.CylinderGeometry(rt||0.15,rb||0.2,h,s||7);}
function dg(r,s){return new T.CircleGeometry(r,s||24);}
function pg(w,h){return new T.PlaneGeometry(w||1,h||1);}
function sm(c,o){return new T.MeshStandardMaterial(Object.assign({color:c,roughness:1},o||{}));}
function bm(c,o){return new T.MeshBasicMaterial(Object.assign({color:c},o||{}));}

// ===== Persistent image cache (shared across mount/unmount) =====
// CACHE holds Image objects; FAILED marks URLs that 404'd so we never re-wait
// on a broken preferred GIF (which used to stall until the 800ms race lost to gen5).
// Persistent image cache, bounded with LRU eviction. CACHE holds Image
// objects; FAILED marks URLs that 404'd so we never re-wait on a broken
// preferred GIF. Without a cap, a long play session accumulates every sprite
// URL ever seen and never releases it.
var CACHE_MAX=600,CACHE=Object.create(null),CACHE_ORDER=[];
var FAILED_MAX=300,FAILED=Object.create(null),FAILED_ORDER=[];
function cachePut(url,img){
  if(CACHE[url])return;
  CACHE[url]=img;CACHE_ORDER.push(url);
  if(CACHE_ORDER.length>CACHE_MAX){delete CACHE[CACHE_ORDER.shift()];}
}
function cacheFail(url){
  if(FAILED[url])return;
  FAILED[url]=1;FAILED_ORDER.push(url);
  if(FAILED_ORDER.length>FAILED_MAX){delete FAILED[FAILED_ORDER.shift()];}
}

// One explicit renderer session owns the sole WebGL context. Previously the
// renderer, canvas, owner and context flags were independent globals; an error
// could update only some of them and leave a "live" owner attached to a dead
// canvas. Keeping those transitions together makes screen swaps transactional.
//
// ROBUSTNESS RULE #1: nothing in here may fail PERMANENTLY. A single
// transient context-creation error (cold GPU init, driver hiccup, a GPU
// process bounce, one unlucky frame right after wake) used to flip a sticky
// 'unavailable' switch, after which EVERY later mount silently rendered flat
// for the rest of the session -- the "3D falls back to 2D every single run"
// bug. Now a screen that cannot get WebGL right this instant renders flat
// (fully playable) while the session keeps retrying creation in the
// background; the moment a context can be created, the live screen is
// upgraded back to 3D in place -- no remount, no lost battle state, no
// reload.
//
// ROBUSTNESS RULE #2: a lost context is REPLACED, not awaited. The browser
// may never deliver webglcontextrestored (killed GPU process, too many
// contexts, WebKit's silent loss path). The scene graph is renderer-agnostic
// Three.js data (sprites are DOM), so creating a fresh renderer+canvas and
// re-rendering the existing scene is safe and always available.
var RendererSession={
  renderer:null,canvas:null,owner:null,state:'idle',lastError:null,
  _lost:false,_recoverTimer:null,_recoverDelay:0,_lastCreateAttempt:0,
  // Never hammer a genuinely missing GPU: two foreground creation attempts
  // must be at least this far apart. The background recovery chain below
  // handles everything else.
  MIN_RETRY_MS:750,
  RECOVER_DELAYS:[300,1000,2000], // then a steady 2000ms
  healthy:function(){
    if(!this.renderer)return false;
    if(this._lost)return false;
    try{if(this.renderer.isContextLost&&this.renderer.isContextLost())return false;}catch(_){return false;}
    return true;
  },
  acquire:function(owner,w,h){
    var previous=this.owner;
    if(previous&&previous!==owner){
      // Used to THROW ('renderer is still in use'): a racing mount crashed
      // the whole battle start. The newest screen simply takes over; the old
      // one keeps playing in flat mode and can re-acquire later if it ever
      // becomes the visible screen again.
      if(previous.s&&previous.s.mounted&&!previous._disposed){
        try{previous._notifyRendererReclaimed();}catch(_){}
      }
    }
    this.owner=owner;
    if(this.healthy()){
      try{
        this.renderer.setSize(w,h,false);
        if(this.renderer.resetState)this.renderer.resetState();
      }catch(err){
        this._markLost(err);
        this._scheduleRecover();
        return null;
      }
      this.state='ready';this.lastError=null;
      return this.renderer;
    }
    // No healthy renderer: dispose the corpse and make a fresh one.
    if(this.renderer)this._disposeRenderer();
    // Back off only when we JUST tried and failed; otherwise always try anew.
    if(this.state==='degraded'&&this._lastCreateAttempt&&(Date.now()-this._lastCreateAttempt)<this.MIN_RETRY_MS){
      this._scheduleRecover();
      return null;
    }
    var r=this._createRenderer(w,h);
    if(r){this.state='ready';this.lastError=null;this._cancelRecover();return r;}
    this.state='degraded';
    this._scheduleRecover();
    return null;
  },
  _createRenderer:function(w,h){
    this._lastCreateAttempt=Date.now();
    try{
      // Scenery does not benefit enough from a 2x/3x backing buffer to justify
      // its GPU cost (Pokemon and controls are crisp DOM layers). A universal
      // 1.5 DPR cap cuts the canvas allocation by 44% versus 2x and avoids
      // context eviction on high-density phones.
      var dpr=Math.min(window.devicePixelRatio||1,1.5);
      var r=new T.WebGLRenderer({antialias:false,alpha:false,powerPreference:'default'});
      r.setPixelRatio(dpr);r.setSize(w,h,false);
      // Three.js output colour-management API changed in r152 from
      // outputEncoding+sRGBEncoding to outputColorSpace+SRGBColorSpace.
      // Detect at runtime so the game works correctly with either version.
      if('outputColorSpace' in r&&typeof T.SRGBColorSpace!=='undefined'){r.outputColorSpace=T.SRGBColorSpace;}
      else if('outputEncoding' in r&&typeof T.sRGBEncoding!=='undefined'){r.outputEncoding=T.sRGBEncoding;}
      r.toneMapping=T.ACESFilmicToneMapping;r.toneMappingExposure=1.1;
      // Shadow config used to be applied 200ms after mount only, which meant a
      // recreated renderer silently lost its shadows. It belongs to creation.
      try{r.shadowMap.enabled=true;r.shadowMap.type=T.PCFSoftShadowMap;}catch(_){}
      var canvas=r.domElement,session=this,record=r;
      canvas.addEventListener('webglcontextlost',function(ev){
        // A disposed renderer's canvas may still deliver a late event; it
        // must not murder the healthy renderer that replaced it.
        if(session.renderer!==record)return;
        if(ev&&ev.preventDefault)ev.preventDefault();
        session._markLost(null);
        var current=session.owner;
        if(current)current._notifyContextLost(ev);
        session._scheduleRecover();
      });
      canvas.addEventListener('webglcontextrestored',function(ev){
        if(session.renderer!==record)return;
        // Three restores its internal GL resources (its own listener runs
        // first, registered in the renderer constructor). Reset cached state
        // before asking the current screen to rebuild only its scene graph.
        session._lost=false;session.state='ready';session.lastError=null;
        session._cancelRecover();
        try{if(session.renderer&&session.renderer.resetState)session.renderer.resetState();}catch(_){}
        var current=session.owner;
        if(current)current._notifyContextRestored(ev);
      });
      this.renderer=r;this.canvas=canvas;this._lost=false;
      return r;
    }catch(err){
      this.lastError=err;
      console.warn('[BattleUI] WebGL unavailable; using flat battle mode',err);
      return null;
    }
  },
  _disposeRenderer:function(){
    var old=this.renderer,oldCanvas=this.canvas||(old&&old.domElement);
    // Detach the dead canvas BEFORE forgetting it. Context recovery used to
    // leave every replaced canvas in the battle host; repeated losses then
    // stacked GPU surfaces until the browser reclaimed the whole 3D process.
    this.renderer=null;this.canvas=null;this._lost=false;
    if(oldCanvas&&oldCanvas.parentNode){try{oldCanvas.parentNode.removeChild(oldCanvas);}catch(_){}}
    if(old){try{if(old.dispose)old.dispose();}catch(_){}}
  },
  _markLost:function(err){
    this._lost=true;this.state='lost';if(err)this.lastError=err;
  },
  // Called by the current owner when IT detected the loss through the
  // renderer instead of a DOM event (a real WebKit behaviour). Guarantees the
  // recovery chain starts even when no canvas event ever arrives.
  noteLost:function(owner){
    if(this.owner!==owner)return;
    this._markLost(null);
    this._scheduleRecover();
  },
  // Background recovery. The only reason flat mode may be long-lived is a
  // machine that truly cannot create a WebGL context; everything else must
  // heal by itself. Each attempt disposes any dead renderer and builds a
  // fresh one; on success the live owner is offered the canvas in place.
  _scheduleRecover:function(){
    // An ownerless renderer is detached between screens. If its context is
    // reclaimed while idle, wait for the next acquire() instead of spinning
    // up replacement GPU contexts behind the title screen.
    if(!this.owner)return;
    if(this._recoverTimer)return;
    var delays=this.RECOVER_DELAYS;
    var delay=delays[Math.min(this._recoverDelay,delays.length-1)];
    this._recoverDelay+=1;
    var session=this;
    this._recoverTimer=setTimeout(function(){
      session._recoverTimer=null;
      if(session.healthy()){session.state='ready';return;}
      if(session.renderer)session._disposeRenderer();
      var w=0,h=0,o=session.owner;
      if(o&&o.host){w=o.host.clientWidth||0;h=o.host.clientHeight||0;}
      if(w<10){w=(typeof window!=='undefined'&&window.innerWidth)||640;}
      if(h<10){h=(typeof window!=='undefined'&&window.innerHeight)||480;}
      var r=session._createRenderer(w,h);
      if(!r){session.state='degraded';session._scheduleRecover();return;}
      session.state='ready';session.lastError=null;
      var current=session.owner;
      if(current&&current.s&&current.s.mounted&&!current._disposed){
        try{current._notifyRendererRecreated(r);}catch(_){}
      }
    },delay);
  },
  _cancelRecover:function(){
    if(this._recoverTimer){clearTimeout(this._recoverTimer);this._recoverTimer=null;}
    this._recoverDelay=0;
  },
  release:function(owner,host){
    // Nobody left to hand a recovered renderer to: pause background retries
    // (a later acquire re-arms them) so an idle game costs zero GPU work.
    if(this.owner===owner){this.owner=null;this._cancelRecover();}
    if(host&&this.canvas&&this.canvas.parentNode===host)host.removeChild(this.canvas);
  },
  reason:function(){
    if(this.state==='degraded')return 'unavailable';
    if(this.state==='lost')return 'context-lost';
    return 'webgl';
  }
};
function sharedRenderer(owner,w,h){return RendererSession.acquire(owner,w,h);}
function preload(url){
  if(!url)return null;
  if(FAILED[url])return null;
  if(CACHE[url])return CACHE[url];
  // Do NOT set crossOrigin: CORS-required taints non-CORS Showdown GIFs for DOM <img> display.
  // Images are only displayed as DOM <img> (never drawn to canvas / uploaded to WebGL),
  // so we don't need CORS permissions at all.
  var img=new Image();
  cachePut(url,img);img.decoding='async';
  // fetchPriority is a real browser hint on HTMLImageElement in Chromium/Safari 17+.
  try{if('fetchPriority' in img)img.fetchPriority='high';}catch(_){}
  img.onerror=function(){cacheFail(url);};
  img.src=url;
  return img;
}
function preloadList(urls){(urls||[]).forEach(preload);}
// True when this URL is a Showdown (or PokeAPI) *animated* GIF we should prefer
// over a static gen5 PNG placeholder.
function isAnimatedSpriteUrl(u){
  return typeof u==='string'&&/\.gif(?:$|\?)/i.test(u);
}

// Accessibility: respect the OS-level "reduce motion" preference. Functional
// animation (attack lunges, hit shake, damage popups, weather identification)
// stays, but continuous ambient motion -- idle sway, camera drift, drifting
// clouds and flies -- is dialled down to nothing so vestibular-sensitive
// players are not disturbed by a scene that never sits still.
var REDUCED_MOTION=false;
try{REDUCED_MOTION=!!(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches);}catch(e){}

function BattleUI(){
  this.host=null;this.r=null;this.sc=null;this.cam=null;this.environment=null;
  // Reuse frame-temporary vectors. The title and long battles used to allocate
  // four or more Vector3 objects every frame, creating needless mobile GC/GPU
  // pressure during the exact sessions most prone to context loss.
  this.clock=new T.Clock();this._tgt=new T.Vector3();
  this._camDest=new T.Vector3();this._lookDest=new T.Vector3();
  this.g={b:null,p:null,e:null,w:null,f:null};
  this.s={mounted:false,moment:'idle',mt:0,locked:false,
    // Player closer to camera (z=1.6); enemy pushed farther back (z=-3.0) so
    // perspective makes the enemy noticeably smaller and gives a classic
    // Pokemon "enemy is in the distance" framing.
    p:mkMon(-1.25,0,-0.7,2.4),e:mkMon(1.45,0,-3.6,2.4),
    msg:'',moves:[],mega:{cm:false,cx:false,cy:false,a:null},onMove:null,logs:[],ps:[],
    flies:null,clouds:[],wsys:null,w:null,
    hdr:{date:'',streak:0,best:0,dexV:false,dexN:0,dexT:0,sw:'streak'}
  };
  this._dom={};this._hostRect={width:0,height:0};this._hostRectAge=0;this._audio=null;
  this._cryQueue=[];this._cryPlaying=false;this._suppressAutoCries=false;
  this._onResize=this._onResize.bind(this);this._anim=this._anim.bind(this);
  this._mountAttempts=0;this._momentTouts=[];
  // WebGL context events are part of the renderer lifecycle, not battle
  // gameplay. The shared renderer owns the actual context lifecycle; screen
  // instances only report loss/restoration and move the canvas between hosts.
  // This prevents ordinary title/battle churn from manufacturing contexts and
  // stops a stale screen from reporting a teardown as a GPU failure.
  this._contextLostHandler=null;this._contextRestoredHandler=null;
  this._contextLostNotified=false;this._unmounting=false;
  this._mountFailed=false;this._mountFailedError=null;this._errorNotified=false;
  this.flat=false;this._flatReason='';
  // A decorative scene may use the same DOM-sprite/camera pipeline without
  // ever acquiring WebGL. The title uses this so only actual battles touch the
  // GPU; `flatOnly` is intentional and must not trigger an unavailable toast.
  this.flatOnly=false;
  // Ops requested before mount() finished; replayed by _flushPending().
  this._pending=[];this._disposed=false;
  this.onMountError=null;this.onError=null;
}
function mkMon(x,y,z,h){return{name:'',lv:100,types:[],hp:1,max:100,st:null,pos:new T.Vector3(x,y,z),h:h,sid:null,num:0,sh:null,shGrp:null,img:null,grp:null,tu:null,url:null,ar:1,fadeT:0,appearT:0,offX:0,offY:0,offZ:0,rotZ:0,tintW:1,lastCrySid:null,headV:new T.Vector3(),feetV:new T.Vector3()};}
BattleUI.preload=preload;BattleUI.preloadList=preloadList;

// Anything that needs the live scene (biome, sprites, bursts) is queued while
// the mount is still deferred and replayed the moment it completes. Before this
// existed, `setupBattle()` called on a not-yet-mounted UI threw on `this.sc`
// and the battle silently never started -- the single most common cause of the
// game "not loading the battle".
// Returns true when the caller may proceed inline (we're mounted), false when
// the work has been queued for _flushPending() instead. The caller must NOT be
// re-invoked here on the ready path -- doing so re-enters this same guard and
// recurses forever.
BattleUI.prototype._reportError=function(err){
  if(this._disposed||this._unmounting||this._errorNotified)return;
  this._errorNotified=true;
  this.s.mounted=false;
  if(this._raf){cancelAnimationFrame(this._raf);this._raf=null;}
  var e=err instanceof Error?err:new Error(String(err||'Unknown renderer error'));
  console.error('[BattleUI] renderer error',e);
  if(this.onError){try{this.onError(this,e);}catch(_) {}}
};
BattleUI.prototype._failMount=function(host,err){
  if(this._mountFailed)return;
  this._mountFailed=true;
  this._mountFailedError=err instanceof Error?err:new Error(String(err||'Battle renderer failed to mount'));
  this.s.mounted=false;this._unmounting=true;this._disposed=true;this._pending=[];
  if(host&&host._bm===this)host._bm=null;
  console.error('[BattleUI] mount unavailable',this._mountFailedError);
  if(this.onMountError){try{this.onMountError(this,this._mountFailedError);}catch(_) {}}
};
BattleUI.prototype._whenMounted=function(fn){
  if(this._disposed)return false;
  if(this.s.mounted&&this.sc)return true;
  this._pending.push(fn);
  return false;
};
BattleUI.prototype._flushPending=function(){
  var q=this._pending;this._pending=[];
  for(var i=0;i<q.length;i++){
    try{q[i].call(this);}catch(e){this._reportError(e);break;}
  }
};
// Some browsers report a lost context through the renderer before the DOM
// event reaches the canvas. Keep one idempotent path for both cases.
BattleUI.prototype.enterFlatMode=function(reason){
  this.flat=true;this._flatReason=reason||this._flatReason||'webgl';
  if(this.host){
    this.host.classList.add('battle-flat');
    this.host.style.background=this._flatBackground(this.s.biomeKey||'meadow');
  }
};
BattleUI.prototype._flatBackground=function(key){
  var b=BIOMES[key]||BIOMES.meadow;
  function hex(n){return '#'+('000000'+Number(n||0).toString(16)).slice(-6);}
  return 'linear-gradient(180deg,'+hex(b.sky)+' 0%, '+hex(b.fog&&b.fog[0])+' 48%, '+hex(b.g)+' 100%)';
};
BattleUI.prototype._notifyContextLost=function(ev){
  if(this._disposed||this._unmounting||this._contextLostNotified)return;
  this._contextLostNotified=true;
  if(ev&&ev.preventDefault)ev.preventDefault();
  // Keep the DOM battle alive while the session replaces the dead context.
  // A context loss is cosmetic here; the player can continue in flat mode
  // instead of being thrown into a dead-end error panel.
  this.enterFlatMode('context-lost');
  // Tell the session a loss was observed through the renderer (not a DOM
  // event) so the recreation chain always starts; this is a no-op when the
  // canvas event already did it.
  try{RendererSession.noteLost(this);}catch(_){}
  if(this.onContextLost){try{this.onContextLost(this,ev);}catch(_) {}}
};
BattleUI.prototype._notifyContextRestored=function(ev){
  if(this._disposed||this._unmounting)return;
  this._contextLostNotified=false;
  // If the same context genuinely came back, drop flat mode immediately so
  // the 3D scene resumes even when no app-level rebuild happens.
  try{if(this.flat&&this.r&&RendererSession.healthy())this.attachRenderer(this.r);}catch(_){}
  if(this.onContextRestored){try{this.onContextRestored(this,ev);}catch(_) {}}
};
// The session created a FRESH renderer after a loss/creation failure and is
// handing it to this live screen. Attach in place: the scene graph and DOM
// battle state are renderer-agnostic, so the battle continues exactly where
// it was -- just in 3D again.
BattleUI.prototype._notifyRendererRecreated=function(r){
  if(this._disposed||this._unmounting||!this.s.mounted||!r)return;
  this._contextLostNotified=false;
  this.attachRenderer(r);
};
// Another screen took the shared renderer over (navigation race). Stay
// playable in flat mode instead of crashing the mount that replaced us.
BattleUI.prototype._notifyRendererReclaimed=function(){
  if(this._disposed||this._unmounting)return;
  this.r=null;
  this.enterFlatMode('reclaimed');
  if(this.onContextLost){try{this.onContextLost(this,null);}catch(_) {}}
};
// Put the optional session canvas above the CSS environment and leave flat
// mode. Idempotent for both initial mount and mid-session recovery.
BattleUI.prototype.attachRenderer=function(r){
  if(!r||this._disposed||this._unmounting||!this.host)return;
  this.r=r;
  this._renderErrs=0;
  var d=r.domElement;
  d.style.cssText='display:block;position:absolute;inset:0;width:100%;height:100%;z-index:1;';
  // A renderer replacement must leave exactly one canvas. This is also a
  // defensive sweep for sessions created by older cached builds that leaked a
  // dead canvas before the current service worker took over.
  var canvases=this.host.querySelectorAll('canvas');
  for(var i=0;i<canvases.length;i++)if(canvases[i]!==d&&canvases[i].parentNode===this.host)this.host.removeChild(canvases[i]);
  if(d.parentNode!==this.host)this.host.insertBefore(d,this.host.firstChild);
  this.exitFlatMode();
  try{this._onResize();}catch(_){}
};
BattleUI.prototype.exitFlatMode=function(){
  this.flat=false;this._flatReason='';
  if(this.host){
    this.host.classList.remove('battle-flat');
    this.host.style.background='';
  }
};

BattleUI.prototype.mount = function(host){
  if(!host||this._disposed)return;
  if(host._bm&&host._bm!==this){
    throw new Error('The battle host is already mounted by another renderer.');
  }
  this.host=host;
  if(!window.THREE){
    var selfT=this;
    if(this._mountAttempts++>200){
      this._failMount(host,new Error('The 3D engine did not finish loading.'));
      return;
    }
    setTimeout(function(){selfT.mount(host);},30);return;
  }
  var w=host.clientWidth,h=host.clientHeight;
  if(w<10||h<10){
    // The host can legitimately be 0x0 for a frame or two right after its
    // screen is unhidden. Retry, but never give up entirely: fall back to the
    // window box so a battle always renders instead of hanging forever.
    if(this._mountAttempts++<120){var retrySelf=this;requestAnimationFrame(function(){retrySelf.mount(host);});return;}
    w=window.innerWidth;h=window.innerHeight;
    if(w<10||h<10){
      this._failMount(host,new Error('The battle scene never became visible.'));
      return;
    }
  }
  this._mountAttempts=0;
  this._unmounting=false;
  this._contextLostNotified=false;
  host._bm=this;host.innerHTML='';
  host.style.cssText='position:absolute;inset:0;overflow:hidden;';
  var self=this;
  try{
    injectCSS();
    // Layer 0: an always-available CSS perspective environment. It remains
    // under the WebGL canvas when 3D is healthy and is already painted if the
    // browser refuses or loses its GPU context.
    buildDomEnvironment(this);
    // Layer 1: optional WebGL scenery. The session always tries to hand
    // back a healthy renderer -- reusing the live one or creating a fresh one
    // if the last screen left a corpse behind. If WebGL cannot be created
    // right now, keep building the DOM layers in flat mode so the battle
    // remains playable; the session's background recovery will upgrade this
    // exact mount to 3D as soon as a context exists again.
    var r=this.flatOnly?null:sharedRenderer(this,w,h);
    if(r){
      this.attachRenderer(r);
    }else{
      this.r=null;
      this.enterFlatMode(this.flatOnly?'flat-only':RendererSession.reason());
    }
    var sc=new T.Scene();this.sc=sc;sc.background=new T.Color(0x70c3e8);
    var cam=new T.PerspectiveCamera(45,w/Math.max(1,h),0.1,200);
    cam.position.set(0,4.8,10.5);cam.lookAt(0,1.2,0);this.cam=cam;
    // Layer 2: Sprite container (projected <img> elements, above either scenery implementation)
    var sp=document.createElement('div');sp.className='bm-sprites';
    sp.style.cssText='position:absolute;inset:0;z-index:2;pointer-events:none;overflow:visible;';
    host.appendChild(sp);this.sprites=sp;
    // Layer 3: HUD (glass UI + floaters)
    var hud=document.createElement('div');hud.className='battle-hud';
    hud.style.cssText='position:absolute;inset:0;pointer-events:none;font-family:VT323,"Courier New",monospace;color:#fff;overflow:visible;z-index:3;';
    host.appendChild(hud);this.hud=hud;
    injectCSS();
    ['b','p','e','w','f'].forEach(function(k){this.g[k]=new T.Group();sc.add(this.g[k]);},this);
    // Build ENEMY first, then PLAYER, so player (closer to camera) is added later
    // in both the 3D scene and the DOM — DOM paints later siblings on top, which
    // is what we want: closer (player) renders in front of farther (enemy).
    buildShadow(this,'e');buildShadow(this,'p');
    buildSpriteDom(this,'e');buildSpriteDom(this,'p');
    buildWeather(this);buildField(this);this.buildBiome('meadow');
    // Shadow maps are configured on the renderer at creation time (see
    // RendererSession._createRenderer), including after any recreation.
    window.addEventListener('resize',this._onResize);
    // A context can disappear while the scene is being assembled. The shared
    // listener has already switched this instance to flat mode, so it is still
    // safe to finish the DOM scene and keep the battle playable.
    this.s.mounted=true;
    this._raf=requestAnimationFrame(this._anim);
    this.render();
    requestAnimationFrame(function(){self._onResize();});
    // Replay anything the game asked for while we were still waiting on layout.
    this._flushPending();
  }catch(err){
    this._mountFailed=true;this._mountFailedError=err;
    // Transactional mount: a throw halfway through must not leave a
    // half-built scene (canvas, sprites, HUD) or a zombie mount flag that
    // blocks the next battle. Clean up, mark disposed, and let the app own
    // the error UX via battleFailed().
    this._unmounting=true;
    try{
      if(this._raf){cancelAnimationFrame(this._raf);this._raf=null;}
      window.removeEventListener('resize',this._onResize);
      RendererSession.release(this,host);
      if(this.sprites&&this.sprites.parentNode)this.sprites.parentNode.removeChild(this.sprites);
      if(this.hud&&this.hud.parentNode)this.hud.parentNode.removeChild(this.hud);
      if(this.environment&&this.environment.parentNode)this.environment.parentNode.removeChild(this.environment);
      if(host)host._bm=null;
    }catch(_){}
    this.r=null;this.sc=null;this.cam=null;this.sprites=null;this.hud=null;this.environment=null;this.host=null;
    this._contextLostHandler=null;this._contextRestoredHandler=null;
    this._disposed=true;this._pending=[];
    console.error('[BattleUI] mount failed',err);
    throw new Error('BattleUI could not mount: '+((err&&err.message)||String(err)),{cause:err});
  }
};

BattleUI.prototype.unmount = function(){
  this.s.mounted=false;
  // A disposed instance must never resurrect itself through a queued retry.
  // Mark the teardown before removing the listeners/forcing context loss so a
  // browser that dispatches webglcontextlost synchronously cannot call back
  // into the app while it is halfway through unmounting.
  this._unmounting=true;this._disposed=true;this._pending=[];
  if(this._raf)cancelAnimationFrame(this._raf);
  this._raf=null;
  if(this._momentTouts){this._momentTouts.forEach(function(t){clearTimeout(t);});}this._momentTouts=[];
  window.removeEventListener('resize',this._onResize);
  // The shared WebGL renderer belongs to the session, not this screen. Move
  // its canvas out of the host and keep the context alive for the next screen.
  RendererSession.release(this,this.host);
  if(this.sprites&&this.sprites.parentNode)this.sprites.parentNode.removeChild(this.sprites);
  if(this.hud&&this.hud.parentNode)this.hud.parentNode.removeChild(this.hud);
  if(this.environment&&this.environment.parentNode)this.environment.parentNode.removeChild(this.environment);
  if(this.host){
    this.host._bm=null;
    this.host.classList.remove('battle-flat');
    this.host.style.background='';
  }
  // Procedural terrain/room textures are cached outside the material tree.
  // Dispose every cached texture when a scene ends or repeated battles retain
  // GPU allocations even though their geometry and materials are gone.
  var field=this.s&&this.s.field;
  if(field&&field.tex){for(var tx in field.tex){try{if(field.tex[tx]&&field.tex[tx].dispose)field.tex[tx].dispose();}catch(_){}}field.tex={};}
  if(this.sc){try{this.sc.traverse(function(o){if(o.geometry)o.geometry.dispose();if(o.material){if(Array.isArray(o.material))o.material.forEach(function(m){m.dispose();});else o.material.dispose();}});}catch(_) {}}
  this._contextLostHandler=null;this._contextRestoredHandler=null;
  this.r=null;this.sc=null;this.cam=null;this.hud=null;this.sprites=null;this.environment=null;this._dom={};
};
BattleUI.prototype._onResize=function(){
  if(!this.host||!this.cam)return;
  var w=this.host.clientWidth,h=this.host.clientHeight;
  if(w<10||h<10){w=window.innerWidth;h=window.innerHeight;}
  // A setSize throw here (e.g. during a context restore) must never bubble to
  // the window error handler -- the next resize/frame simply retries.
  if(this.r&&!this.flat){try{this.r.setSize(w,h,false);}catch(_){}}
  this.cam.aspect=w/Math.max(1,h);this.cam.updateProjectionMatrix();
  // Invalidate cached host rect so the next frame picks up the new size.
  this._hostRectAge=-1;
};

// The compatibility environment is real DOM/CSS, not a screenshot. Layered
// sky, hills, perspective ground and battle platforms preserve the scene's
// depth on every browser, including devices where WebGL is disabled or lost.
function buildDomEnvironment(ui){
  var env=document.createElement('div');
  env.className='bm-env';env.setAttribute('aria-hidden','true');
  env.innerHTML=
    '<div class="be-sky"><i class="be-sun"></i><i class="be-cloud c1"></i><i class="be-cloud c2"></i></div>'+
    '<div class="be-horizon"><i class="be-hill h1"></i><i class="be-hill h2"></i><i class="be-hill h3"></i></div>'+
    '<div class="be-ground"><i class="be-grid"></i></div>'+
    '<div class="be-decor"><i class="d1"></i><i class="d2"></i><i class="d3"></i><i class="d4"></i></div>'+
    '<i class="be-platform enemy"></i><i class="be-platform player"></i>'+
    '<div class="be-field"></div><div class="be-weather"></div><div class="be-room"></div>'+
    '<div class="be-depth-fog"></div>';
  ui.host.appendChild(env);ui.environment=env;
}
function cssHex(n){return '#'+('000000'+Number(n||0).toString(16)).slice(-6);}
function applyDomBiome(ui,key,b){
  var env=ui.environment;if(!env||!b)return;
  env.dataset.biome=key||'meadow';
  env.style.setProperty('--be-sky',cssHex(b.sky));
  env.style.setProperty('--be-fog',cssHex(b.fog&&b.fog[0]));
  env.style.setProperty('--be-ground',cssHex(b.g));
  env.style.setProperty('--be-ground-dark',cssHex(b.d));
  env.style.setProperty('--be-hill',cssHex((b.hills&&b.hills[0]&&b.hills[0][4])||b.d));
  env.style.setProperty('--be-hill-far',cssHex((b.hills&&b.hills[2]&&b.hills[2][4])||b.d));
  env.style.setProperty('--be-accent',cssHex((b.pf&&b.pf[1])||b.stripe||b.g));
  env.style.setProperty('--be-platform',cssHex((b.pf&&b.pf[0])||b.g));
  env.style.setProperty('--be-cloud',cssHex(b.cc||0xffffff));
}

function buildShadow(ui,k){
  var s=ui.s[k];s.grp=new T.Group();
  s.sh=new T.Mesh(dg(1.0,28),bm(0x000000,{transparent:true,opacity:0,depthWrite:false}));
  s.sh.rotation.x=-Math.PI/2;s.sh.position.set(0,0.11,0);
  s.grp.add(s.sh);s.grp.position.copy(s.pos);ui.g[k].add(s.grp);
}
function buildSpriteDom(ui,k){
  var s=ui.s[k];
  var img=document.createElement('img');img.alt='';img.draggable=false;
  img.style.cssText=[
    'position:absolute','left:0','top:0',
    'width:0','height:0',
    'opacity:0',
    'transform:translate(-50%,-100%)',
    'image-rendering:pixelated','image-rendering:crisp-edges','image-rendering:-moz-crisp-edges',
    'pointer-events:none','will-change:transform,opacity',
    'user-select:none','-webkit-user-drag:none'
  ].join(';')+';';
  // NO crossOrigin on DOM imgs — CORS is only needed for WebGL/canvas readback;
  // leaving it off lets the browser load non-CORS Showdown GIFs as <img> elements.
  ui.sprites.appendChild(img);s.img=img;
}

function clrGrp(g){while(g.children.length){var c=g.children.pop();try{c.traverse(function(o){if(o.geometry)o.geometry.dispose();if(o.material){if(Array.isArray(o.material)){o.material.forEach(function(m){m.dispose();});}else o.material.dispose();}});}catch(_){}}}

BattleUI.prototype.buildBiome=function(key){
  if(!this._whenMounted(function(){this.buildBiome(key);}))return;
  var b=BIOMES[key]||BIOMES.meadow;
  applyDomBiome(this,key,b);
  var bg=this.g.b;clrGrp(bg);
  this.s.biomeKey=key;
  if(this.flat&&this.host)this.host.style.background=this._flatBackground(key);
  this.sc.background=new T.Color(b.sky);this.sc.fog=new T.Fog(b.fog[0],b.fog[1],b.fog[2]);
  var amb=new T.AmbientLight(b.a[0],b.a[1]);bg.add(amb);
  var sun=new T.DirectionalLight(b.s[0],b.s[1]);sun.position.set(b.s[2][0],b.s[2][1],b.s[2][2]);
  sun.castShadow=true;sun.shadow.mapSize.set(512,512);var sc=sun.shadow.camera;sc.left=-12;sc.right=12;sc.top=12;sc.bottom=-12;sc.near=0.1;sc.far=40;sun.shadow.bias=-0.002;
  bg.add(sun);
  var ground=new T.Mesh(pg(80,80),sm(b.g,{roughness:0.95}));ground.rotation.x=-Math.PI/2;ground.position.y=-0.05;ground.receiveShadow=true;bg.add(ground);
  if(b.stripe){var st=new T.Mesh(pg(80,10),bm(b.stripe,{transparent:true,opacity:0.25,depthWrite:false}));st.rotation.x=-Math.PI/2;st.position.set(0,-0.02,-4);bg.add(st);}
  for(var i=0;i<b.hills.length;i++){var h=b.hills[i];var hm=new T.Mesh(sg(h[3],12,8),sm(h[4]));hm.position.set(h[0],h[1],h[2]);hm.receiveShadow=true;bg.add(hm);}
  for(var j=0;j<b.trees.length;j++)addTree(bg,b.trees[j],b.trunk);
  addPillars(bg,b.pillars);
  addWalls(bg,b.walls);
  if(b.glow)addGroundGlow(bg,b.glow,b.glowN||18);
  // Platforms are DERIVED from the live sprite slots, never hardcoded. They
  // used to be literals matching the original slots, so when the combatants
  // were repositioned the Pokemon ended up floating off their circles.
  var pp0=this.s.p.pos,ep0=this.s.e.pos;
  addPlat(bg,pp0.x,0.04,pp0.z,2.0,b.pf);addPlat(bg,ep0.x,0.04,ep0.z,2.2,b.pf);
  addFlowers(bg,b.fl);
  this.s.flies=addFlies(bg,b.fc);this.s.clouds=addClouds(bg,b.cc);
  // Remember the pristine biome look. Weather eases AWAY from these values and
  // back to them when it lifts, so a biome change never strands a tinted sky.
  this.s.lt={amb:amb,sun:sun};
  this.s.base={sky:new T.Color(b.sky),fog:new T.Color(b.fog[0]),fn:b.fog[1],ff:b.fog[2],
               ambC:new T.Color(b.a[0]),ambI:b.a[1],sunC:new T.Color(b.s[0]),sunI:b.s[1]};
  this.setWeather(this.s.w||b.wth);
};
function addTree(g,t,trunk){var tr=new T.Mesh(cg(0.18,0.24,t[3],6),sm(trunk));tr.position.set(t[0],t[3]/2,t[2]);tr.castShadow=true;g.add(tr);var lf=new T.Mesh(sg(t[3]*0.6,10,6),sm(t[4],{roughness:0.9}));lf.position.set(t[0],t[3]+0.2,t[2]);lf.castShadow=true;g.add(lf);}
function addPlat(g,x,y,z,s,c){var pg2=new T.Group();pg2.position.set(x,y,z);function d(r,oy,cc){var m=new T.Mesh(dg(r,28),sm(cc));m.rotation.x=-Math.PI/2;m.position.y=oy;m.receiveShadow=true;pg2.add(m);}d(s,0,c[0]);d(s*0.82,0.02,c[1]);d(s*0.6,0.04,c[2]);g.add(pg2);}
function addPillars(g,pils){if(!pils)return;for(var i=0;i<pils.length;i++){var p=pils[i];var h=p[4]||3,r=p[3]||0.25;var tr=new T.Mesh(cg(r*0.85,r,h,8),sm(p[5]||0x808080));tr.position.set(p[0],h/2,p[2]);tr.castShadow=true;g.add(tr);var cap=new T.Mesh(cg(r*1.3,r*1.15,0.3,8),sm(p[5]||0x808080,{roughness:0.8}));cap.position.set(p[0],h+0.15,p[2]);cap.castShadow=true;g.add(cap);}}
function addWalls(g,walls){if(!walls)return;for(var i=0;i<walls.length;i++){var w=walls[i];var geo=new T.BoxGeometry(w[3]||4,w[4]||2.5,w[5]||0.5);var m=new T.Mesh(geo,sm(w[6]||0x808080,{roughness:0.92}));m.position.set(w[0],(w[4]||2.5)/2,w[2]);m.receiveShadow=true;m.castShadow=true;g.add(m);}}
function addGroundGlow(g,col,count){if(!col)return;count=count||18;var geo=new T.BufferGeometry(),p=new Float32Array(count*3),c=new Float32Array(count*3);for(var i=0;i<count;i++){p[i*3]=(Math.random()-0.5)*16;p[i*3+1]=0.05+Math.random()*0.3;p[i*3+2]=(Math.random()-0.5)*12-1;var cc=new T.Color(col);c[i*3]=cc.r;c[i*3+1]=cc.g;c[i*3+2]=cc.b;}geo.setAttribute('position',new T.BufferAttribute(p,3));geo.setAttribute('color',new T.BufferAttribute(c,3));var pt=new T.Points(geo,new T.PointsMaterial({size:0.18,vertexColors:true,transparent:true,opacity:0.7,depthWrite:false,sizeAttenuation:true}));g.add(pt);return pt;}
function addFlowers(g,cols){if(!cols||!cols.length)return;for(var i=0;i<32;i++){var a=i*137.5*Math.PI/180,rr=2.8+(i%8)*0.45,x=Math.cos(a)*rr,zz=Math.sin(a)*rr-0.5,c=cols[i%cols.length];var pe=new T.Mesh(pg(0.1,0.2),bm(c,{side:T.DoubleSide,transparent:true,depthWrite:false}));pe.position.set(x,0.08,zz);pe.rotation.set(-Math.PI/2,0,i%5*0.5);g.add(pe);}}
function addFlies(g,cols){var n=22,geo=new T.BufferGeometry(),p=new Float32Array(n*3),c=new Float32Array(n*3),mm=[];for(var i=0;i<n;i++){p[i*3]=(Math.random()-0.5)*14;p[i*3+1]=Math.random()*4+0.5;p[i*3+2]=(Math.random()-0.5)*10-2;var cc=new T.Color(cols[i%cols.length]);c[i*3]=cc.r;c[i*3+1]=cc.g;c[i*3+2]=cc.b;mm.push({s:0.2+Math.random()*0.4,ph:Math.random()*Math.PI*2});}geo.setAttribute('position',new T.BufferAttribute(p,3));geo.setAttribute('color',new T.BufferAttribute(c,3));var pt=new T.Points(geo,new T.PointsMaterial({size:0.1,vertexColors:true,transparent:true,opacity:0.9,depthWrite:false,sizeAttenuation:true}));g.add(pt);return{pt:pt,m:mm};}
function addClouds(g,col){var cg2=new T.Group();var mat=new T.MeshStandardMaterial({color:col,roughness:1,transparent:true,opacity:0.85,depthWrite:false});function mk(x,y,z,s){var cl=new T.Group();var nn=3+Math.floor(Math.random()*2);for(var i=0;i<nn;i++){var p=new T.Mesh(new T.SphereGeometry(0.8+Math.random()*0.7,7,5),mat);p.position.set((Math.random()-0.5)*2*s,(Math.random()-0.3)*0.5*s,(Math.random()-0.5)*1.2*s);p.scale.setScalar(0.6+Math.random()*0.5);cl.add(p);}cl.position.set(x,y,z);cg2.add(cl);return cl;}var clouds=[mk(-5,6,-8,1.3),mk(6,7,-10,1.5),mk(0,8,-12,1.2)];g.add(cg2);return clouds;}
function buildWeather(ui){var w=new T.Group();ui.g.w.add(w);function mk(n,c,sz,vy,opa){var geo=new T.BufferGeometry();var p=new Float32Array(n*3);var v=new Float32Array(n*3);for(var i=0;i<n;i++){p[i*3]=(Math.random()-0.5)*40;p[i*3+1]=Math.random()*18;p[i*3+2]=(Math.random()-0.5)*25;v[i*3]=(Math.random()-0.5)*0.3;v[i*3+1]=vy*(0.8+Math.random()*0.4);v[i*3+2]=(Math.random()-0.5)*0.3;}geo.setAttribute('position',new T.BufferAttribute(p,3));var pt=new T.Points(geo,new T.PointsMaterial({color:c,size:sz,transparent:true,opacity:opa,depthWrite:false,sizeAttenuation:true}));pt.userData={v:v,n:n};pt.visible=false;w.add(pt);return pt;}ui.s.wsys={rain:mk(900,0xcfe0ff,0.075,-16,0.85),snow:mk(250,0xffffff,0.1,-1.0,0.85),sand:mk(300,0xe0b868,0.12,-2,0.5),hail:mk(220,0xd8efff,0.09,-9,0.7),sunmotes:mk(90,0xfff0c0,0.07,-0.35,0.5)};}

// ===================== FIELD EFFECTS =====================
// Weather / terrain / room each own a distinct, readable visual language:
//   weather -> particles + sky, fog and light grading (the whole world changes)
//   terrain -> a glowing disc laid ON the battlefield floor (ground-level only)
//   room    -> a full-screen enclosing volume (grid walls / inverted tint)
// They compose: Trick Room during Rain on Electric Terrain all read at once.

// --- how each weather grades the scene ---
var WEATHER_LOOK = {
  rain:  {sky:0x37414f,fog:0x39434f,fogN:8, fogF:38,amb:0x8fa4c0,ambI:0.85,sun:0x9fb4d8,sunI:0.55,tint:0x22335c,tintO:0.26},
  sun:   {sky:0xffd9a0,fog:0xffcf95,fogN:14,fogF:60,amb:0xfff0d0,ambI:1.45,sun:0xfff2c8,sunI:1.9, tint:0xffa326,tintO:0.20},
  sand:  {sky:0xc9a469,fog:0xc2a06a,fogN:5, fogF:26,amb:0xe8cf9c,ambI:1.0, sun:0xffe0a0,sunI:0.9, tint:0xc4832a,tintO:0.30},
  hail:  {sky:0x9fb6c8,fog:0xa8bccc,fogN:7, fogF:32,amb:0xd8e8f5,ambI:1.1, sun:0xe8f4ff,sunI:0.8, tint:0x9ad4f5,tintO:0.22},
  snow:  {sky:0xbcc9d6,fog:0xc3ced9,fogN:7, fogF:34,amb:0xe4eef8,ambI:1.15,sun:0xf0f7ff,sunI:0.75,tint:0xcfe6f7,tintO:0.24}
};

// --- terrain discs: colour + the pattern drawn into their texture ---
var TERRAIN_LOOK = {
  electric: {c:0xf7e14a,c2:0xfff8b0,pat:'bolt'},
  grassy:   {c:0x6ddc63,c2:0xc4f5a0,pat:'blade'},
  misty:    {c:0xf5a0e0,c2:0xffd8f4,pat:'swirl'},
  psychic:  {c:0xb47cff,c2:0xe6ccff,pat:'grid'}
};

// Procedural terrain texture — a soft radial glow plus a motif, so each terrain
// is identifiable at a glance without shipping any image assets.
// Bold floor grid for a Room. Thick lines on transparent, so it reads as a
// hard geometric overlay on the natural battlefield.
function roomTex(hex){
  var S=256,cv=document.createElement('canvas');cv.width=cv.height=S;
  var x=cv.getContext('2d');
  if(!x){var fbTx=new T.Texture(cv);fbTx.needsUpdate=true;return fbTx;}
  x.strokeStyle=hex;x.lineWidth=9;x.globalAlpha=1;
  for(var i=0;i<=6;i++){var q=i*S/6;
    x.beginPath();x.moveTo(q,0);x.lineTo(q,S);x.stroke();
    x.beginPath();x.moveTo(0,q);x.lineTo(S,q);x.stroke();}
  var tx=new T.Texture(cv);tx.needsUpdate=true;
  tx.wrapS=tx.wrapT=T.RepeatWrapping;tx.repeat.set(2,2);
  if('colorSpace' in tx&&typeof T.SRGBColorSpace!=='undefined')tx.colorSpace=T.SRGBColorSpace;
  else if('encoding' in tx&&typeof T.sRGBEncoding!=='undefined')tx.encoding=T.sRGBEncoding;
  return tx;
}
function terrainTex(look){
  var S=256,cv=document.createElement('canvas');cv.width=cv.height=S;
  var x=cv.getContext('2d');
  if(!x){var fbTx=new T.Texture(cv);fbTx.needsUpdate=true;return fbTx;}
  var hexA='#'+('000000'+look.c.toString(16)).slice(-6);
  var hexB='#'+('000000'+look.c2.toString(16)).slice(-6);
  // Hold the colour out to ~78% of the radius, then fade fast. A gradient that
  // starts fading at the centre leaves only a washed-out rim visible, because
  // the camera only ever frames the middle of the disc.
  var g=x.createRadialGradient(S/2,S/2,S*0.05,S/2,S/2,S/2);
  g.addColorStop(0,hexB);g.addColorStop(0.45,hexA);g.addColorStop(0.78,hexA);
  g.addColorStop(1,'rgba(0,0,0,0)');
  x.fillStyle=g;x.beginPath();x.arc(S/2,S/2,S/2,0,6.2832);x.fill();
  x.strokeStyle=hexB;x.globalAlpha=0.85;
  if(look.pat==='grid'){
    x.lineWidth=2;
    for(var i=1;i<8;i++){var q=i*S/8;
      x.beginPath();x.moveTo(q,0);x.lineTo(q,S);x.stroke();
      x.beginPath();x.moveTo(0,q);x.lineTo(S,q);x.stroke();}
  }else if(look.pat==='bolt'){
    x.lineWidth=5;x.lineCap='round';
    for(var b=0;b<8;b++){var a=b*Math.PI/4,r0=S*0.16,r1=S*0.42;
      var cx=S/2,cy=S/2,mx=cx+Math.cos(a+0.22)*(r0+r1)/2,my=cy+Math.sin(a+0.22)*(r0+r1)/2;
      x.beginPath();x.moveTo(cx+Math.cos(a)*r0,cy+Math.sin(a)*r0);
      x.lineTo(mx,my);x.lineTo(cx+Math.cos(a)*r1,cy+Math.sin(a)*r1);x.stroke();}
  }else if(look.pat==='blade'){
    x.lineWidth=4;x.lineCap='round';
    for(var v=0;v<40;v++){var aa=v*137.5*Math.PI/180,rr=S*0.12+(v%9)*S*0.035;
      var px=S/2+Math.cos(aa)*rr,py=S/2+Math.sin(aa)*rr;
      x.beginPath();x.moveTo(px,py+9);x.quadraticCurveTo(px+3,py+1,px+1,py-9);x.stroke();}
  }else{ // swirl
    x.lineWidth=3;
    for(var w2=0;w2<3;w2++){x.beginPath();
      for(var th=0;th<Math.PI*4;th+=0.12){var rd=S*0.06+th*S*0.028;
        var sx=S/2+Math.cos(th+w2*2.1)*rd,sy=S/2+Math.sin(th+w2*2.1)*rd;
        th===0?x.moveTo(sx,sy):x.lineTo(sx,sy);}
      x.stroke();}
  }
  var tx=new T.Texture(cv);tx.needsUpdate=true;
  // Match roomTex: without an sRGB tag the pattern is double-transformed by an
  // sRGB-output renderer and reads washed out.
  if('colorSpace' in tx&&typeof T.SRGBColorSpace!=='undefined')tx.colorSpace=T.SRGBColorSpace;
  else if('encoding' in tx&&typeof T.sRGBEncoding!=='undefined')tx.encoding=T.sRGBEncoding;
  return tx;
}

var ROOM_LOOK={
  trickroom:  {c:0xff5fd0,grid:0xffb0ec},
  wonderroom: {c:0x5fe0d0,grid:0xb0fff4},
  magicroom:  {c:0xffc861,grid:0xffe6b0}
};

// Build the persistent field rig once: a terrain disc, a room shell and a
// full-screen colour wash. They are hidden until something turns them on.
function buildField(ui){
  var g=new T.Group();ui.g.w.add(g);

  // -- terrain: a disc hugging the ground, plus a thin rim of light --
  var disc=new T.Mesh(new T.CircleGeometry(7.2,64),
    new T.MeshBasicMaterial({transparent:true,opacity:0,depthWrite:false,
      side:T.DoubleSide}));
  disc.rotation.x=-Math.PI/2;disc.position.y=0.015;disc.visible=false;g.add(disc);
  var ring=new T.Mesh(new T.RingGeometry(6.7,7.3,64),
    new T.MeshBasicMaterial({transparent:true,opacity:0,depthWrite:false,
      side:T.DoubleSide}));
  ring.rotation.x=-Math.PI/2;ring.position.y=0.05;ring.visible=false;g.add(ring);

  // -- room: an enclosing box of grid lines around the whole arena --
  var room=new T.Group();room.visible=false;g.add(room);
  var box=new T.Mesh(new T.BoxGeometry(19,11,19),
    new T.MeshBasicMaterial({transparent:true,opacity:0,depthWrite:false,
      fog:false,side:T.BackSide}));
  box.position.y=4.6;room.add(box);
  var grid=new T.LineSegments(new T.EdgesGeometry(new T.BoxGeometry(19,11,19)),
    new T.LineBasicMaterial({transparent:true,opacity:0,fog:false}));
  grid.position.y=4.6;room.add(grid);
  // interior lattice so the "room" reads as a volume, not just an outline
  var lat=new T.LineSegments(new T.WireframeGeometry(new T.BoxGeometry(19,11,19,4,3,4)),
    new T.LineBasicMaterial({transparent:true,opacity:0,fog:false}));
  lat.position.y=4.6;room.add(lat);

  // -- terrain motes: drifting specks rising off the field. A flat disc alone
  //    is foreshortened to near-nothing at this camera angle; vertical motion
  //    is what actually makes a terrain readable. --
  var N=120,mg=new T.BufferGeometry();
  var mp=new Float32Array(N*3),mv=[];
  for(var i=0;i<N;i++){
    mp[i*3]=(Math.random()-0.5)*13;mp[i*3+1]=Math.random()*1.9;mp[i*3+2]=(Math.random()-0.5)*11-1;
    mv.push({s:0.35+Math.random()*0.75,ph:Math.random()*6.283});
  }
  mg.setAttribute('position',new T.BufferAttribute(mp,3));
  var motes=new T.Points(mg,new T.PointsMaterial({size:0.115,transparent:true,opacity:0,
    depthWrite:false,sizeAttenuation:true}));
  motes.visible=false;g.add(motes);

  // -- full-frame colour wash, parented to the camera so it always covers the
  //    view. Sky and fog alone barely register: most of the frame is lit hill
  //    and ground geometry, which they do not touch. --
  var wash=new T.Mesh(new T.PlaneGeometry(2,2),
    new T.MeshBasicMaterial({transparent:true,opacity:0,depthTest:false,
      depthWrite:false,fog:false,side:T.DoubleSide}));
  wash.position.z=-0.2;wash.renderOrder=999;wash.visible=false;
  wash.frustumCulled=false;
  ui.cam.add(wash);ui.sc.add(ui.cam);

  var rfloor=new T.Mesh(new T.PlaneGeometry(19,19),
    new T.MeshBasicMaterial({transparent:true,opacity:0,depthWrite:false,fog:false,
      side:T.DoubleSide}));
  rfloor.rotation.x=-Math.PI/2;rfloor.position.y=0.09;
  room.add(rfloor);

  ui.s.field={disc:disc,ring:ring,room:room,box:box,grid:grid,lat:lat,rfloor:rfloor,motes:motes,mv:mv,
              wash:wash,terrain:null,room_:null,tex:{},t:0,tp:0,rp:0,wp:0};
}

// ---- WEATHER ----
BattleUI.prototype.setWeather=function(w){
  this.s.w=w;
  if(this.environment)this.environment.dataset.weather=w||'';
  var s=this.s.wsys||{};
  for(var k in s)s[k].visible=(w===k);
  // 'sun' has no particles but still grades the scene, so drive the look
  // from a separate lookup rather than from the particle systems.
  this.s.wlook=WEATHER_LOOK[w]||null;
  if(this.s.wsys&&this.s.wsys.sunmotes)this.s.wsys.sunmotes.visible=(w==='sun');
};

// ---- TERRAIN ----
BattleUI.prototype.setTerrain=function(t){
  var f=this.s.field;if(!f)return;
  f.terrain=t&&TERRAIN_LOOK[t]?t:null;
  if(this.environment)this.environment.dataset.terrain=f.terrain||'';
  if(!f.terrain){f.disc.visible=false;f.ring.visible=false;f.motes.visible=false;return;}
  var look=TERRAIN_LOOK[f.terrain];
  if(this.environment)this.environment.style.setProperty('--be-field',cssHex(look.c));
  if(!f.tex[f.terrain])f.tex[f.terrain]=terrainTex(look);
  f.disc.material.map=f.tex[f.terrain];f.disc.material.needsUpdate=true;
  f.disc.visible=true;f.ring.visible=true;f.motes.visible=true;
  f.ring.material.color=new T.Color(look.c2);
  f.motes.material.color=new T.Color(look.c);
};

// ---- ROOM (Trick Room / Wonder Room / Magic Room) ----
BattleUI.prototype.setRoom=function(r){
  var f=this.s.field;if(!f)return;
  f.room_=r&&ROOM_LOOK[r]?r:null;
  if(this.environment)this.environment.dataset.room=f.room_||'';
  if(!f.room_){f.room.visible=false;return;}
  var look=ROOM_LOOK[f.room_];
  if(this.environment)this.environment.style.setProperty('--be-room',cssHex(look.grid));
  f.room.visible=true;
  f.box.material.color=new T.Color(look.c);
  f.grid.material.color=new T.Color(look.grid);
  f.lat.material.color=new T.Color(look.grid);
  if(!f.tex['room_'+f.room_])f.tex['room_'+f.room_]=roomTex('#'+('000000'+look.grid.toString(16)).slice(-6));
  f.rfloor.material.map=f.tex['room_'+f.room_];
  f.rfloor.material.needsUpdate=true;
};

// Per-frame easing for every field effect. Called from _anim.
BattleUI.prototype._stepField=function(t,dt){
  var st=this.s,f=st.field,base=st.base,lt=st.lt;
  if(base&&lt){
    var L=st.wlook;
    var k=Math.min(1,dt*2.2);   // ease toward the target look
    // Cache immutable colour targets on the look definition. Weather easing
    // previously allocated four Color objects per frame for an entire battle.
    var tSky=L?(L._skyC||(L._skyC=new T.Color(L.sky))):base.sky;
    var tFog=L?(L._fogC||(L._fogC=new T.Color(L.fog))):base.fog;
    if(this.sc.background&&this.sc.background.lerp)this.sc.background.lerp(tSky,k);
    if(this.sc.fog){
      this.sc.fog.color.lerp(tFog,k);
      this.sc.fog.near+=((L?L.fogN:base.fn)-this.sc.fog.near)*k;
      this.sc.fog.far +=((L?L.fogF:base.ff)-this.sc.fog.far )*k;
    }
    lt.amb.color.lerp(L?(L._ambC||(L._ambC=new T.Color(L.amb))):base.ambC,k);
    lt.amb.intensity+=((L?L.ambI:base.ambI)-lt.amb.intensity)*k;
    lt.sun.color.lerp(L?(L._sunC||(L._sunC=new T.Color(L.sun))):base.sunC,k);
    lt.sun.intensity+=((L?L.sunI:base.sunI)-lt.sun.intensity)*k;
    // Harsh sunlight shimmers; a storm flickers with distant lightning.
    if(st.w==='sun')lt.sun.intensity+=Math.sin(t*2.1)*0.06;
    if(st.w==='rain'){
      // Per-frame probability is framerate-dependent and fired several times a
      // second. Schedule the next strike in SECONDS instead: one every 7-16s,
      // with a short bright decay so it reads as a real flash.
      if(st.boltAt==null)st.boltAt=7+Math.random()*9;
      st.boltAt-=dt;
      if(st.boltAt<=0){st.bolt=0.28;st.boltAt=7+Math.random()*9;}
      if(st.bolt>0){st.bolt-=dt;lt.sun.intensity+=Math.max(0,st.bolt)*7;}
    }else{st.bolt=0;st.boltAt=null;}
  }
  if(!f)return;
  f.t+=dt;
  // weather colour wash: ease toward the target tint, sized to fill the frustum
  if(f.wash){
    var L2=this.s.wlook,wantW=L2?L2.tintO:0;
    // A room grades the frame as well; when both are active the room wins the
    // hue (it is the rarer, more dramatic state) and the two opacities add.
    var RL=f.room_?ROOM_LOOK[f.room_]:null;
    if(RL)wantW=Math.min(0.4,wantW+0.20);
    f.wp+=(wantW-f.wp)*Math.min(1,dt*2.2);
    var tCol=RL?new T.Color(RL.c):(L2?new T.Color(L2.tint):null);
    if(tCol)f.wash.material.color.lerp(tCol,Math.min(1,dt*2.2));
    f.wash.material.opacity=f.wp;
    f.wash.visible=f.wp>0.004;
    var hh=Math.tan(this.cam.fov*Math.PI/360)*0.25*2;
    f.wash.scale.set(hh*this.cam.aspect*0.5+0.02,hh*0.5+0.02,1);
    f.wash.position.z=-0.25;
  }
  // NOTE: keep fade progress in its OWN variables (f.tp / f.rp). Reading the
  // material's opacity back as the progress creates a feedback loop -- the
  // value has already been multiplied by the pulse, so it converges to ~0.09
  // and the effect never becomes visible.
  var ease=Math.min(1,dt*3);
  f.tp+=((f.terrain?1:0)-f.tp)*ease;
  f.rp+=((f.room_?1:0)-f.rp)*ease;

  // terrain: a lit floor disc that breathes and slowly turns
  var pulse=0.85+Math.sin(f.t*1.9)*0.15;
  f.disc.material.opacity=f.tp*0.95*pulse;
  f.ring.material.opacity=f.tp*0.95*(0.7+Math.sin(f.t*1.9+0.6)*0.3);
  f.disc.rotation.z+=dt*0.06;
  f.ring.scale.setScalar(1+Math.sin(f.t*1.9)*0.012);
  if(f.motes&&f.tp>0.004){
    f.motes.material.opacity=f.tp*0.9;
    var ma=f.motes.geometry.attributes.position,mArr=ma.array;
    for(var mi=0;mi<f.mv.length;mi++){
      mArr[mi*3+1]+=f.mv[mi].s*dt;                                   // rise
      mArr[mi*3]  +=Math.sin(f.t*0.7+f.mv[mi].ph)*dt*0.35;           // drift
      if(mArr[mi*3+1]>2.1){mArr[mi*3+1]=0;
        mArr[mi*3]=(Math.random()-0.5)*13;mArr[mi*3+2]=(Math.random()-0.5)*11-1;}
    }
    ma.needsUpdate=true;
  }
  if(f.tp<0.004&&!f.terrain){f.disc.visible=false;f.ring.visible=false;f.motes.visible=false;}

  // room: the shell tints the view and the lattice drifts, reading as a
  // volume the battle is trapped inside
  var gp=0.6+Math.sin(f.t*1.4)*0.2;
  f.box.material.opacity=f.rp*0.20;
  f.grid.material.opacity=f.rp*gp;
  f.lat.material.opacity=f.rp*gp*0.4;
  f.rfloor.material.opacity=f.rp*gp*0.9;
  f.room.rotation.y+=dt*(f.room_==='trickroom'?-0.16:0.08);
  if(f.rp<0.002&&!f.room_)f.room.visible=false;
};

// ===== Sprite loading via DOM <img> =====
// Preferred-first with optional provisional fallback.
//
// Old behaviour raced every URL in the chain with an 800ms timeout AND
// preloaded gen5 PNGs in parallel. The smaller static PNGs almost always won
// that race, so players mostly saw gen5 art even when the Showdown animated
// GIF was about to finish. Now:
//   1. Load the preferred URL (almost always the Showdown ani GIF) first.
//   2. Never abandon a still-loading preferred animated URL for a static PNG.
//   3. After a short delay, a static fallback may paint provisionally so the
//      battlefield is never blank — but the preferred GIF always upgrades over
//      it the moment it arrives.
//   4. Only advance past a preferred URL on a real error / known failure /
//      long stall (network hung), never on a short timer race.
BattleUI.prototype._setTex=function(k,urls){
  var s=this.s[k];if(!s)return;
  // The <img> host only exists after mount(); queue and retry once it does,
  // rather than dropping the sprite (which left blank combatants on screen).
  if(!s.img){
    if(!this.s.mounted)this._pending.push(function(){this._setTex(k,urls);});
    return;
  }
  urls=(Array.isArray(urls)?urls:urls?[urls]:[]).filter(function(u){return!!u;});
  var key=urls.join('|');if(s.tu===key)return;
  // Cancel any in-flight load for a previous species on this slot.
  s._texGen=(s._texGen|0)+1;
  var gen=s._texGen;
  s.tu=key;s.url=null;s.ar=1;s.fadeT=0;s.appearT=0;
  s.img.style.opacity=0;s.img.style.width=0;s.img.style.height=0;s.img.style.filter='brightness(0)';

  // Warm the preferred URL immediately at high priority. Fallbacks are NOT
  // preloaded yet — they compete for the same HTTP/2 sockets and used to beat
  // the bigger animated GIF to the finish line.
  if(urls[0])preload(urls[0]);

  function alive(){return s._texGen===gen&&s.img;}

  function paint(u,provisional){
    if(!alive())return;
    var img=CACHE[u];
    if(!img||!img.naturalWidth)return;
    // Never let a provisional static PNG replace an already-shown preferred GIF.
    if(provisional&&s.url&&isAnimatedSpriteUrl(s.url))return;
    // Already showing this exact URL.
    if(s.url===u)return;
    try{
      var w=img.naturalWidth||1,h=img.naturalHeight||1;
      s.ar=w/h;s.url=u;
      // Fade-in only for the first paint of this slot; upgrades (gen5→ani) swap
      // in place so the mon doesn't black-wipe a second time.
      if(!provisional||!s.appearT){
        s.appearT=0.001;
        s.fadeT=0.001;
      }
      s.img.dataset.ar=s.ar;
      // Force GIF animation to restart/play: clear src first, then assign; without
      // this, some browsers (esp. when image was preloaded in a detached Image())
      // will show frame 0 and never advance the animation.
      var useUrl=img.currentSrc||img.src||u;
      var tgt=s.img;
      if(!provisional){
        tgt.style.opacity=0;
        tgt.style.filter='brightness(0)';
      }
      // Re-assigning the same src can no-op in some browsers; clear first.
      if(tgt.getAttribute('src')!==useUrl){
        tgt.removeAttribute('src');
        void tgt.offsetWidth;
        tgt.src=useUrl;
      }
    }catch(e){}
  }

  function waitFor(u,opts){
    opts=opts||{};
    return new Promise(function(resolve){
      if(!u||FAILED[u]){resolve(false);return;}
      var img=CACHE[u]||preload(u);
      if(!img){resolve(false);return;}
      if(img.complete){resolve(img.naturalWidth>0);return;}
      var done=false;
      function finish(ok,hardFail){
        if(done)return;done=true;
        img.removeEventListener('load',onL);
        img.removeEventListener('error',onE);
        if(timer)clearTimeout(timer);
        // Only permanent-fail on a real error. A stall timeout must NOT poison
        // the cache — the GIF may still arrive a moment later and paint.
        if(!ok&&hardFail)FAILED[u]=1;
        resolve(ok);
      }
      function onL(){finish(img.naturalWidth>0,false);}
      function onE(){finish(false,true);}
      img.addEventListener('load',onL);
      img.addEventListener('error',onE);
      // Long stall only — never a short race against fallbacks. 12s covers a
      // cold Showdown CDN hit on a slow mobile link without yielding to gen5.
      var timer=setTimeout(function(){finish(false,false);},opts.stallMs||12000);
    });
  }

  // Kick a static fallback after a brief beat so the field isn't empty while
  // the preferred animated GIF is still in flight. The preferred URL always
  // upgrades over it (see paint()).
  var provisionalTimer=null;
  if(urls.length>1){
    provisionalTimer=setTimeout(function(){
      if(!alive())return;
      // Prefer the first non-animated fallback (gen5 PNG) as the placeholder.
      var fb=null;
      for(var i=1;i<urls.length;i++){
        if(!isAnimatedSpriteUrl(urls[i])){fb=urls[i];break;}
      }
      if(!fb)fb=urls[1];
      if(!fb||FAILED[fb])return;
      waitFor(fb,{stallMs:4000}).then(function(ok){
        if(ok&&alive()&&!(s.url&&isAnimatedSpriteUrl(s.url)))paint(fb,true);
      });
    },220);
  }

  // Keep a background listener on the preferred animated URL so a late arrival
  // (after we already painted a provisional/static fallback) still upgrades.
  if(urls[0]&&isAnimatedSpriteUrl(urls[0])){
    (function(pref){
      var img=CACHE[pref]||preload(pref);
      if(!img)return;
      function upgrade(){
        if(!alive())return;
        if(img.naturalWidth>0){
          paint(pref,false);
          if(provisionalTimer)clearTimeout(provisionalTimer);
        }
      }
      if(img.complete&&img.naturalWidth>0)return; // run() will paint it
      img.addEventListener('load',function(){upgrade();},{once:true});
    })(urls[0]);
  }

  (function run(i){
    if(!alive())return;
    if(i>=urls.length)return;
    var u=urls[i];
    // Skip known-bad URLs immediately.
    if(!u||FAILED[u]){run(i+1);return;}
    // Already showing a preferred animated sprite — nothing left to do.
    if(s.url&&isAnimatedSpriteUrl(s.url))return;

    var prefer=isAnimatedSpriteUrl(u);
    waitFor(u,{stallMs:prefer?12000:6000}).then(function(ok){
      if(!alive())return;
      // A late preferred upgrade may have won while we waited.
      if(s.url&&isAnimatedSpriteUrl(s.url))return;
      if(ok){
        paint(u,false);
        // Preferred animated GIF is the goal — stop walking the chain.
        if(prefer){
          if(provisionalTimer)clearTimeout(provisionalTimer);
          return;
        }
        // Static loaded as a real result (preferred failed earlier). Keep
        // walking only if we still have a better animated candidate behind us.
        for(var j=i+1;j<urls.length;j++){
          if(isAnimatedSpriteUrl(urls[j])&&!FAILED[urls[j]]){run(j);return;}
        }
        return;
      }
      // Preferred failed/stalled: walk the rest of the chain.
      run(i+1);
    });
  })(0);
};
BattleUI.prototype._rs=function(si){
  if(!si)return 'p';
  if(si==='p'||si==='player'||si==='pHpFill')return 'p';
  if(si==='e'||si==='enemy'||si==='eHpFill')return 'e';
  if(typeof si==='string')return si.charAt(0)==='p'?'p':'e';
  return 'e';
};

BattleUI.prototype.setupBattle=function(o){
  // Deferred until the renderer exists; buildBiome() below dereferences
  // this.sc, which is null while mount() is still retrying for a sized host.
  if(!this._whenMounted(function(){this.setupBattle(o);}))return;
  var bk=pickBiome(o.biomeSeed||String(Math.random()),o.biomeTypes||(o.enemy&&o.enemy.types));
  this.buildBiome(bk);
  this.s.logs=[];
  this._resetMon('p');this._resetMon('e');
  if(o.player)this.setPlayer(o.player);
  if(o.enemy)this.setEnemy(o.enemy);
  this.setMoment('idle');this.s.mt=0;
  var pn=o.player?_dispName(o.player.name):'your Pokemon';
  this.setMsg('What will '+pn+' do?');
  this.setWeather(BIOMES[bk].wth);this.s.locked=false;
  // Field effects are per-battle: clear them or Trick Room from the last
  // fight would still be humming over a brand new one.
  this.setTerrain(null);this.setRoom(null);
  this.render();
};

// Note: name cleaning (forme-suffix stripping) happens in the glue layer via
// Dex.species.baseSpecies, which returns the correct root .name — including
// hyphenated base names like "Chi-Yu", "Wo-Chien", "Ho-Oh", "Jangmo-o", etc.
// So this function is just a trim/stringify pass-through; do NOT naively chop
// at hyphens or you'll turn "Chi-Yu" into "Chi".
function _dispName(n){
  if(n==null)return '';
  return String(n).trim();
}
BattleUI.prototype._resetMon=function(k){
  var s=this.s[k];if(!s)return;
  s.hp=1;s.st=null;s.tu=null;s.offX=0;s.offY=0;s.offZ=0;s.rotZ=0;s.tintW=1;s.fadeT=0;s.appearT=0;
  s.lastCrySid=null;
  if(s.sh){s.sh.material.opacity=0;s.sh.scale.set(1,1,1);}
  if(s.img){s.img.style.opacity=0;s.img.style.width=0;s.img.style.height=0;s.img.style.filter='brightness(0)';}
  s.pos.set(s.pos.x,s.pos.y,s.pos.z);
};
BattleUI.prototype.setPlayer=function(p){var s=this.s.p;if(!s)return;
  var onlySprite=p&&Object.keys(p).every(function(k){return k==='u'||k==='name'||k==='types'||k==='h'||k==='sid'||k==='num'||k==='silent';});
  if(p.name!=null)s.name=_dispName(p.name);
  if(p.lv!=null)s.lv=p.lv;if(p.types)s.types=p.types.slice();
  if(p.max!=null)s.max=p.max;if(p.st!==undefined)s.st=p.st;
  if(p.h!=null&&p.h>0)s.h=p.h;
  if(p.sid!=null)s.sid=p.sid;if(p.num!=null)s.num=p.num;
  var sidChanged=(p.sid!=null&&p.sid!==s.lastCrySid);
  if(p.u!==undefined)this._setTex('p',p.u);
  if(p.hp!=null)s.hp=Math.max(0,Math.min(1,p.hp));
  // Auto-cry ONLY when the species/forme actually changes (new sid) and we're
  // not globally suppressing. Repeated sync calls with the same sid (turn
  // ticks, HP updates, etc.) must NOT re-trigger the cry.
  if(p.u!==undefined&&!p.silent&&!this._suppressAutoCries&&sidChanged){
    s.lastCrySid=p.sid;
    this.playCry(p.sid,null,p.num);
  }
  if(!onlySprite)this.render();
};
BattleUI.prototype.setEnemy=function(e){var s=this.s.e;if(!s)return;
  var onlySprite=e&&Object.keys(e).every(function(k){return k==='u'||k==='name'||k==='types'||k==='h'||k==='sid'||k==='num'||k==='silent';});
  if(e.name!=null)s.name=_dispName(e.name);
  if(e.lv!=null)s.lv=e.lv;if(e.types)s.types=e.types.slice();
  if(e.max!=null)s.max=e.max;if(e.st!==undefined)s.st=e.st;
  if(e.h!=null&&e.h>0)s.h=e.h;
  if(e.sid!=null)s.sid=e.sid;if(e.num!=null)s.num=e.num;
  var sidChanged=(e.sid!=null&&e.sid!==s.lastCrySid);
  if(e.u!==undefined)this._setTex('e',e.u);
  if(e.hp!=null)s.hp=Math.max(0,Math.min(1,e.hp));
  if(e.u!==undefined&&!e.silent&&!this._suppressAutoCries&&sidChanged){
    s.lastCrySid=e.sid;
    this.playCry(e.sid,null,e.num);
  }
  if(!onlySprite)this.render();
};

BattleUI.prototype.setHp=function(si,f){
  var s=this.s[this._rs(si)];if(!s)return;
  s.hp=Math.max(0,Math.min(1,f));
  var d=this._dom;var pct=Math.round(s.hp*100);
  var col=s.hp>0.5?'#4ade80':(s.hp>0.2?'#facc15':'#ef4444');
  var key=this._rs(si);
  if(d[key+'-hp']){d[key+'-hp'].style.width=pct+'%';d[key+'-hp'].style.background=col;}
  if(d[key+'-hn']){d[key+'-hn'].textContent=pct+'%';}
};
BattleUI.prototype.setStatus=function(si,st){
  var s=this.s[this._rs(si)];if(!s)return;s.st=st||null;
  if(st&&s.grp){var col={brn:0xf08030,psn:0xa040a0,par:0xf8d030,slp:0xaaaaaa,frz:0x98d8d8,tox:0xc040c0}[st]||0xffffff;
    var pos=new T.Vector3();s.grp.getWorldPosition(pos);pos.y+=s.h*0.5;this._burst(pos,col,8);}
  var key=this._rs(si);var sb=this._dom[key+'-sb'];if(sb)sb.innerHTML=_badgeHtml(st);
};
BattleUI.prototype.setMsg=function(t){this.s.msg=t||'';var e=this._dom.msg;if(e)e.textContent=this.s.msg;};
BattleUI.prototype.setMoves=function(mv,mg,cb){
  this.s.moves=mv||[];this.s.mega=Object.assign({cm:false,cx:false,cy:false,a:null},mg||{});this.s.onMove=cb||null;this.s.locked=false;
  // Return camera to idle once the player has control again (turn finished)
  this.setMoment('idle');
  if(this._momentTouts){this._momentTouts.forEach(function(t){clearTimeout(t);});}this._momentTouts=[];
  this.render();
};
BattleUI.prototype.setMoment=function(m){this.s.moment=m;this.s.mt=0;};
// Queue a simple timeline of moments: [{m,d}, ...] where d=ms until next moment.
// Replaces any previously queued timeline. Call with [{m:'idle',d:0}] to reset.
BattleUI.prototype.queueMoments=function(seq){
  var self=this;
  if(this._momentTouts){this._momentTouts.forEach(function(t){clearTimeout(t);});}
  this._momentTouts=[];
  (function step(i){
    if(i>=seq.length)return;
    self.setMoment(seq[i].m);
    if(seq[i].d>0){
      var t=setTimeout(function(){step(i+1);},seq[i].d);
      self._momentTouts.push(t);
    }
  })(0);
};
BattleUI.prototype.floatN=function(si,n,k){
  var s=this.s[this._rs(si)];if(!s||!this.hud||!s.grp||!this.host||!this.cam)return;
  var bfs=this._dom.bfs||this.hud.querySelector('.bfs');if(!bfs)return;
  var el=document.createElement('div');el.className='bf'+(k==='heal'?' bh':'');el.textContent=(k==='heal'?'+':'−')+Math.abs(Math.round(n));
  var hr=this._hostRect&&this._hostRect.width?this._hostRect:this.host.getBoundingClientRect();var wp=new T.Vector3();s.grp.getWorldPosition(wp);wp.y+=s.h*0.6;var pr=wp.clone().project(this.cam);
  el.style.left=(((pr.x*0.5+0.5)*hr.width))+'px';el.style.top=(((-pr.y*0.5+0.5)*hr.height))+'px';
  bfs.appendChild(el);setTimeout(function(){el.remove();},1300);
};
BattleUI.prototype.floatT=function(t,k){
  if(!this.hud||!this.host)return;var bfs=this._dom.bfs||this.hud.querySelector('.bfs');if(!bfs)return;
  var el=document.createElement('div');el.className='bp '+(k||'');el.textContent=t;var hr=this._hostRect&&this._hostRect.width?this._hostRect:this.host.getBoundingClientRect();
  // Stagger overlapping popups (e.g. crit + super effective on the same hit):
  // keep a counter of currently-alive center popups and shift each new one up
  // so they stack vertically. Each subsequent popup in the same burst also
  // starts its animation 120ms later for a "popping one after the other" feel.
  this._ftStack=(this._ftStack||0)+1;var stack=this._ftStack;
  var baseTop=hr.height*0.32;var offset=(stack-1)*44; // 44px vertical gap
  var delay=(stack-1)*120; // ms delay per stacked popup
  el.style.left=(hr.width/2)+'px';el.style.top=(baseTop-offset)+'px';
  el.style.animationDelay=delay+'ms';
  // Apply the same delay to opacity/visibility so the staggered one doesn't
  // appear static before its animation begins.
  el.style.opacity='0';
  setTimeout(function(){el.style.opacity='';},delay);
  bfs.appendChild(el);
  var self=this;
  setTimeout(function(){el.remove();self._ftStack=Math.max(0,(self._ftStack||1)-1);},1400+delay);
};
BattleUI.prototype.trigMega=function(si){var s=this.s[this._rs(si)];if(s&&s.grp){var pos=new T.Vector3();s.grp.getWorldPosition(pos);pos.y+=s.h*0.6;this._burst(pos,0xffe060,30);}};
BattleUI.prototype.flashHeal=function(si){var s=this.s[this._rs(si)];if(s&&s.grp){var pos=new T.Vector3();s.grp.getWorldPosition(pos);pos.y+=s.h*0.6;this._burst(pos,0x7cff7c,22);}};
BattleUI.prototype.log=function(t){
  // The central single-line message field ("What will X do?" / "X used Move!" /
  // "It's super effective!") is the only battle-text; no scrollable log.
  if(t==null)return;
  var msg=String(t).trim();if(!msg)return;
  this.s.msg=msg;
  var e=this._dom.msg;if(e)e.textContent=msg;
};
BattleUI.prototype.setHdr=function(h){Object.assign(this.s.hdr,h||{});this.render();};

// ===== Pokemon cries =====
// Simple sequential queue: play each requested cry one at a time; only start
// the next one when the current one ends OR a safety timeout fires OR all
// URLs for a cry fail. Never creates overlapping Audio objects.
BattleUI.prototype._drainCryQueue=function(){
  var self=this;
  if(this._cryPlaying||this._cryDrainScheduled)return;
  if(!this._cryQueue||!this._cryQueue.length){this._cryPlaying=false;return;}
  this._cryPlaying=true;this._cryDrainScheduled=false;
  var job=this._cryQueue.shift();
  var urls=job.urls||[];
  if(!urls.length){this._cryPlaying=false;this._drainCryQueue();return;}
  var audio=null,readyHandler=null,idx=0,finished=false;
  function cleanup(){
    if(audio){
      try{audio.pause();audio.removeAttribute('src');audio.onerror=audio.onloadeddata=null;}catch(_){}
      try{audio.removeEventListener('ended',onEnd);}catch(_){}
      if(readyHandler){try{audio.removeEventListener('canplaythrough',readyHandler);}catch(_){}readyHandler=null;}
      audio=null;
    }
    if(safetyT){clearTimeout(safetyT);safetyT=null;}
  }
  function advance(){
    if(finished)return;finished=true;
    cleanup();
    self._cryPlaying=false;
    self._drainCryQueue();
  }
  function onEnd(){advance();}
  var safetyT=null;
  function tryNext(){
    if(finished)return;
    if(idx>=urls.length){advance();return;}
    cleanup();
    // 0.35 is the cry's own balance against the rest of the mix; the SFX
    // slider scales it (GameAudio may not exist in isolated tests).
    var a=new Audio();
    a.volume=window.GameAudio?window.GameAudio.sfxVolume(0.5):0.35;
    a.preload='auto';audio=a;
    function err(){if(audio===a)tryNext();}
    function onReady(){
      if(finished||audio!==a)return;
      try{
        var p=a.play();
        if(p&&typeof p.then==='function')p.catch(function(){err();});
      }catch(_){err();}
    }
    readyHandler=onReady;
    a.addEventListener('ended',onEnd,{once:true});
    a.addEventListener('canplaythrough',readyHandler,{once:true});
    // onloadeddata as backup to canplaythrough
    a.onloadeddata=onReady;
    a.onerror=err;
    // Safety: no Pokémon cry is longer than ~2s; if we're still "playing"
    // after 2500ms, force-advance so the queue never jams.
    safetyT=setTimeout(advance,2500);
    a.src=urls[idx++];
  }
  // Apply the job's initial delay (used to sync with appear fade-in)
  var startDelay=Math.max(0,job.delay||0);
  if(startDelay>0)setTimeout(tryNext,startDelay);
  else tryNext();
};
BattleUI.prototype.playCry=function(spriteId,speciesId,num,delay){
  try{
    var urls=[];
    var sd=String(spriteId||speciesId||'').toLowerCase().replace(/[^a-z0-9-]+/g,'');
    if(sd)urls.push('https://play.pokemonshowdown.com/audio/cries/'+sd+'.mp3');
    var base=sd?sd.replace(/-.*$/,''):'';
    if(base&&base!==sd)urls.push('https://play.pokemonshowdown.com/audio/cries/'+base+'.mp3');
    if(num){
      urls.push('https://raw.githubusercontent.com/PokeAPI/cries/main/cries/pokemon/latest/'+num+'.ogg');
      urls.push('https://raw.githubusercontent.com/PokeAPI/cries/main/cries/pokemon/legacy/'+num+'.ogg');
    }
    if(!urls.length)return;
    this._cryQueue.push({urls:urls,delay:delay});
    // Schedule drain on next tick so multiple rapid playCry calls in one
    // tick (like "player then enemy" during battle start) queue up in order
    // before we start playing the first.
    if(!this._cryDrainScheduled){
      this._cryDrainScheduled=true;
      var self=this;
      setTimeout(function(){self._cryDrainScheduled=false;self._drainCryQueue();},0);
    }
  }catch(_){}
};

BattleUI.prototype._burst=function(pos,col,n){
  if(!this.g.f)return;var geo=new T.BufferGeometry(),a=new Float32Array(n*3),v=[];
  for(var i=0;i<n;i++){a[i*3]=pos.x;a[i*3+1]=pos.y+0.5;a[i*3+2]=pos.z;var th=Math.random()*Math.PI*2,ph=Math.random()*Math.PI*0.7+0.2;v.push([Math.cos(th)*Math.sin(ph)*3,Math.cos(ph)*3+1,Math.sin(th)*Math.sin(ph)*3]);}
  geo.setAttribute('position',new T.BufferAttribute(a,3));
  var pt=new T.Points(geo,new T.PointsMaterial({color:col,size:0.14,transparent:true,opacity:1,depthWrite:false,sizeAttenuation:true}));
  this.g.f.add(pt);this.s.ps.push({m:pt,v:v,life:0,ttl:0.8,a:a});
};

BattleUI.prototype._anim=function(){
  if(!this.s.mounted||this._disposed)return;this._raf=requestAnimationFrame(this._anim);
  if(!this.sc||!this.cam)return;
  // Don't burn GPU/CPU on a scene nobody can see. The browser already throttles
  // rAF in background tabs, but the battle host also gets hidden behind other
  // screens while the instance is still alive.
  if(this.host&&this.host.offsetParent===null&&this.host.getClientRects().length===0)return;
  try{
    var dt=Math.min(0.05,this.clock.getDelta()),t=this.clock.elapsedTime;this.s.mt+=dt;
  // Project sprites (DOM) each frame
  this._projectSprites(t,dt);
  var mo=this.s.moment,idle=(mo==='idle'||mo==='fainted'),cs=idle?2.4:6.0;
  // Camera shifted LEFT for mobile framing. Look target sits between the two
  // mons (player at z=1.6, enemy pushed farther to z=-3.0 so perspective makes
  // the enemy noticeably smaller). Reuse vectors instead of allocating two
  // new objects on every frame.
  var des=this._camDest.set(-0.15,4.6,9.9),dtgt=this._lookDest.set(0.05,0.55,-2.5);
  switch(mo){
    case'playerAttack':des.set(-2.0,3.0,6.0);dtgt.set(1.0,1.5,-1.2);break;
    case'enemyHit':des.set(1.2,2.8,5.6);dtgt.set(2.2,1.4,-2.0);break;
    case'enemyAttack':des.set(1.2,2.9,6.8);dtgt.set(-1.2,1.4,0.6);break;
    case'playerHit':des.set(-2.8,2.8,5.4);dtgt.set(-2.0,1.4,1.2);break;
    case'fainted':des.set(-0.6,3.7,9.5);dtgt.set(0.2,0.6,-0.3);break;
    case'mega':des.set(-0.4,3.8,8.0);dtgt.set(0.2,1.8,-0.4);break;
  }
  // Showcase keeps the REAL battle SLOTS (so the title matches the game) but
  // holds the wide idle camera. The per-moment camera pushes right in on an
  // attack, which works in battle because the HUD frames it -- on the title it
  // just crams the two Pokemon together and crops them.
  if(this.showcase){des.set(-0.55,4.2,10.6);dtgt.set(0.15,1.35,-1.0);cs=2.4;}
  if(!REDUCED_MOTION&&(idle||this.showcase)){des.x+=Math.sin(t*0.35)*0.25;des.y+=Math.sin(t*0.5)*0.08;des.z+=Math.sin(t*0.28)*0.1;}
  this.cam.position.lerp(des,dt*cs);this._tgt.lerp(dtgt,dt*cs);this.cam.lookAt(this._tgt);
  // Scenery
  if(!REDUCED_MOTION&&this.s.clouds)for(var c=0;c<this.s.clouds.length;c++)this.s.clouds[c].position.x+=dt*0.07;
  if(!REDUCED_MOTION&&this.s.flies){var fl=this.s.flies,fp=fl.pt.geometry.attributes.position.array;for(var i=0;i<fl.m.length;i++){fp[i*3+1]+=Math.sin(t*fl.m[i].s+fl.m[i].ph)*dt*0.2;fp[i*3]+=Math.cos(t*fl.m[i].s*0.7+fl.m[i].ph)*dt*0.1;if(fp[i*3+1]>5)fp[i*3+1]=0.5;}fl.pt.geometry.attributes.position.needsUpdate=true;}
  // Step EVERY visible weather system, not just the one keyed by name: harsh
  // sunlight drives 'sunmotes', which would otherwise hang frozen mid-air.
  if(this.s.wsys){for(var wk in this.s.wsys){var pt=this.s.wsys[wk];if(!pt||!pt.visible)continue;
    var pp=pt.geometry.attributes.position.array,v=pt.userData.v,nn=pt.userData.n;
    var sway=(wk==='snow'||wk==='sunmotes')?1:0;
    for(var j=0;j<nn;j++){
      pp[j*3]+=(v[j*3]+(sway?Math.sin(t*0.8+j)*0.25:0))*dt*3;
      pp[j*3+1]+=v[j*3+1]*dt*3;
      pp[j*3+2]+=v[j*3+2]*dt*3;
      if(pp[j*3+1]<0){pp[j*3]=(Math.random()-0.5)*40;pp[j*3+1]=18;pp[j*3+2]=(Math.random()-0.5)*25;}}
    pt.geometry.attributes.position.needsUpdate=true;}}
  for(var k=this.s.ps.length-1;k>=0;k--){var pa=this.s.ps[k];pa.life+=dt;for(var m=0;m<pa.v.length;m++){pa.a[m*3]+=pa.v[m][0]*dt;pa.a[m*3+1]+=pa.v[m][1]*dt;pa.a[m*3+2]+=pa.v[m][2]*dt;pa.v[m][1]-=4*dt;}pa.m.geometry.attributes.position.needsUpdate=true;pa.m.material.opacity=Math.max(0,1-pa.life/pa.ttl);if(pa.life>=pa.ttl){this.g.f.remove(pa.m);try{pa.m.geometry.dispose();pa.m.material.dispose();}catch(_){}this.s.ps.splice(k,1);}}
  this._stepField(t,dt);
  // Some WebKit builds expose the loss through isContextLost() before the DOM
  // event is delivered. Detect it here as well so a white canvas never keeps
  // an animation loop alive forever.
  if(!this.flat&&this.r&&typeof this.r.isContextLost==='function'){
    try{if(this.r.isContextLost()){this._notifyContextLost();return;}}catch(_){}
  }
  // render call is individually guarded -- a one-frame GPU hiccup logs a
  // warning and the next frame simply retries rather than killing the loop.
  // Only a SUSTAINED burst of failures (≈1s of straight errors) is treated as
  // fatal; everything before that is considered transient driver churn --
  // exactly what happens while a context is mid-restore or the GPU channel is
  // bouncing. In flat mode (no WebGL) the DOM sprite projection above still
  // runs, so the battle is fully playable even without a 3D context.
  if(this.r&&!this.flat){try{this.r.render(this.sc,this.cam);this._renderErrs=0;}catch(e){
    try{
      if(this.r.isContextLost&&this.r.isContextLost()){this._renderErrs=0;this._notifyContextLost(e);return;}
    }catch(_){}
    this._renderErrs=(this._renderErrs|0)+1;
    if(this._renderErrs>=60){
      // WebGL is presentation only; even a sustained driver failure must not
      // tear down the battle. Degrade to the DOM/flat renderer and let the
      // session replace the unhealthy canvas in the background.
      this._renderErrs=0;this._notifyContextLost(e);return;
    }
    if(this._renderErrs===1)console.warn('[BattleUI] transient render error; retrying',e);
    return;
  }}
  }catch(e){
    this._reportError(e);
  }
};

// Project 3D sprite positions into DOM coordinates and apply animation offsets.
// Each sprite has a per-species world-space height (s.h, set from Dex heightm in
// setPlayer/setEnemy). We project BOTH the feet (ground) and the head (top of
// sprite) through the camera; the resulting screen-space distance gives pixel
// height that AUTOMATICALLY respects perspective (closer = bigger, farther =
// smaller). Width = height * natural aspect ratio so proportions stay intact.
// For the title showcase we use ultra-subtle, never-snapping motion.
BattleUI.prototype._projectSprites=function(t,dt){
  if(!this.sprites||!this.host||!this.cam)return;
  // Cache the host rect to avoid forced layout every frame. Refresh at most
  // every 20 frames (~3x/sec at 60fps) or on immediate demand when the cached
  // size is stale (first frame, resize not yet fired).
  var hr=this._hostRect||{width:0,height:0};
  // The stale check must run BEFORE the frame-counter increment: a resize sets
  // _hostRectAge=-1 to force an immediate refresh, and `-1++` would swallow it.
  if(!hr.width||this._hostRectAge<0||this._hostRectAge++%20===0){
    hr=this.host.getBoundingClientRect();this._hostRect=hr;this._hostRectAge=1;
  }
  var w=hr.width,h=hr.height;
  var cam=this.cam;
  for(var ik=0;ik<2;ik++){
    var key=ik===0?'p':'e';
    var s=this.s[key];if(!s||!s.img||!s.grp)continue;
    var pl=key==='p';
    // persistent smooth state
    if(s.lungeCur==null)s.lungeCur=0;
    if(s.shakeCur==null)s.shakeCur=0;
    if(s.idlePhase==null)s.idlePhase=Math.random()*6.283+ik*2.1;
    if(s.breathePhase==null)s.breathePhase=Math.random()*6.283+ik*1.7;
    if(s.driftPhase==null)s.driftPhase=Math.random()*6.283+ik*3.3;

    var wx=s.pos.x,wy=s.pos.y,wz=s.pos.z;
    var mo=this.s.moment;
    var mt=this.s.mt;
    var shake=0,flash=1,lunge=0;
    if(s.hp<=0){
      // Faint = pure fade-out (no sink/tilt).
      if(s.fadeT<=0)s.fadeT=0.7;
      s.fadeT-=dt;
      // ease lunge/shake back to zero even while fainting
      s.lungeCur+=(0-s.lungeCur)*Math.min(1,dt*3);
      s.shakeCur+=(0-s.shakeCur)*Math.min(1,dt*4);
    }else{
      // ---- target lunge: 0 idle, 1 attacking ----
      var lungeTarget=0;
      if(pl&&mo==='playerAttack')lungeTarget=1;
      else if(!pl&&mo==='enemyAttack')lungeTarget=1;
      // showcase = much more subtle, real battle = moderate
      var showcase=this.showcase;
      var lungeScaleShowcase=0.28;
      var lungeScaleBattle=1.5;
      var lungeInSpeed=showcase?3.2:6.5;
      var lungeOutSpeed=showcase?1.1:2.8;
      // smooth spring toward target, never snaps
      var spd=lungeTarget> s.lungeCur ? lungeInSpeed : lungeOutSpeed;
      s.lungeCur+=(lungeTarget - s.lungeCur)*Math.min(1,dt*spd);
      // ease curve for more natural feel (easeOutCubic for entry, easeInOut for exit)
      var eased;
      if(lungeTarget>0){
        // easeOutCubic
        var u=Math.min(1,mt/0.32);
        eased=s.lungeCur * (1 - Math.pow(1-u,3));
      }else{
        // when returning, keep the smoothed value (no extra easing) so it glides back
        eased=s.lungeCur;
      }
      lunge=eased;
      var lungeAmp=showcase?lungeScaleShowcase:lungeScaleBattle;
      wx+=(pl?1:-1)*lungeAmp*lunge;

      // ---- subtle idle drift: continuous, never resetting ----
      // Horizontal micro-sway and vertical breathe
      var idleX = Math.sin(t*0.42 + s.idlePhase)*0.055 + Math.sin(t*0.17 + s.driftPhase)*0.032;
      var idleY = Math.sin(t*0.78 + s.breathePhase)*0.018 + Math.sin(t*0.23 + s.idlePhase*0.7)*0.012;
      var idleZ = Math.cos(t*0.31 + s.driftPhase)*0.04;
      if(REDUCED_MOTION){idleX=0;idleY=0;idleZ=0;}
      else if(showcase){
        idleX*=1.6; idleY*=1.4; idleZ*=1.3;
      }else{
        idleX*=0.6; idleY*=0.5; idleZ*=0.4;
      }
      wx+=idleX;
      wy+=idleY;
      wz+=idleZ;

      // ---- hit shake: decaying sinusoid, smooth return ----
      var hitTarget=0;
      if((mo==='enemyHit'&&!pl)||(mo==='playerHit'&&pl))hitTarget=1;
      // shake cur lerps to target quickly, then decays
      var shakeIn=12, shakeOut=5;
      s.shakeCur+=(hitTarget - s.shakeCur)*Math.min(1,dt*(hitTarget> s.shakeCur?shakeIn:shakeOut));
      if(s.shakeCur>0.001){
        // damped oscillation based on mt of the hit moment
        var damping=Math.exp(-mt*4.2);
        var freq= showcase? 28 : 52;
        shake=Math.sin(mt*freq + s.idlePhase)*(REDUCED_MOTION?0.05:0.14) * s.shakeCur * damping;
        // flash flicker decays with same damping
        if(mt<0.28){
          var flick=Math.sin(mt*70);
          flash = (Math.abs(flick)>0.35)?1:0.65;
          flash = flash * (0.5 + 0.5*damping) + (1-damping)*1;
        }
      }
    }
    wx+=shake;
    // Project head (top) and feet (ground) using s.h world-units tall. These
    // vectors are per-slot scratch objects to keep the animation loop allocation-free.
    var headWorld=s.headV.set(wx,wy+s.h,wz).project(cam);
    var feetWorld=s.feetV.set(wx,wy,wz).project(cam);
    if(Math.abs(headWorld.z)>1||Math.abs(feetWorld.z)>1){
      s.img.style.opacity=0;s.sh.material.opacity=0;continue;
    }
    var sx=(feetWorld.x*0.5+0.5)*w;
    var headY=(-headWorld.y*0.5+0.5)*h;
    var feetY=(-feetWorld.y*0.5+0.5)*h;
    // Pixel height from perspective projection — closer = bigger automatically.
    var pxH=Math.max(4,Math.abs(feetY-headY));
    // Showdown canvases are not consistently framed: a wide-winged pose like
    // Wingull is 143x24 (ar ~6.0), so sizing purely by HEIGHT and multiplying
    // by the aspect ratio blew it out to 564px wide -- wider than the screen,
    // and it read as a giant. Clamp how far the aspect ratio may stretch a
    // sprite: everything up to ar 1.7 (virtually every Pokemon) is untouched,
    // only the freakishly wide poses get reined in.
    var MAX_AR=1.7;
    if(s.ar>MAX_AR)pxH=pxH*(MAX_AR/s.ar);
    var pxW=Math.round(pxH*s.ar);
    // Final guard: never let a sprite span more than ~46% of the battlefield.
    var wCap=w*0.46;
    if(pxW>wCap){pxH=pxH*(wCap/pxW);pxW=Math.round(wCap);}
    pxH=Math.round(pxH);
    // Opacity / brightness fades
    var op;
    if(s.appearT>0&&s.appearT<0.35&&s.hp>0){
      s.appearT+=dt;
      var ap=Math.min(1,s.appearT/0.35);
      ap=1-Math.pow(1-ap,3);
      op=flash*ap;
      s.img.style.opacity=String(op);
      s.sh.material.opacity=0.26*ap;
    }else if(s.hp<=0){
      var fa=Math.max(0,Math.min(1,s.fadeT/0.7));
      s.img.style.opacity=String(fa*flash);
      s.sh.material.opacity=0.26*fa;
    }else{
      s.img.style.opacity=String(flash);
      s.sh.material.opacity=0.26;
    }
    var brightMul=1;
    if(s.appearT>0&&s.appearT<0.35&&s.hp>0){
      var ap2=Math.min(1,s.appearT/0.35);
      brightMul=1-Math.pow(1-ap2,3);
    }
    var bv=flash*brightMul;
    var scale=1+0.08*lunge;
    // Position image so its BOTTOM-EDGE is at the projected feet point and it
    // is horizontally centered. No transform tricks needed — direct math.
    var style=s.img.style;
    style.left=(sx-pxW/2)+'px';
    style.top=(feetY-pxH)+'px';
    style.width=pxW+'px';
    style.height=pxH+'px';
    style.transform='scale('+scale+')';
    style.transformOrigin='50% 100%';
    style.filter=bv<1?('brightness('+bv+')'):'';
    // Shadow disc stays on ground at XZ feet
    if(s.sh){
      s.grp.position.set(wx,s.pos.y,wz);
      // Size the contact shadow from the species' world height, so a Gyarados
      // casts a far bigger one than a Joltik.
      var shs=scale*(0.42+Math.min(1.05,(s.h||2.4)*0.26));
      if(s.hp<=0)shs*=Math.max(0,s.fadeT/0.7);
      s.sh.scale.set(shs,shs,1);
    }
  }
};

// ==================== CSS ====================
var CSS_INJECTED=false;
function injectCSS(){
  if(CSS_INJECTED)return;CSS_INJECTED=true;
  var css=[
    // Always-on CSS perspective environment. WebGL paints over this when it is
    // healthy; context loss only reveals an already-complete scene underneath.
    '.bm-env{--be-sky:#70c3e8;--be-fog:#a8e4ff;--be-ground:#42b96a;--be-ground-dark:#2f8b4e;--be-hill:#3a9d5a;--be-hill-far:#2a7549;--be-accent:#d4a56a;--be-platform:#3a9d5a;--be-cloud:#fff;position:absolute;inset:0;z-index:0;overflow:hidden;pointer-events:none;background:var(--be-sky);isolation:isolate;}',
    '.bm-env *{position:absolute;box-sizing:border-box;pointer-events:none;}',
    '.be-sky{inset:0 0 38%;background:radial-gradient(circle at 72% 18%,rgba(255,255,255,.72) 0 2%,rgba(255,255,255,.18) 3% 10%,transparent 22%),linear-gradient(180deg,var(--be-sky),var(--be-fog));}',
    '.be-sun{right:18%;top:12%;width:62px;height:62px;border-radius:50%;background:rgba(255,250,220,.82);filter:blur(1px);box-shadow:0 0 42px rgba(255,245,205,.7);}',
    '.be-cloud{width:150px;height:34px;border-radius:50%;background:var(--be-cloud);opacity:.28;filter:blur(2px);}',
    '.be-cloud::before,.be-cloud::after{content:"";position:absolute;border-radius:50%;background:inherit;}',
    '.be-cloud::before{width:58px;height:58px;left:24px;bottom:0}.be-cloud::after{width:78px;height:50px;right:18px;bottom:0}',
    '.be-cloud.c1{left:7%;top:15%;transform:scale(.72)}.be-cloud.c2{right:-2%;top:29%;transform:scale(.9);opacity:.2}',
    '.be-horizon{left:-8%;right:-8%;top:27%;height:34%;overflow:hidden;}',
    '.be-hill{bottom:-18%;border-radius:50% 50% 18% 18%;background:linear-gradient(165deg,var(--be-hill),var(--be-hill-far));filter:saturate(.85);}',
    '.be-hill.h1{left:-4%;width:54%;height:92%;transform:rotate(6deg)}.be-hill.h2{right:-3%;width:62%;height:104%;transform:rotate(-5deg);background:linear-gradient(165deg,var(--be-hill),var(--be-hill-far))}.be-hill.h3{left:28%;width:46%;height:70%;bottom:-24%;background:var(--be-hill-far);opacity:.8}',
    '.be-ground{left:-18%;right:-18%;top:43%;height:88%;transform-origin:50% 0;transform:perspective(520px) rotateX(57deg);background:linear-gradient(180deg,var(--be-ground) 0%,var(--be-ground-dark) 72%);box-shadow:inset 0 14px 24px rgba(255,255,255,.12);}',
    '.be-grid{inset:0;opacity:.16;background:repeating-linear-gradient(90deg,transparent 0 9.5%,rgba(255,255,255,.35) 10%),repeating-linear-gradient(0deg,transparent 0 13%,rgba(0,0,0,.24) 14%);mask-image:linear-gradient(180deg,transparent,black 22%,black);}',
    '.be-platform{height:10%;border-radius:50%;background:radial-gradient(ellipse,var(--be-accent) 0 45%,var(--be-platform) 47% 66%,rgba(0,0,0,.24) 68%,transparent 72%);filter:drop-shadow(0 12px 9px rgba(0,0,0,.22));}',
    '.be-platform.enemy{width:35%;right:5%;top:48%;transform:scale(.72)}.be-platform.player{width:43%;left:1%;top:70%;}',
    '.be-decor{inset:33% 0 32%;}.be-decor i{bottom:0;width:7%;height:72%;background:linear-gradient(90deg,rgba(0,0,0,.25),var(--be-hill-far));clip-path:polygon(43% 100%,43% 54%,10% 57%,40% 37%,18% 40%,50% 0,82% 40%,60% 37%,90% 57%,57% 54%,57% 100%);filter:drop-shadow(0 6px 4px rgba(0,0,0,.2));opacity:.8}',
    '.be-decor .d1{left:3%;transform:scale(.85)}.be-decor .d2{left:15%;height:48%;opacity:.6}.be-decor .d3{right:4%;transform:scale(.9)}.be-decor .d4{right:18%;height:44%;opacity:.58}',
    '.bm-env[data-biome="cave"] .be-decor i,.bm-env[data-biome="volcano"] .be-decor i,.bm-env[data-biome="rocky"] .be-decor i,.bm-env[data-biome="void"] .be-decor i{clip-path:polygon(50% 0,100% 100%,0 100%);height:54%;width:10%}',
    '.be-depth-fog{left:0;right:0;top:35%;height:25%;background:linear-gradient(180deg,transparent,var(--be-fog),transparent);opacity:.2;filter:blur(7px);}',
    '.be-field{left:11%;right:11%;top:48%;height:40%;border-radius:50%;opacity:0;transform:perspective(420px) rotateX(62deg);background:radial-gradient(ellipse,var(--be-field,#8bdc72),transparent 68%);mix-blend-mode:screen;transition:opacity .35s;}',
    '.bm-env[data-terrain]:not([data-terrain=""]) .be-field{opacity:.58;animation:bePulse 2.8s ease-in-out infinite;}',
    '.be-room{inset:8% 5% 17%;opacity:0;border:2px solid var(--be-room,#ffc861);background:repeating-linear-gradient(90deg,transparent 0 12%,rgba(255,255,255,.14) 12.5%),repeating-linear-gradient(0deg,transparent 0 14%,rgba(255,255,255,.12) 14.5%);box-shadow:inset 0 0 45px rgba(255,255,255,.2);clip-path:polygon(8% 0,92% 0,100% 100%,0 100%);transition:opacity .35s;}',
    '.bm-env[data-room]:not([data-room=""]) .be-room{opacity:.48;}',
    '.be-weather{inset:-15%;opacity:0;transition:opacity .25s;}',
    '.bm-env[data-weather="rain"] .be-weather{opacity:.65;background:repeating-linear-gradient(105deg,transparent 0 14px,rgba(210,230,255,.62) 15px 17px,transparent 18px 31px);animation:beRain .55s linear infinite;}',
    '.bm-env[data-weather="snow"] .be-weather,.bm-env[data-weather="hail"] .be-weather{opacity:.75;background-image:radial-gradient(circle,#fff 0 2px,transparent 2.5px),radial-gradient(circle,rgba(255,255,255,.75) 0 1.5px,transparent 2px);background-size:44px 44px,67px 67px;background-position:0 0,20px 10px;animation:beSnow 4s linear infinite;}',
    '.bm-env[data-weather="sand"] .be-weather{opacity:.42;background:repeating-linear-gradient(170deg,transparent 0 16px,rgba(225,185,105,.48) 17px 20px,transparent 21px 36px);animation:beRain 1.2s linear infinite;}',
    '.bm-env[data-weather="sun"] .be-sun{transform:scale(1.18);box-shadow:0 0 75px rgba(255,225,130,.95)}',
    '.battle-flat>canvas{opacity:0!important;visibility:hidden!important;}.battle-flat .bm-env{visibility:visible;}',
    '@keyframes beRain{to{transform:translate(-28px,72px)}}@keyframes beSnow{to{background-position:44px 88px,87px 144px}}@keyframes bePulse{50%{opacity:.34;transform:perspective(420px) rotateX(62deg) scale(.96)}}',
    '@media(prefers-reduced-motion:reduce){.be-weather,.be-field{animation:none!important}.be-cloud{transform:none!important}}',
    // HUD, all text in VT323 pixel font (matches build/loading/dead screens).
    // No glass backgrounds on cards/buttons — only full-bleed top + bottom gradients
    // frame the play field. Containers are transparent; text relies on shadow for legibility.
    '.battle-hud{position:absolute;inset:0;pointer-events:none;font-family:VT323,"Courier New",monospace;color:#fff;overflow:visible;font-size:18px;}',
    // Top + bottom vignette gradients are painted as fixed full-width pseudo layers
    // so they span edge-to-edge regardless of the centered .col width.
    '.battle-hud::before,.battle-hud::after{content:"";position:fixed;left:0;right:0;width:auto;pointer-events:none;z-index:0;}',
    // TOP gradient: extends from the top of the screen down past the enemy HP card.
    // Lighter than pure-black vignette so the 3D sky/biome still shows through.
    '.battle-hud::before{top:0;height:38vh;background:linear-gradient(180deg,rgba(0,0,0,.55) 0%,rgba(0,0,0,.40) 22%,rgba(0,0,0,.22) 55%,rgba(0,0,0,.07) 80%,rgba(0,0,0,0) 100%);}',
    // BOTTOM gradient: rises from the bottom of the screen up past the move grid
    // to the top of the player HP card, then fades out.
    '.battle-hud::after{bottom:0;height:42vh;background:linear-gradient(0deg,rgba(0,0,0,.55) 0%,rgba(0,0,0,.40) 25%,rgba(0,0,0,.20) 60%,rgba(0,0,0,.06) 82%,rgba(0,0,0,0) 100%);}',
    '.battle-hud .g{background:transparent;border:none;border-radius:0;box-shadow:none;backdrop-filter:none;-webkit-backdrop-filter:none;}',
    '.battle-hud .col{position:absolute;inset:0;max-width:520px;margin:0 auto;left:0;right:0;display:flex;flex-direction:column;padding:0;z-index:1;}',
    // Full-width top bar — date flush left, streak/best flush right, no divider pill.
    '.battle-hud .topbar{pointer-events:auto;position:relative;width:100%;left:0;right:0;margin:0;padding:10px 16px 8px;background:transparent;display:flex;justify-content:space-between;align-items:center;text-align:left;gap:14px;}',
    '.battle-hud .topbar::before{display:none;}',
    '.battle-hud .topbar>*{position:relative;z-index:1;}',
    '.battle-hud .tc{font-size:0.95rem;opacity:0.95;text-shadow:0 2px 10px rgba(0,0,0,.75);white-space:nowrap;text-align:left;}',
    '.battle-hud .sc{font-size:0.95rem;opacity:0.95;text-shadow:0 2px 10px rgba(0,0,0,.75);white-space:nowrap;text-align:right;margin-left:auto;}.battle-hud .sc b{color:#fff;font-weight:400;}',
    '.battle-hud .top-sep{flex:0 0 1px;height:22px;background:rgba(255,255,255,.25);}',
    // HP/name cards fixed equal width.
    '.battle-hud .ec{pointer-events:auto;align-self:flex-start;width:240px;padding:9px 12px;margin-top:12px;margin-left:10px;}',
    '.battle-hud .pc{pointer-events:auto;align-self:flex-end;width:240px;padding:9px 12px;margin:0 10px 4px auto;}',
    '.battle-hud .pr{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;}',
    '.battle-hud .pl{font-size:0.75rem;color:rgba(255,255,255,.6);text-transform:uppercase;letter-spacing:1px;}',
    '.battle-hud .pn{font-size:1.35rem;font-weight:400;line-height:1.05;margin-top:2px;white-space:nowrap;}',
    '.battle-hud .ll{font-size:0.7rem;color:rgba(255,255,255,.55);text-transform:uppercase;letter-spacing:1px;text-align:right;}',
    '.battle-hud .lv{font-size:1.1rem;color:rgba(255,255,255,.92);line-height:1;text-align:right;}',
    '.battle-hud .ts{display:flex;gap:4px;margin-top:6px;flex-wrap:wrap;}',
    '.battle-hud .tb{border-radius:999px;padding:2px 8px;font-size:0.8rem;color:#fff;text-transform:uppercase;letter-spacing:.5px;}',
    '.battle-hud .ht{margin-top:7px;height:9px;background:rgba(0,0,0,.4);border-radius:999px;overflow:hidden;}',
    '.battle-hud .hf{height:100%;border-radius:999px;transition:width .6s cubic-bezier(.22,.61,.36,1),background-color .35s ease;will-change:width;}',
    '.battle-hud .hm{display:flex;justify-content:space-between;align-items:center;margin-top:5px;gap:8px;min-height:18px;}',
    '.battle-hud .hn{font-size:1rem;color:#fff;font-variant-numeric:tabular-nums;}',
    // Stronger text shadow on names/numbers/levels now that the card glass is gone.
    '.battle-hud .pn{text-shadow:0 2px 10px rgba(0,0,0,.95),0 0 18px rgba(0,0,0,.7),1px 1px 0 rgba(0,0,0,.6);}',
    '.battle-hud .pl,.battle-hud .ll,.battle-hud .hn,.battle-hud .lv{text-shadow:0 2px 8px rgba(0,0,0,.85),0 0 12px rgba(0,0,0,.5);}',
    // HP track stays so the bar has something to live inside of, but dimmed.
    '.battle-hud .ht{background:rgba(0,0,0,.45);box-shadow:0 1px 6px rgba(0,0,0,.35);}',
    // Type badges keep a subtle chip so they don't melt into the gradient —
    // but tiny, no heavy glass.
    '.battle-hud .tb{text-shadow:0 1px 2px rgba(0,0,0,.7);box-shadow:0 1px 4px rgba(0,0,0,.3);}',
    // Status badge: minimal chip, no glass.
    '.battle-hud .sb{display:inline-block;font-size:0.75rem;padding:2px 7px;border-radius:4px;letter-spacing:.5px;background:rgba(0,0,0,.45);border:1px solid rgba(255,255,255,.2);text-shadow:0 1px 2px rgba(0,0,0,.7);box-shadow:0 1px 4px rgba(0,0,0,.3);}',
    // Move grid container
    '.battle-hud .bb{pointer-events:auto;margin:6px 10px 0;display:flex;flex-direction:column;gap:8px;padding-bottom:max(10px,env(safe-area-inset-bottom));}',
    // Battle message — no background of its own; lives on the bottom gradient.
    '.battle-hud .bm-msg{pointer-events:none;padding:8px 12px;text-align:center;font-size:1.15rem;color:#fff;text-shadow:0 2px 10px rgba(0,0,0,.95),0 0 20px rgba(0,0,0,.75),1px 1px 0 rgba(0,0,0,.7);background:transparent;border:none;border-radius:0;backdrop-filter:none;-webkit-backdrop-filter:none;}',
    '.battle-hud .mv{display:grid;grid-template-columns:1fr 1fr;gap:8px;}',
    // Move buttons: glassmorphism (frosted white) with NO border.
    '.battle-hud .mb{position:relative;text-align:left;border-radius:0.8rem;padding:9px 12px;border:none;background:rgba(255,255,255,.18)!important;color:#fff;cursor:pointer;transition:transform .08s,background-color .15s,opacity .15s;font-family:inherit;font-size:1rem;text-shadow:0 1px 4px rgba(0,0,0,.55);backdrop-filter:blur(14px) saturate(1.3);-webkit-backdrop-filter:blur(14px) saturate(1.3);box-shadow:0 4px 18px rgba(0,0,0,.22);}',
    '.battle-hud .mb:hover:not(:disabled){background:rgba(255,255,255,.28)!important;}',
    '.battle-hud .mb:active:not(:disabled){transform:scale(.97);}',
    '.battle-hud .mb:disabled{opacity:.4;cursor:not-allowed;}',
    '.battle-hud .mt{display:flex;align-items:center;justify-content:space-between;gap:8px;}',
    '.battle-hud .tb.mn{font-size:0.7rem;padding:2px 6px;}',
    '.battle-hud .pw{font-size:0.75rem;color:rgba(255,255,255,.6);text-transform:uppercase;letter-spacing:.5px;font-variant-numeric:tabular-nums;}',
    '.battle-hud .mn{font-size:1.15rem;line-height:1.15;margin-top:3px;text-shadow:0 1px 0 rgba(0,0,0,.25);}',
    '.battle-hud .pp{display:flex;align-items:center;gap:6px;margin-top:5px;}',
    '.battle-hud .pt{flex:1;height:6px;background:rgba(0,0,0,.4);border-radius:999px;overflow:hidden;box-shadow:inset 0 1px 2px rgba(0,0,0,.4);}',
    '.battle-hud .pf{height:100%;border-radius:999px;transition:width .4s ease;box-shadow:0 0 6px rgba(255,255,255,.2);}',
    '.battle-hud .pn2{font-size:0.9rem;color:rgba(255,255,255,.85);font-variant-numeric:tabular-nums;text-shadow:0 1px 4px rgba(0,0,0,.8);}',
    '.battle-hud .pw{text-shadow:0 1px 4px rgba(0,0,0,.8);}',
    '.battle-hud .mn{text-shadow:0 1px 6px rgba(0,0,0,.85),0 0 10px rgba(0,0,0,.5);}',
    // Effectiveness badges: inline next to the type badge (not a floating top-right chip).
    '.battle-hud .mt-left{display:inline-flex;align-items:center;gap:5px;}',
    '.battle-hud .ef{font-size:0.78rem;padding:2px 6px;border-radius:6px;text-shadow:0 1px 1px rgba(0,0,0,.4);box-shadow:0 1px 4px rgba(0,0,0,.3);line-height:1;}',
    '.battle-hud .ef.se{background:rgba(251,191,36,.9);color:#451a03;}.battle-hud .ef.nv{background:rgba(100,116,139,.9);color:#fff;}.battle-hud .ef.im{background:rgba(0,0,0,.8);color:#fff;}',
    '.battle-hud .mr{grid-column:1/-1;display:flex;gap:6px;}',
    // Mega / Z buttons: glassmorphism matching move buttons, no border.
    '.battle-hud .mg{flex:1;padding:7px 0;border-radius:.7rem;border:none;background:rgba(255,255,255,.15);color:#fff;cursor:pointer;font-family:inherit;font-size:0.95rem;letter-spacing:.8px;text-transform:uppercase;transition:all .12s;text-shadow:0 1px 4px rgba(0,0,0,.55);backdrop-filter:blur(12px) saturate(1.3);-webkit-backdrop-filter:blur(12px) saturate(1.3);box-shadow:0 4px 14px rgba(0,0,0,.2);}',
    '.battle-hud .mg:hover{background:rgba(255,255,255,.25);}',
    '.battle-hud .mg.ac{background:rgba(255,255,255,.92);color:#111;text-shadow:none;box-shadow:0 4px 18px rgba(0,0,0,.25);}',
    // Floating damage numbers + popups (pixel font)
    '.bfs{position:absolute;inset:0;pointer-events:none;z-index:3;}',
    '.bf{position:absolute;transform:translate(-50%,-50%);font-size:2.4rem;color:#fff;font-family:VT323,"Courier New",monospace;text-shadow:2px 2px 0 #b91c1c,0 4px 20px rgba(0,0,0,.6);animation:bfu 1.2s ease-out forwards;}',
    '.bf.bh{color:#baffc2;text-shadow:2px 2px 0 #134e24,0 4px 20px rgba(0,0,0,.5);}',
    '.bp{position:absolute;transform:translate(-50%,-50%);font-size:1.05rem;padding:4px 12px;border-radius:999px;background:rgba(0,0,0,.55);color:#fff;border:1px solid rgba(255,255,255,.35);text-shadow:0 1px 4px rgba(0,0,0,.9);box-shadow:0 2px 10px rgba(0,0,0,.4);animation:bpp 1.3s ease-out forwards;white-space:nowrap;}',
    '.bp.se{background:rgba(251,191,36,.92);color:#451a03;border-color:#fbbf24;text-shadow:0 1px 1px rgba(255,255,255,.25);}.bp.nv{background:rgba(100,116,139,.9);color:#fff;}.bp.cr{background:rgba(239,68,68,.92);color:#fff;border-color:#ef4444;}.bp.mi{background:rgba(107,114,128,.9);color:#fff;}',
    '@keyframes bfu{0%{opacity:0;transform:translate(-50%,0) scale(.7);}18%{opacity:1;transform:translate(-50%,-20px) scale(1.3);}100%{opacity:0;transform:translate(-50%,-70px) scale(1);}}',
    '@keyframes bpp{0%{opacity:0;transform:translate(-50%,0) scale(.7);}15%{opacity:1;transform:translate(-50%,-8px) scale(1.06);}80%{opacity:1;}100%{opacity:0;transform:translate(-50%,-30px) scale(1);}}'
  ].join('\n');
  var s=document.createElement('style');s.id='bm-styles';s.textContent=css;document.head.appendChild(s);
}

function _badgeHtml(st){
  var m={brn:['BRN','#f08030'],psn:['PSN','#a040a0'],par:['PAR','#f8d030'],slp:['SLP','#999'],frz:['FRZ','#98d8d8'],tox:['TOX','#c040c0']};
  if(!st||!m[st])return '';
  return '<span class="sb" style="background:'+m[st][1]+'33;color:'+m[st][1]+';border:1px solid '+m[st][1]+'">'+m[st][0]+'</span>';
}

BattleUI.prototype.render = function(){
  if(!this.hud)return;
  var p=this.s.p,e=this.s.e,h=this.s.hdr;
  var pp=Math.round(p.hp*100),ep=Math.round(e.hp*100);
  function tb(t,mn){var c=TC[t]||'#888';return '<span class="tb'+(mn?' mn':'')+'" style="background:'+c+'">'+(t||'')+'</span>';}
  function badges(arr,mn){var out='';for(var i=0;i<arr.length;i++)out+=tb(arr[i],mn);return out;}
  function hc(f){return f>0.5?'#4ade80':f>0.2?'#facc15':'#ef4444';}
  var et=badges(e.types||[]),pt=badges(p.types||[]);
  var mv='';
  if(this.s.mega.cm||this.s.mega.cx||this.s.mega.cy){
    mv+='<div class="mr">';
    if(this.s.mega.cm)mv+='<button class="mg" data-m="mega">Mega Evolve</button>';
    if(this.s.mega.cx)mv+='<button class="mg" data-m="megax">Mega X</button>';
    if(this.s.mega.cy)mv+='<button class="mg" data-m="megay">Mega Y</button>';
    mv+='</div>';
  }
  for(var idx=0;idx<this.s.moves.length;idx++){
    var m=this.s.moves[idx];var eb='';
    if(m.eff>=2)eb='<span class="ef se">×'+m.eff+'</span>';
    else if(m.eff>0&&m.eff<1)eb='<span class="ef nv">×'+m.eff+'</span>';
    else if(m.eff===0)eb='<span class="ef im">—</span>';
    var frac=m.max?m.pp/m.max:0;var col=frac>0.3?(TC[m.type]||'#fff'):'#ef4444';
    var dis=(m.disabled||this.s.locked)?'disabled':'';var pw=m.power?('Pow '+m.power):(m.type==='Status'?'Status':'');
    mv+='<button class="mb" data-i="'+idx+'" data-move="'+(m.id||'')+'" data-status="'+(m.type==='Status'?1:0)+'" '+dis+'>'+
      '<div class="mt"><span class="mt-left">'+tb(m.type,true)+eb+'</span><span class="pw">'+pw+'</span></div>'+
      '<div class="mn">'+(m.name||'')+'</div>'+
      '<div class="pp"><div class="pt"><div class="pf" style="width:'+(frac*100)+'%;background:'+col+'"></div></div><span class="pn2">'+m.pp+'/'+m.max+'</span></div>'+
      '</button>';
  }
  var datePart=h.date?('Daily Star Run · '+h.date):'Daily Star Run';
  var sw=(h.sw||'streak');sw=sw.charAt(0).toUpperCase()+sw.slice(1).toLowerCase();
  var dexStr=h.dexV?(' · Dex <b>'+h.dexN+'/'+h.dexT+'</b>'):'';
  var streakPart=sw+' '+(h.streak??0)+' · Best <b>'+(h.best??0)+'</b>'+dexStr;
  // Top bar: date flush left, streak/best flush right, no extra buttons.
  var hd='<div class="topbar"><div class="tc">'+datePart+'</div><div class="sc">'+streakPart+'</div></div>';
  var html='<div class="col">'+hd+
    '<div class="g ec"><div class="pr"><div style="min-width:0;flex:1"><div class="pl">Wild Pokémon</div><div class="pn">'+(e.name||'—')+'</div></div><div><div class="ll">Level</div><div class="lv">'+(e.lv||100)+'</div></div></div>'+
    '<div class="ts">'+et+'</div>'+
    '<div class="ht"><div class="hf e-hp" style="width:'+ep+'%;background:'+hc(e.hp)+'"></div></div>'+
    '<div class="hm"><span class="e-sb">'+_badgeHtml(e.st)+'</span><span class="hn e-hn">'+ep+'%</span></div></div>'+
    '<div style="flex:1"></div>'+
    '<div class="g pc"><div class="pr"><div style="min-width:0;flex:1"><div class="pl">Your Pokémon</div><div class="pn">'+(p.name||'—')+'</div></div><div><div class="ll">Level</div><div class="lv">'+(p.lv||100)+'</div></div></div>'+
    '<div class="ts">'+pt+'</div>'+
    '<div class="ht"><div class="hf p-hp" style="width:'+pp+'%;background:'+hc(p.hp)+'"></div></div>'+
    '<div class="hm"><span class="p-sb">'+_badgeHtml(p.st)+'</span><span class="hn p-hn">'+pp+'%</span></div></div>'+
    '<div class="bb"><div class="bm-msg">'+(this.s.msg||'')+'</div><div class="mv">'+mv+'</div></div>'+
    '</div><div class="bfs"></div>';
  this.hud.innerHTML=html;
  var d=this._dom={};
  d.msg=this.hud.querySelector('.bm-msg');
  d.bfs=this.hud.querySelector('.bfs');
  d['e-hp']=this.hud.querySelector('.e-hp');
  d['p-hp']=this.hud.querySelector('.p-hp');
  d['e-hn']=this.hud.querySelector('.e-hn');
  d['p-hn']=this.hud.querySelector('.p-hn');
  d['e-sb']=this.hud.querySelector('.e-sb');
  d['p-sb']=this.hud.querySelector('.p-sb');
  var megaM={m:this.s.mega.a||null};
  var self=this;
  var mgs=this.hud.querySelectorAll('.mg');
  for(var mi=0;mi<mgs.length;mi++){
    var b=mgs[mi];if(b.dataset.m===this.s.mega.a)b.classList.add('ac');
    b.addEventListener('click',(function(btn){return function(){
      megaM.m=(megaM.m===btn.dataset.m)?null:btn.dataset.m;
      self.hud.querySelectorAll('.mg').forEach(function(x){x.classList.remove('ac');});
      if(megaM.m)btn.classList.add('ac');
    };})(b));
  }
  var mbs=this.hud.querySelectorAll('.mb');
  for(var bi=0;bi<mbs.length;bi++){
    var btn2=mbs[bi];
    btn2.addEventListener('click',(function(bb){return function(){
      if(self.s.locked)return;var i=parseInt(bb.dataset.i,10);if(isNaN(i))return;
      self.s.locked=true;self.hud.querySelectorAll('.mb').forEach(function(x){x.disabled=true;});
      self.s.onMove&&self.s.onMove({moveIndex:i,mega:megaM.m});megaM.m=null;
    };})(btn2));
  }
};

window.BattleUI = BattleUI;
})();
