// A size is shown the way Explorer shows it, because Explorer is what the number will be
// compared with: 1024 to the kilobyte, and the units Explorer prints (KB, not KiB). Below a
// kilobyte the bytes are counted; kilobytes are whole; megabytes and gigabytes keep one
// decimal, which is where a profile of several hundred megabytes visibly grows between two
// looks. The decimal separator follows the interface language – 843,5 in Polish.
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

export function formatBytes(bytes, language) {
  let value = Math.max(0, Number(bytes) || 0)
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  const number = new Intl.NumberFormat(language, {
    minimumFractionDigits: 0,
    maximumFractionDigits: unit >= 2 ? 1 : 0,
  }).format(value)
  return `${number} ${UNITS[unit]}`
}
