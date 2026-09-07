import { describe, test, expect } from 'vitest'
import { formatBytes } from '../src/shared/bytes.js'

// The number is compared with what Explorer shows for the same folder, so the units are the
// ones Explorer uses: 1024 to the kilobyte, and KB rather than KiB.
describe('formatBytes', () => {
  test('bytes stay bytes below a kilobyte', () => {
    expect(formatBytes(0, 'en')).toBe('0 B')
    expect(formatBytes(512, 'en')).toBe('512 B')
  })

  test('kilobytes carry no decimals; megabytes and gigabytes carry one', () => {
    expect(formatBytes(2048, 'en')).toBe('2 KB')
    expect(formatBytes(884477795, 'en')).toBe('843.5 MB')
    expect(formatBytes(1610612736, 'en')).toBe('1.5 GB')
  })

  test('the decimal separator follows the language', () => {
    expect(formatBytes(884477795, 'pl')).toBe('843,5 MB')
  })
})
