<#
.SYNOPSIS
  Load / unload the DeepSeek model on the DGX Spark, from this PC.

.DESCRIPTION
  The Spark serves DeepSeek v4 Flash out of a 128 GB *unified* memory pool, of
  which the model pins ~104 GiB (95.4 GiB weights + 8.7 GiB KV). There is no
  partial release: vLLM reserves at launch and holds until the container stops,
  and the /sleep endpoints are not exposed on this image (VLLM_SERVER_DEV_MODE
  is off). "Unloading" therefore means stopping the container, which is the only
  way to give the GB10 back to anything else.

  Boot to healthy is ~3.5-5 min (measured 204-282 s), so treat up/down as a
  coarse-grained lease, not something to toggle per request.

.EXAMPLE
  .\scripts\spark.ps1 status
  .\scripts\spark.ps1 up
  .\scripts\spark.ps1 bench
  .\scripts\spark.ps1 down
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('up', 'down', 'status', 'wait', 'bench', 'env', 'logs')]
    [string]$Command = 'status',

    # Seconds to wait for /health before giving up.
    [int]$TimeoutSeconds = 900
)

$ErrorActionPreference = 'Stop'

# Point these at your own machine, or set the environment variables instead of
# editing the file. They are read from the environment first so a public copy of
# this script carries nobody's hostname.
$SparkUser     = if ($env:SPARK_USER) { $env:SPARK_USER } else { 'ubuntu' }
$SparkHostname = if ($env:SPARK_HOST) { $env:SPARK_HOST } else { 'dgx-spark.local' }
$SparkKey      = if ($env:SPARK_KEY)  { $env:SPARK_KEY }  else { Join-Path $env:USERPROFILE '.ssh\id_ed25519' }
$RepoDir       = if ($env:SPARK_REPO) { $env:SPARK_REPO } else { '~/DeepSeek-v4-Flash-One-DGX-Spark' }
$Port       = 8888
$ModelName  = 'deepseek-v4-flash-0731'

function Invoke-Spark {
    param([Parameter(Mandatory)][string]$Script)
    # BatchMode: never hang on a password prompt if the key stops working.
    ssh -i $SparkKey -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 `
        "$SparkUser@$SparkHostname" $Script 2>&1
}

function Get-SparkAddress {
    # The base URL must be an address this PC can reach. mDNS (.local) resolves
    # from Windows inconsistently, so prefer the numeric address the Spark
    # reports for its own global-scope interface.
    $raw = ((Invoke-Spark 'ip -4 -br addr show scope global') -join ' ')
    if ($raw -match '(\d+\.\d+\.\d+\.\d+)/') { return $Matches[1] }
    return $SparkHostname
}

function Get-SparkMemory {
    <#
      Returns @{ TotalGiB; UsedGiB; AvailGiB }.

      Parsing happens here rather than in a remote awk script on purpose:
      quoting an awk program through PowerShell -> ssh -> remote shell loses the
      inner quotes and silently produces garbage output instead of an error.
    #>
    $line = ((Invoke-Spark 'free -m') -split "`n" | Where-Object { $_ -match '^Mem:' }) -join ' '
    $f = ($line -split '\s+') | Where-Object { $_ -ne '' }
    if ($f.Count -lt 7) { return $null }
    return @{
        TotalGiB = [math]::Round([double]$f[1] / 1024, 1)
        UsedGiB  = [math]::Round([double]$f[2] / 1024, 1)
        AvailGiB = [math]::Round([double]$f[6] / 1024, 1)
    }
}

function Get-SparkAblationMode {
    $name = 'deepseek-v4-flash-spark-deepseek-v4-flash-1'
    $lines = Invoke-Spark "docker inspect $name --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null || true"
    if (($lines -join "`n") -match '(?m)^DSV4_ABLATE_FILE=/models/files/direction_r1\.pt$') { return 1 }
    return 0
}

function Test-Health {
    param([string]$Address)
    try {
        $r = Invoke-WebRequest -Uri "http://${Address}:$Port/health" -TimeoutSec 5 -UseBasicParsing
        return $r.StatusCode -eq 200
    } catch { return $false }
}

function Wait-Healthy {
    param([string]$Address, [int]$Timeout)
    $sw = [Diagnostics.Stopwatch]::StartNew()
    while ($sw.Elapsed.TotalSeconds -lt $Timeout) {
        if (Test-Health -Address $Address) {
            Write-Host ("  healthy after {0:N0}s" -f $sw.Elapsed.TotalSeconds) -ForegroundColor Green
            return $true
        }
        Write-Host ("  waiting... {0:N0}s   " -f $sw.Elapsed.TotalSeconds) -NoNewline
        Write-Host "`r" -NoNewline
        Start-Sleep -Seconds 6
    }
    Write-Host ''
    Write-Warning "not healthy after ${Timeout}s. Check: .\scripts\spark.ps1 logs"
    return $false
}

$address = Get-SparkAddress
$baseUrl = "http://${address}:$Port/v1"

switch ($Command) {

    'status' {
        Write-Host "Spark $SparkUser@$SparkHostname ($address)" -ForegroundColor Cyan
        $container = ((Invoke-Spark 'docker ps --format "{{.Status}}"') -join ' ').Trim()
        if ([string]::IsNullOrWhiteSpace($container)) {
            Write-Host '  model     : DOWN (no container)' -ForegroundColor Yellow
        } else {
            Write-Host "  model     : $container"
        }
        $healthy = if (Test-Health -Address $address) { 'OK' } else { 'unreachable' }
        Write-Host "  /health   : $healthy"
        Write-Host "  ABLATE    : $(Get-SparkAblationMode)"
        $m = Get-SparkMemory
        if ($m) {
            Write-Host ("  memory    : {0} GiB used, {1} GiB available of {2} GiB" -f $m.UsedGiB, $m.AvailGiB, $m.TotalGiB)
        }
        $gpu = ((Invoke-Spark 'nvidia-smi --query-gpu=clocks.sm,power.draw,temperature.gpu,utilization.gpu --format=csv,noheader') -join '').Trim()
        Write-Host "  gpu       : $gpu"
        Write-Host "  base URL  : $baseUrl"
    }

    'up' {
        $isHealthy = Test-Health -Address $address
        $ablationMode = Get-SparkAblationMode
        if ($isHealthy -and $ablationMode -eq 1) {
            Write-Host 'ABLATE=1 model already loaded and healthy.' -ForegroundColor Green
            break
        }
        if (-not $isHealthy) {
            $m = Get-SparkMemory
            $avail = if ($m) { $m.AvailGiB } else { 0 }
            Write-Host "Free host RAM: $avail GiB (recipe needs >= 114.3)"
            if ($avail -lt 114) {
                # Booting under-provisioned is how this box got hard-reset before:
                # the launcher OOM-loops and drags the host down with it.
                Write-Warning 'Not enough free RAM to boot. Stop whatever is holding it first.'
                break
            }
        } else {
            Write-Host 'Healthy stock container found; switching it to ABLATE=1.' -ForegroundColor Cyan
        }
        Write-Host 'Loading model (expect 3.5-5 min)...' -ForegroundColor Cyan
        # ABLATE=1 is pinned explicitly for this local branch. A bare ./start.sh inherits whatever the
        # last run stamped, and a changed stamp silently recreates the container.
        $launch = "cd $RepoDir && ABLATE=1 setsid nohup ./start.sh --no-wait > /tmp/spark-up.log 2>&1 < /dev/null & disown; echo launched"
        Invoke-Spark $launch | Out-Null
        [void](Wait-Healthy -Address $address -Timeout $TimeoutSeconds)
    }

    'down' {
        Write-Host 'Unloading model (frees ~104 GiB and the GB10)...' -ForegroundColor Cyan
        Invoke-Spark "cd $RepoDir && ./stop.sh" | Write-Host
        Start-Sleep -Seconds 3
        $m = Get-SparkMemory
        if ($m) { Write-Host ("  {0} GiB now available" -f $m.AvailGiB) -ForegroundColor Green }
    }

    'wait' { [void](Wait-Healthy -Address $address -Timeout $TimeoutSeconds) }

    'logs' { Invoke-Spark "cd $RepoDir && docker compose logs --tail=60" | Write-Host }

    'bench' {
        if (-not (Test-Health -Address $address)) { Write-Warning 'Model is not up.'; break }
        Write-Host 'Measuring decode throughput (warm-up + 1 run)...' -ForegroundColor Cyan
        $body = @{
            model      = $ModelName
            messages   = @(@{ role = 'user'; content = 'Explain how a GPU warp scheduler works.' })
            max_tokens = 300
            temperature = 0
            stream     = $false
            chat_template_kwargs = @{ thinking = $false }
        } | ConvertTo-Json -Depth 6
        # One discarded warm-up: Triton/CUTLASS kernels JIT-compile on first use
        # after a boot, which otherwise reads as a false ~20% slowdown.
        $null = Invoke-RestMethod -Uri "$baseUrl/chat/completions" -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 600
        $sw = [Diagnostics.Stopwatch]::StartNew()
        $r = Invoke-RestMethod -Uri "$baseUrl/chat/completions" -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 600
        $sw.Stop()
        $tok = $r.usage.completion_tokens
        Write-Host ("  {0} tokens in {1:N1}s = {2:N1} tok/s (end-to-end)" -f $tok, $sw.Elapsed.TotalSeconds, ($tok / $sw.Elapsed.TotalSeconds))
        Write-Host '  Measured baseline on this box: ~26-31 tok/s decode.'
    }

    'env' {
        Write-Host 'Point CURI at the Spark by adding this to .env:' -ForegroundColor Cyan
        Write-Host ''
        Write-Host '  AR_LOCAL_ONLY=1'
        Write-Host '  AR_MODEL_PROVIDER=openai-compatible'
        Write-Host "  AR_MODEL_BASE_URL=$baseUrl"
        Write-Host "  AR_MODEL=$ModelName"
        Write-Host '  AR_MAX_COST_USD=0'
        Write-Host ''
        Write-Host 'Inference and state stay local. Public web/arXiv/GitHub retrieval remains enabled.'
        Write-Host 'No OpenRouter, Gemini, Vertex, Firestore, or cloud mirror is used.'
    }
}
