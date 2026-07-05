#!/usr/bin/env pwsh
# Uploads all env vars from .env to Vercel and deploys to production

$envFile = ".env"
$lines = Get-Content $envFile | Where-Object { $_ -match "^[^#].*=.+" }

foreach ($line in $lines) {
    $key, $value = $line -split "=", 2
    $key = $key.Trim()
    $value = $value.Trim()
    if ($key -and $value) {
        Write-Host "Setting $key ..."
        echo $value | vercel env add $key production --force 2>&1
    }
}

Write-Host "`nAll env vars set. Deploying to production..."
vercel --prod --yes
