param(
  [string]$Version
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Write-Stage {
  param(
    [Parameter(Mandatory = $true)]
    [int]$Number,
    [Parameter(Mandatory = $true)]
    [string]$Message
  )

  Write-Host "[$Number/7] $Message"
}

function Write-Ok {
  param([Parameter(Mandatory = $true)][string]$Message)
  Write-Host "OK $Message"
}

function Fail {
  param([string]$Message)
  throw $Message
}

function Increment-PatchVersion {
  param([string]$CurrentVersion)

  if ($CurrentVersion -notmatch '^(\d+)\.(\d+)\.(\d+)$') {
    Fail "Versao atual invalida: $CurrentVersion"
  }

  $major = [int]$Matches[1]
  $minor = [int]$Matches[2]
  $patch = [int]$Matches[3] + 1
  return "$major.$minor.$patch"
}

function Assert-CommandExists {
  param([string]$Name)
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Invoke-Git {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$Arguments
  )

  & git @Arguments
  if ($LASTEXITCODE -ne 0) {
    Fail "Falha ao executar git $($Arguments -join ' ')"
  }
}

function Invoke-Gh {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$Arguments
  )

  & gh @Arguments
  if ($LASTEXITCODE -ne 0) {
    Fail "Falha ao executar gh $($Arguments -join ' ')"
  }
}

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

if (-not (Assert-CommandExists -Name 'gh')) {
  Write-Host 'GitHub CLI nao instalado.'
  Write-Host 'Baixe:'
  Write-Host 'https://github.com/cli/cli/releases/latest'
  exit 1
}

Write-Stage 1 'Validando GitHub auth...'
& gh auth status -h github.com
if ($LASTEXITCODE -ne 0) {
  Write-Host 'GitHub CLI nao autenticado. Execute "gh auth login" e tente novamente.'
  exit 1
}

$currentBranch = (git branch --show-current).Trim()
if ($LASTEXITCODE -ne 0) {
  Fail 'Nao foi possivel identificar a branch atual.'
}
if ($currentBranch -ne 'main') {
  Fail "Execute a release a partir da branch main. Branch atual: $currentBranch"
}

$package = Get-Content (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json
$currentVersion = [string]$package.version

if ([string]::IsNullOrWhiteSpace($Version)) {
  $inputVersion = Read-Host "Nova versao ou Enter para patch automatico (atual: $currentVersion)"
  $Version = $inputVersion.Trim()
}

if ([string]::IsNullOrWhiteSpace($Version) -or $Version -ieq 'patch') {
  $Version = Increment-PatchVersion -CurrentVersion $currentVersion
} elseif ($Version -notmatch '^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$') {
  Fail "Versao invalida: $Version"
}

if ($Version -eq $currentVersion) {
  Fail "A nova versao precisa ser diferente da atual: $currentVersion"
}

Write-Stage 2 'Atualizando versao...'
Write-Host "Versao atual: $currentVersion"
Write-Host "Versao nova:   $Version"

& npm version $Version --no-git-tag-version
if ($LASTEXITCODE -ne 0) {
  Fail 'Falha ao atualizar a versao no package.json.'
}

Write-Stage 3 'Gerando build Windows...'
$distDir = Join-Path $repoRoot 'dist'
if (Test-Path $distDir) {
  Remove-Item -LiteralPath $distDir -Recurse -Force
}

& npm run dist:win
if ($LASTEXITCODE -ne 0) {
  Fail 'Falha no build Windows.'
}

Write-Stage 4 'Validando dist...'
$expectedAssets = @(
  'PrintAssistantSetup.exe',
  'latest.yml',
  'PrintAssistantSetup.exe.blockmap'
)

foreach ($asset in $expectedAssets) {
  $assetPath = Join-Path $distDir $asset
  if (-not (Test-Path $assetPath)) {
    Fail "Asset obrigatorio ausente: $assetPath"
  }
}

$latestYmlPath = Join-Path $distDir 'latest.yml'
$latestYml = Get-Content $latestYmlPath -Raw
if ($latestYml -notmatch "(?m)^version:\s+$([regex]::Escape($Version))\s*$") {
  Fail "latest.yml nao corresponde a versao $Version."
}

$cleanupTargets = @(
  (Join-Path $distDir 'win-unpacked'),
  (Join-Path $distDir 'builder-debug.yml'),
  (Join-Path $distDir 'builder-effective-config.yaml'),
  (Join-Path $repoRoot 'builder-debug.yml'),
  (Join-Path $repoRoot 'builder-effective-config.yaml')
)

foreach ($target in $cleanupTargets) {
  if (Test-Path $target) {
    Remove-Item -LiteralPath $target -Recurse -Force
  }
}

Get-ChildItem -LiteralPath $distDir -Force | Where-Object {
  $expectedAssets -notcontains $_.Name
} | Remove-Item -Recurse -Force

foreach ($asset in $expectedAssets) {
  if (-not (Test-Path (Join-Path $distDir $asset))) {
    Fail "Falha na limpeza, asset perdido: $asset"
  }
}

Write-Ok 'Build concluido'
Write-Ok "Version bump $Version"

$tag = "v$Version"
$releaseTitle = "Print Assistant $Version"
$releaseNotes = @"
Automated release $Version

Assets:
- PrintAssistantSetup.exe
- latest.yml
- PrintAssistantSetup.exe.blockmap
"@

Write-Stage 5 'Adicionando alteracoes e commitando...'
Invoke-Git -Arguments @('add', '.')
Invoke-Git -Arguments @('commit', '-m', "chore(release): $Version")
Write-Ok 'Git commit realizado'

Invoke-Git -Arguments @('tag', '-fa', $tag, '-m', "Release $Version")
Invoke-Git -Arguments @('push', 'origin', 'main')
Invoke-Git -Arguments @('push', 'origin', $tag, '--force')
Write-Ok 'Push enviado'

Write-Stage 6 'Publicando release...'
$releaseExists = $true
try {
  Invoke-Gh -Arguments @('release', 'view', $tag)
} catch {
  $releaseExists = $false
}

if ($releaseExists) {
  Invoke-Gh -Arguments @('release', 'edit', $tag, '--title', $releaseTitle, '--notes', $releaseNotes, '--latest')
} else {
  Invoke-Gh -Arguments @('release', 'create', $tag, '--title', $releaseTitle, '--notes', $releaseNotes, '--latest')
}

Invoke-Gh -Arguments @(
  'release', 'upload', $tag,
  (Join-Path $distDir 'PrintAssistantSetup.exe'),
  (Join-Path $distDir 'latest.yml'),
  (Join-Path $distDir 'PrintAssistantSetup.exe.blockmap'),
  '--clobber'
)

Write-Stage 7 'Upload concluido.'
Write-Ok 'Release criada'
Write-Ok 'Latest atualizado'
Write-Ok 'Instalador publicado'
