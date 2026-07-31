# Third-party notices

Dailylocke distributes the following third-party software:

| Component | Distributed file(s) | Copyright / source | License |
| --- | --- | --- | --- |
| `@pkmn/sim` 0.10.11 | `vendor/pkmn-sim.js`, `vendor/pkmn-learnsets.js` | Copyright © 2011–2026 Guangcong Luo and other Pokémon Showdown contributors; <https://github.com/pkmn/ps> | MIT |
| three.js r149 | `vendor/three.min.js` | Copyright © 2010–2023 three.js authors; <https://github.com/mrdoob/three.js> | MIT |
| VT323 | `assets/fonts/vt323-*.woff2` | Copyright © 2011 The VT323 Project Authors (peter.hull@oikoi.com); <https://github.com/googlefonts/VT323> | SIL Open Font License 1.1 |

The MIT license for those components follows:

> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the “Software”), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

VT323 is licensed under the SIL Open Font License, Version 1.1, whose full text
is distributed alongside the font files in
[`assets/fonts/LICENSE-VT323.txt`](assets/fonts/LICENSE-VT323.txt). The font is
self-hosted (rather than loaded from Google Fonts) so the app renders correctly
offline.

## Remotely loaded assets and data

The app loads Pokémon sprites, item art, trainer art, cries, and battle music
from Pokémon Showdown and PokeAPI-hosted repositories at runtime. Capture rates
and item costs in `src/pokedata.js` were derived from PokéAPI. These assets and
Pokémon-related data are **not** covered by the software licenses above.

Note in particular that the PokeAPI sprites repository is itself distributed
under CC0 while stating that the *image contents* remain copyright The Pokémon
Company. A permissive repository license is therefore not a license to the
artwork, and CC0 on the repository does not make the sprites free to use.

The placeholder art in `assets/img/` is original to this project and contains no
Pokémon likeness; it exists so the UI degrades gracefully when the remote
sprite hosts are unreachable.

Pokémon and Pokémon character names are trademarks of Nintendo. Pokémon
artwork and audio are copyright Nintendo, Creatures Inc., GAME FREAK Inc.,
and/or The Pokémon Company. Dailylocke is an unofficial, non-commercial fan
project and is not endorsed by or affiliated with those rights holders.

## Dailylocke's own code

Dailylocke's own source is MIT licensed — see [`LICENSE`](LICENSE). That license
covers this project's code only and grants no rights to any of the third-party
software or Pokémon assets described above.

Obtain independent legal advice before monetizing this project or distributing
it through an app store.
