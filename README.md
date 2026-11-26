# Slop's Last Cry

A unofficial port of the iOS game *Banshee's Last Cry* (Aksys Games, 32-bit iOS) to a small web engine,
so it can be played on PC browsers, Android, PS Vita and New 3DS.

**This repository contains no game content.** No text, images, music or fonts from the game are included in the
code, the web zip or the APK. You need your own copy of the game as an `.ipa` file. On first run, the setup page
reads that file and converts everything locally, on your own device:

- the `page.plist` scripts and other plists become `engine/data.js`;
- Apple's "CgBI" PNGs become standard PNGs, and the engine's interface images are cropped from them;
- the IMA4 `.aif` and ALAC `.m4a` audio becomes Opus in WebM (`engine/audio/*.webm`), keeping the loop points.

Don't share converted game files.

## Relevant information 
The original iOS version had HTML files for every dialog page, plus embedded CSS and JavaScript elements. The entire engine was seemingly based on a JavaScript component, so it should be trivial to make an actual human version of this. I was too lazy so I just asked the clanker to do it and gave it access to an emulator so it could check some stuff lol

## Layout

| Path | What it is |
| --- | --- |
| `web/` | The engine (`index.html`, `engine/`) and the first-run converter (`setup.html`, `setup/`). |
| `android/` | A thin Android wrapper: a full-screen WebView that serves `web/` from the APK and the converted game from the app's private storage. |
| `vita/` | A version of the engine that runs on PS Vita using the same assets. |
| `n3ds/` | The New 3DS host. It runs the same game engine as the Vita (`vita/js/game.js`) with the console held like a book. |
| `.github/workflows/build.yml` | Builds every version on every push. |

## Web version (PC)

1. Download `slops-last-cry-web.zip` from the latest release and unzip it into a folder.
2. Open `setup.html` in **Chrome or Edge** (the converter needs WebCodecs and the File System Access API).
3. Choose your `.ipa`, then choose the unzipped folder. The converter writes `ink-en.app/` and `engine/` files into it.
4. Open `index.html`. If your browser blocks local files, serve the folder instead, for example
   `python -m http.server` and open `http://localhost:8000/`.

## Android version

1. Install `slops-last-cry.apk` from the latest release (allow installing from unknown sources).
2. Open the app and tap **Choose the .ipa…**, or first copy the `.ipa` to
   `Android/obb/xyz.mariosjaque.slopslastcry/main.1.xyz.mariosjaque.slopslastcry.obb` so the setup page finds it and offers **Use it**.
3. Wait for extraction and conversion (a few minutes; about 1 GB of free space is needed during setup).
   After that the game starts directly. The original `.ipa`/OBB can be deleted.

Requires Android 8.0 or newer with an up-to-date Android System WebView (Chrome 94+).

## PS Vita version

1. Download `slops-last-cry-vita.vpk` and `slops-last-cry-web.zip` from the latest release and unzip them into a folder.
2. Open `setup.html` in **Chrome or Edge** (the converter needs WebCodecs and the File System Access API).
3. Choose your `.ipa`, then choose the unzipped folder. The converter writes the folder `slc-vita/` .
4. Copy `slc-vita/` as `slc/` to `ux0:/data` on your Vita.
5. Install the vpk file on your Vita.
6. Launch the game and you're ready to play.

## New 3DS version

Held sideways like a book: one screen shows the text, the other the picture, and choices and menus are on the touch screen.
Settings has **Text screen** (top or touch screen) and **Top screen side** (left or right).

1. Download `slops-last-cry.3dsx` and `slops-last-cry-web.zip` from the latest release and unzip the zip into a folder.
2. Open `setup.html` in **Chrome or Edge**, choose your `.ipa` and the unzipped folder, then press **Make 3DS files**.
3. Copy `slc-3ds/` as `slc/` to `3ds/` on your SD card (so the files are in `sdmc:/3ds/slc/`), and `slops-last-cry.3dsx` to `3ds/`.
4. Start it from the Homebrew Launcher. Sound needs `sdmc:/3ds/dspfirm.cdc` (Luma3DS: Rosalina menu > Miscellaneous options > Dump DSP firmware).
   
## Building

- **Web:** nothing to build; `web/` is the release. The workflow just zips it.
- **Android:** JDK 17, Android SDK 34 and Gradle 8.7: `gradle -p android assembleRelease`.
- **PS Vita:** soon idk
- **New 3DS:** devkitARM with `3ds-dev`, plus checkouts of quickjs-ng in `n3ds/quickjs` and stb in `n3ds/stb`: `make -C n3ds`.
  
## Third-party code and fonts

- `web/setup/alac.js` is adapted from [audiocogs/alac.js](https://github.com/audiocogs/alac.js) (Apache License 2.0).
  Its notice is kept in the file.
- `web/engine/fonts/LibreBaskerville-*` is Libre Baskerville by Impallari Type, under the SIL Open Font License 1.1
  (`LibreBaskerville-OFL.txt`). It is used as a stand-in for the Marion font that iOS provided.
- The Vita and 3DS builds also bundle Lato by Łukasz Dziedzic (SIL Open Font License 1.1, `vita/fonts/Lato-OFL.txt`),
  and are built with [QuickJS-ng](https://github.com/quickjs-ng/quickjs) (MIT); the 3DS build also uses
  [stb_image and stb_truetype](https://github.com/nothings/stb) (public domain / MIT).

*Banshee's Last Cry* and its content belong to their respective owners. This project is not affiliated with or
endorsed by them.

The code in this repo was completely made by Claude Opus 5.5, zero lines were made or reviewed by a human.
