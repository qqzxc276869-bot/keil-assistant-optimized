# Used only when a Windows reader allows writes but prevents atomic replacement.
$ErrorActionPreference = 'Stop'
$project = $null
$originalSaved = $false
try {
    $updated = [IO.File]::ReadAllBytes($env:KEIL_EDIT_NEW)
    foreach ($delay in 0, 150, 300, 600) {
        if ($delay) { Start-Sleep -Milliseconds $delay }
        try {
            $project = [IO.File]::Open($env:KEIL_EDIT_FILE, 'Open', 'ReadWrite', 'Read')
            # Deny other writers and prevent readers from observing a partial XML file.
            $project.Lock(0, [Math]::Max($project.Length, $updated.LongLength) + 1)
            break
        } catch [UnauthorizedAccessException] {
            exit 3
        } catch [IO.IOException] {
            if (($_.Exception.GetBaseException().HResult -band 0xffff) -notin 32, 33) { throw }
            if ($null -ne $project) { $project.Dispose(); $project = $null }
        }
    }
    if ($null -eq $project) { exit 3 }

    $hash = [Security.Cryptography.SHA256]::Create()
    try { $digest = [BitConverter]::ToString($hash.ComputeHash($project)).Replace('-', '') }
    finally { $hash.Dispose() }
    if ($digest -ne $env:KEIL_EDIT_HASH) { exit 2 }

    $backup = [IO.File]::Open($env:KEIL_EDIT_BACKUP, 'CreateNew', 'Write', 'None')
    try {
        $project.Position = 0
        $project.CopyTo($backup)
        $backup.Flush($true)
        $originalSaved = $true
    } finally {
        $backup.Dispose()
        if (!$originalSaved) { [IO.File]::Delete($env:KEIL_EDIT_BACKUP) }
    }
    try {
        $project.Position = 0
        $project.Write($updated, 0, $updated.Length)
        $project.SetLength($updated.LongLength)
        $project.Flush($true)
    } catch {
        $restore = [IO.File]::OpenRead($env:KEIL_EDIT_BACKUP)
        try {
            $project.Position = 0
            $restore.CopyTo($project)
            $project.SetLength($restore.Length)
            $project.Flush($true)
        } finally { $restore.Dispose() }
        [IO.File]::Delete($env:KEIL_EDIT_BACKUP)
        throw
    }
    [IO.File]::Delete($env:KEIL_EDIT_BACKUP)
} finally {
    if ($null -ne $project) { $project.Dispose() }
}
