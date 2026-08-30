# Local desktop update channel for this Flux checkout.
# Builds with mock-updates, serves ./release-mock over HTTP, installs, and
# registers a logon task so Updates check this folder without using a CLI.

param(
  [ValidateSet("all", "build", "serve", "install", "register-autostart", "pin")]
  [string]$Action = "all",
  [int]$Port = 4141
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$ReleaseMock = Join-Path $RepoRoot "release-mock"
$VpBin = Join-Path $env:LOCALAPPDATA "vite-plus\bin"
if (Test-Path $VpBin) {
  $env:Path = "$VpBin;" + $env:Path
}

function Ensure-Vp {
  if (-not (Get-Command vp -ErrorAction SilentlyContinue)) {
    throw "vp is not installed. Open a new terminal after installing Vite+ from https://vite.plus"
  }
}

function Build-LocalDesktop {
  Ensure-Vp
  Set-Location $RepoRoot
  Write-Host "Installing workspace deps..."
  vp i
  Write-Host "Building Windows installer with local update feed on port $Port..."
  $env:T3CODE_DESKTOP_MOCK_UPDATES = "true"
  $env:T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT = "$Port"
  $env:T3CODE_DESKTOP_VERBOSE = "true"
  node (Join-Path $RepoRoot "scripts\build-desktop-artifact.ts") --platform win --target nsis --mock-updates --mock-update-server-port $Port --verbose
}

function Start-UpdateServer {
  if (-not (Test-Path $ReleaseMock)) {
    throw "Missing $ReleaseMock. Run -Action build first."
  }
  $env:T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT = "$Port"
  $env:T3CODE_DESKTOP_MOCK_UPDATE_SERVER_ROOT = $ReleaseMock
  Set-Location $RepoRoot
  Write-Host "Serving local updates from $ReleaseMock on http://localhost:$Port"
  node (Join-Path $RepoRoot "scripts\mock-update-server.ts")
}

function Find-Installer {
  if (-not (Test-Path $ReleaseMock)) { return $null }
  Get-ChildItem -Path $ReleaseMock -Filter "*.exe" -Recurse |
    Where-Object { $_.Name -match "Flux|T3-Code|Setup|nsis" -or $_.Extension -eq ".exe" } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
}

function Install-LocalDesktop {
  $installer = Find-Installer
  if ($null -eq $installer) {
    throw "No installer found under $ReleaseMock. Run -Action build first."
  }
  Write-Host "Installing $($installer.FullName) silently..."
  $proc = Start-Process -FilePath $installer.FullName -ArgumentList "/S" -Wait -PassThru
  if ($null -ne $proc.ExitCode -and $proc.ExitCode -ne 0) {
    Write-Warning "Installer exited with code $($proc.ExitCode)"
  }
}

function Register-UpdateServerAutostart {
  $taskName = "T3CodeLocalUpdateServer"
  $scriptPath = Join-Path $PSScriptRoot "windows-local-channel.ps1"
  $action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$scriptPath`" -Action serve -Port $Port"
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
  Write-Host "Registered scheduled task '$taskName' to serve updates from this folder at logon."
  Start-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
}

function Pin-Flux {
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA "Programs\t3-code-desktop\Flux (Alpha).exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\t3-code\Flux (Alpha).exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\Flux\Flux (Alpha).exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\t3-code-desktop\T3 Code (Alpha).exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\t3-code\T3 Code (Alpha).exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\T3 Code\T3 Code (Alpha).exe"),
    (Join-Path ${env:ProgramFiles} "Flux\Flux (Alpha).exe"),
    (Join-Path ${env:ProgramFiles} "T3 Code\T3 Code (Alpha).exe")
  )
  $exe = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $exe) {
    $exe = Get-ChildItem -Path "$env:LOCALAPPDATA\Programs","$env:ProgramFiles","$env:ProgramFiles(x86)" -Filter "*Flux*.exe" -Recurse -ErrorAction SilentlyContinue |
      Select-Object -First 1 -ExpandProperty FullName
  }
  if (-not $exe) {
    $exe = Get-ChildItem -Path "$env:LOCALAPPDATA\Programs","$env:ProgramFiles","$env:ProgramFiles(x86)" -Filter "*T3*Code*.exe" -Recurse -ErrorAction SilentlyContinue |
      Select-Object -First 1 -ExpandProperty FullName
  }
  if (-not $exe) {
    Write-Warning "Could not find installed Flux.exe to pin."
    return
  }

  $startMenu = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
  $shortcutPath = Join-Path $startMenu "Flux.lnk"
  $wscript = New-Object -ComObject WScript.Shell
  $shortcut = $wscript.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = $exe
  $shortcut.WorkingDirectory = Split-Path $exe
  $shortcut.Description = "Flux (local update channel)"
  $shortcut.Save()
  Write-Host "Start Menu shortcut: $shortcutPath"

  # Taskbar pin: removed as a public API on modern Windows. Try the verb; if it
  # fails, leave the Start Menu shortcut for one-click pin from the user.
  try {
    $shell = New-Object -ComObject Shell.Application
    $folder = $shell.Namespace((Split-Path $shortcutPath))
    $item = $folder.ParseName((Split-Path $shortcutPath -Leaf))
    $verb = $item.Verbs() | Where-Object { $_.Name -replace "&", "" -match "Pin to taskbar|Pin to Tas" } | Select-Object -First 1
    if ($verb) {
      $verb.DoIt()
      Write-Host "Pinned to taskbar."
    } else {
      Write-Warning "Windows blocked automatic taskbar pin. Right-click Start → Flux → Pin to taskbar."
    }
  } catch {
    Write-Warning "Could not auto-pin to taskbar: $($_.Exception.Message). Pin manually from Start."
  }
}

switch ($Action) {
  "build" { Build-LocalDesktop }
  "serve" { Start-UpdateServer }
  "install" { Install-LocalDesktop }
  "register-autostart" { Register-UpdateServerAutostart }
  "pin" { Pin-Flux }
  "all" {
    Build-LocalDesktop
    Register-UpdateServerAutostart
    Install-LocalDesktop
    Pin-Flux
  }
}
