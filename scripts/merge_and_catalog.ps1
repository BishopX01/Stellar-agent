$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$workspaceDir = Resolve-Path (Join-Path $scriptDir "..")
$issuesJsonPath = Join-Path $workspaceDir "issues_data.json"
$issuesMdPath = Join-Path $workspaceDir "ISSUES.md"

$files = @(
    (Join-Path $scriptDir "issues_contracts.json"),
    (Join-Path $scriptDir "issues_backend.json"),
    (Join-Path $scriptDir "issues_frontend.json"),
    (Join-Path $scriptDir "issues_react.json"),
    (Join-Path $scriptDir "issues_devops.json")
)

$allIssues = @()

foreach ($f in $files) {
    if (-not (Test-Path $f)) {
        throw "File not found: $f"
    }
    $raw = Get-Content -Path $f -Raw -Encoding UTF8
    $parsed = $raw | ConvertFrom-Json
    $allIssues += $parsed
    Write-Host "Loaded $($parsed.Count) issues from $(Split-Path -Leaf $f)"
}

Write-Host "Total merged issues: $($allIssues.Count)"
if ($allIssues.Count -ne 100) {
    throw "Expected exactly 100 issues, but got $($allIssues.Count)"
}

# Write issues_data.json
$allIssues | ConvertTo-Json -Depth 6 | Set-Content -Path $issuesJsonPath -Encoding UTF8
Write-Host "Successfully saved issues_data.json"

# Write ISSUES.md
$mdHeader = @"
# Stellar Agent (Bear Protocol) — Master Issue Catalog (100 Issues)

This document contains the complete catalog of **100 high-impact, production-grade technical issues** designed for **Drips**, **Stellar Wave**, and community contributors.

Each issue follows conventional commit conventions, includes motivation referencing actual codebase locations, detailed technical proposals, and concrete acceptance criteria.

---

## Issue Distribution Summary

| Category | Issue IDs | Count | Primary Focus |
|---|---|---|---|
| **Smart Contracts (Soroban / Rust)** | #1 – #25 | 25 | Escrows, Multi-token, Arbitrations, Session Keys, TTL Rent, Gas |
| **Backend, Indexer & Agent System** | #26 – #50 | 25 | SQLite WAL, SSE/WebSocket, Reorgs, Rate Limiting, Retries, Tracing |
| **Frontend & Dashboard** | #51 – #70 | 20 | Stellar Wallets Kit, Optimistic UI, Timelines, WCAG AAA, x402 Tester |
| **Packages & React SDK** | #71 – #85 | 15 | React Hooks (useJob, useCommerce, useWallet), UI components, SSR |
| **SDK, Security, DevOps & CI/CD** | #86 – #100 | 15 | CSP Headers, SSE Streaming, Cold Storage, Fuzzing, Matrix CI, Docker |

---

"@

$mdEntries = foreach ($issue in $allIssues) {
    $criteriaFormatted = ($issue.criteria | ForEach-Object { "- [ ] $_" }) -join "`r`n"
    @"
### #$($issue.id) - $($issue.title)

**Category:** $($issue.category)  
**Labels:** ``$($issue.labels)``  
**Difficulty:** $($issue.difficulty)  
**Skills:** $($issue.skills)  

#### Summary
$($issue.summary)

#### Motivation & Code Context
$($issue.motivation)

#### Proposed Architecture & Implementation
$($issue.implementation)

#### Acceptance Criteria
$criteriaFormatted

---
"@
}

$fullMd = $mdHeader + "`r`n`r`n" + ($mdEntries -join "`r`n`r`n")
Set-Content -Path $issuesMdPath -Value $fullMd -Encoding UTF8
Write-Host "Successfully generated ISSUES.md with all 100 issues!"
