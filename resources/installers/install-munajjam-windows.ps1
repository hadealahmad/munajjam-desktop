[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Root,
  [string]$RepoUrl = "https://github.com/Itqan-community/Munajjam",
  [string]$RepoRef = "main",
  [string]$PythonVersion = "3.12"
)

$ErrorActionPreference = "Stop"

function Get-NormalizedGitHubRepo {
  param([string]$RepoUrl)

  $CleanUrl = $RepoUrl.TrimEnd("/") -replace "\.git$", ""
  $Uri = [Uri]$CleanUrl
  $Parts = $Uri.AbsolutePath.Trim("/") -split "/"

  if ($Uri.Host -ne "github.com" -or $Parts.Length -lt 2) {
    throw "Unsupported Munajjam repository URL: $RepoUrl"
  }

  return @{
    Owner = $Parts[0]
    Name = $Parts[1]
  }
}

function Invoke-DownloadFile {
  param([string]$Uri, [string]$OutFile)

  try {
    Invoke-WebRequest `
      -Uri $Uri `
      -OutFile $OutFile `
      -UseBasicParsing `
      -Headers @{ "User-Agent" = "Munajjam-Desktop-Installer" }
  } catch {
    $StatusCode = $_.Exception.Response.StatusCode.value__
    if ($StatusCode) {
      throw "Failed to download Munajjam repository archive from $Uri (HTTP $StatusCode)."
    }
    throw "Failed to download Munajjam repository archive from $Uri. $($_.Exception.Message)"
  }
}

function Sync-MunajjamRepo {
  param([string]$RepoDir, [string]$RepoUrl, [string]$RepoRef)

  $Repo = Get-NormalizedGitHubRepo -RepoUrl $RepoUrl
  $ZipUrl = "https://codeload.github.com/$($Repo.Owner)/$($Repo.Name)/zip/refs/heads/$RepoRef"
  $TempZip = Join-Path $env:TEMP "munajjam-repo.zip"
  $TempExtract = Join-Path $env:TEMP "munajjam-extract"

  Write-Host "Downloading Munajjam repository ($RepoRef)..."
  try {
    Invoke-DownloadFile -Uri $ZipUrl -OutFile $TempZip
  } catch {
    $TagZipUrl = "https://codeload.github.com/$($Repo.Owner)/$($Repo.Name)/zip/refs/tags/$RepoRef"
    Write-Host "Branch archive was not available; trying tag archive..."
    Invoke-DownloadFile -Uri $TagZipUrl -OutFile $TempZip
  }

  if (Test-Path $TempExtract) { Remove-Item $TempExtract -Recurse -Force }
  Expand-Archive -Path $TempZip -DestinationPath $TempExtract -Force
  Remove-Item $TempZip -Force

  $ExtractedFolder = Get-ChildItem $TempExtract -Directory | Select-Object -First 1
  if (-not $ExtractedFolder) { throw "Failed to extract Munajjam repository archive." }

  if (Test-Path $RepoDir) { Remove-Item $RepoDir -Recurse -Force }
  Move-Item $ExtractedFolder.FullName $RepoDir

  Remove-Item $TempExtract -Recurse -Force -ErrorAction SilentlyContinue
}

function Resolve-MunajjamPackageDir {
  param([string]$RepoDir)

  $Candidates = @(
    (Join-Path $RepoDir "munajjam"),
    $RepoDir
  )

  foreach ($Candidate in $Candidates) {
    if (Test-Path (Join-Path $Candidate "pyproject.toml")) {
      return $Candidate
    }
  }

  $Match = Get-ChildItem -Path $RepoDir -Recurse -Filter "pyproject.toml" -File -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match "[\\/]munajjam[\\/]pyproject\.toml$" } |
    Select-Object -First 1

  if ($Match) {
    return $Match.DirectoryName
  }

  throw "Munajjam package pyproject.toml was not found in the downloaded repository."
}

function New-MunajjamVenv {
  param([string]$VenvDir, [string]$PythonVersion)

  Write-Host "Creating Python virtual environment..."
  if (Get-Command py.exe -ErrorAction SilentlyContinue) {
    & py ("-" + $PythonVersion) -m venv $VenvDir
    if ($LASTEXITCODE -eq 0) { return }

    Write-Host "Python $PythonVersion was not available through py.exe; trying the default Python launcher..."
    & py -3 -m venv $VenvDir
    if ($LASTEXITCODE -eq 0) { return }
  }

  if (Get-Command python.exe -ErrorAction SilentlyContinue) {
    & python -m venv $VenvDir
    if ($LASTEXITCODE -eq 0) { return }
  }

  throw "Python was not found after winget install."
}

if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
  Write-Error "winget is required for automated Munajjam setup on Windows."
  Write-Error "Install App Installer from Microsoft and retry."
  exit 1
}

Write-Host "Installing required packages with winget..."
winget install --exact --id Gyan.FFmpeg --accept-package-agreements --accept-source-agreements
winget install --exact --id Python.Python.3.12 --accept-package-agreements --accept-source-agreements

# Refresh PATH in the current session so newly installed tools are visible immediately.
$env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
            [System.Environment]::GetEnvironmentVariable("Path", "User")

$null = New-Item -ItemType Directory -Force -Path $Root
$null = New-Item -ItemType Directory -Force -Path (Join-Path $Root "logs")

$RepoDir = Join-Path $Root "repo"
$VenvDir = Join-Path $Root "venv"
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"
$FfmpegMarker = Join-Path $Root "ffmpeg-path.txt"

Sync-MunajjamRepo -RepoDir $RepoDir -RepoUrl $RepoUrl -RepoRef $RepoRef
$PackageDir = Resolve-MunajjamPackageDir -RepoDir $RepoDir

if ((Test-Path $VenvDir) -and -not (Test-Path $VenvPython)) {
  Write-Host "Removing incomplete Python virtual environment..."
  Remove-Item $VenvDir -Recurse -Force
}

if (-not (Test-Path $VenvPython)) {
  New-MunajjamVenv -VenvDir $VenvDir -PythonVersion $PythonVersion
}

if (-not (Test-Path $VenvPython)) {
  throw "Managed Python executable was not created at $VenvPython."
}

$FfmpegBin = $null
$FfmpegCommand = Get-Command ffmpeg.exe -ErrorAction SilentlyContinue
if ($FfmpegCommand) {
  $FfmpegBin = $FfmpegCommand.Source
}

if (-not $FfmpegBin) {
  $WingetPackages = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages"
  if (Test-Path $WingetPackages) {
    $PackageDirEntry = Get-ChildItem -Path $WingetPackages -Directory -Filter "Gyan.FFmpeg_*" -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending |
      Select-Object -First 1
    if ($PackageDirEntry) {
      $Match = Get-ChildItem -Path $PackageDirEntry.FullName -Recurse -Filter "ffmpeg.exe" -ErrorAction SilentlyContinue |
        Select-Object -First 1
      if ($Match) {
        $FfmpegBin = $Match.FullName
      }
    }
  }
}

if (-not $FfmpegBin) {
  throw "FFmpeg executable not found after winget install."
}

Set-Content -Path $FfmpegMarker -Value $FfmpegBin -NoNewline

Write-Host "Upgrading packaging tools..."
& $VenvPython -m pip install --upgrade pip setuptools wheel

Write-Host "Installing Munajjam with faster-whisper support..."
& $VenvPython -m pip install "$PackageDir[faster-whisper]"

Write-Host "Verifying managed runtime..."
& $VenvPython -c "import munajjam, sys; print(f'Python: {sys.executable}'); print(f'munajjam: {getattr(munajjam, ""__version__"", ""unknown"")}')"

Write-Host "Managed Munajjam runtime is ready at $Root"
