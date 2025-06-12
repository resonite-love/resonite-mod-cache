# Resonite MOD Cache

このリポジトリは、Resonite MODの情報をキャッシュし、レートリミットを回避するためのものです。

## 仕組み

1. **GitHub Actions**: 毎日午前0時（UTC）に自動実行
2. **データ収集**: 公式MODマニフェストを取得し、各MODのGitHubリリース情報を収集
3. **キャッシュ生成**: 収集した情報を`cache/mods.json`に保存
4. **利用**: Resonite Toolsアプリケーションがこのキャッシュを使用

## ファイル構成

```
.github/workflows/update-cache.yml  # GitHub Actionsワークフロー
scripts/collect-mod-info.js         # MOD情報収集スクリプト
cache/mods.json                     # キャッシュされたMOD情報
package.json                        # Node.js依存関係
```

## 手動実行

```bash
npm install
npm run update
```

## キャッシュデータ構造

```json
[
  {
    "name": "MOD名",
    "description": "MODの説明",
    "category": "カテゴリ",
    "source_location": "GitHubリポジトリURL",
    "author": "作者名",
    "latest_version": "最新バージョン",
    "latest_download_url": "ダウンロードURL",
    "release_url": "リリースページURL",
    "published_at": "公開日時",
    "tags": ["タグ1", "タグ2"],
    "flags": ["フラグ1"],
    "last_updated": "最終更新日時"
  }
]
```

## レート制限対策

- GitHub Actionsの`GITHUB_TOKEN`を使用してAPI制限を緩和
- 各API呼び出し間に100msの待機時間
- 1日1回の更新頻度でレート制限を回避

## 利用方法

Resonite Toolsアプリケーションは以下のURLからキャッシュを取得します：

```
https://raw.githubusercontent.com/YOUR_USERNAME/resonite-mod-cache/main/cache/mods.json
```

## セットアップ

1. このリポジトリをGitHubにプッシュ
2. GitHub Actionsが自動的に有効化
3. 初回実行は手動トリガーまたは翌日0時に実行
4. Resonite Toolsのコードで`YOUR_USERNAME`を実際のユーザー名に置換