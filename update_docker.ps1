param([switch]$NoPull)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Invoke-DockerCommand {
	param([string[]]$Arguments)
	& docker @Arguments
	if ($LASTEXITCODE -ne 0) { throw 'Docker command failed. The update stopped without removing any volumes.' }
}

Push-Location $PSScriptRoot
try {
	if (-not $NoPull) {
		git pull --ff-only
		if ($LASTEXITCODE -ne 0) { throw 'git pull failed; no Docker services were changed.' }
	}
	$environmentPath = Join-Path $PSScriptRoot '.env'
	$environmentText = if (Test-Path $environmentPath) { [System.IO.File]::ReadAllText($environmentPath) } else { '' }
	$passwordLine = [regex]::Match($environmentText, '(?m)^\s*POSTGRES_PASSWORD\s*=([^\r\n]*)')
	if ([string]::IsNullOrWhiteSpace($env:POSTGRES_PASSWORD) -and
		(-not $passwordLine.Success -or [string]::IsNullOrWhiteSpace($passwordLine.Groups[1].Value.Trim('"', "'")))) {
		$password = [Convert]::ToHexString([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
		if ($passwordLine.Success) {
			$environmentText = $environmentText.Remove($passwordLine.Index, $passwordLine.Length).Insert($passwordLine.Index, "POSTGRES_PASSWORD=$password")
		} else {
			$environmentText = $environmentText.TrimEnd() + "`nPOSTGRES_PASSWORD=$password`n"
		}
		[System.IO.File]::WriteAllText($environmentPath, $environmentText, [System.Text.UTF8Encoding]::new($false))
		Write-Host 'Created PostgreSQL credentials in .env; the password is not displayed.'
	}
	Invoke-DockerCommand -Arguments @('compose', 'config', '--quiet')
	Invoke-DockerCommand -Arguments @('compose', 'build', 'app')
	Invoke-DockerCommand -Arguments @('compose', 'up', '-d', '--wait', 'postgres')
	Invoke-DockerCommand -Arguments @('compose', 'up', '-d', '--no-build', '--wait', 'app')
	Write-Host 'Update complete. PostgreSQL and the app are ready.'
} finally {
	Pop-Location
}