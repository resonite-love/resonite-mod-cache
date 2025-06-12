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

// リポジトリから最新リリース情報を取得
async function getLatestRelease(owner, repo) {
  try {
    const { data } = await octokit.rest.repos.getLatestRelease({
      owner,
      repo,
    });
    
    // .dllファイルを探す
    const dllAsset = data.assets.find(asset => asset.name.endsWith('.dll'));
    
    return {
      version: data.tag_name,
      download_url: dllAsset?.browser_download_url || null,
      release_url: data.html_url,
      published_at: data.published_at,
    };
  } catch (error) {
    console.warn(`Failed to get release for ${owner}/${repo}:`, error.message);
    return null;
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
      let releaseInfo = null;
      
      if (repoInfo) {
        releaseInfo = await getLatestRelease(repoInfo.owner, repoInfo.repo);
        // レート制限を避けるため少し待機
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
      mods.push({
        name: modEntry.name,
        description: modEntry.description,
        category: modEntry.category,
        source_location: modEntry.sourceLocation,
        author: authorName,
        latest_version: releaseInfo?.version || null,
        latest_download_url: releaseInfo?.download_url || null,
        release_url: releaseInfo?.release_url || null,
        published_at: releaseInfo?.published_at || null,
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
    const withReleases = mods.filter(mod => mod.latest_version).length;
    console.log(`MODs with releases: ${withReleases}/${mods.length}`);
    
  } catch (error) {
    console.error('Error collecting MOD information:', error);
    process.exit(1);
  }
}

main();