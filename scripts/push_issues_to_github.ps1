# PowerShell script to push all 100 issues to GitHub sequentially with rate-limit protection
$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$workspaceDir = Resolve-Path (Join-Path $scriptDir "..")
$issuesJsonPath = Join-Path $workspaceDir "issues_data.json"
$progressJsonPath = Join-Path $scriptDir "push_progress.json"
$mappingMdPath = Join-Path $workspaceDir "ISSUES_GITHUB_MAPPING.md"

if (-not (Test-Path $issuesJsonPath)) {
    throw "Missing issues_data.json! Run merge_and_catalog.ps1 first."
}

$rawIssues = Get-Content -Path $issuesJsonPath -Raw -Encoding UTF8
$issues = $rawIssues | ConvertFrom-Json

# Load or initialize progress tracker
$progress = @{}
if (Test-Path $progressJsonPath) {
    try {
        $rawProgress = Get-Content -Path $progressJsonPath -Raw -Encoding UTF8
        $parsedProgress = $rawProgress | ConvertFrom-Json
        foreach ($prop in $parsedProgress.PSObject.Properties) {
            $progress[$prop.Name] = $prop.Value
        }
        Write-Host "Loaded existing progress for $($progress.Keys.Count) issues."
    } catch {
        Write-Warning "Could not parse push_progress.json, initializing fresh."
    }
}

# Issue #1 was already created during verification
if (-not $progress.ContainsKey("1")) {
    $progress["1"] = [PSCustomObject]@{
        id = 1
        github_number = 693
        github_url = "https://github.com/sonoflawal-1/Stellar-agent/issues/693"
        title = $issues[0].title
        created_at = (Get-Date).ToString("o")
    }
}

$total = $issues.Count
Write-Host "Starting GitHub issue push for $total issues..."

for ($i = 0; $i -lt $total; $i++) {
    $issue = $issues[$i]
    $issueIdStr = [string]$issue.id

    if ($progress.ContainsKey($issueIdStr) -and $progress[$issueIdStr].github_url) {
        Write-Host "[$($issue.id)/$total] SKIP: Already created at $($progress[$issueIdStr].github_url)"
        continue
    }

    Write-Host "[$($issue.id)/$total] Creating: $($issue.title)..."

    $criteriaFormatted = ($issue.criteria | ForEach-Object { "- [ ] $_" }) -join "`r`n"
    $body = @"
## Summary

$($issue.summary)

## Motivation & Code Context

$($issue.motivation)

## Proposed Architecture & Implementation

$($issue.implementation)

## Acceptance Criteria

$criteriaFormatted

**Category:** $($issue.category)  
**Labels:** $($issue.labels)  
**Difficulty:** $($issue.difficulty)  
**Skills:** $($issue.skills)
"@

    # Write body to temp file to preserve formatting and prevent CLI arg overflow
    $tempFile = [System.IO.Path]::GetTempFileName()
    try {
        [System.IO.File]::WriteAllText($tempFile, $body, [System.Text.Encoding]::UTF8)

        $retries = 3
        $createdUrl = $null

        while ($retries -gt 0) {
            try {
                $createdUrl = gh issue create --title $issue.title --body-file $tempFile --label $issue.labels
                if ($createdUrl -and $createdUrl.StartsWith("https://github.com/")) {
                    break
                }
            } catch {
                Write-Warning "Creation attempt failed. Retrying in 5 seconds... Error: $_"
                Start-Sleep -Seconds 5
                $retries--
            }
        }

        if (-not $createdUrl -or -not $createdUrl.StartsWith("https://github.com/")) {
            throw "Failed to create issue #$($issue.id) on GitHub after retries!"
        }

        $createdUrl = $createdUrl.Trim()
        $ghNumber = ($createdUrl -split "/")[-1]

        Write-Host "[$($issue.id)/$total] SUCCESS: Issue #$ghNumber created -> $createdUrl"

        $progress[$issueIdStr] = [PSCustomObject]@{
            id = $issue.id
            github_number = [int]$ghNumber
            github_url = $createdUrl
            title = $issue.title
            created_at = (Get-Date).ToString("o")
        }

        # Save progress after every issue
        $progress | ConvertTo-Json -Depth 4 | Set-Content -Path $progressJsonPath -Encoding UTF8

        # Safe delay to prevent secondary rate limits
        Start-Sleep -Milliseconds 1200
    } finally {
        if (Test-Path $tempFile) {
            Remove-Item $tempFile -Force -ErrorAction SilentlyContinue
        }
    }
}

Write-Host "All issues processed! Generating ISSUES_GITHUB_MAPPING.md..."

# Generate ISSUES_GITHUB_MAPPING.md
$mappingLines = @()
$mappingLines += "# Stellar-agent - Live GitHub Issues Directory (100 Issues)"
$mappingLines += ""
$mappingLines += "| Catalog # | GitHub Issue | Title | Category | Status |"
$mappingLines += "|---|---|---|---|---|"

for ($i = 0; $i -lt $total; $i++) {
    $issue = $issues[$i]
    $issueIdStr = [string]$issue.id
    if ($progress.ContainsKey($issueIdStr)) {
        $p = $progress[$issueIdStr]
        $mappingLines += "| #$($issue.id) | [#$($p.github_number)]($($p.github_url)) | $($issue.title) | $($issue.category) | Open |"
    } else {
        $mappingLines += "| #$($issue.id) | Pending | $($issue.title) | $($issue.category) | Pending |"
    }
}

$mappingLines -join "`r`n" | Set-Content -Path $mappingMdPath -Encoding UTF8
Write-Host "Mapping successfully saved to $mappingMdPath"
