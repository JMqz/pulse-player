; Pulse installer (Inno Setup 6). Built by package.ps1, which passes:
;   /DAppVersion=x.y.z  /DStageDir=<staged app folder>  /DOutDir=<release folder>
; Per-user install (no admin): %LOCALAPPDATA%\Programs\Pulse

#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif
#ifndef StageDir
  #define StageDir "..\release\stage\Pulse"
#endif
#ifndef OutDir
  #define OutDir "..\release"
#endif

#define AppName "Pulse"
#define AppExe "Pulse.exe"
#define AppPublisher "João Maurício"
#define AppUrl "https://github.com/JMqz/pulse-player"

[Setup]
AppId={{6B1E3C52-7A0D-4E2B-9C4F-3D8A1F5E9B27}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppUrl}
AppSupportURL={#AppUrl}/issues
AppUpdatesURL={#AppUrl}/releases
DefaultDirName={localappdata}\Programs\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
DisableDirPage=auto
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
OutputDir={#OutDir}
OutputBaseFilename=Pulse-Setup-win64
SetupIconFile={#StageDir}\assets\icon.ico
UninstallDisplayIcon={app}\{#AppExe}
UninstallDisplayName={#AppName}
Compression=lzma2/max
SolidCompression=yes
LZMAUseSeparateProcess=yes
WizardStyle=modern
CloseApplications=yes
RestartApplications=no
VersionInfoVersion={#AppVersion}
VersionInfoProductName={#AppName}
VersionInfoDescription={#AppName} Setup

[Languages]
Name: "brazilianportuguese"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[InstallDelete]
; Drop UI/server files from a previous version so removed files don't linger.
Type: filesandordirs; Name: "{app}\src"
Type: filesandordirs; Name: "{app}\assets"

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExe}"; WorkingDir: "{app}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExe}"; Description: "{cm:LaunchProgram,{#AppName}}"; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "{sys}\taskkill.exe"; Parameters: "/F /T /IM {#AppExe}"; Flags: runhidden; RunOnceId: "StopPulse"

[UninstallDelete]
; yt-dlp self-updates in place and leaves a stamp file next to it.
Type: filesandordirs; Name: "{app}\bin"

[Code]
const
  WebView2Key = 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
  WebView2Key32 = 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
  WebView2Url = 'https://go.microsoft.com/fwlink/p/?LinkId=2124703';

function HasWebView2: Boolean;
var
  V: String;
begin
  Result :=
    (RegQueryStringValue(HKLM, WebView2Key32, 'pv', V) and (V <> '') and (V <> '0.0.0.0')) or
    (RegQueryStringValue(HKLM, WebView2Key, 'pv', V) and (V <> '') and (V <> '0.0.0.0')) or
    (RegQueryStringValue(HKCU, WebView2Key, 'pv', V) and (V <> '') and (V <> '0.0.0.0'));
end;

// Windows 11 ships the WebView2 runtime; older Windows 10 installs may not have it.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  Result := '';
  if HasWebView2 then Exit;
  try
    DownloadTemporaryFile(WebView2Url, 'MicrosoftEdgeWebview2Setup.exe', '', nil);
    Exec(ExpandConstant('{tmp}\MicrosoftEdgeWebview2Setup.exe'), '/silent /install', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  except
    Log('WebView2 bootstrapper failed: ' + GetExceptionMessage);
  end;
  if not HasWebView2 then
    Result := 'O Pulse precisa do Microsoft Edge WebView2 Runtime. Instale-o em https://go.microsoft.com/fwlink/p/?LinkId=2124703 e execute este instalador novamente.';
end;
