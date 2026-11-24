# Slop's Last Cry

A personal, unofficial port of the iOS game *Banshee's Last Cry* (Aksys Games, 32-bit iOS) to a small web engine,
so it can be played on PC browsers and on Android.

**This repository contains no game content.** No text, images, music or fonts from the game are included in the
code, the web zip or the APK. You need your own copy of the game as an `.ipa` file. On first run, the setup page
reads that file and converts everything locally, on your own device:

- the `page.plist` scripts and other plists become `engine/data.js`;
- Apple's "CgBI" PNGs become standard PNGs, and the engine's interface images are cropped from them;
- the IMA4 `.aif` and ALAC `.m4a` audio becomes Opus in WebM (`engine/audio/*.webm`), keeping the loop points.

Don't share converted game files.

## Layout

| Path | What it is |
| --- | --- |
| `web/` | The engine (`index.html`, `engine/`) and the first-run converter (`setup.html`, `setup/`). |
| `android/` | A thin Android wrapper: a full-screen WebView that serves `web/` from the APK and the converted game from the app's private storage. |
| `.github/workflows/build.yml` | Builds both versions on every push. |

## Web version (PC)

1. Download `slops-last-cry-web.zip` from the latest Actions run (or a release) and unzip it into a folder.
2. Open `setup.html` in **Chrome or Edge** (the converter needs WebCodecs and the File System Access API).
3. Choose your `.ipa`, then choose the unzipped folder. The converter writes `ink-en.app/` and `engine/` files into it.
4. Open `index.html`. If your browser blocks local files, serve the folder instead, for example
   `python -m http.server` and open `http://localhost:8000/`.

## Android version

1. Install `slops-last-cry.apk` from the latest Actions run (allow installing from unknown sources).
2. Open the app and tap **Choose the .ipa…**, or first copy the `.ipa` to
   `Android/obb/xyz.mariosjaque.slopslastcry/main.1.xyz.mariosjaque.slopslastcry.obb` so the setup page finds it and offers **Use it**.
3. Wait for extraction and conversion (a few minutes; about 1 GB of free space is needed during setup).
   After that the game starts directly. The original `.ipa`/OBB can be deleted.

Requires Android 8.0 or newer with an up-to-date Android System WebView (Chrome 94+).

## Building

- **Web:** nothing to build; `web/` is the release. The workflow just zips it.
- **Android:** JDK 17, Android SDK 34 and Gradle 8.7: `gradle -p android assembleRelease`.
  
## Third-party code and fonts

- `web/setup/alac.js` is adapted from [audiocogs/alac.js](https://github.com/audiocogs/alac.js) (Apache License 2.0).
  Its notice is kept in the file.
- `web/engine/fonts/LibreBaskerville-*` is Libre Baskerville by Impallari Type, under the SIL Open Font License 1.1
  (`LibreBaskerville-OFL.txt`). It is used as a stand-in for the Marion font that iOS provided.

*Banshee's Last Cry* and its content belong to their respective owners. This project is not affiliated with or
endorsed by them.
The code in this repo was completely made by Claude Opus 5.5, zero lines were made or reviewed by a human.