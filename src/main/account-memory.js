// What one awake account costs in memory, as one number for the log.
//
// Putting accounts to sleep only pays if an awake one costs enough to matter, and nobody had
// measured it on this machine. The answer is read from Electron's own process table: the
// private memory of the account's renderer plus that of every process its frames run in – a
// cross-site embed gets a process of its own, and it is the account's as much as the page is.
// Partitions never share a renderer, so no process is counted for two accounts.

// The processes behind one account view. Zero means there is no renderer right now – not started
// yet, or just gone – and a process that is not there has no memory to count.
export function processIdsOf(webContents) {
  const ids = new Set([webContents.getOSProcessId()])
  for (const frame of webContents.mainFrame?.framesInSubtree ?? []) ids.add(frame.osProcessId)
  return [...ids].filter((pid) => Number.isInteger(pid) && pid > 0)
}

// app.getAppMetrics() reports memory in kilobytes, and privateBytes on Windows only. Null rather
// than zero when there is nothing to add: zero would read as an account that costs nothing.
export function accountMemoryMb(metrics, pids) {
  const wanted = new Set(pids)
  const found = metrics.filter((entry) => wanted.has(entry.pid) && Number.isFinite(entry.memory?.privateBytes))
  if (!found.length) return null
  const kilobytes = found.reduce((sum, entry) => sum + entry.memory.privateBytes, 0)
  return Math.round(kilobytes / 1024)
}
