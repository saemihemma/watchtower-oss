param(
  [string]$Command = "profiles",
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Rest
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = (Resolve-Path (Join-Path $ScriptDir "..")).Path
if (-not (Test-Path (Join-Path $RepoRoot "node_modules"))) {
  throw "Dependencies not found in $RepoRoot. Run 'cmd /c npm install' first."
}

if (-not $env:WATCHTOWER_DATA_ROOT) {
  $env:WATCHTOWER_DATA_ROOT = Join-Path $RepoRoot "watchtower-data"
}

$CallerCwd = (Get-Location).Path
$env:WATCHTOWER_CALLER_CWD = $CallerCwd

Push-Location $RepoRoot
try {
  & npm run watchtower -- $Command @Rest
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
} finally {
  Pop-Location
}
