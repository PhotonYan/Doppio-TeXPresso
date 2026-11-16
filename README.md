# Real-Time LaTeX

Incremental **XeLaTeX and pdfLaTeX** preview inside VS Code. See changes as you type, select text in the PDF, and jump between the preview and the source.

![LaTeX source and its compiled PDF open side by side in VS Code](https://raw.githubusercontent.com/PhotonYan/Real_Time_LaTeX/main/assets/preview.png)

- **XeLaTeX** uses TeXpresso with local changes for embedded previews, fonts, and source navigation. It supports editing in included files and compiling `subfiles` chapters.
- **pdfLaTeX** uses FlashTeX's resident engine. After an edit, it can resume from a checkpoint and reuse unchanged pages.
- **Both** render unsaved edits, open in a side-by-side editor tab, and support source-to-PDF and PDF-to-source navigation. The preview follows edits after compilation.

In the 24-page pdfLaTeX integration test, an unsaved edit on page 18 kept the same compiler process, reused the first 17 pages, and retypeset only 2 pages.

## Install on macOS

The first release was tested on Apple Silicon with TeX Live and desktop VS Code. Install the VSIX from the [latest GitHub release](https://github.com/PhotonYan/Real_Time_LaTeX/releases/latest) with **Extensions: Install from VSIX…**. If you already use the TeXpresso VS Code extension, disable it before enabling Real-Time LaTeX, since the extensions share command and setting identifiers.

Install the [Xcode Command Line Tools](https://developer.apple.com/xcode/resources/), [Homebrew](https://brew.sh/), [Rust](https://rustup.rs/), and a TeX Live distribution such as [MacTeX](https://www.tug.org/mactex/). Then build the engines once:

```sh
brew install mupdf-tools sdl2 pkgconf fontconfig harfbuzz freetype icu4c@78
git clone https://github.com/PhotonYan/Real_Time_LaTeX.git
cd Real_Time_LaTeX
./scripts/build-engines-macos.sh
```

The script builds the pinned engine sources with the patches in this repository. Copy the settings it prints into **Preferences: Open User Settings (JSON)**. Keep the checkout where you built it, since the settings point to its engine binaries.

## Use

1. Open a `.tex` file. Open the command palette (`⌘⇧P` on macOS) and run **Real-Time LaTeX: Start Document**.
2. Choose **XeLaTeX** or **pdfLaTeX**. If the open file is an included file and has no `% !TeX root = ...` directive, select the main file when prompted.
3. To jump from PDF to source, hold `⌘` or `Ctrl` and click rendered text. To jump from source to PDF, place the caret on a source line and run **Real-Time LaTeX: SyncTeX Forward**.

**Real-Time LaTeX: Open Preview (Auto)** reuses a running preview. When starting a new preview, Auto reads the main file's `% !TeX program = pdflatex` directive, and defaults to XeLaTeX without it. You can set `texpresso.engine` at the workspace level if you prefer.

Use your usual LaTeX Workshop or `latexmk` build to produce the final PDF and regenerate bibliographies and indexes. FlashTeX previews use an isolated copy of the project and run with shell escape disabled.

## Build the extension from source

Use Node.js 22+ and npm.

```sh
npm ci
npm test
npm exec --yes --package=@vscode/vsce@3.7.1 -- npm run package:vsix
```

Install `artifacts/texpresso.vsix` using **Extensions: Install from VSIX…**.

## Credits and licenses

The VS Code extension builds on [Dominik Peters's TeXpresso extension](https://github.com/DominikPeters/texpresso-vscode), which integrates [Frédéric Bour's TeXpresso](https://github.com/let-def/texpresso). This project adds dual-engine integration, the compiler picker, selectable preview text, and changes to editing and navigation. The VS Code extension retains the upstream [MIT license](https://github.com/PhotonYan/Real_Time_LaTeX/blob/main/LICENSE).

The XeLaTeX backend uses the [TeXpresso VS Code fork](https://github.com/DominikPeters/texpresso/tree/7f3d752832d3de75d79408a839d1e132f281063f). The pdfLaTeX backend communicates with [FlashTeX](https://github.com/flash-tex/flashtex/tree/28cb0d7b80a8f01bf60e196112663d5a0be744e7) over its [display-list protocol](https://github.com/flash-tex/flashtex/blob/28cb0d7b80a8f01bf60e196112663d5a0be744e7/docs/protocol/display-list-v3.md). The FlashTeX engine is GPL-2.0-or-later. [MuPDF](https://mupdf.com/) provides PDF rendering. The VSIX includes the extension code and UI assets, with the engines and renderer installed separately.

See [native build notes](https://github.com/PhotonYan/Real_Time_LaTeX/blob/main/native/README.md) for development and [engine patches](https://github.com/PhotonYan/Real_Time_LaTeX/tree/main/native/patches/) for the local changes.
