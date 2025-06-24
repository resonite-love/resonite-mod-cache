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

// APIレート制限検出とエラーハンドリング
function isRateLimitError(error) {
  return error.status === 403 && 
         (error.message.includes('rate limit') || 
          error.message.includes('API rate limit'));
}

// リポジトリからすべてのリリース情報を取得（ハッシュ情報付き）
async function getAllReleasesWithHashes(owner, repo, calculateHashes = true, existingReleases = []) {
  try {
    console.log(`Fetching releases for ${owner}/${repo}...`);
    
    // すべてのリリースを取得（ページネーション対応）
    let releases;
    try {
      releases = await octokit.paginate(octokit.rest.repos.listReleases, {
        owner,
        repo,
        per_page: 100,
      });
    } catch (error) {
      if (isRateLimitError(error)) {
        console.error(`Rate limit reached for ${owner}/${repo}. Using existing data if available.`);
        return existingReleases;
      }
      throw error;
    }
    
    const releaseData = [];
    
    for (const release of releases) {
      // .dllファイルを探す
      const dllAsset = release.assets.find(asset => asset.name.endsWith('.dll'));
      
      if (!dllAsset) {
        console.log(`  No DLL found in release ${release.tag_name}`);
        continue;
      }
      
      // 既存のリリース情報をチェック
      const existingRelease = existingReleases.find(r => r.version === release.tag_name);
      
      let hashInfo = null;
      let shouldCalculateHash = calculateHashes && dllAsset.browser_download_url;
      
      // force_hash_calculationがtrueの場合、ハッシュが無いリリースは強制計算
      if (process.argv.includes('--force-hash') && existingRelease && !existingRelease.sha256) {
        shouldCalculateHash = true;
        console.log(`  Force calculating hash for ${release.tag_name} (missing hash)`);
      }
      
      if (shouldCalculateHash) {
        try {
          hashInfo = await downloadAndHash(dllAsset.browser_download_url);
          // レート制限とサーバー負荷を避けるため待機
          await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (error) {
          if (error.message.includes('429') || error.message.includes('rate limit')) {
            console.warn(`Rate limit reached during hash calculation. Stopping hash calculation for ${owner}/${repo}.`);
            // 既存のハッシュ情報を使用
            if (existingRelease?.sha256) {
              hashInfo = { 
                sha256: existingRelease.sha256, 
                file_size: existingRelease.file_size 
              };
            }
          } else {
            console.warn(`Failed to calculate hash for ${release.tag_name}:`, error.message);
            // 既存のハッシュ情報を使用（あれば）
            if (existingRelease?.sha256) {
              hashInfo = { 
                sha256: existingRelease.sha256, 
                file_size: existingRelease.file_size 
              };
            }
          }
        }
      } else if (existingRelease?.sha256) {
        // キャッシュからハッシュ情報を取得
        hashInfo = { 
          sha256: existingRelease.sha256, 
          file_size: existingRelease.file_size 
        };
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
    if (isRateLimitError(error)) {
      console.error(`API rate limit reached for ${owner}/${repo}. Using existing data.`);
      return existingReleases;
    }
    console.warn(`Failed to get releases for ${owner}/${repo}:`, error.message);
    return existingReleases || [];
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

// 追加リポジトリ設定を読み込み
async function loadAdditionalRepositories() {
  try {
    const repoConfigPath = path.join(process.cwd(), 'repositories.json');
    const data = await fs.readFile(repoConfigPath, 'utf-8');
    const config = JSON.parse(data);
    return config.repositories.filter(repo => repo.enabled !== false);
  } catch (error) {
    console.warn('No additional repositories config found or error reading it:', error.message);
    return [];
  }
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
  const additionalRepos = await loadAdditionalRepositories();
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
  totalCount += additionalRepos.length;
  
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
        // 既存キャッシュがある場合の処理
        const existingMod = existingModsMap.get(modEntry.sourceLocation);
        const isOlderThan7Days = !existingMod || 
          !existingMod.last_updated || 
          (new Date() - new Date(existingMod.last_updated)) > 7 * 24 * 60 * 60 * 1000;
        
        // ハッシュを持っていないリリースがあるかチェック
        const hasIncompleteHashes = existingMod?.releases?.some(release => 
          release.download_url && !release.sha256
        ) || false;
        
        // force_hash_calculationフラグをチェック
        const forceHashCalculation = process.argv.includes('--force-hash');
        
        const shouldCalculateHashes = isOlderThan7Days || hasIncompleteHashes || forceHashCalculation;
        
        if (existingMod && !shouldCalculateHashes) {
          console.log('  Using cached data (less than 7 days old, all hashes complete)');
          releases = existingMod.releases || [];
        } else {
          if (hasIncompleteHashes) {
            console.log('  Updating due to incomplete hashes');
          } else if (forceHashCalculation) {
            console.log('  Force hash calculation enabled');
          } else if (isOlderThan7Days) {
            console.log('  Updating due to age (>7 days)');
          }
          
          try {
            releases = await getAllReleasesWithHashes(
              repoInfo.owner, 
              repoInfo.repo, 
              shouldCalculateHashes,
              existingMod?.releases || []
            );
            // レート制限を避けるため少し待機
            await new Promise(resolve => setTimeout(resolve, 500));
          } catch (error) {
            if (isRateLimitError(error)) {
              console.error(`API rate limit reached. Stopping processing.`);
              // 現在までに処理したMODを保存して終了
              break;
            }
            console.warn(`Failed to process ${modEntry.name}:`, error.message);
            releases = existingMod?.releases || [];
          }
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
        source: 'manifest',
        hash_metadata: {
          total_releases: releases.length,
          releases_with_hash: releases.filter(r => r.sha256).length,
          last_hash_update: new Date().toISOString()
        }
      });
    }
  }
  
  // 追加リポジトリの処理
  console.log('\nProcessing additional repositories...');
  for (const repo of additionalRepos) {
    processedCount++;
    console.log(`\n[${processedCount}/${totalCount}] Processing additional repository: ${repo.name}...`);
    
    const repoInfo = parseGitHubUrl(repo.repository);
    if (!repoInfo) {
      console.warn(`Invalid repository URL: ${repo.repository}`);
      continue;
    }
    
    // 既存キャッシュがある場合の処理
    const existingMod = existingModsMap.get(repo.repository);
    const isOlderThan7Days = !existingMod || 
      !existingMod.last_updated || 
      (new Date() - new Date(existingMod.last_updated)) > 7 * 24 * 60 * 60 * 1000;
    
    const hasIncompleteHashes = existingMod?.releases?.some(release => 
      release.download_url && !release.sha256
    ) || false;
    
    const forceHashCalculation = process.argv.includes('--force-hash');
    const shouldCalculateHashes = isOlderThan7Days || hasIncompleteHashes || forceHashCalculation;
    
    let releases = [];
    
    if (existingMod && !shouldCalculateHashes) {
      console.log('  Using cached data (less than 7 days old, all hashes complete)');
      releases = existingMod.releases || [];
    } else {
      if (hasIncompleteHashes) {
        console.log('  Updating due to incomplete hashes');
      } else if (forceHashCalculation) {
        console.log('  Force hash calculation enabled');
      } else if (isOlderThan7Days) {
        console.log('  Updating due to age (>7 days)');
      }
      
      try {
        releases = await getAllReleasesWithHashes(
          repoInfo.owner, 
          repoInfo.repo, 
          shouldCalculateHashes,
          existingMod?.releases || []
        );
        // レート制限を避けるため少し待機
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (error) {
        if (isRateLimitError(error)) {
          console.error(`API rate limit reached. Stopping processing.`);
          break;
        }
        console.warn(`Failed to process ${repo.name}:`, error.message);
        releases = existingMod?.releases || [];
      }
    }
    
    const latestRelease = releases[0] || null;
    
    mods.push({
      name: repo.name,
      description: repo.description,
      category: repo.category,
      source_location: repo.repository,
      author: repo.author,
      latest_version: latestRelease?.version || null,
      latest_download_url: latestRelease?.download_url || null,
      releases: releases,
      tags: repo.tags || null,
      flags: repo.flags || null,
      last_updated: new Date().toISOString(),
      source: 'additional',
      hash_metadata: {
        total_releases: releases.length,
        releases_with_hash: releases.filter(r => r.sha256).length,
        last_hash_update: new Date().toISOString()
      }
    });
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
    const releasesWithDownloadUrl = mods.reduce((sum, mod) => 
      sum + mod.releases.filter(r => r.download_url).length, 0);
    const avgReleasesPerMod = withReleases > 0 ? (totalReleases / withReleases).toFixed(1) : 0;
    const hashCoverage = releasesWithDownloadUrl > 0 ? ((totalHashedReleases / releasesWithDownloadUrl) * 100).toFixed(1) : 0;
    const modsWithIncompleteHashes = mods.filter(mod => 
      mod.releases.some(r => r.download_url && !r.sha256)
    ).length;
    
    console.log(`\nStatistics:`);
    console.log(`MODs with releases: ${withReleases}/${mods.length}`);
    console.log(`Total releases collected: ${totalReleases}`);
    console.log(`Releases with download URLs: ${releasesWithDownloadUrl}`);
    console.log(`Releases with SHA256 hash: ${totalHashedReleases} (${hashCoverage}%)`);
    console.log(`MODs with incomplete hashes: ${modsWithIncompleteHashes}`);
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
  --help, -h        Show this help message
  --force-hash      Force hash calculation for all MODs, even if cached within 7 days
  
Environment Variables:
  GITHUB_TOKEN      GitHub personal access token (recommended for higher rate limits)

This script collects MOD information including SHA256 hashes of DLL files.
It may take a significant amount of time due to file downloads and GitHub API rate limits.

Smart Caching Behavior:
- Skips hash calculation if data is less than 7 days old AND all hashes are present
- Forces hash calculation if any releases are missing SHA256 hashes
- Gracefully handles API rate limits by saving progress and using cached data
- With --force-hash: calculates hashes for all MODs regardless of cache age

The script generates two files:
- cache/mods.json: Complete MOD information with release data and hashes
- cache/hash-lookup.json: SHA256 hash to MOD/version mapping table
`);
  process.exit(0);
}

main();