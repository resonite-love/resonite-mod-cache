import { Octokit } from '@octokit/rest';
import fetch from 'node-fetch';
import fs from 'fs/promises';
import path from 'path';

const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});

// GitHubリポジトリURLからowner/repo形式を抽出
function parseGitHubUrl(url) {
  const match = url.match(/github\.com\/([^\/]+)\/([^\/]+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

// リポジトリからすべてのリリース情報を取得
async function getAllReleases(owner, repo) {
  try {
    // すべてのリリースを取得（ページネーション対応）
    const releases = await octokit.paginate(octokit.rest.repos.listReleases, {
      owner,
      repo,
      per_page: 100,
    });
    
    const releaseData = releases.map(release => {
      // .dllファイルを探す
      const dllAsset = release.assets.find(asset => asset.name.endsWith('.dll'));
      
      return {
        version: release.tag_name,
        download_url: dllAsset?.browser_download_url || null,
        release_url: release.html_url,
        published_at: release.published_at,
        prerelease: release.prerelease,
        draft: release.draft,
        changelog: release.body || null,
        file_name: dllAsset?.name || null,
        file_size: dllAsset?.size || null,
      };
    });
    
    // 公開日時で新しい順にソート
    releaseData.sort((a, b) => new Date(b.published_at) - new Date(a.published_at));
    
    return releaseData;
  } catch (error) {
    console.warn(`Failed to get releases for ${owner}/${repo}:`, error.message);
    return [];
  }
}

// ResoniteのMODマニフェストを取得
async function fetchModManifest() {
  const manifestUrl = 'https://raw.githubusercontent.com/resonite-modding-group/resonite-mod-manifest/main/manifest.json';
  const response = await fetch(manifestUrl);
  const manifest = await response.json();
  return manifest;
}

// MOD情報を収集
async function collectModInfo() {
  console.log('Fetching MOD manifest...');
  const manifest = await fetchModManifest();
  
  const mods = [];
  
  for (const [authorKey, authorEntry] of Object.entries(manifest.objects)) {
    // 作者名を取得
    const authorName = Object.keys(authorEntry.author)[0] || authorKey;
    
    for (const [modKey, modEntry] of Object.entries(authorEntry.entries)) {
      console.log(`Processing ${modEntry.name}...`);
      
      // GitHubリポジトリ情報を解析
      const repoInfo = parseGitHubUrl(modEntry.sourceLocation);
      let releases = [];
      
      if (repoInfo) {
        releases = await getAllReleases(repoInfo.owner, repoInfo.repo);
        // レート制限を避けるため少し待機
        await new Promise(resolve => setTimeout(resolve, 200));
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
      });
    }
  }
  
  return mods;
}

// メイン処理
async function main() {
  try {
    console.log('Starting MOD information collection...');
    const mods = await collectModInfo();
    
    // キャッシュディレクトリを作成
    await fs.mkdir('cache', { recursive: true });
    
    // MOD情報をJSONファイルに保存
    const cachePath = path.join('cache', 'mods.json');
    await fs.writeFile(cachePath, JSON.stringify(mods, null, 2));
    
    console.log(`Successfully collected information for ${mods.length} MODs`);
    console.log(`Cache saved to ${cachePath}`);
    
    // 統計情報を表示
    const withReleases = mods.filter(mod => mod.releases.length > 0).length;
    const totalReleases = mods.reduce((sum, mod) => sum + mod.releases.length, 0);
    const avgReleasesPerMod = withReleases > 0 ? (totalReleases / withReleases).toFixed(1) : 0;
    
    console.log(`MODs with releases: ${withReleases}/${mods.length}`);
    console.log(`Total releases collected: ${totalReleases}`);
    console.log(`Average releases per MOD: ${avgReleasesPerMod}`);
    
  } catch (error) {
    console.error('Error collecting MOD information:', error);
    process.exit(1);
  }
}

main();