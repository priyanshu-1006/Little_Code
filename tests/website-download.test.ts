import assert from 'node:assert/strict';
import test from 'node:test';
import { verifiedGithubAsset, verifiedLocalAsset } from '../website/src/downloadProtocol';
import type { PublicRelease } from '../website/src/release';

const expected: PublicRelease = { name:'Little Code',version:'0.3.0',releaseDate:'2026-10-10',repository:'https://github.com/example/Little_Code',releaseTag:'v0.3.0',releaseApi:'https://api.github.com/repos/example/Little_Code/releases/tags/v0.3.0',releasePage:'https://github.com/example/Little_Code/releases',fileName:'LittleCode-0.3.0-CodeOSS-1.141.0-win32-x64-UserSetup.exe',bytes:347230859,sha256:'a'.repeat(64),unsigned:true,platform:'Windows x64' };
const url = `${expected.repository}/releases/download/${expected.releaseTag}/${expected.fileName}`;
const asset = {name:expected.fileName,size:expected.bytes,state:'uploaded',digest:`sha256:${expected.sha256}`,browser_download_url:url};
const published = (assets: unknown[] = [asset]) => ({draft:false,prerelease:true,tag_name:expected.releaseTag,assets});

test('download enables the exact published artifact, including preview releases', () => {
  assert.equal(verifiedGithubAsset(published(),expected),url);
  assert.equal(verifiedGithubAsset({...published(),prerelease:false},expected),url);
});
test('download rejects draft, wrong tag, missing publication fields and absent releases', () => {
  for (const candidate of [null,{},'html',{...published(),draft:true},{...published(),tag_name:'v0.2.0'},{...published(),prerelease:undefined}]) assert.equal(verifiedGithubAsset(candidate,expected),null);
});
test('download requires matching filename, bytes, upload state and digest', () => {
  for (const change of [{name:'old.exe'},{size:1},{state:'new'},{digest:null},{digest:`sha256:${'b'.repeat(64)}`}]) assert.equal(verifiedGithubAsset(published([{...asset,...change}]),expected),null);
});
test('download rejects untrusted origins, credentials, query/fragment and alternate paths', () => {
  for (const bad of ['javascript:alert(1)','https://github.com.attacker.invalid/example/Little_Code',url+'?redirect=1',url+'#other',url.replace('github.com','user:pass@github.com'),url.replace('/example/','/other/'),'/downloads/setup.exe']) assert.equal(verifiedGithubAsset(published([{...asset,browser_download_url:bad}]),expected),null);
});
test('one malformed asset does not suppress an independent valid asset', () => {
  assert.equal(verifiedGithubAsset(published([null,{...asset,browser_download_url:'https://['},asset]),expected),url);
});
test('local downloads require verification and the exact pinned relative route', () => {
  const local={available:true,bytes:expected.bytes,sha256:expected.sha256,fileName:expected.fileName,downloadUrl:`/downloads/${expected.fileName}`};
  assert.equal(verifiedLocalAsset(local,expected),local.downloadUrl);
  for (const change of [{available:false},{bytes:1},{sha256:'b'.repeat(64)},{fileName:'old.exe'},{downloadUrl:'//evil.invalid/setup.exe'},{downloadUrl:local.downloadUrl+'?x=1'},{downloadUrl:'/downloads/../setup.exe'}]) assert.equal(verifiedLocalAsset({...local,...change},expected),null);
});
