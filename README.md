# React + TypeScript + Vite
Cloudflare Durable Objects と WebSocket を用いた2人用リアルタイムお絵描きアプリ。

## 必要環境
+ Node.js
+ npm
+ Cloudflare

# はじめかた
ローカル起動

``` powershell
npm run dev
```

本番ビルド/デプロイ

``` powershell
npm run build
npm run deploy
```

<!--
## メモ
Cloudflare Workers と Durable Object がバックエンドになっている。
`ctx.storage.get()` と、
`put()` と、
`delete()`
 によりルーム状態と描画済みストロークを保存している。<br>

### Cloudflare Workers
Cloudflare Workers は、Cloudflareの世界中のネットワーク上で、自分のサーバを管理せずにプログラムを実行できるサーバレス実行環境。サーバ管理なしでアプリを構築・デプロイ・スケールできるプラットフォーム。現在の実装では、 Cloudflare Workers へデプロイする構成であり、Cloudflare Tunnel は使っていない。

### Durable Object
 Durable Object は Cloudflare が提供している「状態(state)を持てるサーバレス実行単位」

-->