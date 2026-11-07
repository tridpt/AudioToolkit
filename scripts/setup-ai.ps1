$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path -LiteralPath '.venv/Scripts/python.exe')) {
    if (Get-Command uv -ErrorAction SilentlyContinue) {
        uv venv --python 3.12 .venv
    } else {
        python -m venv .venv
    }
    if ($LASTEXITCODE -ne 0) { throw 'Cannot create a Python environment.' }
}
if (Get-Command uv -ErrorAction SilentlyContinue) {
    uv pip install --python .venv/Scripts/python.exe -r requirements.txt
} else {
    & .venv/Scripts/python.exe -m pip install -r requirements.txt
}
if ($LASTEXITCODE -ne 0) { throw 'AI dependency installation failed.' }
Write-Host 'Local AI dependencies are ready. Public model files download on first use.'
