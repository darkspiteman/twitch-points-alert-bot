# Установка Twitch Alert Bot: подготовка Node.js, зависимостей, лаунчера и ярлыков.
# Запуск: двойной щелчок по install.cmd в папке программы.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
function Step($t) { Write-Host ''; Write-Host "== $t" -ForegroundColor Cyan }

Step 'Проверка Node.js'
$node = Get-Command node.exe -ErrorAction SilentlyContinue
$runtimeNode = Join-Path $root 'runtime\node.exe'
if (-not $node -and -not (Test-Path $runtimeNode)) {
  Write-Host 'Node.js не найден. Установите Node.js LTS (версия 22.18 или новее) с https://nodejs.org и запустите install.cmd снова.' -ForegroundColor Red
  exit 1
}
$nodeExe = if ($node) { $node.Source } else { $runtimeNode }
$ver = & $nodeExe -v
$parts = $ver.TrimStart('v').Split('.') | ForEach-Object { [int]$_ }
if ($parts[0] -lt 22 -or ($parts[0] -eq 22 -and $parts[1] -lt 18)) {
  Write-Host "Нужен Node.js 22.18 или новее, установлен $ver." -ForegroundColor Red
  exit 1
}
Write-Host "Найден Node.js $ver"

# Собственная копия node.exe: обновление системного Node.js не сломает бота.
if ($node) {
  New-Item -ItemType Directory -Force (Join-Path $root 'runtime') | Out-Null
  Copy-Item $node.Source $runtimeNode -Force
  Write-Host "Node.js скопирован в runtime\node.exe"
}

Step 'Установка зависимостей'
if (-not (Test-Path (Join-Path $root 'node_modules\ws\package.json'))) {
  $npm = Join-Path (Split-Path $nodeExe) 'npm.cmd'
  if (-not (Test-Path $npm)) { $npm = 'npm.cmd' }
  & $npm install --omit=dev --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'npm install завершился с ошибкой' }
} else { Write-Host 'Зависимости уже установлены' }

Step 'Сборка лаунчера'
& (Join-Path $root 'launcher\build-launcher.ps1')

Step 'Ярлыки'
$exe = Join-Path $root 'TwitchAlertBot.exe'
$shell = New-Object -ComObject WScript.Shell
$targets = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Twitch Alert Bot.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Programs')) 'Twitch Alert Bot.lnk')
)
foreach ($lnkPath in $targets) {
  $lnk = $shell.CreateShortcut($lnkPath)
  $lnk.TargetPath = $exe
  $lnk.WorkingDirectory = $root
  $lnk.IconLocation = "$exe,0"
  $lnk.Description = 'Оповещения о наградах за баллы канала Twitch для OBS'
  $lnk.Save()
  Write-Host "Создан ярлык: $lnkPath"
}

Step 'Готово'
Write-Host 'Запустите «Twitch Alert Bot» с рабочего стола. Значок появится в трее рядом с часами,'
Write-Host 'а панель управления откроется в браузере. Автозапуск с Windows включается в «Настройки → Система».'
