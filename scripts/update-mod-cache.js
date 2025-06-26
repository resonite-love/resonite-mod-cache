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
async function getAllReleases(owner, repo, existingReleases = []) {
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
      // .dllファイルまたは.nupkgファイルを探す
      const modAsset = release.assets.find(asset => 
        asset.name.endsWith('.dll') || asset.name.endsWith('.nupkg')
      );
      
      if (!modAsset) {
        console.log(`  No DLL or NUPKG found in release ${release.tag_name}`);
        continue;
      }
      
      // 既存のリリース情報をチェック
      const existingRelease = existingReleases.find(r => r.version === release.tag_name);
      
      let hashInfo = null;
      
      // ハッシュが存在しない場合のみ計算
      if (modAsset.browser_download_url && (!existingRelease || !existingRelease.sha256)) {
        console.log(`  Calculating hash for ${release.tag_name}...`);
        hashInfo = await downloadAndHash(modAsset.browser_download_url);
        // レート制限を避けるため少し待機
        await new Promise(resolve => setTimeout(resolve, 1000));
      } else if (existingRelease && existingRelease.sha256) {
        // 既存のハッシュ情報を使用
        hashInfo = {
          sha256: existingRelease.sha256,
          file_size: existingRelease.file_size
        };
        console.log(`  Using cached hash for ${release.tag_name}: ${existingRelease.sha256}`);
      }
      
      releaseData.push({
        version: release.tag_name,
        download_url: modAsset.browser_download_url,
        release_url: release.html_url,
        published_at: release.published_at,
        prerelease: release.prerelease,
        draft: release.draft,
        changelog: release.body || null,
        file_name: modAsset.name,
        file_size: hashInfo?.file_size || modAsset.size,
        sha256: hashInfo?.sha256 || null,
      });
    }
    
    // 公開日時で新しい順にソート
    releaseData.sort((a, b) => new Date(b.published_at) - new Date(a.published_at));
    
    return releaseData;
  } catch (error) {
    console.warn(`Failed to get releases for ${owner}/${repo}:`, error.message);
    return existingReleases || [];
  }
}

// ResoniteのMODマニフェストを取得
async function fetchModManifest() {
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

// 既存のキャッシュを読み込み
async function loadExistingCache() {
  try {
    const cachePath = path.join(process.cwd(), 'cache', 'mods.json');
    const data = await fs.readFile(cachePath, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    console.log('No existing cache found');
    return [];
  }
}

// MOD情報を収集
async function collectModInfo() {
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
        // 既存のリリース情報を取得
        const existingMod = existingModsMap.get(modEntry.sourceLocation);
        const existingReleases = existingMod?.releases || [];
        
        try {
          releases = await getAllReleases(repoInfo.owner, repoInfo.repo, existingReleases);
          // レート制限を避けるため少し待機
          await new Promise(resolve => setTimeout(resolve, 500));
        } catch (error) {
          if (isRateLimitError(error)) {
            console.error(`API rate limit reached. Stopping processing.`);
            // 現在までに処理したMODを保存して終了
            break;
          }
          console.warn(`Failed to process ${modEntry.name}:`, error.message);
          releases = existingReleases;
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
      });
    }
  }
  
  // 追加リポジトリを処理
  console.log('\n--- Processing additional repositories ---');
  for (const repo of additionalRepos) {
    processedCount++;
    console.log(`\n[${processedCount}/${totalCount}] Processing ${repo.name || repo.url}...`);
    
    const repoInfo = parseGitHubUrl(repo.url);
    if (!repoInfo) {
      console.warn(`Invalid GitHub URL: ${repo.url}`);
      continue;
    }
    
    // 既存のリリース情報を取得
    const existingMod = existingModsMap.get(repo.url);
    const existingReleases = existingMod?.releases || [];
    
    try {
      const releases = await getAllReleases(repoInfo.owner, repoInfo.repo, existingReleases);
      const latestRelease = releases[0] || null;
      
      mods.push({
        name: repo.name || `${repoInfo.owner}/${repoInfo.repo}`,
        description: repo.description || null,
        category: repo.category || 'Other',
        source_location: repo.url,
        author: repo.author || repoInfo.owner,
        latest_version: latestRelease?.version || null,
        latest_download_url: latestRelease?.download_url || null,
        releases: releases,
        tags: repo.tags || null,
        flags: repo.flags || null,
        last_updated: new Date().toISOString(),
        source: 'additional',
      });
      
      // レート制限を避けるため少し待機
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch (error) {
      console.warn(`Failed to process ${repo.url}:`, error.message);
      
      // エラー時は既存データを使用
      if (existingMod) {
        mods.push(existingMod);
      }
    }
  }
  
  return mods;
}

// ハッシュルックアップテーブルを生成
function generateHashLookup(mods) {
  const hashLookup = {};
  
  for (const mod of mods) {
    for (const release of mod.releases || []) {
      if (release.sha256 && release.download_url) {
        hashLookup[release.sha256] = {
          mod_name: mod.name,
          version: release.version,
          download_url: release.download_url,
          file_name: release.file_name,
          file_size: release.file_size,
        };
      }
    }
  }
  
  return hashLookup;
}

// メイン処理
async function main() {
  console.log('Starting MOD cache update...\n');
  
  try {
    const mods = await collectModInfo();
    
    // キャッシュディレクトリを作成
    const cacheDir = path.join(process.cwd(), 'cache');
    await fs.mkdir(cacheDir, { recursive: true });
    
    // MOD情報を保存
    const modsPath = path.join(cacheDir, 'mods.json');
    await fs.writeFile(modsPath, JSON.stringify(mods, null, 2));
    console.log(`\nSaved ${mods.length} MODs to ${modsPath}`);
    
    // ハッシュルックアップテーブルを生成・保存
    const hashLookup = generateHashLookup(mods);
    const hashLookupPath = path.join(cacheDir, 'hash-lookup.json');
    await fs.writeFile(hashLookupPath, JSON.stringify(hashLookup, null, 2));
    console.log(`Saved hash lookup table with ${Object.keys(hashLookup).length} entries to ${hashLookupPath}`);
    
    // サマリー情報を表示
    console.log('\n=== Summary ===');
    console.log(`Total MODs processed: ${mods.length}`);
    console.log(`Total unique hashes: ${Object.keys(hashLookup).length}`);
    
    const categoryCounts = {};
    let totalReleases = 0;
    let releasesWithHash = 0;
    
    for (const mod of mods) {
      categoryCounts[mod.category] = (categoryCounts[mod.category] || 0) + 1;
      totalReleases += mod.releases?.length || 0;
      releasesWithHash += mod.releases?.filter(r => r.sha256).length || 0;
    }
    
    console.log('\nMODs by category:');
    for (const [category, count] of Object.entries(categoryCounts).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${category}: ${count}`);
    }
    
    console.log(`\nTotal releases: ${totalReleases}`);
    console.log(`Releases with hash: ${releasesWithHash} (${((releasesWithHash/totalReleases)*100).toFixed(1)}%)`);
    
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

main();