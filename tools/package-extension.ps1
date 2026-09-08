[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
  [Parameter()]
  [string]$OutputRoot,

  [Parameter()]
  [switch]$Zip
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ProjectRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
  $OutputRoot = Join-Path $ProjectRoot 'dist'
}
$ManifestPath = Join-Path $ProjectRoot 'manifest.json'
$VerifyPath = Join-Path $ProjectRoot 'tools\verify.js'
$RuntimeFiles = @{}
$ForbiddenPathParts = @(
  'tests',
  'tools',
  '.git',
  '.agents',
  '.claude',
  '.opencode',
  '.codex',
  'node_modules'
)

function Get-FullPath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,

    [Parameter(Mandatory = $true)]
    [string]$BasePath
  )

  if ([System.IO.Path]::IsPathRooted($Path)) {
    return [System.IO.Path]::GetFullPath($Path)
  }

  return [System.IO.Path]::GetFullPath((Join-Path $BasePath $Path))
}

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

function Get-ObjectPropertyValue {
  param(
    [AllowNull()]
    [object]$InputObject,

    [Parameter(Mandatory = $true)]
    [string]$Name
  )

  if ($null -eq $InputObject) {
    return $null
  }

  $property = $InputObject.PSObject.Properties[$Name]
  if ($null -eq $property) {
    return $null
  }

  return $property.Value
}

function Assert-NoReparsePointInSourcePath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  $current = Get-Item -LiteralPath $Path -Force
  while ($true) {
    if (($current.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Runtime reference traverses a reparse point: $($current.FullName)"
    }

    if ($current -is [System.IO.DirectoryInfo]) {
      $parent = $current.Parent
    } else {
      $parent = $current.Directory
    }
    if ($null -eq $parent) {
      break
    }
    if ($parent.FullName.Equals($ProjectRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
      break
    }
    $current = $parent
  }
}

function Assert-NoReparsePointTree {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  $rootItem = Get-Item -LiteralPath $Path -Force
  if (($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Refusing to remove a reparse-point output: $Path"
  }

  $pending = New-Object 'System.Collections.Generic.Stack[System.IO.DirectoryInfo]'
  $pending.Push([System.IO.DirectoryInfo]$rootItem)
  while ($pending.Count -gt 0) {
    $directory = $pending.Pop()
    foreach ($entry in $directory.GetFileSystemInfos()) {
      if (($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing to remove output containing a reparse point: $($entry.FullName)"
      }
      if ($entry -is [System.IO.DirectoryInfo]) {
        $pending.Push($entry)
      }
    }
  }
}

function Test-ForbiddenRuntimePath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RelativePath
  )

  if ($RelativePath -match '(?i)\.md$') {
    return $true
  }

  foreach ($part in ($RelativePath -split '/')) {
    foreach ($forbidden in $ForbiddenPathParts) {
      if ($part.Equals($forbidden, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $true
      }
    }
  }

  return $false
}

function Add-RuntimeReference {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Reference,

    [Parameter(Mandatory = $true)]
    [string]$BasePath,

    [Parameter(Mandatory = $true)]
    [string]$SourceLabel
  )

  $raw = $Reference.Trim()
  if (-not $raw) {
    throw "$SourceLabel contains an empty runtime reference"
  }
  if ($raw -match '[*?]') {
    throw "$SourceLabel contains an unsupported wildcard reference: $raw"
  }
  if ($raw -match '^(?i:[a-z][a-z0-9+.-]*:|#)') {
    throw "$SourceLabel must use a package-relative runtime reference: $raw"
  }
  if ($raw -match '[?#]' -or [System.IO.Path]::IsPathRooted($raw)) {
    throw "$SourceLabel contains an unsafe runtime reference: $raw"
  }

  $sourcePath = Get-FullPath -Path $raw -BasePath $BasePath
  Assert-StrictChildPath -ChildPath $sourcePath -ParentPath $ProjectRoot -Label $SourceLabel
  if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
    throw "$SourceLabel references a missing runtime file: $sourcePath"
  }
  Assert-NoReparsePointInSourcePath -Path $sourcePath

  $projectPrefix = Get-PathPrefix -Path $ProjectRoot
  $relativePath = $sourcePath.Substring($projectPrefix.Length).Replace('\', '/')
  if (Test-ForbiddenRuntimePath -RelativePath $relativePath) {
    throw "$SourceLabel references a forbidden release path: $relativePath"
  }

  $key = $relativePath.ToLowerInvariant()
  if ($RuntimeFiles.ContainsKey($key) -and $RuntimeFiles[$key] -cne $relativePath) {
    throw "Runtime whitelist contains case-variant paths: '$($RuntimeFiles[$key])' and '$relativePath'"
  }
  $RuntimeFiles[$key] = $relativePath
  return $relativePath
}

function Add-ObjectPropertyReferences {
  param(
    [AllowNull()]
    [object]$InputObject,

    [Parameter(Mandatory = $true)]
    [string]$BasePath,

    [Parameter(Mandatory = $true)]
    [string]$SourceLabel
  )

  if ($null -eq $InputObject) {
    return
  }

  foreach ($property in $InputObject.PSObject.Properties) {
    if ($null -ne $property.Value -and [string]$property.Value) {
      $null = Add-RuntimeReference -Reference ([string]$property.Value) -BasePath $BasePath -SourceLabel $SourceLabel
    }
  }
}

function Add-ReferenceList {
  param(
    [AllowNull()]
    [object]$References,

    [Parameter(Mandatory = $true)]
    [string]$BasePath,

    [Parameter(Mandatory = $true)]
    [string]$SourceLabel
  )

  foreach ($reference in @($References)) {
    if ($null -eq $reference) {
      continue
    }
    $null = Add-RuntimeReference -Reference ([string]$reference) -BasePath $BasePath -SourceLabel $SourceLabel
  }
}

function Add-PopupReferences {
  param(
    [Parameter(Mandatory = $true)]
    [string]$PopupRelativePath
  )

  $popupPath = Join-Path $ProjectRoot $PopupRelativePath.Replace('/', [System.IO.Path]::DirectorySeparatorChar)
  $popupDirectory = Split-Path -Parent $popupPath
  $html = Get-Content -Raw -Encoding UTF8 -LiteralPath $popupPath
  $pattern = '<(?:script|link)\b[^>]*(?:src|href)\s*=\s*(["''])(?<ref>.*?)\1'
  $matches = [System.Text.RegularExpressions.Regex]::Matches(
    $html,
    $pattern,
    [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
  )

  foreach ($match in $matches) {
    $reference = $match.Groups['ref'].Value
    $null = Add-RuntimeReference -Reference $reference -BasePath $popupDirectory -SourceLabel 'popup HTML'
  }
}

function Get-RuntimeWhitelist {
  param(
    [Parameter(Mandatory = $true)]
    [object]$Manifest
  )

  $null = Add-RuntimeReference -Reference 'manifest.json' -BasePath $ProjectRoot -SourceLabel 'package root'

  foreach ($contentScript in @(Get-ObjectPropertyValue -InputObject $Manifest -Name 'content_scripts')) {
    if ($null -eq $contentScript) {
      continue
    }
    Add-ReferenceList -References (Get-ObjectPropertyValue -InputObject $contentScript -Name 'js') -BasePath $ProjectRoot -SourceLabel 'manifest content script'
    Add-ReferenceList -References (Get-ObjectPropertyValue -InputObject $contentScript -Name 'css') -BasePath $ProjectRoot -SourceLabel 'manifest content style'
  }

  $background = Get-ObjectPropertyValue -InputObject $Manifest -Name 'background'
  $serviceWorker = Get-ObjectPropertyValue -InputObject $background -Name 'service_worker'
  if ($serviceWorker) {
    $null = Add-RuntimeReference -Reference ([string]$serviceWorker) -BasePath $ProjectRoot -SourceLabel 'manifest background worker'
  }

  $action = Get-ObjectPropertyValue -InputObject $Manifest -Name 'action'
  $popup = Get-ObjectPropertyValue -InputObject $action -Name 'default_popup'
  if ($popup) {
    $popupRelativePath = Add-RuntimeReference -Reference ([string]$popup) -BasePath $ProjectRoot -SourceLabel 'manifest popup'
    Add-PopupReferences -PopupRelativePath $popupRelativePath
  }
  Add-ObjectPropertyReferences -InputObject (Get-ObjectPropertyValue -InputObject $action -Name 'default_icon') -BasePath $ProjectRoot -SourceLabel 'manifest action icon'
  Add-ObjectPropertyReferences -InputObject (Get-ObjectPropertyValue -InputObject $Manifest -Name 'icons') -BasePath $ProjectRoot -SourceLabel 'manifest icon'

  foreach ($resourceGroup in @(Get-ObjectPropertyValue -InputObject $Manifest -Name 'web_accessible_resources')) {
    if ($null -eq $resourceGroup) {
      continue
    }
    Add-ReferenceList -References (Get-ObjectPropertyValue -InputObject $resourceGroup -Name 'resources') -BasePath $ProjectRoot -SourceLabel 'manifest web accessible resource'
  }

  foreach ($propertyName in @('options_page', 'devtools_page')) {
    $reference = Get-ObjectPropertyValue -InputObject $Manifest -Name $propertyName
    if ($reference) {
      $null = Add-RuntimeReference -Reference ([string]$reference) -BasePath $ProjectRoot -SourceLabel "manifest $propertyName"
    }
  }

  $optionsUi = Get-ObjectPropertyValue -InputObject $Manifest -Name 'options_ui'
  $optionsPage = Get-ObjectPropertyValue -InputObject $optionsUi -Name 'page'
  if ($optionsPage) {
    $null = Add-RuntimeReference -Reference ([string]$optionsPage) -BasePath $ProjectRoot -SourceLabel 'manifest options page'
  }

  $sidePanel = Get-ObjectPropertyValue -InputObject $Manifest -Name 'side_panel'
  $sidePanelPath = Get-ObjectPropertyValue -InputObject $sidePanel -Name 'default_path'
  if ($sidePanelPath) {
    $null = Add-RuntimeReference -Reference ([string]$sidePanelPath) -BasePath $ProjectRoot -SourceLabel 'manifest side panel'
  }

  Add-ObjectPropertyReferences -InputObject (Get-ObjectPropertyValue -InputObject $Manifest -Name 'chrome_url_overrides') -BasePath $ProjectRoot -SourceLabel 'manifest URL override'

  $sandbox = Get-ObjectPropertyValue -InputObject $Manifest -Name 'sandbox'
  Add-ReferenceList -References (Get-ObjectPropertyValue -InputObject $sandbox -Name 'pages') -BasePath $ProjectRoot -SourceLabel 'manifest sandbox page'

  foreach ($ruleResource in @(Get-ObjectPropertyValue -InputObject (Get-ObjectPropertyValue -InputObject $Manifest -Name 'declarative_net_request') -Name 'rule_resources')) {
    if ($null -eq $ruleResource) {
      continue
    }
    $rulePath = Get-ObjectPropertyValue -InputObject $ruleResource -Name 'path'
    if ($rulePath) {
      $null = Add-RuntimeReference -Reference ([string]$rulePath) -BasePath $ProjectRoot -SourceLabel 'manifest ruleset'
    }
  }

  return @($RuntimeFiles.Values | Sort-Object)
}

function Set-ProcessEnvironmentValue {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name,

    [AllowNull()]
    [string]$Value
  )

  [System.Environment]::SetEnvironmentVariable($Name, $Value, [System.EnvironmentVariableTarget]::Process)
}

function Invoke-ProjectVerification {
  param(
    [AllowNull()]
    [string]$ReleaseDirectory,

    [AllowNull()]
    [string]$ReleaseArchive
  )

  $environmentNames = @(
    'ATP_VERIFY_PACKAGE',
    'ATP_RELEASE_KIND',
    'ATP_RELEASE_DIR',
    'ATP_RELEASE_ARCHIVE',
    'ATP_RELEASE_ZIP',
    'ATP_RELEASE_PACKAGE'
  )
  $savedEnvironment = @{}
  foreach ($name in $environmentNames) {
    $savedEnvironment[$name] = [System.Environment]::GetEnvironmentVariable(
      $name,
      [System.EnvironmentVariableTarget]::Process
    )
    Set-ProcessEnvironmentValue -Name $name -Value $null
  }

  try {
    if ($ReleaseDirectory -or $ReleaseArchive) {
      Set-ProcessEnvironmentValue -Name 'ATP_VERIFY_PACKAGE' -Value '1'
      Set-ProcessEnvironmentValue -Name 'ATP_RELEASE_KIND' -Value 'extension'
      if ($ReleaseDirectory) {
        Set-ProcessEnvironmentValue -Name 'ATP_RELEASE_DIR' -Value $ReleaseDirectory
      }
      if ($ReleaseArchive) {
        Set-ProcessEnvironmentValue -Name 'ATP_RELEASE_ARCHIVE' -Value $ReleaseArchive
      }
    }

    Push-Location $ProjectRoot
    try {
      & $script:NodeCommand $VerifyPath
      $exitCode = $LASTEXITCODE
    } finally {
      Pop-Location
    }
    if ($exitCode -ne 0) {
      throw "node tools/verify.js failed with exit code $exitCode"
    }
  } finally {
    foreach ($name in $environmentNames) {
      Set-ProcessEnvironmentValue -Name $name -Value $savedEnvironment[$name]
    }
  }
}

function Copy-RuntimeFiles {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$Files,

    [Parameter(Mandatory = $true)]
    [string]$DestinationRoot
  )

  foreach ($relativePath in $Files) {
    $platformPath = $relativePath.Replace('/', [System.IO.Path]::DirectorySeparatorChar)
    $sourcePath = Join-Path $ProjectRoot $platformPath
    $destinationPath = Join-Path $DestinationRoot $platformPath
    Assert-StrictChildPath -ChildPath $destinationPath -ParentPath $DestinationRoot -Label 'runtime destination'

    $destinationDirectory = Split-Path -Parent $destinationPath
    if (-not [System.IO.Directory]::Exists($destinationDirectory)) {
      $null = [System.IO.Directory]::CreateDirectory($destinationDirectory)
    }
    [System.IO.File]::Copy($sourcePath, $destinationPath, $true)
  }
}

function Remove-SafeOutputDirectory {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,

    [Parameter(Mandatory = $true)]
    [string]$SafeRoot
  )

  Assert-StrictChildPath -ChildPath $Path -ParentPath $SafeRoot -Label 'output directory'
  if (-not (Test-Path -LiteralPath $Path)) {
    return
  }
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
    throw "Expected an output directory but found another entry: $Path"
  }
  Assert-NoReparsePointTree -Path $Path
  Remove-Item -LiteralPath $Path -Recurse -Force
}

function Remove-SafeOutputFile {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,

    [Parameter(Mandatory = $true)]
    [string]$SafeRoot
  )

  Assert-StrictChildPath -ChildPath $Path -ParentPath $SafeRoot -Label 'output file'
  if (-not (Test-Path -LiteralPath $Path)) {
    return
  }
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Expected an output file but found another entry: $Path"
  }
  $item = Get-Item -LiteralPath $Path -Force
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Refusing to remove a reparse-point output file: $Path"
  }
  Remove-Item -LiteralPath $Path -Force
}

if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
  throw "Manifest not found: $ManifestPath"
}
if (-not (Test-Path -LiteralPath $VerifyPath -PathType Leaf)) {
  throw "Verification script not found: $VerifyPath"
}

$node = Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1
$script:NodeCommand = $node.Source

Write-Host 'Running source verification...'
Invoke-ProjectVerification

try {
  $manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath $ManifestPath | ConvertFrom-Json
} catch {
  throw "Failed to parse manifest.json: $($_.Exception.Message)"
}

$version = [string](Get-ObjectPropertyValue -InputObject $manifest -Name 'version')
if ($version -notmatch '^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$') {
  throw "Manifest version is not safe for a package filename: $version"
}

$runtimeWhitelist = Get-RuntimeWhitelist -Manifest $manifest
if ($runtimeWhitelist.Count -eq 0 -or $runtimeWhitelist -notcontains 'manifest.json') {
  throw 'Runtime whitelist did not include manifest.json'
}

$OutputRootPath = Get-FullPath -Path $OutputRoot -BasePath $ProjectRoot
$OutputDirectory = Join-Path $OutputRootPath 'chrome-unpacked'
Assert-StrictChildPath -ChildPath $OutputDirectory -ParentPath $OutputRootPath -Label 'chrome-unpacked output'

$projectName = 'article-thumbnail-preview'
$zipPath = Join-Path $OutputRootPath ("$projectName-v$version.zip")
$hashPath = "$zipPath.sha256"
Assert-StrictChildPath -ChildPath $zipPath -ParentPath $OutputRootPath -Label 'release archive'
Assert-StrictChildPath -ChildPath $hashPath -ParentPath $OutputRootPath -Label 'release checksum'

Write-Host ("Runtime whitelist: {0} files" -f $runtimeWhitelist.Count)
Write-Host ("Output directory: {0}" -f $OutputDirectory)
if ($Zip) {
  Write-Host ("Archive: {0}" -f $zipPath)
}
foreach ($relativePath in $runtimeWhitelist) {
  Write-Verbose ("Include: {0}" -f $relativePath)
}

$action = 'Build the manifest-derived extension package'
if (-not $PSCmdlet.ShouldProcess($OutputDirectory, $action)) {
  return
}

if (Test-Path -LiteralPath $OutputRootPath) {
  if (-not (Test-Path -LiteralPath $OutputRootPath -PathType Container)) {
    throw "OutputRoot is not a directory: $OutputRootPath"
  }
  $outputRootItem = Get-Item -LiteralPath $OutputRootPath -Force
  if (($outputRootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "OutputRoot must not be a reparse point: $OutputRootPath"
  }
} else {
  $null = [System.IO.Directory]::CreateDirectory($OutputRootPath)
}

$stagingDirectory = Join-Path $OutputRootPath ('.chrome-unpacked.stage-' + [System.Guid]::NewGuid().ToString('N'))
Assert-StrictChildPath -ChildPath $stagingDirectory -ParentPath $OutputRootPath -Label 'staging directory'

try {
  $null = [System.IO.Directory]::CreateDirectory($stagingDirectory)
  Copy-RuntimeFiles -Files $runtimeWhitelist -DestinationRoot $stagingDirectory

  Write-Host 'Verifying staged extension directory...'
  Invoke-ProjectVerification -ReleaseDirectory $stagingDirectory

  # Only a verified staging tree is allowed to replace the fixed output.
  Remove-SafeOutputDirectory -Path $OutputDirectory -SafeRoot $OutputRootPath
  Move-Item -LiteralPath $stagingDirectory -Destination $OutputDirectory

  Write-Host 'Verifying final extension directory...'
  Invoke-ProjectVerification -ReleaseDirectory $OutputDirectory

  if ($Zip) {
    Remove-SafeOutputFile -Path $zipPath -SafeRoot $OutputRootPath
    Remove-SafeOutputFile -Path $hashPath -SafeRoot $OutputRootPath

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::CreateFromDirectory(
      $OutputDirectory,
      $zipPath,
      [System.IO.Compression.CompressionLevel]::Optimal,
      $false
    )

    Write-Host 'Verifying final extension archive...'
    Invoke-ProjectVerification -ReleaseArchive $zipPath

    $hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $hashLine = "$hash  $([System.IO.Path]::GetFileName($zipPath))`r`n"
    [System.IO.File]::WriteAllText(
      $hashPath,
      $hashLine,
      (New-Object System.Text.UTF8Encoding($false))
    )
    Write-Host ("SHA-256: {0}" -f $hash)
  }
} finally {
  if (Test-Path -LiteralPath $stagingDirectory) {
    Remove-SafeOutputDirectory -Path $stagingDirectory -SafeRoot $OutputRootPath
  }
}

Write-Host ("Extension package ready: {0}" -f $OutputDirectory)
if ($Zip) {
  Write-Host ("Extension archive ready: {0}" -f $zipPath)
  Write-Host ("Checksum ready: {0}" -f $hashPath)
}
