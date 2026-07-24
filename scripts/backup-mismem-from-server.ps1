# Daily backup of misMEM SQLite DB from a remote server -> local.
# Uses VACUUM INTO for a consistent snapshot (safe with WAL).
# Keeps last 14 daily backups.
#
# Usage: .\backup-mismem-from-server.ps1 [-SshHost myserver] [-HostVolumeDir /var/lib/docker/volumes/mismem-data/_data]

param(
    # SSH alias or user@host of the server running the mismem-brain container.
    [string]$SshHost = $env:MISMEM_SSH_HOST,
    # Host path that maps to /data inside the container (docker volume _data dir).
    [string]$HostVolumeDir = $env:MISMEM_HOST_VOLUME_DIR
)

$ErrorActionPreference = 'Stop'

if (-not $SshHost)       { throw "Set -SshHost or MISMEM_SSH_HOST" }
if (-not $HostVolumeDir) { throw "Set -HostVolumeDir or MISMEM_HOST_VOLUME_DIR" }

$BackupDir   = "$env:USERPROFILE\.mismem\backups"
# Container path (DB is mounted at /data/mem.db inside mismem-brain).
$ContainerDb   = "/data/mem.db"
$ContainerTmp  = "/data/.backup-tmp.db"
$HostTmp       = "$HostVolumeDir/.backup-tmp.db"
$Stamp         = Get-Date -Format 'yyyyMMdd-HHmmss'
$LocalFile     = Join-Path $BackupDir "mem-$Stamp.db"
$RetainCount   = 14

if (-not (Test-Path $BackupDir)) {
    New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
}

Write-Host "[$(Get-Date -Format s)] Snapshotting via mismem-brain container..."
# Pipe SQL via stdin to avoid shell quoting hell across pwsh -> ssh -> docker -> sh -> sqlite3.
$sql = "VACUUM INTO '$ContainerTmp';"
$sql | ssh $SshHost "docker exec -i mismem-brain sh -c 'rm -f $ContainerTmp; sqlite3 $ContainerDb'"
if ($LASTEXITCODE -ne 0) { throw "VACUUM INTO failed" }

Write-Host "[$(Get-Date -Format s)] Downloading to $LocalFile..."
scp "${SshHost}:$HostTmp" "$LocalFile"
if ($LASTEXITCODE -ne 0) { throw "scp failed" }

Write-Host "[$(Get-Date -Format s)] Cleaning up remote tmp..."
ssh $SshHost "rm -f $HostTmp" | Out-Null

# Retention: keep newest $RetainCount, delete older.
$old = Get-ChildItem $BackupDir -Filter 'mem-*.db' | Sort-Object LastWriteTime -Descending | Select-Object -Skip $RetainCount
foreach ($f in $old) {
    Write-Host "[$(Get-Date -Format s)] Removing old backup: $($f.Name)"
    Remove-Item $f.FullName -Force
}

$size = (Get-Item $LocalFile).Length / 1MB
Write-Host ("[$(Get-Date -Format s)] Done. Size: {0:N2} MB" -f $size)
