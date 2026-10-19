export interface PublicRelease {
  name: string;
  version: string;
  releaseDate: string;
  repository: string;
  releaseTag: string;
  releaseApi: string;
  releasePage: string;
  fileName: string;
  bytes: number;
  sha256: string;
  platform: string;
  unsigned: boolean;
}

// The build injects only the public allowlist, never product.json's local path.
declare const __LITTLE_RELEASE__: PublicRelease;
export const release: PublicRelease = __LITTLE_RELEASE__;
