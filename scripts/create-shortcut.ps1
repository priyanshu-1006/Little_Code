param(
  [Parameter(Mandatory = $true)][string]$ExecutablePath,
  [Parameter(Mandatory = $true)][string]$ShortcutPath
)
$ErrorActionPreference = 'Stop'
$projectDirectory = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$targetExecutable = [IO.Path]::GetFullPath($ExecutablePath)
$targetShortcut = [IO.Path]::GetFullPath($ShortcutPath)
$projectPrefix = $projectDirectory.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if (-not $targetExecutable.StartsWith($projectPrefix, [StringComparison]::OrdinalIgnoreCase) -or
    -not $targetShortcut.StartsWith($projectPrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Little Code launcher paths must stay inside the project directory.'
}
if (-not (Test-Path -LiteralPath $targetExecutable -PathType Leaf)) { throw 'The packaged Little Code executable is missing.' }
$shortcutShell = New-Object -ComObject WScript.Shell
try {
  $shortcut = $shortcutShell.CreateShortcut($targetShortcut)
  $shortcut.TargetPath = $targetExecutable
  $shortcut.WorkingDirectory = Split-Path -Parent $targetExecutable
  $shortcut.IconLocation = "$targetExecutable,0"
  $shortcut.Description = 'Little Code - Your AI-native coding companion'
  $shortcut.Save()
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shortcut)
} finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shortcutShell) }
Write-Output "Little Code shortcut ready: $targetShortcut"
