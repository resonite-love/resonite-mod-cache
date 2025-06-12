import { Octokit } from '@octokit/rest';
import fetch from 'node-fetch';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});

// GitHubリポジトリURLからowner/repo形式を抽出
function parseGitHubUrl(url) {
  const match = url.match(/github\.com\/([^\/]+)\/([^\/]+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

// ファイルをダウンロードしてSHA256ハッシュを計算
async function downloadAndHash(url, maxSize = 50 * 1024 * 1024) { // 50MB制限
  try {
    console.log(`  Downloading and hashing: ${url}`);
    const response = await fetch(url);
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const contentLength = parseInt(response.headers.get('content-length') || '0');
    if (contentLength > maxSize) {
      console.warn(`  File too large (${(contentLength/1024/1024).toFixed(1)}MB), skipping hash calculation`);
      return null;
    }
    
    const buffer = await response.buffer();
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');
    
    console.log(`  Hash: ${hash} (${(buffer.length/1024).toFixed(1)}KB)`);
    return {
      sha256: hash,
      file_size: buffer.length
    };
  } catch (error) {
    console.warn(`  Failed to download/hash ${url}:`, error.message);
    return null;
  }
}

// リポジトリからすべてのリリース情報を取得（ハッシュ情報付き）
async function getAllReleasesWithHashes(owner, repo, calculateHashes = true) {
  try {
    console.log(`Fetching releases for ${owner}/${repo}...`);
    
    // すべてのリリースを取得（ページネーション対応）
    const releases = await octokit.paginate(octokit.rest.repos.listReleases, {
      owner,
      repo,
      per_page: 100,
    });
    
    const releaseData = [];
    
    for (const release of releases) {
      // .dllファイルを探す
      const dllAsset = release.assets.find(asset => asset.name.endsWith('.dll'));
      
      if (!dllAsset) {
        console.log(`  No DLL found in release ${release.tag_name}`);
        continue;
      }
      
      let hashInfo = null;
      if (calculateHashes && dllAsset.browser_download_url) {
        hashInfo = await downloadAndHash(dllAsset.browser_download_url);
        // レート制限とサーバー負荷を避けるため待機
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
      const releaseInfo = {
        version: release.tag_name,
        download_url: dllAsset.browser_download_url || null,
        release_url: release.html_url,
        published_at: release.published_at,
        prerelease: release.prerelease,
        draft: release.draft,
        changelog: release.body || null,
        file_name: dllAsset.name || null,
        file_size: hashInfo?.file_size || dllAsset.size || null,
        sha256: hashInfo?.sha256 || null,
      };
      
      releaseData.push(releaseInfo);
    }
    
    // 公開日時で新しい順にソート
    releaseData.sort((a, b) => new Date(b.published_at) - new Date(a.published_at));
    
    console.log(`  Found ${releaseData.length} releases with DLL files`);
    return releaseData;
  } catch (error) {
    console.warn(`Failed to get releases for ${owner}/${repo}:`, error.message);
    return [];
  }
}

// ResoniteのMODマニフェストを取得
async function fetchModManifest() {
  console.log('Fetching MOD manifest...');
  const manifestUrl = 'https://raw.githubusercontent.com/resonite-modding-group/resonite-mod-manifest/main/manifest.json';
  const response = await fetch(manifestUrl);
  const manifest = await response.json();
  return manifest;
}

// 既存のキャッシュを読み込み（ハッシュ情報を保持するため）
async function loadExistingCache() {
  try {
    const cachePath = path.join('cache', 'mods.json');
    const content = await fs.readFile(cachePath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    console.log('No existing cache found, starting fresh');
    return [];
  }
}

// MOD情報を収集（ハッシュ情報付き）
async function collectModInfoWithHashes() {
  const manifest = await fetchModManifest();
  const existingCache = await loadExistingCache();
  
  // 既存キャッシュをマップに変換（高速検索用）
  const existingModsMap = new Map();
  existingCache.forEach(mod => {
    existingModsMap.set(mod.source_location, mod);
  });
  
  const mods = [];
  let processedCount = 0;
  let totalCount = 0;
  
  // 総数をカウント
  for (const authorEntry of Object.values(manifest.objects)) {
    totalCount += Object.keys(authorEntry.entries).length;
  }
  
  for (const [authorKey, authorEntry] of Object.entries(manifest.objects)) {
    // 作者名を取得
    const authorName = Object.keys(authorEntry.author)[0] || authorKey;
    
    for (const [modKey, modEntry] of Object.entries(authorEntry.entries)) {
      processedCount++;
      console.log(`\n[${processedCount}/${totalCount}] Processing ${modEntry.name}...`);
      
      // GitHubリポジトリ情報を解析
      const repoInfo = parseGitHubUrl(modEntry.sourceLocation);
      let releases = [];
      
      if (repoInfo) {
        // 既存キャッシュがある場合、最近更新されたもの以外はスキップ
        const existingMod = existingModsMap.get(modEntry.sourceLocation);
        const shouldCalculateHashes = !existingMod || 
          !existingMod.last_updated || 
          (new Date() - new Date(existingMod.last_updated)) > 7 * 24 * 60 * 60 * 1000; // 7日以上古い
        
        if (existingMod && !shouldCalculateHashes) {
          console.log('  Using cached data (less than 7 days old)');
          releases = existingMod.releases || [];
        } else {
          releases = await getAllReleasesWithHashes(repoInfo.owner, repoInfo.repo, shouldCalculateHashes);
          // レート制限を避けるため少し待機
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
      
      // 最新リリース情報を取得
      const latestRelease = releases[0] || null;
      
      mods.push({
        name: modEntry.name,
        description: modEntry.description,
        category: modEntry.category,
        source_location: modEntry.sourceLocation,
        author: authorName,
        latest_version: latestRelease?.version || null,
        latest_download_url: latestRelease?.download_url || null,
        releases: releases,
        tags: modEntry.tags || null,
        flags: modEntry.flags || null,
        last_updated: new Date().toISOString(),
        hash_metadata: {
          total_releases: releases.length,
          releases_with_hash: releases.filter(r => r.sha256).length,
          last_hash_update: new Date().toISOString()
        }
      });
    }
  }
  
  return mods;
}

// SHA256ハッシュから該当するMODとバージョンを検索
function createHashLookupTable(mods) {
  const hashLookup = new Map();
  
  mods.forEach(mod => {
    mod.releases.forEach(release => {
      if (release.sha256) {
        if (!hashLookup.has(release.sha256)) {
          hashLookup.set(release.sha256, []);
        }
        hashLookup.get(release.sha256).push({
          mod_name: mod.name,
          mod_source: mod.source_location,
          version: release.version,
          file_name: release.file_name,
          file_size: release.file_size,
          published_at: release.published_at,
          download_url: release.download_url
        });
      }
    });
  });
  
  return Object.fromEntries(hashLookup);
}

// メイン処理
async function main() {
  try {
    console.log('Starting MOD information collection with hash calculation...');
    console.log('This process may take a while due to file downloads and rate limiting.\n');
    
    const mods = await collectModInfoWithHashes();
    
    // キャッシュディレクトリを作成
    await fs.mkdir('cache', { recursive: true });
    
    // MOD情報をJSONファイルに保存
    const cachePath = path.join('cache', 'mods.json');
    await fs.writeFile(cachePath, JSON.stringify(mods, null, 2));
    
    // ハッシュルックアップテーブルを作成
    const hashLookup = createHashLookupTable(mods);
    const hashLookupPath = path.join('cache', 'hash-lookup.json');
    await fs.writeFile(hashLookupPath, JSON.stringify(hashLookup, null, 2));
    
    console.log(`\nSuccessfully collected information for ${mods.length} MODs`);
    console.log(`Cache saved to ${cachePath}`);
    console.log(`Hash lookup table saved to ${hashLookupPath}`);
    
    // 統計情報を表示
    const withReleases = mods.filter(mod => mod.releases.length > 0).length;
    const totalReleases = mods.reduce((sum, mod) => sum + mod.releases.length, 0);
    const totalHashedReleases = mods.reduce((sum, mod) => 
      sum + mod.releases.filter(r => r.sha256).length, 0);
    const avgReleasesPerMod = withReleases > 0 ? (totalReleases / withReleases).toFixed(1) : 0;
    const hashCoverage = totalReleases > 0 ? ((totalHashedReleases / totalReleases) * 100).toFixed(1) : 0;
    
    console.log(`\nStatistics:`);
    console.log(`MODs with releases: ${withReleases}/${mods.length}`);
    console.log(`Total releases collected: ${totalReleases}`);
    console.log(`Releases with SHA256 hash: ${totalHashedReleases} (${hashCoverage}%)`);
    console.log(`Average releases per MOD: ${avgReleasesPerMod}`);
    console.log(`Unique hashes in lookup table: ${Object.keys(hashLookup).length}`);
    
  } catch (error) {
    console.error('Error collecting MOD information:', error);
    process.exit(1);
  }
}

// コマンドライン引数の処理
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Usage: node collect-mod-info-with-hashes.js [options]

Options:
  --help, -h     Show this help message
  
Environment Variables:
  GITHUB_TOKEN   GitHub personal access token (recommended for higher rate limits)

This script collects MOD information including SHA256 hashes of DLL files.
It may take a significant amount of time due to file downloads and GitHub API rate limits.

The script generates two files:
- cache/mods.json: Complete MOD information with release data and hashes
- cache/hash-lookup.json: SHA256 hash to MOD/version mapping table
`);
  process.exit(0);
}

main();