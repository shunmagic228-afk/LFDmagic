# このフォルダ内のファイルについて

このアプリの「自動切り抜き」機能(AI)は、以下のオープンソースを利用しています。
いずれも端末上で完結して動作し、写真をどこにも送信しません。

## onnxruntime-web

- ファイル: `ort.min.js`, `ort-wasm-simd-threaded.wasm`, `ort-wasm-simd-threaded.mjs`
- 配布元: https://github.com/microsoft/onnxruntime (npm: onnxruntime-web)
- ライセンス: MIT License
- 用途: ブラウザ上でAIモデル(ONNX形式)を実行するためのランタイム

## U^2-Netp (u2netp.onnx)

- 配布元(モデル本体の配布): https://github.com/danielgatis/rembg (MIT License)
- 元モデル: U^2-Net (Qin et al.) https://github.com/xuebinqin/U-2-Net
- ライセンス: Apache License 2.0
- 用途: 写真から被写体を認識し、背景を切り抜くための画像セグメンテーションモデル
