[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
  [Parameter()]
  [string]$OutputRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ProjectRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$UsageDocName = (-join @([char]0x4f7f, [char]0x7528, [char]0x8bf4, [char]0x660e)) + '.md'
$TechnicalOverviewName = (-join @([char]0x63d2, [char]0x4ef6, [char]0x6280, [char]0x672f, [char]0x603b, [char]0x89c8)) + '.md'
$MaintainerGuideName = (-join @([char]0x7ef4, [char]0x62a4, [char]0x8005, [char]0x4ea4, [char]0x63a5, [char]0x6307, [char]0x5357)) + '.md'
$StartHereName = (-join @([char]0x4ece, [char]0x8fd9, [char]0x91cc, [char]0x5f00, [char]0x59cb)) + '.md'
$ProjectDisplayName = -join @([char]0x6587, [char]0x7ae0, [char]0x7f29, [char]0x7565, [char]0x56fe, [char]0x9884, [char]0x89c8)
if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
  $OutputRoot = Join-Path $ProjectRoot 'dist'
}
$OutputRootPath = if ([System.IO.Path]::IsPathRooted($OutputRoot)) {
  [System.IO.Path]::GetFullPath($OutputRoot)
} else {
  [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot $OutputRoot))
}
$ManifestPath = Join-Path $ProjectRoot 'manifest.json'
$VerifyPath = Join-Path $ProjectRoot 'tools\verify.js'
$ExtensionPackagePath = Join-Path $ProjectRoot 'tools\package-extension.ps1'
$GuidePath = Join-Path $ProjectRoot $MaintainerGuideName

$SourceFiles = @(
  '.gitignore',
  '.github/workflows/verify.yml',
  '.gitattributes',
  'README.md',
  'README.en.md',
  'CHANGELOG.md',
  'PROJECT_OVERVIEW.md',
  'HANDOFF.md',
  $UsageDocName,
  $TechnicalOverviewName,
  $MaintainerGuideName,
  'manifest.json',
  'background.js',
  'cache.js',
  'config.js',
  'content.css',
  'content.js',
  'defaults.js',
  'fetcher.js',
  'floating-panel.css',
  'floating-panel.js',
  'forum-pacer.js',
  'loader.js',
  'loading-policy.js',
  'logger.js',
  'page-fetch-bridge.js',
  'popup.css',
  'popup.html',
  'popup.js',
  'popup-mirrors.js',
  'previewer.js',
  'renderer.js',
  'resource-panel.js',
  'resource-marks.js',
  'scanner.js',
  'settings-schema.js',
  'shared-utils.js',
  'viewport-observer.js',
  'icons/icon16.png',
  'icons/icon48.png',
  'icons/icon128.png',
  'tests/resource-extraction.test.js',
  'tests/loading-policy.test.js',
  'tests/page-fetch-bridge.test.js',
  'tests/release-regressions.test.js',
  'tests/text-queue.test.js',
  'tests/page-fixtures.test.js',
  'tests/mirror-sites.test.js',
  'tests/resource-marks.test.js',
  'tests/fixtures/pages/cases.json',
  'tests/fixtures/pages/README.md',
  'tests/fixtures/pages/listing.html',
  'tests/fixtures/pages/gallery.html',
  'tests/fixtures/pages/resources.html',
  'tests/fixtures/pages/login.html',
  'tests/fixtures/resource-extraction.json',
  'tools/verify.js',
  'tools/browser-smoke.js',
  'tools/package-extension.ps1',
  'tools/package-maintainer-handoff.ps1'
)

function Get-PathPrefix {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  return $Path.TrimEnd(
    [System.IO.Path]::DirectorySeparatorChar,
    [System.IO.Path]::AltDirectorySeparatorChar
  ) + [System.IO.Path]::DirectorySeparatorChar
}

function Assert-StrictChildPath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ChildPath,

    [Parameter(Mandatory = $true)]
    [string]$ParentPath,

    [Parameter(Mandatory = $true)]
    [string]$Label
  )

  $child = [System.IO.Path]::GetFullPath($ChildPath)
  $parent = [System.IO.Path]::GetFullPath($ParentPath)
  $prefix = Get-PathPrefix -Path $parent
  if (-not $child.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label must be strictly inside '$parent': $child"
  }
}

function Assert-NoReparsePointTree {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  $rootItem = Get-Item -LiteralPath $Path -Force
  if (($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Refusing a reparse-point directory: $Path"
  }

  $pending = New-Object 'System.Collections.Generic.Stack[System.IO.DirectoryInfo]'
  $pending.Push([System.IO.DirectoryInfo]$rootItem)
  while ($pending.Count -gt 0) {
    $directory = $pending.Pop()
    foreach ($entry in $directory.GetFileSystemInfos()) {
      if (($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing a tree containing a reparse point: $($entry.FullName)"
      }
      if ($entry -is [System.IO.DirectoryInfo]) {
        $pending.Push($entry)
      }
    }
  }
}

function Remove-SafeDirectory {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,

    [Parameter(Mandatory = $true)]
    [string]$SafeRoot
  )

  Assert-StrictChildPath -ChildPath $Path -ParentPath $SafeRoot -Label 'directory removal target'
  if (-not (Test-Path -LiteralPath $Path)) {
    return
  }
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
    throw "Expected a directory but found another entry: $Path"
  }
  Assert-NoReparsePointTree -Path $Path
  Remove-Item -LiteralPath $Path -Recurse -Force
}

function Remove-SafeFile {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,

    [Parameter(Mandatory = $true)]
    [string]$SafeRoot
  )

  Assert-StrictChildPath -ChildPath $Path -ParentPath $SafeRoot -Label 'file removal target'
  if (-not (Test-Path -LiteralPath $Path)) {
    return
  }
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Expected a file but found another entry: $Path"
  }
  $item = Get-Item -LiteralPath $Path -Force
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Refusing a reparse-point file: $Path"
  }
  Remove-Item -LiteralPath $Path -Force
}

function Assert-SourceFiles {
  $seen = @{}
  foreach ($relativePath in $SourceFiles) {
    $normalized = $relativePath.Replace('\', '/').TrimStart('/')
    $key = $normalized.ToLowerInvariant()
    if ($seen.ContainsKey($key)) {
      throw "Duplicate source handoff path: $normalized"
    }
    $seen[$key] = $true

    $sourcePath = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot $normalized))
    Assert-StrictChildPath -ChildPath $sourcePath -ParentPath $ProjectRoot -Label 'source handoff file'
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
      throw "Source handoff file is missing: $normalized"
    }
    $item = Get-Item -LiteralPath $sourcePath -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Source handoff file must not be a reparse point: $normalized"
    }
  }
}

function Copy-SourceSnapshot {
  param(
    [Parameter(Mandatory = $true)]
    [string]$DestinationRoot
  )

  foreach ($relativePath in $SourceFiles) {
    $platformPath = $relativePath.Replace('/', [System.IO.Path]::DirectorySeparatorChar)
    $sourcePath = Join-Path $ProjectRoot $platformPath
    $destinationPath = Join-Path $DestinationRoot $platformPath
    Assert-StrictChildPath -ChildPath $destinationPath -ParentPath $DestinationRoot -Label 'source snapshot destination'
    $destinationDirectory = Split-Path -Parent $destinationPath
    if (-not [System.IO.Directory]::Exists($destinationDirectory)) {
      $null = [System.IO.Directory]::CreateDirectory($destinationDirectory)
    }
    [System.IO.File]::Copy($sourcePath, $destinationPath, $true)
  }
}

function Invoke-NodeVerification {
  param(
    [Parameter(Mandatory = $true)]
    [string]$SourceRoot
  )

  $node = Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1
  $verify = Join-Path $SourceRoot 'tools\verify.js'
  Push-Location $SourceRoot
  try {
    & $node.Source $verify
    if ($LASTEXITCODE -ne 0) {
      throw "node tools/verify.js failed with exit code $LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }
}

function Assert-HandoffTreeBoundary {
  param(
    [Parameter(Mandatory = $true)]
    [string]$StageRoot
  )

  $forbiddenDirectories = @('.git', '.claude', '.agents', '.opencode', '.codex', 'node_modules', 'dist', 'logs')
  $stagePrefix = Get-PathPrefix -Path $StageRoot
  foreach ($entry in Get-ChildItem -LiteralPath $StageRoot -Force -Recurse) {
    if (($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Handoff tree contains a reparse point: $($entry.FullName)"
    }
    $relative = $entry.FullName.Substring($stagePrefix.Length).Replace('\', '/')
    foreach ($part in ($relative -split '/')) {
      if ($forbiddenDirectories -contains $part.ToLowerInvariant()) {
        throw "Handoff tree contains a forbidden directory: $relative"
      }
    }
    if ($entry -is [System.IO.FileInfo]) {
      if ($entry.Name -match '(?i)^\.env(?:\.|$)' -or $entry.Extension -match '(?i)^\.(?:pem|key|p12|pfx|crt|cer|sqlite|sqlite3|db|dump|sql|bak|log)$') {
        throw "Handoff tree contains a sensitive file type: $relative"
      }
      if ($entry.Extension -match '(?i)^\.(?:js|css|html|json|md|ps1)$' -or $entry.Name -eq '.gitignore') {
        $text = [System.IO.File]::ReadAllText($entry.FullName)
        if ($text -match '(?i)[A-Z]:\\Users\\[^\\]+\\' -or $text -match '(?i)G:\\(?:opencode_projects|OneDrive|AppData)\\') {
          throw "Handoff tree contains a machine-specific absolute path: $relative"
        }
      }
    }
  }
}

function Get-RelativeFileRecords {
  param(
    [Parameter(Mandatory = $true)]
    [string]$StageRoot
  )

  $stagePrefix = Get-PathPrefix -Path $StageRoot
  $records = @()
  foreach ($file in Get-ChildItem -LiteralPath $StageRoot -File -Recurse | Sort-Object FullName) {
    $relative = $file.FullName.Substring($stagePrefix.Length).Replace('\', '/')
    if ($relative -eq 'HANDOFF-MANIFEST.json') {
      continue
    }
    $records += [ordered]@{
      path = $relative
      bytes = $file.Length
      sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
  }
  return $records
}

function Get-GitHead {
  if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot '.git'))) {
    return $null
  }
  $gitCommands = @(Get-Command git -CommandType Application -ErrorAction SilentlyContinue)
  if ($gitCommands.Count -eq 0) {
    return $null
  }
  $result = & $gitCommands[0].Source -C $ProjectRoot rev-parse --verify --quiet HEAD
  if ($LASTEXITCODE -ne 0) {
    return $null
  }
  return ([string]$result).Trim()
}

function Assert-HandoffArchive {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ArchivePath,

    [Parameter(Mandatory = $true)]
    [string[]]$RequiredEntries
  )

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [System.IO.Compression.ZipFile]::OpenRead($ArchivePath)
  try {
    $names = @{}
    foreach ($entry in $archive.Entries) {
      $name = $entry.FullName.Replace('\', '/')
      if (-not $name -or $name.StartsWith('/') -or $name -match '(^|/)\.\.(/|$)') {
        throw "Unsafe handoff archive entry: $name"
      }
      $key = $name.ToLowerInvariant()
      if ($names.ContainsKey($key)) {
        throw "Duplicate handoff archive entry: $name"
      }
      $names[$key] = $name
      if ($name -match '(^|/)(?:\.git|\.claude|\.agents|\.opencode|\.codex|node_modules|dist|logs)(/|$)') {
        throw "Forbidden handoff archive entry: $name"
      }
    }
    foreach ($required in $RequiredEntries) {
      if (-not $names.ContainsKey($required.ToLowerInvariant())) {
        throw "Handoff archive is missing required entry: $required"
      }
    }
  } finally {
    $archive.Dispose()
  }
}

if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
  throw "Manifest not found: $ManifestPath"
}
if (-not (Test-Path -LiteralPath $VerifyPath -PathType Leaf)) {
  throw "Verification script not found: $VerifyPath"
}
if (-not (Test-Path -LiteralPath $ExtensionPackagePath -PathType Leaf)) {
  throw "Extension package script not found: $ExtensionPackagePath"
}
if (-not (Test-Path -LiteralPath $GuidePath -PathType Leaf)) {
  throw "Maintainer guide not found: $GuidePath"
}

Assert-SourceFiles
Write-Host 'Running current-worktree verification...'
Invoke-NodeVerification -SourceRoot $ProjectRoot

$manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath $ManifestPath | ConvertFrom-Json
$version = [string]$manifest.version
if ($version -notmatch '^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$') {
  throw "Manifest version is not safe for a package filename: $version"
}

$projectName = 'article-thumbnail-preview'
$archiveName = "$projectName-maintainer-v$version.zip"
$archivePath = Join-Path $OutputRootPath $archiveName
$hashPath = "$archivePath.sha256"
$releaseArchiveName = "$projectName-v$version.zip"
$releaseHashName = "$releaseArchiveName.sha256"
Assert-StrictChildPath -ChildPath $archivePath -ParentPath $OutputRootPath -Label 'maintainer archive'
Assert-StrictChildPath -ChildPath $hashPath -ParentPath $OutputRootPath -Label 'maintainer checksum'

Write-Host ("Source snapshot files: {0}" -f $SourceFiles.Count)
Write-Host ("Maintainer archive: {0}" -f $archivePath)
if (-not $PSCmdlet.ShouldProcess($archivePath, 'Build verified maintainer handoff archive')) {
  return
}

if (Test-Path -LiteralPath $OutputRootPath) {
  if (-not (Test-Path -LiteralPath $OutputRootPath -PathType Container)) {
    throw "OutputRoot is not a directory: $OutputRootPath"
  }
  $outputItem = Get-Item -LiteralPath $OutputRootPath -Force
  if (($outputItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "OutputRoot must not be a reparse point: $OutputRootPath"
  }
} else {
  $null = [System.IO.Directory]::CreateDirectory($OutputRootPath)
}

$stageRoot = Join-Path $OutputRootPath ('.maintainer.stage-' + [System.Guid]::NewGuid().ToString('N'))
$temporaryArchive = Join-Path $OutputRootPath ('.maintainer.archive-' + [System.Guid]::NewGuid().ToString('N') + '.zip')
Assert-StrictChildPath -ChildPath $stageRoot -ParentPath $OutputRootPath -Label 'maintainer staging directory'
Assert-StrictChildPath -ChildPath $temporaryArchive -ParentPath $OutputRootPath -Label 'temporary maintainer archive'

try {
  $sourceRoot = Join-Path $stageRoot 'source'
  $releaseRoot = Join-Path $stageRoot 'release'
  $null = [System.IO.Directory]::CreateDirectory($sourceRoot)
  $null = [System.IO.Directory]::CreateDirectory($releaseRoot)

  Copy-SourceSnapshot -DestinationRoot $sourceRoot
  [System.IO.File]::Copy((Join-Path $sourceRoot $MaintainerGuideName), (Join-Path $stageRoot $StartHereName), $true)

  Write-Host 'Verifying copied source snapshot...'
  Invoke-NodeVerification -SourceRoot $sourceRoot

  Write-Host 'Building installable extension inside the handoff...'
  & (Join-Path $sourceRoot 'tools\package-extension.ps1') -OutputRoot $releaseRoot -Zip

  $builtArchives = @(Get-ChildItem -LiteralPath $releaseRoot -File -Filter "*-v$version.zip")
  if ($builtArchives.Count -ne 1) {
    throw "Expected one nested extension ZIP, found $($builtArchives.Count)"
  }
  $builtZipPath = $builtArchives[0].FullName
  $builtHashPath = "$builtZipPath.sha256"
  if (-not (Test-Path -LiteralPath $builtHashPath -PathType Leaf)) {
    throw 'Nested installable extension checksum was not generated'
  }

  $declaredReleaseHash = ((Get-Content -Raw -Encoding UTF8 -LiteralPath $builtHashPath).Trim() -split '\s+')[0].ToLowerInvariant()
  $actualReleaseHash = (Get-FileHash -LiteralPath $builtZipPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualReleaseHash -ne $declaredReleaseHash) {
    throw 'Nested extension ZIP checksum does not match'
  }

  $releaseZipPath = Join-Path $releaseRoot $releaseArchiveName
  $releaseHashPath = Join-Path $releaseRoot $releaseHashName
  if (-not $builtZipPath.Equals($releaseZipPath, [System.StringComparison]::OrdinalIgnoreCase)) {
    Move-Item -LiteralPath $builtZipPath -Destination $releaseZipPath
  }
  if (-not $builtHashPath.Equals($releaseHashPath, [System.StringComparison]::OrdinalIgnoreCase)) {
    [System.IO.File]::Delete($builtHashPath)
  }
  $releaseHashLine = "$actualReleaseHash  $releaseArchiveName`r`n"
  [System.IO.File]::WriteAllText(
    $releaseHashPath,
    $releaseHashLine,
    (New-Object System.Text.UTF8Encoding($false))
  )

  Assert-HandoffTreeBoundary -StageRoot $stageRoot
  $fileRecords = Get-RelativeFileRecords -StageRoot $stageRoot
  $handoffManifest = [ordered]@{
    project = $ProjectDisplayName
    version = $version
    generatedAtUtc = [DateTime]::UtcNow.ToString('o')
    sourceSnapshot = 'verified-current-worktree'
    sourceBaseCommit = Get-GitHead
    gitMetadataIncluded = $false
    installableZip = "release/$releaseArchiveName"
    installableZipSha256 = $actualReleaseHash
    fileCountExcludingManifest = $fileRecords.Count
    files = $fileRecords
  }
  $manifestJson = $handoffManifest | ConvertTo-Json -Depth 6
  [System.IO.File]::WriteAllText(
    (Join-Path $stageRoot 'HANDOFF-MANIFEST.json'),
    $manifestJson + "`r`n",
    (New-Object System.Text.UTF8Encoding($false))
  )

  Assert-HandoffTreeBoundary -StageRoot $stageRoot
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::CreateFromDirectory(
    $stageRoot,
    $temporaryArchive,
    [System.IO.Compression.CompressionLevel]::Optimal,
    $false
  )

  Assert-HandoffArchive -ArchivePath $temporaryArchive -RequiredEntries @(
    $StartHereName,
    'HANDOFF-MANIFEST.json',
    'source/manifest.json',
    "source/$MaintainerGuideName",
    'source/tools/verify.js',
    'source/tools/package-maintainer-handoff.ps1',
    'release/chrome-unpacked/manifest.json',
    "release/$releaseArchiveName",
    "release/$releaseHashName"
  )

  Remove-SafeFile -Path $archivePath -SafeRoot $OutputRootPath
  Remove-SafeFile -Path $hashPath -SafeRoot $OutputRootPath
  Move-Item -LiteralPath $temporaryArchive -Destination $archivePath

  $archiveHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
  $hashLine = "$archiveHash  $archiveName`r`n"
  [System.IO.File]::WriteAllText(
    $hashPath,
    $hashLine,
    (New-Object System.Text.UTF8Encoding($false))
  )

  Write-Host ("Maintainer archive ready: {0}" -f $archivePath)
  Write-Host ("Checksum ready: {0}" -f $hashPath)
  Write-Host ("SHA-256: {0}" -f $archiveHash)
} finally {
  if (Test-Path -LiteralPath $temporaryArchive) {
    Remove-SafeFile -Path $temporaryArchive -SafeRoot $OutputRootPath
  }
  if (Test-Path -LiteralPath $stageRoot) {
    Remove-SafeDirectory -Path $stageRoot -SafeRoot $OutputRootPath
  }
}
