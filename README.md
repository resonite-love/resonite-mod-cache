# Resonite MOD Cache

このリポジトリは、Resonite MODの情報をキャッシュし、レートリミットを回避するためのものです。

## 仕組み

1. **GitHub Actions**: 複数のスケジュールで自動実行
   - **週次更新**: 毎週日曜日午前1時（UTC）- 標準のMOD情報更新
   - **月次ハッシュ更新**: 毎月1日午前2時（UTC）- SHA256ハッシュ計算付き更新
2. **データ収集**: 
   - 公式MODマニフェストからMOD情報を取得
   - `repositories.json`に追加されたリポジトリからもMOD情報を収集
   - 各MODのGitHubリリース情報を収集
3. **キャッシュ生成**: 収集した情報を`cache/mods.json`と`cache/hash-lookup.json`に保存
4. **利用**: Resonite Toolsアプリケーションがこのキャッシュを使用

## ファイル構成

```
.github/workflows/
├── update-cache-weekly.yml         # 週次更新ワークフロー
└── update-cache-with-hashes.yml    # 月次ハッシュ更新ワークフロー
.github/PULL_REQUEST_TEMPLATE/
└── add_repository.md               # リポジトリ追加用PRテンプレート
scripts/
├── collect-mod-info.js             # 標準MOD情報収集スクリプト
└── collect-mod-info-with-hashes.js # ハッシュ計算付きスクリプト
cache/
├── mods.json                       # キャッシュされたMOD情報
└── hash-lookup.json               # SHA256ハッシュルックアップテーブル
repositories.json                   # 追加リポジトリ設定ファイル
package.json                        # Node.js依存関係
```

## 手動実行

```bash
npm install

# 標準更新
npm run update

# ハッシュ計算付き更新
npm run update-with-hashes
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
    "latest_download_url": "最新ダウンロードURL",
    "releases": [
      {
        "version": "v1.2.0",
        "download_url": "ダウンロードURL",
        "release_url": "リリースページURL",
        "published_at": "2024-01-15T10:30:00Z",
        "prerelease": false,
        "draft": false,
        "changelog": "変更ログ",
        "file_name": "ModName.dll",
        "file_size": 102400,
        "sha256": "a1b2c3d4e5f6..."
      }
    ],
    "tags": ["タグ1", "タグ2"],
    "flags": ["フラグ1"],
    "last_updated": "最終更新日時",
    "hash_metadata": {
      "total_releases": 15,
      "releases_with_hash": 12,
      "last_hash_update": "2024-01-15T10:30:00Z"
    }
  }
]
```

### ハッシュルックアップテーブル（hash-lookup.json）

```json
{
  "a1b2c3d4e5f6...": [
    {
      "mod_name": "MOD名",
      "mod_source": "GitHubリポジトリURL",
      "version": "v1.2.0",
      "file_name": "ModName.dll",
      "file_size": 102400,
      "published_at": "2024-01-15T10:30:00Z",
      "download_url": "ダウンロードURL"
    }
  ]
}
```

## 追加リポジトリのサポート 🆕

### 新しいMODリポジトリの追加方法

公式マニフェストに含まれていないMODリポジトリを追加できるようになりました。

1. **`repositories.json`を編集**: 以下の形式でリポジトリ情報を追加
   ```json
   {
     "name": "Your Mod Name",
     "repository": "https://github.com/username/repo-name",
     "description": "Brief description of your mod",
     "category": "Category (e.g., Optimization, UI, Gameplay)",
     "author": "Your Name",
     "tags": ["tag1", "tag2"],
     "enabled": true
   }
   ```

2. **Pull Requestを作成**: PRテンプレートに従って情報を記入

3. **自動収集**: マージ後、次回の定期更新時に自動的にリリース情報が収集されます

### 注意事項
- GitHubリポジトリのみサポート
- リリースには.dllファイルが添付されている必要があります
- `source`フィールドで`manifest`（公式）と`additional`（追加）を区別

## 新機能: バージョン管理 & ハッシュベース検出

### 全リリース情報の収集
- 各MODのすべてのリリース情報を収集
- プレリリース・ドラフト情報も含む
- 変更ログ・ファイルサイズなど詳細情報

### バージョン選択インストール
- 特定のバージョンを選択してインストール可能
- ダウングレード・アップグレード対応
- プレリリース版の明示表示

### SHA256ハッシュベースMOD検出 🆕
- **正確なバージョン識別**: DLLファイルのSHA256ハッシュでMODとバージョンを特定
- **ドロップファイル対応**: rml_modsフォルダに手動で追加されたMODを自動認識
- **バージョン検出**: ファイル名に関係なく、ハッシュで正確なバージョンを特定
- **インテリジェントキャッシング**: 7日間のキャッシュで不要なダウンロードを回避

#### ハッシュ更新スケジュール
- **月次更新**: 毎月1日にSHA256ハッシュ計算を実行
- **週次更新**: 毎週日曜日に標準のMOD情報のみ更新
- **手動実行**: 必要に応じて手動でハッシュ計算を強制実行可能

#### 使用場面
1. **手動MODインストール**: GitHubから直接ダウンロードしたMODファイルの識別
2. **バックアップ復元**: 古いMODファイルのバージョン特定
3. **MOD管理**: 未管理状態のMODを管理システムに自動統合

## レート制限対策

- GitHub Actionsの`GITHUB_TOKEN`を使用してAPI制限を緩和
- 各API呼び出し間に適切な待機時間（標準200ms、ハッシュ計算時1000ms）
- 週次・月次更新スケジュールでレート制限を回避
- ページネーション対応で大量リリースにも対応
- インテリジェントキャッシングで不要なダウンロードを削減

## 利用方法

Resonite Toolsアプリケーションは以下のURLからキャッシュを取得します：

### MOD情報キャッシュ
```
https://raw.githubusercontent.com/YOUR_USERNAME/resonite-mod-cache/main/cache/mods.json
```

### ハッシュルックアップテーブル
```
https://raw.githubusercontent.com/YOUR_USERNAME/resonite-mod-cache/main/cache/hash-lookup.json
```

## セットアップ

1. このリポジトリをGitHubにプッシュ
2. GitHub Actionsが自動的に有効化
3. 初回実行は手動トリガーまたは次回スケジュール実行時
4. Resonite Toolsのコードで`YOUR_USERNAME`を実際のユーザー名に置換

### 手動トリガー

GitHub Actionsページから以下のワークフローを手動実行できます：
- `Update MOD Cache Weekly` - 標準のMOD情報更新
- `Update MOD Cache with Hashes` - SHA256ハッシュ計算付き更新

## GitHub Actionsワークフロー

### 週次更新（update-cache-weekly.yml）
- **スケジュール**: 毎週日曜日 1:00 UTC
- **処理内容**: 標準のMOD情報収集
- **実行時間**: 約5-10分
- **手動実行**: 可能（ハッシュ計算強制オプション付き）

### 月次ハッシュ更新（update-cache-with-hashes.yml）
- **スケジュール**: 毎月1日 2:00 UTC
- **処理内容**: SHA256ハッシュ計算付きMOD情報収集
- **実行時間**: 約30-60分（ファイルダウンロードのため）
- **手動実行**: 可能