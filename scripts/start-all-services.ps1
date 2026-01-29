# Script para iniciar todos os servicos em abas do Windows Terminal
# Uso: powershell -ExecutionPolicy Bypass -File scripts/start-all-services.ps1
# Requer: Windows Terminal instalado (vem por padrao no Windows 11)

# Define o diretorio do script
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$configFile = Join-Path $scriptDir "..\services-config.json"

# Verifica se o arquivo de configuracao existe
if (-not (Test-Path $configFile)) {
    Write-Host "ERRO: Arquivo de configuracao nao encontrado em: $configFile" -ForegroundColor Red
    Write-Host "Crie um arquivo services-config.json com a estrutura dos servicos." -ForegroundColor Yellow
    exit 1
}

# Le a configuracao
try {
    $config = Get-Content $configFile | ConvertFrom-Json
    Write-Host "Configuracao carregada de: $configFile" -ForegroundColor Cyan
} catch {
    Write-Host "ERRO ao ler configuracao: $_" -ForegroundColor Red
    exit 1
}

$tempDir = [System.IO.Path]::GetTempPath()

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "Iniciando todos os servicos no Windows Terminal..." -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""

# Verifica se Windows Terminal esta disponivel
$wtAvailable = $null -ne (Get-Command wt -ErrorAction SilentlyContinue)

if (-not $wtAvailable) {
    Write-Host "AVISO: Windows Terminal nao encontrado!" -ForegroundColor Yellow
    Write-Host "Usando janelas separadas..." -ForegroundColor Yellow
    Write-Host ""
    $useWindowsTabs = $false
} else {
    Write-Host "Windows Terminal detectado! Usando abas..." -ForegroundColor Green
    $useWindowsTabs = $true
}

# Inicia cada servico em uma nova aba (ou janela)
$isFirstService = $true
$failedServices = @()
$startedServices = @()
$tempScripts = @()

foreach ($service in $config.services) {
    Write-Host "Iniciando $($service.name)..." -ForegroundColor Cyan
    
    # Verifica se o diretorio existe
    if (-not (Test-Path $service.path)) {
        Write-Host "  [ERRO] Diretorio nao encontrado: $($service.path)" -ForegroundColor Red
        $failedServices += $service.name
        continue
    }
    
    try {
        if ($useWindowsTabs) {
            # Cria um arquivo de script temporario para o servico
            $scriptName = "start_$($service.name.Replace('-', '_')).ps1"
            $scriptPath = Join-Path $tempDir $scriptName
            
            # Conteudo do script
            $scriptContent = @"
`$ErrorActionPreference = 'Continue'
`$serviceName = "$($service.name)"
`$host.ui.RawUI.WindowTitle = `$serviceName

# Define uma funcao de prompt que sempre mantém o título
function prompt {
    `$host.ui.RawUI.WindowTitle = `$serviceName
    return "PS `$(Get-Location)> "
}

Set-Location "$($service.path)"
Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "Servico: `$serviceName" -ForegroundColor Green
Write-Host "Diretorio: `$(Get-Location)" -ForegroundColor Green
Write-Host "Comando: $($service.command)" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
cmd /c $($service.command)
"@
            
            # Escreve o arquivo de script
            Set-Content -Path $scriptPath -Value $scriptContent -Encoding UTF8
            $tempScripts += $scriptPath
            
            # Abre no Windows Terminal
            if ($isFirstService) {
                # Primeira aba
                & wt powershell.exe -NoExit -File "$scriptPath"
                $isFirstService = $false
            } else {
                # Novas abas
                & wt -w 0 new-tab powershell.exe -NoExit -File "$scriptPath"
            }
            
            Write-Host "  [OK] Aba '$($service.name)' iniciada" -ForegroundColor Green
        } else {
            # Fallback: janelas separadas
            $scriptName = "start_$($service.name.Replace('-', '_')).ps1"
            $scriptPath = Join-Path $tempDir $scriptName
            
            $scriptContent = @"
`$ErrorActionPreference = 'Continue'
Set-Location "$($service.path)"
Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "Servico: $($service.name)" -ForegroundColor Green
Write-Host "Diretorio: $($service.path)" -ForegroundColor Green
Write-Host "Comando: $($service.command)" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
cmd /c $($service.command)
"@
            
            Set-Content -Path $scriptPath -Value $scriptContent -Encoding UTF8
            $tempScripts += $scriptPath
            
            Start-Process -FilePath "powershell.exe" -ArgumentList "-NoExit", "-File", "`"$scriptPath`""
            
            Write-Host "  [OK] Janela iniciada" -ForegroundColor Green
        }
        
        $startedServices += $service.name
        
        # Pequena pausa entre inicializacoes
        Start-Sleep -Milliseconds 300
    }
    catch {
        Write-Host "  [ERRO] Falha ao iniciar: $_" -ForegroundColor Red
        $failedServices += $service.name
    }
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "Resumo da inicializacao:" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green

if ($useWindowsTabs) {
    Write-Host "Modo: ABAS no Windows Terminal" -ForegroundColor Cyan
} else {
    Write-Host "Modo: JANELAS SEPARADAS (Windows Terminal nao disponivel)" -ForegroundColor Yellow
}

Write-Host "Iniciados: $($startedServices.Count)" -ForegroundColor Green

foreach ($service in $startedServices) {
    Write-Host "  [OK] $service" -ForegroundColor Green
}

if ($failedServices.Count -gt 0) {
    Write-Host "Falharam: $($failedServices.Count)" -ForegroundColor Red
    foreach ($service in $failedServices) {
        Write-Host "  [ERRO] $service" -ForegroundColor Red
    }
}

Write-Host ""
Write-Host "Todos os servicos foram iniciados." -ForegroundColor Cyan

if ($useWindowsTabs) {
    Write-Host "Verifique as abas no Windows Terminal." -ForegroundColor Cyan
    Write-Host "Clique na aba 'X' para encerrar um servico individual." -ForegroundColor Cyan
    Write-Host "Os scripts temporarios serao automaticamente removidos quando fechados." -ForegroundColor Cyan
} else {
    Write-Host "Feche as janelas individuais para encerrar cada servico." -ForegroundColor Cyan
}

Write-Host ""

# Cleanup de scripts temporarios (executado quando o script principal fecha)
$null = Register-EngineEvent -SourceIdentifier PowerShell.Exiting -Action {
    foreach ($script in $tempScripts) {
        if (Test-Path $script) {
            Remove-Item $script -Force -ErrorAction SilentlyContinue
        }
    }
}
