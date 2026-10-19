import type { PublicRelease } from './release';

/** Enable a public installer only when all publication metadata agrees. */
export function verifiedGithubAsset(data: unknown, expected: PublicRelease): string | null {
  if (!data || typeof data !== 'object') return null;
  const value = data as Record<string, unknown>;
  if (value.draft !== false || typeof value.prerelease !== 'boolean' || value.tag_name !== expected.releaseTag || !Array.isArray(value.assets)) return null;
  const exact = `${expected.repository}/releases/download/${encodeURIComponent(expected.releaseTag)}/${encodeURIComponent(expected.fileName)}`;
  for (const candidate of value.assets) {
    if (!candidate || typeof candidate !== 'object') continue;
    const asset = candidate as Record<string, unknown>;
    if (asset.name !== expected.fileName || asset.size !== expected.bytes || asset.state !== 'uploaded' || asset.digest !== `sha256:${expected.sha256}` || typeof asset.browser_download_url !== 'string') continue;
    try {
      const url = new URL(asset.browser_download_url);
      if (url.href === exact && !url.username && !url.password) return url.href;
    } catch { /* A malformed asset cannot suppress other matching candidates. */ }
  }
  return null;
}

export function verifiedLocalAsset(data: unknown, expected: PublicRelease): string | null {
  if (!data || typeof data !== 'object') return null;
  const value = data as Record<string, unknown>;
  return value.available === true && value.sha256 === expected.sha256 && value.bytes === expected.bytes && value.fileName === expected.fileName && value.downloadUrl === `/downloads/${expected.fileName}` ? value.downloadUrl : null;
}
