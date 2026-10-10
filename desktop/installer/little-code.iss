; Little Code per-user installer. Uses the pinned Code-OSS Inno Setup compiler,
; product identity and branded assets. This development package deliberately has
; no update service, shell integration, file association, PATH or launch hooks.

[Setup]
AppId={#AppId}
AppName={#NameLong}
AppVersion={#LittleVersion}
AppVerName={#NameLong} {#LittleVersion}
AppPublisher=Priyanshu Chaurasia
VersionInfoVersion={#LittleVersion}.0
VersionInfoDescription=Little Code per-user setup
VersionInfoCompany=Priyanshu Chaurasia
VersionInfoCopyright=Copyright (C) Microsoft Corporation and Priyanshu Chaurasia. MIT licensed.
DefaultDirName={userpf}\{#DirName}
DefaultGroupName={#NameLong}
DisableProgramGroupPage=yes
AllowNoIcons=no
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
AppMutex={#AppMutex},Global\{#AppMutex}
SetupMutex=LittleCodePerUserSetup
CloseApplications=no
RestartApplications=no
ChangesEnvironment=no
ChangesAssociations=no
WizardStyle=modern
WizardImageFile={#BrandingDir}\inno-big-100.bmp
WizardSmallImageFile={#BrandingDir}\inno-small-100.bmp
SetupIconFile={#BrandingDir}\code.ico
UninstallDisplayIcon={app}\{#ExeBasename}.exe
UninstallDisplayName={#NameLong}
LicenseFile={#SourceDir}\resources\app\LICENSE.txt
OutputDir={#OutputDir}
OutputBaseFilename={#OutputName}
Compression=lzma2/fast
SolidCompression=yes
SetupLogging=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"; Flags: unchecked

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#NameLong}"; Filename: "{app}\{#ExeBasename}.exe"; WorkingDir: "{app}"; AppUserModelID: "{#AppUserId}"
Name: "{userdesktop}\{#NameLong}"; Filename: "{app}\{#ExeBasename}.exe"; WorkingDir: "{app}"; AppUserModelID: "{#AppUserId}"; Tasks: desktopicon

[Code]
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ProductPath: String;
  ProductText: AnsiString;
  IdentityText: String;
begin
  Result := '';
  if FileExists(ExpandConstant('{app}\Code.exe')) or
     FileExists(ExpandConstant('{app}\VSCodium.exe')) then begin
    Result := 'This folder contains a different editor. Choose a separate Little Code installation folder.';
    Exit;
  end;
  ProductPath := ExpandConstant('{app}\resources\app\product.json');
  if FileExists(ProductPath) then begin
    if not LoadStringFromFile(ProductPath, ProductText) then begin
      Result := 'The existing application identity cannot be read. Choose a separate Little Code installation folder.';
      Exit;
    end;
    IdentityText := Utf8Decode(ProductText);
    StringChangeEx(IdentityText, ' ', '', True);
    StringChangeEx(IdentityText, #9, '', True);
    StringChangeEx(IdentityText, #10, '', True);
    StringChangeEx(IdentityText, #13, '', True);
    if Pos('"applicationName":"little-code"', IdentityText) = 0 then
      Result := 'This folder belongs to a different application. Choose a separate Little Code installation folder.';
  end;
end;
